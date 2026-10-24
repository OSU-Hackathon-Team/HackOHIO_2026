# 09 — Demo Runbook (whole team; owner: Eng 3)

## 1. Measure first (fill in at CP2, H14)

| Step (live) | Feature A: wiki graph | Feature B: SM-2 | Target |
|---|---|---|---|
| REA collect (warm) | | | < 15 s |
| Spec (Bedrock, incl. repairs) | | | < 60 s |
| Engine (Bedrock, incl. repairs) | | | < 45 s |
| **Harvest both (parallel)** | | | **< 120 s** |
| Synthesize + validate | | | < 75 s |
| Refine (edit) | | | < 45 s |

**Decision rule at H18:**
- Harvest ≤ 120 s → run the harvest **live** and talk over it (the script below is built for this).
- Harvest > 120 s → start the demo with `LLM_MODE=replay` for harvest (REA still live in
  `auto`), and run synthesize and refine **live**. Say so plainly: *"The harvest you're seeing is
  a recording of a live run from an hour ago. Fusion and refinement are live."*

## 2. Pre-flight (T−30 min)

- [ ] AWS session credentials are fresh (`aws sts get-caller-identity`); `npm run test:llm` passes
- [ ] Backend log shows `[rea] ready: N tools`; `GET /api/health` shows `rea.connected: true`
- [ ] Run one full warm-up of the golden path (it warms REA and the prompt cache), then **reload the page**
- [ ] `REA_MODE=auto`, `LLM_MODE=live` (or per the decision rule)
- [ ] Golden fixtures present: `fixtures/{evidence,specs,blueprints,transcripts,bundles}` for both demo features and the demo prompt
- [ ] Browser: 125% zoom, a fresh profile (no extensions), notifications off, laptop on power
- [ ] Phone hotspot ready as backup internet (Bedrock, Sandpack and the Tailwind CDN need it)
- [ ] Backup video (recorded at H20) open in a tab, ready to play
- [ ] Second terminal ready with `LLM_MODE=replay npm run dev:backend` (restart takes ~5 s)

## 3. The 3-minute golden path

**0:00 — Hook (while clicking Harvest).** Select *Inkwell → Wiki-link graph* and *Recall → SM-2
spaced repetition*, then press **Harvest 2 features**.

> "Lovable and v0 write apps from scratch, and they guess. But the best version of a feature
> usually already exists inside some app you use. Splice takes it out of the shipped app,
> proves what it does, and rebuilds it so you can reuse it. These are two Electron apps we
> built as stand-ins. Splice only sees their packaged `.asar` files."

**0:20 — Step 1 (terminal, amber).** Point at the REA calls streaming in.

> "This is REA, an open-source reverse-engineering MCP server. It's analyzing the packaged
> app's module graph and tracing the feature. It never runs the app."

**0:45 — Step 2 (card turns sky).** Flip the SM-2 card to X-Ray.

> "From what REA located, Claude writes a spec: eight numbered requirements, each citing the
> exact source lines, plus tests. Then we run those tests **against the original app's code**.
> If Claude invented a behaviour, the original fails the test and the spec gets corrected.
> 7 of 7 pass against the original."

**1:15 — Step 3 (card turns green).** Open the drawer → **Tests: original vs engine**.

> "A separate step writes a brand-new engine from the spec alone. It never sees the original
> code. Same tests: left column is the original app, right column is the new engine. Both
> green."

**1:40 — Fuse.** The prompt is pre-filled. Press **⚡ Fuse**.

> "Now we combine them. One prompt: a study app for a med student."

While it generates (~45 s): open the **Code** tab, point at `/engines/` (read-only) vs `/App.tsx`.

> "The UI is generated, but the engines are injected byte-for-byte and type-checked against.
> The model can't touch them."

**2:25 — Use the app.** Add a note containing `[[Cardiology]]`, then show the backlink appear.
Review a card, grade it 4, and show the due date move to +6 days.

**2:45 — Refine.** Click the chip *"Add a 'Due today' filter"*. While it runs:

> "Refinement only changes the UI. The verified engines stay locked."

**3:00 — Close.**

> "Splice: don't guess the wheel. Harvest it, prove it, rebuild it."

## 4. Golden-path prompt (keep byte-identical; replay keys depend on it)

```
Build a study app for a medical student: notes link to each other with [[wiki links]], show each note's backlinks, and turn every note into a flashcard scheduled with spaced repetition. Show what's due today.
```

## 5. When things break on stage

| Symptom | Do this (no apologies, one sentence to the audience) |
|---|---|
| REA call errors / slow | Nothing. `auto` falls back to recorded evidence and the terminal says so. "REA hit a snag. It's using evidence recorded from a live run earlier." |
| Bedrock error / credentials expired | Switch to the replay backend (second terminal), reload, re-run. Say: "Switching to a recorded run." |
| Synthesis takes > 90 s | Keep talking through the drawer's test table. If still stuck at 2:30, load `fixtures/bundles/<demo>.json` (the hidden `?bundle=golden` URL param) |
| Sandpack runtime error | Auto-fix kicks in. Narrate it: "It found a runtime error and is fixing itself." |
| No internet | Play the backup video |

## 6. Judge Q&A — honest answers

| Question | Answer |
|---|---|
| "Are these real apps?" | "They're real Electron apps that we wrote for the demo, so we have the right to reverse-engineer them. REA treats any Electron `.asar` the same way." |
| "Is this clean-room?" | "Not in the legal sense. It's spec-first: the code-writing step never sees the original source, and the spec is checked against the original's behaviour. A legal clean room needs separate teams and process." |
| "How do you know the spec is right?" | "Every acceptance test runs against the original code through a thin adapter, and the sandbox counts calls into the original, so a test can't pass without exercising it." |
| "What about compiled binaries?" | "REA supports native and .NET targets. Our live path is JavaScript because native decompilers on Windows are experimental, and an un-executable target gets marked 'unverified' rather than faked." (Show the stretch card if built.) |
| "Which model?" | "Claude Opus 5.5 on Amazon Bedrock, with structured outputs. Each card records which model answered." |
| "What if it's wrong?" | "Then the card says so: amber 'unverified', with the open issues listed. We never show a green check we didn't earn." |
| "Legal / IP concerns?" | "Only use it on software you have the right to analyze. Splice reconstructs behaviour from a spec; it doesn't copy code." |

## 7. Submission checklist (H22–H24)

- [ ] Devpost: problem, how it works (the 3-step diagram from `agents/README.md`), honest limitations, team
- [ ] README with setup (Node 22.19+, AWS Bedrock access, `npm run build:targets`, `npm run dev`)
- [ ] Backup video (≤ 3 min) uploaded
- [ ] Screenshots: terminal mid-run, X-Ray card, original-vs-engine table, fused app
- [ ] Repo clean: no `.env`, no `*.latest.json`, AWS keys revoked and history rewritten
