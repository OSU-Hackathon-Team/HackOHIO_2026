# 03 — REA MCP Bridge (H1–H4)

> **Concurrency scope:** The single connection and serialization below are for the Electron
> demo bridge. Do not route all native workers through one stateful active-target session.
> The new engine uses cached evidence plus a bounded pool of warm analysis contexts. Preserve
> session ownership of retained evidence IDs; persist exported payloads under durable IDs before
> sharing them across workers. See [the architecture](../../DecompPileline.md).

One long-lived stdio MCP connection to REA per backend process. It must be long-lived because
REA's `retained-evidence` references (`ev_…`) belong to a single connection's ledger.

## 1. Dependencies (`packages/backend`)

```bash
npm install -w @splice/backend --save-exact rea-agents@6.7.0 @modelcontextprotocol/sdk @electron/asar
```

We use the classic `@modelcontextprotocol/sdk` (v1) client API. It speaks the same protocol as
REA's newer server packages. Pin whatever version npm resolves with the lockfile.

## 2. `src/rea/reaClient.ts`

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { config, REPO_ROOT } from "../config.js";
import { normalize, type NormalizedResult } from "./normalize.js";

/** Prefer the pinned local install (fast, offline). Fall back to npx. */
function resolveLaunch(): { command: string; args: string[] } {
  const candidates: string[] = [];
  try {
    const require = createRequire(import.meta.url);
    candidates.push(path.join(path.dirname(require.resolve("rea-agents/package.json")), "scripts/rea.mjs"));
  } catch {
    // package "exports" may hide package.json — fall through to path probing
  }
  candidates.push(
    path.join(REPO_ROOT, "node_modules/rea-agents/scripts/rea.mjs"),
    path.join(REPO_ROOT, "packages/backend/node_modules/rea-agents/scripts/rea.mjs"),
  );
  const entry = candidates.find((p) => fs.existsSync(p));
  if (entry) return { command: process.execPath, args: [entry, "mcp"] };

  const npx = ["-y", `rea-agents@${config.reaVersion}`, "mcp"];
  return process.platform === "win32"
    ? { command: "cmd.exe", args: ["/d", "/c", "npx", ...npx] }
    : { command: "npx", args: npx };
}

export class ReaUnavailableError extends Error {}

class ReaBridge {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private starting: Promise<Client> | null = null;
  private tools: Tool[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  serverVersion: string | null = null;

  get connected() {
    return this.client !== null;
  }
  get toolCount() {
    return this.tools.length;
  }

  async start(): Promise<Client> {
    if (this.client) return this.client;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const { command, args } = resolveLaunch();
      const transport = new StdioClientTransport({
        command,
        args,
        cwd: REPO_ROOT,
        stderr: "pipe",
        env: {
          ...getDefaultEnvironment(),
          REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
          REA_MCP_MAX_RESPONSE_BYTES: String(config.reaMaxResponseBytes),
        },
      });
      transport.stderr?.on("data", (d) => {
        if (config.reaDebug) process.stderr.write(`[rea] ${d}`);
      });
      transport.onclose = () => {
        // Connection gone → retained evidence IDs are gone too. Next call restarts.
        this.client = null;
        this.transport = null;
        this.tools = [];
      };
      const client = new Client({ name: "splice", version: "0.1.0" }, { capabilities: {} });
      try {
        await client.connect(transport);
      } catch (e) {
        throw new ReaUnavailableError(`Could not start REA (${command} ${args.join(" ")}): ${(e as Error).message}`);
      }
      this.serverVersion = client.getServerVersion()?.version ?? null;
      this.tools = (await client.listTools()).tools;
      this.client = client;
      this.transport = transport;
      return client;
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async listTools(): Promise<Tool[]> {
    await this.start();
    return this.tools;
  }

  hasTool(name: string) {
    return this.tools.some((t) => t.name === name);
  }

  /** Serialize calls: REA sessions are stateful (active target), so one call at a time. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async callRaw(
    name: string,
    args: Record<string, unknown>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<CallToolResult> {
    return this.enqueue(async () => {
      const client = await this.start();
      return (await client.callTool({ name, arguments: args }, undefined, {
        timeout: opts.timeoutMs ?? config.reaCallTimeoutMs,
        signal: opts.signal,
      })) as CallToolResult;
    });
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<NormalizedResult> {
    return normalize(name, await this.callRaw(name, args, opts));
  }

  async close() {
    await this.transport?.close();
    this.client = null;
    this.transport = null;
  }
}

export const rea = new ReaBridge();
```

Behaviours that matter:
- **Pre-warm:** `server.ts` calls `rea.start()` and then `rea.call("binary_session", {})` at boot.
  REA's first call is slow (cold worker).
- **Serialized calls:** two extractions started at once queue up rather than fight over the
  active target. The UI runs extractions one after another anyway.
- **Restart on crash:** `onclose` clears state. The collector treats a mid-run restart as a
  failed run (old evidence IDs are invalid) and `auto` mode falls back to replay.

## 3. `src/rea/normalize.ts`

All knowledge of REA's result shape lives here. When REA's output doesn't match, fix this file
and nothing else.

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface NormalizedResult {
  tool: string;
  ok: boolean;
  evidenceId: string | null;
  /** structuredContent.normalized_result (falls back to the whole structured payload / parsed text) */
  result: unknown;
  limitations: string[];
  unknowns: string[];
  text: string;          // concatenated text content, truncated
  summary: string;       // ≤ 300 chars for the terminal
}

const MAX_TEXT = 60_000;

export function normalize(tool: string, r: CallToolResult): NormalizedResult {
  const sc = (r.structuredContent ?? null) as Record<string, unknown> | null;
  const text = (r.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .slice(0, MAX_TEXT);

  const result = sc?.normalized_result ?? sc ?? tryJson(text);
  const evidenceId = typeof sc?.evidence_id === "string" ? sc.evidence_id : null;

  return {
    tool,
    ok: !r.isError,
    evidenceId,
    result,
    limitations: collectNamed(sc, "limitations"),   // VERIFY location against fixtures/rea/sample_*.json
    unknowns: collectNamed(sc, "unknowns"),         // VERIFY
    text,
    summary: summarize(tool, !r.isError, result, text),
  };
}

function tryJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/** Walk the payload and collect strings from every array under a key with this name. */
function collectNamed(root: unknown, key: string, limit = 50): string[] {
  const out = new Set<string>();
  const stack: unknown[] = [root];
  let visited = 0;
  while (stack.length && visited++ < 20_000 && out.size < limit) {
    const v = stack.pop();
    if (!v || typeof v !== "object") continue;
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (k === key && Array.isArray(child)) {
        for (const item of child) {
          if (typeof item === "string") out.add(item);
          else if (item && typeof item === "object") {
            const msg = (item as any).message ?? (item as any).summary ?? (item as any).description;
            if (typeof msg === "string") out.add(msg);
          }
        }
      } else if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }
  return [...out];
}

/** Human summary: counts of top-level arrays, e.g. "modules: 9, relations: 14, routes: 2". */
function summarize(tool: string, ok: boolean, result: unknown, text: string): string {
  if (!ok) return `error: ${text.slice(0, 260)}`;
  if (result && typeof result === "object") {
    const parts = Object.entries(result as Record<string, unknown>)
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => `${k}: ${(v as unknown[]).length}`)
      .slice(0, 6);
    if (parts.length) return parts.join(", ");
  }
  return text.replace(/\s+/g, " ").slice(0, 300) || `${tool} ok`;
}
```

After the H1 catalog, improve `summarize` with per-tool cases (e.g. for
`analyze_javascript_application`: "9 modules · 14 imports · 2 IPC channels"). It's the text
judges read in the terminal, so make it specific.

## 4. `src/rea/reaArgs.ts` — every tool argument in one place

Fill in the verified names from `fixtures/rea/tools.json`, then remove each `// VERIFY`.

```ts
import type { ReaSeed } from "@splice/contracts";

export const reaArgs = {
  session: () => ({}),

  /** analyze_javascript_application — target is an ABSOLUTE path to a dir or .asar */
  analyzeApp: (absPath: string) => ({
    path: absPath,          // VERIFY: could be "target_path" / "application_path" / "root"
    detail: "summary",      // documented: keep the first reply small; full graph can be MBs
  }),

  /** trace_application_feature — shape from docs/mcp-contracts.md (documented example) */
  traceFeature: (evidenceId: string, seed: ReaSeed) => ({
    application: { kind: "retained-evidence", evidence_id: evidenceId },
    seed: { kind: seed.kind, value: seed.value, match: "exact" },
  }),

  /** trace_javascript_semantics — optional deeper trace when available */
  traceSemantics: (evidenceId: string, symbol: string) => ({
    application: { kind: "retained-evidence", evidence_id: evidenceId },
    seed: { kind: "symbol", value: symbol, match: "exact" }, // VERIFY
  }),

  /** inspect_analysis_view — page a retained dossier */
  inspectView: (parentEvidenceId: string, cursor?: string) => ({
    evidence_id: parentEvidenceId, // VERIFY
    ...(cursor ? { cursor } : {}), // VERIFY: "cursor" / "page" / "offset"
  }),
} as const;

/** Called once at startup: fail fast if a builder sends an arg the server doesn't know. */
export function checkArgsAgainstCatalog(tools: { name: string; inputSchema: any }[]) {
  const probes: [string, Record<string, unknown>][] = [
    ["analyze_javascript_application", reaArgs.analyzeApp("/x")],
    ["trace_application_feature", reaArgs.traceFeature("ev_x", { kind: "module", value: "x" })],
  ];
  const problems: string[] = [];
  for (const [name, args] of probes) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) { problems.push(`missing tool ${name}`); continue; }
    const props = Object.keys(tool.inputSchema?.properties ?? {});
    for (const k of Object.keys(args)) if (!props.includes(k)) problems.push(`${name}: unknown arg "${k}" (has: ${props.join(", ")})`);
    for (const r of tool.inputSchema?.required ?? []) if (!(r in args)) problems.push(`${name}: missing required "${r}"`);
  }
  if (problems.length) console.warn("[rea] argument/catalog mismatch:\n  " + problems.join("\n  "));
  return problems;
}
```

### Verified-arguments table (paste the H1 results here)

| Tool | Required args | Optional args we use | Verified by / time |
|---|---|---|---|
| `analyze_javascript_application` | | | |
| `trace_application_feature` | | | |
| `trace_javascript_semantics` | | | |
| `inspect_analysis_view` | | | |
| `binary_session` | – | – | |

## 5. Shutdown hygiene

In `server.ts` (06):

```ts
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await rea.close().catch(() => {});
    process.exit(0);
  });
}
```

On Windows, check for orphaned REA workers after Ctrl+C:
`Get-Process node | Select-Object Id, StartTime, Path`. The acceptance gate (07) requires zero
orphans.
