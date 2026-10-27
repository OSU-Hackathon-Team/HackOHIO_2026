/**
 * End-to-end Electron reconstruction pipeline.
 *
 *   node scripts/electron/pipeline.mjs <app.asar> <new-output-directory> [options]
 *
 * Stages: static inventory → orchestration agent learns behavior through the oracle → generated
 * public cases → assemble a runnable project → differential check against the original on public
 * and held-out cases. There are no per-application adapters, templates, blueprints or scenarios.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";
import { analyzeElectronArchive } from "./analyze-archive.mjs";
import { runCase } from "./oracle.mjs";
import { buildCases, compareCase, coverage, coverageGaps, runSuite, usableResults, validateContract } from "./cases.mjs";
import { runAgent } from "./agent.mjs";
import { assembleProject, validateWorkspace } from "./project.mjs";
import { resolveModel } from "./models.mjs";

function parseArguments(argv) {
  const positional = [], options = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const key = value.slice(2);
    if (key === "keep-workspace") { options[key] = true; continue; }
    options[key] = argv[++index];
  }
  return { archive: positional[0], output: positional[1], options };
}

function log(message) { process.stderr.write(`[electron] ${message}\n`); }

function channelInventory(analysis) {
  return (analysis.ipc?.handles ?? []).map(entry => ({ channel: entry.channel, arity: entry.arity ?? 0 }));
}

async function expectations({ cases, appDir }) {
  const results = await runSuite({ runCase, appDir, cases });
  return usableResults(results);
}

async function checkCandidate({ cases, candidate }) {
  const results = await runSuite({ runCase, appDir: candidate, cases: cases.map(item => item.case) });
  const failures = [];
  let passed = 0;
  for (let index = 0; index < cases.length; index++) {
    const item = results[index];
    if (item.error) { failures.push({ case: item.case.name, channel: item.case.channel, problems: [`candidate did not run: ${item.error.message}`] }); continue; }
    const problems = compareCase(cases[index].result, item.result);
    if (problems.length) failures.push({ case: item.case.name, channel: item.case.channel,
      calls: item.case.calls, problems: problems.slice(0, 4) });
    else passed++;
  }
  return { passed, total: cases.length, failures };
}

function describeAgent(run) {
  return `round ${run.round}: ${run.toolCalls.length} tool call(s), ${run.tokens} tokens, ` +
    `exit ${run.exitCode ?? "timeout"}${run.errors.length ? `, ${run.errors.length} error(s)` : ""}`;
}

export async function reconstruct({ archive, output, options = {} }) {
  if (!archive || !output) throw new Error("Usage: node scripts/electron/pipeline.mjs <app.asar> <new-output-directory>");
  const archivePath = path.resolve(archive);
  const outputPath = path.resolve(output);
  if (!fs.existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`);
  if (fs.existsSync(outputPath) && fs.readdirSync(outputPath).length) throw new Error(`Output already exists and is not empty: ${outputPath}`);
  const rounds = Number(options.rounds ?? 2);
  const model = options.model ?? process.env.ELECTRON_AGENT_MODEL ?? resolveModel();
  const timeout = Number(options.timeout ?? process.env.ELECTRON_AGENT_TIMEOUT ?? 1200);

  const stateDir = options.state ? path.resolve(options.state) : await fsp.mkdtemp(path.join(os.tmpdir(), "splice-electron-"));
  const appDir = path.join(stateDir, "original");
  const workspace = path.join(stateDir, "workspace");
  const candidate = path.join(stateDir, "candidate");
  await fsp.mkdir(appDir, { recursive: true });
  await fsp.mkdir(workspace, { recursive: true });
  asar.extractAll(archivePath, appDir);
  const analysis = analyzeElectronArchive(archivePath);
  const analysisFile = path.join(stateDir, "analysis.json");
  const publicFile = path.join(stateDir, "public-cases.json");
  await fsp.writeFile(analysisFile, JSON.stringify(analysis, null, 2) + "\n");
  await fsp.writeFile(path.join(workspace, "TASK.md"), "See the prompt. Work only with the oracle tools and files in this workspace.\n");
  log(`archive ${analysis.archive.sha256.slice(0, 12)} ${analysis.archive.name ?? ""}`);
  log(`${channelInventory(analysis).length} channel(s), workspace ${workspace}`);

  const agentRuns = [];
  let feedback = "";
  let contract = null;
  let verdict = null;
  for (let round = 1; round <= rounds; round++) {
    const run = await runAgent({ workspace, stateDir, appDir, archiveName: analysis.archive.name ?? "",
      analysisFile, publicFile, candidateDir: candidate, model, timeout, round, feedback, log });
    run.round = round;
    agentRuns.push(run);
    log(describeAgent(run));
    if (run.timedOut || run.error) {
      feedback = `Round ${round} ended without a result (${run.timedOut ? "timeout" : run.error}). Continue the reconstruction.`;
      continue;
    }
    const contractFile = path.join(workspace, "contract.json");
    contract = fs.existsSync(contractFile) ? JSON.parse(await fsp.readFile(contractFile, "utf8")) : null;
    if (!contract) {
      feedback = "No contract.json was declared. Declare one with oracle_declare_contract, then verify.";
      continue;
    }
    const problems = [...validateContract(contract, channelInventory(analysis)),
      ...validateWorkspace(workspace, analysis, contract)];
    if (problems.length) { feedback = `Contract problems:\n${problems.join("\n")}`; continue; }

    const channelNames = channelInventory(analysis).map(item => item.channel);
    const built = buildCases({ contract, channels: channelInventory(analysis), seed: "public" });
    const publicExpectations = await expectations({ cases: built.publicCases, appDir });
    const repairExpectations = await expectations({ cases: built.repairCases, appDir });
    const finalExpectations = await expectations({ cases: built.finalCases, appDir });
    if (!publicExpectations.length) { feedback = "No public case could observe the original app. Check fixtures and arguments."; continue; }
    const gaps = [...new Set([...coverageGaps(repairExpectations, channelNames), ...coverageGaps(finalExpectations, channelNames)])];
    const assembled = await assembleProject({ analysis, contract, workspace, output: candidate });
    const publicCheck = await checkCandidate({ cases: publicExpectations, candidate: assembled.output });
    const repairCheck = await checkCandidate({ cases: repairExpectations, candidate: assembled.output });
    const finalCheck = await checkCandidate({ cases: finalExpectations, candidate: assembled.output });
    verdict = {
      public: { coverage: coverage(publicExpectations), gaps: coverageGaps(publicExpectations, channelNames), ...publicCheck },
      repair: { coverage: coverage(repairExpectations), gaps: coverageGaps(repairExpectations, channelNames), ...repairCheck },
      final: { coverage: coverage(finalExpectations), gaps: coverageGaps(finalExpectations, channelNames), ...finalCheck },
    };
    log(`round ${round}: public ${publicCheck.passed}/${publicCheck.total}, repair ` +
      `${repairCheck.passed}/${repairCheck.total}, final ${finalCheck.passed}/${finalCheck.total}`);
    if (!publicCheck.failures.length && !repairCheck.failures.length && !finalCheck.failures.length && !gaps.length) break;
    feedback = `Public failures:\n${JSON.stringify(publicCheck.failures.slice(0, 8), null, 1)}\n` +
      `Repair failures (these cases are now visible; match the original exactly):\n` +
      `${JSON.stringify(repairCheck.failures.slice(0, 8), null, 1)}\n` +
      `Final held-out failures: ${finalCheck.failures.length} on channel(s) ` +
      `${[...new Set(finalCheck.failures.map(item => item.channel))].join(", ") || "none"}. ` +
      `Coverage gaps:\n${[...gaps, ...coverageGaps(publicExpectations, channelNames)].join("\n") || "none"}`;
  }

  if (!contract || !verdict) throw new Error(`No reconstruction was produced.${feedback ? `\n${feedback}` : ""}`);
  if (verdict.public.failures.length || verdict.repair.failures.length || verdict.final.failures.length ||
    verdict.repair.gaps.length || verdict.final.gaps.length) {
    throw new Error(`Reconstruction did not reach parity after ${agentRuns.length} round(s).\n` +
      `public ${verdict.public.passed}/${verdict.public.total}, repair ${verdict.repair.passed}/${verdict.repair.total}, ` +
      `final ${verdict.final.passed}/${verdict.final.total}\n` +
      `${[...verdict.public.failures.slice(0, 5), ...verdict.repair.failures.slice(0, 5), ...verdict.final.failures.slice(0, 5)]
        .map(item => JSON.stringify(item)).join("\n")}`);
  }

  const assembled = await assembleProject({ analysis, contract, workspace, output: outputPath });
  const report = {
    schema_version: 1,
    archive: { path: path.relative(process.cwd(), archivePath), ...analysis.archive },
    method: "agent reconstruction from black-box IPC observations, verified differentially",
    model,
    rounds: agentRuns.map(run => ({ model: run.model, tool_calls: run.toolCalls.length, tokens: run.tokens,
      exit_code: run.exitCode, timed_out: run.timedOut, errors: run.errors })),
    channels: channelInventory(analysis),
    public: { cases: verdict.public.total, passed: verdict.public.passed, coverage: verdict.public.coverage },
    repair: { cases: verdict.repair.total, passed: verdict.repair.passed, coverage: verdict.repair.coverage },
    held_out: { cases: verdict.final.total, passed: verdict.final.passed, coverage: verdict.final.coverage },
    final_held_out: { cases: verdict.final.total, passed: verdict.final.passed, coverage: verdict.final.coverage },
    limitations: [
      "Case values do not prove equivalence for arbitrary input.",
      "Renderer and preload behavior is generated from the contract; only main-process IPC behavior is differentially verified.",
    ],
  };
  await fsp.writeFile(path.join(outputPath, "reconstruction-report.json"), JSON.stringify(report, null, 2) + "\n");
  if (!options["keep-workspace"] && !options.state) await fsp.rm(stateDir, { recursive: true, force: true });
  log(`wrote ${outputPath}`);
  return { output: outputPath, report, stateDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { archive, output, options } = parseArguments(process.argv.slice(2));
  if (!archive || !output) {
    console.error("Usage: node scripts/electron/pipeline.mjs <app.asar> <new-output-directory> " +
      "[--rounds 2] [--timeout 900] [--model opencode/...] [--keep-workspace] [--state dir]");
    process.exitCode = 2;
  } else {
    reconstruct({ archive, output, options }).then(result => {
      console.log(JSON.stringify({ output: result.output, public: result.report.public, repair: result.report.repair,
        held_out: result.report.held_out, final_held_out: result.report.final_held_out,
        rounds: result.report.rounds.length }, null, 2));
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
