// Child process for crash recovery test. The parent kills this process after
// the marker appears, while SQLite still has an uncommitted transaction.
import fs from "node:fs";
import path from "node:path";
import { FsBlobStore } from "../../../runtime/src/host.ts";
import { openStateStore } from "./store.ts";
import { TranscriptionStore } from "./transcriptions.ts";

const [root, marker] = process.argv.slice(2);
const state = openStateStore(root);
const blobs = new FsBlobStore(path.join(root, "audio"));
const audio = await blobs.put(new Uint8Array([1, 2, 3, 4]), { contentType: "audio/L16" });
const sessions = new TranscriptionStore(state);
const session = sessions.create({ audio, sample_rate_hz: 16_000, language: null });
state.transaction(() => {
  state.dbHandle.prepare("UPDATE transcription_sessions SET status = 'running' WHERE session_id = ?")
    .run(session.session_id);
  fs.writeFileSync(marker, session.session_id);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
});
state.close();
