// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/03_bundle_validator.md §2
import ts from "typescript";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Virtual files live under packages/backend/__virtual__/ (never on disk), so module resolution
// walks up into the real node_modules and finds React's types.
const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VROOT = path.join(BACKEND_DIR, "__virtual__").replace(/\\/g, "/");
const toV = (p: string) => VROOT + (p.startsWith("/") ? p : "/" + p);
const fromV = (p: string) => p.replace(/\\/g, "/").replace(VROOT, "");
const norm = (p: string) => p.replace(/\\/g, "/");

/** Type-checks an in-memory file map ("/App.tsx" → code). Returns "path(line,col): message" strings. */
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
