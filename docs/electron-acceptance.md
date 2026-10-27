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
| Intermediate file effects, deletions and byte content compared | `test:electron-general` | Covered | `compareCase` (log files excluded, see below) |
| A specification for a real third-party app is accepted | Stretchly run, 2026-10-27 | Partially: accepted for 18 of 28 channels | Run log `stretchly10`: 28 channels discovered, 180 observable cases, 0 coverage gaps, 10 declared exclusions |
| A real third-party app reaches parity | Stretchly run, 2026-10-27 | **Open** | `public 0/99`, `repair 0/29` in three implementation rounds; the candidate does not reproduce the app's 16 KB default `config.json` |
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

## What a real application showed (Stretchly 1.22.1)

The pipeline was run against a packaged third-party app of 28 IPC channels on 2026-10-27
(`/mnt/nvme1n1/scratch/state/stretchly10`, archive sha256 `152ed0996091…`). Built-in apps cannot
show these failures because their behaviour, host surface and file sizes are small. Every item
below except the last is fixed and covered by `npm run test:electron-general`.

| Symptom on the real app | Cause | Fix |
|---|---|---|
| The specification round ended with 12 of 28 channels; a 58 KB probe reply filled the context window | every probe returned each persisted file in full, twice (snapshot and diff) | bounded probe replies (4000 characters per changed file, size and digest index) plus an `oracle_file` tool for exact bytes |
| Fourteen channels were excluded for host reasons: `appIcon.setImage`, `globalShortcut.isRegistered`, `screen.getDisplayNearestPoint`, `session.getPreloads` all missing | the mocked host exposed a thin Electron surface, so the app's own data behaviour failed | host answers `Tray`, `nativeImage`, `screen` displays, the platform `app.getPath` keys, `globalShortcut` and `session` |
| `get-window-bounds` answered with the mock's window bounds, which would have been verified as app behaviour | the comparison could not tell host state from app state | each channel's case is replayed under a second host configuration; a result that changes there is reported as a host-dependent exclusion |
| Channels returning a path could never match, and were excluded as host-dependent | each observation runs in its own directory, so the path differs between the original and any reimplementation | values, error messages and file content report the storage root (`userData/...`) instead of its absolute path |
| No case involving a channel that logs could be compared | electron-log timestamps every line with the real wall clock, not the frozen `Date` | `*.log` files are diagnostics: they are reported as reads and writes and excluded from byte comparison |
| A constant result could never satisfy the coverage gate (`get-version` cannot produce three outcomes, and a zero-argument channel cannot produce six cases) | the gate asked for breadth a channel cannot supply | reachability is the blocking gap; one-outcome channels are reported as `narrow`, and partition minimums scale to the cases a channel has |
| An implementation round ended with `spawn E2BIG` | 157 failing cases were passed in the prompt | the prompt carries a bounded summary and points at `failures.md` in the handoff |
| **Every case still failed** (`public 0/99`, `repair 0/29`) | the specification describes the channels but not the app's persisted default state: the original writes a 16 KB `config.json` (tab indentation, key order, `__internal__.migrations`) before/while answering, and no requirement states those bytes | **Open.** The comparison is fair (the original's own bytes are the expectation), the candidate is assembled and registered, and the driver reports no coverage gap, so the remaining work is specification content: a channel whose behaviour includes a large persisted default has to state it, which the agent can read with `oracle_file`. |

The run's own numbers are honest about the outcome: `readiness.ready` is false, `whole_app_ready`
false, ten exclusions listed with reasons, no coverage gap or observation failure recorded.

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
