# 04 — Evidence Collector (H4–H8, CP1)

> **Scope:** This capped collector is for the small Electron demo. The subsystem engine uses
> scope discovery, address-linked evidence, pagination, and on-demand expansion as specified in
> [the implementation plan](../../DECOMP_IMPLEMENTATION_PLAN.md). An eight-file or character
> cap must report omitted evidence; truncation must never imply complete behavioral coverage.

`collectEvidence(app, feature, hooks)` → `RawEvidence`. The sequence of calls is fixed per
artifact type, so runs are fast and repeatable.

## 1. Pipeline (electron_asar / electron_dir)

```
connecting      rea.start()                                  (pre-warmed, usually instant)
analyzing       analyze_javascript_application(target)       → evidence_id A  (module graph)
tracing         trace_application_feature(A, seed)  × seeds  → module paths related to the feature
                trace_javascript_semantics(A, symbol)        (optional, if available; ≤ 2 symbols)
reading_source  read each located file's bytes from the .asar (seed first, then related, cap 8)
→ RawEvidence
```

Why we read the source ourselves: REA *locates* code (which modules, which relations, which
symbols). The bytes at those locations are the evidence. Reading them straight from the archive
REA analyzed is exact, and it doesn't depend on REA's response caps or paging. Everything we
read is a path REA itself named, and the `tool_calls` record shows where each path came from.

## 2. `src/rea/asarReader.ts`

```ts
import * as asar from "@electron/asar";
import fs from "node:fs/promises";
import path from "node:path";

export interface ArchiveReader {
  files: string[];                       // posix paths relative to archive root, no leading slash
  readText(p: string): string;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\/+/, "");

export async function openArchive(absPath: string): Promise<ArchiveReader> {
  if (absPath.endsWith(".asar")) {
    const files = asar.listPackage(absPath, { isPack: false }).map(norm);
    const fileSet = new Set(files);
    return {
      files,
      readText: (p) => {
        const key = norm(p);
        if (!fileSet.has(key)) throw new Error(`not in archive: ${key}`);
        return asar.extractFile(absPath, key).toString("utf8");
      },
    };
  }
  // electron_dir
  const files: string[] = [];
  async function walk(dir: string) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else files.push(norm(path.relative(absPath, full)));
    }
  }
  await walk(absPath);
  const { readFileSync } = await import("node:fs");
  return { files, readText: (p) => readFileSync(path.join(absPath, norm(p)), "utf8") };
}
```

> `asar.listPackage` on Windows returns backslash paths with a leading separator. `norm`
> handles that. Directories also appear in the list; `readText` on a directory throws, and the
> collector filters to `*.js` / `*.mjs` / `*.cjs` / `*.ts` anyway.

## 3. `src/evidence/collector.ts`

```ts
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { RawEvidence, type PantryApp, type PantryFeature, type ToolCallRecord, type SourceSnippet } from "@splice/contracts";
import { rea } from "../rea/reaClient.js";
import { reaArgs } from "../rea/reaArgs.js";
import type { NormalizedResult } from "../rea/normalize.js";
import { openArchive, type ArchiveReader } from "../rea/asarReader.js";
import { config, REPO_ROOT } from "../config.js";

export interface CollectorHooks {
  onStage(stage: "connecting" | "analyzing" | "tracing" | "reading_source", message: string): void;
  onToolCall(seq: number, tool: string, argsPreview: string): void;
  onToolResult(rec: ToolCallRecord): void;
  signal?: AbortSignal;
}

const CODE_FILE = /\.(c|m)?(j|t)s$/;
const MAX_SNIPPETS = 8;
const MAX_SNIPPET_CHARS = 40_000;

export async function collectEvidence(app: PantryApp, feature: PantryFeature, hooks: CollectorHooks): Promise<RawEvidence> {
  if (app.artifact_type !== "electron_asar" && app.artifact_type !== "electron_dir") {
    throw new Error(`live collection not supported for ${app.artifact_type}; use replay`);
  }
  const budget = AbortSignal.timeout(config.reaRunBudgetMs);
  const signal = hooks.signal ? AbortSignal.any([hooks.signal, budget]) : budget;

  const targetAbs = path.join(REPO_ROOT, app.target_path);
  const sha256 = createHash("sha256").update(await fs.readFile(targetAbs)).digest("hex");
  const calls: ToolCallRecord[] = [];
  let seq = 0;

  async function run(tool: string, args: Record<string, unknown>): Promise<NormalizedResult> {
    signal.throwIfAborted();
    const n = ++seq;
    hooks.onToolCall(n, tool, preview(args));
    const t0 = Date.now();
    let res: NormalizedResult;
    try {
      res = await rea.call(tool, args, { signal });
    } catch (e) {
      const rec: ToolCallRecord = {
        seq: n, tool, args, ok: false, duration_ms: Date.now() - t0, evidence_id: null,
        summary: `error: ${(e as Error).message}`.slice(0, 300), limitations: [],
      };
      calls.push(rec);
      hooks.onToolResult(rec);
      throw e;
    }
    const rec: ToolCallRecord = {
      seq: n, tool, args, ok: res.ok, duration_ms: Date.now() - t0, evidence_id: res.evidenceId,
      summary: res.summary, limitations: res.limitations,
    };
    calls.push(rec);
    hooks.onToolResult(rec);
    if (!res.ok) throw new Error(`${tool} failed: ${res.summary}`);
    return res;
  }

  // 1. connect
  hooks.onStage("connecting", "Connecting to REA (rea-agents MCP)…");
  await rea.start();

  // 2. analyze
  hooks.onStage("analyzing", `Analyzing ${app.display_name} — ${path.basename(targetAbs)} (${(await fs.stat(targetAbs)).size.toLocaleString()} bytes)`);
  const analysis = await run("analyze_javascript_application", reaArgs.analyzeApp(targetAbs));
  if (!analysis.evidenceId) throw new Error("analyze_javascript_application returned no evidence_id");

  // 3. trace
  hooks.onStage("tracing", `Tracing "${feature.title}" from ${feature.seeds.map((s) => s.value).join(", ")}`);
  const traces: NormalizedResult[] = [];
  for (const seed of feature.seeds) traces.push(await run("trace_application_feature", reaArgs.traceFeature(analysis.evidenceId, seed)));
  if (rea.hasTool("trace_javascript_semantics")) {
    for (const sym of feature.symbols.slice(0, 2)) {
      try {
        traces.push(await run("trace_javascript_semantics", reaArgs.traceSemantics(analysis.evidenceId, sym)));
      } catch {
        // optional — the failed call is still in the record
      }
    }
  }

  // 4. read located source
  hooks.onStage("reading_source", "Reading located modules from the archive…");
  const archive = await openArchive(targetAbs);
  const ordered = rankPaths(feature, archive, [analysis, ...traces]);
  const snippets: SourceSnippet[] = ordered.slice(0, MAX_SNIPPETS).map((p) => {
    const code = archive.readText(p);
    return {
      location: `${path.basename(targetAbs)}:${p}`,
      symbol: feature.symbols.find((s) => new RegExp(`function\\s+${s}\\b|${s}\\s*[:=]`).test(code)) ?? null,
      language: p.endsWith(".ts") ? "typescript" : "javascript",
      code: code.slice(0, MAX_SNIPPET_CHARS),
      full_module: code.length <= MAX_SNIPPET_CHARS,
    };
  });

  const unknowns = [...new Set([...analysis.unknowns, ...traces.flatMap((t) => t.unknowns)])];
  for (const sym of feature.symbols) {
    if (!snippets.some((s) => s.code.includes(sym))) unknowns.push(`symbol ${sym} not found in located modules`);
  }

  return RawEvidence.parse({
    app_id: app.app_id,
    feature_id: feature.feature_id,
    target: { path: app.target_path, artifact_type: app.artifact_type, sha256 },
    rea_package_version: config.reaVersion,
    mode: "live",
    tool_calls: calls,
    snippets,
    related_paths: ordered,
    limitations: [...new Set(calls.flatMap((c) => c.limitations))],
    unknowns,
    collected_at: new Date().toISOString(),
  });
}

/** Seed modules first, then files REA's results mention, then files that seeds require(). */
function rankPaths(feature: PantryFeature, archive: ArchiveReader, results: NormalizedResult[]): string[] {
  const code = archive.files.filter((f) => CODE_FILE.test(f));
  const out: string[] = [];
  const add = (p: string | undefined) => { if (p && !out.includes(p)) out.push(p); };

  for (const s of feature.seeds) if (s.kind === "module") add(matchKnown(s.value, code));
  for (const r of results) for (const p of pathsMentioned(r.result, code)) add(p);
  // follow relative require() one level from the seeds (cheap, and covers helpers like wikilinks.js)
  for (const p of [...out]) {
    const src = archive.readText(p);
    for (const m of src.matchAll(/require\(["'](\.{1,2}\/[^"']+)["']\)/g)) {
      add(matchKnown(pathJoin(p, m[1]), code));
    }
  }
  return out;
}

function matchKnown(candidate: string, known: string[]): string | undefined {
  const c = candidate.replace(/\\/g, "/").replace(/^\/+/, "");
  return known.find((k) => k === c || k === c + ".js" || k.endsWith("/" + c) || c.endsWith("/" + k));
}

function pathJoin(fromFile: string, rel: string): string {
  const parts = fromFile.split("/").slice(0, -1);
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** Walk any JSON payload and return archive paths that appear in string values. */
function pathsMentioned(payload: unknown, known: string[], cap = 20_000): string[] {
  const found = new Set<string>();
  const stack: unknown[] = [payload];
  let n = 0;
  while (stack.length && n++ < cap) {
    const v = stack.pop();
    if (typeof v === "string") {
      if (v.length < 300 && /\.(c|m)?(j|t)s\b/.test(v)) {
        const hit = matchKnown(v.split(/[#:?]/)[0], known);
        if (hit) found.add(hit);
      }
    } else if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === "object") stack.push(...Object.values(v));
  }
  return [...found];
}

function preview(args: Record<string, unknown>): string {
  const s = JSON.stringify(args, (_k, v) => (typeof v === "string" && v.length > 80 ? "…" + v.slice(-60) : v));
  return s.length > 200 ? s.slice(0, 197) + "…" : s;
}
```

## 4. What a good RawEvidence looks like (inkwell.wikilink_graph)

- `tool_calls`: 3–4 entries (analyze, trace, maybe semantics), each with an `evidence_id`
- `snippets`: `src/graph/backlinks.js` (seed, `symbol: "buildLinkGraph"`), `src/graph/wikilinks.js`
  (required helper), and possibly `src/main.js` (REA relates it via `ipcMain.handle`, which is
  useful context for Eng 2: "this is IPC glue, ignore it")
- `unknowns`: empty. If you see `symbol X not found`, the seed or path matching is wrong.

## 5. Timing targets

| Step | Target | If slower |
|---|---|---|
| analyze (warm) | < 5 s | use `detail: "summary"`; check `REA_MCP_MAX_RESPONSE_BYTES` |
| each trace | < 3 s | drop `trace_javascript_semantics` |
| total collection | < 15 s | `auto` mode falls back to replay at `REA_RUN_BUDGET_MS` (45 s) |

## 6. Stretch: agentic REA mode (only after CP2, cut first)

The fixed sequence above is what ships. If you're ahead, add `collectEvidenceAgentic()`: Claude
gets a **read-only allowlist** of REA tools and the feature query, and decides which tools to
call. It reuses Eng 2's `llm.ts` (Bedrock).

```ts
const ALLOW = ["binary_session", "analyze_javascript_application", "trace_application_feature",
               "trace_javascript_semantics", "inspect_analysis_view"];
const tools = (await rea.listTools())
  .filter((t) => ALLOW.includes(t.name))
  .map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema as any }));
// Use toolLoop() from 2_requirements_extraction/02_llm_client.md §5 (max 8 iterations).
// Each tool_use → rea.call(...) → tool_result content = normalized.summary + truncated JSON (≤ 8k chars).
// Then run §3's step 4 (read located source) over every result, so the output is still RawEvidence.
```

Keep it behind `COLLECTOR=agentic` and never use it in the demo unless it has been recorded.
