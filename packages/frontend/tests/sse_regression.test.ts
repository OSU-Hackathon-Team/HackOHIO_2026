// Regression tests for SSE streaming edge cases
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { streamPost } from "../src/api/sse";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), message: z.string() }),
  z.object({ type: z.literal("done"), ok: z.boolean() })
]);

const encoder = new TextEncoder();
function response(stream: ReadableStream) {
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

// Helper to create a ReadableStream that yields given chunks (Uint8Array[])
function chunkedResponse(chunks: Uint8Array[]) {
  return response(new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    }
  }));
}

// Test: chunk boundaries – a line split across two reads
test("chunk boundaries are handled correctly", async () => {
  const part1 = encoder.encode("data: {\"type\":\"stage\",\"message\":\"he");
  const part2 = encoder.encode("llo\"}\n\ndata: {\"type\":\"done\",\"ok\":true}\n\n");
  globalThis.fetch = async () => chunkedResponse([part1, part2]);
  const events: unknown[] = [];
  await streamPost("/api/test", {}, (e) => events.push(e), { schema });
  assert.deepEqual(events, [{ type: "stage", message: "hello" }, { type: "done", ok: true }]);
});

// Test: CRLF line endings are normalized
test("CRLF line endings are accepted", async () => {
  const payload = ': ping\r\n' +
    'data: {"type":"stage","message":"crlf"}\r\n\r\n' +
    'data: {"type":"done","ok":true}\r\n\r\n';
  globalThis.fetch = async () => response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(payload)); controller.close(); }
  }));
  const events: unknown[] = [];
  await streamPost("/api/test", {}, (e) => events.push(e), { schema });
  assert.deepEqual(events, [{ type: "stage", message: "crlf" }, { type: "done", ok: true }]);
});

// Test: incomplete final event without trailing empty line
test("incomplete final event is still processed", async () => {
  const payload = 'data: {"type":"stage","message":"no-trailer"}\n\n' +
    'data: {"type":"done","ok":true}'; // missing final blank line
  globalThis.fetch = async () => response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(payload)); controller.close(); }
  }));
  const events: unknown[] = [];
  await streamPost("/api/test", {}, (e) => events.push(e), { schema });
  assert.deepEqual(events, [{ type: "stage", message: "no-trailer" }, { type: "done", ok: true }]);
});
