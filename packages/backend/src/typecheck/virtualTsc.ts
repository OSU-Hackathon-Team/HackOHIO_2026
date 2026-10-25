// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/03_bundle_validator.md §2
import ts from "typescript";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Virtual files live under packages/backend/__virtual__/ (never on disk), so module resolution
// walks up into the real node_modules and finds React's types and dependencies.
const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VROOT = path.join(BACKEND_DIR, "__virtual__").replace(/\\/g, "/");
export const toV = (p: string) => VROOT + (p.startsWith("/") ? p : "/" + p);
export const fromV = (p: string) => p.replace(/\\/g, "/").replace(VROOT, "");
export const norm = (p: string) => p.replace(/\\/g, "/");

export interface VirtualDiagnostic {
  file: string;
  line: number;
  col: number;
  message: string;
  code: number;
  category: "error" | "warning" | "suggestion" | "message";
}

export interface TypecheckVirtualResult {
  ok: boolean;
  errors: string[];
  diagnostics: VirtualDiagnostic[];
}

/**
 * Type-checks an in-memory file map ("/App.tsx" → code) using TypeScript's Compiler API.
 * Provides detailed structured diagnostics and formatted error strings.
 */
export function typecheckVirtualDetailed(
  files: Record<string, string>,
  opts: { strict: boolean; jsx: boolean; maxErrors?: number },
): TypecheckVirtualResult {
  const vfiles = new Map<string, string>();
  for (const [p, c] of Object.entries(files)) {
    if (/\.(tsx?|d\.ts)$/.test(p)) vfiles.set(toV(p), c);
  }

  // Provide ambient declarations for CSS and static assets so bundler asset imports resolve
  const ambientPath = toV("/__ambient_assets__.d.ts");
  if (!vfiles.has(ambientPath)) {
    vfiles.set(
      ambientPath,
      `declare module "*.css" { const content: Record<string, string>; export default content; }\n` +
      `declare module "*.svg" { const content: string; export default content; }\n`,
    );
  }

  // Track exact ancestor directories of virtual files to avoid claiming non-existent virtual directories exist
  const vdirs = new Set<string>();
  for (const vf of vfiles.keys()) {
    let dir = path.dirname(vf).replace(/\\/g, "/");
    while (dir && dir.startsWith(VROOT)) {
      vdirs.add(dir);
      const parent = path.dirname(dir).replace(/\\/g, "/");
      if (parent === dir) break;
      dir = parent;
    }
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
  host.directoryExists = (d) => {
    const nd = norm(d);
    if (nd === VROOT || vdirs.has(nd)) return true;
    if (nd.startsWith(VROOT)) return false;
    return ts.sys.directoryExists!(d);
  };
  host.getSourceFile = (f, lang, onError, shouldCreate) => {
    const v = vfiles.get(norm(f));
    return v !== undefined ? ts.createSourceFile(f, v, lang, true) : origGetSourceFile(f, lang, onError, shouldCreate);
  };

  const program = ts.createProgram([...vfiles.keys()], options, host);
  const diags = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => !d.file || (vfiles.has(norm(d.file.fileName)) && norm(d.file.fileName) !== ambientPath));

  const diagnostics: VirtualDiagnostic[] = [];
  const errors: string[] = [];

  for (const d of diags.slice(0, opts.maxErrors ?? 30)) {
    const rawMsg = ts.flattenDiagnosticMessageText(d.messageText, " ").split(VROOT).join("");
    let file = "";
    let line = 0;
    let col = 0;
    if (d.file && d.start !== undefined) {
      const pos = d.file.getLineAndCharacterOfPosition(d.start);
      line = pos.line + 1;
      col = pos.character + 1;
      file = fromV(d.file.fileName);
    }
    const category: VirtualDiagnostic["category"] =
      d.category === ts.DiagnosticCategory.Error
        ? "error"
        : d.category === ts.DiagnosticCategory.Warning
          ? "warning"
          : d.category === ts.DiagnosticCategory.Suggestion
            ? "suggestion"
            : "message";

    diagnostics.push({
      file: file || "unknown",
      line,
      col,
      message: rawMsg,
      code: d.code,
      category,
    });

    const formatted = file ? `${file}(${line},${col}): ${rawMsg}` : rawMsg;
    errors.push(formatted);
  }

  return {
    ok: errors.length === 0,
    errors,
    diagnostics,
  };
}

/**
 * Type-checks an in-memory file map ("/App.tsx" → code). Returns "path(line,col): message" strings.
 * Maintained for exact signature compatibility.
 */
export function typecheckVirtual(
  files: Record<string, string>,
  opts: { strict: boolean; jsx: boolean; maxErrors?: number },
): string[] {
  return typecheckVirtualDetailed(files, opts).errors;
}
