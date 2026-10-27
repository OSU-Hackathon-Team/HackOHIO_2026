# Electron readiness ledger

This ledger tracks what the two-stage reconstruction pipeline verifies today, how to reproduce each
claim, and which parts of `electron-spec.md` remain open. It is deliberately narrower than the plan:
a row is only "covered" when a command produces the evidence.

| Gate | Command or procedure | Status | Evidence |
|---|---|---|---|
| Static inventory of an archive (main, preload, IPC arity, bridges, assets, diagnostics) | `npm run electron:analyze -- <app.asar>` | Covered | `scripts/electron/analyze-archive.mjs`, `tests/analyze-archive.test.mjs` |
| Behavioral oracle for a packaged app (values, errors, files, effects) | `npm run test:electron-general` | Covered for CJS and ESM main processes | `oracle.mjs`, synthetic and Inkwell/Recall oracle tests |
| Specification stage writes a validated, coverage-complete spec | `npm run electron:reconstruct -- <asar> <out>` (stage 1) | Covered for tested applications | `agent-tools.mjs`, `spec.mjs`, run report `spec` block |
| Implementation stage sees only the public handoff | `npm run test:electron-general` ("implementation workspace never contains the original app") | Covered | `implement-tools.mjs`, handoff test |
| Coverage gates reject error-only or unreachable channels | `test:electron-general`, `agent-tools` test | Covered | `cases.mjs` coverage and shape-stratified partitions |
| Public / repair / final partitions are distinct and final never feeds back | `test:electron-general` | Covered | `partitionCases`, pipeline feedback code |
| Intermediate file effects, deletions and byte content compared | `test:electron-general` | Covered | `compareCase` |
| Unusable original observations are visible readiness blockers | Report `observations.failures` | Covered | `observationFailures`, report `readiness.blockers` |
| Declared channel exclusions are explicit, reasoned and reported | Exclusion test in `test:electron-general` | Covered | `spec.mjs`, `project.mjs` manifest `excluded_channels` |
| Renderer workflows and original UI parity | — | Open | Generated renderer only |
| Menus, tray, dialogs, notifications, protocol handlers, updater | — | Open (channels depending on them are declared exclusions) | `channel_exclusions` |
| Real Electron observation harness (not only the mocked host) | — | Open | `oracle.mjs` is a mocked host |
| Independent human review of specifications and exclusions | — | Open | exclusions are agent-declared |
| OS matrix / display-capable CI for Electron runtime | — | Open | `electron:smoke` needs xvfb and a local install |
| Step 1–3 Studio gates and live REA acceptance | see `.agents/build-and-run.md` | Out of scope for this ledger | separate track |

## Reading a run

`reconstruction-report.json` is the artifact of record:

- `spec.sha256` binds the run to one specification revision; `spec.channel_exclusions` lists
  channels the specification stage declared out of scope with reasons.
- `partitions.public|repair|final` show cases, passes, per-channel coverage and gaps. A partition
  with fewer cases than its channel needs reports a gap instead of inflating the score.
- `observations` records generated cases, usable expectations and every observation that produced
  none (crashed worker, unregistered channel, startup rejection).
- `readiness.ready` is true only with no failing case, no gap, no observation failure and no
  declared blocker. `readiness.whole_app_ready` additionally requires zero exclusions.

## Reproducing acceptance locally

```bash
npm ci
npm run test:electron-general                      # no credentials
AWS_PROFILE=... npm run electron:reconstruct -- \
  targets/build/recall/app.asar /tmp/recall-out \
  --state /tmp/recall-state --spec-rounds 2 --impl-rounds 3 --spec-timeout 900 --impl-timeout 900
jq '.readiness, .partitions' /tmp/recall-out/reconstruction-report.json
cd /tmp/recall-out && npm install && npm start     # needs Electron and a display
```

Model access is the only credentialed dependency. When a run fails, read the report before the
agent logs: partition failures mean behavior differs, observation failures mean the oracle could
not see the app, and spec blockers or exclusions mean the specification stage gave up on a channel.
