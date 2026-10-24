# Splice — Engineering Playbook (start here)

This folder is the build spec for Splice. It replaces the high-level plan in
`hackathon_master_plan_rea_lovable.md` wherever the two disagree. (The older flat files
`agents/reverse_engineering.md`, `feature_extraction.md` and `implementation_and_frontend.md`
have been deleted; see git history if needed.)

```
agents/
├── README.md                         ← you are here: team, timeline, repo layout, rules
├── CONTRACTS.md                      ← THE single source of truth for every shared type
├── 1_reverse_engineering/            ← Step 1 (Eng 1): targets → REA → RawEvidence
├── 2_requirements_extraction/        ← Step 2 (Eng 2): RawEvidence → FeatureSpec (requirements + tests checked against original)
└── 3_feature_implementation/         ← Step 3 (Eng 3): FeatureSpec → engine → fused app in Sandpack + Studio UI
```

---

## 1. What we are building (one paragraph)

The user picks features from a **pantry** of desktop apps. **Step 1** drives **REA**
(`rea-agents`, an MCP server) to locate and trace the real code inside the packaged app.
**Step 2** turns that evidence into a **requirements spec**: numbered behaviours that cite source
lines, a TypeScript interface, and acceptance tests. For JavaScript targets, those tests are
**checked against the original code** through a small adapter, so the spec matches what the app
actually does. **Step 3** has Claude implement a pure TypeScript engine that passes those tests,
then generates a React UI around the **unchanged** engines. The UI runs live in Sandpack and can
be refined by chat.

```
 Step 1 · Eng 1 · REA          Step 2 · Eng 2 · Requirements         Step 3 · Eng 3 · Implementation
┌────────────────────┐ Raw    ┌──────────────────────────────┐ Spec  ┌──────────────────────────────────┐
│ targets/*.asar     │Evidence│ requirements + interface     │──────▶│ implement engine (Claude)        │
│ REA MCP bridge     │───────▶│ + acceptance tests (Claude)  │       │ → run acceptance tests → repair  │
│ evidence collector │        │ → run tests vs ORIGINAL code │       │ = FeatureBlueprint (card)        │
│ record / replay    │        │   via adapter → repair       │       │ → synthesize UI around engines   │
└────────────────────┘        └──────────────────────────────┘       │ → validate → Sandpack → refine   │
     POST /api/extract (Steps 1+2, one stream)                        │ Studio frontend                  │
                                                                     └──────────────────────────────────┘
                                                        POST /api/implement · /api/synthesize · /api/refine
```

What each step hands to the next:

| Hand-off | Type (`CONTRACTS.md`) | Meaning |
|---|---|---|
| 1 → 2 | `RawEvidence` | "Here is the real code REA found, and how it found it" |
| 2 → 3 | `FeatureSpec` | "Here is what the feature must do, as numbered requirements and tests that the original passes" |
| 3 → user | `FeatureBlueprint`, `SynthesisBundle` | "Here is a working engine that passes those tests, and an app built on it" |

---

## 2. Verified facts about REA (checked 2026-10-24 against npm + upstream docs)

These **override** anything the older docs say:

| Topic | Fact | Consequence |
|---|---|---|
| Package | `rea-agents@6.7.0`, needs Node `^22.19.0 \|\| ^24.11.0 \|\| >=26` | Everyone installs Node 22.19+ (`node -v`) |
| Launch | MCP server is the **`mcp` subcommand**: `npx -y rea-agents@6.7.0 mcp`. **Not `--mcp`.** On Windows wrap with `cmd.exe /d /c` or run the entry script with `node` directly | See `1_reverse_engineering/03_mcp_bridge.md` |
| JS/Electron | `analyze_javascript_application` takes a local directory or `.asar`, needs **no** Ghidra/IDA/Hopper and does **not** execute the app | **The live demo runs on Electron targets.** This is the low-risk path |
| Native | Native decompiling needs Hopper, Ghidra or IDA. **Windows Ghidra support is labelled experimental.** | Native targets are a stretch goal, replay only (`1_reverse_engineering/08_stretch_native_targets.md`) |
| Real tool names (from docs) | `binary_session`, `analyze_javascript_application`, `trace_application_feature`, `trace_javascript_semantics`, `inspect_analysis_view`, `inspect_artifact`, `open_binary`, `close_binary`, `list_procedures`, `search_procedures`, `search_strings`, `analyze_function`, `get_call_graph`, `trace_call_path`, `get_evidence_bundle`, `export_evidence_bundle`, `capture_browser_scenario`, `analyze_web_bundle` | The old docs' `survey_program`, `function_inventory`, `trace_callees` and `decompile` **do not exist**. Delete them |
| Results | Evidence tools return `structuredContent.normalized_result` and `structuredContent.evidence_id` (`ev_<64 hex>`). Follow-up tools accept `{ "kind": "retained-evidence", "evidence_id": "..." }` **on the same connection** | One long-lived MCP connection per backend process |
| Discovery | `tools/list` returns the full catalog. `binary_session {}` → `tool_availability` says what is callable right now | Hour-0 task: dump both to `fixtures/rea/` |
| Big replies | A full app graph can be MBs. Use `detail: "summary"` on the first call. Response cap is set by `REA_MCP_MAX_RESPONSE_BYTES` | Bridge truncates before anything reaches Claude |

> ✅ **Arguments verified live on 2026-10-24** for `analyze_javascript_application` (`input_path`),
> `trace_application_feature` and `binary_session`. The catalog and real results are in `fixtures/rea/`.
> The key surprise: with `detail: "summary"`, follow-up tools need the reply's
> `normalized_result.parent_evidence_id`, not its `evidence_id`. `trace_javascript_semantics` and
> `inspect_analysis_view` are still `// VERIFY` (see `1_reverse_engineering/03_mcp_bridge.md` §4).

---

## 3. Team & ownership — one engineer per step

| Engineer | Step | Owns | Docs |
|---|---|---|---|
| **Eng 1 — REA** | 1 | demo target apps, REA bridge, evidence collector, record/replay, Express server shell + SSE helper, `/api/health`, `/api/pantry` | `1_reverse_engineering/*` |
| **Eng 2 — Requirements** | 2 | shared `llm.ts` + shared `sandbox/` runner (Eng 3 reuses both), requirements prompt, adapter/oracle check, spec repair loop, `POST /api/extract` (runs Step 1 then Step 2) | `2_requirements_extraction/*` |
| **Eng 3 — Implementation** | 3 | engine implementation + test loop (`POST /api/implement`), UI synthesis, bundle validator, refine/auto-fix, the whole Studio frontend | `3_feature_implementation/*` |

Load balancing: Eng 3 has the largest scope. To make that workable:
- Eng 3 reuses Eng 2's `llm.ts` and sandbox runner instead of writing their own (Eng 2 ships both by H4).
- The frontend scope is trimmed to the essentials (see `3_feature_implementation/README.md`).
- After CP2, whoever is ahead pairs with Eng 3. The validator (`3_feature_implementation/03_bundle_validator.md`) is self-contained and easy to hand off.

---

## 4. Repository layout (create exactly this at H0)

```
HackOHIO_2026/
├── .gitignore                  # MUST include .env, node_modules, dist, targets/build/**/node_modules
├── .env.example                # AWS_REGION=, AWS_PROFILE=, MODEL_<ROLE>=, REA_MODE=, LLM_MODE=
├── models.json                   # global role → model routing (decomp_worker, spec_writer, legal_verification)
├── package.json                # npm workspaces
├── agents/                     # these docs
├── packages/
│   ├── contracts/              # @splice/contracts — Zod schemas from CONTRACTS.md (TS source, no build step)
│   ├── backend/                # @splice/backend  — Express + tsx
│   └── frontend/               # @splice/frontend — Vite + React + Tailwind + Sandpack
├── targets/
│   ├── manifest.json           # the pantry (apps + features + REA seeds)
│   ├── src/inkwell/            # source of demo target app #1 (notes app)
│   ├── src/recall/             # source of demo target app #2 (flashcards app)
│   └── build/                  # built .asar files — COMMITTED so every machine has the same sha256
├── fixtures/
│   ├── rea/                    # tools.json, session.json (catalog dumps)
│   ├── evidence/               # <app>__<feature>.json   RawEvidence recorded from live REA runs
│   ├── transcripts/            # <app>__<feature>.json   full ExtractEvent stream of a live run
│   ├── specs/                  # <feature_id>.json        golden FeatureSpecs (Step 2 output)
│   ├── blueprints/             # <feature_id>.json        golden FeatureBlueprints (Step 3 output)
│   └── bundles/                # <name>.json              golden SynthesisBundles for the demo
└── scripts/
    └── build-targets.mjs
```

Root `package.json`:

```json
{
  "name": "splice",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=22.19.0" },
  "scripts": {
    "build:targets": "node scripts/build-targets.mjs",
    "dev:backend": "npm run dev -w @splice/backend",
    "dev:frontend": "npm run dev -w @splice/frontend",
    "dev": "npm run dev:backend & npm run dev:frontend"
  }
}
```

> On Windows, `&` in npm scripts doesn't run things in parallel. Use two terminals, or add
> `concurrently` (`"dev": "concurrently -n api,web \"npm:dev:backend\" \"npm:dev:frontend\""`).

---

## 5. Secrets — do this before anything else

The AWS keys committed in `.env` (`83f811b`, pushed to `origin/dev`) are compromised. Revoke them in
IAM first. Then:

```bash
printf ".env\n.env.*\n!.env.example\nnode_modules/\ndist/\n.vite/\n*.log\n" > .gitignore
git rm --cached .env
git commit -m "Stop tracking .env"
# Then rewrite history (team decision: everyone re-clones after):
#   pip install git-filter-repo && git filter-repo --path .env --invert-paths && git push --force-with-lease
```

We call Claude through **Amazon Bedrock**. AWS credentials live **only** in `~/.aws` (preferred,
`AWS_PROFILE=splice`) or in `packages/backend/.env` (gitignored). The frontend never sees them.
Temporary session credentials expire, so refresh them from the AWS portal when calls start
failing with `ExpiredTokenException`. Before H1, confirm Bedrock model access for Claude Opus 5.5 is
enabled in your region (`2_requirements_extraction/02_llm_client.md` §1).

---

## 6. Runtime modes (demo safety without faking)

Two independent switches, both read by the backend:

| Var | Values | Meaning |
|---|---|---|
| `REA_MODE` | `live` / `replay` / `auto` | `live` = call REA. `replay` = load `fixtures/evidence/*.json` recorded from a real earlier run. `auto` = try live with a 45s budget, then fall back to replay |
| `LLM_MODE` | `live` / `replay` | `live` = Claude writes specs, engines and UIs. `replay` = replay `fixtures/transcripts/*` + `fixtures/specs/*` + `fixtures/blueprints/*` + `fixtures/bundles/*` with their original timing |

Rules:
1. Replay data must be **recorded from real runs**. Nobody hand-writes a transcript. The only
   hand-written fixtures are the H2 seeds in `fixtures/*/_seed/`, and those
   are deleted once live runs produce real ones.
2. The UI shows a **`REPLAY` badge** on any card or bundle that came from replay. Judges respect
   honesty; they don't respect getting caught.

---

## 7. Timeline (24h build — shift all times if the event is longer)

| Hour | Eng 1 · REA | Eng 2 · Requirements | Eng 3 · Implementation | Gate |
|---|---|---|---|---|
| **0–1** | revoke keys; scaffold repo; `rea:catalog` | write `packages/contracts` from `CONTRACTS.md` | scaffold Vite + Tailwind + Sandpack | **Contracts locked** (all three review `CONTRACTS.md`) |
| 1–4 | build Inkwell + Recall targets; bridge connects; hand-write seed evidence | `llm.ts`, sandbox runner (ship to Eng 3 by H4); spec prompt on seed evidence | layout shell, store, SSE client, mock streams from seed spec | — |
| 4–8 | collector: live analyze + trace on Inkwell → RawEvidence | adapter/oracle check + repair loop; `/api/extract` on replayed evidence | `/api/implement` against seed spec; FeatureCard + terminal | **CP1 (H8):** live REA on Inkwell → live spec → live engine → card in UI |
| 8–14 | record evidence for all 4 features; server shell, health, pantry; `auto` fallback | spec quality across 4 features; requirement coverage check | synthesis + merge + validator; Sandpack studio; Fuse button | **CP2 (H14):** full golden path live: 2 apps → 2 specs → 2 engines → fused app runs |
| 14–18 | record transcripts; harden bridge; help Eng 3 | tune prompts; record golden specs; help Eng 3 | refine + auto-fix, export zip, REPLAY badges | **Feature freeze (H18)** |
| 18–20 | commit fixtures | commit fixtures | golden bundles, polish, phone-width check | fixtures committed |
| 20–22 | rehearse ×3, record backup video | rehearse | rehearse | **Code freeze (H22)** |
| 22–24 | Devpost + README | Devpost | screenshots / GIFs | submit |

**Cut list (in this order if behind):** agentic REA mode → native target → export zip →
oracle adapter for the second app (keep LLM-only tests, marked "not checked against original") →
evidence drawer tabs (keep the card back only) → refine chat (keep auto-fix only).

---

## 8. Working rules

- **Contracts change only by PR touching `packages/contracts` + `CONTRACTS.md`, approved by all three.**
- Each engineer works on their own branch (`e1/*`, `e2/*`, `e3/*`) and merges to `dev` at every checkpoint.
- Every backend module ships with a CLI script under `packages/backend/src/scripts/` that runs it
  alone. "It works" means that script passes.
- Pin exact versions with a committed `package-lock.json`. Never write `"latest"` anywhere (code or prompts).
- Models are routed per role in root `models.json` (`decomp_worker` → nova lite, `spec_writer` → nova pro, `legal_verification` → opus 4.6). Override a role with `MODEL_<ROLE>` env (e.g. `MODEL_SPEC_WRITER`); `OPENCODE_MODEL` remains the legacy default override. Do not hard-code model IDs; Python resolves via `model_config.py`, TS via `packages/backend/src/models.ts`, and all Claude calls go through `llm/llm.ts`.

---

## 9. How this plan scores against `judging_criteria.md`

| Criterion (1–5) | What earns the 5 | Owner | Evidence to show |
|---|---|---|---|
| **Innovation** | Spec-first reuse: harvest a feature from a shipped app, **prove** the spec against the original, rebuild it without seeing the original code. Lovable/v0 generate from scratch | all | The "original vs engine" test table (Step 3 doc 07 §6) |
| **Curiosity** — *multiple approaches tested* | We deliberately compare approaches and keep the numbers: **(a)** direct reconstruction (LLM reads code → writes code) vs **spec-first** (our pipeline); **(b)** scripted REA sequence vs agentic REA (Claude picks tools); **(c)** spec with vs without the oracle (how many invented requirements were caught) | Eng 2 runs (a) and (c); Eng 1 runs (b) | One results slide from `agents/JOURNAL.md` |
| **Communication** | Three steps, three colours (amber REA → sky spec → green engine) used consistently in the terminal, cards and drawer; a 3-minute scripted demo; a backup video | Eng 3 | `3_feature_implementation/09_demo_runbook.md` |
| **Breadth & Complexity** | MCP (REA) + reverse engineering of Electron archives + Claude on Amazon Bedrock with structured outputs + sandboxed differential testing + TS compiler API + Sandpack live runtime | all | Architecture diagram (§1) on the Devpost and first slide |
| **Impact** | Teams re-implement the same proven features from scratch every day. Splice makes "reuse behaviour you're allowed to analyze" fast **and checkable** | all | The fused app solving a real user's problem (med-student study app) |
| **Challenge Navigation** | Real obstacles, handled creatively and logged as they happen (see the starter entries below) | all | "Obstacles we hit" slide from `agents/JOURNAL.md` |

### `agents/JOURNAL.md` — keep it during the build (2 minutes per entry)

Create it at H0. Every time you try an alternative or hit a wall, add a row. It becomes the
Curiosity and Challenge Navigation slides, and it's the honest answer to "what was hard?".

```markdown
| Time | Who | Tried / Obstacle | Result (numbers!) | Decision |
|------|-----|------------------|-------------------|----------|
| H0 | E1 | Planned docs used `npx rea-agents --mcp` and tools like `function_inventory` | Real CLI is `rea-agents mcp`; those tools don't exist | Verified the catalog via `tools/list` before writing code |
| H0 | E1 | Native decompiling on Windows | REA marks Windows Ghidra experimental | Live path = Electron `.asar` (no decompiler needed); native = replay-only stretch |
| H0 | E2 | Server-side refusal fallbacks | Not available on Bedrock | Client-side retry on a fallback model; card records which model answered |
| H? | E2 | Spec WITHOUT oracle vs WITH oracle on 4 features | e.g. 5 invented requirements caught, 3 repaired, 2 unverified | Oracle stays |
| H? | E2 | Direct reconstruction vs spec-first engines | e.g. direct: 3/4 pass own tests but 2/4 fail the oracle tests | Spec-first |
| H? | E1 | Scripted vs agentic REA collection | e.g. scripted 9 s avg, 100% symbols found; agentic 41 s, 75% | Scripted for demo |
```

Approach (a) costs one extra script for Eng 2 (`scripts/compareDirect.ts`): give the model the
original snippets and ask for the engine directly, then run the **oracle-verified** acceptance
tests against it. Approach (c) costs nothing: log `repair_attempts` and the first-attempt oracle
failures that `buildSpec` already produces. Do (a)–(c) after CP2, before the H18 freeze.
