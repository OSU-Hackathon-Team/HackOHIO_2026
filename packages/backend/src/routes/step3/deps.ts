// Owner: Eng 3 (Implementation) — production wiring for Step 3.
// The ONLY Step 3 file that will import Eng 1/2 helpers. Until the sandbox lands, it
// exports null and the streaming routes answer 503 instead of pretending to work. To wire up:
//   import { structuredCall, continueWith } from "../../llm/llm.js";          (Eng 2, 02_llm_client.md §4)
//   import { runTests } from "../../sandbox/runTests.js";                      (Eng 2, 04_sandbox_runner.md §3)
//   import { openSse, newRunId } from "../../http/sse.js";                     (Eng 1, 06_backend_server_shell.md §3)
//   import { createTranscript } from "../../evidence/recorder.js";            (Eng 1, 05_record_and_replay.md §1)
//   import { replayTranscript } from "../../evidence/replay.js";              (Eng 1, 05_record_and_replay.md §2)
//   import { config } from "../../config.js";                                  (Eng 1, 06_backend_server_shell.md §2)
//   export const step3Deps: Step3Deps | null = {
//     llm: { structuredCall, continueWith }, sandbox: { runTests }, llmMode: () => config.llmMode,
//     openSse, newRunId, createTranscript, replayTranscript,
//   };
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import type { LlmPort, SandboxPort } from "../../engine/ports.js";

/** Mirrors SseWriter from http/sse.ts (the subset Step 3 uses). */
export interface SseWriterPort {
  send(event: { type: string }): void;
  close(): void;
  readonly signal: AbortSignal;
}

/** Mirrors Transcript from evidence/recorder.ts. */
export interface TranscriptPort {
  push(event: { type: string; ts: number }): void;
  save(ok: boolean): Promise<void>;
}

export type Step3TranscriptKind = "implement" | "synthesize";

export interface Step3Deps {
  llm: LlmPort;
  sandbox: SandboxPort;
  llmMode(): "live" | "replay";
  openSse(req: Request, res: Response): SseWriterPort;
  newRunId(): string;
  createTranscript(kind: Step3TranscriptKind, key: string): TranscriptPort;
  replayTranscript(kind: Step3TranscriptKind, key: string, sse: SseWriterPort, opts: { runId: string }): Promise<boolean>;
  /** UI skills the synthesis model may choose; omitted in tests that don't exercise selection. */
  skills?: SkillCatalog;
}

import { structuredCall, continueWith } from "../../llm/llm.js";
import { runTests } from "../../sandbox/runTests.js";
import { openSse as openSseReal, newRunId as newRunIdReal } from "../../http/sse.js";
import { createTranscript as createTranscriptReal } from "../../evidence/recorder.js";
import { replayTranscript as replayTranscriptReal } from "../../evidence/replay.js";
import { config } from "../../config.js";
import { loadSkillCatalog, type SkillCatalog } from "../../skills/skills.js";

// Kept for tests that verify 503 behavior when deps is explicitly passed as null
export const MISSING_UPSTREAM = [
  "sandbox/runTests.ts (Eng 2)",
];

export const step3Deps: Step3Deps = {
  llm: { structuredCall, continueWith },
  sandbox: { runTests },
  llmMode: () => config.llmMode,
  openSse: openSseReal,
  newRunId: newRunIdReal,
  createTranscript: createTranscriptReal,
  replayTranscript: (kind, key, sse, opts) => replayTranscriptReal(kind, key, sse as any, opts),
  skills: loadSkillCatalog(),
};

/** Same value as REPO_ROOT in config.ts: src|dist/routes/step3 → repo root. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
