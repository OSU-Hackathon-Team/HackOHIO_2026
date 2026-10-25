// Tests for the SSE streaming utility
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { streamPost } from "../src/api/sse";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Schema for events used in these tests
const schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), message: z.string() }),
  z.object({ type: z.literal("done"), ok: z.boolean() })
]);

const encoder = new TextEncoder();
function response(text: string) {
  const bytes = encoder.encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      }
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

// Successful streaming with proper events
test("POST SSE accepts byte‑split UTF8, CRLF, comments, multiline data and done", async () => {
  globalThis.fetch = async (_url, options) => {
    assert.equal(options?.method, "POST");
    assert.equal((options?.headers as Record<string, string>).Accept, "text/event-stream");
    return response(': ping\r\r\n' +
      'data: {"type":"stage","message":"café"}\r\r\n' +
      'data: {"type":"done","ok":true}\n\n');
  };
  const events: unknown[] = [];
  await streamPost("/api/test", {}, e => events.push(e), { schema });
  assert.deepEqual(events, [{ type: "stage", message: "café" }, { type: "done", ok: true }]);
});

// HTTP error propagation
test("HTTP failures retain backend status and diagnostic", async () => {
  globalThis.fetch = async () => new Response("Missing sandbox helper", { status: 503 });
  await assert.rejects(streamPost("/api/test", {}, () => {}, { schema }), /503 Missing sandbox/);
});

// Malformed streams should reject
test("truncated streams and malformed events fail", async () => {
  for (const frame of [
    'data: {"type":"stage","message":"hi"}\n\n',
    'data: {"type":"done"}\n\n',
    'data: nope\n\n'
  ]) {
    globalThis.fetch = async () => response(frame);
    await assert.rejects(streamPost("/api/test", {}, () => {}, { schema }));
  }
});

// Abort handling
test("cancellation propagates and releases the reader", async () => {
  const controller = new AbortController();
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(c) { c.enqueue(encoder.encode('data: {"type":"stage","message":"hi"}\n\n')); },
        cancel() { cancelled = true; }
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    );
  await assert.rejects(
    streamPost("/api/test", {}, () => controller.abort(), { schema, signal: controller.signal }),
    { name: "AbortError" }
  );
  assert.equal(cancelled, true);
});

// Unknown event types should cause rejection
test("unknown event type is rejected", async () => {
  const unknown = 'data: {"type":"unknown", "foo":"bar"}\n\n';
  globalThis.fetch = async () => response(unknown);
  await assert.rejects(streamPost("/api/test", {}, () => {}, { schema }));
});
