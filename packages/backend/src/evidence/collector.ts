import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import {
  RawEvidence,
  type PantryApp,
  type PantryFeature,
  type ToolCallRecord,
  type SourceSnippet,
} from "@splice/contracts";
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

export async function collectEvidence(
  app: PantryApp,
  feature: PantryFeature,
  hooks: CollectorHooks,
): Promise<RawEvidence> {
  if (app.artifact_type !== "electron_asar" && app.artifact_type !== "electron_dir") {
    throw new Error(`live collection not supported for ${app.artifact_type}; use replay`);
  }

  const targetAbs = path.join(REPO_ROOT, app.target_path);
  if (!fsSync.existsSync(targetAbs)) {
    throw new Error(`Target archive not found: ${app.target_path}`);
  }

  const budget = AbortSignal.timeout(config.reaRunBudgetMs);
  const signal = hooks.signal ? AbortSignal.any([hooks.signal, budget]) : budget;

  const targetBytes = await fs.readFile(targetAbs);
  const sha256 = createHash("sha256").update(targetBytes).digest("hex");
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
        seq: n,
        tool,
        args,
        ok: false,
        duration_ms: Date.now() - t0,
        evidence_id: null,
        summary: `error: ${(e as Error).message}`.slice(0, 300),
        limitations: [],
      };
      calls.push(rec);
      hooks.onToolResult(rec);
      throw e;
    }
    const rec: ToolCallRecord = {
      seq: n,
      tool,
      args,
      ok: res.ok,
      duration_ms: Date.now() - t0,
      evidence_id: res.evidenceId,
      summary: res.summary,
      limitations: res.limitations,
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
  hooks.onStage(
    "analyzing",
    `Analyzing ${app.display_name} — ${path.basename(targetAbs)} (${targetBytes.length.toLocaleString()} bytes)`,
  );
  const analysis = await run("analyze_javascript_application", reaArgs.analyzeApp(targetAbs));
  // detail:"summary" returns a summary record; trace tools need the retained full analysis
  const appEvidence = analysis.parentEvidenceId ?? analysis.evidenceId;
  if (!appEvidence) throw new Error("analyze_javascript_application returned no evidence id");

  // 3. trace
  hooks.onStage("tracing", `Tracing "${feature.title}" from ${feature.seeds.map((s) => s.value).join(", ")}`);
  const traces: NormalizedResult[] = [];
  for (const seed of feature.seeds) {
    traces.push(await run("trace_application_feature", reaArgs.traceFeature(appEvidence, seed)));
  }
  if (rea.hasTool("trace_javascript_semantics")) {
    for (const sym of feature.symbols.slice(0, 2)) {
      try {
        traces.push(await run("trace_javascript_semantics", reaArgs.traceSemantics(appEvidence, sym)));
      } catch {
        // optional — failed call is still in the record
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
    if (!snippets.some((s) => s.code.includes(sym))) {
      unknowns.push(`symbol ${sym} not found in located modules`);
    }
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
export function rankPaths(
  feature: PantryFeature,
  archive: ArchiveReader,
  results: NormalizedResult[],
): string[] {
  const code = archive.files.filter((f) => CODE_FILE.test(f));
  const out: string[] = [];
  const add = (p: string | undefined) => {
    if (p && !out.includes(p)) out.push(p);
  };

  for (const s of feature.seeds) {
    if (s.kind === "module") add(matchKnown(s.value, code));
  }
  for (const r of results) {
    for (const p of pathsMentioned(r.result, code)) add(p);
  }
  // follow relative require() one level from the seeds (covers helpers like wikilinks.js)
  for (const p of [...out]) {
    try {
      const src = archive.readText(p);
      for (const m of src.matchAll(/require\(["'](\.{1,2}\/[^"']+)["']\)/g)) {
        add(matchKnown(pathJoin(p, m[1]), code));
      }
    } catch {
      // ignore read failures on directories or missing files
    }
  }
  return out;
}

export function matchKnown(candidate: string, known: string[]): string | undefined {
  const c = candidate.replace(/\\/g, "/").replace(/^\/+/, "");
  return known.find((k) => k === c || k === c + ".js" || k.endsWith("/" + c) || c.endsWith("/" + k));
}

export function pathJoin(fromFile: string, rel: string): string {
  const parts = fromFile.split("/").slice(0, -1);
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** Walk any JSON payload and return archive paths that appear in string values. */
export function pathsMentioned(payload: unknown, known: string[], cap = 20_000): string[] {
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
    } else if (Array.isArray(v)) {
      stack.push(...v);
    } else if (v && typeof v === "object") {
      stack.push(...Object.values(v));
    }
  }
  return [...found];
}

export function preview(args: Record<string, unknown>): string {
  const s = JSON.stringify(args, (_k, v) => (typeof v === "string" && v.length > 80 ? "…" + v.slice(-60) : v));
  return s.length > 200 ? s.slice(0, 197) + "…" : s;
}
