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
import { buildCases, coverage, coverageGaps, filesWithoutDescribedContent, hash, narrowChannels,
  partitionCases, usableResults } from "./cases.mjs";
import { excludedChannels, validateSpec } from "./spec.mjs";
import { findFixture } from "./fixture-search.mjs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

/* A probe reply is read by an agent with a finite context window, so persisted file content is
   reported as a bounded digest plus the head of the file. `file` re-runs the same probe when a
   requirement has to describe one file's exact bytes. */
const FILE_CHARS = 4000;
const IO_PAIRS = 60;

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
  const result = await runCase({ appDir, case: testCaseFrom(input), timeout: input.timeout_ms ?? 20000 });
  return {
    channels: result.channels,
    outcomes: result.outcomes.map(outcome => outcome.ok
      ? { ok: true, value: outcome.value }
      : { ok: false, error: { name: outcome.error.name, message: outcome.error.message, code: outcome.error.code } }),
    calls: callEffects(result),
    files: fileSummary(result.files),
    io: ioPairs(result.io),
    bridge: result.bridge,
    startup_error: result.startup_error,
    note: `Changed file content is capped at ${FILE_CHARS} characters (marked \"truncated\"). ` +
      "Use the `file` tool, with the same fixtures and calls, to read one file's exact bytes.",
  };
}

function clipFile(value) {
  if (typeof value !== "string") return { bytes: value.size, sha256: value.sha256.slice(0, 12) };
  if (value.length <= FILE_CHARS) return value;
  return { truncated: true, characters: value.length, head: value.slice(0, FILE_CHARS) };
}

function fileSummary(files) {
  const summary = {};
  for (const [file, value] of Object.entries(files))
    summary[file] = typeof value === "string"
      ? { characters: value.length, sha256: hash(value).slice(0, 12) }
      : { bytes: value.size, sha256: value.sha256.slice(0, 12) };
  return summary;
}

function callEffects(result) {
  return result.effects.map((effect, index) => ({
    call: index,
    changed: Object.fromEntries(Object.entries(effect.changed).map(([file, value]) => [file, clipFile(value)])),
    removed: effect.removed,
  }));
}

function ioPairs(io) {
  const pairs = new Map();
  for (const entry of io) {
    const key = `${entry.op} ${entry.path}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  return { total: io.length, unique: [...pairs.entries()].slice(0, IO_PAIRS)
    .map(([key, count]) => ({ effect: key, calls: count })) };
}

function testCaseFrom(input) {
  return input.calls
    ? { calls: input.calls, fixtures: input.fixtures ?? [], fixed_time: input.fixed_time }
    : { channel: input.channel, args: input.args ?? [], fixtures: input.fixtures ?? [], fixed_time: input.fixed_time };
}

/** The content of one persisted file after call `index`, replayed from the observation. */
function fileAfter(result, file, index) {
  let value = Object.hasOwn(result.initial, file) ? result.initial[file] : undefined;
  for (let call = 0; call <= index; call++) {
    const effect = result.effects[call];
    if (!effect) continue;
    if (Object.hasOwn(effect.changed, file)) value = effect.changed[file];
    if (effect.removed.includes(file)) value = undefined;
  }
  return value;
}

async function probeFile(input) {
  const match = /^(userData|documents|logs|temp)\/(.+)$/.exec(String(input.path ?? ""));
  if (!match) return { found: false,
    problem: "path must be relative to a fixture base, for example userData/config.json" };
  const file = `${match[1]}/${match[2]}`;
  const result = await runCase({ appDir, case: testCaseFrom(input), timeout: input.timeout_ms ?? 20000 });
  const last = input.call === undefined ? result.outcomes.length - 1 : Number(input.call);
  if (!Number.isInteger(last) || last < 0 || last >= result.outcomes.length)
    return { path: file, found: false, calls: result.outcomes.length,
      problem: `call must be between 0 and ${result.outcomes.length - 1}` };
  const value = fileAfter(result, file, last);
  if (value === undefined) return { path: file, call: last, found: false,
    files: Object.keys(result.files),
    problem: `${file} does not exist after call ${last}` };
  if (typeof value !== "string") return { path: file, call: last, found: true, hashed: true,
    bytes: value.size, sha256: value.sha256,
    problem: `the file is larger than the oracle's 262144-byte snapshot limit, so only its digest is available` };
  const offset = Math.max(0, Number(input.offset ?? 0));
  const maxChars = Math.min(50000, Math.max(200, Number(input.max_chars ?? 20000)));
  const text = value.slice(offset, offset + maxChars);
  return { path: file, call: last, found: true, characters: value.length, sha256: hash(value).slice(0, 12),
    offset, text, more: offset + text.length < value.length };
}

/* Every declared revision is re-checked, and most of its cases are unchanged, so the round's
   observations are kept: the oracle freezes the clock and gives each case a fresh data directory,
   which makes a case's answer a function of its fixtures and calls alone. */
const caseCache = new Map();

async function cachedRun(testCase) {
  const key = hash({ channel: testCase.channel, fixtures: testCase.fixtures, calls: testCase.calls,
    fixed_time: testCase.fixed_time });
  if (!caseCache.has(key)) {
    try {
      caseCache.set(key, { case: testCase, result: await runCase({ appDir, case: testCase }) });
    } catch (error) {
      caseCache.set(key, { case: testCase, error: { name: error.name ?? "Error", message: error.message } });
    }
  }
  return caseCache.get(key);
}

async function runSample(cases, concurrency = 6) {
  const results = new Array(cases.length);
  let cursor = 0;
  async function worker() {
    while (cursor < cases.length) { const index = cursor++; results[index] = await cachedRun(cases[index]); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  return results;
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
  const declared = new Set(Object.keys(spec.channels ?? {}));
  /* Declaration is incremental, so evaluate only what is declared: a channel that has not been
     declared yet is reported as remaining, not as a coverage gap. */
  const channels = inventory().channels.filter(entry => !excluded.has(entry.channel) && declared.has(entry.channel));
  if (!channels.length) {
    preparedHash = null;
    return { problems: ["Every original channel is excluded, so the specification describes nothing. " +
      "Exclusions are only for behavior the feature contract cannot express. Repair the fixtures " +
      "(find_fixture repairs missing files and fields) and declare the channels you abandoned."] };
  }
  const built = buildCases({ contract: spec, channels, seed: "public" });
  /* Coverage feedback during discovery samples shape-diverse cases per channel instead of running
     the whole generated suite on every declaration. The driver observes the full suite once, so
     a large application does not spend its round budget re-running hundreds of probes each time
     the specification changes. */
  const sample = [];
  const perChannel = new Map();
  const MAX_PER_CHANNEL = 12, MAX_PER_SHAPE = 6;
  for (const testCase of built.all) {
    const entry = perChannel.get(testCase.channel) ?? { shapes: new Map(), count: 0 };
    if (entry.count >= MAX_PER_CHANNEL) continue;
    const seen = entry.shapes.get(testCase.shape) ?? 0;
    if (seen >= MAX_PER_SHAPE) continue;
    entry.shapes.set(testCase.shape, seen + 1);
    entry.count++;
    perChannel.set(testCase.channel, entry);
    sample.push(testCase);
  }
  const observed = usableResults(await runSample(sample));
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
  return { problems: [], cases: publicSuite.cases.length, sampled_cases: sample.length,
    coverage: publicSuite.coverage,
    gaps: coverageGaps(observed, channelNames),
    narrow: narrowChannels(observed, channelNames),
    undescribed_files: filesWithoutDescribedContent(spec, observed),
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
  description: "Run the original app under a mocked Electron host with optional fixtures and invoke IPC channels. Returns handler values or errors, each call's changed or removed files, and an index of every file. Content is bounded, so use `file` when a file's exact bytes matter. Nothing is cached between probes.",
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

server.registerTool("file", {
  title: "Read one persisted file exactly",
  description: "Re-run a probe and return the exact bytes of one file under userData, documents, logs or temp after a given call. Probe replies cap file content; use this when a requirement must state a file's bytes precisely.",
  inputSchema: {
    path: z.string().describe("Base-relative path, for example userData/config.json"),
    call: z.number().optional().describe("Call index to read after; defaults to the last call"),
    channel: z.string().optional().describe("IPC channel to invoke"),
    args: z.array(z.any()).optional().describe("Argument array for channel"),
    calls: z.array(z.looseObject({ channel: z.string(), args: z.array(z.any()).optional() })).optional()
      .describe("Ordered calls for a stateful probe; overrides channel/args"),
    fixtures: z.array(fixtureSchema).optional(),
    fixed_time: z.string().optional().describe("Freeze Date to this ISO instant"),
    offset: z.number().optional().describe("Character offset to start from"),
    max_chars: z.number().optional().describe("Maximum characters to return (default 20000)"),
    timeout_ms: z.number().optional(),
  },
}, async input => text(await probeFile(input)));

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
    outcomes: found.result.outcomes, calls: callEffects(found.result),
    files: fileSummary(found.result.files) });
});

server.registerTool("declare_spec", {
  title: "Declare the behavioral specification",
  description: "Declare channels (and optionally application metadata, exclusions and schema_version) into spec.json. Each call merges into the current specification, so a large application can be declared in batches without one oversized tool call. Returns remaining channels, validation problems and coverage gaps for what is declared.",
  inputSchema: {
    spec: specSchema.partial(),
    replace_channels: z.boolean().optional()
      .describe("Discard previously declared channels before applying this batch"),
  },
}, async ({ spec, replace_channels }) => {
  const existing = readSpec();
  const merged = {
    schema_version: spec.schema_version ?? existing?.schema_version ?? 2,
    application: { ...(existing?.application ?? {}), ...(spec.application ?? {}) },
    channels: replace_channels ? { ...(spec.channels ?? {}) }
      : { ...(existing?.channels ?? {}), ...(spec.channels ?? {}) },
    channel_exclusions: spec.channel_exclusions !== undefined
      ? spec.channel_exclusions : (existing?.channel_exclusions ?? []),
  };
  fs.writeFileSync(path.join(workspace, "spec.json"), JSON.stringify(merged, null, 2) + "\n");
  preparedHash = null;
  const allProblems = spec.schema_version === undefined && merged.schema_version !== 2
    ? ["schema_version must be 2"] : [];
  const report = merged.schema_version === 2 ? await prepareCases(merged)
    : { problems: allProblems, cases: 0, coverage: {}, gaps: [] };
  const problems = (report.problems ?? []).filter(problem =>
    !problem.startsWith("Contract does not declare original channel(s)"));
  const excluded = excludedChannels(merged);
  const remaining = inventory().channels.map(entry => entry.channel)
    .filter(channel => !(channel in merged.channels) && !excluded.has(channel));
  /* The driver only trusts a specification that was declared: this record binds the file to the
     validated revision. It is only written once nothing is left undeclared or broken. */
  const complete = !remaining.length && !problems.length && !(report.gaps ?? []).length;
  if (complete) fs.writeFileSync(path.join(workspace, "spec.declared.json"), JSON.stringify({
    sha256: specHash(merged), declared_at: new Date().toISOString(),
    problems, cases: report.cases ?? 0, gaps: report.gaps ?? [],
  }, null, 2) + "\n");
  return text({ saved: true, complete, remaining_channels: remaining,
    declared_channels: Object.keys(merged.channels).length,
    excluded_channels: [...excluded.keys()], problems,
    cases: report.cases ?? 0, coverage: report.coverage ?? {}, gaps: report.gaps ?? [],
    narrow_channels: report.narrow ?? [],
    undescribed_files: report.undescribed_files ?? [],
    next: remaining.length
      ? "Declare the remaining channels (send them in batches); the specification is not complete yet."
      : problems.length ? "Fix the listed problems and declare again."
      : report.gaps?.length ? "Close the coverage gaps before finishing."
      : report.narrow?.length || report.undescribed_files?.length
        ? "The specification is complete. Channels listed in narrow_channels answered with a single " +
          "outcome; keep them only if their result genuinely does not depend on their arguments. " +
          "Files listed in undescribed_files are written by cases but their content appears nowhere " +
          "in the specification: if an implementer cannot derive them, read them with oracle_file " +
          "and state them."
        : "Specification complete; stop declaring." });
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
