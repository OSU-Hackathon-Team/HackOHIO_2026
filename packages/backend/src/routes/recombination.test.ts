import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { CompositionPlan, TranscriptionEvent, type CompositionValidateResponse, type JobRecord } from "@splice/contracts";
import { createRecombinationRouter } from "./recombination.js";
import { notebookPlan } from "../example/notebook.js";
import { JobManager } from "../recombination/jobs.js";
import type { RecombinationService } from "../recombination/service.js";
import { hashJson } from "../capabilities/identity.js";

const plan = CompositionPlan.parse(notebookPlan(new Map([
  ["splice.example.formula", `pkg_${"a".repeat(32)}`],
  ["splice.example.markdown", `pkg_${"b".repeat(32)}`],
  ["splice.example.transcription", `pkg_${"c".repeat(32)}`],
])));

function fakeService(overrides: Partial<RecombinationService> = {}): RecombinationService {
  const base: RecombinationService = {
    listCapabilities: async () => ({ packages: [], intakes: [] }),
    intake: async (request) => ({
      intake_id: `int_${"a".repeat(32)}`,
      accepted: true,
      definition_hash: request.definition.origin.artifact_hash,
      origin_artifact_hash: request.definition.origin.artifact_hash,
      blockers: [],
      readiness: {
        upstream_review: { status: "not_applicable", detail: "", at: null, evidence_hash: null },
        implementation_checks: { status: "not_run", detail: "", at: null, evidence_hash: null },
        independent_behavior_checks: { status: "not_run", detail: "", at: null, evidence_hash: null },
        composition_checks: { status: "not_run", detail: "", at: null, evidence_hash: null },
        packaging_checks: { status: "not_run", detail: "", at: null, evidence_hash: null },
      },
      received_at: new Date().toISOString(),
      definition: request.definition,
      public_tests: request.public_tests,
      implementation: request.implementation,
      review_attestation: null,
      independent_verdict: null,
    }),
    getPackage: async () => null,
    seedAuthored: async () => ({ packages: [], intakes: [] }),
    validatePlan: async () => ({
      ok: false,
      plan_hash: "b".repeat(64),
      errors: [{ code: "missing_package", path: "instances", message: "Unknown package", owner: "user", question: null }],
      warnings: [],
      checked_bindings: [],
      readiness: {
        upstream_review: { status: "not_applicable", detail: "", at: null, evidence_hash: null },
        implementation_checks: { status: "passed", detail: "", at: null, evidence_hash: null },
        independent_behavior_checks: { status: "not_run", detail: "", at: null, evidence_hash: null },
        composition_checks: { status: "failed", detail: "", at: null, evidence_hash: null },
        packaging_checks: { status: "not_run", detail: "", at: null, evidence_hash: null },
      },
    }),
    buildCapability: async (_intake, job) => {
      job.stage("build", "building", 50);
      return { package_id: `pkg_${"c".repeat(32)}` };
    },
    buildApp: async (_plan, job) => {
      job.stage("compile", "compiling", 50);
      return { app_id: `app_${"d".repeat(32)}`, revision: 0 };
    },
    listApps: async () => ({ apps: [] }),
    getApp: async () => null,
    listAppRevisions: async () => null,
    activateRevision: async () => { throw Object.assign(new Error("No revision"), { status: 404 }); },
    exportApp: async () => {
      throw Object.assign(new Error("No verified application"), { status: 404 });
    },
    previewApp: async () => ({
      ok: true,
      status: "succeeded",
      documents: {},
      step_results: {},
      unsupported: [],
      error: null,
    }),
    notebookPlan: async () => ({ plan }),
    transcriptionAvailability: async () => ({ configured: false, provider: null, detail: "not configured" }),
    transcribePcm: async function* () { yield { type: "done", final_segments: 0 }; },
    prepareTranscription: async () => { throw new Error("not configured"); },
    runTranscription: async () => { throw new Error("not configured"); },
    getTranscriptionSession: async () => null,
    reconcileTranscriptionSession: async () => { throw new Error("not configured"); },
  };
  return { ...base, ...overrides };
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("recombination routes", () => {
  let server: Server;
  let baseUrl = "";
  const jobs = new JobManager(null);
  let transcriptionConfigured = false;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(createRecombinationRouter(fakeService({
      transcriptionAvailability: async () => ({ configured: transcriptionConfigured, provider: transcriptionConfigured ? "aws_transcribe_streaming" : null, detail: "test provider" }),
      transcribePcm: async function* (input) {
        assert.equal(input.sampleRateHz, 16_000);
        assert.equal(input.pcm.length, 3_200);
        yield { type: "started", provider: "aws_transcribe_streaming", audio: { id: "a".repeat(64), size: 3_200 }, sample_rate_hz: 16_000 };
        yield { type: "segment", index: 0, start_ms: 0, end_ms: 100, text: "budget", final: true };
        yield { type: "done", final_segments: 1 };
      },
    }), jobs));
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects malformed capability intake before touching the service", async () => {
    const response = await fetch(`${baseUrl}/api/capabilities/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definition: {} }),
    });
    assert.equal(response.status, 400);
    assert.match((await json<{ error: string }>(response)).error, /Invalid capability intake/);
  });

  it("starts a capability build job and exposes its result", async () => {
    const response = await fetch(`${baseUrl}/api/capabilities/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intake_id: `int_${"a".repeat(32)}` }),
    });
    assert.equal(response.status, 202);
    const job = await json<JobRecord>(response);
    assert.equal(job.kind, "capability_build");
    await jobs.wait(job.job_id);
    const done = await json<JobRecord>(await fetch(`${baseUrl}/api/jobs/${job.job_id}`));
    assert.equal(done.status, "succeeded");
    assert.equal(done.result_ref, `package:pkg_${"c".repeat(32)}`);
  });

  it("returns a typed validation response for a plan", async () => {
    const response = await fetch(`${baseUrl}/api/compositions/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan }),
    });
    assert.equal(response.status, 200);
    const body = await json<CompositionValidateResponse>(response);
    assert.equal(body.ok, false);
    assert.equal(body.errors[0].code, "missing_package");
  });

  it("starts an application build job", async () => {
    const response = await fetch(`${baseUrl}/api/apps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan }),
    });
    assert.equal(response.status, 202);
    const job = await json<JobRecord>(response);
    await jobs.wait(job.job_id);
    assert.equal(jobs.get(job.job_id)!.result_ref, `app:app_${"d".repeat(32)}:0`);
  });

  it("maps missing resources to 404 and preserves service status codes", async () => {
    assert.equal((await fetch(`${baseUrl}/api/capabilities/pkg_${"c".repeat(32)}`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/apps/app_${"d".repeat(32)}/export`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/jobs/job_${"0".repeat(32)}`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/apps/app_${"d".repeat(32)}/revisions`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/apps/app_${"d".repeat(32)}/revisions/nope/activate`, { method: "POST" })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/apps/app_${"d".repeat(32)}/revisions/0/activate`, { method: "POST" })).status, 404);
  });

  it("streams job events to a late subscriber and closes on done", async () => {
    const started = await json<JobRecord>(await fetch(`${baseUrl}/api/capabilities/build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intake_id: `int_${"a".repeat(32)}` }),
      }));
    await jobs.wait(started.job_id);
    const response = await fetch(`${baseUrl}/api/jobs/${started.job_id}/events`, {
      headers: { accept: "text/event-stream" },
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: stage/);
    assert.match(text, /event: done/);
    assert.match(text, /event: result/);
  });

  it("cancels a running job", async () => {
    const manager = new JobManager(null);
    const app = express();
    app.use(express.json());
    app.use(
      createRecombinationRouter(
        fakeService({
          buildCapability: async (_intake, job) => {
            job.stage("waiting", "waiting", 10);
            await new Promise((resolve) => job.signal.addEventListener("abort", resolve));
            return { package_id: "pkg_never" };
          },
        }),
        manager,
      ),
    );
    const local = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => local.once("listening", () => resolve()));
    const address = local.address();
    const url = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
    const started = await json<JobRecord>(await fetch(`${url}/api/capabilities/build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intake_id: `int_${"a".repeat(32)}` }),
      }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelled = await json<JobRecord>(await fetch(`${url}/api/jobs/${started.job_id}/cancel`, { method: "POST" }));
    await manager.wait(started.job_id);
    assert.equal(cancelled.status, "running");
    assert.equal(manager.get(started.job_id)!.status, "cancelled");
    await new Promise<void>((resolve) => local.close(() => resolve()));
  });

  it("restarts a persisted build through the route service", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-route-job-"));
    const request = { intake_id: `int_${"a".repeat(32)}` };
    const first = new JobManager(root);
    const started = first.start("capability_build", hashJson(request), async () => {
      await new Promise(() => {});
      return { result_ref: "never" };
    }, { kind: "capability_build", request });
    const restarted = new JobManager(root);
    let called = 0;
    createRecombinationRouter(fakeService({
      buildCapability: async (intake, context) => {
        called++;
        assert.equal(intake, request.intake_id);
        context.stage("verify", "recovered", 90);
        return { package_id: `pkg_${"c".repeat(32)}` };
      },
    }), restarted);
    await restarted.wait(started.job_id);
    assert.equal(called, 1);
    assert.equal(restarted.get(started.job_id)?.result_ref, `package:pkg_${"c".repeat(32)}`);
  });

  it("reports optional transcription and streams a validated WAV as typed events", async () => {
    const unavailable = await json<{ configured: boolean }>(await fetch(`${baseUrl}/api/recombination/transcription`));
    assert.equal(unavailable.configured, false);
    const wav = Buffer.alloc(44 + 3_200);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(3_200, 40);
    const upload = (token?: string) => fetch(`${baseUrl}/api/recombination/transcription`, { method: "POST", headers: { "content-type": "audio/wav", ...(token ? { "X-Splice-Transcription-Token": token } : {}) }, body: wav });
    assert.equal((await upload()).status, 503);
    const previousToken = process.env.SPLICE_TRANSCRIPTION_ACCESS_TOKEN;
    const token = "t".repeat(40);
    process.env.SPLICE_TRANSCRIPTION_ACCESS_TOKEN = token;
    transcriptionConfigured = true;
    try {
      assert.equal((await upload("wrong-token")).status, 401);
      const malformed = await fetch(`${baseUrl}/api/recombination/transcription`, { method: "POST", headers: { "content-type": "audio/wav", "X-Splice-Transcription-Token": token }, body: Buffer.from("not a wave") });
      assert.equal(malformed.status, 400);
      const response = await upload(token);
      assert.equal(response.status, 200);
      const events = (await response.text()).split("\n\n").map((frame) => frame.split("\n").find((line) => line.startsWith("data: "))).filter(Boolean).map((line) => TranscriptionEvent.parse(JSON.parse(line!.slice(6))));
      assert.deepEqual(events.map((event) => event.type), ["started", "segment", "done"]);
      assert.equal(events[1].type === "segment" ? events[1].text : null, "budget");
    } finally {
      transcriptionConfigured = false;
      if (previousToken === undefined) delete process.env.SPLICE_TRANSCRIPTION_ACCESS_TOKEN;
      else process.env.SPLICE_TRANSCRIPTION_ACCESS_TOKEN = previousToken;
    }
  });
});
