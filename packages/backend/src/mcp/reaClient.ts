import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "child_process";

export class ReaMcpManager {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  /**
   * Resolves the REA execution binary.
   * Prioritizes globally installed `rea-agents` (from Docker `npm install -g rea-agents`)
   * to ensure 100% offline hackathon execution without registry checks, falling back to `npx`.
   */
  private resolveReaCommand(): { command: string; args: string[] } {
    try {
      execSync("which rea-agents || where rea-agents", { stdio: "ignore" });
      return {
        command: "rea-agents",
        args: ["--mcp"]
      };
    } catch {
      return {
        command: "npx",
        args: ["-y", "rea-agents@latest", "--mcp"]
      };
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
      { capabilities: { tools: {} } }
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
