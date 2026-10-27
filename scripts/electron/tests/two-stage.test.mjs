import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { reconstruct } from "../pipeline.mjs";
import { specHash } from "../spec.mjs";
import { ADD_FEATURE, HOST_SPEC, READ_FEATURE, SPEC, hostSyntheticArchive, syntheticArchive } from "./synthetic.mjs";

function agentRun(stage, round) {
  return { stage, round, model: "scripted", toolCalls: [], tokens: 0, exitCode: 0,
    timedOut: false, errors: [] };
}

async function declare(workspace, spec) {
  await fsp.writeFile(path.join(workspace, "spec.json"), JSON.stringify(spec, null, 2) + "\n");
  await fsp.writeFile(path.join(workspace, "spec.declared.json"),
    JSON.stringify({ sha256: specHash(spec) }, null, 2) + "\n");
}

/** A scripted stand-in for the model: the specification stage declares SPEC, the implementation
 *  stage writes the given feature modules. It proves the driver and the handoff, not model skill. */
function scriptedAgent({ features, spec = SPEC }) {
  return async ({ stage, round, workspace }) => {
    if (stage === "spec") {
      await declare(workspace, spec);
    } else {
      await fsp.mkdir(path.join(workspace, "features"), { recursive: true });
      for (const [file, content] of Object.entries(features))
        await fsp.writeFile(path.join(workspace, file), content);
    }
    return agentRun(stage, round);
  };
}

test("a specification alone is enough for an implementation to pass the frozen candidate", { timeout: 180000 }, async () => {
  const { root, archive } = await syntheticArchive();
  const output = path.join(root, "out");
  try {
    const result = await reconstruct({ archive, output, agentRunner: scriptedAgent({
      features: { "features/add.cjs": ADD_FEATURE, "features/read.cjs": READ_FEATURE },
    }), options: { state: path.join(root, "state"), "spec-rounds": 1, "impl-rounds": 1 } });
    assert.equal(result.report.readiness.ready, true, JSON.stringify(result.report.readiness.blockers));
    assert.equal(result.report.models.spec, "scripted");
    assert.equal(result.report.models.implementer, "scripted");
    for (const partition of ["public", "repair", "final"])
      assert.equal(result.report.partitions[partition].passed, result.report.partitions[partition].total);
    assert.ok(result.report.partitions.final.total > 0, "the held-out partition must be evaluated");
    const project = await fsp.readFile(path.join(output, "main.cjs"), "utf8");
    assert.ok(project.includes("ipcMain.handle"));
    assert.ok(await fsp.readFile(path.join(output, "handoff", "SPEC.md"), "utf8")
      .then(text => text.includes("notes:add")));
    assert.ok(await fsp.readFile(path.join(output, "handoff", "spec.json"), "utf8")
      .then(text => text.includes("\"requirements\"")));
    const report = JSON.parse(await fsp.readFile(path.join(output, "reconstruction-report.json"), "utf8"));
    assert.equal(report.readiness.ready, true);
    assert.equal(report.observations.failures.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("the implementation workspace never contains the original app or its analysis", { timeout: 180000 }, async () => {
  const { root, archive } = await syntheticArchive();
  const state = path.join(root, "state");
  let implementationFiles = null;
  const agent = scriptedAgent({ features: { "features/add.cjs": ADD_FEATURE, "features/read.cjs": READ_FEATURE } });
  try {
    await reconstruct({ archive, output: path.join(root, "out"), options: { state, "spec-rounds": 1, "impl-rounds": 1 },
      agentRunner: async context => {
        if (context.stage === "implement")
          implementationFiles = (await fsp.readdir(context.workspace)).sort();
        return agent(context);
      } });
    assert.deepEqual(implementationFiles, ["README.md", "SPEC.md", "public-cases.json", "spec.json"],
      "the implementer sees the specification and public cases, nothing from the archive");
    const stateFiles = await fsp.readdir(state);
    assert.ok(stateFiles.includes("original"), "the original app stays in driver-only state");
    for (const leaked of ["main.js", "package.json", "analysis.json"])
      await assert.rejects(fsp.stat(path.join(state, "implementation", leaked)));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a declared channel exclusion is reported instead of silently dropped", { timeout: 180000 }, async () => {
  const { root, archive } = await syntheticArchive();
  const output = path.join(root, "out");
  const spec = structuredClone(SPEC);
  delete spec.channels["notes:read"];
  spec.channel_exclusions = [{ channel: "notes:read",
    reason: "test: the channel is outside the reproducible feature contract" }];
  try {
    const result = await reconstruct({ archive, output, agentRunner: async ({ stage, round, workspace }) => {
      if (stage === "spec") await declare(workspace, spec);
      else {
        await fsp.mkdir(path.join(workspace, "features"), { recursive: true });
        await fsp.writeFile(path.join(workspace, "features/add.cjs"), ADD_FEATURE);
      }
      return agentRun(stage, round);
    }, options: { state: path.join(root, "state"), "spec-rounds": 1, "impl-rounds": 1 } });
    assert.equal(result.report.readiness.ready, true, JSON.stringify(result.report.readiness.blockers));
    assert.equal(result.report.readiness.whole_app_ready, false);
    assert.deepEqual(result.report.readiness.excluded.map(item => item.channel), ["notes:read"]);
    const manifest = JSON.parse(await fsp.readFile(path.join(output, "reconstruction.json"), "utf8"));
    assert.deepEqual(manifest.channels.map(item => item.channel), ["notes:add"]);
    assert.deepEqual(manifest.excluded_channels.map(item => item.channel), ["notes:read"]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a supplied specification skips discovery but keeps verification", { timeout: 180000 }, async () => {
  const { root, archive } = await syntheticArchive();
  const specFile = path.join(root, "reviewed-spec.json");
  await fsp.writeFile(specFile, JSON.stringify(SPEC, null, 2));
  const stages = [];
  try {
    const result = await reconstruct({ archive, output: path.join(root, "out"),
      agentRunner: async ({ stage, round, workspace }) => {
        stages.push(stage);
        await fsp.mkdir(path.join(workspace, "features"), { recursive: true });
        await fsp.writeFile(path.join(workspace, "features/add.cjs"), ADD_FEATURE);
        await fsp.writeFile(path.join(workspace, "features/read.cjs"), READ_FEATURE);
        return agentRun(stage, round);
      },
      options: { state: path.join(root, "state"), spec: specFile, "impl-rounds": 1 } });
    assert.deepEqual(stages, ["implement"], "the specification stage must not run");
    assert.equal(result.report.readiness.ready, true, JSON.stringify(result.report.readiness.blockers));
    assert.ok(result.report.partitions.final.total >= 3);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a channel whose answer depends on the mocked host is excluded, not claimed", { timeout: 180000 }, async () => {
  const { root, archive } = await hostSyntheticArchive();
  const output = path.join(root, "out");
  try {
    const result = await reconstruct({ archive, output, agentRunner: scriptedAgent({
      spec: HOST_SPEC, features: { "features/add.cjs": ADD_FEATURE },
    }), options: { state: path.join(root, "state"), "spec-rounds": 1, "impl-rounds": 1 } });
    assert.equal(result.report.readiness.ready, true, JSON.stringify(result.report.readiness.blockers));
    assert.deepEqual(result.report.spec.host_dependent_exclusions.map(item => item.channel), ["window:bounds"]);
    assert.match(result.report.spec.host_dependent_exclusions[0].reason, /window bounds/);
    assert.deepEqual(result.report.readiness.excluded.map(item => item.channel), ["window:bounds"]);
    assert.equal(result.report.readiness.excluded[0].source, "host-variation");
    assert.equal(result.report.readiness.whole_app_ready, false);
    /* The candidate is built for the reconstructible channels only, and the handoff says so. */
    const manifest = JSON.parse(await fsp.readFile(path.join(output, "reconstruction.json"), "utf8"));
    assert.deepEqual(manifest.channels.map(item => item.channel), ["notes:add"]);
    assert.deepEqual(manifest.excluded_channels.map(item => item.channel), ["window:bounds"]);
    const spec = await fsp.readFile(path.join(output, "handoff", "SPEC.md"), "utf8");
    assert.match(spec, /Excluded channels[\s\S]*window:bounds/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("an implementation that ignores the specification is rejected", { timeout: 180000 }, async () => {
  const { root, archive } = await syntheticArchive();
  const output = path.join(root, "out");
  try {
    await assert.rejects(reconstruct({ archive, output, agentRunner: scriptedAgent({
      features: {
        "features/add.cjs": `"use strict";\nmodule.exports = async () => ({ name: "always", length: 0 });\n`,
        "features/read.cjs": READ_FEATURE,
      },
    }), options: { state: path.join(root, "state"), "spec-rounds": 1, "impl-rounds": 1 } }), /did not reach parity/);
    const report = JSON.parse(await fsp.readFile(path.join(output, "reconstruction-report.json"), "utf8"));
    assert.equal(report.readiness.ready, false);
    assert.ok(report.partitions.public.failures.length > 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
