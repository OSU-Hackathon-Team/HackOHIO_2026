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
