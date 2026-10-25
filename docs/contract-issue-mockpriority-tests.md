# Contract mismatch: `mockpriority.priority_score` acceptance tests

> **Status: fixed locally, not committed (2026-10-24).** The fixture's tests were converted as
> described under "Fix". The live rerun gave `PASSED 5/5 tests · repairs 0 · 6.2s` (Qwen3 Coder 480B).

**File:** `fixtures/specs/_seed/mockpriority.priority_score.json`, added in `bb1ef5e`
**Effect:** In live mode, Step 3 can't build an engine from this spec. Every run fails before any test executes.

## What happens

Running the spec through the application phase live (Qwen3 Coder 480B on Bedrock, 2026-10-24):

```
npm run test:implement -w @splice/backend -- mockpriority.priority_score

[implementing] Implementing priorityScore from 5 requirements (original source withheld)
[testing] Running the acceptance tests against the new engine
[repairing_engine] Repair 1/2: 1 failure(s), e.g. Sandbox: Test file failed to load:
  Error: require('vitest') is not allowed here; the code must be self-contained
[repairing_engine] Repair 2/2: ... same error ...
→ FAILED  0/0 tests · purity 0 · type errors 0 · repairs 2 · 16.3s
```

The engine the model wrote was never tested. The test file itself won't load, so both repairs, which can only change the engine, are wasted Bedrock calls.

## The mismatch

The contract, `agents/CONTRACTS.md` (around line 529), says acceptance tests run with:

> globals: `test`, `assert`, plus every export of the module under test

That means no `import` statements and no `expect`. The sandbox (`packages/backend/src/sandbox/worker.cjs`) injects exactly those globals and rejects `require`/`import`. That's intended: it keeps engines and tests self-contained.

The mock is written for Vitest instead:

```ts
import { test, expect } from "vitest";                              // not allowed
import { score_task_priority, urgency_bucket } from "./index.js";   // not needed: exports are globals

test("REQ-1: Completed tasks score 0 ...", () => {
  const score = score_task_priority({ completed: true, importance: 5, due_epoch: 0 }, 100000);
  expect(score).toBe(0);                                            // no `expect` global
});
```

For comparison, `fixtures/hand-authored/specs/recall.sm2_scheduler.json` follows the contract and passes live.

## Fix

Change only the `acceptance_tests` string in the fixture:

1. Delete the two `import` lines.
2. Replace each `expect(X).toBe(Y);` with `assert.equal(X, Y);`. `toBe` is the only matcher used, across all 5 tests.

```ts
test("REQ-1: Completed tasks score 0 regardless of due date or importance.", () => {
  const score = score_task_priority({ completed: true, importance: 5, due_epoch: 0 }, 100000);
  assert.equal(score, 0);
});
```

Other assertions the sandbox supports, if you need them: `assert.deepEqual`, `assert.ok`, `assert.approx(actual, expected, tol)`, and `assert.throws(fn, RangeError | "RangeError")`.

Then check it with:

```bash
npm run test:implement -w @splice/backend -- mockpriority.priority_score
# expect: → PASSED  5/5 tests
```

## Why the e2e test didn't catch it

`tests/studio/workflow.spec.ts` ("Native · Task Priority") runs in replay mode, using the pre-recorded `fixtures/hand-authored/transcripts/mockpriority.priority_score.json` and the hand-written blueprint. Replay never sends the test file to the sandbox, so the bad format only shows up in a live run.

## Scope

A search of `engine/`, `packages/backend/src/`, `scripts/` and the spec fixtures finds Vitest syntax only in this one fixture. No generator produces it, so fixing the fixture is enough. If the mock was copied from a template or another agent's output, fix that source too, so the next mock follows the contract.
