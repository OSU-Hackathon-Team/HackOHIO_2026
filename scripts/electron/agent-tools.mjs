/**
 * Oracle tools for the reconstruction agent.
 *
 * The agent sees a packaged app only through behavior: channel inventory, probe results, persisted
 * files and differential checks. It never receives the archive's source files or paths. This server
 * runs over stdio and is launched by the agent runtime with one extracted app directory.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCase } from "./oracle.mjs";
import { buildCases, compareCase, coverage, coverageGaps, hash, runSuite, usableResults, validateContract } from "./cases.mjs";
import { assembleProject, validateWorkspace } from "./project.mjs";
import { findFixture } from "./fixture-search.mjs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const appDir = path.resolve(argument("app-dir"));
const workspace = path.resolve(argument("workspace"));
const analysisFile = argument("analysis");
const publicFile = argument("public-cases");
const candidateDir = path.resolve(argument("candidate", path.join(workspace, ".candidate")));
const analysis = JSON.parse(fs.readFileSync(analysisFile, "utf8"));
let publicSuite = publicFile && fs.existsSync(publicFile) ? JSON.parse(fs.readFileSync(publicFile, "utf8")) : { cases: [], gaps: [] };
let preparedHash = null;
const contractHash = contract => (contract ? hash(contract) : null);

const text = value => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const clip = (value, limit = 1600) => {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  return json.length > limit ? `${json.slice(0, limit)}… (${json.length} chars)` : json;
};

function inventory() {
  return {
    package: { name: analysis.archive?.name ?? null, version: analysis.archive?.version ?? null,
      sha256: analysis.archive?.sha256 ?? null },
    entry: analysis.entries?.main ?? null,
    preloads: analysis.entries?.preloads ?? [],
    renderer_loads: analysis.entries?.renderers ?? [],
    channels: (analysis.ipc?.handles ?? []).map(({ channel, arity }) => ({ channel, arity })),
    bridge_exports: (analysis.bridge_exports ?? []).map(({ global, methods }) => ({ global,
      methods: (methods ?? []).map(method => ({ name: method.name, invokes: method.invokes })) })),
    assets: (analysis.assets ?? []).map(asset => ({ file: asset.file, type: asset.type })),
    modules: analysis.reachable_modules ?? [],
    diagnostics: (analysis.diagnostics ?? []).slice(0, 40),
    analysis_limits: analysis.analysis_limits ?? [],
    note: "Original source is intentionally unavailable. Infer behavior only from probe results.",
  };
}

async function probe(input) {
  const testCase = input.calls ? { calls: input.calls, fixtures: input.fixtures ?? [], fixed_time: input.fixed_time }
    : { channel: input.channel, args: input.args ?? [], fixtures: input.fixtures ?? [], fixed_time: input.fixed_time };
  const result = await runCase({ appDir, case: testCase, timeout: input.timeout_ms ?? 20000 });
  return {
    channels: result.channels,
    outcomes: result.outcomes.map(outcome => outcome.ok
      ? { ok: true, value: outcome.value }
      : { ok: false, error: { name: outcome.error.name, message: outcome.error.message, code: outcome.error.code } }),
    files: result.files,
    effects: result.effects,
    io: result.io.slice(-60),
    bridge: result.bridge,
    startup_error: result.startup_error,
  };
}

function readContract() {
  const file = path.join(workspace, "contract.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

async function prepareCases(contract) {
  const problems = validateContract(contract, inventory().channels);
  if (problems.length) { preparedHash = null; return { problems }; }
  const built = buildCases({ contract, channels: inventory().channels, seed: "public" });
  const results = await runSuite({ runCase, appDir, cases: built.publicCases });
  const usable = usableResults(results);
  publicSuite = {
    coverage: coverage(usable),
    gaps: coverageGaps(usable, inventory().channels.map(item => item.channel)),
    cases: usable.map(item => ({ case: item.case, result: item.result })),
  };
  if (publicFile) fs.writeFileSync(publicFile, JSON.stringify(publicSuite) + "\n");
  preparedHash = contractHash(contract);
  return { problems: publicSuite.gaps.map(gap => `Coverage: ${gap}`), cases: publicSuite.cases.length,
    coverage: publicSuite.coverage, gaps: publicSuite.gaps };
}

async function assemble(contract) {
  const problems = validateWorkspace(workspace, analysis, contract);
  if (problems.length) return { problems };
  try {
    return { ...(await assembleProject({ analysis, contract, workspace, output: candidateDir })) };
  } catch (error) {
    return { problems: [error.message] };
  }
}

async function verify(input) {
  const contract = input.contract ?? readContract();
  if (!contract) return { passed: 0, total: 0, failures: [{ problem: "No contract.json declared." }] };
  if (preparedHash !== contractHash(contract)) {
    const report = await prepareCases(contract);
    if (report.problems) return { passed: 0, total: 0, failures: report.problems.map(problem => ({ problem })) };
  }
  const buildProblems = validateWorkspace(workspace, analysis, contract);
  if (buildProblems.length) return { passed: 0, total: publicSuite.cases.length,
    failures: buildProblems.map(problem => ({ problem })), gaps: publicSuite.gaps ?? [] };
  const built = await assemble(contract);
  if (built.problems) return { passed: 0, total: 0, failures: built.problems.map(problem => ({ problem })) };
  const cases = publicSuite.cases;
  const results = await runSuite({ runCase, appDir: candidateDir, cases: cases.map(item => item.case) });
  const expected = new Map(cases.map(item => [item.case.name, item.result]));
  const failures = [];
  let passed = 0;
  for (const item of results) {
    const want = expected.get(item.case.name);
    if (!want) continue;
    if (item.error) { failures.push({ case: item.case.name, problems: [`candidate did not run: ${item.error.message}`] }); continue; }
    const problems = compareCase(want, item.result);
    if (problems.length) failures.push({ case: item.case.name, channel: item.case.channel, calls: item.case.calls,
      fixtures: item.case.fixtures, problems: problems.map(problem => clip(problem, 1200)) });
    else passed++;
  }
  const gaps = publicSuite.gaps ?? [];
  return { passed, total: cases.length,
    failures: [...gaps.map(gap => ({ problem: `Coverage: ${gap}` })), ...failures].slice(0, 10), gaps };
}

const server = new McpServer({ name: "oracle", version: "1.0.0" });

server.registerTool("inventory", {
  title: "Archive inventory",
  description: "Static inventory of the packaged app: package metadata, IPC channels and arity, preload bridge globals, renderer loads and assets.",
  inputSchema: {},
}, async () => text(inventory()));

server.registerTool("probe", {
  title: "Probe the original app",
  description: "Run the original app under a mocked Electron host with optional fixtures and invoke IPC channels. Returns handler values or errors and every file effect. Use it to discover behavior; nothing is cached between probes.",
  inputSchema: {
    channel: z.string().optional().describe("IPC channel to invoke"),
    args: z.array(z.any()).optional().describe("Argument array for channel"),
    calls: z.array(z.object({ channel: z.string(), args: z.array(z.any()).optional() })).optional()
      .describe("Ordered calls for a stateful probe; overrides channel/args"),
    fixtures: z.array(z.object({ base: z.enum(["userData", "documents", "logs", "temp"]), path: z.string(), content: z.any() })).optional(),
    fixed_time: z.string().optional().describe("Freeze Date to this ISO instant"),
    timeout_ms: z.number().optional(),
  },
}, async input => text(await probe(input)));

server.registerTool("find_fixture", {
  title: "Repair an unreachable fixture",
  description: "When a probe fails because a fixture is missing a file or an object field, search the fixture shape mechanically and return the first version where the channel succeeds. Use it instead of guessing field names; it only adds structure the error names or that already appears in the fixture set.",
  inputSchema: {
    channel: z.string(),
    args: z.array(z.any()).optional(),
    fixtures: z.array(z.object({ base: z.enum(["userData", "documents", "logs", "temp"]), path: z.string(), content: z.any() })).optional(),
    timeout_ms: z.number().optional(),
  },
}, async input => {
  const found = await findFixture({ appDir, channel: input.channel, args: input.args ?? [],
    fixtures: input.fixtures ?? [], timeout: input.timeout_ms ?? 20000 });
  if (!found.found) return text({ found: false, attempts: found.attempts, failures: found.failures });
  return text({ found: true, attempts: found.attempts, fixtures: found.fixtures,
    outcomes: found.result.outcomes, files: found.result.files });
});

server.registerTool("public_cases", {
  title: "Public differential cases",
  description: "The public cases the reconstruction must pass, with the original app's observed outcomes and file effects. Fixture sets are shared by reference.",
  inputSchema: {},
}, async () => {
  const contract = readContract();
  if (!contract) return text({ cases: [], gaps: ["Declare a contract first."] });
  if (preparedHash !== contractHash(contract)) await prepareCases(contract);
  return text(publicSuite);
});

server.registerTool("declare_contract", {
  title: "Declare the reconstruction contract",
  description: "Write contract.json for the workspace. Every original channel needs a feature module, the fixtures that make it reachable, and sample arguments. Returns validation problems.",
  inputSchema: {
    contract: z.object({
      schema_version: z.number(),
      channels: z.record(z.string(), z.object({
        feature: z.string().describe("Workspace-relative module that exports a function or { handle }"),
        fixtures: z.array(z.object({ base: z.enum(["userData", "documents", "logs", "temp"]), path: z.string(), content: z.any() })).optional(),
        args: z.array(z.array(z.any())).optional(),
        params: z.array(z.object({ name: z.string(), type: z.enum(["string", "number", "boolean", "json"]), example: z.any().optional() })).optional(),
        title: z.string().optional(),
        description: z.string().optional(),
      })),
    }),
  },
}, async ({ contract }) => {
  fs.writeFileSync(path.join(workspace, "contract.json"), JSON.stringify(contract, null, 2) + "\n");
  preparedHash = null;
  const report = await prepareCases(contract);
  return text({ saved: true, ...report });
});

server.registerTool("verify", {
  title: "Verify the candidate",
  description: "Assemble the workspace into a runnable Electron project and compare it with the original app on every public case. Returns the count passed and compact failure details.",
  inputSchema: { contract: z.any().optional() },
}, async input => text(await verify(input)));

server.registerTool("candidate", {
  title: "Run the candidate",
  description: "Assemble the current workspace and run one free-form case against the candidate, for debugging without the original comparison.",
  inputSchema: {
    channel: z.string().optional(),
    args: z.array(z.any()).optional(),
    calls: z.array(z.object({ channel: z.string(), args: z.array(z.any()).optional() })).optional(),
    fixtures: z.array(z.object({ base: z.enum(["userData", "documents", "logs", "temp"]), path: z.string(), content: z.any() })).optional(),
    fixed_time: z.string().optional(),
  },
}, async input => {
  const contract = readContract();
  if (!contract) return text({ error: "No contract.json declared." });
  const built = await assemble(contract);
  if (built.problems) return text({ problems: built.problems });
  const result = await runCase({ appDir: candidateDir, case: input });
  return text({ channels: result.channels, outcomes: result.outcomes, files: result.files,
    startup_error: result.startup_error });
});

await server.connect(new StdioServerTransport());
