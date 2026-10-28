# Handoff: faster decompilation with REA and a Ghidra MCP server

**For:** whoever owns native decompilation (`engine/`, `launch.py`, `agent_worker.py`) and the Step 1 REA path.
**Problem:** decompiles take a long time, and the output is mostly junk.
**Read with:** `agents/1_reverse_engineering/` (REA facts), `DecompPileline.md` (engine design), `.agents/gotchas.md` §REA.

Each recommendation below names the code it changes. Items marked **(unverified)** come from upstream docs and haven't been tested in this repo.

---

## 1. TL;DR

Most of the time and most of the junk come from our own pipeline, not from Ghidra:

1. **We decompile everything up front.** `queue-drain` warms the whole export cache before any work, and `export-all` decompiles every function serially, allowing 120 s per function.
2. **Some code paths re-run analysis.** Each rename attempt starts a new container, JVM and Ghidra MCP server, then calls `program_open` with `update_analysis=true`.
3. **We give Ghidra almost no symbol help.** There's no PDB/FID/library identification and `analysis_options: {}`. Library code (CRT, libc, statically linked dependencies) therefore comes out as thousands of `FUN_xxxx` functions, which agents then "reverse engineer".
4. **A tiny model writes the semantic claims.** The `decomp_worker` role in `models.json` is `amazon.nova-lite-v1:0`. A weak model reading raw pseudocode produces confident junk.
5. **Some targets shouldn't go through Ghidra at all.** For Electron apps, Go, Rust, .NET and packed binaries, REA has better dedicated tools.

**Fix:** let REA decide what's worth decompiling (triage plus feature tracing). Import into Ghidra once, with tuned analysis. Then decompile only the scope's functions through one persistent Ghidra MCP or warm pool, and use a stronger model for claims.

---

## 2. What REA is and what it gives us

[REA](https://github.com/morluto/rea) (`rea-agents`, MIT) is a single MCP server for reverse engineering. We pin **`rea-agents@6.7.0`** (`.agents/gotchas.md`). All 207 of its tools are in `fixtures/rea/tools.json`, which was captured live; use that file, not memory, for argument names.

- **MCP launch:** `npx -y rea-agents@6.7.0 mcp`. The subcommand is `mcp`, not `--mcp`. Our client is `packages/backend/src/rea/reaClient.ts` (spec `03_mcp_bridge.md`).
- **Native decompiler backends:** Ghidra (uses your installation), IDA, Hopper, and offline objdump/Rizin. REA never installs Ghidra or Java.
- **Ghidra setup (from REA's `installation.md`):**

  | Setting | Value |
  |---|---|
  | `GHIDRA_INSTALL_DIR` | A **12.1.x** install. Our worker image pins 12.1.3; REA verifies against 12.1.4 |
  | JDK | 21 or newer, selected with `JAVA_HOME` |
  | `REA_GHIDRA_STARTUP_TIMEOUT_MS` | Default 330 000 ms. Covers import, analysis, bridge and health check. Raise it for big binaries |
  | `REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS` | Default is **no limit**. Set it (e.g. 60) so one pathological function fails alone instead of hanging the session |
  | Linux | A procps `ps` must be on `PATH` |

- **Sessions are ephemeral.** Every REA Ghidra session imports and auto-analyses the binary again. Its socket opens only after default auto-analysis finishes. So:
  - Keep one long-lived REA connection per binary. Evidence IDs only work on the same connection anyway (gotchas).
  - `open_binary` takes `snapshot_path` and `close_binary` writes one. Test whether a snapshot skips re-analysis on 6.7.0 **(unverified)**.
- **Windows:** "experimental x64 P0". It's read-only and handles native x86/x64/ARM PE files on local NTFS only. Run native REA+Ghidra on Linux or macOS (or in the worker container), as `08_stretch_native_targets.md` says.

### REA tools that matter for decompiling (names checked against `tools.json`)

| Purpose | Tools |
|---|---|
| Triage (no decompiler) | `inspect_artifact`, `inspect_binary_layout`, `inspect_pe_resources`, `inspect_go_binary`, `inspect_rust_binary`, `inspect_managed_artifact`/`inspect_managed_members` (.NET), `inspect_electron_fuses`, `analyze_javascript_application` |
| Open / overview | `open_binary {path, provider_id?, snapshot_path?}`, `binary_overview`, `list_segments`, `inspect_native_load_image` |
| Find the feature | `trace_feature {query}`, `search_strings {pattern}`, `search_procedures {pattern, mode}`, `find_xrefs_to_name {name}`, `xrefs`, `procedure_callers`/`procedure_callees` |
| Bound the scope | `trace_call_path {start, goal?, direction?}`, `get_call_graph {address, direction}`, `trace_native_values {procedure, max_depth, max_functions…}` (budgeted) |
| Read code | `analyze_function {procedure}` (function dossier), `procedure_pseudo_code`, `procedure_assembly`, `batch_decompile {addresses}` (**small batches only**) |
| Runtime truth | `observe_native_calls {breakpoints, …}` (records entries, not return values), Frida tools, `capture_process_scenario` |
| Keep evidence | `export_evidence_bundle {path}`, `record_unknown`, `list_unknowns` |

REA's own native workflow (`docs/native-investigation.md`) says:
- Start from inventories and dossiers, not full decompilation.
- Decompile only the procedures your question depends on, chosen from traces and xrefs.
- Use `decompile_all` only when a whole-program export is truly needed.

Our pipeline currently does the opposite.

---

## 3. Ghidra MCP servers

| Server | Pros | Cons | Fit |
|---|---|---|---|
| [`ghidra-headless-mcp`](https://github.com/mrphrazer/ghidra-headless-mcp): already in `worker.Dockerfile`, pinned at commit `f3af083` | ~212 tools, including `analysis.options.set`; `project.program.open_existing` reuses a project; has a persistent TCP server mode | Slow JVM start per process; the TCP server has **no auth** (localhost, trusted containers only); `ghidra.eval`/`script` run arbitrary code; license unclear | Keep it, but run **one persistent server per campaign** instead of one per attempt. Note that upstream uses dotted names (`program.open`), while our pinned build exposes `ghidra_program_open`. Check names against the pinned commit |
| [`pyghidra-mcp`](https://github.com/clearbluejar/pyghidra-mcp) | One long-running process over streamable HTTP; imports a directory or project once and caches GZFs; batch `decompile_function` with per-target errors and `timeout_sec` (default 30); `--max-workers`, `--no-wait-for-analysis`; semantic `search_code` | Beta; ChromaDB indexing lags behind analysis on big projects | **Best fit for agent drill-down** against our cached baseline project. Trial it next to the warm pool |
| REA's Ghidra provider | Evidence model, budgets, compact schemas, feature tracing | Ephemeral sessions re-analyse every time; Windows read-only | Use it for **triage and choosing the scope**, not bulk export |

Run any Ghidra MCP server inside the worker container, never exposed to the network.

---

## 4. Why it's slow (with code locations)

| # | Cause | Where | Fix |
|---|---|---|---|
| S1 | Full default auto-analysis on import, up to 900 s per file, no analyzer tuning (`"analysis_options": {}`) | `engine/analysis/ghidra.py` `analyze()` / `_analyze_locked()` (`-import … -analysisTimeoutPerFile`) | Add a `-preScript` that sets analysis options. Record them in `identity["analysis_options"]` so the cache key changes. Candidates to measure: **Decompiler Parameter ID** (decompiles every function during analysis; slow but improves signatures), Aggressive Instruction Finder (off), Non-Returning Functions (keep). Measure; don't guess |
| S2 | `queue-drain` warms the whole export cache, and `export_all` decompiles **every** function in one serial JVM (bulk deadline `len(functions) * 130` s) | `ghidra.py` `export_all()`; README `queue-drain` | Export only the functions in the current **scope** (`launch.py scope` already computes them). Keep `export-all` as an explicit offline command |
| S3 | 120 s per-function decompile timeout with a default `DecompInterface` | `engine/analysis/scripts/ExportEvidence.java` (`decompileFunction(function, 120, monitor)`) | Use 30–60 s, record timeouts as `status: "timeout"` evidence, and skip retries. Use Ghidra's `ParallelDecompiler` (or more warm slots) for bulk |
| S4 | With `DECOMP_ANALYSIS_WORKERS=0`, each function starts a new `analyzeHeadless` JVM (~10–60 s startup) | `ghidra.py` `function()` cold path | Always run the warm pool. 2 slots is the default; benchmark 4–8 against RAM |
| S5 | Each warm worker copies the whole `baseline.rep`, and restarts on campaign switch (startup cap 120 s) | `engine/analysis/warm.py` `_start()` | Fine for small binaries. For big ones, open the baseline read-only from one long-lived process (pyghidra-mcp or the ghidra-headless-mcp server) instead of copying it |
| S6 | Each rename attempt runs a Podman container, OpenCode, a fresh `ghidra-headless-mcp` and `program_open(update_analysis=true)`, so analysis runs again per function | `agent_worker.py` `attempt()` / `opencode_config()`; `launch.py` | Treat it as a diagnostic only (as `DecompPileline.md` says). Never put it on the main path. If you keep it, open the existing project with `update_analysis=false` |
| S7 | REA sessions re-import every time | REA provider design | One connection per binary, pre-warmed at boot; test `snapshot_path` |

## 5. Why the output is junk

| # | Cause | Fix |
|---|---|---|
| J1 | **Wrong target.** For an Electron app, decompiling `App.exe` means decompiling Chromium. | The app code lives in `resources/app.asar`, so use `analyze_javascript_application` and `trace_application_feature` (the Step 1 path that already works). Native add-ons are `*.node` files; decompile only those |
| J2 | **Managed or language-specific binaries:** .NET, Go, Rust, Flutter/Dart | Use `inspect_managed_*` (C#-level recovery with no Ghidra), `inspect_go_binary`, `inspect_rust_binary` (recover symbols and types first), `inspect_dart_aot` |
| J3 | **Packed or obfuscated binaries** (UPX, protectors), where Ghidra decompiles a stub | Triage with `inspect_binary_layout` / `inspect_pe_resources` (section entropy, imports). Unpack first or stop |
| J4 | **No symbols:** library code mixed with app code, everything `FUN_` | Load PDBs when available. Apply **Function ID** (FID) databases and type archives (`.gdt`) during import. Before scheduling a function, filter out library functions (FID matches, thunks, imports). `ExportEvidence.java` already marks `external`/`thunk`; also add a `library` flag |
| J5 | **Decompiler options not taken from the program** (default `DecompInterface`) | Before `openProgram`, call `DecompileOptions opts = new DecompileOptions(); opts.grabFromProgram(currentProgram); decompiler.setOptions(opts);` |
| J6 | **A weak model writes claims:** `decomp_worker = amazon.nova-lite-v1:0` | Route semantic claims to Qwen3 Coder 480B, which already works on our account through Bedrock. Set `MODEL_DECOMP_WORKER` or change `models.json`, then check that the Python model runtime (`engine/model_runtime.py`) accepts that ID. Keep Nova Lite for cheap extraction only, as `DecompPileline.md` §Capacity already warns |
| J7 | **Agents get pseudocode without context** | Give the agent the REA `analyze_function` dossier (callers, callees, strings, xrefs, data) plus assembly for ambiguous spots, not bare C. Make it check signedness, widths and byte order against disassembly (`DecompPileline.md` §Worker output) |
| J8 | **No runtime check** | When the target can run, confirm claims with `observe_native_calls` or our original-binary probes (`launch.py probe`). A static-only claim stays labelled `static_only` |

---

## 6. Recommended agent loop

```
1. TRIAGE (REA, seconds; no decompiler)
   inspect_artifact / inspect_binary_layout → what is it? packed? managed? Electron? Go/Rust?
   └─ Electron → Step 1 JS path (analyze_javascript_application → trace_application_feature). Stop here.
   └─ .NET / Go / Rust / Dart → dedicated REA tool. Use Ghidra only for leftover native code.

2. IMPORT ONCE (engine, minutes, cached by sha256 + Ghidra version + options)
   python launch.py analyze --binary /abs/path   # tuned analysis options (S1, J4)

3. FIND THE FEATURE (REA over a long-lived connection, or Ghidra MCP)
   search_strings / trace_feature {query} / find_xrefs_to_name → seed functions
   trace_call_path / get_call_graph → candidate set (budgeted)

4. SCOPE (engine)
   python launch.py scope --manifest … → bounded function list, library functions excluded

5. DECOMPILE ONLY THE SCOPE (warm pool or persistent Ghidra MCP; 30–60 s per function)
   python launch.py function --manifest … --address …   # or a pyghidra-mcp decompile_function batch

6. REASON (queue workers, strong model)
   claim = dossier + pseudocode + assembly excerpts + xrefs/strings, cited by address

7. VERIFY
   independent review (queue-review) → probes / observe_native_calls → partial dossier with explicit unknowns
```

Rules for the agent prompt:
- Never "decompile all".
- Ask for one function at a time, or small batches of 10 or fewer.
- Cite addresses.
- Skip a function marked library, external or thunk unless the scope depends on its contract.
- Absence of an xref or string is not proof (REA docs).

---

## 7. Concrete first tasks (in order)

1. **Measure before changing anything.** On one real target, record:
   - import time and function count (`decomp-state/progress.jsonl` already logs `import_finished` and `indexed`);
   - time per function, and how many functions are library vs app code;
   - one sample of "junk" output.

   Put the numbers in `docs/archive/` and the journal.
2. **Triage gate:** add a REA triage step before `launch.py analyze`, and refuse Electron, managed or packed inputs with a pointer to the right path (J1–J3).
3. **Scope-only export:** stop `queue-drain` from warming the full cache (S2), and lower the per-function timeout (S3).
4. **Analysis options and FID:** add the pre-script, store the options in the identity, and re-measure (S1, J4).
5. **`DecompileOptions.grabFromProgram`** in `ExportEvidence.java` (J5).
6. **Model routing:** move semantic claims off Nova Lite (J6). Check it with `queue-metrics` on the same scope, before and after.
7. **Persistent MCP trial:** run `pyghidra-mcp --transport streamable-http --project-path <campaign project>` inside the worker, and compare per-function latency with the warm pool (S5, S6).
8. **REA long-lived session:** for native targets on Linux, keep one REA connection per binary, set `REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS=60`, and test `snapshot_path` reuse (S7).

## 8. Known problem to fix along the way

`engine/analysis/ghidra.py` imports `fcntl`, which only exists on Unix. Because of that, `launch.py` crashes on Windows, and the backend test `routes/nativeSpecs.test.ts` ("native API generates a spec…") fails on Windows. Either guard the import (use `msvcrt.locking` or a portable lock library), or document that the engine runs only in the Linux worker container.

## 9. Safety and legal

- Analyse only software we own or are authorised to examine (REA `DISCLAIMER.md`).
- IDA, Hopper and JEB need our own licences.
- Ghidra MCP eval/script tools run arbitrary code. Keep them in the container and on localhost.
- Never present static-only or replayed findings as verified (`.agents/README.md` rules).

## Sources

- REA: https://github.com/morluto/rea, including `docs/installation.md`, `docs/ghidra-provider.md` and `docs/native-investigation.md`
- ghidra-headless-mcp: https://github.com/mrphrazer/ghidra-headless-mcp
- pyghidra-mcp: https://github.com/clearbluejar/pyghidra-mcp
- Ghidra `DecompInterface` / `ParallelDecompiler`: https://ghidra.re/ghidra_docs/api/
- Repo: `fixtures/rea/tools.json`, `engine/analysis/ghidra.py`, `engine/analysis/warm.py`, `engine/analysis/scripts/ExportEvidence.java`, `agent_worker.py`, `models.json`
