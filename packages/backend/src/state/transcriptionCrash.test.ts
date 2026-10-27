import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FsBlobStore } from "@splice/runtime";
import { checkSqliteIntegrity, openStateStore } from "./store.js";
import { TranscriptionStore } from "./transcriptions.js";

test("a hard process kill rolls back a transcription update and retains its saved audio", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-transcription-crash-"));
  const marker = path.join(root, "transaction-open");
  const worker = fileURLToPath(new URL("./transcriptionCrashWorker.mjs", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", worker, root, marker], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  try {
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(marker), true, `worker did not open transaction: ${stderr}`);
    const sessionId = fs.readFileSync(marker, "utf8");
    assert.match(sessionId, /^tr_[a-f0-9]{32}$/);
    child.kill("SIGKILL");
    const result = await exited;
    assert.equal(result.signal, "SIGKILL");

    const state = openStateStore(root);
    try {
      assert.equal(checkSqliteIntegrity(path.join(root, "state.db")).ok, true);
      const session = new TranscriptionStore(state).get(sessionId);
      assert.ok(session);
      assert.equal(session.status, "queued", "the interrupted update must not commit");
      const blobs = new FsBlobStore(path.join(root, "audio"));
      assert.deepEqual(await blobs.get(session.audio), new Uint8Array([1, 2, 3, 4]));
    } finally {
      state.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
