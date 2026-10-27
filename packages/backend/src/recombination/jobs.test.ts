import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobManager } from "./jobs.js";
import { hashJson } from "../capabilities/identity.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "splice-jobs-"));
}

describe("durable job manager", () => {
  it("records stages, result and completion", async () => {
    const job = await new JobManager(tempDir()).runNow("capability_build", "a".repeat(64), async (ctx) => {
      ctx.stage("compile", "compiling", 40, "source-written");
      ctx.log("done");
      return { result_ref: "pkg_test" };
    });
    assert.equal(job.status, "succeeded");
    assert.equal(job.result_ref, "pkg_test");
    assert.equal(job.progress.stage, "complete");
  });

  it("records a failure without a result", async () => {
    const manager = new JobManager(tempDir());
    const job = await manager.runNow("application_build", "b".repeat(64), async () => {
      throw new Error("plan rejected");
    });
    assert.equal(job.status, "failed");
    assert.match(job.error!, /plan rejected/);
    assert.equal(job.result_ref, null);
  });

  it("cancels a running job and aborts its work", async () => {
    const manager = new JobManager(tempDir());
    let aborted = false;
    const job = manager.start("export", "c".repeat(64), async (ctx) => {
      ctx.stage("waiting", "waiting", 10);
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      });
      return { result_ref: "never" };
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    manager.cancel(job.job_id);
    await manager.wait(job.job_id);
    assert.equal(aborted, true);
    assert.equal(manager.get(job.job_id)!.status, "cancelled");
  });

  it("persists events and marks interrupted jobs on restart", async () => {
    const root = tempDir();
    const first = new JobManager(root);
    await first.runNow("capability_build", "d".repeat(64), async (ctx) => {
      ctx.stage("verify", "verified", 90);
      return { result_ref: "pkg_ok" };
    });
    const second = new JobManager(root);
    const loaded = second.list();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].status, "succeeded");

    const running = second.start("application_build", "e".repeat(64), async () => {
      await new Promise(() => {});
      return { result_ref: "never" };
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const third = new JobManager(root);
    const recovered = third.get(running.job_id)!;
    assert.equal(recovered.status, "failed");
    assert.match(recovered.error!, /restart/);
    assert.ok(third.events(running.job_id).some((event) => event.type === "error"));
  });

  it("replays a saved build request under its original job id and keeps prior events", async () => {
    const root = tempDir();
    const request = { intake_id: `int_${"a".repeat(32)}` };
    const first = new JobManager(root);
    const started = first.start("capability_build", hashJson(request), async (ctx) => {
      ctx.stage("compile", "first attempt", 40, "source-written");
      await new Promise(() => {});
      return { result_ref: "never" };
    }, { kind: "capability_build", request });
    assert.equal("resume_request" in started, false);
    const jobFile = path.join(root, "jobs", `${started.job_id}.json`);
    assert.equal(fs.statSync(jobFile).mode & 0o777, 0o600);

    const restarted = new JobManager(root);
    assert.equal(restarted.get(started.job_id)?.status, "queued");
    assert.equal(restarted.get(started.job_id)?.progress.checkpoint, "source-written");
    assert.ok(restarted.events(started.job_id).some((event) => event.type === "stage" && event.stage === "resume_pending"));
    const resumed = restarted.resumePending(async (saved, job, ctx) => {
      assert.equal(saved.kind, "capability_build");
      assert.equal(job.job_id, started.job_id);
      ctx.stage("verify", "replayed", 90);
      return { result_ref: "package:pkg_ok" };
    });
    assert.equal(resumed.length, 1);
    assert.equal(restarted.resumePending(async () => ({ result_ref: "duplicate" })).length, 0);
    await restarted.wait(started.job_id);
    assert.equal(restarted.get(started.job_id)?.status, "succeeded");
    assert.equal(restarted.get(started.job_id)?.result_ref, "package:pkg_ok");
    assert.ok(restarted.events(started.job_id).some((event) => event.type === "stage" && event.message === "first attempt"));
    assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).resume_request, null);
  });

  it("rejects an altered saved request on recovery", () => {
    const root = tempDir();
    const request = { intake_id: `int_${"a".repeat(32)}` };
    const first = new JobManager(root);
    const started = first.start("capability_build", hashJson(request), async () => {
      await new Promise(() => {});
      return { result_ref: "never" };
    }, { kind: "capability_build", request });
    const jobFile = path.join(root, "jobs", `${started.job_id}.json`);
    const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    stored.resume_request.request.intake_id = `int_${"b".repeat(32)}`;
    fs.writeFileSync(jobFile, JSON.stringify(stored));
    const restarted = new JobManager(root);
    assert.equal(restarted.get(started.job_id)?.status, "failed");
    assert.equal(restarted.resumePending(async () => ({ result_ref: "never" })).length, 0);
  });

  it("streams only to subscribers of the matching job", async () => {
    const manager = new JobManager(null);
    const events: string[] = [];
    const job = manager.start("capability_build", "f".repeat(64), async (ctx) => {
      ctx.stage("compile", "compiling", 50);
      return { result_ref: "pkg_x" };
    });
    const unsubscribe = manager.subscribe(job.job_id, (event) => events.push(event.type));
    await manager.wait(job.job_id);
    unsubscribe();
    assert.ok(events.includes("stage"));
    assert.ok(events.includes("result"));
    assert.ok(events.includes("done"));
  });
});
