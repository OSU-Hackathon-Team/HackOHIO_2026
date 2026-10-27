/**
 * Reconstruction agent runtimes.
 *
 * Two stages, two agents, deliberately asymmetric:
 *
 * - `spec` observes the original application through the oracle and writes a public
 *   specification (channels, fixtures, arguments, numbered requirements, stateful sequences).
 * - `implement` receives that specification and the public differential cases and writes feature
 *   modules. It has no oracle, no archive path and no access to the original app.
 *
 * Splitting the stages is what makes the handoff testable: the implementer succeeding proves the
 * specification was sufficient, not that a second probe session filled the gaps.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { awsEnvironment, resolveModel } from "./models.mjs";

const TOOLS = {
  spec: fileURLToPath(new URL("./agent-tools.mjs", import.meta.url)),
  implement: fileURLToPath(new URL("./implement-tools.mjs", import.meta.url)),
};
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FILE_TOOLS = ["read", "list", "glob", "grep", "edit", "write"];
const STAGE_TOOLS = {
  spec: ["oracle_inventory", "oracle_probe", "oracle_find_fixture", "oracle_declare_spec", "oracle_public_cases"],
  implement: ["implement_spec", "implement_public_summary", "implement_public_case", "implement_check",
    "implement_run", "implement_refresh_public"],
};
const STAGE_FILE_TOOLS = {
  /* OpenCode's `edit` permission covers edit, write and patch. The specification stage must not
     write files at all: oracle_declare_spec is the only path to spec.json, so every declaration
     is validated and coverage-checked by the driver. */
  spec: FILE_TOOLS.filter(tool => tool !== "write" && tool !== "edit"),
  implement: FILE_TOOLS,
};

export function specPrompt({ workspace, archiveName }) {
  return `You are writing the behavioral specification for a desktop Electron application. You cannot
see its source; that is deliberate. The packaged app is available only through the \`oracle\` tools,
which run the real main process under a mocked Electron host.

Application: ${archiveName}
Workspace: ${workspace}

## What you produce

One JSON specification, declared with \`oracle_declare_spec\`, that lets another engineer rebuild
every IPC channel without ever observing the original:

- every original channel (the inventory is authoritative) implemented by a feature module path;
- fixtures under \`userData\`/\`documents\`/\`logs\`/\`temp\` that make the channel reachable;
- at least three argument samples that produce distinct outcomes;
- numbered \`requirements\`: precise, observable rules — return values, error names/codes, file
  paths, exact bytes, ordering, persistence across calls, edge conditions;
- optional stateful \`sequences\`: fixture set plus an ordered list of calls that prove behavior
  across several interactions.

The driver generates differential cases from these declarations, runs them against the original,
and only hands your specification to the implementation agent if every channel is reachable.

Shape (complete, version 2):

\`\`\`json
{
  "schema_version": 2,
  "application": {
    "name": "app-name", "version": "1.2.3",
    "scope": ["main-process IPC channels and their persisted files"],
    "exclusions": ["renderer layout", "menus and tray"],
    "blockers": [], "unresolved": [],
    "environments": { "clock": "2026-10-25T12:00:00.000Z" }
  },
  "channels": {
    "example:channel": {
      "feature": "features/example-channel.cjs",
      "title": "Short user-facing name",
      "description": "What the channel does",
      "params": [{ "name": "id", "type": "string", "example": "sample" }],
      "fixtures": [{ "base": "userData", "path": "data/items.json", "content": { "items": [] } }],
      "args": [["sample"], ["missing"], [null]],
      "requirements": [
        "Returns the matching record as { id, count } and writes userData/data/items.json with two-space JSON.",
        "Throws Error with code ENOENT when data/items.json is absent and does not create it."
      ],
      "sequences": [
        { "description": "the second call sees the first call's write",
          "calls": [{ "channel": "example:channel", "args": ["sample"] },
                    { "channel": "example:channel", "args": ["sample"] }] }
      ]
    }
  }
}
\`\`\`

You have no file-write tools: \`oracle_declare_spec\` is the only way to save the specification,
and it validates the result. A specification the driver cannot tie to a declaration is ignored.

## How to observe

- \`oracle_inventory\` — channels with arity, preload bridges, renderer loads, modules, diagnostics.
- \`oracle_probe\` — run the original with fixtures and calls. The reply has handler values or
  errors, every file after each call, and the paths read or written. Probe one interaction per
  call; use \`calls\` for stateful behavior.
- \`oracle_find_fixture\` — when a probe fails on a missing file or object field, this searches the
  fixture shape mechanically. Use it instead of guessing structural details.
- \`oracle_declare_spec\` — validate and save the specification. It returns coverage gaps; a spec
  with gaps is not accepted.
- \`oracle_public_cases\` — after a successful declaration, the generated public cases and the
  original outcomes. Re-read them to confirm your requirements explained what was observed.

## What good requirements look like

Write the rule an implementer needs, not a transcript of one probe:

- "grade below 3 resets repetitions to 0 and sets interval to null" — good.
- "returns the card" — too vague; list every field and its value.
- Mention error names and codes, whether a missing file is created, JSON indentation and key
  order when files are compared byte for byte, and what the second call sees after the first.
- Probe boundary values (0, 1, negative, empty string, whitespace, unicode), missing fixture
  fields and repeated calls. The driver mutates your fixtures and arguments mechanically, so
  rules that only cover one sample will fail.
- Record genuine blockers in \`application.blockers\` rather than guessing.

## How cases are generated (the evaluation domain)

The driver builds cases mechanically from your declarations, in these shape families:

- \`base\`: your fixtures and the first argument sample, unchanged.
- \`fixture-mutation\`: each fixture key removed; arrays emptied, reversed, duplicated or given a
  repeated item; object values replaced with \`{}\`; scalars changed.
- \`args\`: every argument replaced by the value pools — strings \`""\`, \`"missing"\`, \`"Alpha"\`,
  \`"zz"\`; numbers \`-1, 0, 1, 2, 3, 4, 5, 6, 9, 0.5\`; booleans both ways; empty and duplicated
  arrays; \`{}\`.
- \`cold\`: no fixtures at all, so files the app writes are absent.
- \`repeat\`: the same call twice in one process.
- \`sequence\`: each sequence you declare.

A public case from every shape family is always visible to the implementer, but the values differ
in held-out cases. So the requirements must state what happens for each family — for example what
the app does when a required array is missing from a fixture, when a file is absent, or when a
number is negative — not only for the sample you happened to type.

## Channels that cannot be reimplemented

The implementation contract gives a feature module only \`{ app, fs, path, userData, documents }\`.
A channel whose result depends on a host object the module cannot see — which window invoked it,
window bounds or focus, menus, tray icons, dialogs, notifications, protocol handlers, the
updater, network responses — cannot be reproduced from a specification. Do not guess its values
and do not describe mock behavior as app behavior. Declare it in \`channel_exclusions\` instead:

\`\`\`json
"channel_exclusions": [
  { "channel": "get-window-bounds", "reason": "result depends on the invoking window's bounds, which the feature contract does not expose" }
]
\`\`\`

Every original channel must be either implemented or explicitly excluded with a reason. Exclusions
are reported to the reader and prevent a whole-app readiness claim, so exclude only what genuinely
cannot be expressed, never a channel that is merely inconvenient.

Exclusion is the last resort, not an escape hatch. If a channel only fails because a fixture is
unreachable, that is a fixture problem: call \`oracle_find_fixture\`, then probe the repaired
fixtures. A channel that reads values or files is always implementable from a specification.
Excluding every channel is rejected outright.

The generated cases freeze the clock at 2026-10-25T12:00:00.000Z; pass \`fixed_time\` to probes
whenever a handler reads the clock, and declare it per channel if needed.

## Rules

- Never request, infer from shell output, or reproduce original source. You have no shell.
- Do not implement the channels; feature modules are written by a different agent from your
  specification alone.
- Do not add dependencies.
- Iterate until \`oracle_declare_spec\` reports no problems and no coverage gaps.`;
}

export function implementationPrompt({ workspace, archiveName }) {
  return `You are implementing a desktop Electron application from a written specification. There is
no original application available to you and no oracle: \`SPEC.md\`, \`spec.json\` and
\`public-cases.json\` in ${workspace} are the complete handoff.

Application: ${archiveName}

## Your job

Read \`SPEC.md\` first. For every channel it lists, write the feature module at the declared path
(usually under \`features/\`). Channels listed as excluded are not part of your job. Each module is
CommonJS and exports a function or \`{ handle }\`:

\`\`\`js
module.exports = async function handle(args, ctx) {
  // args: IPC arguments after the event, as an array
  // ctx: { app, fs, path, userData, documents }
  return value;
};
\`\`\`

Implement the stated requirements. Match returned JSON exactly (including key presence,
\`undefined\` versus \`null\`, and non-finite numbers), throw the same error names and codes,
write the same files with the same bytes, and persist state between calls.

## Checking

- \`implement_public_summary\` — the public cases with their original outcomes, compact.
- \`implement_public_case\` — full fixtures and expected effects for one named case.
- \`implement_check\` — assemble the workspace and run every public case, plus repair cases once
  they are visible. This is the same differential comparison the driver uses.
- \`implement_run\` — run a single free-form case against your build, for debugging.

Run \`implement_check\` early (a failing build is informative), then after each module, and keep
fixing until every partition reports \`passed === total\` and no coverage gaps. If a case fails,
read its name in the failure, inspect it with \`implement_public_case\`, and fix the rule.

## Rules

- Implement the behavior, not the samples. Held-out cases use the same requirements with
  different inputs; special-casing argument values will fail.
- Only Node built-ins are available.
- A workspace file may not live outside the workspace; feature paths come from the specification.
- Do not stop while \`implement_check\` reports a failure or an unaddressed public case.`;
}

function limitsFor(model) {
  return { context: Number(process.env.ELECTRON_AGENT_CONTEXT ?? 196608),
    output: Number(process.env.ELECTRON_AGENT_OUTPUT ?? 16384) };
}

export async function runAgent({ stage = "spec", workspace, stateDir, appDir, archiveName, analysisFile,
  publicFile, candidateDir, model, timeout = Number(process.env.ELECTRON_AGENT_TIMEOUT || 1200),
  round = 1, feedback = "", log }) {
  if (!STAGE_TOOLS[stage]) throw new Error(`Unknown agent stage ${stage}`);
  workspace = path.resolve(workspace);
  stateDir = path.resolve(stateDir);
  analysisFile = path.resolve(analysisFile);
  const role = stage === "spec" ? "electron_spec_writer" : "electron_implementer";
  model = model ?? process.env[`MODEL_${role.toUpperCase()}`] ?? resolveModel(role);
  const allowed = [...STAGE_FILE_TOOLS[stage], ...STAGE_TOOLS[stage]];
  const permission = { "*": "deny", ...Object.fromEntries(allowed.map(tool => [tool, "allow"])) };
  const mcp = stage === "spec" ? {
    oracle: {
      type: "local", enabled: true,
      command: [process.execPath, TOOLS.spec, "--app-dir", path.resolve(appDir),
        "--workspace", workspace, "--analysis", analysisFile,
        "--public-cases", publicFile ? path.resolve(publicFile) : "",
        "--candidate", path.resolve(candidateDir ?? path.join(stateDir, "candidate"))],
      timeout: 600000,
    },
  } : {
    implement: {
      type: "local", enabled: true,
      command: [process.execPath, TOOLS.implement, "--workspace", workspace,
        "--analysis", analysisFile, "--public-cases", path.resolve(publicFile),
        "--candidate", path.resolve(candidateDir)],
      timeout: 600000,
    },
  };
  const config = {
    $schema: "https://opencode.ai/config.json",
    model,
    small_model: model,
    permission,
    agent: {
      [stage]: {
        mode: "primary", model,
        prompt: stage === "spec"
          ? "Write an application's behavioral specification from oracle observations; never request source."
          : "Implement the application from the written specification; never request the original app.",
        permission,
      },
    },
    mcp,
  };
  if (model.startsWith("amazon-bedrock/")) {
    const modelId = model.slice("amazon-bedrock/".length);
    config.provider = {
      "amazon-bedrock": {
        models: { [modelId]: { name: modelId, id: modelId,
          provider: { npm: "@ai-sdk/amazon-bedrock" }, limit: limitsFor(model) } },
      },
    };
  }
  const configPath = path.join(stateDir, `opencode-${stage}-round-${round}.json`);
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  const eventsPath = path.join(stateDir, `agent-${stage}-round-${round}.events.jsonl`);
  const stderrPath = path.join(stateDir, `agent-${stage}-round-${round}.stderr.log`);
  const prompt = (stage === "spec"
    ? specPrompt({ workspace, archiveName: archiveName ?? path.basename(stateDir) })
    : implementationPrompt({ workspace, archiveName: archiveName ?? path.basename(stateDir) })) +
    (feedback ? `\n\n## Previous round feedback\n${feedback}\n` : "");
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
  log?.(`agent ${stage} round ${round}: ${model}`);
  const completed = await new Promise(resolve => {
    /* --standalone gives each round a private server that loads this round's config. Reusing
       OpenCode's background service keeps the first run's agent list and MCP servers, which
       makes a later stage fail with "Agent not found". */
    const child = spawn(opencode, ["run", "--standalone", "--print-logs", "--title", `electron-${stage}`,
      "--agent", stage, "--model", model, "--format", "json", prompt],
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
  const errors = rows.filter(row => row.type === "error")
    .map(row => row.error?.data?.message ?? row.error?.name ?? "error");
  const usage = rows.filter(row => row.type === "step_finish").map(row => row.part?.tokens?.total ?? 0);
  return { stage, round, model, exitCode: completed.code, timedOut: completed.timedOut,
    error: completed.error?.message, eventsPath, stderrPath, text: texts.join("\n").trim(),
    toolCalls, errors: errors.slice(0, 20), tokens: usage.reduce((sum, value) => sum + value, 0) };
}
