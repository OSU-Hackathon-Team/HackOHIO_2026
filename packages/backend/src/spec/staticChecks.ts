// Owner: Eng 2 (Requirements) — spec: agents/2_requirements_extraction/05_oracle_coverage_and_repair.md §1-2
import { transform } from "esbuild";
import type { RawEvidence } from "@splice/contracts";
import type { SpecDraft } from "./prompt.js";
import { snippetPath } from "./formatEvidence.js";

export function testNames(testsCode: string): string[] {
  return [...testsCode.matchAll(/\btest\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
}

export function reqIdsIn(name: string): string[] {
  return [...name.matchAll(/\bREQ-\d+\b/g)].map((m) => m[0]);
}

export function computeCoverage(draft: SpecDraft) {
  const names = testNames(draft.acceptance_tests);
  return draft.requirements.map((r) => ({
    requirement_id: r.id,
    test_names: names.filter((n) => reqIdsIn(n).includes(r.id)),
  }));
}

export async function staticChecks(draft: SpecDraft, ev: RawEvidence): Promise<string[]> {
  const problems: string[] = [];

  // requirement IDs: REQ-1..n, unique, no gaps
  draft.requirements.forEach((r, i) => {
    if (r.id !== `REQ-${i + 1}`) {
      problems.push(`Requirement #${i + 1} has id ${r.id}; ids must be REQ-1..REQ-${draft.requirements.length} in order`);
    }
  });

  // source refs point at real lines
  const lineCounts = new Map(ev.snippets.map((s) => [snippetPath(s.location), s.code.split(/\r?\n/).length]));
  for (const r of draft.requirements) {
    for (const ref of r.source_refs) {
      const m = ref.match(/^(.+):L(\d+)-L(\d+)$/);
      if (!m) {
        problems.push(`${r.id}: source ref "${ref}" must look like "path:L12-L18"`);
        continue;
      }
      const [, p, a, b] = m;
      const n = lineCounts.get(p);
      if (n === undefined) {
        problems.push(`${r.id}: "${p}" is not one of the evidence files (${[...lineCounts.keys()].join(", ")})`);
      } else if (+a < 1 || +b < +a || +b > n) {
        problems.push(`${r.id}: lines L${a}-L${b} are outside ${p} (1-${n})`);
      }
    }
  }

  // tests: every name tagged, tags exist, every requirement covered
  const ids = new Set(draft.requirements.map((r) => r.id));
  const names = testNames(draft.acceptance_tests);
  if (names.length === 0) problems.push("acceptance_tests registers no test(...) calls");
  for (const n of names) {
    const tags = reqIdsIn(n);
    if (tags.length === 0) problems.push(`Test "${n}" does not start with the REQ ids it covers`);
    for (const t of tags) {
      if (!ids.has(t)) problems.push(`Test "${n}" references unknown ${t}`);
    }
  }
  for (const c of computeCoverage(draft)) {
    if (c.test_names.length === 0) problems.push(`${c.requirement_id} is not covered by any test`);
  }

  // determinism
  if (/Date\.now\(|new Date\(\s*\)|Math\.random\(/.test(draft.acceptance_tests)) {
    problems.push("acceptance_tests use Date.now(), new Date() or Math.random(); tests must be deterministic");
  }

  // types_code: declarations only, declares every export
  if (/\bimport\s/.test(draft.types_code)) problems.push("types_code must not import anything");
  if (/export\s+function\s/.test(draft.types_code)) {
    problems.push("types_code must use 'export declare function', not implementations");
  }
  for (const e of draft.exports) {
    const re = new RegExp(`export\\s+(declare\\s+function|declare\\s+const|interface|type)\\s+${e.name}\\b`);
    if (!re.test(draft.types_code)) problems.push(`export "${e.name}" is listed but not declared in types_code`);
  }
  try {
    await transform(draft.types_code, { loader: "ts" });
  } catch (e) {
    problems.push(`types_code does not parse: ${(e as Error).message.split("\n")[0]}`);
  }

  // adapter delegates to the original
  if (!/\boriginal\(\s*["'`]/.test(draft.adapter_code)) problems.push('adapter_code never calls original("<path>")');
  if (!/module\.exports\s*=/.test(draft.adapter_code)) problems.push("adapter_code must end with module.exports = { ... }");

  return problems;
}

export function repairFeedback(problems: string[]): string {
  return `Your specification has problems. The ORIGINAL code is the ground truth.

<problems>
${problems.map((p, i) => `${i + 1}. ${p}`).join("\n")}
</problems>

For every test that FAILED against the original, decide which part is wrong:
- the test's expected value: re-trace the original code by hand, line by line, with that exact input; or
- the adapter's translation: field names, units, clock format, argument order.
Never change a requirement to describe behavior the original does not have. If a requirement is wrong, correct its statement to match what the original does.
Do not delete a test just because it fails; every requirement must stay covered.
Return the complete corrected specification with all fields, not a diff.`;
}
