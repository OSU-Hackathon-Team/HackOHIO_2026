# 06 — Backend Server Shell (H0–H6)

Eng 1 owns the process. Each step gets its own router file so three people never edit the same
file. Eng 1 creates all three router stubs at H0.

## 1. `packages/backend/package.json`

```json
{
  "name": "@splice/backend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch --clear-screen=false src/server.ts",
    "start": "tsx src/server.ts",
    "rea:catalog": "tsx src/scripts/reaCatalog.ts",
    "seed:evidence": "tsx src/scripts/makeSeedEvidence.ts",
    "record:evidence": "tsx src/scripts/recordAll.ts",
    "fixtures:promote": "tsx src/scripts/promoteFixtures.ts",
    "test:bridge": "tsx src/scripts/testBridge.ts",
    "test:collector": "tsx src/scripts/testCollector.ts",
    "test:unit": "node --import tsx --test src/**/*.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@splice/contracts": "*",
    "dotenv": "^16.4.5",
    "express": "^4.21.2",
    "zod": "^4.1.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3"
  }
}
```
(REA, MCP SDK and asar are added with `--save-exact` per 03. Eng 2 and Eng 3 add their own deps.)

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": false,
    "types": ["node"]
  },
  "include": ["src"]
}
```

> Imports use `.js` extensions (`./rea/reaClient.js`) because of NodeNext. tsx resolves them to
> `.ts`. `@splice/contracts` resolves through its `exports` to the TS source.

## 2. `src/config.ts`

```ts
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const flag = z.enum(["0", "1"]).default("0").transform((v) => v === "1");
// "mock" is the Docker/compose/CI default across the repo; it means "no live calls" = replay.
const mode = <T extends string>(values: readonly [T, ...T[]], dflt: T) =>
  z.enum([...values, "mock"] as [string, ...string[]]).default(dflt)
    .transform((v) => (v === "mock" ? "replay" : v) as T);

const Env = z.object({
  PORT: z.coerce.number().default(3001),
  AWS_REGION: z.string().default("us-east-2"),           // Bedrock region; creds come from the AWS chain
  LLM_DEBUG: flag,
  REA_MODE: mode(["live", "replay", "auto"] as const, "auto"),
  LLM_MODE: mode(["live", "replay"] as const, "live"),
  REA_VERSION: z.string().default("6.7.0"),
  REA_CALL_TIMEOUT_MS: z.coerce.number().default(60_000),
  REA_RUN_BUDGET_MS: z.coerce.number().default(45_000),
  REA_MAX_RESPONSE_BYTES: z.coerce.number().default(2_000_000),
  REA_DEBUG: flag,
});

const env = Env.parse(process.env);

export const config = {
  port: env.PORT,
  awsRegion: env.AWS_REGION,
  llmDebug: env.LLM_DEBUG,
  reaMode: env.REA_MODE,
  llmMode: env.LLM_MODE,
  reaVersion: env.REA_VERSION,
  reaCallTimeoutMs: env.REA_CALL_TIMEOUT_MS,
  reaRunBudgetMs: env.REA_RUN_BUDGET_MS,
  reaMaxResponseBytes: env.REA_MAX_RESPONSE_BYTES,
  reaDebug: env.REA_DEBUG,
} as const;

if (config.llmMode === "live" && !process.env.AWS_PROFILE && !process.env.AWS_ACCESS_KEY_ID) {
  console.warn("[config] LLM_MODE=live but no AWS_PROFILE / AWS_ACCESS_KEY_ID set — relying on the default AWS credential chain (SSO, ~/.aws)");
}
```

## 3. `src/http/sse.ts`

```ts
import type { Request, Response } from "express";

export interface SseWriter {
  send(event: { type: string }): void;
  comment(text: string): void;
  close(): void;
  readonly signal: AbortSignal;   // aborts when the client disconnects
  readonly closed: boolean;
}

export function openSse(_req: Request, res: Response): SseWriter {
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const ac = new AbortController();
  let closed = false;
  const ping = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, 15_000);

  res.on("close", () => {
    closed = true;
    clearInterval(ping);
    ac.abort();
  });

  return {
    send(event) {
      if (closed) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    comment(text) {
      if (!closed) res.write(`: ${text.replace(/\n/g, " ")}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      res.end();
    },
    get signal() {
      return ac.signal;
    },
    get closed() {
      return closed;
    },
  };
}

export const newRunId = () => `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
```

Don't add `compression()` middleware. It buffers SSE.

## 4. Routes

### `src/routes/step1/index.ts` (Eng 1)

```ts
import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { Pantry, type HealthResponse } from "@splice/contracts";
import { config, REPO_ROOT } from "../../config.js";
import { rea } from "../../rea/reaClient.js";

export const step1Router = Router();

step1Router.get("/api/health", (_req, res) => {
  const body: HealthResponse = {
    ok: true,
    rea: { connected: rea.connected, version: rea.serverVersion, tool_count: rea.toolCount },
    rea_mode: config.reaMode,
    llm_mode: config.llmMode,
    model: getModel("spec_writer"),   // models.ts; the full table: resolvedModelTable()
  };
  res.json(body);
});

export async function loadPantry() {
  const raw = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "targets/manifest.json"), "utf8"));
  const pantry = Pantry.parse(raw);
  for (const app of pantry.apps) {
    const exists = await fs.access(path.join(REPO_ROOT, app.target_path)).then(() => true, () => false);
    if (!exists) app.live_supported = false;
  }
  return pantry;
}

step1Router.get("/api/pantry", async (_req, res, next) => {
  try {
    res.json(await loadPantry());
  } catch (e) {
    next(e);
  }
});
```

### `src/routes/step2/index.ts` and `src/routes/step3/index.ts` (stubs Eng 1 creates at H0)

```ts
import { Router } from "express";
export const step2Router = Router();   // Eng 2 owns this file from H0 on
```

```ts
import { Router } from "express";
export const step3Router = Router();   // Eng 3 owns this file from H0 on
```

## 5. `src/server.ts`

```ts
import express from "express";
import { config } from "./config.js";
import { rea } from "./rea/reaClient.js";
import { checkArgsAgainstCatalog } from "./rea/reaArgs.js";
import { step1Router } from "./routes/step1/index.js";
import { step2Router } from "./routes/step2/index.js";
import { step3Router } from "./routes/step3/index.js";

const app = express();
app.use(express.json({ limit: "10mb" }));   // blueprints + bundles can be large
app.use(step1Router);
app.use(step2Router);
app.use(step3Router);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  if (res.headersSent) return res.end();      // SSE already open: route should have sent an error event
  res.status(500).json({ error: (err as Error).message ?? String(err) });
});

app.listen(config.port, () => {
  console.log(`[splice] backend on http://localhost:${config.port}  REA_MODE=${config.reaMode} LLM_MODE=${config.llmMode} models=${JSON.stringify(resolvedModelTable())}`);
});

// Pre-warm REA so the first demo click isn't a cold start
if (config.reaMode !== "replay") {
  rea.start()
    .then(async () => {
      checkArgsAgainstCatalog(await rea.listTools() as any);
      await rea.call("binary_session", {});
      console.log(`[rea] ready: ${rea.toolCount} tools (server ${rea.serverVersion ?? "?"})`);
    })
    .catch((e) => console.warn(`[rea] pre-warm failed: ${e.message} — live extraction will fall back to replay in auto mode`));
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await rea.close().catch(() => {});
    process.exit(0);
  });
}
```

## 6. Pattern every streaming route follows (share with Eng 2 and Eng 3)

```ts
router.post("/api/something", async (req, res) => {
  const parsed = SomethingRequest.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  const sse = openSse(req, res);
  const run_id = newRunId();
  const transcript = createTranscript("extract", key);
  const emit = (e: PipelineEvent) => { sse.send(e); transcript.push(e); };

  let ok = false;
  try {
    // ... do work, pass sse.signal into every REA / Claude call ...
    ok = true;
  } catch (e) {
    if (!sse.signal.aborted) emit({ type: "error", run_id, feature_id, ts: Date.now(), message: (e as Error).message, fatal: true });
  } finally {
    emit({ type: "done", run_id, feature_id, ts: Date.now(), ok, replayed: false });
    await transcript.save(ok);
    sse.close();
  }
});
```
