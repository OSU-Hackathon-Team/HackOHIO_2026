/**
 * The public specification handed to an implementation agent.
 *
 * The specification is the only thing an implementer sees about the original application: the
 * observation agent writes it from oracle probes, and the driver exports it with the public
 * differential cases. Nothing here renders or copies original source. Kept deliberately free of
 * candidate paths, expected-only partitions and private evidence locations.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { validateContract, hash } from "./cases.mjs";

export const SPEC_VERSION = 2;

/**
 * Channels the specification deliberately leaves out because the feature-module contract cannot
 * express them (window-bound results, dialogs, trays, notifications, network). They are reported
 * as declared exclusions, never silently dropped, and they keep a run from claiming whole-app
 * readiness.
 */
export function excludedChannels(spec) {
  const excluded = new Map();
  for (const item of spec?.channel_exclusions ?? []) {
    if (item && typeof item === "object" && typeof item.channel === "string")
      excluded.set(item.channel, item);
  }
  return excluded;
}

/** Validate a specification against the archive's original channels. */
export function validateSpec(spec, originalChannels) {
  const problems = [];
  const excluded = new Map();
  if (spec?.channel_exclusions !== undefined) {
    if (!Array.isArray(spec.channel_exclusions)) problems.push("channel_exclusions must be an array");
    else for (const item of spec.channel_exclusions) {
      if (!item || typeof item !== "object" || typeof item.channel !== "string" || !item.channel.trim())
        problems.push("every channel exclusion needs a channel");
      else if (excluded.has(item.channel)) problems.push(`${item.channel}: excluded more than once`);
      else if (!originalChannels.some(entry => entry.channel === item.channel))
        problems.push(`${item.channel}: exclusion names a channel the archive does not register`);
      else if (typeof item.reason !== "string" || !item.reason.trim())
        problems.push(`${item.channel}: an exclusion needs a reason`);
      else excluded.set(item.channel, item);
    }
  }
  for (const channel of Object.keys(spec?.channels ?? {}))
    if (excluded.has(channel)) problems.push(`${channel}: is declared and excluded at the same time`);
  const required = originalChannels.filter(entry => !excluded.has(entry.channel));
  problems.push(...validateContract(spec, required));
  if (spec?.schema_version === SPEC_VERSION) {
    if (!spec.application || typeof spec.application !== "object")
      problems.push("application is required: name, version, scope and exclusions");
    else {
      if (typeof spec.application.name !== "string" || !spec.application.name.trim())
        problems.push("application.name is required");
      if (!Array.isArray(spec.application.scope) || !spec.application.scope.length)
        problems.push("application.scope must list what this specification covers");
    }
    for (const [channel, entry] of Object.entries(spec.channels ?? {}))
      if (!Array.isArray(entry.requirements) || !entry.requirements.length)
        problems.push(`${channel}: requirements must describe the observable behavior of the channel`);
  }
  return problems;
}

export function specHash(spec) {
  return hash(spec);
}

/** Compact view of one differential case; full fixtures are fetched by name. */
export function caseSummary(item) {
  const outcomes = item.result?.outcomes ?? [];
  return {
    name: item.case.name,
    channel: item.case.channel,
    calls: item.case.calls,
    fixtures: (item.case.fixtures ?? []).map(fixture => `${fixture.base}/${fixture.path}`),
    fixed_time: item.case.fixed_time ?? null,
    description: item.case.description ?? null,
    expected: outcomes.map(outcome => outcome.ok
      ? { ok: true, value: outcome.value }
      : { ok: false, error: { name: outcome.error?.name ?? null, code: outcome.error?.code ?? null } }),
  };
}

export function suiteSummary(suite) {
  return {
    cases: (suite.cases ?? []).map(caseSummary),
    coverage: suite.coverage ?? {},
    gaps: suite.gaps ?? [],
  };
}

function fixtureText(fixture) {
  const content = typeof fixture.content === "string" ? fixture.content : JSON.stringify(fixture.content, null, 2);
  const clipped = content.length > 1200 ? `${content.slice(0, 1200)}\n… (${content.length} characters)` : content;
  return `${fixture.base}/${fixture.path}\n\`\`\`\n${clipped}\n\`\`\``;
}

/** Human-readable specification for an implementer that may not read JSON comfortably. */
export function renderSpecMarkdown({ spec, analysis, publicSuite }) {
  const app = spec.application ?? {};
  const name = app.name || analysis.archive?.name || "Electron application";
  const version = app.version || analysis.archive?.version || "unknown";
  const lines = [];
  lines.push(`# ${name} ${version} — behavior specification`, "");
  lines.push(`Archive SHA-256: \`${analysis.archive?.sha256 ?? "unknown"}\``, "");
  lines.push("This document is a behavioral specification for an independent implementation. It was",
    "written by observing the packaged application through a mocked Electron host. Original source",
    "code is not included and is not available to you.", "");
  lines.push("## Scope", "");
  for (const item of app.scope ?? []) lines.push(`- ${item}`);
  lines.push("");
  if (app.exclusions?.length) {
    lines.push("## Exclusions (not required)", "");
    for (const item of app.exclusions) lines.push(`- ${item}`);
    lines.push("");
  }
  const clock = app.environments?.clock ?? "2026-10-25T12:00:00.000Z";
  lines.push("## Execution environment", "");
  lines.push(`- Storage roots available through \`ctx\`: \`userData\`, \`documents\`. Cases also isolate`,
    "  `logs` and `temp`; do not rely on their absolute paths.");
  lines.push(`- Cases freeze \`Date.now()\` and \`new Date()\` at \`${clock}\`.`);
  lines.push("- Only Node built-ins are available. Do not add dependencies.");
  lines.push("");
  lines.push("## Feature module contract", "");
  lines.push("Each IPC channel is implemented by a CommonJS module named in its section:", "");
  lines.push("```js");
  lines.push("module.exports = async function handle(args, ctx) {");
  lines.push("  // args: IPC arguments after the event, as an array");
  lines.push("  // ctx: { app, fs (node:fs/promises), path, userData, documents, channel }");
  lines.push("  return value;");
  lines.push("};");
  lines.push("```");
  lines.push("");
  lines.push("`ctx.channel` names the channel being invoked, so one module declared for several",
    "channels can tell them apart; each channel's behavior is still verified on its own cases.", "");
  lines.push("The module may also export `{ handle }`. Throw the error the original throws (same name",
    "and code). Return the same JSON value, including undefined results (`{\"$undefined\":true}` in",
    "observations means the handler returned nothing). Files must match in path and exact bytes —",
    "including indentation, key order and trailing newlines. Log files (`*.log`) are the one",
    "exception: their lines carry the harness's wall clock, so whether you write them is up to you",
    "and their contents are not compared.", "");
  lines.push("## Channels", "");
  for (const [channel, entry] of Object.entries(spec.channels ?? {})) {
    const summary = publicSuite?.coverage?.[channel];
    lines.push(`### \`${channel}\``, "");
    if (entry.title) lines.push(`**${entry.title}**`, "");
    if (entry.description) lines.push(entry.description, "");
    lines.push(`Feature module: \`${entry.feature}\``, "");
    if (entry.params?.length) {
      lines.push("Arguments:", "");
      for (const param of entry.params) lines.push(`- \`${param.name}\` (${param.type ?? "value"})`);
      lines.push("");
    }
    if (entry.requirements?.length) {
      lines.push("Behavior requirements:", "");
      for (const requirement of entry.requirements) lines.push(`- ${requirement}`);
      lines.push("");
    }
    if (entry.fixtures?.length) {
      lines.push("Reachable starting state (fixtures):", "");
      for (const fixture of entry.fixtures) lines.push(fixtureText(fixture), "");
    } else lines.push("Starting state: none; the channel reaches its own files.", "");
    if (entry.args?.length) {
      lines.push("Observed argument samples:", "");
      lines.push("```json", JSON.stringify(entry.args, null, 2), "```", "");
    }
    for (const sequence of entry.sequences ?? []) {
      lines.push("Stateful sequence:", "");
      if (sequence.description) lines.push(sequence.description, "");
      lines.push("```json", JSON.stringify({ fixtures: sequence.fixtures ?? [], calls: sequence.calls }, null, 2), "```", "");
    }
    if (summary) lines.push(`Public cases for this channel: ${summary.cases} (${summary.distinct} distinct outcomes, ${summary.value} successful).`, "");
  }
  if (spec.channel_exclusions?.length) {
    lines.push("## Excluded channels (do not implement)", "");
    for (const exclusion of spec.channel_exclusions)
      lines.push(`- \`${exclusion.channel}\` — ${exclusion.reason}`);
    lines.push("");
  }
  if (spec.application?.blockers?.length) {
    lines.push("## Blockers", "");
    for (const blocker of spec.application.blockers) lines.push(`- ${blocker}`);
    lines.push("");
  }
  lines.push("## Verification", "");
  lines.push(`The driver generated ${publicSuite?.cases?.length ?? 0} public differential cases from this`,
    "specification. Each case runs your implementation against the same fixtures, arguments and frozen",
    "clock that the original application saw, and compares handler values, error names/codes, every",
    "file written or deleted after each call, and the resulting file bytes. Further cases exist that",
    "you will not see; they test the same requirements with different inputs, so implement the rules",
    "rather than the examples.", "");
  lines.push("Use the `check` tool to assemble your workspace and run every public case. Use",
    "`public_case` for one case's fixtures and expected outcome when a failure is unclear.", "");
  return lines.join("\n");
}

/** Write the implementer-facing handoff directory. */
export async function writeHandoff({ spec, analysis, publicSuite, directory, repairSuite = null }) {
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(path.join(directory, "spec.json"), JSON.stringify(spec, null, 2) + "\n");
  await fsp.writeFile(path.join(directory, "public-cases.json"), JSON.stringify(publicSuite) + "\n");
  if (repairSuite) await fsp.writeFile(path.join(directory, "repair-cases.json"), JSON.stringify(repairSuite) + "\n");
  await fsp.writeFile(path.join(directory, "SPEC.md"), renderSpecMarkdown({ spec, analysis, publicSuite }) + "\n");
  await fsp.writeFile(path.join(directory, "README.md"),
    "# Reconstruction workspace\n\n" +
    `Implement every IPC channel of ${spec.application?.name ?? analysis.archive?.name ?? "the application"} ` +
    "from `SPEC.md`. Write the feature modules under `features/` exactly where the specification says. " +
    "`spec.json` carries the same contract in machine-readable form and `public-cases.json` holds the " +
    "public differential cases with the original application's observed outcomes.\n\n" +
    "Run the `check` tool to assemble the project and compare it with the public cases after every " +
    "change. Do not add dependencies; the pipeline only builds Node built-ins into the project.\n");
  return directory;
}
