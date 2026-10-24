// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/03_bundle_validator.md §3
// Catches compile-time problems before Sandpack sees the bundle. Runtime errors go to auto-fix (04).
import ts from "typescript";
import { GENERATED_PATH, ALLOWED_DEPENDENCIES, type FeatureBlueprint, type SynthesisBundle } from "@splice/contracts";
import { typecheckVirtual } from "../typecheck/virtualTsc.js";
import { ENTRY_FILES, enginePath, duplicateEngineErrors } from "./assemble.js";

const ALLOWED_PKGS = new Set([...Object.keys(ALLOWED_DEPENDENCIES), "react/jsx-runtime", "react-dom/client"]);

function importsOf(path: string, code: string): string[] {
  const sf = ts.createSourceFile(path, code, ts.ScriptTarget.ES2022, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) out.push(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function resolveRelative(from: string, spec: string, files: Record<string, string>): string | null {
  const dir = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") dir.pop();
    else if (seg !== ".") dir.push(seg);
  }
  const base = dir.join("/") || "/";
  for (const c of [base, base + ".ts", base + ".tsx", base + "/index.ts", base + "/index.tsx"]) if (files[c] !== undefined) return c;
  return null;
}

export function validateBundle(bundle: SynthesisBundle, blueprints: FeatureBlueprint[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [...duplicateEngineErrors(blueprints)];
  const f = bundle.files;

  // 1. required files and server-owned files untouched
  if (!f["/App.tsx"]) errors.push("Missing /App.tsx");
  else if (!/export\s+default\s+(function|class|App\b)/.test(f["/App.tsx"])) errors.push("/App.tsx must have a default export (export default function App())");
  for (const [p, c] of Object.entries(ENTRY_FILES)) if (f[p] !== c) errors.push(`${p} was modified; it is server-owned`);

  // 2. engines byte-identical
  for (const b of blueprints) {
    const p = enginePath(b);
    if (f[p] !== b.implementation.portable_code) errors.push(`${p} differs from the verified engine`);
  }

  // 3. paths
  const serverPaths = new Set([...Object.keys(ENTRY_FILES), ...blueprints.map(enginePath)]);
  for (const p of Object.keys(f)) if (!serverPaths.has(p) && !GENERATED_PATH.test(p)) errors.push(`File not allowed: ${p}`);

  // 4. imports allowed + resolvable; each engine used
  const usedEngines = new Set<string>();
  for (const p of bundle.generated_paths) {
    if (f[p] === undefined) { errors.push(`${p} is listed as generated but missing from the bundle`); continue; }
    for (const spec of importsOf(p, f[p])) {
      if (spec.startsWith(".")) {
        const r = resolveRelative(p, spec, f);
        if (!r) errors.push(`${p}: cannot resolve import "${spec}"`);
        else if (r.startsWith("/engines/")) usedEngines.add(r);
      } else if (!ALLOWED_PKGS.has(spec)) {
        errors.push(`${p}: package "${spec}" is not available (allowed: ${[...ALLOWED_PKGS].join(", ")})`);
      }
    }
  }
  for (const b of blueprints) {
    if (!usedEngines.has(enginePath(b))) errors.push(`Engine ${b.implementation.module_name} is never imported by the UI; every engine must be used`);
  }

  // 5. type-check everything together (only if structure is sane, to keep messages focused).
  // strict: false — catch real breakage (wrong exports/shapes), not implicit-any style issues.
  if (errors.length === 0) {
    errors.push(...typecheckVirtual(f, { strict: false, jsx: true }));
  }

  return { ok: errors.length === 0, errors };
}
