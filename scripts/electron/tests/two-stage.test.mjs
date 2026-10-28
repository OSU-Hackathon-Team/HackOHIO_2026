import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { reconstruct } from "../pipeline.mjs";
import { specHash } from "../spec.mjs";
import { ADD_FEATURE, ECHO_FEATURE, FRAGILE_SPEC, FRAGILE_SPEC_REPAIRED, HOST_SPEC, READ_FEATURE,
  REGISTRY_ADD_FEATURE, REGISTRY_LIST_FEATURE, REGISTRY_SPEC, SHARED_FEATURE, SHARED_SPEC, SPEC,
  SUBSYSTEM_SPEC, VERSION_FEATURE, fragileArchive, hostSyntheticArchive, registryArchive,
  sharedArchive, syntheticArchive } from "./synthetic.mjs";

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
      spec: HOST_SPEC,
      features: { "features/add.cjs": ADD_FEATURE, "features/version.cjs": VERSION_FEATURE },
    }), options: { state: path.join(root, "state"), "spec-rounds": 1, "impl-rounds": 1 } });
    assert.equal(result.report.readiness.ready, true, JSON.stringify(result.report.readiness.blockers));
    /* A channel that answers the same way over varying inputs is narrow, not a gap: it is
       reported, the run still converges, and the candidate implements it. */
    assert.ok(result.report.partitions.public.coverage["app:version"].cases > 0);
    assert.equal(result.report.partitions.final.coverage["app:version"].distinct, 1);
    assert.ok(result.report.readiness.blockers.every(item => !/app:version/.test(item)));
    assert.deepEqual(result.report.spec.unreproducible_channel_exclusions.map(item => item.channel),
      ["window:bounds"]);
    assert.match(result.report.spec.unreproducible_channel_exclusions[0].reason, /changes between two observations/);
    assert.deepEqual(result.report.readiness.excluded.map(item => item.channel), ["window:bounds"]);
    assert.equal(result.report.readiness.excluded[0].source, "host-variation");
    assert.equal(result.report.readiness.whole_app_ready, false);
    /* The candidate is built for the reconstructible channels only, and the handoff says so. */
    const manifest = JSON.parse(await fsp.readFile(path.join(output, "reconstruction.json"), "utf8"));
    assert.deepEqual(manifest.channels.map(item => item.channel), ["app:version", "notes:add"]);
    assert.deepEqual(manifest.excluded_channels.map(item => item.channel), ["window:bounds"]);
    const spec = await fsp.readFile(path.join(output, "handoff", "SPEC.md"), "utf8");
    assert.match(spec, /Excluded channels[\s\S]*window:bounds/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("an unobservable case is repaired by the specification stage, not verified", { timeout: 240000 }, async () => {
  const { root, archive } = await fragileArchive();
  const state = path.join(root, "state");
  const feedbacks = [];
  try {
    const result = await reconstruct({ archive, output: path.join(root, "out"),
      agentRunner: async ({ stage, round, workspace, feedback }) => {
        if (stage === "spec") {
          feedbacks.push(feedback ?? "");
          /* The declared fixture makes the original exit before it registers a channel, so no case
             built on it can produce an expectation. The stage is told and repairs it. */
          await declare(workspace, round === 1 ? FRAGILE_SPEC : FRAGILE_SPEC_REPAIRED);
        } else {
          await fsp.mkdir(path.join(workspace, "features"), { recursive: true });
          await fsp.writeFile(path.join(workspace, "features/echo.cjs"), ECHO_FEATURE);
        }
        return agentRun(stage, round);
      },
      options: { state, "spec-rounds": 2, "impl-rounds": 1 } });
    assert.match(feedbacks[1] ?? "", /produced no usable observation/);
    assert.equal(result.report.readiness.ready, true, JSON.stringify(result.report.readiness.blockers));
    assert.equal(result.report.observations.failures.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a case that calls a channel outside the run is dropped, not compared", { timeout: 180000 }, async () => {
  const { root, archive } = await syntheticArchive();
  const spec = structuredClone(SPEC);
  delete spec.channels["notes:read"];
  spec.channel_exclusions = [{ channel: "notes:read",
    reason: "test: the channel is outside the reproducible feature contract" }];
  /* A sequence of a reconstructed channel that calls the excluded one: the candidate cannot
     register it, so grading the case would compare the original's answer with a missing handler. */
  spec.channels["notes:add"].sequences = [{ description: "add, then read through the excluded channel",
    calls: [{ channel: "notes:add", args: ["alpha", "one"] }, { channel: "notes:read", args: ["alpha"] }] }];
  try {
    const result = await reconstruct({ archive, output: path.join(root, "out"), agentRunner: async context => {
      if (context.stage === "spec") await declare(context.workspace, spec);
      else {
        await fsp.mkdir(path.join(context.workspace, "features"), { recursive: true });
        await fsp.writeFile(path.join(context.workspace, "features/add.cjs"), ADD_FEATURE);
      }
      return agentRun(context.stage, context.round);
    }, options: { state: path.join(root, "state"), "spec-rounds": 1, "impl-rounds": 1 } });
    assert.equal(result.report.readiness.ready, true, JSON.stringify(result.report.readiness.blockers));
    assert.deepEqual(result.report.spec.cases_dropped.map(item => item.excluded_calls), [["notes:read"]]);
    assert.ok(result.report.partitions.public.cases > 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("one feature module can serve several channels, because the contract names the channel", { timeout: 180000 }, async () => {
  const { root, archive } = await sharedArchive();
  try {
    const result = await reconstruct({ archive, output: path.join(root, "out"), agentRunner: scriptedAgent({
      spec: SHARED_SPEC, features: { "features/state.cjs": SHARED_FEATURE },
    }), options: { state: path.join(root, "state"), "spec-rounds": 1, "impl-rounds": 1 } });
    assert.equal(result.report.readiness.ready, true, JSON.stringify(result.report.readiness.blockers));
    assert.ok(result.report.partitions.final.total > 0);
    assert.equal(result.report.partitions.final.passed, result.report.partitions.final.total,
      "a module that branches on ctx.channel answers both channels");
    const manifest = JSON.parse(await fsp.readFile(path.join(root, "out", "reconstruction.json"), "utf8"));
    assert.deepEqual(manifest.channels.map(item => item.feature),
      ["features/state.cjs", "features/state.cjs"]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a channel that is unstable only in a stateful case is excluded, not verified", { timeout: 180000 }, async () => {
  const { root, archive } = await registryArchive();
  try {
    const result = await reconstruct({ archive, output: path.join(root, "out"), agentRunner: scriptedAgent({
      spec: REGISTRY_SPEC,
      features: { "features/add.cjs": REGISTRY_ADD_FEATURE, "features/list.cjs": REGISTRY_LIST_FEATURE },
    }), options: { state: path.join(root, "state"), "spec-rounds": 1, "impl-rounds": 1 } });
    /* The original mints a random key, so the expectation is its own run state and no
       implementation can match it. One case per channel would have missed it: the unstable
       answer appears only in the declared sequence, so the check samples shapes. */
    assert.deepEqual(result.report.spec.unstable_cases.map(item => [item.channel, item.shape]),
      [["registry:list", "sequence"]]);
    assert.equal(result.report.spec.unreproducible_channel_exclusions.length, 0,
      "the channel keeps the cases that are reproducible");
    assert.equal(result.report.readiness.ready, true, JSON.stringify(result.report.readiness.blockers));
    const manifest = JSON.parse(await fsp.readFile(path.join(root, "out", "reconstruction.json"), "utf8"));
    assert.deepEqual(manifest.channels.map(item => item.channel), ["registry:add", "registry:list"]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("a run can reconstruct one subsystem and says so in its report", { timeout: 180000 }, async () => {
  const { root, archive } = await hostSyntheticArchive();
  const output = path.join(root, "out");
  const stages = [];
  try {
    const result = await reconstruct({ archive, output, agentRunner: async context => {
      stages.push(context.stage);
      if (context.stage === "spec") {
        /* The specification stage is told which channels this run covers, and a declaration about
           a channel outside that list is ignored rather than failed. */
        assert.deepEqual(context.scope.channels, ["notes:add"]);
        assert.equal(context.scope.total, 3);
        await declare(context.workspace, SUBSYSTEM_SPEC);
      } else {
        await fsp.mkdir(path.join(context.workspace, "features"), { recursive: true });
        await fsp.writeFile(path.join(context.workspace, "features/add.cjs"), ADD_FEATURE);
      }
      return agentRun(context.stage, context.round);
    }, options: { state: path.join(root, "state"), "spec-rounds": 1, "impl-rounds": 1,
      only: ["notes:*"], "scope-label": "notes subsystem" } });
    assert.deepEqual(stages, ["spec", "implement"]);
    assert.equal(result.report.readiness.ready, true, JSON.stringify(result.report.readiness.blockers));
    /* Parity here is parity of the subsystem: the other channels were neither specified nor
       verified, so the run must not claim the application. */
    assert.equal(result.report.readiness.whole_app_ready, false);
    assert.deepEqual(result.report.scope.channels, ["notes:add"]);
    assert.deepEqual(result.report.scope.out_of_scope.slice().sort(), ["app:version", "window:bounds"]);
    assert.deepEqual(result.report.readiness.scoped,
      { label: "notes subsystem", channels: 1, application_channels: 3, out_of_scope: 2 });
    assert.deepEqual(result.report.readiness.excluded
      .map(({ channel, source }) => [channel, source]).sort(),
      [["app:version", "run-scope"], ["window:bounds", "run-scope"]]);
    /* Out-of-scope channels are excluded, not silently dropped, and the note explains the verdict. */
    assert.match(result.report.readiness.note, /subsystem \(notes subsystem\): 1 of 3 IPC channels/);
    assert.equal(result.report.readiness.excluded.every(item => /subsystem scope/.test(item.reason)), true);
    const manifest = JSON.parse(await fsp.readFile(path.join(output, "reconstruction.json"), "utf8"));
    assert.deepEqual(manifest.channels.map(item => item.channel), ["notes:add"]);
    const spec = await fsp.readFile(path.join(output, "handoff", "SPEC.md"), "utf8");
    assert.match(spec, /Excluded channels[\s\S]*app:version[\s\S]*subsystem scope/);
    assert.doesNotMatch(spec, /### `app:version`/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("an implementation that ignores the specification is rejected", { timeout: 180000 }, async () => {
  const { root, archive } = await syntheticArchive();
  const output = path.join(root, "out");
  const state = path.join(root, "state");
  const feedbacks = [];
  const agent = scriptedAgent({
    features: {
      "features/add.cjs": `"use strict";\nmodule.exports = async () => ({ name: "always", length: 0 });\n`,
      "features/read.cjs": READ_FEATURE,
    },
  });
  try {
    await assert.rejects(reconstruct({ archive, output, agentRunner: async context => {
      if (context.stage === "implement") feedbacks.push(context.feedback ?? "");
      return agent(context);
    }, options: { state, "spec-rounds": 1, "impl-rounds": 2 } }), /did not reach parity/);
    /* Failure feedback travels in an argv element: a real application can fail hundreds of cases,
       so the prompt stays bounded and the detail is written for the agent to read. */
    const feedback = feedbacks[1] ?? "";
    assert.ok(feedback.length > 0, "the second implementation round gets feedback");
    assert.ok(feedback.length < 12000, `feedback stayed inside an argv element (${feedback.length} characters)`);
    assert.match(feedback, /failures\.md/);
    const detail = await fsp.readFile(path.join(state, "implementation", "failures.md"), "utf8");
    assert.match(detail, /## public/);
    assert.match(detail, /notes:add/);
    const report = JSON.parse(await fsp.readFile(path.join(output, "reconstruction-report.json"), "utf8"));
    assert.equal(report.readiness.ready, false);
    assert.ok(report.partitions.public.failures.length > 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
