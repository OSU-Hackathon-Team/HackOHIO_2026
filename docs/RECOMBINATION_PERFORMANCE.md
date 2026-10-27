# Recombination development workload and budgets

This is an opt-in workload gate for the **authored development** packages and
the two downstream recipes. It does not measure approved upstream handoffs,
live transcription, or the installed Electron app. Run it on Linux with
Bubblewrap and `ps`:

```sh
npm run test:recombination:performance
```

The command seeds four authored packages, builds the notebook and budget board
from a fresh temporary state directory, and measures 20 calls after three warmups
per operation. Package clients stay open during their own samples and are
disposed before the next package. Workflow calls use the real preview service,
which creates and disposes runtime clients for each preview and writes the
revisioned documents. The notebook workload supplies 512 workbook cells, 200
ordered transcript segments, an 8,737-byte Markdown note, and `=B2*C2`. The
budget workflow uses the same cells and formula. Both must return 60.

| Operation or phase | p95 latency budget |
| --- | ---: |
| Formula package | 250 ms |
| Markdown package | 500 ms |
| Recorded transcript fixture package | 500 ms |
| Budget renderer package | 250 ms |
| Notebook preview workflow | 1,500 ms |
| Budget preview workflow | 1,000 ms |
| Cold seed and two app builds | 60,000 ms |

The process-tree resident-memory budget is 2,048 MiB during the cold build and
1,536 MiB during package calls and previews. The script samples the benchmark
process and descendants every 50 ms through `ps`, so it can miss short peaks.
The interactive cap covers a backend that has already performed the builds and
includes any retained compiler memory plus active worker processes. An initial
1,024 MiB trial missed consistently at about 1,069–1,097 MiB; the largest
sample had roughly 895 MiB in the Node backend, 100 MiB in esbuild and two
roughly 60 MiB worker processes. The 1,536 MiB development cap leaves room for
that combined process model without treating the initial miss as a pass.

On 2026-10-27, a Linux x64 host with Intel Xeon Platinum 8488C and Node
22.22.1 passed the gate. The cold seed and builds took 6,816 ms, peak sampled
build memory was 1,005 MiB, and peak sampled interactive memory was 1,077 MiB.
Measured p95s were 1.6 ms for formula, 2.6 ms for Markdown, 3.4 ms for the
recorded transcript fixture, 0.4 ms for the budget renderer, 413 ms for the
notebook workflow, and 253 ms for the budget workflow. These are one-host
development results; the script prints the full JSON result on each run.

M7 performance acceptance still requires workloads for approved capabilities,
human audio latency, installed app measurements, platform-specific resource
budgets, and a representative load profile beyond one sequential caller. The
current `verified` app status does not include this performance gate.
