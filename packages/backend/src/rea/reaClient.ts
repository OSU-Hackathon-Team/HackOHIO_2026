import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "child_process";

// Owner: Eng 1 (REA) — spec: agents/1_reverse_engineering/03_mcp_bridge.md §2
// Interim client: launch command fixed (verified live against rea-agents 6.7.0). Replace with the
// spec's ReaBridge (serialized calls, timeouts, normalize()) when implementing Step 1.
const REA_VERSION = process.env.REA_VERSION ?? "6.7.0";

export class ReaMcpManager {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  /**
   * Resolves the REA launch command. The MCP server is the `mcp` SUBCOMMAND (not `--mcp`).
   * Prefers a globally installed `rea-agents` (Docker image), else a pinned npx; Windows needs cmd.exe for npx.
   */
  private resolveReaCommand(): { command: string; args: string[] } {
    try {
      execSync(process.platform === "win32" ? "where rea-agents" : "which rea-agents", { stdio: "ignore" });
      return process.platform === "win32"
        ? { command: "cmd.exe", args: ["/d", "/c", "rea-agents", "mcp"] }
        : { command: "rea-agents", args: ["mcp"] };
    } catch {
      const npx = ["-y", `rea-agents@${REA_VERSION}`, "mcp"];
      return process.platform === "win32"
        ? { command: "cmd.exe", args: ["/d", "/c", "npx", ...npx] }
        : { command: "npx", args: npx };
    }
  }

  async start(): Promise<Client> {
    if (this.client) return this.client;

    const { command, args } = this.resolveReaCommand();
    console.log(`[REA MCP] Launching REA engine using: ${command} ${args.join(" ")}`);

    this.transport = new StdioClientTransport({
      command,
      args,
      env: {
        ...process.env,
        REA_MCP_INPUT_SCHEMA_PROFILE: "compact"
      }
    });

    this.client = new Client(
      { name: "splice-orchestrator", version: "1.0.0" },
      { capabilities: {} }
    );

    await this.client.connect(this.transport);
    console.log("[REA MCP] Connected successfully to rea-agents stdio!");
    return this.client;
  }

  async callTool(name: string, args: Record<string, any>) {
    if (!this.client) await this.start();
    const result = await this.client!.callTool({ name, arguments: args });
    return result;
  }

  async close() {
    if (this.transport) {
      await this.transport.close();
      this.client = null;
      this.transport = null;
    }
  }
}

export const reaMcp = new ReaMcpManager();
