/**
 * Mechanical differential cases for a reconstructed Electron app.
 *
 * The orchestration agent declares which channels it implements, the fixtures that make each one
 * reachable, and sample arguments. This module mutates those declarations into a larger case set
 * and splits it deterministically into public cases (the agent may see them) and held-out cases
 * (only the driver sees them). Expectations always come from the original archive, never from the
 * candidate, so a reconstruction cannot define its own correctness.
 */
import crypto from "node:crypto";
import { validateCase } from "./oracle.mjs";

export const CONTRACT_VERSION = 2;
const SUPPORTED_VERSIONS = new Set([1, 2]);

const STRINGS = ["", "missing", "study", "Alpha", "Beta", "al", "zz", "2026-10-25", "2026-10-20", "x"];
const NUMBERS = [-1, 0, 1, 2, 3, 4, 5, 6, 9, 0.5];
const BOOLEANS = [true, false];
const ARRAYS = [[], ["2026-10-25"], ["2026-10-20", "2026-10-25"], ["2026-10-25", "2026-10-25"]];

export function hash(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function poolFor(value) {
  if (typeof value === "number") return NUMBERS;
  if (typeof value === "boolean") return BOOLEANS;
  if (Array.isArray(value)) return [...ARRAYS, value];
  if (value && typeof value === "object") return [{}, value];
  return [...STRINGS, String(value ?? "")];
}

function unique(values) {
  const seen = new Set(), out = [];
  for (const value of values) {
    const key = JSON.stringify(value) ?? "undefined";
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** JSON-preserving mutations of one fixture's content. */
export function mutateContent(content) {
  if (Array.isArray(content)) {
    return [content.slice(0, -1), [...content].reverse(), [...content, ...content], content.map(item => mutateScalar(item))];
  }
  if (content && typeof content === "object") {
    const out = [{}];
    const keys = Object.keys(content).slice(0, 6);
    for (const key of keys) {
      const clone = { ...content };
      delete clone[key];
      out.push(clone);
    }
    for (const [key, value] of Object.entries(content).slice(0, 5)) {
      if (Array.isArray(value)) {
        out.push({ ...content, [key]: [] }, { ...content, [key]: [...value].reverse() },
          { ...content, [key]: [...value, ...value] });
        for (const item of value.slice(0, 2)) out.push({ ...content, [key]: [...value, item] });
      } else if (value && typeof value === "object") {
        out.push({ ...content, [key]: {} }, { ...content, [key]: { ...value, extra: true } });
      } else out.push({ ...content, [key]: mutateScalar(value) });
    }
    return out;
  }
  if (typeof content === "string") {
    return ["", content + "\n", content.split("\n").slice(0, -1).join("\n"),
      content.replace(/\[\[([^\]]+)\]\]/g, "[[Missing-$1]]")];
  }
  return [];
}

function mutateScalar(value) {
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  if (typeof value === "string") return value ? `${value}-changed` : "x";
  if (Array.isArray(value)) return value.slice(0, 1);
  if (value && typeof value === "object") return {};
  return value;
}

function mutateFixtures(fixtures) {
  const out = [];
  for (let index = 0; index < fixtures.length; index++) {
    for (const content of mutateContent(fixtures[index].content)) {
      const copy = fixtures.map(fixture => ({ ...fixture }));
      copy[index].content = content;
      out.push(copy);
    }
  }
  return out;
}

function sampleArguments(sample, arity) {
  if (Array.isArray(sample) && sample.length) return [sample];
  const defaults = Array.from({ length: arity }, (_, index) => {
    const value = sample?.[index];
    if (typeof value === "number") return 1;
    if (typeof value === "boolean") return true;
    if (Array.isArray(value)) return [];
    if (value && typeof value === "object") return {};
    return index === 0 ? "study" : "";
  });
  return [defaults];
}

export function validateContract(contract, originalChannels) {
  const problems = [];
  if (!contract || typeof contract !== "object") return ["Contract must be a JSON object"];
  if (!SUPPORTED_VERSIONS.has(contract.schema_version))
    problems.push(`schema_version must be one of ${[...SUPPORTED_VERSIONS].join(", ")}`);
  if (!contract.channels || typeof contract.channels !== "object") return [...problems, "Contract needs a channels object"];
  const names = new Set(originalChannels.map(item => item.channel));
  if (contract.application !== undefined) {
    if (!contract.application || typeof contract.application !== "object") problems.push("application must be an object");
    for (const key of ["scope", "exclusions", "blockers", "unresolved"])
      if (contract.application?.[key] !== undefined && !Array.isArray(contract.application[key]))
        problems.push(`application.${key} must be an array`);
  }
  for (const [channel, entry] of Object.entries(contract.channels)) {
    if (!names.has(channel)) problems.push(`Unknown original channel: ${channel}`);
    if (!entry || typeof entry !== "object") { problems.push(`${channel}: entry must be an object`); continue; }
    if (typeof entry.feature !== "string" || !/\.(cjs|js)$/.test(entry.feature))
      problems.push(`${channel}: feature must name a workspace .cjs or .js module`);
    if (entry.fixtures !== undefined && !Array.isArray(entry.fixtures)) problems.push(`${channel}: fixtures must be an array`);
    if (entry.args !== undefined && !Array.isArray(entry.args)) problems.push(`${channel}: args must be an array of argument arrays`);
    for (const sample of entry.args ?? []) {
      if (!Array.isArray(sample)) problems.push(`${channel}: each args entry must be an array`);
    }
    if (entry.requirements !== undefined) {
      if (!Array.isArray(entry.requirements) || !entry.requirements.length)
        problems.push(`${channel}: requirements must be a nonempty array of behavior statements`);
      for (const requirement of entry.requirements ?? [])
        if (typeof requirement !== "string" || !requirement.trim())
          problems.push(`${channel}: every requirement must be a nonempty string`);
    }
    for (const sequence of entry.sequences ?? []) {
      if (!Array.isArray(sequence?.calls) || !sequence.calls.length) {
        problems.push(`${channel}: every sequence needs a nonempty calls array`);
        continue;
      }
      for (const call of sequence.calls) {
        if (typeof call?.channel !== "string" || !names.has(call.channel))
          problems.push(`${channel}: sequence calls unknown channel ${call?.channel}`);
        if (call?.args !== undefined && !Array.isArray(call.args))
          problems.push(`${channel}: sequence call args must be an array`);
      }
      try {
        validateCase({ fixtures: sequence.fixtures ?? [], calls: sequence.calls });
      } catch (error) { problems.push(`${channel}: sequence ${error.message}`); }
    }
    try {
      validateCase({ fixtures: entry.fixtures ?? [], calls: [{ channel, args: [] }] });
    } catch (error) { problems.push(`${channel}: ${error.message}`); }
  }
  const missing = [...names].filter(name => !(name in contract.channels));
  if (missing.length) problems.push(`Contract does not declare original channel(s): ${missing.join(", ")}`);
  return problems;
}

/** Candidate cases before any original behavior is observed. */
export function buildCases({ contract, channels, seed = "splice" }) {
  const cases = [];
  const defaultFixedTime = "2026-10-25T12:00:00.000Z";
  for (const { channel, arity } of [...channels].sort((a, b) => a.channel.localeCompare(b.channel))) {
    const entry = contract.channels?.[channel] ?? {};
    const fixedTime = entry.fixed_time ?? defaultFixedTime;
    if (!Number.isFinite(Date.parse(fixedTime))) throw new Error(`${channel}: fixed_time must be an ISO date`);
    const baseFixtures = entry.fixtures ?? [];
    const fixtureVariants = [baseFixtures, ...mutateFixtures(baseFixtures)];
    const shapes = fixtureVariants.map((_, index) => index === 0 ? "base" : "fixture-mutation");
    for (const sample of sampleArguments(entry.args?.[0], arity)) {
      const variants = [sample];
      for (let index = 0; index < sample.length; index++)
        for (const value of poolFor(sample[index])) {
          const copy = [...sample];
          copy[index] = value;
          variants.push(copy);
        }
      let count = 0;
      const perChannel = Number(process.env.ELECTRON_CASES_PER_CHANNEL ?? 16);
      for (const args of unique(variants)) {
        for (let fixtureIndex = 0; fixtureIndex < fixtureVariants.length; fixtureIndex++) {
          if (count++ >= perChannel) break;
          const fixtures = fixtureVariants[fixtureIndex];
          const testCase = { channel, fixtures, fixed_time: fixedTime, calls: [{ channel, args }] };
          const key = hash({ channel, fixtures: fixtures.map(({ base, path, content }) => ({ base, path, content })), args });
          cases.push({
            name: `${channel.replace(/[^a-z0-9]+/gi, "-")}-${key.slice(0, 10)}`,
            shape: shapes[fixtureIndex],
            ...testCase,
          });
        }
      }
    }
    for (const extra of (entry.args ?? []).slice(1)) {
      const fixtures = baseFixtures;
      const key = hash({ channel, fixtures, args: extra });
      cases.push({ name: `${channel.replace(/[^a-z0-9]+/gi, "-")}-${key.slice(0, 10)}`, channel,
        shape: "args", fixtures, fixed_time: fixedTime, calls: [{ channel, args: extra }] });
    }
    if (baseFixtures.length) {
      const key = hash({ channel, cold: true });
      cases.push({ name: `${channel.replace(/[^a-z0-9]+/gi, "-")}-cold-${key.slice(0, 8)}`, channel,
        shape: "cold", fixtures: [], fixed_time: fixedTime,
        calls: [{ channel, args: sampleArguments(entry.args?.[0], arity)[0] }] });
    }
    /* A second identical call sees what the first call persisted. Without this, a stateless
       implementation can pass every single-call case. */
    const repeatArgs = sampleArguments(entry.args?.[0], arity)[0];
    const repeatKey = hash({ channel, repeat: true, args: repeatArgs });
    cases.push({ name: `${channel.replace(/[^a-z0-9]+/gi, "-")}-repeat-${repeatKey.slice(0, 8)}`,
      channel, shape: "repeat", fixtures: baseFixtures, fixed_time: fixedTime,
      calls: [{ channel, args: repeatArgs }, { channel, args: repeatArgs }] });
    for (const [index, sequence] of (entry.sequences ?? []).entries()) {
      const sequenceKey = hash({ channel, sequence: index, calls: sequence.calls });
      cases.push({ name: `${channel.replace(/[^a-z0-9]+/gi, "-")}-sequence-${sequenceKey.slice(0, 8)}`,
        channel, shape: "sequence", fixtures: sequence.fixtures ?? baseFixtures,
        fixed_time: sequence.fixed_time ?? fixedTime,
        description: sequence.description ?? null, calls: sequence.calls });
    }
  }
  const seen = new Set(), uniqueCases = [];
  for (const testCase of cases) {
    const key = hash({ fixtures: testCase.fixtures, calls: testCase.calls });
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueCases.push(testCase);
  }
  const publicCases = [], repairCases = [], finalCases = [];
  for (const testCase of uniqueCases) {
    const bucket = parseInt(hash({ seed, name: testCase.name, fixtures: testCase.fixtures, calls: testCase.calls }).slice(0, 4), 16) % 100;
    if (bucket < 55) publicCases.push(testCase);
    else if (bucket < 75) repairCases.push(testCase);
    else finalCases.push(testCase);
  }
  for (const channel of new Set(uniqueCases.map(item => item.channel))) {
    for (const [pool, minimum] of [[repairCases, 1], [finalCases, 3]]) {
      const count = pool.filter(item => item.channel === channel).length;
      if (count >= minimum) continue;
      for (const testCase of publicCases.filter(item => item.channel === channel).slice(0, minimum - count)) {
        publicCases.splice(publicCases.indexOf(testCase), 1);
        pool.push(testCase);
      }
    }
  }
  return { publicCases, repairCases, finalCases, heldOut: finalCases, all: uniqueCases };
}

function normalizeOutcome(outcome) {
  if (outcome.ok) return { ok: true, value: outcome.value };
  return { ok: false, error: { name: outcome.error?.name ?? "Error", code: outcome.error?.code ?? null } };
}

export function behaviorFiles(result) {
  const files = {};
  for (const [key, value] of Object.entries(result.files ?? {}))
    if (key.startsWith("userData/") || key.startsWith("documents/")) files[key] = value;
  return files;
}

/** Differences that make a candidate fail one case. */
export function compareCase(expected, actual) {
  const problems = [];
  const expectedChannels = expected.channels.map(item => item.channel);
  const actualChannels = new Set(actual.channels.map(item => item.channel));
  for (const channel of expectedChannels)
    if (!actualChannels.has(channel)) problems.push(`candidate does not register original channel ${channel}`);
  if (expected.outcomes.length !== actual.outcomes.length)
    problems.push(`expected ${expected.outcomes.length} outcome(s), got ${actual.outcomes.length}`);
  expected.outcomes.forEach((outcome, index) => {
    const want = normalizeOutcome(outcome);
    const got = actual.outcomes[index] ? normalizeOutcome(actual.outcomes[index]) : null;
    if (!got) return;
    if (JSON.stringify(want) !== JSON.stringify(got))
      problems.push(`call ${index + 1} differs:\n  original: ${JSON.stringify(want)}\n  candidate: ${JSON.stringify(got)}`);
  });
  const wantFiles = behaviorFiles(expected), gotFiles = behaviorFiles(actual);
  for (const key of new Set([...Object.keys(wantFiles), ...Object.keys(gotFiles)])) {
    if (JSON.stringify(wantFiles[key]) !== JSON.stringify(gotFiles[key]))
      problems.push(`file ${key} differs:\n  original: ${JSON.stringify(wantFiles[key])}\n  candidate: ${JSON.stringify(gotFiles[key])}`);
  }
  /* Per-call effects catch writes or deletions that a later call undoes or overwrites. */
  (expected.effects ?? []).forEach((effect, index) => {
    const got = actual.effects?.[index];
    if (!got) return;
    if (JSON.stringify(effect.changed) !== JSON.stringify(got.changed))
      problems.push(`call ${index + 1} writes differ:\n  original: ${JSON.stringify(effect.changed)}\n  candidate: ${JSON.stringify(got.changed)}`);
    if (JSON.stringify(effect.removed) !== JSON.stringify(got.removed))
      problems.push(`call ${index + 1} deletions differ:\n  original: ${JSON.stringify(effect.removed)}\n  candidate: ${JSON.stringify(got.removed)}`);
  });
  return problems;
}

/** Run cases with bounded parallelism; one case cannot poison another. */
export async function runSuite({ runCase, appDir, cases, concurrency = 6, timeout = 20000 }) {
  const results = new Array(cases.length);
  let cursor = 0;
  async function worker() {
    while (cursor < cases.length) {
      const index = cursor++;
      try {
        results[index] = { case: cases[index], result: await runCase({ appDir, case: cases[index], timeout }) };
      } catch (error) {
        results[index] = { case: cases[index], error: { name: error.name ?? "Error", message: error.message } };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  return results;
}

/** Drop cases that cannot say anything about behavior. */
export function usableResults(results) {
  return results.filter(item => {
    if (item.error) return false;
    return item.result.outcomes.every(outcome => outcome.error?.name !== "MissingHandler");
  });
}

/**
 * Every original observation that produced no usable expectation. These stay visible as readiness
 * blockers: a crashed worker, an unregistered channel or a timeout must never look like coverage.
 */
export function observationFailures(results) {
  const failures = [];
  for (const item of results) {
    if (item.error) {
      failures.push({ case: item.case.name, channel: item.case.channel, reason: `worker failed: ${item.error.message}` });
      continue;
    }
    const missing = item.result.outcomes.filter(outcome => outcome.error?.name === "MissingHandler");
    if (missing.length)
      failures.push({ case: item.case.name, channel: item.case.channel,
        reason: "original app did not register the channel during this case" });
    if (item.result.startup_error)
      failures.push({ case: item.case.name, channel: item.case.channel,
        reason: `original startup rejected: ${item.result.startup_error.message}` });
  }
  return failures;
}

export function coverage(results) {
  const summary = {};
  for (const item of results) {
    const channel = item.case.channel;
    summary[channel] ??= { cases: 0, value: 0, error: 0, distinct: new Set() };
    summary[channel].cases++;
    for (const outcome of item.result.outcomes) {
      if (outcome.ok) summary[channel].value++;
      else summary[channel].error++;
      summary[channel].distinct.add(JSON.stringify(outcome.ok ? outcome.value : { name: outcome.error?.name, code: outcome.error?.code }));
    }
  }
  return Object.fromEntries(Object.entries(summary).map(([channel, entry]) => [channel,
    { ...entry, distinct: entry.distinct.size }]));
}

export function coverageGaps(results, expectedChannels = [], { minDistinct = 1, requireSuccess = true,
  minCasesForConstant = 6 } = {}) {
  const gaps = [];
  const summary = coverage(results);
  /* A gap message is the specification agent's only lever, so it names what was observed: the
     failing call it would otherwise have to guess at, and the distance to the threshold. */
  const firstFailure = new Map();
  for (const item of results) {
    for (const outcome of item.result?.outcomes ?? []) {
      if (outcome.ok || firstFailure.has(item.case.channel)) continue;
      firstFailure.set(item.case.channel,
        `${outcome.error?.name ?? "Error"}: ${String(outcome.error?.message ?? "").slice(0, 160)}`);
    }
  }
  for (const channel of expectedChannels)
    if (!summary[channel]) gaps.push(`${channel}: no usable case in this split`);
  for (const [channel, entry] of Object.entries(summary)) {
    if (!entry.distinct) gaps.push(`${channel}: no observable outcomes`);
    if (requireSuccess && !entry.value)
      gaps.push(`${channel}: none of its ${entry.cases} case(s) succeeded against the original` +
        (firstFailure.has(channel) ? ` — first failure ${firstFailure.get(channel)}` : "") +
        "; declare arguments and fixtures that reach it");
    /* Constant-result operations (version strings, locale direction) cannot produce three
       outcomes. They still need breadth, so observable cases count when the result is stable. */
    if (entry.distinct < minDistinct && entry.cases < minCasesForConstant)
      gaps.push(`${channel}: ${entry.distinct} distinct outcome(s) from ${entry.cases} case(s); ` +
        `a stable result needs ${minCasesForConstant} observable cases, changing results need ` +
        `${minDistinct} distinct outcomes — add argument samples (and fixtures) that reach it`);
  }
  return gaps;
}

function successful(item) {
  return (item.result?.outcomes ?? []).every(outcome => outcome.ok);
}

/**
 * Split observed cases into public, repair and final partitions, keeping coverage intact.
 *
 * A plain hash split can put every successful case for a channel in one partition, which would let
 * an error-only candidate pass the partition it is graded on and would hide the behavior from the
 * implementer. So after the hash assignment each channel is rebalanced: the final partition keeps
 * at least three cases, repair one, public one, and public and final each get a successful case
 * whenever the channel has one.
 */
export function partitionCases({ items, seed = "public", channels = [] }) {
  const names = [...new Set([...channels, ...items.map(item => item.case.channel)])];
  const publicCases = [], repairCases = [], finalCases = [];
  const publicItems = [], repairItems = [], finalItems = [];
  for (const channel of names) {
    const channelItems = items.filter(item => item.case.channel === channel)
      .sort((a, b) => a.case.name.localeCompare(b.case.name));
    const pools = { public: [], repair: [], final: [] };
    for (const item of channelItems) {
      const bucket = parseInt(hash({ seed, name: item.case.name, fixtures: item.case.fixtures,
        calls: item.case.calls }).slice(0, 4), 16) % 100;
      if (bucket < 55) pools.public.push(item);
      else if (bucket < 75) pools.repair.push(item);
      else pools.final.push(item);
    }
    const move = (from, to, predicate = () => true) => {
      const index = pools[from].findIndex(predicate);
      if (index < 0) return false;
      pools[to].push(...pools[from].splice(index, 1));
      return true;
    };
    const swap = (target, donor) => {
      const targetIndex = pools[target].findIndex(item => !successful(item));
      const donorIndex = pools[donor].findIndex(successful);
      if (targetIndex < 0 || donorIndex < 0) return false;
      const temporary = pools[target][targetIndex];
      pools[target][targetIndex] = pools[donor][donorIndex];
      pools[donor][donorIndex] = temporary;
      return true;
    };
    while (pools.final.length < 3 && pools.public.length > 1) move("public", "final");
    while (pools.repair.length < 1 && pools.public.length > 1) move("public", "repair");
    while (pools.public.length < 1) {
      if (!move("repair", "public") && !move("final", "public")) break;
    }
    /* Shape stratification: a shape family that only appears in the held-out partition is an
       unseen rule, not a generalization test. Put one case of every observed shape in public. */
    for (const shape of new Set(channelItems.map(item => item.case.shape ?? "args"))) {
      if (pools.public.some(item => (item.case.shape ?? "args") === shape)) continue;
      for (const donor of ["repair", "final"])
        if (move(donor, "public", item => (item.case.shape ?? "args") === shape)) break;
    }
    for (const target of ["public", "final"]) {
      if (!pools[target].length || pools[target].some(successful)) continue;
      for (const donor of ["public", "repair", "final"].filter(name => name !== target))
        if (swap(target, donor)) break;
    }
    for (const item of pools.public) { publicCases.push(item.case); publicItems.push(item); }
    for (const item of pools.repair) { repairCases.push(item.case); repairItems.push(item); }
    for (const item of pools.final) { finalCases.push(item.case); finalItems.push(item); }
  }
  return { publicCases, repairCases, finalCases, publicItems, repairItems, finalItems,
    all: [...publicCases, ...repairCases, ...finalCases] };
}
