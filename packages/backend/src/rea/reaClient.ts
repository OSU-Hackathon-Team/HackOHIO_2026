import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { config, REPO_ROOT } from "../config.js";
import { normalize, type NormalizedResult } from "./normalize.js";

/** Prefer the pinned local install (fast, offline). Fall back to npx. */
export function resolveLaunch(): { command: string; args: string[] } {
  const candidates: string[] = [];
  try {
    const require = createRequire(import.meta.url);
    candidates.push(path.join(path.dirname(require.resolve("rea-agents/package.json")), "scripts/rea.mjs"));
  } catch {
    // package "exports" may hide package.json — fall through to path probing
  }
  candidates.push(
    path.join(REPO_ROOT, "node_modules/rea-agents/scripts/rea.mjs"),
    path.join(REPO_ROOT, "packages/backend/node_modules/rea-agents/scripts/rea.mjs"),
  );
  const entry = candidates.find((p) => fs.existsSync(p));
  if (entry) return { command: process.execPath, args: [entry, "mcp"] };

  const npx = ["-y", `rea-agents@${config.reaVersion}`, "mcp"];
  return process.platform === "win32"
    ? { command: "cmd.exe", args: ["/d", "/c", "npx", ...npx] }
    : { command: "npx", args: npx };
}

export class ReaUnavailableError extends Error {}

export class ReaBridge {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private starting: Promise<Client> | null = null;
  private tools: Tool[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  serverVersion: string | null = null;

  get connected() {
    return this.client !== null;
  }
  get toolCount() {
    return this.tools.length;
  }

  async start(): Promise<Client> {
    if (this.client) return this.client;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const { command, args } = resolveLaunch();
      const transport = new StdioClientTransport({
        command,
        args,
        cwd: REPO_ROOT,
        stderr: "pipe",
        env: {
          ...getDefaultEnvironment(),
          REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
          REA_MCP_MAX_RESPONSE_BYTES: String(config.reaMaxResponseBytes),
        },
      });
      transport.stderr?.on("data", (d) => {
        if (config.reaDebug) process.stderr.write(`[rea] ${d}`);
      });
      transport.onclose = () => {
        // Connection gone → retained evidence IDs are gone too. Next call restarts.
        this.client = null;
        this.transport = null;
        this.tools = [];
      };
      const client = new Client({ name: "splice", version: "0.1.0" }, { capabilities: {} });
      try {
        await client.connect(transport);
      } catch (e) {
        throw new ReaUnavailableError(`Could not start REA (${command} ${args.join(" ")}): ${(e as Error).message}`);
      }
      this.serverVersion = client.getServerVersion()?.version ?? null;
      this.tools = (await client.listTools()).tools;
      this.client = client;
      this.transport = transport;
      return client;
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async listTools(): Promise<Tool[]> {
    await this.start();
    return this.tools;
  }

  hasTool(name: string) {
    return this.tools.some((t) => t.name === name);
  }

  /** Serialize calls: REA sessions are stateful (active target), so one call at a time. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async callRaw(
    name: string,
    args: Record<string, unknown>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<CallToolResult> {
    return this.enqueue(async () => {
      const client = await this.start();
      return (await client.callTool({ name, arguments: args }, undefined, {
        timeout: opts.timeoutMs ?? config.reaCallTimeoutMs,
        signal: opts.signal,
      })) as CallToolResult;
    });
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<NormalizedResult> {
    return normalize(name, await this.callRaw(name, args, opts));
  }

  async close() {
    await this.transport?.close();
    this.client = null;
    this.transport = null;
  }
}

export const rea = new ReaBridge();
// Backward compatibility for any early imports
export const reaMcp = rea;
