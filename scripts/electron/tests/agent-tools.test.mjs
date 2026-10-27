import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { analyzeElectronArchive } from "../analyze-archive.mjs";
import { SPEC, syntheticArchive } from "./synthetic.mjs";

const TOOLS = path.resolve("scripts/electron/agent-tools.mjs");

test("oracle tools inventory, probe and declare a specification with coverage", { timeout: 120000 }, async () => {
  const { root, archive, extracted } = await syntheticArchive();
  const workspace = await fsp.mkdtemp(path.join(root, "workspace-"));
  const analysisFile = path.join(root, "analysis.json");
  const publicFile = path.join(root, "public-cases.json");
  await fsp.writeFile(analysisFile, JSON.stringify(analyzeElectronArchive(archive)));
  const transport = new StdioClientTransport({ command: process.execPath, args: [TOOLS,
    "--app-dir", extracted, "--workspace", workspace, "--analysis", analysisFile,
    "--public-cases", publicFile, "--candidate", path.join(root, "candidate")] });
  const client = new Client({ name: "pipeline-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(tools, ["declare_spec", "find_fixture", "inventory", "probe", "public_cases"]);

    const inventory = JSON.parse((await client.callTool({ name: "inventory", arguments: {} })).content[0].text);
    assert.deepEqual(inventory.channels, [{ channel: "notes:add", arity: 2 }, { channel: "notes:read", arity: 1 }]);

    const probe = JSON.parse((await client.callTool({ name: "probe", arguments: {
      channel: "notes:add", args: ["alpha", " hi "],
    } })).content[0].text);
    assert.deepEqual(probe.outcomes[0].value, { name: "alpha", length: 2 });

    const declared = JSON.parse((await client.callTool({ name: "declare_spec",
      arguments: { spec: SPEC } })).content[0].text);
    assert.deepEqual(declared.problems, []);
    assert.ok(declared.cases >= 6);
    assert.deepEqual(declared.gaps, []);
    assert.ok(await fsp.readFile(publicFile, "utf8").then(text => text.includes("notes:add")));

    const cases = JSON.parse((await client.callTool({ name: "public_cases", arguments: {} })).content[0].text);
    assert.equal(cases.cases.length, declared.cases);
    assert.ok(cases.cases.every(item => item.case && item.result), "public cases carry original outcomes");

    const gapSpec = structuredClone(SPEC);
    gapSpec.channels["notes:read"].fixtures = [];
    const rejected = JSON.parse((await client.callTool({ name: "declare_spec",
      arguments: { spec: gapSpec } })).content[0].text);
    assert.ok(rejected.gaps.length > 0, "an unreachable channel must be reported as a coverage gap");
  } finally {
    await client.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});
