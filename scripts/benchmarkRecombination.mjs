// Opt-in development performance gate for authored packages and workflows.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createCapabilityClient } from "@splice/runtime";
import { budgetBoardPlan } from "../packages/backend/src/example/budget.ts";
import { FilesystemRecombinationService } from "../packages/backend/src/recombination/service.ts";

if (process.platform !== "linux") throw new Error("The development benchmark currently needs Linux bubblewrap and /proc");
const iterations = 20;
const budgets = Object.freeze({
  formula: 250, markdown: 500, transcription_fixture: 500, budget_renderer: 250,
  notebook_workflow: 1500, budget_workflow: 1000,
});
const maxInteractiveTreeRssMiB = 1536;
const maxBuildTreeRssMiB = 2048;
const maxColdBuildMs = 60_000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-recombination-perf-"));
const service = new FilesystemRecombinationService(root);
const context = { signal: new AbortController().signal, stage() {}, log() {}, transcriptionReset() {}, transcriptionSegment() {} };
const clients = [];
const results = {};
let peakTreeRssBytes = 0;
let currentStage = "cold_build";
const memoryPeaks = {};
let peakProcesses = [];

function treeRss() {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" }).trim().split("\n")
    .map((line) => line.trim().split(/\s+/))
    .map(([pid, ppid, rss, command]) => ({ pid: Number(pid), ppid: Number(ppid), rss_kib: Number(rss), command }))
    .filter((row) => Number.isFinite(row.pid) && Number.isFinite(row.ppid) && Number.isFinite(row.rss_kib));
  const descendants = new Set([process.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const { pid, ppid } of rows) {
      if (descendants.has(ppid) && !descendants.has(pid)) { descendants.add(pid); changed = true; }
    }
  }
  const processes = rows.filter(({ pid }) => descendants.has(pid));
  return { bytes: processes.reduce((sum, row) => sum + row.rss_kib * 1024, 0), processes };
}
const memorySampler = setInterval(() => {
  const { bytes, processes } = treeRss();
  if (bytes > peakTreeRssBytes) peakProcesses = processes;
  peakTreeRssBytes = Math.max(peakTreeRssBytes, bytes);
  memoryPeaks[currentStage] = Math.max(memoryPeaks[currentStage] ?? 0, bytes);
}, 50);

async function measure(name, run) {
  currentStage = name;
  for (let i = 0; i < 3; i++) await run();
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p95Ms = Number(samples[Math.ceil(samples.length * 0.95) - 1].toFixed(1));
  results[name] = { count: iterations, p95_ms: p95Ms, max_ms: Number(samples.at(-1).toFixed(1)), budget_p95_ms: budgets[name] };
}

const cells = Object.fromEntries(Array.from({ length: 510 }, (_, i) => [`A${i + 1}`, i]));
cells.B2 = 3;
cells.C2 = 20;
assert.equal(Object.keys(cells).length, 512);
const segments = Array.from({ length: 200 }, (_, i) => ({ id: `seg-${i}`, start_ms: i * 500, end_ms: i * 500 + 450, text: `Budget line ${i} confirmed` }));
const markdown = `${"# Meeting notes\n"}${"Budget review and follow up.\n".repeat(300)}\nTotal: **{{value}}**`;

try {
  const coldStart = performance.now();
  const listed = await service.seedAuthored();
  assert.equal(listed.packages.length, 4);
  const plan = await service.notebookPlan();
  const notebook = await service.buildApp(plan, context);
  const byId = Object.fromEntries(listed.packages.map((pkg) => [pkg.definition.id, pkg]));
  const secondPlan = budgetBoardPlan(plan, byId["splice.example.formula"].package_id, byId["splice.example.budget_report"].package_id);
  const budget = await service.buildApp(secondPlan, context);
  const coldBuildMs = Number((performance.now() - coldStart).toFixed(1));

  async function client(id) {
    const pkg = byId[id];
    assert.ok(pkg, `missing ${id}`);
    const definition = await service.registry.getDefinition(pkg.package_id);
    assert.ok(definition);
    const value = await createCapabilityClient(pkg, { definition, artifactRoot: service.registry.artifactRoot(pkg) });
    clients.push(value);
    return value;
  }
  const formula = await client("splice.example.formula");
  await measure("formula", async () => {
    assert.equal((await formula.call("evaluate", { formula: "=B2*C2", cells })).value, 60);
  });
  await formula.dispose();
  const markdownClient = await client("splice.example.markdown");
  await measure("markdown", async () => {
    assert.match((await markdownClient.call("render", { markdown, value: 60, segments })).html, /<strong>60<\/strong>/);
  });
  await markdownClient.dispose();
  const transcription = await client("splice.example.transcription");
  await measure("transcription_fixture", async () => {
    assert.equal((await transcription.call("accept_segments", { segments })).segments.length, 200);
  });
  await transcription.dispose();
  const report = await client("splice.example.budget_report");
  await measure("budget_renderer", async () => {
    assert.match((await report.call("render_budget", { label: "Operating budget", value: 60 })).html, /60\.00/);
  });
  await report.dispose();

  const notebookInput = { segments, formula: "=B2*C2", markdown };
  const firstNotebook = await service.previewApp(notebook.app_id, {
    workflow: "update_notebook", input: notebookInput,
    document_edits: [{ document: "workbook", path: "cells", value: cells }],
  });
  assert.equal(firstNotebook.documents.meeting.value, 60);
  await measure("notebook_workflow", async () => {
    const result = await service.previewApp(notebook.app_id, { workflow: "update_notebook", input: notebookInput, document_edits: [] });
    assert.equal(result.ok, true);
    assert.equal(result.documents.meeting.value, 60);
  });
  const budgetInput = { formula: "=B2*C2", cells, label: "Operating budget" };
  await measure("budget_workflow", async () => {
    const result = await service.previewApp(budget.app_id, { workflow: "compute_budget", input: budgetInput, document_edits: [] });
    assert.equal(result.ok, true);
    assert.equal(result.documents.budget.total, 60);
  });
  peakTreeRssBytes = Math.max(peakTreeRssBytes, treeRss().bytes);
  const buildRssMiB = Number(((memoryPeaks.cold_build ?? 0) / 1048576).toFixed(1));
  const interactiveRssMiB = Number((Math.max(...Object.entries(memoryPeaks).filter(([stage]) => stage !== "cold_build").map(([, bytes]) => bytes)) / 1048576).toFixed(1));
  const summary = {
    schema_version: 1, fixture: "authored_development", platform: `${process.platform}/${process.arch}`,
    node: process.version, cpu: os.cpus()[0]?.model ?? "unknown", iterations,
    workload: { cells: 512, segments: 200, markdown_bytes: Buffer.byteLength(markdown) },
    cold_build_ms: coldBuildMs, cold_build_budget_ms: maxColdBuildMs,
    peak_process_tree_rss_mib: Number((peakTreeRssBytes / 1048576).toFixed(1)),
    build_rss_mib: buildRssMiB, build_memory_budget_mib: maxBuildTreeRssMiB,
    interactive_rss_mib: interactiveRssMiB, interactive_memory_budget_mib: maxInteractiveTreeRssMiB,
    memory_peaks_mib: Object.fromEntries(Object.entries(memoryPeaks).map(([stage, bytes]) => [stage, Number((bytes / 1048576).toFixed(1))])),
    peak_processes: peakProcesses.sort((a, b) => b.rss_kib - a.rss_kib).slice(0, 8),
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  assert.ok(coldBuildMs <= maxColdBuildMs, "cold seed and two app builds exceeded budget");
  assert.ok(buildRssMiB <= maxBuildTreeRssMiB, "build process-tree memory exceeded budget");
  assert.ok(interactiveRssMiB <= maxInteractiveTreeRssMiB, "interactive process-tree memory exceeded budget");
  for (const [name, result] of Object.entries(results)) assert.ok(result.p95_ms <= budgets[name], `${name} p95 exceeded budget`);
} finally {
  clearInterval(memorySampler);
  await Promise.allSettled(clients.map((client) => client.dispose()));
  service.close();
  fs.rmSync(root, { recursive: true, force: true });
}
