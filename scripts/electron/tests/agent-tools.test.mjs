import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { analyzeElectronArchive } from "../analyze-archive.mjs";
import { CONTRACT, syntheticArchive, syntheticWorkspace } from "./synthetic.mjs";

const TOOLS = path.resolve("scripts/electron/agent-tools.mjs");

test("oracle tools prepare cases, verify a faithful candidate and reject a broken one", { timeout: 120000 }, async () => {
  const { root, archive, extracted } = await syntheticArchive();
  const workspace = await syntheticWorkspace();
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
    assert.deepEqual(tools, ["candidate", "declare_contract", "find_fixture", "inventory", "probe", "public_cases", "verify"]);

    const inventory = JSON.parse((await client.callTool({ name: "inventory", arguments: {} })).content[0].text);
    assert.deepEqual(inventory.channels, [{ channel: "notes:add", arity: 2 }, { channel: "notes:read", arity: 1 }]);

    const probe = JSON.parse((await client.callTool({ name: "probe", arguments: {
      channel: "notes:add", args: ["alpha", " hi "],
    } })).content[0].text);
    assert.deepEqual(probe.outcomes[0].value, { name: "alpha", length: 2 });

    const declared = JSON.parse((await client.callTool({ name: "declare_contract",
      arguments: { contract: CONTRACT } })).content[0].text);
    assert.deepEqual(declared.problems, []);
    assert.ok(declared.cases >= 7);
    assert.deepEqual(declared.gaps, []);

    const verified = JSON.parse((await client.callTool({ name: "verify", arguments: {} })).content[0].text);
    assert.equal(verified.total, declared.cases);
    assert.equal(verified.passed, verified.total, JSON.stringify(verified.failures));

    await fsp.writeFile(path.join(workspace, "features/add.cjs"),
      `"use strict";\nmodule.exports = async function () { return { name: "always", length: 0 }; };\n`);
    const broken = JSON.parse((await client.callTool({ name: "verify", arguments: {} })).content[0].text);
    assert.ok(broken.failures.length > 0, "verify must reject a candidate that ignores its input");
  } finally {
    await client.close();
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(workspace, { recursive: true, force: true });
  }
});
