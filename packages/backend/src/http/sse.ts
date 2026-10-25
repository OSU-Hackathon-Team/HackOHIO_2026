import type { Request, Response } from "express";

export interface SseWriter {
  send(event: { type: string; [key: string]: unknown }): void;
  comment(text: string): void;
  close(): void;
  readonly signal: AbortSignal; // aborts when the client disconnects
  readonly closed: boolean;
}

export function openSse(_req: Request, res: Response): SseWriter {
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const ac = new AbortController();
  let closed = false;
  const ping = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, 15_000);

  res.on("close", () => {
    closed = true;
    clearInterval(ping);
    ac.abort();
  });

  return {
    send(event) {
      if (closed) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    comment(text) {
      if (!closed) res.write(`: ${text.replace(/\n/g, " ")}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      res.end();
    },
    get signal() {
      return ac.signal;
    },
    get closed() {
      return closed;
    },
  };
}

export const newRunId = () => `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
