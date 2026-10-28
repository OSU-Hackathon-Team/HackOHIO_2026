import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import express from "express";
import { REPO_ROOT } from "../config.js";
import { electronRunsRouter } from "./electronRuns.js";

describe("electron reconstruction client routes", () => {
  let directory: string;
  let server: Server;
  let base: string;

  before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "splice-electron-route-test-"));
    const script = path.join(directory, "pipeline.mjs");
    await fs.writeFile(script, `import fs from "node:fs/promises";
import path from "node:path";
const out = process.argv[3];
await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(out, "reconstruction-report.json"), JSON.stringify({ readiness: { ready: true, scoped: true, whole_app_ready: false } }));
process.stderr.write("scoped pipeline finished\\n");
`);
    const app = express();
    app.use(express.json());
    const renderer = path.join(directory, "failed-renderer.mjs");
    await fs.writeFile(renderer, 'process.stderr.write("renderer launch failed"); process.exit(1);');
    app.use(electronRunsRouter(directory, script, renderer));
    server = app.listen(0);
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("rejects invalid uploads and scopes, then exposes a completed run and report", async () => {
    const invalid = await fetch(`${base}/api/electron/archives`, { method: "POST",
      headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from("not an archive") });
    assert.equal(invalid.status, 400);

    const bytes = await fs.readFile(path.join(REPO_ROOT, "targets", "build", "recall", "app.asar"));
    const upload = await fetch(`${base}/api/electron/archives`, { method: "POST",
      headers: { "Content-Type": "application/octet-stream" }, body: bytes });
    assert.equal(upload.status, 201);
    const archive = await upload.json() as { archive_id: string };
    assert.match(archive.archive_id, /^[a-f0-9]{64}$/);
    const missingReplay = await fetch(`${base}/api/electron/archives/${archive.archive_id}/renderer-discovery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "Replay original observations", confirm_cost: true, replay_discovery_id: "renderer-00000000-0000-0000-0000-000000000000" }),
    });
    assert.equal(missingReplay.status, 422, "unbound or missing source traces cannot be replayed");
    const missingRecaptureSource = await fetch(`${base}/api/electron/archives/${archive.archive_id}/renderer-discovery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "Recapture original observations", confirm_cost: true, recapture: true }),
    });
    assert.equal(missingRecaptureSource.status, 400);
    const renderer = await fetch(`${base}/api/electron/archives/${archive.archive_id}/renderer-discovery`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ task: "Discover editing behavior", confirm_cost: true }),
    });
    const events = await renderer.text();
    assert.match(events, /renderer launch failed/);
    assert.match(events, /"ok":false/);
    assert.equal((await fetch(`${base}/api/electron/archives`)).status, 200, "renderer failure must leave the API available");
    const inventory = await fetch(`${base}/api/electron/archives/${archive.archive_id}/inventory`);
    assert.equal(inventory.status, 200);
    assert(Array.isArray((await inventory.json() as { channels: unknown[] }).channels));

    const invalidScope = await fetch(`${base}/api/electron/runs`, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archive_id: archive.archive_id, channels: [], scope_label: "empty" }) });
    assert.equal(invalidScope.status, 400);

    const started = await fetch(`${base}/api/electron/runs`, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archive_id: archive.archive_id, channels: ["settings"], scope_label: "settings" }) });
    assert.equal(started.status, 202);
    const id = (await started.json() as { run: { run_id: string } }).run.run_id;
    let run: { status: string; ready: boolean | null } | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      run = (await (await fetch(`${base}/api/electron/runs/${id}`)).json() as { run: typeof run }).run;
      if (run?.status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(run?.status, "completed");
    assert.equal(run.ready, true);
    const report = await (await fetch(`${base}/api/electron/runs/${id}/report`)).json() as { readiness: { scoped: boolean; whole_app_ready: boolean } };
    assert.equal(report.readiness.scoped, true);
    assert.equal(report.readiness.whole_app_ready, false);
    const log = await (await fetch(`${base}/api/electron/runs/${id}/log`)).json() as { text: string };
    assert.match(log.text, /scoped pipeline finished/);
  });
});
