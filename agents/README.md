# Splice — Engineering Playbook (start here)

This folder is the build spec for Splice. It replaces the high-level plan in
`hackathon_master_plan_rea_lovable.md` wherever the two disagree, and it replaces
the older flat files `agents/reverse_engineering.md`, `agents/feature_extraction.md`
and `agents/implementation_and_frontend.md`.

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

> ⚠️ **Exact argument names for each tool are NOT confirmed.** The first job of Engineer 1 is
> `npm run rea:catalog`, which writes the real input schemas to `fixtures/rea/tools.json`. All
> argument names in these docs that are marked `// VERIFY` must be checked against that file.

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
├── .env.example                # ANTHROPIC_API_KEY=, SPLICE_MODEL=, REA_MODE=, LLM_MODE=
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

`ANTHROPIC_API_KEY` lives **only** in `packages/backend/.env` (gitignored). The frontend never
sees it.

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
- Model: `claude-opus-5-5` (set via `SPLICE_MODEL`). Do not hard-code other model IDs.
