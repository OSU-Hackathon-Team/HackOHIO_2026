# Stupid Decomp Engine — plan (branch `chore/stupid-decomp-engine`, worktree `/tmp/stupid-engine`)

Status: planning, updated 2026-10-24. Work happens in this worktree only; `dev` stays clean.

## 1. Goal

Make the decomp engine stupid. All judgment moves into agents; our code keeps only
mechanics: content-addressed artifacts, thin Ghidra evidence export, parallel fan-out,
and collecting agent JSON. Anything hard-coded that decides *what* the binary means
must go or become an agent decision.

Target shape:

```
user goal + binary
  -> orchestrator agent (decides what needs decomp'd, seeds, scope, done-ness)
    -> N parallel decomp agents (each: raw evidence in, claims + citations out)
      -> review agents (challenge claims against raw evidence)
    -> spec agents (accepted claims in, prose spec out)
```

Code owns: artifact hashing, process spawning, timeouts, JSON plumbing.
Agents own: seeds, scope boundaries, priorities, claim validity, readiness, blockers.

## 2. What is hard-coded today (to kill or shrink)

Inventory (worktree `HEAD 6860517`):

| File | Lines | Hard-coded judgment to remove |
|---|---|---|
| `launch.py` | 1091 | ~40 subcommands (`queue-*`, `project-*`, `review-*`, `gap-*`, `coverage-*` …). Replace with 3: `stupid-run`, `stupid-status`, `stupid-spec`. |
| `engine/queue.py` | 1517 | Priority classes, aging, leases/fencing/epochs, dedup keys, retry classification. Replace with dumb FIFO + agent-chosen priorities, or just `ThreadPoolExecutor` fan-out with file artifacts (no Postgres). |
| `engine/scope.py` | 315 | Seed scoring (100/90/85/55/40/35), heap BFS, priorities 80/65/35, depth/budget cutoffs, thunk/external/boundary rules, canned task question. Orchestrator agent decides all of this. |
| `engine/worker.py` | 300 | 40-line hand-tuned prompt, evidence allowlist, 60 kB truncation, `validate_answer`/`normalize_*` shape police. Workers get evidence + goal and return self-shaped claims; a review agent (not regex) checks citations. |
| `engine/validation/*` (6 files) | ~1100 | `review.py`, `dependencies.py`, `gaps.py`, `coverage.py`, `fixed_memory.py`, `memory_ranges.py`, `probes.py`. Keep only probe *execution* (run binary, record I/O). Verdicts become review-agent jobs. |
| `engine/dossier.py` | 549 | ~10 blocker kinds, `ready_for_spec iff claims and not blockers`, markdown renderer. Readiness/blockers become orchestrator-agent verdict over agent outputs. |
| `engine/specification.py` | 393 | Schema-2 prose rules enforced in code. Become spec-agent instructions; code only checks "no addresses/asm" by trivial grep, or leaves even that to a checker agent. |
| `engine/findings.py` | 306 | Conditional publish, invalidation graph, contract versioning. Replace with append-only agent claims; conflicts stay visible, orchestrator picks. |
| `engine/project_scope.py` + `project_queue.py` | ~400 | Cross-module binding heuristics + per-module queue fan-out. Orchestrator agent handles module choice; one generic fan-out covers both. |

Keep (dumb, no judgment): `engine/artifacts.py` (hash store), `engine/analysis/ghidra.py`
evidence export restricted to `function` / `references` / `strings` / `calls` / `range`
(raw bytes + addresses, no interpretation), `engine/model_runtime.py` (spawn model, return text).

Drop the Postgres requirement on this branch: file artifacts + thread/process pool are
enough for 1 → 16 local workers; durable multi-host queue returns only if agents prove
they need it.

## 3. Least-code design

New surface (target ≤ 400 lines of our code total):

- `engine/stupid/tools.py` — thin wrappers: `export_function(entry)`, `export_refs(entry)`,
  `export_strings()`, `export_calls()`, `run_probe(binary, argv/stdin)` → bytes in, artifact hash out. No scoring, no filtering.
- `engine/stupid/orchestrator.py` — loop: (a) ask orchestrator agent "what next?" with
  (goal, artifact inventory, agent results so far); (b) execute the tool calls it asks for
  or spawn the worker agents it names; (c) repeat until it emits `DONE` + readiness verdict.
  Code never interprets results, only routes them.
- `engine/stupid/prompts.py` — four prompt templates as data (orchestrator, decomp worker,
  reviewer, spec writer), each with: role, inputs, output JSON shape, "cite raw addresses,
  admit unknowns" rule. Tuning happens in prompts, not in `if` statements.
- `launch.py stupid-run --binary --goal --max-workers` — one entry point; `--max-workers`
  only sizes the pool.

Parallelism: `concurrent.futures` over worker agents (local first; same JSON protocol works
over containers later). Reviews run in the same pool. No leases/epochs — idempotent artifact
hashes make retries safe (re-running same input hash returns same artifact).

## 4. Sequence

1. **Small fixture** (`fixtures/decomp/native_lab.c`: `parse_frame`, `accept_even`,
   `reset_state`, `read_*`, `fold_depth` — 6–8 functions, known source, 4-6 probes in
   `probes.json`). Prove: orchestrator picks seeds from goal alone, workers produce cited
   claims, reviewer catches at least one planted wrong claim, spec agent writes prose spec
   with zero addresses. No `scope.py` scoring allowed — orchestrator must do seed/scope work.
2. **LibreOffice stress** (`stress_test_calc_formula_engine.py`: 50-function scope from
   seed `CompileTokenArray`, 32 probes, cleanroom reimplementation must pass 100%).
   Prove the same loop scales: orchestrator fans out 16+ workers, agents (not code) handle
   precedence/grammar/VectorRefArray claims. Existing stress script becomes the acceptance
   harness, not the implementation.
3. Delete-or-gate the old code path once (1) passes: keep old files untouched until the
   stupid loop matches small-fixture quality, then remove `queue.py`/validation rules in a
   follow-up commit.

## 5. Acceptance (agent-does-it gates)

- Scope: our code contains no seed scores, no priority numbers, no depth/budget cutoffs.
  Test: `rg -n "score|priority.*80|70|max_depth|boundary_contract" engine/stupid/` returns nothing; scope output differs when the *agent* is asked twice, not when a constant changes.
- Decomp: worker prompt is data, not string surgery in `worker.py`; adding a new claim
  shape needs no code change.
- Review/spec: no Python function returns `supported_static`/`blocked`/`ready_for_spec`
  verdicts — those strings appear only in agent outputs and prompt templates.
- Small fixture end-to-end runs with `--max-workers 4` and produces a prose spec; LibreOffice
  run fans out to 16 workers on one host.
- Docs updated here first (this file + §6 pointers); implementation follows.

## 6. Doc updates on this branch

- `DecompPileline.md`: add "Stupid-engine direction" pointer to this file (this branch only).
- `DECOMP_IMPLEMENTATION_PLAN.md`: mark M2–M5 gates as "under agent-first rewrite on this
  branch; see STUPID_ENGINE_PLAN.md" — no milestone claimed complete here.
- `.agents/README.md` "Current state": one line noting the stupid-engine worktree/branch
  and that old-engine files are frozen there until the stupid loop passes the small fixture.
- This file is the source of truth for the rewrite until it lands.

## 7. Open questions for the user (before code)

1. May the stupid loop drop Postgres/file-queue durability on this branch (artifacts + rerun suffice)?
2. May worker agents see demangled/symbol names, or stripped-only like evaluators?
3. Is "orchestrator decides DONE" acceptable, or must a human still approve `ready_for_spec`?

## 8. Decisions (2026-10-24, user-confirmed)

1. **Durability: files only.** No Postgres on this branch. `ThreadPoolExecutor` fan-out,
   `LocalArtifactStore` on disk, idempotent hashes make rerun safe.
2. **Stripped-only workers.** Agents see `FUN_<entry>`-style placeholders + raw bytes and
   addresses; real/demangled names are held out for evaluation. The tools layer redacts
   names before handing evidence to agents.
3. **Agent decides DONE.** The orchestrator agent emits `DONE` + readiness verdict; human
   reviews after. No human approval inside the loop.
4. **Live-model gate.** AWS session creds in this environment are expired, so no
   implementation runs until the user refreshes creds. Skeleton code lands only after a
   live-model smoke check passes on this branch.

## 9. Small-fixture proof (2026-10-24, live Qwen via Bedrock)

Command: `python3 launch.py stupid-run --binary decomp-state/fixtures/native_lab_O0_shared.so
--goal "Describe the frame-parsing subsystem..." --max-workers 4 --max-rounds 12`.
Five live runs total; final run `cb7df4154477`:

- Agent-chosen scope (no seed scores in code): 12 entries covering all 8 real
  subsystem functions (frame decoder, callback helper, state reset, 3 state
  readers, recursive helper, entry point) plus init/fini boilerplate.
- 19 drafts (incl. 7 agent-triggered redrafts), 15 reviews, verdicts
  3 supported / 1 uncertain / 8 contradicted. All 4 boilerplate drafts were
  contradicted (correct); all 3 state readers supported; the frame decoder
  stays contested on endianness explicitness (reviewer demands the omitted
  detail be stated; honest partial, not a false pass).
- Prose spec ~5 kB, concrete values and examples; one `param_1` leaked inside
  a C prototype in run 5 -> SPEC prompt now forbids code blocks entirely
  (prompt-data fix, validates on the next run).
- Readiness `partial` via the 3-consecutive-no-op mechanical budget, with
  reasons in the log. No `ready_for_spec` was claimed without reviews.
- Stripped-only held: agents saw `FUN_<entry>` placeholders; dynamic symbol
  names are exact-match redacted from inventory strings; real names never
  left `tools.py`.
- Cost note: `engine/stupid/` is 457 lines (over the 400 target; provenance
  persistence and the noop budget account for the drift).

Open tuning (prompts, not code): reviewer calibration on "incomplete vs
false", orchestrator `done` decisiveness. LibreOffice scale-up is next (section 4,
step 2): 50-function scope from `CompileTokenArray`, 32 probes, 16 workers.
Known risks: 606-function inventory exceeds the 60 kB orchestrator prompt
window (needs paging or agent-driven inventory queries); Ghidra export time
for 50 functions; model nondeterminism across the wider scope.

## 10. LibreOffice scale-up (2026-10-24/25, live Qwen via Bedrock, 16 workers)

Target: `decomp-state/fixtures/calc/libforlo.so`, sha256 `5fb252ad…cd03c`, the same binary
`spec/modules/calc_formula_engine.md` verifies against. Inventory: 606 functions, 121 thunks,
2018 call edges, 1055 strings, **268 exported addresses**, campaign `53c336ec…9b659`.
Goal: "token array compilation, opcode dispatch, and interpreter value handling".

The first runs stalled at 2-6 drafts. Each failure had a mechanical cause, and each fix was
routing/state work in `engine/stupid/`, not judgment added to code:

| Symptom | Cause | Fix |
|---|---|---|
| `explored` stayed empty, agent asked for `export_entries` once and got a no-op | export list was never seeded, so every `decompile` key was "unexplored" | large binaries preseed `explored` from the export table (268 keys) at analyze time |
| run ended at round 7 of 40 with 6 drafts | three repeated plans tripped a 3-no-op guard | guard at 5, and a no-op now reports the streak, how many explored entries are still undrafted, a 40-key sample, and which drafts still need review |
| 33 of 60 actions replayed the *prompt's own example* (`resolve_symbol CompileTokenArray`, `neighbors 0011b900`) | few-shot anchoring on a concrete key | prompt examples are placeholders; `state.exhausted` lists actions that already returned everything they can |
| 20 invented addresses (`00104795`) decompiled twice | `last_result` only said "unknown_entry", never which key or why | rejected/unexplored keys are echoed with the reason |
| `probe` requests looked like progress but executed nothing | no probe adapter attached to this harness | recorded as `probe_requested` with `executed: false`, counts as no-change |
| 6 drafts was the ceiling with 16 idle workers | every decompile step named 1-3 entries | a decompile step may say `entries: "*"` with its own `limit`; the harness expands it to explored-but-undrafted keys, capped by the agent's limit |
| 127-fact run produced a 2 kB spec | facts JSON was cut mid-array at 60 kB | facts project to claim statements + verdicts, whole entries added until the budget ends (`spec_facts` log: `scoped`/`sent`) |

Scale results, final three runs (`decomp-state/stupid/<id>/result.json`):

- `07d42de2cc07`: **127 drafts, 80 reviews**, verdicts 25 supported / 19 uncertain /
  36 contradicted, scope 127, spec 2.0 kB, no address leaks, readiness `partial`,
  13 orchestrator rounds of 24.
- `0bb7b9ae8bb1` (40 rounds): **130 drafts, 59 reviews**, 23 / 12 / 24, scope 130,
  spec 3.4 kB with no `FUN_`/`param_` leaks, `spec_facts` sent 69 of 130 entries
  (59.4 kB budget), readiness `partial`, 12 orchestrator rounds.
- Small fixture re-run after all of the above (`native_lab_O2_shared.so`, 4 workers,
  6 rounds): 18 drafts, 14 reviews, 3 supported / 11 contradicted, spec 3.0 kB, no leaks,
  readiness `partial` — no regression from the scale work.

What this proves: Ghidra analysis, 268-key export preseed, 16-worker fan-out, review and
spec writing all hold at 606-function scale, and coverage is now bounded by the planner's
rounds rather than by the harness. Readiness never claimed `ready_for_spec`.

Known limits, in the order they hurt:

1. **Planner breadth is the binding constraint.** Qwen3-Coder still spends ~24 actions per
   run on repeated or rejected keys, and a run ends on the 5-no-op guard at round 12-13 of
   40. Claude as planner is not available on this account: `anthropic.claude-opus-4-6-v1`
   needs an inference profile, `us.anthropic.claude-opus-4-5-20251101-v1:0` answers a smoke
   test but the run is refused with `AccessDeniedException` (Marketplace subscribe). The
   `orchestrator` role is in place, so `MODEL_ORCHESTRATOR` swaps a planner as soon as one
   is enabled.
2. **Redrafts still eat the budget.** 12 per run, then `redraft_exhausted`; on libforlo the
   planner spends them on the first contested entry instead of widening.
3. **The spec is the thin end.** 130 functions became ~420 words with generic filler at the
   tail ("ISO standards", "legacy documents") that no draft supports, and only 69 of 130
   facts fit the budget. The spec writer needs chunked synthesis (per-cluster drafts, then a
   merge pass) before a wide scope can produce a trustworthy document.
4. **No probe execution** in this harness, so grammar-probe evidence (section 4, step 2) is
   still unexercised; `scripts/calc_grammar_probe_adapter.py` is the intended seam.
