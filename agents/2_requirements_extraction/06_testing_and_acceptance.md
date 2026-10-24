# 06 — Testing & Acceptance (Step 2)

## 1. Scripts (`packages/backend/package.json`)

```json
"test:llm": "tsx src/scripts/testLlm.ts",
"test:sandbox": "tsx src/scripts/testSandbox.ts",
"test:spec": "tsx src/scripts/testSpec.ts",
"spec:all": "tsx src/scripts/specAll.ts"
```

### `src/scripts/testSpec.ts` — `npm run test:spec -- recall.sm2_scheduler`

Runs Step 2 alone on recorded (or seed) evidence. No REA needed.

```ts
import { loadPantry } from "../routes/step1/index.js";
import { loadRecordedEvidence } from "../evidence/replay.js";
import { buildSpec } from "../spec/buildSpec.js";
import { saveSpec } from "../spec/store.js";

const featureId = process.argv[2] ?? "recall.sm2_scheduler";
const pantry = await loadPantry();
const app = pantry.apps.find((a) => a.features.some((f) => f.feature_id === featureId))!;
const feature = app.features.find((f) => f.feature_id === featureId)!;
const ev = await loadRecordedEvidence(featureId);
if (!ev) throw new Error(`no evidence for ${featureId} (run npm run seed:evidence)`);

const t0 = Date.now();
const spec = await buildSpec({ ...ev, mode: "live" }, app, feature, {
  onStage: (s, m) => console.log(`[${s}] ${m}`),
  onProgress: () => {},
  onTestResult: (t) => console.log(`  ${t.passed ? "✓" : "✗"} ${t.name}${t.error ? "  — " + t.error : ""}`),
});

console.log(`\n${spec.consumer_title} — ${spec.status.toUpperCase()} in ${Date.now() - t0}ms, ${spec.repair_attempts} repair(s), model ${spec.provenance.model}`);
console.table(spec.requirements.map((r) => ({ id: r.id, kind: r.kind, statement: r.statement.slice(0, 90), refs: r.source_refs.join(" ") })));
console.log("interface:", spec.interface.exports.map((e) => `${e.name}${e.kind === "function" ? e.signature : ""}`).join("\n           "));
console.log("oracle:", spec.oracle.status, `${spec.oracle.passed}/${spec.oracle.total}`);
console.log("stripped glue:", spec.stripped_glue.join("; "));
if (spec.open_issues.length) console.log("OPEN ISSUES:\n - " + spec.open_issues.join("\n - "));
await saveSpec(spec);   // → fixtures/specs/<id>.latest.json (seed evidence is forced to mode "live" for this dev run only)
```

> `{ ...ev, mode: "live" }` only exists so dev runs on seed evidence get saved. Golden specs
> for the demo must come from `/api/extract` runs on **real** recorded REA evidence
> (`provenance.tool_calls` non-empty).

### `src/scripts/specAll.ts`

Loops `testSpec` logic over all 4 features and prints one summary row each:
`feature | status | reqs | oracle passed/total | repairs | seconds`. Run it after every prompt
change and paste the table into team chat.

## 2. Quality rubric — what a good spec must contain (from the target source)

The sandbox can't judge whether requirements are **complete**, only whether they're
**correct**. A human checks completeness against this list. Each spec should capture most of
these (≥ 80%) before you promote it.

**recall.sm2_scheduler**: see `CONTRACTS.md` §9 (8 requirements).

**recall.review_streaks**
- duplicate dates count once; input order doesn't matter
- empty input → `{ current: 0, longest: 0, lastReview: null }`
- longest = longest run of consecutive calendar days
- current counts back from the last review only if it was today or yesterday; otherwise 0
- `lastReview` is the latest date as `YYYY-MM-DD`
- (quirk) a review dated in the future still counts as current

**inkwell.wikilink_graph**
- parses `[[Target]]`, `[[Target|alias]]`, `[[Target#Heading]]`, `[[Target#Heading|alias]]`; trims parts
- links inside fenced code blocks (```` ``` ````) and inline `` `code` `` are ignored
- titles match case-insensitively with whitespace collapsed
- self-links ignored; duplicate links between the same two notes produce one edge
- unresolved targets are listed per source note (duplicates kept)
- backlinks list sources in note order; every note has a (possibly empty) backlink list
- degree = number of edges touching the note, both directions

**inkwell.fuzzy_search**
- case-insensitive subsequence match; no match → excluded (score `null`)
- empty query scores 0 (every note matches)
- spaces in the query are skipped
- +1 per matched char, +5 consecutive, +10 at a word boundary (start, or after space `-` `_` `/` `.`), +3 at index 0
- penalty: `floor((titleLength − queryLength) / 10)`
- sort by score desc, ties by title (`localeCompare`); default limit 10

## 3. Step 2 acceptance gate

- [ ] `npm run test:llm` passes on all three machines (H4)
- [ ] `npm run test:sandbox` passes, including the cheating-adapter and infinite-loop cases (H4)
- [ ] `npm run spec:all` → all 4 features `VERIFIED`, ≤ 1 repair on average, each < 90 s
- [ ] Each golden spec meets ≥ 80% of its rubric above; reviewed by a second engineer
- [ ] `POST /api/extract` streams the event sequence in `01` §1 end-to-end, live REA + live Bedrock
- [ ] `REA_MODE=replay` and `LLM_MODE=replay` both work, and replayed specs carry `provenance.mode: "replay"`
- [ ] Closing the browser tab mid-extraction aborts the Bedrock stream (check the server log: no completed call afterwards)
- [ ] Golden specs committed in `fixtures/specs/` with real `tool_calls`; `_seed` specs deleted at CP2
