import assert from "node:assert/strict";
import { processTreeRss } from "./processTreeRss.mjs";

/** Optional workload gate inside the installed Electron app, after its upgrade/restart smoke. */
export async function benchmarkInstalledNotebook(page, electronPid) {
  const iterations = 20;
  const p95BudgetMs = 1500;
  const memoryBudgetMiB = 2048;
  const cells = Object.fromEntries(Array.from({ length: 510 }, (_, i) => [`A${i + 1}`, i]));
  cells.B2 = 4;
  cells.C2 = 20;
  assert.equal(Object.keys(cells).length, 512);
  const segments = Array.from({ length: 200 }, (_, i) => ({ id: `seg-${i}`, start_ms: i * 500, end_ms: i * 500 + 450, text: `Budget line ${i} confirmed` }));
  const markdown = `${"# Meeting notes\n"}${"Budget review and follow up.\n".repeat(300)}\nTotal: **{{value}}**`;
  const input = { segments, formula: "=B2*C2", markdown };
  const saved = await page.evaluate(async (value) => {
    const current = await window.splice.getDocument("workbook");
    return window.splice.saveDocument("workbook", { cells: value }, current.revision);
  }, cells);
  assert.deepEqual(saved.data.cells, cells);

  let peakRssBytes = 0;
  let peakProcesses = [];
  const sampler = setInterval(() => {
    const snapshot = processTreeRss(electronPid);
    if (snapshot.bytes > peakRssBytes) {
      peakRssBytes = snapshot.bytes;
      peakProcesses = snapshot.processes;
    }
  }, 50);
  try {
    const run = async () => {
      const outcome = await page.evaluate(async (workflowInput) => {
        const start = performance.now();
        const result = await window.splice.runWorkflow("update_notebook", workflowInput);
        return { elapsed_ms: performance.now() - start, status: result.status, value: result.step_results?.calculate?.value, errors: result.errors };
      }, input);
      assert.equal(outcome.status, "succeeded", JSON.stringify(outcome.errors));
      assert.equal(outcome.value, 80);
      return outcome.elapsed_ms;
    };
    for (let i = 0; i < 3; i++) await run();
    const samples = [];
    for (let i = 0; i < iterations; i++) samples.push(await run());
    samples.sort((a, b) => a - b);
    const p95Ms = Number(samples[Math.ceil(iterations * 0.95) - 1].toFixed(1));
    const snapshot = processTreeRss(electronPid);
    if (snapshot.bytes > peakRssBytes) {
      peakRssBytes = snapshot.bytes;
      peakProcesses = snapshot.processes;
    }
    const summary = {
      schema_version: 1, fixture: "authored_development", target: "installed_linux_x64_deb",
      iterations, workload: { cells: 512, segments: 200, markdown_bytes: Buffer.byteLength(markdown) },
      p95_ms: p95Ms, max_ms: Number(samples.at(-1).toFixed(1)), p95_budget_ms: p95BudgetMs,
      peak_process_tree_rss_mib: Number((peakRssBytes / 1048576).toFixed(1)), memory_budget_mib: memoryBudgetMiB,
      peak_processes: peakProcesses.sort((a, b) => b.rss_kib - a.rss_kib).slice(0, 8),
    };
    console.log(`Installed app benchmark: ${JSON.stringify(summary)}`);
    assert.ok(p95Ms <= p95BudgetMs, "installed notebook workflow p95 exceeded budget");
    assert.ok(peakRssBytes <= memoryBudgetMiB * 1048576, "installed Electron process tree exceeded memory budget");
    const meeting = await page.evaluate(() => window.splice.getDocument("meeting"));
    assert.equal(meeting.data.value, 80);
    return summary;
  } finally {
    clearInterval(sampler);
  }
}
