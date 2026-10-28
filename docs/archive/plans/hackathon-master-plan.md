# Project Blueprint: "Splice" (Lovable + Reverse Engineer Anything)
### Complete Implementation Architecture & 3-Engineer Parallel Execution Plan

> **One-Line Pitch:** Lovable builds apps from scratch using prompts; **Splice** builds hyper-specialized software by harvesting proven features and business logic directly from existing desktop, mobile, and web applications via autonomous reverse-engineering agents.

---

## 1. The Core Thesis ("The Great Unbundling")

Modern SaaS and desktop software are bloated because they try to serve every use case at once. A freelance video editor, a medical student, or a local tournament organizer doesn't need 100% of Notion, Jira, and Anki—they need **10% of each**, unified into a single purpose-built workflow.

* **The Problem:** `Reverse Engineer Anything (REA)` (`morluto/rea`, npm `rea-agents`) is an extraordinary open-source MCP server and reverse-engineering pipeline capable of extracting logic from compiled binaries (PE/ELF/Mach-O), Electron bundles, and live web apps. However, it is currently locked behind CLI commands and deep technical reverse-engineering knowledge.
* **Our Solution ("Splice"):** We place an autonomous **Agentic Orchestrator** and a **Lovable-style consumer studio** on top of `rea-agents`. Non-technical domain experts select existing applications as "ingredients", prompt what niche tool they need, watch autonomous agents extract the exact mechanics into visual **Feature Cards**, and fuse them into a specialized, live-running micro-app inside an embedded sandbox.

---

## 2. Monorepo Directory Structure & Git Boundaries

To ensure **3 engineers can work simultaneously without merge conflicts**, the project is organized into strictly isolated packages with a shared contract layer.

```
/REA (Repository Root)
├── hackathon_master_plan_rea_lovable.md   # This master blueprint
├── package.json                          # Root workspace configuration (npm / pnpm)
├── packages/
│   ├── contracts/                        # STEP 0: Shared TypeScript types & Zod schemas
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── blueprint.ts              # FeatureBlueprint schema & types
│   │   │   ├── api.ts                    # Request/Response schemas for SSE & Synthesis
│   │   │   └── index.ts
│   │   └── tsconfig.json
│   │
│   ├── backend/                          # TRACK A (Worker 1) & TRACK B (Worker 2)
│   │   ├── package.json
│   │   ├── .env.example                  # ANTHROPIC_API_KEY, REA_MODE, etc.
│   │   ├── src/
│   │   │   ├── mcp/
│   │   │   │   ├── reaClient.ts          # Worker 1: Stdio MCP client wrapping rea-agents
│   │   │   │   └── reaTools.ts           # Worker 1: Tool definitions and caller wrappers
│   │   │   ├── harvester/
│   │   │   │   ├── harvesterAgent.ts     # Worker 1: Autonomous "Seen->Inferred->Verified" loop
│   │   │   │   └── cacheManager.ts       # Worker 1: Cache replay system for demo safety
│   │   │   ├── synthesis/
│   │   │   │   ├── synthesizerAgent.ts   # Worker 2: Multi-blueprint fusion prompt & glue gen
│   │   │   │   └── refinerAgent.ts       # Worker 2: Iterative specialization chat loop
│   │   │   ├── routes/
│   │   │   │   ├── extract.ts            # Worker 1: POST /api/extract (SSE progress stream)
│   │   │   │   ├── synthesize.ts         # Worker 2: POST /api/synthesize (Sandpack bundle)
│   │   │   │   └── refine.ts             # Worker 2: POST /api/refine (Chat updates)
│   │   │   ├── server.ts                 # Express / Node HTTP API server
│   │   │   └── scripts/
│   │   │       ├── testHarvester.ts      # Worker 1 test harness
│   │   │       └── testSynthesizer.ts    # Worker 2 test harness
│   │   └── tsconfig.json
│   │
│   ├── frontend/                         # TRACK C (Worker 3)
│   │   ├── package.json
│   │   ├── vite.config.ts / next.config.ts
│   │   ├── tailwind.config.js
│   │   ├── src/
│   │   │   ├── components/
│   │   │   │   ├── pantry/               # App Pantry picker (Obsidian, Anki, Calc, etc.)
│   │   │   │   ├── cards/
│   │   │   │   │   ├── FeatureCard.tsx   # 3D Flippable card (Front: IO badges / Back: X-Ray)
│   │   │   │   │   └── CardTray.tsx      # Tray of extracted cards
│   │   │   │   ├── terminal/
│   │   │   │   │   └── SseTerminal.tsx   # Real-time streaming REA extraction log
│   │   │   │   ├── studio/
│   │   │   │   │   ├── SandpackPreview.tsx # Live Sandpack runner + Tailwind loader
│   │   │   │   │   └── CodeViewer.tsx    # Syntax-highlighted view of generated files
│   │   │   │   └── chat/
│   │   │   │       └── RefineChat.tsx    # Follow-up conversational prompt box
│   │   │   ├── hooks/
│   │   │   │   ├── useExtraction.ts      # EventSource SSE hook
│   │   │   │   └── useSynthesis.ts       # Synthesis & Sandpack state hook
│   │   │   ├── App.tsx                   # Split-screen studio layout
│   │   │   └── main.tsx
│   │   └── tsconfig.json
│   │
│   └── mocks/                            # STEP 0: Shared Ground Truth Fixtures
│       ├── obsidian_graph_parser.json    # Mock Blueprint 1
│       ├── anki_sm2_scheduler.json       # Mock Blueprint 2
│       └── calc_percentage_engine.json   # Mock Blueprint 3
│
├── targets/                              # Prepared local demo binaries / bundles
│   ├── obsidian-sample/                  # Electron app / asar unpacked bundle
│   └── binaries/                         # Small DLLs / sample compiled binaries
└── rea-upstream/                         # Local clone of morluto/rea for reference
```

---

## 3. Step 0: The Core Data Contracts & Mock Blueprints
*(Everyone reviews & locks this contract. Blocker for parallel work.)*

### 3.1. `FeatureBlueprint` Interface (`packages/contracts/src/blueprint.ts`)

```typescript
import { z } from "zod";

export const BlueprintInputSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string().optional()
});

export const BlueprintOutputSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string().optional()
});

export const ReaEvidenceSchema = z.object({
  artifact_type: z.enum([
    "electron_asar",
    "javascript_bundle",
    "native_pe_dll",
    "native_elf",
    "managed_cli",
    "web_runtime"
  ]),
  target_file: z.string(),
  entry_symbols: z.array(z.string()),
  decompiled_snippet: z.string(),
  ipc_or_network_routes: z.array(z.string()).default([]),
  confidence_score: z.number().min(0).max(1).default(0.95),
  limitations: z.array(z.string()).default([])
});

export const CleanRoomImplementationSchema = z.object({
  language: z.literal("typescript"),
  module_name: z.string(),
  inputs: z.array(BlueprintInputSchema),
  outputs: z.array(BlueprintOutputSchema),
  portable_code: z.string(),
  unit_test_code: z.string().optional()
});

export const FeatureBlueprintSchema = z.object({
  feature_id: z.string(),
  source_app: z.string(),
  source_icon: z.string().optional(),
  consumer_title: z.string(),
  consumer_description: z.string(),
  category: z.enum(["graph", "scheduling", "calculator", "parser", "state_engine", "utility"]),
  rea_evidence: ReaEvidenceSchema,
  clean_room_implementation: CleanRoomImplementationSchema
});

export type FeatureBlueprint = z.infer<typeof FeatureBlueprintSchema>;
```

### 3.2. SSE API Contract (`packages/contracts/src/api.ts`)

```typescript
export interface SseProgressEvent {
  stage: "analyzing" | "locating_symbol" | "tracing_ast" | "decompiling" | "clean_room_synthesis" | "complete" | "error";
  message: string;
  tool_called?: string;
  tool_args?: Record<string, any>;
  timestamp: number;
  data?: FeatureBlueprint; // Delivered when stage === "complete"
}

export interface SynthesisRequest {
  blueprints: FeatureBlueprint[];
  specialization_prompt: string;
}

export interface SynthesisResponse {
  app_title: string;
  app_description: string;
  files: Record<string, string>; // Sandpack file mapping (e.g. "/App.tsx", "/engines/graph.ts")
  dependencies: Record<string, string>; // package.json dependencies for Sandpack
}

export interface RefineRequest {
  current_files: Record<string, string>;
  blueprints: FeatureBlueprint[];
  refine_prompt: string;
}
```

### 3.3. Ground Truth Mock Fixtures (`packages/mocks/`)

#### 1. `obsidian_graph_parser.json`
```json
{
  "feature_id": "obsidian_wiki_backlink_graph",
  "source_app": "Obsidian",
  "source_icon": "BookOpen",
  "consumer_title": "Bi-Directional Wiki Link Graph Engine",
  "consumer_description": "Parses markdown content for [[wikilinks]] and resolves bi-directional node connections and backlink references.",
  "category": "graph",
  "rea_evidence": {
    "artifact_type": "electron_asar",
    "target_file": "app.asar/dist/app.js",
    "entry_symbols": ["parseMarkdownLinks", "resolveBacklinks", "metadataCache"],
    "decompiled_snippet": "function resolveBacklinks(e, t) { let n = {}; for (let r of e) { let i = parseWikiLinks(r.content); i.forEach(l => { n[l] = n[l] || []; n[l].push(r.id); }); } return n; }",
    "ipc_or_network_routes": ["vault:read-metadata", "renderer->metadata-worker"],
    "confidence_score": 0.98,
    "limitations": ["Assumes UTF-8 markdown notes", "Ignores block-level transclusions"]
  },
  "clean_room_implementation": {
    "language": "typescript",
    "module_name": "wikiGraphEngine",
    "inputs": [
      { "name": "notes", "type": "Array<{ id: string; title: string; content: string }>" }
    ],
    "outputs": [
      { "name": "graph", "type": "{ nodes: Array<{ id: string; label: string }>; links: Array<{ source: string; target: string }> }" },
      { "name": "backlinks", "type": "Record<string, string[]>" }
    ],
    "portable_code": "export interface NoteItem {\n  id: string;\n  title: string;\n  content: string;\n}\n\nexport interface GraphData {\n  nodes: { id: string; label: string }[];\n  links: { source: string; target: string }[];\n  backlinks: Record<string, string[]>;\n}\n\nexport function buildWikiGraph(notes: NoteItem[]): GraphData {\n  const nodes = notes.map(n => ({ id: n.id, label: n.title }));\n  const links: { source: string; target: string }[] = [];\n  const backlinks: Record<string, string[]> = {};\n  const titleToId = new Map(notes.map(n => [n.title.toLowerCase().trim(), n.id]));\n\n  for (const note of notes) {\n    const matches = Array.from(note.content.matchAll(/\\[\\[([^\\]\\|]+)(?:\\|[^\\]]+)?\\]\\]/g));\n    for (const match of matches) {\n      const targetTitle = match[1].toLowerCase().trim();\n      const targetId = titleToId.get(targetTitle);\n      if (targetId && targetId !== note.id) {\n        links.push({ source: note.id, target: targetId });\n        if (!backlinks[targetId]) backlinks[targetId] = [];\n        if (!backlinks[targetId].includes(note.id)) backlinks[targetId].push(note.id);\n      }\n    }\n  }\n  return { nodes, links, backlinks };\n}"
  }
}
```

#### 2. `anki_sm2_scheduler.json`
```json
{
  "feature_id": "anki_sm2_repetition",
  "source_app": "Anki",
  "source_icon": "Clock",
  "consumer_title": "SuperMemo-2 (SM-2) Spaced Repetition Engine",
  "consumer_description": "Calculates optimal review intervals, easiness factor (EF), and repetition decay based on user recall grade (0-5).",
  "category": "scheduling",
  "rea_evidence": {
    "artifact_type": "native_pe_dll",
    "target_file": "anki_core.dll",
    "entry_symbols": ["SchedV2::answerCard", "calculateNextInterval", "0x140023B80"],
    "decompiled_snippet": "double calculate_factor(double factor, int grade) { double next = factor + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)); return next < 1.3 ? 1.3 : next; }",
    "ipc_or_network_routes": [],
    "confidence_score": 0.99,
    "limitations": ["Evaluates standard SM-2 algorithm without FSRS fuzzy adjustments"]
  },
  "clean_room_implementation": {
    "language": "typescript",
    "module_name": "sm2Scheduler",
    "inputs": [
      { "name": "cardState", "type": "{ repetitions: number; intervalDays: number; easeFactor: number }" },
      { "name": "grade", "type": "0 | 1 | 2 | 3 | 4 | 5 (0: blackout, 5: perfect)" }
    ],
    "outputs": [
      { "name": "nextState", "type": "{ repetitions: number; intervalDays: number; easeFactor: number; nextDueDate: string }" }
    ],
    "portable_code": "export interface CardScheduleState {\n  repetitions: number;\n  intervalDays: number;\n  easeFactor: number;\n}\n\nexport interface ScheduleResult extends CardScheduleState {\n  nextDueDate: string;\n}\n\nexport function computeNextReview(state: CardScheduleState, grade: number): ScheduleResult {\n  let { repetitions, intervalDays, easeFactor } = state;\n  if (grade >= 3) {\n    if (repetitions === 0) {\n      intervalDays = 1;\n    } else if (repetitions === 1) {\n      intervalDays = 6;\n    } else {\n      intervalDays = Math.round(intervalDays * easeFactor);\n    }\n    repetitions += 1;\n  } else {\n    repetitions = 0;\n    intervalDays = 1;\n  }\n  easeFactor = easeFactor + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02));\n  if (easeFactor < 1.3) easeFactor = 1.3;\n\n  const dueDate = new Date();\n  dueDate.setDate(dueDate.getDate() + intervalDays);\n  return {\n    repetitions,\n    intervalDays,\n    easeFactor: Number(easeFactor.toFixed(2)),\n    nextDueDate: dueDate.toISOString().split('T')[0]\n  };\n}"
  }
}
```

#### 3. `calc_percentage_engine.json`
```json
{
  "feature_id": "calc_percent_logic",
  "source_app": "Windows Calculator",
  "source_icon": "Calculator",
  "consumer_title": "Context-Aware Percentage & Tax Engine",
  "consumer_description": "Resolves percentage operations differently based on preceding arithmetic context (additive tax/discount vs multiplicative ratio).",
  "category": "calculator",
  "rea_evidence": {
    "artifact_type": "native_pe_dll",
    "target_file": "Calculator.dll",
    "entry_symbols": ["CCalculator::ProcessPercentage", "0x5C_PERCENT_HANDLER"],
    "decompiled_snippet": "if (last_op == ADD || last_op == SUB) { return base * (pct / 100.0); } else { return pct / 100.0; }",
    "ipc_or_network_routes": [],
    "confidence_score": 0.96,
    "limitations": ["Evaluates standard infix notation"]
  },
  "clean_room_implementation": {
    "language": "typescript",
    "module_name": "contextPercentEngine",
    "inputs": [
      { "name": "baseValue", "type": "number" },
      { "name": "percentValue", "type": "number" },
      { "name": "operator", "type": "'+' | '-' | '*' | '/'" }
    ],
    "outputs": [
      { "name": "resolvedValue", "type": "number" }
    ],
    "portable_code": "export function computeContextualPercent(baseValue: number, percentValue: number, operator: '+' | '-' | '*' | '/'): number {\n  if (operator === '+' || operator === '-') {\n    return baseValue * (percentValue / 100);\n  }\n  return percentValue / 100;\n}"
  }
}
```

---

## 4. Worker 1 Playbook: Track A (The REA Engine & Harvester Loop)

**Role:** Backend Reverse-Engineering & Harvester Specialist  
**Core Goal:** Build `packages/backend` with live stdio MCP connection to `rea-agents`, run the Harvester agent loop, and expose `POST /api/extract` with real-time SSE streaming and mock caching.

### 4.1. Connecting to REA via Stdio MCP Client (`packages/backend/src/mcp/reaClient.ts`)

Instead of compiling REA from scratch, use the globally published or npx package `rea-agents@6.7.0` which supports `--mcp` mode:

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
```

### 4.2. Harvester Agent Workflow ("Seen -> Inferred -> Verified")
File: `packages/backend/src/harvester/harvesterAgent.ts`

When a user requests a feature from an app:
1. **Target Selection**:
   - If target is an Electron app / `.asar`: call `analyze_javascript_application` with `target_path`.
   - If target is a Web URL: call `capture_browser_scenario` or `analyze_web_bundle`.
   - If target is a native binary: call `open_binary` followed by `decompile` or `function`.
2. **Autonomous Tool Loop**:
   - Give the LLM (Claude 3.7 Sonnet / GPT-4o) access to REA tools via MCP.
   - Inject the system prompt adapted from `rea-upstream/.agents/skills/reverse-engineer-anything/SKILL.md`:
     - *Phase 1 (Seen)*: Inspect entry points, module names, exported symbols.
     - *Phase 2 (Inferred)*: Trace call trees and decompile relevant functions.
     - *Phase 3 (Verified / Clean-Room)*: Write a pure, dependency-free TypeScript module that replicates the isolated logic, and construct the `FeatureBlueprint` JSON.

### 4.3. SSE Progress Stream & Cache Fallback
File: `packages/backend/src/routes/extract.ts`

```typescript
import { Router } from "express";
import { FeatureBlueprint } from "@splice/contracts";
import fs from "fs/promises";
import path from "path";

export const extractRouter = Router();

extractRouter.post("/api/extract", async (req, res) => {
  const { appId, featureQuery, useCache = false } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (stage: string, message: string, tool?: string, data?: any) => {
    res.write(`data: ${JSON.stringify({ stage, message, tool_called: tool, data, timestamp: Date.now() })}\n\n`);
  };

  try {
    if (useCache || process.env.REA_MODE === "mock") {
      // Replay realistic REA steps for guaranteed demo stability (6-7s total)
      sendEvent("analyzing", `Attaching REA analyzer to target: ${appId}...`);
      await delay(1200);

      sendEvent("locating_symbol", `Unpacking archive and scanning symbols for query: "${featureQuery}"`, "analyze_javascript_application");
      await delay(1500);

      sendEvent("tracing_ast", `Tracing AST call graph and resolving IPC routes...`, "trace_javascript_semantics");
      await delay(1800);

      sendEvent("decompiling", `Decompiling target module to clean TypeScript AST...`, "decompile");
      await delay(1200);

      sendEvent("clean_room_synthesis", `Synthesizing portable Clean-Room TypeScript implementation...`);
      await delay(1000);

      // Load matching mock blueprint
      const mockFile = path.resolve(__dirname, `../../../mocks/${getMockFilename(appId)}`);
      const blueprint: FeatureBlueprint = JSON.parse(await fs.readFile(mockFile, "utf-8"));

      sendEvent("complete", `Extraction complete! Feature blueprint ready.`, undefined, blueprint);
      return res.end();
    }

    // LIVE REA MCP EXECUTION
    // (Calls reaMcp.callTool, streams live events, finishes with complete)
  } catch (err: any) {
    sendEvent("error", err.message);
    res.end();
  }
});

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function getMockFilename(appId: string): string {
  if (appId.includes("obsidian")) return "obsidian_graph_parser.json";
  if (appId.includes("anki")) return "anki_sm2_scheduler.json";
  return "calc_percentage_engine.json";
}
```

---

## 5. Worker 2 Playbook: Track B (The Fusion & Specialization Engine)

**Role:** AI Synthesis & Codegen Specialist  
**Core Goal:** Build `packages/backend/src/synthesis` to take 2–3 `FeatureBlueprint` JSONs, write an intelligent React+Tailwind adapter layer, and generate an executable Sandpack file bundle via `POST /api/synthesize` and `POST /api/refine`.

### 5.1. Synthesis Prompt Design (`packages/backend/src/synthesis/synthesizerAgent.ts`)

The synthesis agent takes:
1. Selected `FeatureBlueprint[]` objects.
2. The user's specialization prompt (e.g., *"Build an interactive flashcard study suite that parses markdown wiki notes and schedules review dates"*).

**Prompt Invariants:**
- **Immutable Engines:** Every blueprint's `clean_room_implementation.portable_code` MUST be placed unchanged in `/engines/<module_name>.ts`.
- **Glue Adapter:** The agent generates `/App.tsx` and UI components that import the functions from `/engines/` and wire their inputs and outputs using React state.
- **Styling:** Must use standard Tailwind CSS classes with clean, modern styling (slate dark theme or clean white, smooth cards, responsive grid).
- **Executable Sandpack Bundle:** The response must be a valid JSON dictionary of files:
  - `/App.tsx`
  - `/engines/wikiGraphEngine.ts`
  - `/engines/sm2Scheduler.ts`
  - `/index.tsx`
  - `/styles.css`

### 5.2. Example LLM System Prompt for Track B

```markdown
You are the Splice Synthesis Engine.
You receive multiple reverse-engineered TypeScript engines (FeatureBlueprints) and a user's target application specification.

Your job is to fuse these extracted mechanics into a complete, beautiful, working React + Tailwind web application that runs inside Sandpack.

RULES:
1. Place each blueprint's portable_code into its own file under `/engines/<moduleName>.ts`. DO NOT MODIFY the algorithmic code inside these engines. Treat them as ground truth.
2. In `/App.tsx`, build a cohesive, delightful UI. Provide sample seed data so the app immediately displays content when opened.
3. Wire user interactions directly to the imported engine functions.
4. Use Tailwind CSS for modern aesthetics (clean cards, subtle borders, rounded badges, clean typography).
5. Output MUST be strictly valid JSON matching this schema:
{
  "app_title": "string",
  "app_description": "string",
  "files": {
    "/App.tsx": "code string",
    "/engines/engine1.ts": "code string",
    "/engines/engine2.ts": "code string"
  },
  "dependencies": {
    "lucide-react": "latest",
    "canvas-confetti": "latest"
  }
}
```

### 5.3. Iterative Refinement Loop (`packages/backend/src/routes/refine.ts`)

Allows follow-up prompts from the user (e.g., *"Add a tag filter to the flashcard list and add a progress bar for mastery"*):
- Receives: `{ current_files, blueprints, refine_prompt }`
- Keeps `/engines/*` untouched.
- Modifies `/App.tsx` and auxiliary components to implement the user's requested additions.
- Returns updated `files` map back to the Sandpack runner.

---

## 6. Worker 3 Playbook: Track C (Lightweight Studio & Sandpack UI)

**Role:** Frontend & UX Engineer  
**Core Goal:** Build `packages/frontend` (Vite + React + Tailwind + `@codesandbox/sandpack-react` + `lucide-react` + `framer-motion`) delivering a responsive split-screen studio.

### 6.1. Split-Screen Layout (`packages/frontend/src/App.tsx`)

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  [Logo: SPLICE]  Reverse-Engineered App Blender              [REA Status: Connected ●] │
├──────────────────────────────────────────┬─────────────────────────────────────────────┤
│ LEFT COLUMN (45%): HARVESTER & BLENDER   │ RIGHT COLUMN (55%): LIVE SANDPACK STUDIO    │
│                                          │                                             │
│ 1. App Pantry (Select Ingredients):      │ [Tab: Live Preview] [Tab: View Code]        │
│    [x] Obsidian   [x] Anki   [ ] Calc    │ ┌─────────────────────────────────────────┐ │
│                                          │ │                                         │ │
│ 2. Feature Query & Extract:              │ │    (Sandpack Embedded React App)        │ │
│    [ "Extract Graph + Spaced Repetition" ]│ │                                         │ │
│    [ > Harvest Features (SSE Stream) ]   │ │  - Medical Study War Room               │ │
│                                          │ │  - Interactive Wiki Backlinks           │ │
│ 3. Streaming REA Terminal:               │ │  - Anki SM-2 Review Buttons             │ │
│    ┌───────────────────────────────────┐ │ │                                         │ │
│    │ [15:42:01] analyze_javascript_... │ │ └─────────────────────────────────────────┘ │
│    │ [15:42:03] decompile 0x140023B80  │ │                                             │
│    └───────────────────────────────────┘ │ ─────────────────────────────────────────── │
│                                          │ Follow-up Refinement:                       │
│ 4. Feature Card Tray (Flippable Cards):  │ [ "Add dark mode toggle and card tags" ]    │
│    ┌─────────────────┐ ┌───────────────┐ │ [ > Refine App ]                            │
│    │ Obsidian Graph  │ │ Anki Scheduler│ │                                             │
│    │ [X-Ray Flip 🔄] │ │ [X-Ray Flip 🔄]│ │                                             │
│    └─────────────────┘ └───────────────┘ │                                             │
│                                          │                                             │
│ 5. [ ⚡ Fuse & Specialize Application ]   │                                             │
└──────────────────────────────────────────┴─────────────────────────────────────────────┘
```

### 6.2. The 3D Flippable "X-Ray" Card Component (`packages/frontend/src/components/cards/FeatureCard.tsx`)

Judges will love this: The front of the card shows consumer-friendly inputs and outputs; clicking **"X-Ray Evidence"** triggers a 3D card flip showing the raw decompiled C/assembly/AST snippet extracted by REA.

```tsx
import React, { useState } from "react";
import { FeatureBlueprint } from "@splice/contracts";
import { Code, Cpu, ExternalLink, RefreshCw, CheckCircle2 } from "lucide-react";

export const FeatureCard: React.FC<{
  blueprint: FeatureBlueprint;
  selected: boolean;
  onToggle: () => void;
}> = ({ blueprint, selected, onToggle }) => {
  const [flipped, setFlipped] = useState(false);

  return (
    <div className="relative w-full h-72 [perspective:1000px] select-none">
      <div
        className={`w-full h-full duration-500 [transform-style:preserve-3d] transition-transform ${
          flipped ? "[transform:rotateY(180deg)]" : ""
        }`}
      >
        {/* FRONT OF CARD */}
        <div className="absolute inset-0 bg-slate-900 border border-slate-750 rounded-xl p-4 flex flex-col justify-between [backface-visibility:hidden] shadow-lg">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold px-2 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800">
                {blueprint.source_app}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); setFlipped(true); }}
                className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1 bg-amber-950/40 px-2 py-0.5 rounded border border-amber-800/50"
              >
                <Cpu className="w-3 h-3" /> X-Ray Evidence
              </button>
            </div>
            <h3 className="font-bold text-slate-100 text-sm mb-1">{blueprint.consumer_title}</h3>
            <p className="text-xs text-slate-400 line-clamp-2">{blueprint.consumer_description}</p>

            <div className="mt-3 space-y-1">
              <div className="text-[11px] text-slate-400 font-medium">Inputs:</div>
              <div className="flex flex-wrap gap-1">
                {blueprint.clean_room_implementation.inputs.map((inp, i) => (
                  <span key={i} className="text-[10px] bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded border border-slate-700">
                    {inp.name}: {inp.type}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <button
            onClick={onToggle}
            className={`w-full py-1.5 px-3 rounded text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${
              selected
                ? "bg-emerald-600 text-white hover:bg-emerald-500"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            {selected ? "Selected for Fusion" : "Include in Recipe"}
          </button>
        </div>

        {/* BACK OF CARD: X-RAY REA EVIDENCE */}
        <div className="absolute inset-0 bg-slate-950 border border-amber-600/50 rounded-xl p-4 flex flex-col justify-between [transform:rotateY(180deg)] [backface-visibility:hidden] shadow-2xl">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-mono font-bold text-amber-400 flex items-center gap-1">
                <Cpu className="w-3.5 h-3.5" /> REA Evidence Provenance
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); setFlipped(false); }}
                className="text-xs text-slate-400 hover:text-slate-200"
              >
                Back to Card ✕
              </button>
            </div>

            <div className="text-[10px] font-mono text-slate-400 mb-1">
              Artifact: <span className="text-amber-300">{blueprint.rea_evidence.artifact_type}</span> ({blueprint.rea_evidence.target_file})
            </div>
            <div className="text-[10px] font-mono text-slate-400 mb-2">
              Symbols: <span className="text-slate-300">{blueprint.rea_evidence.entry_symbols.join(", ")}</span>
            </div>

            <div className="bg-black/80 rounded p-2 border border-slate-800 overflow-x-auto max-h-32 text-[10px] font-mono text-emerald-400 leading-tight">
              <pre>{blueprint.rea_evidence.decompiled_snippet}</pre>
            </div>
          </div>

          <div className="text-[10px] text-slate-500 italic">
            Extracted via rea-agents MCP • Confidence: {blueprint.rea_evidence.confidence_score * 100}%
          </div>
        </div>
      </div>
    </div>
  );
};
```

### 6.3. Sandpack Live Preview Integration (`packages/frontend/src/components/studio/SandpackPreview.tsx`)

```tsx
import React from "react";
import { Sandpack } from "@codesandbox/sandpack-react";

export const SandpackPreview: React.FC<{
  files: Record<string, string>;
  dependencies?: Record<string, string>;
}> = ({ files, dependencies = {} }) => {
  return (
    <div className="h-full w-full rounded-xl overflow-hidden border border-slate-800 shadow-2xl">
      <Sandpack
        template="react-ts"
        theme="dark"
        files={{
          ...files,
          "/public/index.html": `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen">
  <div id="root"></div>
</body>
</html>`
        }}
        customSetup={{
          dependencies: {
            "lucide-react": "^0.344.0",
            "canvas-confetti": "^1.9.2",
            ...dependencies
          }
        }}
        options={{
          showNavigator: false,
          showTabs: true,
          showLineNumbers: true,
          editorHeight: "100%",
          resizablePanels: true
        }}
      />
    </div>
  );
};
```

---

## 7. Hour-by-Hour 3-Engineer Collaboration Matrix

| Time Window | Worker 1 (Track A: REA Harvester) | Worker 2 (Track B: Synthesis Engine) | Worker 3 (Track C: Studio & UI) |
| :--- | :--- | :--- | :--- |
| **Hours 0–1 (Foundation Gate)** | **All:** Review & lock `FeatureBlueprint` contract & create 3 Mock JSONs in `packages/mocks/`. | **All:** Setup contract & test imports. | **All:** Scaffold monorepo & project shells. |
| **Hours 1–6 (Independent Build)** | Setup Stdio MCP client (`reaClient.ts`) to wrap `npx rea-agents@latest --mcp`. Test `analyze_javascript_application`. | Build `synthesizerAgent.ts` prompt using Mock Blueprints 1 & 2. Generate Sandpack React bundle. | Build Split-Screen Studio shell with Vite + Tailwind + `@codesandbox/sandpack-react`. Load hardcoded files. |
| **Hours 6–12 (Feature Maturation)** | Write autonomous Harvester loop with Claude/GPT calling REA tools and formatting into Blueprint JSON. | Build follow-up chat loop (`POST /api/refine`) that modifies React UI while preserving `/engines/*.ts`. | Build 3D Flippable `FeatureCard` with X-Ray mode and `CardTray` loaded from `packages/mocks/`. |
| **Hours 12–18 (API & Streaming)** | Implement `POST /api/extract` with real-time SSE progress streaming + `USE_CACHE=true` replay engine. | Add Tailwind styling templates & input-to-output state adapter patterns in synthesis prompt. | Build `SseTerminal` and wire `useExtractionStream` to `POST /api/extract`. |
| **Hours 18–24 (Convergence Gate)** | Deploy local backend server (`http://localhost:3001`). Pre-warm cache for demo targets. | Run synthesis tests with all 3 mock combinations. Ensure 0 compile errors in Sandpack. | Point frontend to live backend. Wire "Fuse & Specialize" button to `POST /api/synthesize`. |
| **Hours 24–30 (Demo Polish & Script)** | Assist with demo rehearsal, record backup video screencast, verify cache triggers in 5s. | Tune generated app styling (medical study suite demo, calculator fusion demo). | Add confetti animations, sleek transitions, polish mobile/split responsiveness. |

---

## 8. Pitch & Demo Day Runbook (The 3-Minute Golden Path)

1. **The Hook (0:00 - 0:30):**
   - *"Everyone knows Lovable and v0 generate apps from scratch. But complex real-world software shouldn't be guessed from scratch—it should be **harvested** from proven tools."*
   - *"Introducing **Splice**: we put an autonomous reverse-engineering agent on top of REA to extract real features from desktop and web apps and fuse them into specialized micro-apps."*
2. **The Extraction & X-Ray (0:30 - 1:30):**
   - Click **Obsidian** and **Anki** from the App Pantry.
   - Prompt: *"Build a medical student war-room combining Obsidian's backlink graph with Anki's SM-2 spaced repetition scheduler."*
   - Watch the **Streaming REA Terminal** dynamically inspect `.asar` files and decompile functions.
   - The two **Feature Cards** appear! Flip the Anki card around using the **X-Ray Toggle** to show the live decompiled C/C++ algorithm and symbols to the judges.
3. **The Fusion & Live Sandpack App (1:30 - 2:30):**
   - Click **"⚡ Fuse & Specialize Application"**.
   - Within 5 seconds, Sandpack boots up the unified study suite.
   - Click around: Create a markdown note with `[[Cardiology]]`, watch the link graph update, and click "Review Now" to watch the SM-2 algorithm calculate the next review interval!
4. **The Refinement & Close (2:30 - 3:00):**
   - In the refinement chat, type: *"Add a dark mode toggle and card difficulty ratings"*.
   - App updates live in Sandpack without breaking the extracted reverse-engineered engines.
   - *"Splice: Don't rewrite the wheel. Reverse-engineer it, unbundle it, and splice it."*
