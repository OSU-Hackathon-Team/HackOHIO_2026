// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/03_bundle_validator.md §3
// Comprehensive final bundle validator and structural audit gate.
// Ensures manifest schema validity, behavioral conformance of blueprints, immutability of
// server entry files, clean-room engine byte-identity, import allowlist & resolution,
// and virtual TypeScript compilation.
import ts from "typescript";
import {
  GENERATED_PATH,
  ALLOWED_DEPENDENCIES,
  SynthesisBundle,
  type FeatureBlueprint,
} from "@splice/contracts";
import { typecheckVirtualDetailed } from "../typecheck/virtualTsc.js";
import { ENTRY_FILES, enginePath, duplicateEngineErrors } from "./assemble.js";

const ALLOWED_PKGS = new Set([
  ...Object.keys(ALLOWED_DEPENDENCIES),
  "react/jsx-runtime",
  "react-dom/client",
]);

export type BundleValidationStage =
  | "manifest"
  | "structure"
  | "engine_conformance"
  | "imports"
  | "typecheck";

export interface BundleDiagnostic {
  stage: BundleValidationStage;
  file?: string;
  line?: number;
  col?: number;
  message: string;
  severity: "error" | "warning";
}

export interface BundleValidationResult {
  ok: boolean;
  errors: string[];
  diagnostics: BundleDiagnostic[];
  summary: string;
}

/**
 * Inspects a TypeScript / TSX source file AST for syntax/parse errors and imports.
 */
function inspectSource(path: string, code: string): { imports: string[]; parseErrors: string[] } {
  const sf = ts.createSourceFile(
    path,
    code,
    ts.ScriptTarget.ES2022,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const parseErrors: string[] = [];
  const diags = (sf as any).parseDiagnostics as ts.DiagnosticWithLocation[] | undefined;
  if (diags && diags.length > 0) {
    for (const d of diags) {
      const pos = sf.getLineAndCharacterOfPosition(d.start ?? 0);
      const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
      parseErrors.push(`${path}(${pos.line + 1},${pos.character + 1}): Syntax error: ${msg}`);
    }
  }

  const imports: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      imports.push(n.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      imports.push(n.arguments[0].text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  return { imports, parseErrors };
}

/**
 * Resolves a relative import specifier against the in-memory bundle file map.
 */
function resolveRelative(from: string, spec: string, files: Record<string, string>): string | null {
  const dir = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") dir.pop();
    else if (seg !== "." && seg !== "") dir.push(seg);
  }
  const base = dir.join("/") || "/";
  for (const c of [
    base,
    base + ".ts",
    base + ".tsx",
    base + ".d.ts",
    base + "/index.ts",
    base + "/index.tsx",
  ]) {
    if (files[c] !== undefined) return c;
  }
  return null;
}

/**
 * Validates a final synthesis bundle against its feature blueprints, shared contracts,
 * structural constraints, and virtual TypeScript compilation.
 */
export function validateBundle(
  bundle: SynthesisBundle,
  blueprints: FeatureBlueprint[],
): BundleValidationResult {
  const errors: string[] = [];
  const diagnostics: BundleDiagnostic[] = [];

  function addDiag(
    stage: BundleValidationStage,
    file: string | undefined,
    message: string,
    line?: number,
    col?: number,
  ) {
    errors.push(message);
    diagnostics.push({
      stage,
      file,
      line,
      col,
      message,
      severity: "error",
    });
  }

  // 1. Manifest and Metadata Schema Validation
  const schemaParsed = SynthesisBundle.safeParse(bundle);
  if (!schemaParsed.success) {
    for (const issue of schemaParsed.error.issues) {
      addDiag(
        "manifest",
        undefined,
        `Bundle manifest schema error: ${issue.path.join(".") || "root"} - ${issue.message}`,
      );
    }
  }

  if (bundle.bundle_id !== undefined) {
    const bpFeatureIds = [...blueprints.map((b) => b.feature_id)].sort();
    const bundleFeatureIds = [...(bundle.feature_ids ?? [])].sort();
    if (JSON.stringify(bpFeatureIds) !== JSON.stringify(bundleFeatureIds)) {
      addDiag(
        "manifest",
        undefined,
        `Manifest feature_ids [${bundleFeatureIds.join(", ")}] do not match blueprints [${bpFeatureIds.join(", ")}]`,
      );
    }

    const expectedEnginePaths = [...blueprints.map(enginePath)].sort();
    const actualEnginePaths = [...(bundle.engine_paths ?? [])].sort();
    if (JSON.stringify(expectedEnginePaths) !== JSON.stringify(actualEnginePaths)) {
      addDiag(
        "manifest",
        undefined,
        `Manifest engine_paths do not match expected [${expectedEnginePaths.join(", ")}]`,
      );
    }

    if (bundle.dependencies) {
      for (const [pkg, ver] of Object.entries(bundle.dependencies)) {
        const allowedVer = ALLOWED_DEPENDENCIES[pkg as keyof typeof ALLOWED_DEPENDENCIES];
        if (allowedVer === undefined) {
          addDiag(
            "manifest",
            undefined,
            `Dependency "${pkg}" is not an allowed Sandpack dependency`,
          );
        } else if (allowedVer !== ver) {
          addDiag(
            "manifest",
            undefined,
            `Dependency "${pkg}@${ver}" does not match allowed version "${allowedVer}"`,
          );
        }
      }
    }
  }

  // 2. Behavioral Conformance Pre-requisite on Blueprints
  // (Ensures typechecking alone is NEVER treated as proof of behavioral correctness)
  for (const b of blueprints) {
    if (b.verification.status !== "passed") {
      addDiag(
        "engine_conformance",
        enginePath(b),
        `Engine "${b.implementation.module_name}" (${b.feature_id}) failed behavioral conformance verification (status: ${b.verification.status}); unverified engines cannot be bundled`,
      );
    }
    if (b.verification.purity_violations.length > 0) {
      addDiag(
        "engine_conformance",
        enginePath(b),
        `Engine "${b.implementation.module_name}" contains purity violations: ${b.verification.purity_violations.join(", ")}`,
      );
    }
    if (b.verification.type_errors.length > 0) {
      addDiag(
        "engine_conformance",
        enginePath(b),
        `Engine "${b.implementation.module_name}" contains type errors: ${b.verification.type_errors.join(", ")}`,
      );
    }
    if (b.verification.passed < b.verification.total || b.verification.total === 0) {
      addDiag(
        "engine_conformance",
        enginePath(b),
        `Engine "${b.implementation.module_name}" has failing or unexecuted acceptance tests (${b.verification.passed}/${b.verification.total} passed)`,
      );
    }
  }

  // 3. Structure & Server-Owned Immutability
  for (const err of duplicateEngineErrors(blueprints)) {
    addDiag("structure", undefined, err);
  }

  const f = bundle.files ?? {};

  // /App.tsx presence and default export check
  if (!f["/App.tsx"]) {
    addDiag("structure", "/App.tsx", "Missing /App.tsx");
  } else if (
    !/export\s+default\s+(function|class|App\b|{\s*App\s*as\s*default)/.test(f["/App.tsx"])
  ) {
    addDiag(
      "structure",
      "/App.tsx",
      "/App.tsx must have a default export (export default function App())",
    );
  }

  // Server-owned entry files must exist and be byte-identical
  for (const [p, c] of Object.entries(ENTRY_FILES)) {
    if (f[p] !== c) {
      addDiag("structure", p, `${p} was modified; it is server-owned`);
    }
  }

  // Engines must be byte-identical to verified portable_code
  for (const b of blueprints) {
    const p = enginePath(b);
    if (f[p] !== b.implementation.portable_code) {
      addDiag("structure", p, `${p} differs from the verified engine`);
    }
  }

  // File paths must be strictly within allowed server-owned or generated paths
  const serverPaths = new Set([...Object.keys(ENTRY_FILES), ...blueprints.map(enginePath)]);
  for (const p of Object.keys(f)) {
    if (!serverPaths.has(p) && !GENERATED_PATH.test(p)) {
      addDiag("structure", p, `File not allowed: ${p}`);
    }
  }

  // 4. Imports, Syntax & Resolution
  const usedEngines = new Set<string>();
  for (const p of bundle.generated_paths ?? []) {
    if (f[p] === undefined) {
      addDiag("structure", p, `${p} is listed as generated but missing from the bundle`);
      continue;
    }

    const { imports, parseErrors } = inspectSource(p, f[p]);
    for (const pe of parseErrors) {
      addDiag("imports", p, pe);
    }

    for (const spec of imports) {
      if (spec.startsWith(".")) {
        const r = resolveRelative(p, spec, f);
        if (!r) {
          addDiag("imports", p, `${p}: cannot resolve import "${spec}"`);
        } else {
          if (r === p) {
            addDiag("imports", p, `${p}: file imports itself "${spec}"`);
          }
          if (r.startsWith("/engines/")) {
            usedEngines.add(r);
          }
        }
      } else if (!ALLOWED_PKGS.has(spec)) {
        addDiag(
          "imports",
          p,
          `${p}: package "${spec}" is not available (allowed: ${[...ALLOWED_PKGS].join(", ")})`,
        );
      }
    }
  }

  // Every engine must be imported by the UI
  for (const b of blueprints) {
    if (!usedEngines.has(enginePath(b))) {
      addDiag(
        "imports",
        enginePath(b),
        `Engine ${b.implementation.module_name} is never imported by the UI; every engine must be used`,
      );
    }
  }

  // 5. Virtual TypeScript Compilation
  // Type-check everything together if structural and import checks passed
  if (errors.length === 0) {
    const tcResult = typecheckVirtualDetailed(f, { strict: false, jsx: true });
    for (const d of tcResult.diagnostics) {
      addDiag("typecheck", d.file, `${d.file}(${d.line},${d.col}): ${d.message}`, d.line, d.col);
    }
  }

  const summary =
    errors.length === 0
      ? "Bundle validation passed: manifest valid, all engines verified and utilized, entry files intact, imports resolved, and TypeScript virtual compilation passed."
      : `Bundle validation failed: ${errors.length} error(s) detected across ${[
          ...new Set(diagnostics.map((d) => d.stage)),
        ].join(", ")}.`;

  // Return { ok, errors } as own enumerable properties for exact backwards compatibility,
  // and attach diagnostics & summary
  const res = {
    ok: errors.length === 0,
    errors,
  };

  Object.defineProperty(res, "diagnostics", {
    value: diagnostics,
    enumerable: false,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(res, "summary", {
    value: summary,
    enumerable: false,
    writable: true,
    configurable: true,
  });

  return res as BundleValidationResult;
}

/**
 * Validates a bundle and returns an explicitly enumerable BundleValidationResult.
 */
export function validateBundleDetailed(
  bundle: SynthesisBundle,
  blueprints: FeatureBlueprint[],
): BundleValidationResult {
  const res = validateBundle(bundle, blueprints);
  return {
    ok: res.ok,
    errors: res.errors,
    diagnostics: res.diagnostics,
    summary: res.summary,
  };
}
