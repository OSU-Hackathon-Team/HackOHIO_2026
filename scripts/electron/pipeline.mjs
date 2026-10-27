/**
 * End-to-end Electron reconstruction pipeline.
 *
 *   node scripts/electron/pipeline.mjs <app.asar> <new-output-directory> [options]
 *
 * Stage 1 (spec): a specification agent observes the packaged app through the black-box oracle and
 * writes a public specification: channels, fixtures, argument samples, numbered requirements and
 * stateful sequences. The driver turns that specification into differential cases and expects the
 * original app's answers.
 *
 * Stage 2 (implement): a different agent receives only the specification and the public cases. It
 * has no oracle and no archive path, so it cannot probe the original. Its build is compared with
 * the original on public and repair cases until it converges.
 *
 * Stage 3 (evaluate): the frozen candidate runs the held-out partition once, after repair is over.
 * There are no per-application adapters, templates, blueprints or scenarios.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as asar from "@electron/asar";
import { analyzeElectronArchive } from "./analyze-archive.mjs";
import { DEFAULT_HOST, VARIANT_HOST, runCase } from "./oracle.mjs";
import { buildCases, comparableShape, compareCase, coverage, coverageGaps, narrowChannels,
  observationFailures, partitionCases, runSuite, usableResults } from "./cases.mjs";
import { runAgent } from "./agent.mjs";
import { assembleProject } from "./project.mjs";
import { resolveModel } from "./models.mjs";
import { excludedChannels, renderSpecMarkdown, specHash, validateSpec, writeHandoff } from "./spec.mjs";

function parseArguments(argv) {
  const positional = [], options = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const key = value.slice(2);
    if (key === "keep-workspace") { options[key] = true; continue; }
    /* --only is repeatable: each occurrence adds channels to the run scope. */
    if (key === "only") { options.only = [...(options[key] ?? []), argv[++index]]; continue; }
    options[key] = argv[++index];
  }
  return { archive: positional[0], output: positional[1], options };
}

function log(message) {
  process.stderr.write(`[electron] ${message}\n`);
}

function channelInventory(analysis) {
  return (analysis.ipc?.handles ?? []).map(entry => ({ channel: entry.channel, arity: entry.arity ?? 0 }));
}

/*
 * A run can cover a subsystem of the application instead of all of it: `--only` selects channels
 * by name or wildcard. The scope only decides what this run specifies and verifies. Channels
 * outside it are declared as exclusions with their own source, so nothing disappears silently and
 * the run can never claim whole-app readiness from a partial reconstruction.
 */
function scopePatterns(options) {
  return [].concat(options.only ?? []).flatMap(value => String(value).split(","))
    .map(part => part.trim()).filter(Boolean);
}

function matchingChannels(inventory, patterns) {
  const matchers = patterns.map(pattern => new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
  return inventory.filter(entry => matchers.some(matcher => matcher.test(entry.channel)));
}

async function observe({ cases, appDir, timeout }) {
  const results = await runSuite({ runCase, appDir, cases, timeout });
  const usable = usableResults(results);
  return { usable, failures: observationFailures(results), total: results.length };
}

/*
 * Host-dependent behavior cannot be reimplemented from a specification: the feature-module
 * contract has no window and no display. Rather than verify a mocked host's own answer as if it
 * were the app's, the same case is replayed under a second host configuration (window bounds and
 * display size) and a channel whose result changes is reported as an exclusion.
 */
async function hostDependentChannels({ cases, appDir, timeout, concurrency = 4 }) {
  const representatives = new Map();
  for (const testCase of cases) {
    const known = representatives.get(testCase.channel);
    if (known && known.shape === "base") continue;
    if (!known || testCase.shape === "base") representatives.set(testCase.channel, testCase);
  }
  const entries = [...representatives.values()];
  const dependent = [];
  let cursor = 0;
  async function worker() {
    while (cursor < entries.length) {
      const testCase = entries[cursor++];
      let first, second;
      try {
        first = await runCase({ appDir, case: testCase, timeout, host: DEFAULT_HOST });
        second = await runCase({ appDir, case: testCase, timeout, host: VARIANT_HOST });
      } catch { continue; /* an unrunnable case says nothing about host dependence */ }
      const shape = result => JSON.stringify(comparableShape(result));
      if (shape(first) !== shape(second))
        dependent.push({ channel: testCase.channel, source: "host-variation",
          reason: `the observed result changes when the mocked host changes (window bounds ` +
            `${DEFAULT_HOST.bounds.width}x${DEFAULT_HOST.bounds.height} to ` +
            `${VARIANT_HOST.bounds.width}x${VARIANT_HOST.bounds.height}, display ` +
            `${DEFAULT_HOST.display.width}x${DEFAULT_HOST.display.height} to ` +
            `${VARIANT_HOST.display.width}x${VARIANT_HOST.display.height}), so it depends on a host ` +
            "object the feature contract does not expose" });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return dependent.sort((a, b) => a.channel.localeCompare(b.channel));
}

/* Turn a validated specification into what the driver will actually verify: the channels that can
   be reconstructed, the cases generated for them, and the exclusions that stand in the way of a
   whole-app claim. */
async function acceptSpecification({ spec, inventory, appDir, timeout, log }) {
  const excluded = excludedChannels(spec);
  let required = inventory.filter(entry => !excluded.has(entry.channel));
  if (!required.length) return { excluded, required, built: null, hostDependent: [], contract: spec };
  let built = buildCases({ contract: spec, channels: required, seed: "public" });
  const hostDependent = await hostDependentChannels({ cases: built.all, appDir, timeout });
  if (!hostDependent.length) return { excluded, required, built, hostDependent, contract: spec };
  const contract = { ...spec, channels: { ...spec.channels },
    channel_exclusions: [...(spec.channel_exclusions ?? []), ...hostDependent] };
  for (const item of hostDependent) { delete contract.channels[item.channel]; excluded.set(item.channel, item); }
  required = inventory.filter(entry => !excluded.has(entry.channel));
  built = required.length ? buildCases({ contract, channels: required, seed: "public" }) : null;
  log(`${hostDependent.length} host-dependent channel(s) excluded: ` +
    hostDependent.map(item => item.channel).join(", "));
  return { excluded, required, built, hostDependent, contract };
}

/** Add this run's subsystem exclusions to the contract that will be verified and assembled. */
function withScope(contract, exclusions) {
  if (!exclusions.length) return contract;
  return { ...contract,
    channel_exclusions: [...(contract.channel_exclusions ?? []), ...exclusions] };
}

async function checkSuite({ suite, candidate, timeout }) {
  if (!suite) return null;
  const results = await runSuite({ runCase, appDir: candidate, cases: suite.cases.map(item => item.case), timeout });
  const failures = [];
  let passed = 0;
  for (let index = 0; index < suite.cases.length; index++) {
    const want = suite.cases[index].result;
    const item = results[index];
    if (item.error) {
      failures.push({ case: item.case.name, channel: item.case.channel,
        problems: [`candidate did not run: ${item.error.message}`] });
      continue;
    }
    const problems = compareCase(want, item.result);
    if (problems.length) failures.push({ case: item.case.name, channel: item.case.channel,
      calls: item.case.calls, problems: problems.slice(0, 3) });
    else passed++;
  }
  return { passed, total: suite.cases.length, failures, gaps: suite.gaps ?? [] };
}

function partitionReport(suite, check) {
  return {
    cases: suite?.cases?.length ?? 0,
    passed: check?.passed ?? 0,
    total: check?.total ?? 0,
    coverage: suite?.coverage ?? {},
    gaps: check?.gaps ?? [],
    narrow: suite?.narrow ?? [],
    failures: (check?.failures ?? []).slice(0, 5).map(item => ({ case: item.case, channel: item.channel,
      problems: item.problems })),
  };
}

function describeRun(run) {
  return `${run.stage} round ${run.round}: ${run.toolCalls.length} tool call(s), ` +
    `exit ${run.exitCode ?? "timeout"}${run.errors.length ? `, ${run.errors.length} error(s)` : ""}`;
}

/* Failure feedback travels in an argv element, and a real application can fail hundreds of cases
   at once (Stretchly: 132 public cases, every one of them). The prompt therefore carries a bounded
   summary; the full list is written next to the specification for the agent to read. */
const FEEDBACK_PROBLEMS = 3;
const FEEDBACK_CHARS = 320;

function failureLines(failures, limit) {
  return failures.slice(0, limit).map(item => {
    const problems = (item.problems ?? []).map(problem => {
      const text = typeof problem === "string" ? problem : JSON.stringify(problem);
      return text.length > FEEDBACK_CHARS ? `${text.slice(0, FEEDBACK_CHARS)}…` : text;
    });
    return `- ${item.case} (${item.channel})\n  ${problems.join("\n  ")}`;
  }).join("\n");
}

function failureText(failures, limit = FEEDBACK_PROBLEMS) {
  return failureLines(failures, limit);
}

/** Every failing case with its calls, for the agent to read instead of the prompt. */
function failureReport(checks, limit = 20) {
  const lines = ["# Failing cases", ""];
  for (const [partition, check] of Object.entries(checks)) {
    if (!check) continue;
    lines.push(`## ${partition}: ${check.passed}/${check.total} cases match`, "");
    if (!check.failures.length) { lines.push("Every case in this partition matches.", ""); continue; }
    for (const item of check.failures.slice(0, limit)) {
      lines.push(`### \`${item.case}\` (${item.channel})`, "");
      lines.push("```json", JSON.stringify(item.calls ?? [], null, 2), "```", "");
      for (const problem of (item.problems ?? []).slice(0, 3))
        lines.push("- " + String(problem).replace(/\n/g, "\n  "));
      lines.push("");
    }
    if (check.failures.length > limit)
      lines.push(`… and ${check.failures.length - limit} more in this partition.`, "");
  }
  return lines.join("\n");
}

export async function reconstruct({ archive, output, options = {}, agentRunner = runAgent }) {
  if (!archive || !output) throw new Error("Usage: node scripts/electron/pipeline.mjs <app.asar> <new-output-directory>");
  const archivePath = path.resolve(archive);
  const outputPath = path.resolve(output);
  if (!fs.existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);
  if (fs.existsSync(outputPath) && fs.readdirSync(outputPath).length)
    throw new Error(`Output already exists and is not empty: ${outputPath}`);

  const specRounds = Number(options["spec-rounds"] ?? 2);
  const implRounds = Number(options["impl-rounds"] ?? Number(options.rounds ?? 2));
  const specTimeout = Number(options["spec-timeout"] ?? options.timeout ?? process.env.ELECTRON_SPEC_TIMEOUT ?? 1200);
  const implTimeout = Number(options["impl-timeout"] ?? options.timeout ?? process.env.ELECTRON_IMPL_TIMEOUT ?? 1200);
  const caseTimeout = Number(options["case-timeout"] ?? 20000);
  const specModelOption = options["spec-model"] ?? options.model;
  const implModelOption = options["impl-model"] ?? options.model;

  const stateDir = options.state ? path.resolve(options.state)
    : await fsp.mkdtemp(path.join(process.env.ELECTRON_STATE_ROOT || os.tmpdir(), "splice-electron-"));
  const appDir = path.join(stateDir, "original");
  const specWorkspace = path.join(stateDir, "spec");
  const handoff = path.join(stateDir, "implementation");
  const candidate = path.join(stateDir, "candidate");
  await fsp.mkdir(appDir, { recursive: true });
  await fsp.mkdir(specWorkspace, { recursive: true });
  asar.extractAll(archivePath, appDir);
  const analysis = analyzeElectronArchive(archivePath);
  /* Static discovery sees direct call shapes only. The app's own registration is authoritative:
     run it once with no calls and reconcile. A runtime-only channel is a real behavior, not an
     invention, and must be specified like any other. */
  const runtime = await runCase({ appDir, case: { calls: [] }, timeout: Number(options["startup-timeout"] ?? 60000) });
  analysis.ipc.runtime = runtime.channels;
  const staticChannels = new Map(analysis.ipc.handles.map(entry => [entry.channel, entry]));
  const runtimeNames = new Set(runtime.channels.map(entry => entry.channel));
  for (const entry of runtime.channels) {
    const known = staticChannels.get(entry.channel);
    if (known) { known.arity = entry.arity; known.runtime_arity = entry.arity; continue; }
    analysis.ipc.handles.push({ channel: entry.channel, arity: entry.arity, file: null, line: null,
      source: "runtime" });
    analysis.diagnostics.push({ severity: "warning", code: "runtime-only-channel", file: null, line: null,
      detail: `${entry.channel} is registered at runtime but was not found statically` });
  }
  for (const entry of [...analysis.ipc.handles]) {
    if (runtimeNames.has(entry.channel)) continue;
    analysis.ipc.handles = analysis.ipc.handles.filter(item => item !== entry);
    analysis.diagnostics.push({ severity: "warning", code: "unregistered-channel", file: entry.file ?? null,
      line: entry.line ?? null,
      detail: `${entry.channel} was found statically but never registered during startup; not treated as behavior` });
  }
  const inventory = channelInventory(analysis);
  const patterns = scopePatterns(options);
  const requiredInventory = patterns.length ? matchingChannels(inventory, patterns) : inventory;
  if (patterns.length && !requiredInventory.length)
    throw new Error(`Run scope ${patterns.join(", ")} matches no channel; the archive registers ` +
      `${inventory.length}: ${inventory.map(entry => entry.channel).join(", ")}`);
  const scopedNames = new Set(requiredInventory.map(entry => entry.channel));
  const outOfScope = inventory.filter(entry => !scopedNames.has(entry.channel));
  const scopeLabel = options["scope-label"] ?? patterns.join(", ");
  /* Out-of-scope channels are exclusions of this run, not of the application: the contract names
     them so the assembled project registers exactly what was verified, and the report keeps them
     separate from exclusions the specification agent declared. */
  const scopeExclusions = outOfScope.map(entry => ({ channel: entry.channel, source: "run-scope",
    reason: `outside this run's subsystem scope (${scopeLabel})` }));
  const analysisFile = path.join(stateDir, "analysis.json");
  const specPublicFile = path.join(stateDir, "spec-public-cases.json");
  const handoffPublicFile = path.join(handoff, "public-cases.json");
  await fsp.writeFile(analysisFile, JSON.stringify(analysis, null, 2) + "\n");
  log(`archive ${analysis.archive.sha256.slice(0, 12)} ${analysis.archive.name ?? ""}`);
  log(`${inventory.length} channel(s); spec workspace ${specWorkspace}`);
  if (patterns.length)
    log(`subsystem scope "${scopeLabel}": ${requiredInventory.length} of ${inventory.length} channel(s), ` +
      `${outOfScope.length} outside this run`);

  const runs = [];
  let spec = null;
  let contract = null;
  let hostDependent = [];
  let feedback = "";
  let suites = null;
  let observations = null;

  /* ---------------------------------------------------------------- stage 1: specification */
  /* An explicit --spec reuses a reviewed specification: discovery is skipped and the given file
     is validated and observed the same way a declared one would be. */
  const suppliedSpec = options.spec ? JSON.parse(await fsp.readFile(path.resolve(options.spec), "utf8")) : null;
  if (suppliedSpec) {
    const problems = validateSpec(suppliedSpec, requiredInventory);
    if (problems.length) throw new Error(`Supplied specification is invalid:\n${problems.join("\n")}`);
    log(`reusing specification ${path.resolve(options.spec)}`);
  }
  for (let round = 1; round <= (suppliedSpec ? 0 : specRounds); round++) {
    const run = await agentRunner({ stage: "spec", workspace: specWorkspace, stateDir, appDir,
      archiveName: analysis.archive.name ?? "", analysisFile, publicFile: specPublicFile,
      candidateDir: candidate, model: specModelOption, timeout: specTimeout, round, feedback, log,
      scope: { channels: requiredInventory.map(entry => entry.channel), label: scopeLabel,
        total: inventory.length } });
    run.round = round;
    runs.push(run);
    log(describeRun(run));
    const specFile = path.join(specWorkspace, "spec.json");
    if (!fs.existsSync(specFile)) {
      feedback = `No spec.json was declared (${run.timedOut ? "the round timed out" : "the round ended"}). ` +
        "Declare the complete specification with oracle_declare_spec before finishing.";
      continue;
    }
    const declared = JSON.parse(await fsp.readFile(specFile, "utf8"));
    const declarationFile = path.join(specWorkspace, "spec.declared.json");
    if (!fs.existsSync(declarationFile)) {
      feedback = "spec.json exists but was never declared. Save it with oracle_declare_spec so it is " +
        "validated and coverage-checked before the driver uses it.";
      continue;
    }
    const declaration = JSON.parse(await fsp.readFile(declarationFile, "utf8"));
    if (declaration.sha256 !== specHash(declared)) {
      feedback = "spec.json changed after its last declaration. Declare the current revision with " +
        "oracle_declare_spec.";
      continue;
    }
    const problems = validateSpec(declared, requiredInventory);
    if (problems.length) { feedback = `Specification problems:\n${problems.join("\n")}`; continue; }
    /* The run's scope becomes part of the specification for everything downstream: out-of-scope
       channels are excluded from the expected channel inventory, from case generation and from
       the assembled project, exactly like an exclusion the specification declared. */
    const accepted = await acceptSpecification({ spec: withScope(declared, scopeExclusions),
      inventory: requiredInventory, appDir, timeout: caseTimeout, log });
    if (!accepted.required.length) {
      feedback = accepted.hostDependent.length
        ? `Every channel that is not excluded is host-dependent, so nothing is left to reconstruct: ` +
          `${accepted.hostDependent.map(item => item.channel).join(", ")} answer differently when the ` +
          "mocked host changes, which no feature module can reproduce."
        : "Every original channel is excluded, so nothing is left to reconstruct. Exclusions are " +
          "only for behavior the feature contract cannot express; a channel that reads or writes data can " +
          "always be specified. Rebuild the fixtures (oracle_find_fixture repairs missing files and fields) " +
          "and declare the channels you abandoned.";
      continue;
    }
    const { excluded, required, built } = accepted;
    const channelNames = required.map(item => item.channel);
    const observed = [];
    const observationProblems = [];
    for (const cases of [built.publicCases, built.repairCases, built.finalCases]) {
      const result = await observe({ cases, appDir, timeout: caseTimeout });
      observed.push(...result.usable);
      observationProblems.push(...result.failures);
    }
    /* Excluded channels are not part of the candidate, so they must not appear in the expected
       channel inventory either. */
    for (const item of observed)
      item.result.channels = item.result.channels.filter(entry => !excluded.has(entry.channel));
    const gaps = coverageGaps(observed, channelNames);
    const narrow = narrowChannels(observed, channelNames);
    log(`spec round ${round}: ${observed.length} case(s) observable against the original, ` +
      `${gaps.length} gap(s), ${narrow.length} narrow channel(s)`);
    if (!observed.length) {
      feedback = "No generated case could observe the original app. Check fixtures and arguments; " +
        "every channel must succeed at least once before the specification is usable.";
      continue;
    }
    if (gaps.length) {
      feedback = `Coverage gaps (a channel needs a reachable fixture and one successful ` +
        `observation):\n${gaps.join("\n")}`;
      continue;
    }
    if (narrow.length) log(`narrow coverage: ${narrow.length} channel(s) with a single outcome`);
    const partitioned = partitionCases({ items: observed, channels: channelNames });
    /* A partition is only expected to hold a channel's case when that channel has enough cases to
       go round; the partitioner reports which, so a constant channel with two cases is not
       reported as a gap for a partition it cannot fill. */
    const suiteFor = (items, expected) => ({
      coverage: coverage(items),
      expected,
      gaps: coverageGaps(items, expected),
      narrow: narrowChannels(items, channelNames),
      cases: items.map(item => ({ case: item.case, result: item.result })),
    });
    suites = { public: suiteFor(partitioned.publicItems, partitioned.expected.public),
      repair: suiteFor(partitioned.repairItems, partitioned.expected.repair),
      final: suiteFor(partitioned.finalItems, partitioned.expected.final) };
    spec = declared;
    contract = accepted.contract;
    hostDependent = accepted.hostDependent;
    log(`${required.length} required channel(s), ${excluded.size} exclusion(s)`);
    observations = { total: built.all.length, usable: observed.length,
      failures: observationProblems };
    break;
  }
  if (!spec && suppliedSpec) {
    const accepted = await acceptSpecification({ spec: withScope(suppliedSpec, scopeExclusions),
      inventory: requiredInventory, appDir, timeout: caseTimeout, log });
    const { excluded, required, built } = accepted;
    if (!required.length) throw new Error("The supplied specification excludes every channel");
    const channelNames = required.map(item => item.channel);
    const observed = [];
    const observationProblems = [];
    for (const cases of [built.publicCases, built.repairCases, built.finalCases]) {
      const result = await observe({ cases, appDir, timeout: caseTimeout });
      observed.push(...result.usable);
      observationProblems.push(...result.failures);
    }
    const gaps = coverageGaps(observed, channelNames);
    if (gaps.length) throw new Error(`The supplied specification cannot observe the app:\n${gaps.join("\n")}`);
    narrowChannels(observed, channelNames).forEach(item => log(`narrow coverage: ${item}`));
    for (const item of observed)
      item.result.channels = item.result.channels.filter(entry => !excluded.has(entry.channel));
    const partitioned = partitionCases({ items: observed, channels: channelNames });
    const suiteFor = (items, expected) => ({ coverage: coverage(items),
      gaps: coverageGaps(items, expected), narrow: narrowChannels(items, channelNames),
      cases: items.map(item => ({ case: item.case, result: item.result })) });
    suites = { public: suiteFor(partitioned.publicItems, partitioned.expected.public),
      repair: suiteFor(partitioned.repairItems, partitioned.expected.repair),
      final: suiteFor(partitioned.finalItems, partitioned.expected.final) };
    spec = suppliedSpec;
    contract = accepted.contract;
    hostDependent = accepted.hostDependent;
    observations = { total: built.all.length, usable: observed.length, failures: observationProblems };
  }
  if (!spec) throw new Error(`No usable specification was produced after ${specRounds} round(s).\n${feedback}`);

  /* ---------------------------------------------------------------- stage 2: implementation */
  await writeHandoff({ spec: contract, analysis, publicSuite: suites.public, directory: handoff });
  let repairVisible = false;
  let publicCheck = null, repairCheck = null;
  feedback = "";
  for (let round = 1; round <= implRounds; round++) {
    if (repairVisible) await writeHandoff({ spec: contract, analysis, publicSuite: suites.public,
      directory: handoff, repairSuite: suites.repair });
    const run = await agentRunner({ stage: "implement", workspace: handoff, stateDir, appDir,
      archiveName: analysis.archive.name ?? "", analysisFile, publicFile: handoffPublicFile,
      candidateDir: candidate, model: implModelOption, timeout: implTimeout, round, feedback, log });
    run.round = round;
    runs.push(run);
    log(describeRun(run));
    let assembled;
    try {
      assembled = await assembleProject({ analysis, contract, workspace: handoff, output: candidate });
    } catch (error) {
      feedback = `The candidate could not be assembled: ${error.message}\nFix the feature modules and run check again.`;
      continue;
    }
    publicCheck = await checkSuite({ suite: suites.public, candidate: assembled.output, timeout: caseTimeout });
    repairCheck = await checkSuite({ suite: suites.repair, candidate: assembled.output, timeout: caseTimeout });
    log(`impl round ${round}: public ${publicCheck.passed}/${publicCheck.total}` +
      `${repairCheck ? `, repair ${repairCheck.passed}/${repairCheck.total}` : ""}`);
    const publicFailed = publicCheck.failures.length > 0;
    const repairFailed = Boolean(repairCheck?.failures.length);
    if (!publicFailed && !repairFailed) break;
    if (!repairVisible) {
      repairVisible = true;
      await writeHandoff({ spec: contract, analysis, publicSuite: suites.public, directory: handoff,
        repairSuite: suites.repair });
    }
    const report = failureReport({ public: publicCheck, repair: repairVisible ? repairCheck : null });
    await fsp.writeFile(path.join(handoff, "failures.md"), report);
    const counts = `public ${publicCheck.passed}/${publicCheck.total}` +
      (repairCheck ? `, repair ${repairCheck.passed}/${repairCheck.total}` : "");
    feedback = (publicFailed
      ? `Public cases that do not match yet (${counts}); the first few are below, every failing ` +
        `case is in failures.md:\n${failureText(publicCheck.failures)}\n`
      : `Public cases pass (${counts}). Repair cases, now visible in repair-cases.json, do not; ` +
        `every failing case is in failures.md:\n${failureText(repairCheck?.failures ?? [])}\n`) +
      `\nRead failures.md for the calls and the original-versus-candidate difference of the first ` +
      `failing cases, and implement_public_case for any case by name.`;
  }

  /* ------------------------------------------------------------------ stage 3: final evaluation */
  const finalCheck = await checkSuite({ suite: suites.final, candidate, timeout: caseTimeout });
  const finalReport = {
    schema_version: 2,
    archive: { path: path.relative(process.cwd(), archivePath), ...analysis.archive },
    method: "two-stage: specification from black-box IPC observation, implementation from the public " +
      "handoff alone, differential verification against the original",
    models: { spec: runs.find(run => run.stage === "spec")?.model ?? null,
      implementer: runs.find(run => run.stage === "implement")?.model ?? null },
    scope: patterns.length ? { label: scopeLabel, patterns,
      channels: requiredInventory.map(entry => entry.channel),
      out_of_scope: outOfScope.map(entry => entry.channel) } : null,
    spec: { sha256: specHash(spec), channels: Object.keys(spec.channels ?? {}),
      channel_exclusions: contract.channel_exclusions ?? [],
      host_dependent_exclusions: hostDependent,
      scope: spec.application?.scope ?? [], exclusions: spec.application?.exclusions ?? [],
      blockers: spec.application?.blockers ?? [], unresolved: spec.application?.unresolved ?? [] },
    partitions: {
      public: partitionReport(suites.public, publicCheck),
      repair: partitionReport(suites.repair, repairCheck),
      final: partitionReport(suites.final, finalCheck),
    },
    observations,
    rounds: runs.map(run => ({ stage: run.stage, round: run.round, model: run.model,
      tool_calls: run.toolCalls.length, tokens: run.tokens, exit_code: run.exitCode,
      timed_out: run.timedOut, errors: run.errors })),
    limitations: [
      "Case values are samples, not an equivalence proof for arbitrary input.",
      "Log files (*.log under a storage root) are read and written by the case but not compared:" +
        " their lines carry the harness wall clock, so their bytes are not reproducible behavior.",
      "Only main-process IPC behavior, its persisted files and error results are compared; renderer " +
        "layout, menus, tray, updater and other platform effects are outside the verified scope.",
      "The specification agent decides what to observe; behavior it never reached is absent from the " +
        "specification and therefore from this verdict.",
    ],
  };
  const blockers = [];
  for (const [name, check] of [["public", publicCheck], ["repair", repairCheck], ["final", finalCheck]]) {
    if (!check) { blockers.push(`${name} partition was never evaluated`); continue; }
    if (check.failures.length)
      blockers.push(`${name} partition: ${check.failures.length} of ${check.total} case(s) differ`);
    if (check.gaps.length) blockers.push(`${name} partition: ${check.gaps.join("; ")}`);
  }
  if (observations.failures.length) {
    const reasons = [...new Set(observations.failures.map(item => item.reason))];
    blockers.push(`${observations.failures.length} original observation(s) produced no usable expectation: ` +
      reasons.slice(0, 4).join("; "));
  }
  for (const item of spec.application?.blockers ?? []) blockers.push(`specification blocker: ${item}`);
  for (const item of spec.application?.unresolved ?? []) blockers.push(`unresolved question: ${item}`);
  /* The contract already carries the specification's exclusions, the host-dependent ones the
     driver detected and this run's subsystem exclusions; they are reported together, labelled. */
  const excludedList = (contract.channel_exclusions ?? []).filter(item => item?.source !== "run-scope");
  finalReport.readiness = {
    ready: blockers.length === 0,
    whole_app_ready: blockers.length === 0 && !patterns.length && excludedList.length === 0,
    blockers,
    scoped: patterns.length
      ? { label: scopeLabel, channels: requiredInventory.length, application_channels: inventory.length,
        out_of_scope: outOfScope.length }
      : null,
    excluded: [...excludedList, ...scopeExclusions].map(item => ({ channel: item.channel,
      reason: item.reason, source: item.source ?? "specification" })),
    note: patterns.length
      ? `This run reconstructs one subsystem (${scopeLabel}): ${requiredInventory.length} of ` +
        `${inventory.length} IPC channels. The other ${outOfScope.length} were neither specified nor ` +
        "verified, so parity here says nothing about them, and whole-app readiness stays false." +
        (excludedList.length ? " Within the subsystem, exclusions also remain (see excluded)." : "")
      : excludedList.length
        ? "Exclusions keep this run from claiming whole-app readiness. They were declared by the " +
          "specification stage, or detected mechanically as host-dependent, and have not been " +
          "independently reviewed."
        : "All discovered IPC channels are in the verified scope.",
  };

  await assembleProject({ analysis, contract, workspace: handoff, output: outputPath });
  await fsp.mkdir(path.join(outputPath, "handoff"), { recursive: true });
  await fsp.writeFile(path.join(outputPath, "handoff", "spec.json"), JSON.stringify(contract, null, 2) + "\n");
  await fsp.writeFile(path.join(outputPath, "handoff", "SPEC.md"),
    renderSpecMarkdown({ spec: contract, analysis, publicSuite: suites.public }) + "\n");
  await fsp.writeFile(path.join(outputPath, "handoff", "public-cases.json"),
    JSON.stringify(suites.public) + "\n");
  await fsp.writeFile(path.join(outputPath, "reconstruction-report.json"),
    JSON.stringify(finalReport, null, 2) + "\n");
  if (!options["keep-workspace"] && !options.state) await fsp.rm(stateDir, { recursive: true, force: true });
  log(`wrote ${outputPath} (ready: ${finalReport.readiness.ready})`);
  if (!finalReport.readiness.ready)
    throw new Error(`Reconstruction did not reach parity after ${runs.length} agent round(s).\n` +
      `public ${publicCheck?.passed ?? 0}/${publicCheck?.total ?? 0}, ` +
      `repair ${repairCheck ? `${repairCheck.passed}/${repairCheck.total}` : "not evaluated"}, ` +
      `final ${finalCheck?.passed ?? 0}/${finalCheck?.total ?? 0}\n${blockers.join("\n")}`);
  return { output: outputPath, report: finalReport, stateDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { archive, output, options } = parseArguments(process.argv.slice(2));
  if (!archive || !output) {
    console.error("Usage: node scripts/electron/pipeline.mjs <app.asar> <new-output-directory> " +
      "[--spec-rounds 2] [--impl-rounds 2] [--spec-timeout 1200] [--impl-timeout 1200] " +
      "[--spec-model role] [--impl-model role] [--spec <spec.json>] [--case-timeout 20000] " +
      "[--only channel[,channel|*]] [--scope-label text] [--keep-workspace] [--state dir]");
    process.exitCode = 2;
  } else {
    reconstruct({ archive, output, options }).then(result => {
      console.log(JSON.stringify({ output: result.output, ready: result.report.readiness.ready,
        partitions: Object.fromEntries(Object.entries(result.report.partitions).map(([name, value]) =>
          [name, { cases: value.cases, passed: value.passed }])),
        rounds: result.report.rounds.length, state: result.stateDir }, null, 2));
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
