process.env.NODE_ENV = "test";
process.env.REA_MODE = "replay";

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { PipelineEvent, FeatureSpec, type ClaudeClient } from "@splice/contracts";
import { app } from "../dist/server.js";
import { setClaudeClientForTests, setConverseClientForTests, type ConverseClient } from "../dist/llm/llm.js";
import { staticChecks, computeCoverage, testNames, repairFeedback } from "../dist/spec/staticChecks.js";
import { buildSpec } from "../dist/spec/buildSpec.js";
import { loadRecordedEvidence } from "../dist/evidence/replay.js";
import { loadPantry } from "../dist/routes/step1/index.js";
import { listSpecs } from "../dist/spec/store.js";

async function collectSseEvents(res: globalThis.Response): Promise<PipelineEvent[]> {
  const text = await res.text();
  const frames = text.split("\n\n");
  const events: PipelineEvent[] = [];
  for (const frame of frames) {
    const lines = frame.split("\n").filter((l) => l.trim().length > 0);
    const dataLine = lines.find((l) => l.startsWith("data:"));
    if (dataLine) {
      const json = JSON.parse(dataLine.slice(5).trim());
      events.push(PipelineEvent.parse(json));
    }
  }
  return events;
}

describe("Step 2: End-to-End Extraction Pipeline Suite", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (typeof addr === "object" && addr !== null) {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  afterEach(() => {
    setClaudeClientForTests(null);
    setConverseClientForTests(null);
  });

  describe("GET /api/specs", () => {
    it("returns an array of valid FeatureSpecs from store", async () => {
      const res = await fetch(`${baseUrl}/api/specs`);
      assert.equal(res.status, 200);
      const specs = (await res.json()) as unknown[];
      assert.ok(Array.isArray(specs));
      assert.ok(specs.length >= 1, "Expected at least 1 spec (hand-authored or seed)");
      for (const s of specs) {
        const parsed = FeatureSpec.parse(s);
        assert.ok(parsed.feature_id);
        assert.equal(parsed.schema_version, 1);
        assert.equal(parsed.provenance.mode, "replay");
      }
    });

    it("store.listSpecs aggregates specs with deduplication", async () => {
      const specs = await listSpecs();
      const ids = specs.map((s) => s.feature_id);
      const unique = new Set(ids);
      assert.equal(ids.length, unique.size, "feature_ids must be unique in listSpecs()");
    });
  });

  describe("POST /api/extract Request Validation", () => {
    it("returns 400 when app_id or feature_id are missing", async () => {
      const res = await fetch(`${baseUrl}/api/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: "recall" }), // missing feature_id
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.ok(body.error);
    });

    it("returns 404 when app_id is unknown", async () => {
      const res = await fetch(`${baseUrl}/api/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: "nonexistent_app", feature_id: "recall.sm2_scheduler" }),
      });
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /unknown/);
    });

    it("returns 404 when feature_id does not belong to app", async () => {
      const res = await fetch(`${baseUrl}/api/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: "recall", feature_id: "inkwell.wikilink_graph" }),
      });
      assert.equal(res.status, 404);
    });
  });

  describe("POST /api/extract SSE Streaming (Replay Mode)", () => {
    it("streams a valid PipelineEvent sequence for recall.sm2_scheduler", async () => {
      const res = await fetch(`${baseUrl}/api/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          app_id: "recall",
          feature_id: "recall.sm2_scheduler",
          force_mode: "replay",
        }),
      });

      assert.equal(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));
      assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");

      const events = await collectSseEvents(res);
      assert.ok(events.length > 0, "Expected streamed events");

      // Verify terminal event
      const doneEvent = events.find((e) => e.type === "done");
      assert.ok(doneEvent, "Expected done event");
      assert.equal(doneEvent.type, "done");
      if (doneEvent.type === "done") {
        assert.equal(doneEvent.ok, true);
        assert.equal(doneEvent.replayed, true);
      }

      // Verify spec event
      const specEvent = events.find((e) => e.type === "spec");
      assert.ok(specEvent, "Expected spec event in replay stream");
      if (specEvent?.type === "spec") {
        assert.equal(specEvent.spec.feature_id, "recall.sm2_scheduler");
        assert.equal(specEvent.spec.provenance.mode, "replay");
        assert.ok(specEvent.spec.requirements.length >= 1);
      }
    });

    it("streams a valid PipelineEvent sequence for inkwell.wikilink_graph", async () => {
      const res = await fetch(`${baseUrl}/api/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          app_id: "inkwell",
          feature_id: "inkwell.wikilink_graph",
          force_mode: "replay",
        }),
      });

      assert.equal(res.status, 200);
      const events = await collectSseEvents(res);
      const doneEvent = events.find((e) => e.type === "done");
      assert.ok(doneEvent);
      if (doneEvent?.type === "done") {
        assert.equal(doneEvent.ok, true);
      }
    });
  });

  describe("POST /api/extract with Mocked Bedrock Client (Live Pipeline Flow)", () => {
    it("connects recorded evidence to buildSpec and emits verified FeatureSpec", async () => {
      const mockDraft = {
        consumer_title: "Recall SM-2 Scheduler",
        consumer_description: "Calculates review intervals and ease factors for spaced repetition.",
        requirements: [
          {
            id: "REQ-1",
            kind: "behavior",
            statement: "Review grade 5 updates ease factor.",
            source_refs: ["src/scheduler/sm2.js:L1-L15"],
          },
        ],
        module_name: "sm2Scheduler",
        exports: [
          {
            name: "updateCard",
            kind: "function",
            signature: "(ease: number, grade: number) => number",
            description: "Updates ease factor based on performance grade",
          },
        ],
        types_code: "export declare function updateCard(ease: number, grade: number): number;\n",
        inputs: [
          { name: "ease", type: "number", description: "Previous ease factor" },
          { name: "grade", type: "number", description: "Quality grade" },
        ],
        outputs: [{ name: "nextEase", type: "number", description: "Updated ease factor" }],
        acceptance_tests: `
          test("REQ-1: test updateCard with grade 5", () => {
            assert.equal(updateCard(2.5, 5), 2.6);
          });
        `,
        adapter_code: `
          const sm2 = original("src/scheduler/sm2.js");
          module.exports = {
            updateCard: (ease, grade) => sm2.updateEase(ease, grade),
          };
        `,
        allowed_deviations: ["Exposes functional interface without internal Card class"],
        stripped_glue: ["ipcMain.handle('card:review')"],
      };

      const fakeClient: ClaudeClient = {
        messages: {
          stream(params: any) {
            const text = JSON.stringify(mockDraft);
            const msg = {
              id: "msg_extract_mock",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text, citations: null }],
              model: params.model,
              stop_reason: "end_turn",
              usage: { input_tokens: 150, output_tokens: text.length },
            };
            return {
              on: () => {},
              async finalMessage() {
                return msg;
              },
            } as any;
          },
        } as any,
      };
      setClaudeClientForTests(fakeClient);

      const fakeConverseClient: ConverseClient = {
        async send(command: any) {
          async function* stream() {
            yield { contentBlockDelta: { delta: { toolUse: { input: JSON.stringify(mockDraft) } } } };
            yield { messageStop: { stopReason: "tool_use" } };
            yield { metadata: { usage: { inputTokens: 150, outputTokens: JSON.stringify(mockDraft).length } } };
          }
          return { stream: stream() } as any;
        },
      };
      setConverseClientForTests(fakeConverseClient);

      const res = await fetch(`${baseUrl}/api/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          app_id: "recall",
          feature_id: "recall.sm2_scheduler",
          force_mode: "live",
        }),
      });

      assert.equal(res.status, 200);
      const events = await collectSseEvents(res);

      // Verify stages were emitted
      const stages = events.filter((e) => e.type === "stage").map((e: any) => e.stage);
      assert.ok(stages.includes("queued"));
      assert.ok(stages.includes("specifying"));
      assert.ok(stages.includes("checking_oracle"));
      assert.ok(stages.includes("complete"));

      // Verify oracle test result was streamed
      const testResults = events.filter((e) => e.type === "test_result");
      assert.ok(testResults.length >= 1);
      assert.equal((testResults[0] as any).passed, true);

      // Verify spec event
      const specEvent = events.find((e) => e.type === "spec");
      assert.ok(specEvent);
      if (specEvent?.type === "spec") {
        assert.equal(specEvent.spec.feature_id, "recall.sm2_scheduler");
        assert.equal(specEvent.spec.status, "verified");
        assert.equal(specEvent.spec.oracle.status, "passed");
      }

      // Verify done event
      const doneEvent = events.find((e) => e.type === "done");
      assert.ok(doneEvent);
      if (doneEvent?.type === "done") {
        assert.equal(doneEvent.ok, true);
      }
    });
  });

  describe("Static Checks and Coverage Logic", () => {
    it("computes requirement coverage correctly from test names", () => {
      const draft = {
        requirements: [{ id: "REQ-1" }, { id: "REQ-2" }, { id: "REQ-3" }],
        acceptance_tests: `
          test("REQ-1: test first requirement", () => {});
          test("REQ-1 REQ-2: test combined", () => {});
        `,
      } as any;

      const coverage = computeCoverage(draft);
      assert.equal(coverage[0].requirement_id, "REQ-1");
      assert.equal(coverage[0].test_names.length, 2);
      assert.equal(coverage[1].requirement_id, "REQ-2");
      assert.equal(coverage[1].test_names.length, 1);
      assert.equal(coverage[2].requirement_id, "REQ-3");
      assert.equal(coverage[2].test_names.length, 0);
    });

    it("staticChecks flags gaps, non-determinism, and bad line numbers", async () => {
      const badDraft = {
        requirements: [
          { id: "REQ-1", source_refs: ["src/sm2.js:L1-L10"] },
          { id: "REQ-3", source_refs: ["src/sm2.js:L500-L600"] }, // gap: missing REQ-2, out-of-range line
        ],
        exports: [{ name: "fn1", kind: "function" }],
        types_code: "export function fn1(): void {}\n", // illegal implementation instead of declare
        acceptance_tests: `
          test("REQ-1: non-deterministic test", () => {
            const now = Date.now();
          });
        `,
        adapter_code: "module.exports = {};", // missing original() call
      } as any;

      const mockEvidence = {
        snippets: [{ location: "app.asar:src/sm2.js", code: "line1\nline2\nline3\n" }],
      } as any;

      const problems = await staticChecks(badDraft, mockEvidence);
      assert.ok(problems.some((p) => /ids must be REQ-1..REQ-2 in order/.test(p)));
      assert.ok(problems.some((p) => /lines L500-L600 are outside/.test(p)));
      assert.ok(problems.some((p) => /Date\.now/.test(p)));
      assert.ok(problems.some((p) => /export declare function/.test(p)));
      assert.ok(problems.some((p) => /adapter_code never calls original/.test(p)));
    });

    it("repairFeedback formats structured numbered problem list", () => {
      const feedback = repairFeedback(["Test failed", "Missing REQ-2"]);
      assert.match(feedback, /1\. Test failed/);
      assert.match(feedback, /2\. Missing REQ-2/);
      assert.match(feedback, /The ORIGINAL code is the ground truth/);
    });
  });

  describe("Request Cancellation / Abort", () => {
    it("terminates pipeline cleanly when client disconnects mid-request", async () => {
      const controller = new AbortController();
      const promise = fetch(`${baseUrl}/api/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          app_id: "recall",
          feature_id: "recall.sm2_scheduler",
          force_mode: "replay",
        }),
        signal: controller.signal,
      });

      // Abort immediately
      controller.abort();
      await assert.rejects(promise, (err: any) => err.name === "AbortError");
    });
  });
});
