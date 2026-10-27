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
| A large third-party main process is observable and specified at all | Obsidian runs, 2026-10-27 | Covered | 47 of 47 channels registered with 0 startup error, 263 usable observations, 0 coverage gaps, 6 exclusions |
| A subsystem of a real third-party app reaches scoped parity | Obsidian informational-channel run, 2026-10-27 | Covered | `ready: true`, public 5/5, final 5/5, `whole_app_ready: false` |
| The whole surface of a real third-party app reaches parity | Obsidian large runs, 2026-10-27 | **Open, close** | `public 144/144`, `repair 51/51`, `final 80/84` across 45 declared channels (`runs/large6`); the four held-out differences are specification content, not comparison fairness |
| A large subsystem of a real third-party app converges | Obsidian vault-registry runs | **Open** | Not converged in three attempts (see the subsystem table) |
| An unreproducible answer is excluded instead of verified | `test:electron-general`, Obsidian runs | Covered | every case observed twice; unstable cases dropped (`spec.unstable_cases`), channels that keep no case excluded (`host-variation`): Obsidian's `file-url`, `desktop-dir`, `sandbox`, `vault-open` |
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

## What a large application showed (Obsidian 1.14.5)

Obsidian is the largest target so far: a 73 KB `resources/app.asar` whose main process registers no
channel at all, plus a 28 MB `resources/obsidian.asar` holding the real main process (203 KB,
minified) and the renderer. Its main process registers **47 channels, all of them `ipcMain.on`
(sendSync), none of them `ipcMain.handle`**. Runs on 2026-10-27 used the second archive directly
(sha256 `3a349274f789…`, package name `obsidian-dev`, version 1.14.5).

The first attempt observed nothing at all; each step below is fixed and covered by
`npm run test:electron-general`.

| Symptom on the real app | Cause | Fix |
|---|---|---|
| The inventory refused the archive (`Electron main entry is missing: index.js`) and the launcher archive yielded 0 channels | `package.json` describes the launcher, not the payload; the archived module registers nothing as it loads and `module.exports` a function | shared entry resolution falls back to a conventional entry and reports `entry-fallback` (Obsidian: `main.js`); the worker invokes an exported initializer with the application directory and an event emitter |
| `Cannot find module 'original-fs'` | Electron-only module | `original-fs` resolves to Node's `fs` (nothing is packed here) |
| `Cannot find module .../lib/i18next.min.js`, then `path.join` on `app.name`, then `app.isDefaultProtocolClient is not a function`, `session.getUserAgent`, `webRequest.onBeforeRequest`, `Menu...popup`, `event.reply`, `webContents.printToPDF` | the mocked host exposed a thin Electron surface; every one is a hard crash or a false exclusion during startup | the host answers `app.name`/desktop integration, `protocol`, `systemPreferences`, `remote`, `session` (webRequest, user agent, spell-checker), a real `Menu` object, the event `reply` form, and printing/page capture |
| Every channel was registered but answered `undefined` | `ipcMain.on` handlers answer `ipcRenderer.sendSync` by assigning `event.returnValue`; the oracle read the handler's return value | sendSync is observed: the answer is the `returnValue` the handler assigned, and channel arity is the handler's parameters minus the event |
| 13 of 61 cases produced no usable observation (`Oracle worker exited 1: TypeError ... paths[0] ... undefined`) | a handler started work it never awaited; the rejection killed the worker, so the case was lost instead of recorded | the first error raised while a call is being answered is that call's outcome, the worker survives, and the next call is answered |
| A held-out `vault-list` sequence differed in a random vault id, although public and repair cases passed | the reproducibility check compared one case per channel; the random identifier appears only after a stateful call | every observed case is now re-observed in a second run and under a second host configuration; a case that changes is dropped and its shape reported |
| A held-out `vault-open` case expected the original's own random vault id, and a `set-icon` case expected a file the original never writes | two unstable cases outside the sample were graded as behavior | with the full second draw they are dropped like any other unstable case |

Obsidian's subsystem runs (2026-10-27, `--only`, three sizes):

| Subsystem | Scope | Result |
|---|---|---|
| Informational channels | `version`, `policy`, `resources`, `documents-dir`, `get-documents-path`, `file-url` (6 of 47) | **Scoped parity** (`runs/small`): `ready: true`, public 5/5, final 5/5; `file-url` excluded as unreproducible (its answer embeds a path-derived hash), `whole_app_ready: false` |
| Vault registry | `vault*`, `get-default-vault-path`, `get-sandbox-vault-path` (8 of 47) | **Not converged** in three attempts: `runs/medium2` public 41/41 and repair 15/15 but one held-out case expected the original's random vault id (that case is now dropped instead of graded); `runs/medium3` public 27/30, repair 5/7, final 11/18 (four channels shared one feature module, and the contract could not tell them apart — fixed); `runs/medium6` public 38/38, repair 15/15, final 15/23, all eight differences being the app's startup-written `userData/obsidian.json` (`{"vaults":{}}`) not promised by any requirement for those channels |
| Whole application surface | all 47 channels: 45 declared, 2 declared exclusions (`print-to-pdf`, `set-menu`), 3 unreproducible channels (`desktop-dir`, `file-url`, `sandbox`), 8 unstable cases dropped, 279 usable observations | **Visible partitions converge, 4 held-out cases differ** (`runs/large6`, current code): `public 144/144`, `repair 51/51`, `final 80/84`, 0 coverage gaps, 0 observation failures. All four differences are specification content: a default ad-block frequency (original 4, candidate 0), the startup `userData/obsidian.json` bytes for `disable-update`/`insider-build`, and a mutated-argument branch of `vault-open`. Earlier attempts: `runs/large3` 134/134 / 53/53 / 73/76, `runs/large4` 128/128 / 50/50 / 79/82 |

The large runs are the same application surface measured three times (three specification revisions from
the same model): the visible partitions converge exactly each time, and 3–4 held-out cases differ each
time on specification content, in different channels. The medium subsystem is the honest counterexample
to a simple "bigger is harder" story: it is small enough that its gaps show up in the held-out partition
rather than in the public one, and it did not converge in three attempts.

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
