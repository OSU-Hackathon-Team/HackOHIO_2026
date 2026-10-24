# Splice end-to-end architecture

Code snapshot: 2026-10-24. Solid arrows describe implemented relationships, not
proof of successful live end-to-end acceptance. Dashed arrows identify unfinished
product integration or contract handoffs.

```mermaid
flowchart TB
    User["User / maker"] --> UI

    subgraph Browser["Browser — one React + Vite frontend"]
      UI["Chat · App library · My app<br/>Zustand session state"]
      Catalog["Bundled example applications<br/>Feature descriptions, rules, and evidence"]
      Preview["Developed app<br/>Study canvas / Sandpack preview"]
      Catalog -->|"Inspect and select features"| UI
      UI -->|"Enabled features + layout"| Preview
    end

    subgraph Node["Node / Express backend — unified Docker service, port 3001"]
      Builder["POST /api/builder/edits<br/>Validate request and proposed operations"]
      Pipeline["Extraction / implementation / synthesis / refinement APIs<br/>REST + POST-SSE events"]
      NativeAPI["POST /api/native-specs<br/>GET /api/native-specs/:artifact"]
      LLM["Shared structuredCall client<br/>Qwen by default via Bedrock Converse"]
      Layout["Validated layout operations<br/>Revision and cancellation checks in browser"]
      Builder --> LLM --> Layout
    end

    UI -->|"Natural-language edits"| Builder
    Layout -->|"Apply atomically; preserve app on failure"| UI
    UI -.->|"Live analysis / Harvest flow not connected in current workspace"| Pipeline

    subgraph Electron["Electron feature reconstruction pipeline — TypeScript"]
      ASAR["Original Electron application<br/>.asar + feature seeds"]
      REA["rea-agents MCP<br/>Archive inspection + evidence collection"]
      Evidence["RawEvidence<br/>Source citations and provenance"]
      Spec["Write requirements + interface + tests<br/>FeatureSpec"]
      Engine["Implement from specification only<br/>FeatureBlueprint + locked TS engine"]
      Fuse["Fuse selected passing engines<br/>Generate / refine UI; validate SynthesisBundle"]
      Sandbox["Isolated JavaScript test worker<br/>Original-code oracle + engine acceptance tests"]
      ASAR --> REA --> Evidence --> Spec --> Engine --> Fuse
      Sandbox <-->|"Original behavior checks"| Spec
      Sandbox <-->|"Acceptance checks"| Engine
    end

    Pipeline --> REA
    Pipeline --> Spec
    Pipeline --> Engine
    Pipeline --> Fuse
    Spec --> LLM
    Engine --> LLM
    Fuse --> LLM
    Fuse -.->|"Live generated-bundle handoff pending in current workspace"| Preview
    Files[("Filesystem<br/>Evidence, specs, blueprints, bundles<br/>Recordings and replay fixtures")]
    Evidence --> Files
    Spec --> Files
    Engine --> Files
    Fuse --> Files
    Files -->|"Example fixtures"| Catalog

    subgraph Native["Native subsystem engine — Python CLI / worker runtime"]
      Binary["Native executable / shared library"]
      CLI["launch.py<br/>Import, scope, worker, probe, dossier commands"]
      Ghidra["Ghidra import + broad index<br/>Targeted exports and warm contexts"]
      Scope["Bounded subsystem discovery<br/>Entry points + dependency boundaries"]
      Queue[("PostgreSQL<br/>Task leases, retries, findings, progress")]
      Workers["Reasoning worker pool<br/>Semantic claims + dependency contracts"]
      Review["Independent review + original-binary probes<br/>Preserve uncertainty and blockers"]
      Dossier["Immutable subsystem dossier<br/>Partial / blocked / ready-for-spec"]
      Artifacts[("Content-addressed artifact store<br/>SHA-256 evidence and dossier revisions")]
      NativeSpec["Existing native spec generator<br/>NativeSubsystemSpec<br/>Campaign advancement remains gated"]
      Binary --> CLI --> Ghidra --> Scope --> Queue --> Workers --> Review --> Dossier
      Workers -->|"Additional evidence requests"| Ghidra
      Review -->|"Unresolved work"| Queue
      Ghidra --> Artifacts
      Dossier --> Artifacts
      Artifacts --> Workers
      Dossier -->|"Explicit artifact handoff"| NativeSpec
    end

    User -->|"CLI campaigns today"| CLI
    NativeAPI -->|"Invokes launch.py spec; needs Python runtime + shared state"| NativeSpec
    NativeSpec -.->|"Native-to-FeatureSpec contract adapter pending"| Spec
    UI -.->|"Campaign/job API and live progress integration pending"| CLI
    OpenCode["OpenCode model runtime<br/>Separate Python role resolution"]
    Workers --> OpenCode
    Review --> OpenCode
    Models["models.json + environment overrides"] --> LLM
    Models --> OpenCode
```

## Reading the boundaries

- **One frontend:** `packages/frontend/src/App.tsx` mounts `IdeWorkbench`. Old
  components are retained source, not separately deployed frontends. Production
  Express serves Vite's compiled assets on port 3001. Development Vite runs on
  port 5173 and proxies API requests to Express.
- **Current UI:** the library uses bundled fixtures. Chat calls the builder API;
  valid operations change presentation while engines remain locked. The current
  IDE state survives view changes in the session, not necessarily page reloads.
- **Electron pipeline:** Step 2 and Step 3 dependencies are wired in code. The
  sandbox checks original behavior and reconstructed implementations separately.
  Purity, type conformance, test results, and bundle validation constrain output.
  Backend wiring and tests do not establish live full-pipeline acceptance.
- **Native engine:** PostgreSQL controls durable work; immutable files hold evidence.
  Scope expansion, targeted analysis, review, and probes can create further work.
  Parallel leases have been demonstrated; full scale, quality, and recovery gates
  remain open. Partial evidence produces a partial dossier.
- **Native specification bridge:** the route and generator exist. A native
  specification is a different contract from `FeatureSpec`; it does not yet feed
  the TS implementation/fusion pipeline. The root Node Dockerfile does not package
  the Python engine or its state; the bridge requires the appropriate runtime and
  shared artifact access. Campaign specification generation remains gated by the
  engine implementation plan.
- **Models:** Splice's spec, engine, UI, and refusal-fallback defaults use Qwen via
  the shared Bedrock client. Explicit Claude overrides retain their separate API
  path. Native workers use OpenCode and Python role routing; do not assume every
  native model call uses the Splice Qwen path.

## Deployment and verification

```mermaid
flowchart LR
    Repo["Repository checkout + lockfile"] --> CI["CI<br/>Build + typecheck + regression tests<br/>Desktop browser tests"]
    CI --> Build["Root Dockerfile<br/>Build contracts, backend, frontend"]
    Build --> Web["splice container<br/>Express + compiled frontend<br/>Port 3001"]
    Web --> Smoke["Container smoke checks<br/>Current UI bundle + health + API guards"]
    Browser["Browser"] --> Web
    Worker["Compose worker profile<br/>Python orchestration + OpenCode<br/>Ghidra worker tooling"] --> Store["Native artifact state<br/>and PostgreSQL control state"]
```

The Node image and native worker runtime are separate deployment concerns. The
Compose worker service defaults to CLI help, not an automatically running native
campaign or a fully provisioned multi-host worker fleet.

## Source anchors

- Browser: `packages/frontend/src/ide/IdeWorkbench.tsx`, `store/useIdeStore.ts`, `data/ideFixtures.ts`.
- API mounting / static assets: `packages/backend/src/server.ts`.
- Extraction / oracle: `packages/backend/src/routes/step2/index.ts`, `spec/buildSpec.ts`, `sandbox/runTests.ts`.
- Reconstruction / fusion: `packages/backend/src/routes/step3/deps.ts`, `engine/implement.ts`, `synthesis/`.
- Layout editing: `packages/backend/src/builder/edits.ts`, `packages/contracts/src/builder.ts`.
- Native bridge: `packages/backend/src/routes/nativeSpecs.ts`, `packages/contracts/src/nativeSpec.ts`.
- Native analysis and control: `launch.py`, `engine/analysis/`, `engine/queue.py`, `engine/worker.py`, `engine/validation/`, `engine/dossier.py`.
- Native design and execution gate: `DecompPileline.md`, `DECOMP_IMPLEMENTATION_PLAN.md`.
- Deployment: `Dockerfile`, `worker.Dockerfile`, `compose.yaml`, `.github/workflows/ci.yml`.
