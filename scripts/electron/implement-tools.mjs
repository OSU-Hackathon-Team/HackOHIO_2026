/**
 * Implementation-side tools for the two-stage Electron reconstruction pipeline.
 *
 * This server has no access to the original archive, its extracted files or its oracle. The only
 * ground truth is the public cases the driver shipped with the specification. That is the point:
 * an implementer that needs to probe the original has been handed the answer, not a specification.
 */
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCase } from "./oracle.mjs";
import { compareCase, runSuite } from "./cases.mjs";
import { assembleProject, validateWorkspace } from "./project.mjs";
import { suiteSummary } from "./spec.mjs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const workspace = path.resolve(argument("workspace"));
const candidateDir = path.resolve(argument("candidate", path.join(workspace, ".candidate")));
const analysis = JSON.parse(fs.readFileSync(path.resolve(argument("analysis")), "utf8"));
const publicFile = path.resolve(argument("public-cases"));
let publicSuite = JSON.parse(fs.readFileSync(publicFile, "utf8"));
const repairFile = path.join(workspace, "repair-cases.json");

const text = value => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const clip = (value, limit = 900) => {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  return json.length > limit ? `${json.slice(0, limit)}… (${json.length} chars)` : json;
};

function readSpec() {
  const file = path.join(workspace, "spec.json");
  if (!fs.existsSync(file)) throw new Error("spec.json is missing from the workspace");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readRepair() {
  return fs.existsSync(repairFile) ? JSON.parse(fs.readFileSync(repairFile, "utf8")) : null;
}

async function assemble() {
  const spec = readSpec();
  const problems = validateWorkspace(workspace, analysis, spec);
  if (problems.length) return { problems };
  try {
    return await assembleProject({ analysis, contract: spec, workspace, output: candidateDir });
  } catch (error) {
    return { problems: [error.message] };
  }
}

async function check({ include_repair } = {}) {
  const built = await assemble();
  if (built.problems) return { passed: 0, total: 0, failures: built.problems.map(problem => ({ problem })) };
  const repair = include_repair === false ? null : readRepair();
  const suites = [{ partition: "public", suite: publicSuite }];
  if (repair) suites.push({ partition: "repair", suite: repair });
  const report = { partitions: {}, failures: [] };
  for (const { partition, suite } of suites) {
    const results = await runSuite({ runCase, appDir: candidateDir, cases: suite.cases.map(item => item.case) });
    const expected = new Map(suite.cases.map(item => [item.case.name, item.result]));
    let passed = 0;
    for (const item of results) {
      const want = expected.get(item.case.name);
      if (!want) continue;
      if (item.error) {
        report.failures.push({ partition, case: item.case.name, channel: item.case.channel,
          calls: item.case.calls, problem: `candidate did not run: ${item.error.message}` });
        continue;
      }
      const problems = compareCase(want, item.result);
      if (problems.length) report.failures.push({ partition, case: item.case.name, channel: item.case.channel,
        calls: item.case.calls, problems: problems.slice(0, 2).map(problem => clip(problem, 700)) });
      else passed++;
    }
    report.partitions[partition] = { passed, total: suite.cases.length, gaps: suite.gaps ?? [] };
  }
  report.passed = Object.values(report.partitions).every(entry => entry.passed === entry.total) &&
    Object.values(report.partitions).every(entry => !entry.gaps.length);
  report.failures = report.failures.slice(0, 8);
  report.next = repair
    ? "Repair cases are now visible; they must pass too."
    : "Public failures are shown; fix the general rule, then run check again.";
  return report;
}

const server = new McpServer({ name: "implement", version: "1.0.0" });

server.registerTool("spec", {
  title: "Specification",
  description: "The machine-readable specification for this reconstruction: application scope, channels, fixtures, argument samples, requirements and sequences.",
  inputSchema: {},
}, async () => text(readSpec()));

server.registerTool("public_summary", {
  title: "Public case summary",
  description: "Compact list of the public differential cases: name, channel, calls, fixture paths and the original outcome. Use public_case for full fixtures and file effects.",
  inputSchema: {},
}, async () => text(suiteSummary(publicSuite)));

server.registerTool("public_case", {
  title: "One public case",
  description: "Full fixtures, calls and the original application's recorded outcome and file effects for one public case name.",
  inputSchema: { name: z.string() },
}, async ({ name }) => {
  const item = publicSuite.cases.find(entry => entry.case.name === name);
  if (!item) return text({ error: `Unknown public case ${name}. Use public_summary for names.` });
  return text({ case: item.case, result: item.result });
});

server.registerTool("check", {
  title: "Check the implementation",
  description: "Assemble the workspace into a runnable Electron project and compare it with every public differential case, plus repair cases once they are visible. Returns per-partition counts and compact failure details.",
  inputSchema: { include_repair: z.boolean().optional() },
}, async input => text(await check(input)));

server.registerTool("run", {
  title: "Run one case against the candidate",
  description: "Assemble the workspace and run a free-form case against your implementation only. For debugging; it does not compare with the original.",
  inputSchema: {
    channel: z.string().optional(),
    args: z.array(z.any()).optional(),
    calls: z.array(z.object({ channel: z.string(), args: z.array(z.any()).optional() })).optional(),
    fixtures: z.array(z.object({ base: z.enum(["userData", "documents", "logs", "temp"]), path: z.string(), content: z.any() })).optional(),
    fixed_time: z.string().optional(),
  },
}, async input => {
  const built = await assemble();
  if (built.problems) return text({ problems: built.problems });
  const result = await runCase({ appDir: candidateDir, case: input });
  return text({ outcomes: result.outcomes, files: result.files, effects: result.effects,
    startup_error: result.startup_error });
});

server.registerTool("refresh_public", {
  title: "Reload public cases",
  description: "Reload public and repair cases from disk after the driver updates them.",
  inputSchema: {},
}, async () => {
  publicSuite = JSON.parse(fs.readFileSync(publicFile, "utf8"));
  const repair = readRepair();
  return text({ public_cases: publicSuite.cases.length, repair_visible: Boolean(repair),
    repair_cases: repair?.cases?.length ?? 0, gaps: publicSuite.gaps ?? [] });
});

await server.connect(new StdioServerTransport());
