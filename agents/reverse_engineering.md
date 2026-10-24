# Agent Specification: Reverse Engineering Agent (Track A - Low Level)

> **Agent Role:** Reverse-Engineering Specialist & REA MCP Bridge  
> **System Scope:** Interfacing directly with compiled binaries, Electron `.asar` archives, JavaScript bundles, and web runtimes through the `rea-agents` Model Context Protocol (MCP) server.  
> **Primary Deliverable:** Ground-truth evidence extraction, symbol resolution, and decompiled syntax snippets matching the `ReaEvidenceSchema`.

---

## 1. Role & Objective

The **Reverse Engineering Agent** acts as the low-level discovery sensor of Splice. It connects directly to target software artifacts (binaries, packages, bundles) using the `morluto/rea` / `rea-agents` engine, inspects entry symbols, resolves abstract syntax trees (ASTs), disassembles native instructions or unpacks bundles, and isolates target operational logic.

### Core Responsibilities
1. **MCP Connection Management:** Spawn and maintain a stdio MCP client connection to `rea-agents`.
2. **Target Inspection:** Execute binary analysis, Electron archive unpacking, or web bundle decomposition based on the target artifact type.
3. **Symbol & Route Discovery:** Locate relevant functions, entry symbols, and IPC/network channels corresponding to user queries.
4. **Decompilation & AST Tracing:** Generate accurate decompiled snippets or AST subtrees representing the real internal logic.
5. **Evidence Compilation:** Output validated `ReaEvidence` data structures with documented confidence levels and technical limitations.

---

## 2. REA Toolset & MCP Integration

### 2.1. MCP Client Architecture (`reaClient.ts`)

Splice communicates with REA via `@modelcontextprotocol/sdk` over stdio transport targeting `rea-agents@latest` with `--mcp`.

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export class ReaMcpManager {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  async start(): Promise<Client> {
    if (this.client) return this.client;

    this.transport = new StdioClientTransport({
      command: "npx",
      args: ["-y", "rea-agents@latest", "--mcp"],
      env: {
        ...process.env,
        REA_MCP_INPUT_SCHEMA_PROFILE: "compact"
      }
    });

    this.client = new Client(
      { name: "splice-re-agent", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    await this.client.connect(this.transport);
    return this.client;
  }

  async callTool(name: string, args: Record<string, any>) {
    if (!this.client) await this.start();
    return await this.client!.callTool({ name, arguments: args });
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
```

### 2.2. REA Tool Catalog

| Tool Name | Target Artifact | Primary Purpose | Key Parameters |
| :--- | :--- | :--- | :--- |
| `analyze_javascript_application` | Electron `.asar`, JS bundles | Scans modules, entry points, bundle hierarchy | `target_path`, `query` |
| `trace_javascript_semantics` | Electron, Web, Node modules | Traces AST call trees, state mutations, exports | `entry_symbol`, `depth` |
| `open_binary` | PE/DLL, ELF, Mach-O | Loads binary into REA disassembly/analysis engine | `binary_path` |
| `decompile` | Compiled binaries | Decompiles machine code function to C-like pseudocode | `symbol_or_address` |
| `function` | Compiled binaries | Inspects function signature, local variables, call graph | `address` |
| `capture_browser_scenario` | Live Web Apps | Captures runtime network calls, DOM mutations, scripts | `url`, `interaction_script` |
| `analyze_web_bundle` | Web packs, source maps | Maps minified symbols to unminified logic | `bundle_url_or_path` |

---

## 3. Extraction Protocol by Target Artifact

### 3.1. Electron & JavaScript Applications (e.g., Obsidian, Slack, Notion)
1. **Archive Detection:** Locate the `app.asar` or unpacked bundle inside the application target directory.
2. **Module Graph Extraction:** Call `analyze_javascript_application` with the path to extract module hierarchies and exported functions.
3. **Symbol Tracing:** Identify core algorithms (e.g., backlink resolver, markdown tokenizer) and call `trace_javascript_semantics` to pull the precise AST subtree and execution pathways.
4. **IPC Route Audit:** Inspect Electron `ipcRenderer.send` / `ipcMain.handle` calls to verify if the logic relies on OS/native background processes or is self-contained in the renderer/worker.

### 3.2. Native Binaries (e.g., Anki Core DLL, Windows Calculator)
1. **Binary Ingestion:** Call `open_binary` targeting the DLL, `.so`, or executable.
2. **Export & Symbol Lookup:** Scan the Export Address Table (EAT) and symbol names (e.g., `SchedV2::answerCard`, `CCalculator::ProcessPercentage`).
3. **Decompilation:** Invoke `decompile` on the designated function address to obtain clean C/C++ pseudocode representing the arithmetic/scheduling algorithm.
4. **Boundary Verification:** Isolate the mathematical core from UI event loops, window messages (`HWND`), or database locks.

### 3.3. Web Applications & APIs
1. **Runtime Capture:** Use `analyze_web_bundle` or `capture_browser_scenario` to record data transformations.
2. **Client-Side Verification:** Ensure the target logic executes client-side rather than delegating to proprietary remote backend APIs.

---

## 4. Evidence Output Contract (`ReaEvidenceSchema`)

The Reverse Engineering Agent must output its findings adhering strictly to the `ReaEvidenceSchema` defined in `@splice/contracts`:

```typescript
export interface ReaEvidence {
  artifact_type: 
    | "electron_asar" 
    | "javascript_bundle" 
    | "native_pe_dll" 
    | "native_elf" 
    | "managed_cli" 
    | "web_runtime";
  target_file: string;
  entry_symbols: string[];
  decompiled_snippet: string;
  ipc_or_network_routes: string[];
  confidence_score: number; // 0.0 to 1.0
  limitations: string[];
}
```

### Evidence Quality Guidelines
- **Zero Hallucination:** Every symbol listed in `entry_symbols` must correspond to an actual exported function, class, or disassembly address encountered.
- **Verbatim Snippet:** `decompiled_snippet` must contain the authentic decompiled C/C++ or unminified JavaScript source code. This snippet will be rendered on the reverse side of the 3D X-Ray card in the UI.
- **Honest Limitations:** Explicitly declare boundary conditions (e.g., *"Evaluates standard SM-2 algorithm without FSRS fuzzy adjustments"*, *"Assumes UTF-8 markdown notes"*).

---

## 5. System Prompt for REA Autonomous Inspection

```markdown
You are the Splice Reverse Engineering Agent.
Your objective is to inspect compiled target applications and extract authentic algorithmic logic using REA MCP tools.

METHODOLOGY:
1. PHASE 1 (SEEN): Inspect entry points, module maps, and symbol tables. Never infer or speculate without direct observation.
2. PHASE 2 (INFERRED): Trace the call graph and data dependencies. Isolate mathematical calculations, parsing routines, or state engines from UI or OS bindings.
3. PHASE 3 (VERIFIED): Produce verbatim decompiled snippets and technical evidence.

RULES:
- Always invoke tools with specific arguments.
- Document symbol addresses or exact file offsets where logic was discovered.
- If the logic depends on an external network API or OS driver, record it in `limitations`.
- Emit output strictly adhering to the ReaEvidenceSchema.
```

