/**
 * Oracle tools for the specification agent.
 *
 * The agent sees a packaged app only through behavior: channel inventory, probe results, persisted
 * files and coverage of the generated cases. It never receives the archive's source files or paths.
 * This server runs over stdio and is launched by the agent runtime with one extracted app
 * directory. The implementation agent is served by implement-tools.mjs instead.
 */
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCase } from "./oracle.mjs";
import { buildCases, coverage, coverageGaps, hash, partitionCases, runSuite, usableResults } from "./cases.mjs";
import { excludedChannels, validateSpec } from "./spec.mjs";
import { findFixture } from "./fixture-search.mjs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const appDir = path.resolve(argument("app-dir"));
const workspace = path.resolve(argument("workspace"));
const analysisFile = argument("analysis");
const publicFile = argument("public-cases");
const analysis = JSON.parse(fs.readFileSync(analysisFile, "utf8"));
let publicSuite = publicFile && fs.existsSync(publicFile)
  ? JSON.parse(fs.readFileSync(publicFile, "utf8")) : { cases: [], gaps: [] };
let preparedHash = null;
const specHash = spec => (spec ? hash(spec) : null);

const text = value => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

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

function readSpec() {
  const file = path.join(workspace, "spec.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

async function prepareCases(spec) {
  const problems = spec?.schema_version === 2 ? validateSpec(spec, inventory().channels)
    : ["schema_version must be 2 for a handoff specification"];
  if (problems.length) { preparedHash = null; return { problems }; }
  const excluded = excludedChannels(spec);
  const channels = inventory().channels.filter(entry => !excluded.has(entry.channel));
  if (!channels.length) {
    preparedHash = null;
    return { problems: ["Every original channel is excluded, so the specification describes nothing. " +
      "Exclusions are only for behavior the feature contract cannot express. Repair the fixtures " +
      "(find_fixture repairs missing files and fields) and declare the channels you abandoned."] };
  }
  const built = buildCases({ contract: spec, channels, seed: "public" });
  const observed = [];
  for (const cases of [built.publicCases, built.repairCases, built.finalCases]) {
    const results = await runSuite({ runCase, appDir, cases });
    observed.push(...usableResults(results));
  }
  const channelNames = channels.map(item => item.channel);
  for (const item of observed)
    item.result.channels = item.result.channels.filter(entry => !excluded.has(entry.channel));
  const partitioned = partitionCases({ items: observed, channels: channelNames });
  publicSuite = {
    coverage: coverage(partitioned.publicItems),
    gaps: coverageGaps(partitioned.publicItems, channelNames),
    cases: partitioned.publicItems.map(item => ({ case: item.case, result: item.result })),
  };
  if (publicFile) {
    fs.mkdirSync(path.dirname(path.resolve(publicFile)), { recursive: true });
    fs.writeFileSync(publicFile, JSON.stringify(publicSuite) + "\n");
  }
  preparedHash = specHash(spec);
  return { problems: [], cases: publicSuite.cases.length, coverage: publicSuite.coverage,
    gaps: coverageGaps(observed, channelNames, { minDistinct: 3 }),
    public_gaps: publicSuite.gaps,
    excluded_channels: [...excluded.keys()] };
}

const fixtureSchema = z.looseObject({
  base: z.enum(["userData", "documents", "logs", "temp"]),
  path: z.string(),
  content: z.any(),
});
const sequenceSchema = z.looseObject({
  fixtures: z.array(fixtureSchema).optional(),
  calls: z.array(z.looseObject({ channel: z.string(), args: z.array(z.any()).optional() })),
  description: z.string().optional(),
  fixed_time: z.string().optional(),
});
const channelSchema = z.looseObject({
  feature: z.string().describe("Workspace-relative module that exports a function or { handle }"),
  fixtures: z.array(fixtureSchema).optional(),
  args: z.array(z.array(z.any())).optional(),
  params: z.array(z.looseObject({ name: z.string(),
    type: z.enum(["string", "number", "boolean", "json"]), example: z.any().optional() })).optional(),
  requirements: z.array(z.string()).optional(),
  sequences: z.array(sequenceSchema).optional(),
  fixed_time: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
});
const specSchema = z.looseObject({
  schema_version: z.number(),
  application: z.looseObject({
    name: z.string().optional(),
    version: z.string().optional(),
    scope: z.array(z.string()).optional(),
    exclusions: z.array(z.string()).optional(),
    blockers: z.array(z.string()).optional(),
    unresolved: z.array(z.string()).optional(),
    environments: z.looseObject({ clock: z.string().optional() }).optional(),
  }).optional(),
  channels: z.record(z.string(), channelSchema),
});

const server = new McpServer({ name: "oracle", version: "2.0.0" });

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
    calls: z.array(z.looseObject({ channel: z.string(), args: z.array(z.any()).optional() })).optional()
      .describe("Ordered calls for a stateful probe; overrides channel/args"),
    fixtures: z.array(fixtureSchema).optional(),
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
    fixtures: z.array(fixtureSchema).optional(),
    timeout_ms: z.number().optional(),
  },
}, async input => {
  const found = await findFixture({ appDir, channel: input.channel, args: input.args ?? [],
    fixtures: input.fixtures ?? [], timeout: input.timeout_ms ?? 20000 });
  if (!found.found) return text({ found: false, attempts: found.attempts, failures: found.failures });
  return text({ found: true, attempts: found.attempts, fixtures: found.fixtures,
    outcomes: found.result.outcomes, files: found.result.files });
});

server.registerTool("declare_spec", {
  title: "Declare the behavioral specification",
  description: "Write spec.json for the workspace and validate it against the original channels. Returns validation problems, generated public case counts and coverage gaps. A specification with gaps is not accepted by the pipeline.",
  inputSchema: { spec: specSchema },
}, async ({ spec }) => {
  fs.writeFileSync(path.join(workspace, "spec.json"), JSON.stringify(spec, null, 2) + "\n");
  preparedHash = null;
  const report = await prepareCases(spec);
  /* The driver only trusts a specification that was declared: this record binds the file to the
     validated revision, including the cases and gaps the declaration produced. */
  fs.writeFileSync(path.join(workspace, "spec.declared.json"), JSON.stringify({
    sha256: specHash(spec), declared_at: new Date().toISOString(),
    problems: report.problems ?? [], cases: report.cases ?? 0, gaps: report.gaps ?? [],
  }, null, 2) + "\n");
  return text({ saved: true, ...report });
});

server.registerTool("public_cases", {
  title: "Public differential cases",
  description: "After a declaration, the generated public cases with the original outcomes and per-channel coverage. Use it to confirm the requirements explain what was observed.",
  inputSchema: {},
}, async () => {
  const spec = readSpec();
  if (!spec) return text({ cases: [], gaps: ["Declare a specification first."] });
  if (preparedHash !== specHash(spec)) await prepareCases(spec);
  return text(publicSuite);
});

await server.connect(new StdioServerTransport());
