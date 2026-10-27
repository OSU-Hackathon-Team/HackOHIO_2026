/**
 * Reconstruction agent runtime.
 *
 * The agent gets a workspace, file tools limited to that workspace, and the Oracle MCP server. It
 * has no shell, no network and no archive paths. Everything it knows about the original app comes
 * from the oracle tools. OpenCode is the only external dependency; the free model is the default.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { awsEnvironment, resolveModel } from "./models.mjs";

const TOOLS = fileURLToPath(new URL("./agent-tools.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FILE_TOOLS = ["read", "list", "glob", "grep", "edit", "write"];
const ORACLE_TOOLS = ["inventory", "probe", "find_fixture", "public_cases", "declare_contract", "verify", "candidate"];

export function agentPrompt({ workspace, archiveName }) {
  return `You are reconstructing a desktop Electron application from observed behavior. The original
source is unavailable by design; do not ask for it and do not try to find it. Work only in this
workspace: ${workspace}

Target: ${archiveName}

## How you learn the app

The \`oracle\` MCP tools run the original app under a mocked Electron host:

- \`oracle_inventory\` — package metadata, IPC channels with argument counts, preload bridge globals
  and methods, renderer loads, assets.
- \`oracle_probe\` — invoke IPC channels in a fresh app instance. Pass \`fixtures\` to create files
  under \`userData\`, \`documents\`, \`logs\` or \`temp\`, then \`calls\`. The reply contains handler values
  or errors, every persisted file after each call, and the file paths the app read or wrote. Use
  it to discover argument shapes, storage layout, JSON formatting and error behavior. Probes are
  isolated: nothing survives between calls to the tool.
- \`oracle_find_fixture\` — when a probe fails because the fixture lacks a file or field, this
  searches the fixture shape mechanically and returns the first version where the channel succeeds.
  Use it instead of guessing; fixtures it returns are valid contract fixtures.
- \`oracle_public_cases\` — the public cases your reconstruction must pass, with the original app's
  exact observed outcomes. They appear after you declare a contract.
- \`oracle_verify\` — assemble your workspace into a runnable Electron project and compare it to the
  original on every public case.
- \`oracle_candidate\` — run a free-form case against your current implementation.
- \`oracle_declare_contract\` — save contract.json. It is also the input to case generation.

## What to build

Write one CommonJS module per IPC channel under \`features/\`. Each module exports either a function
or \`{ handle }\` with the shape:

\`\`\`js
module.exports = async function handle(args, ctx) {
  // args: the IPC arguments after the event (an array)
  // ctx: { app, fs, path, userData, documents }
  return result;
};
\`\`\`

Return the same value the original handler returns. Throw the same error type (name/code) the
original throws. When the original writes files, write the same paths with the same exact bytes
(including JSON indentation). Use \`ctx.fs\` (node:fs/promises), \`ctx.path\`, and
\`ctx.userData\`/\`ctx.documents\`. You may add helper modules next to the features. Only Node
built-ins are available; do not add dependencies.

Then declare contract.json through \`oracle_declare_contract\`:

\`\`\`json
{
  "schema_version": 1,
  "channels": {
    "some:channel": {
      "feature": "features/some-channel.cjs",
      "title": "Some feature",
      "description": "What it does",
      "fixtures": [
        { "base": "userData", "path": "data/example.json", "content": { "items": [] } }
      ],
      "args": [["example", 1], ["example", 2]],
      "params": [
        { "name": "name", "type": "string", "example": "example" },
        { "name": "count", "type": "number", "example": 1 }
      ]
    }
  }
}
\`\`\`

Every original channel must be declared. Fixtures must make the channel reachable and \`args\` must
cover at least three distinct behaviors. Declaration is rejected while any channel has a coverage
gap: at least one generated case must succeed against the original and at least three distinct
outcomes must be observed. An implementation that reproduces only errors is not a reconstruction.
Use \`oracle_probe\` to find a fixture shape that succeeds before declaring it. The driver expands
these into a larger set of mutated cases, so generalized behavior is required — special-casing the
sample arguments will fail.

## Rules

- Match exact values, error names/codes, persisted file contents and paths.
- Generated cases freeze the clock at 2026-10-25T12:00:00.000Z. Pass the same \`fixed_time\` to
  \`oracle_probe\` whenever a handler reads the current time; otherwise results drift.
- If every probe of a channel fails with a missing-file or undefined-property error, call
  \`oracle_find_fixture\` with the same channel, args and fixtures. Build the contract from the
  fixtures that actually made the original succeed.
- Edge cases are graded: whitespace-only and empty strings, unicode, duplicate fixture entries,
  missing files, boundary numbers and repeated calls. Probe them on purpose; behavioral quirks in
  the original must be reproduced, not corrected.
- Budget your probing: learn a channel with a handful of targeted probes, implement it, then use
  verification failures to focus further probing. Do not exhaust the round on exploration.
- Never copy original source. You cannot see it, and hidden files must not be requested.
- Do not use shell, network, or package installation; those tools are denied.
- Iterate: probe, implement, verify, fix. Stop only after \`oracle_verify\` reports every public case
  passing and the declared contract has no problems.`;
}

export async function runAgent({ workspace, stateDir, appDir, archiveName, analysisFile, publicFile, candidateDir,
  model = process.env.ELECTRON_AGENT_MODEL || resolveModel(),
  timeout = Number(process.env.ELECTRON_AGENT_TIMEOUT || 1200), round = 1, feedback = "", log }) {
  workspace = path.resolve(workspace);
  stateDir = path.resolve(stateDir);
  appDir = path.resolve(appDir);
  analysisFile = path.resolve(analysisFile);
  publicFile = path.resolve(publicFile);
  candidateDir = path.resolve(candidateDir);
  const config = {
    $schema: "https://opencode.ai/config.json",
    model,
    small_model: model,
    permission: { "*": "deny", ...Object.fromEntries([...FILE_TOOLS, ...ORACLE_TOOLS.map(tool => `oracle_${tool}`)]
      .map(tool => [tool, "allow"])) },
    agent: {
      reconstruct: {
        mode: "primary", model,
        prompt: "Reconstruct an Electron app from oracle observations. Use the oracle tools; never ask for source.",
        permission: { "*": "deny", ...Object.fromEntries([...FILE_TOOLS, ...ORACLE_TOOLS.map(tool => `oracle_${tool}`)]
          .map(tool => [tool, "allow"])) },
      },
    },
    mcp: {
      oracle: {
        type: "local", enabled: true,
        command: [process.execPath, TOOLS, "--app-dir", appDir, "--workspace", workspace,
          "--analysis", analysisFile, "--public-cases", publicFile, "--candidate", candidateDir],
        timeout: 600000,
      },
    },
  };
  if (model.startsWith("amazon-bedrock/")) {
    const modelId = model.slice("amazon-bedrock/".length);
    config.provider = {
      "amazon-bedrock": {
        models: {
          [modelId]: {
            name: modelId, id: modelId, status: "active",
            provider: { npm: "@ai-sdk/amazon-bedrock" },
            limit: { context: 32768, output: 4000 },
          },
        },
      },
    };
  }
  const configPath = path.join(stateDir, `opencode-round-${round}.json`);
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  const eventsPath = path.join(stateDir, `agent-round-${round}.events.jsonl`);
  const stderrPath = path.join(stateDir, `agent-round-${round}.stderr.log`);
  const prompt = agentPrompt({ workspace, archiveName: archiveName ?? path.basename(appDir) }) +
    (feedback ? `\n\n## Verification feedback from the previous round\n${feedback}\n` : "");
  const opencode = process.env.OPENCODE_BIN || "opencode";
  const env = { ...process.env, OPENCODE_CONFIG: configPath, PWD: workspace,
    OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true" };
  delete env.OPENCODE_CONFIG_CONTENT;
  if (model.startsWith("amazon-bedrock/") && !env.AWS_PROFILE) {
    const aws = awsEnvironment([path.join(REPO_ROOT, ".env"), path.join(REPO_ROOT, "packages/backend/.env")]);
    for (const [key, value] of Object.entries(aws)) env[key] = value;
  }
  const events = fs.createWriteStream(eventsPath);
  const stderr = fs.createWriteStream(stderrPath);
  log?.(`agent round ${round}: ${model}`);
  const completed = await new Promise(resolve => {
    const child = spawn(opencode, ["run", "--print-logs", "--title", "electron-reconstruct",
      "--agent", "reconstruct", "--model", model, "--format", "json", prompt],
    { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: null, timedOut: true }); }, timeout * 1000);
    child.stdout.pipe(events);
    child.stderr.pipe(stderr);
    child.on("error", error => { clearTimeout(timer); resolve({ code: null, error }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, timedOut: false }); });
  });
  events.end();
  stderr.end();
  await Promise.all([finished(events), finished(stderr)]);
  const rows = (await fsp.readFile(eventsPath, "utf8")).split("\n").filter(line => line.startsWith("{"))
    .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const texts = rows.filter(row => row.type === "text").map(row => row.part?.text ?? "");
  const toolCalls = rows.filter(row => row.type === "tool_use")
    .map(row => ({ tool: row.part?.tool, status: row.part?.state?.status }));
  const errors = rows.filter(row => row.type === "error").map(row => row.error?.data?.message ?? row.error?.name ?? "error");
  const usage = rows.filter(row => row.type === "step_finish").map(row => row.part?.tokens?.total ?? 0);
  return { round, model, exitCode: completed.code, timedOut: completed.timedOut, error: completed.error?.message,
    eventsPath, stderrPath, text: texts.join("\n").trim(), toolCalls, errors: errors.slice(0, 20),
    tokens: usage.reduce((sum, value) => sum + value, 0) };
}
