# 03 — Bundle Validator & Virtual `tsc`

Catches compile-time problems **before** Sandpack sees the bundle: wrong engine export names,
type mismatches, forbidden imports, missing `App`. Runtime errors are handled by auto-fix (04).

## 1. Dependencies (backend, for type information only)

```bash
npm install -w @splice/backend --save-dev typescript @types/react@18.3.12 @types/react-dom@18.3.1 @types/canvas-confetti
npm install -w @splice/backend --save-dev --save-exact lucide-react@0.344.0
```
(`lucide-react` ships its own types. It must be the **same version** Sandpack installs, so
icon names type-check correctly.)

## 2. `src/typecheck/virtualTsc.ts`

Type-checks an in-memory file map. Virtual files live under `packages/backend/__virtual__/`
(that directory never exists on disk), so module resolution walks up into the real
`node_modules` and finds React's types.

```ts
import ts from "typescript";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VROOT = path.join(BACKEND_DIR, "__virtual__").replace(/\\/g, "/");
const toV = (p: string) => VROOT + (p.startsWith("/") ? p : "/" + p);
const fromV = (p: string) => p.replace(/\\/g, "/").replace(VROOT, "");
const norm = (p: string) => p.replace(/\\/g, "/");

export function typecheckVirtual(
  files: Record<string, string>,
  opts: { strict: boolean; jsx: boolean; maxErrors?: number },
): string[] {
  const vfiles = new Map<string, string>();
  for (const [p, c] of Object.entries(files)) {
    if (/\.(tsx?|d\.ts)$/.test(p)) vfiles.set(toV(p), c);
  }

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: opts.jsx ? ts.JsxEmit.ReactJSX : undefined,
    strict: opts.strict,
    noImplicitAny: opts.strict,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    noEmit: true,
    isolatedModules: true,
    types: [],
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  };

  const host = ts.createCompilerHost(options, true);
  const origGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (f) => vfiles.has(norm(f)) || ts.sys.fileExists(f);
  host.readFile = (f) => vfiles.get(norm(f)) ?? ts.sys.readFile(f);
  host.directoryExists = (d) => norm(d).startsWith(VROOT) || ts.sys.directoryExists!(d);
  host.getSourceFile = (f, lang, onError, shouldCreate) => {
    const v = vfiles.get(norm(f));
    return v !== undefined ? ts.createSourceFile(f, v, lang, true) : origGetSourceFile(f, lang, onError, shouldCreate);
  };

  const program = ts.createProgram([...vfiles.keys()], options, host);
  const diags = ts.getPreEmitDiagnostics(program).filter((d) => !d.file || vfiles.has(norm(d.file.fileName)));

  return diags.slice(0, opts.maxErrors ?? 20).map((d) => {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
    if (!d.file || d.start === undefined) return msg;
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${fromV(d.file.fileName)}(${line + 1},${character + 1}): ${msg}`;
  });
}
```

Speed: the first call takes ~1–2 s (it loads lib + React types). Later calls are similar,
which is fine for our volume. If it gets slow, cache a `ts.createDocumentRegistry()` and reuse it.

## 3. `src/synthesis/validateBundle.ts`

```ts
import ts from "typescript";
import { GENERATED_PATH, ALLOWED_DEPENDENCIES, type FeatureBlueprint, type SynthesisBundle } from "@splice/contracts";
import { typecheckVirtual } from "../typecheck/virtualTsc.js";
import { ENTRY_FILES, enginePath } from "./assemble.js";

const ALLOWED_PKGS = new Set([...Object.keys(ALLOWED_DEPENDENCIES), "react/jsx-runtime", "react-dom/client"]);

function importsOf(path: string, code: string): string[] {
  const sf = ts.createSourceFile(path, code, ts.ScriptTarget.ES2022, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(n.arguments[0])) out.push(n.arguments[0].text);
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
  const errors: string[] = [];
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

  // 5. type-check everything together (only if structure is sane, to keep messages focused)
  if (errors.length === 0) {
    errors.push(...typecheckVirtual(f, { strict: false, jsx: true }));
  }

  return { ok: errors.length === 0, errors };
}
```

Why `strict: false` for UI code: generated UIs often have harmless implicit-`any` event
handlers. We want to catch **real** breakage (wrong export names, wrong argument shapes,
missing props), not style. Engines are checked with `strict: true` in 01.

## 4. Unit tests (`src/synthesis/validateBundle.test.ts`)

Must cover:
1. A valid two-engine bundle → `ok: true`
2. App imports `reviewCards` (typo) from the engine → a type error naming the missing export
3. App imports `axios` → "package not available"
4. One engine never imported → "never imported"
5. `/engines/x.ts` edited → "differs from the verified engine"
6. A file at `/src/App.tsx` → "File not allowed"
