// The native target registry: fixtures/decomp/targets/<id>.json, validated by DecompTargetSpec.
// A malformed entry fails loudly at startup instead of silently disappearing from Studio.

import fs from "node:fs";
import path from "node:path";
import { DecompTargetSpec, type DecompTarget } from "@splice/contracts";

export function loadTargetRegistry(folder: string): DecompTargetSpec[] {
  let names: string[];
  try { names = fs.readdirSync(folder).filter((name) => name.endsWith(".json")).sort(); }
  catch { return []; }
  const targets = names.map((name) => {
    const parsed = DecompTargetSpec.safeParse(JSON.parse(fs.readFileSync(path.join(folder, name), "utf8")));
    if (!parsed.success) throw new Error(`invalid decomp target ${name}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    if (`${parsed.data.id}.json` !== name) throw new Error(`decomp target ${name} declares id ${parsed.data.id}`);
    return parsed.data;
  });
  // LibreOffice stays first: it is the reference target the rest of Studio was built around.
  return targets.sort((a, b) => Number(b.id === "libreoffice-calc") - Number(a.id === "libreoffice-calc"));
}

export function publicTarget({ id, name, description, library, driver, function_budgets, estimated_cost_usd }: DecompTargetSpec): DecompTarget {
  return { id, name, description, library, driver, function_budgets, estimated_cost_usd };
}
