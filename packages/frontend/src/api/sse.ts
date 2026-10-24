// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/06_state_and_api_client.md §1
import type { ZodType } from "zod";

/** Require done: a dropped connection must not look like a successful operation. */
export async function streamPost<E extends { type: string }>(
  url: string, body: unknown, onEvent: (e: E) => void,
  opts: { signal?: AbortSignal; schema: ZodType<E> },
): Promise<void> {
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body), signal: opts.signal,
  });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error(`${url}: expected an SSE response`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", frame: string[] = [], complete = false;
  const dispatch = () => {
    const data = frame.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    frame = [];
    if (!data) return;
    const event = opts.schema.parse(JSON.parse(data));
    onEvent(event);
    if (event.type === "done") complete = true;
  };
  try {
    while (!complete) {
      opts.signal?.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
        if (line === "") dispatch(); else frame.push(line);
        if (complete) break;
      }
      if (done) break;
    }
    opts.signal?.throwIfAborted();
    if (!complete) throw new Error(`${url}: stream ended before done`);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
