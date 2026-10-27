import { execFileSync } from "node:child_process";

/** Sample resident KiB for one process and its descendants. Shared pages may be counted twice. */
export function processTreeRss(rootPid) {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" }).trim().split("\n")
    .map((line) => line.trim().split(/\s+/))
    .map(([pid, ppid, rss, command]) => ({ pid: Number(pid), ppid: Number(ppid), rss_kib: Number(rss), command }))
    .filter((row) => Number.isFinite(row.pid) && Number.isFinite(row.ppid) && Number.isFinite(row.rss_kib));
  const descendants = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const { pid, ppid } of rows) {
      if (descendants.has(ppid) && !descendants.has(pid)) { descendants.add(pid); changed = true; }
    }
  }
  const processes = rows.filter(({ pid }) => descendants.has(pid));
  return { bytes: processes.reduce((sum, row) => sum + row.rss_kib * 1024, 0), processes };
}
