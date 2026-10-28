import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { PublicOracleReport, type DecompTargetSpec } from "@splice/contracts";

/** Check the public projection against the registered suite before exposing worker data. */
export async function validatePublicOracle(raw: unknown, target: DecompTargetSpec, repoRoot: string) {
  const report = PublicOracleReport.parse(raw);
  if (target.driver !== "uno" || report.target_id !== target.id) throw new Error("public oracle target mismatch");
  const suite = JSON.parse(await fs.readFile(path.join(repoRoot, target.cases), "utf8"));
  const publicCases = new Map<string, Record<string, any>>((suite.cases as Record<string, any>[])
    .filter(c => !("held_out" in c ? Boolean(c.held_out)
      : Math.floor(createHash("sha256").update(c.id).digest()[0] * 100 / 256) < 30))
    .map(c => [c.id, c]));
  if (report.cases.length !== publicCases.size || new Set(report.cases.map(c => c.id)).size !== publicCases.size) {
    throw new Error("public oracle report does not match the registered public suite");
  }
  for (const item of report.cases) {
    const original = publicCases.get(item.id);
    if (!original) throw new Error("public oracle report contains a case outside the public suite");
    const input = { ...(original.operation ? { operation: original.operation } : { formula: original.formula }),
      cells: original.cells ?? {} };
    if (!isDeepStrictEqual(input, item.input)) throw new Error("public oracle input differs from the registered suite");
    if ((item.observed === null) !== (item.outcome === "execution_error")) {
      throw new Error("public oracle outcome contradicts its observation");
    }
  }
  return report;
}
