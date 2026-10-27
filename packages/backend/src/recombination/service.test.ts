import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAuthoredNotebookIntakes } from "../example/notebook.js";
import { budgetBoardPlan } from "../example/budget.js";
import { hashJson } from "../capabilities/identity.js";
import { documentSignature } from "../composition/documentMigrations.js";
import { packageLinuxApplication } from "../composition/linuxPackage.js";
import { createRecombinationRouter } from "../routes/recombination.js";
import { JobManager } from "./jobs.js";
import { FilesystemRecombinationService } from "./service.js";

const context = { signal: new AbortController().signal, stage() {}, log() {}, transcriptionReset() {}, transcriptionSegment() {} };

test("app revisions add a workbook atomically and retain its data through rollback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-document-migration-test-"));
  const service = new FilesystemRecombinationService(root);
  try {
    await service.seedAuthored();
    const old = await service.notebookPlan();
    old.documents = old.documents.filter((document) => document.id !== "workbook");
    old.ui = old.ui.filter((surface) => surface.id !== "workbook");
    delete old.document_migrations;
    old.workflows[0].input.fields.push({ name: "cells", type: { kind: "map", values: { kind: "float", bits: 64 }, max_entries: 2048 }, optional: false });
    const oldCalculation = old.workflows[0].steps.find((step) => step.id === "calculate")!;
    oldCalculation.input.find((mapping) => mapping.to === "cells")!.from = "$input.cells";
    oldCalculation.stale_guard = null;
    old.acceptance_scenarios = [{ id: "old_formula", name: "Original notebook calculation", steps: [
      { kind: "invoke", workflow: "update_notebook", input: { segments: [], formula: "=B2*C2", cells: { B2: 3, C2: 20 }, markdown: "Value {{value}}" }, expect_status: "succeeded" },
      { kind: "assert_document", document: "meeting", path: "value", equals: 60 },
    ] }];
    const first = await service.buildApp(old, context);
    const sample = old.acceptance_scenarios[0].steps.find((step) => step.kind === "invoke");
    assert.ok(sample?.kind === "invoke");
    assert.equal((await service.previewApp(first.app_id, { workflow: "update_notebook", input: sample.input, document_edits: [] })).ok, true);
    const before = service.state.getDocument(`${first.app_id}:meeting`)!;
    const next = await service.notebookPlan();
    assert.equal(next.document_migrations?.[0].from_signature, documentSignature(old.documents));
    assert.equal((await service.validatePlan(next)).ok, true);
    const built = await service.buildApp(next, context);
    assert.equal(built.revision, 1);
    assert.deepEqual(service.state.getDocument(`${first.app_id}:meeting`), { ...before, document: `${first.app_id}:meeting` });
    assert.deepEqual(service.state.getDocument(`${first.app_id}:workbook`)?.data, { cells: {} });
    service.state.putDocument(`${first.app_id}:workbook`, { cells: { B2: 3, C2: 20 } }, 1);
    await service.activateRevision(first.app_id, 0);
    assert.deepEqual(service.state.getDocument(`${first.app_id}:workbook`)?.data, { cells: { B2: 3, C2: 20 } });
    await service.activateRevision(first.app_id, 1);
    assert.deepEqual(service.state.getDocument(`${first.app_id}:workbook`)?.data, { cells: { B2: 3, C2: 20 } });
    await service.activateRevision(first.app_id, 0);
    const invalid = structuredClone(next);
    invalid.document_migrations![0].from_signature = "0".repeat(64);
    await assert.rejects(() => service.buildApp(invalid, context), /explicit data migration/);
    assert.equal((await service.getApp(first.app_id, "latest"))?.revision, 0);
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recombination builds, executes, persists, exports and replaces pinned packages", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-recombination-test-"));
  let service: FilesystemRecombinationService | null = new FilesystemRecombinationService(root);
  try {
    const installed = await service.seedAuthored();
    assert.equal(installed.packages.length, 4);
    assert.equal((await service.seedAuthored()).packages.length, 4, "seed is idempotent");
    const changedTests = structuredClone(getAuthoredNotebookIntakes()[0].request);
    changedTests.public_tests[0].code += '\nconst changed = await ctx.call("evaluate", { formula: "=1", cells: {} }); ctx.assert.equal(changed.value, 999);';
    const changedIntake = await service.intake(changedTests);
    assert.equal(changedIntake.accepted, true);
    await assert.rejects(() => service!.buildCapability(changedIntake.intake_id, context), /verification failed/i,
      "a changed public suite must run and must not reuse an older passing package");
    const plan = await service.notebookPlan();
    assert.equal(plan.bindings.length, 2);
    assert.equal((await service.validatePlan(plan)).ok, true);

    const malformed = structuredClone(plan);
    malformed.bindings[0].mappings[0].transform = "string";
    const rejected = await service.validatePlan(malformed);
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.some((item) => item.code === "mapping_type_mismatch"));

    const invalidWrite = structuredClone(plan);
    invalidWrite.workflows[0].steps[1].writes[1].from = "$input.formula";
    const rejectedWrite = await service.validatePlan(invalidWrite);
    assert.equal(rejectedWrite.ok, false);
    assert.ok(rejectedWrite.errors.some((item) => item.code === "write_type_mismatch"));

    const invalidProjection = structuredClone(plan);
    invalidProjection.providers[0].document_projection!.path = "formula";
    assert.ok((await service.validatePlan(invalidProjection)).errors.some((item) => item.code === "provider_projection_path"));
    const invalidProviderWorkflow = structuredClone(plan);
    invalidProviderWorkflow.providers[0].workflow_input!.path = "formula";
    assert.ok((await service.validatePlan(invalidProviderWorkflow)).errors.some((item) => item.code === "provider_workflow_input"));
    const invalidInitial = structuredClone(plan);
    invalidInitial.documents[0].initial = { transcript: [] };
    assert.ok((await service.validatePlan(invalidInitial)).errors.some((item) => item.code === "document_initial_invalid"));

    const buildJob = { ...context, job_id: `job_${"a".repeat(32)}` };
    const built = await service.buildApp(plan, buildJob);
    assert.equal(built.revision, 0);
    const first = plan.acceptance_scenarios[0].steps.find((step) => step.kind === "invoke");
    assert.ok(first?.kind === "invoke");
    const preview60 = await service.previewApp(built.app_id, { workflow: "update_notebook", input: first.input, document_edits: [{ document: "workbook", path: "cells", value: { B2: 3, C2: 20 } }] });
    assert.equal(preview60.ok, true);
    assert.match(String((preview60.documents.meeting as { html: string }).html), /<strong>60<\/strong>/);
    const second = plan.acceptance_scenarios[0].steps.filter((step) => step.kind === "invoke")[1];
    assert.ok(second?.kind === "invoke");
    const preview80 = await service.previewApp(built.app_id, { workflow: "update_notebook", input: second.input, document_edits: [{ document: "workbook", path: "cells", value: { B2: 4, C2: 20 } }] });
    assert.equal((preview80.documents.meeting as { value: number }).value, 80);
    assert.match(String((preview80.documents.meeting as { html: string }).html), /<strong>80<\/strong>/);
    await assert.rejects(() => service!.previewApp(built.app_id, { workflow: "update_notebook", input: second.input, document_edits: [
      { document: "workbook", path: "cells", value: { B2: 99, C2: 20 } },
      { document: "workbook", path: "cells", value: { B2: "invalid" } },
    ] }), /expected|float|number/i);
    assert.deepEqual(service!.state.getDocument(`${built.app_id}:workbook`)?.data, { cells: { B2: 4, C2: 20 } });

    const exported = await service.exportApp(built.app_id);
    assert.ok(exported.files.some((file) => file.path === "host/main.js"));
    assert.ok(exported.files.some((file) => file.path === "renderer/index.html"));
    assert.ok(exported.files.some((file) => file.path.startsWith("migrations/")));
    assert.ok(exported.files.some((file) => file.path === "splice.lock.json"));
    const tampered = structuredClone(exported);
    const renderer = tampered.files.find((file) => file.path === "renderer/index.html")!;
    renderer.content = `${renderer.content ?? ""}tampered`;
    await assert.rejects(() => packageLinuxApplication(tampered, "unused", path.join(root, "tampered-package")), /Export hash mismatch/);

    service.close();
    service = new FilesystemRecombinationService(root);
    assert.equal((await service.listCapabilities()).packages.length, 4);
    assert.equal((await service.getApp(built.app_id, "latest"))?.revision, 0);
    assert.equal((service.state.getDocument(`${built.app_id}:meeting`)?.data as { value: number }).value, 80);
    assert.deepEqual(await service.buildApp(plan, buildJob), built, "replaying a committed build returns its exact revision");
    assert.equal((await service.listApps()).apps.find((app) => app.app_id === built.app_id)?.revision, 0);
    const mismatchedReplay = structuredClone(plan);
    mismatchedReplay.app.description += " changed";
    await assert.rejects(() => service!.buildApp(mismatchedReplay, buildJob), /different plan/);

    const badRevision = structuredClone(plan);
    badRevision.acceptance_scenarios[0].steps[1] = { kind: "assert_document", document: "meeting", path: "value", equals: 999 };
    await assert.rejects(() => service!.buildApp(badRevision, context), /acceptance scenarios failed/);
    assert.equal((await service.getApp(built.app_id, "latest"))?.revision, 0, "failed build retains the last verified app");

    const invalidScenarioEdit = structuredClone(plan);
    invalidScenarioEdit.acceptance_scenarios[0].steps.unshift({ kind: "set_document", document: "workbook", path: "cells", value: { B2: "invalid" } });
    await assert.rejects(() => service!.buildApp(invalidScenarioEdit, context), /acceptance scenarios failed/);
    assert.equal((await service.getApp(built.app_id, "latest"))?.revision, 0, "invalid scenario state cannot verify a revision");

    const refined = structuredClone(plan);
    refined.app.description += " Refined UI copy.";
    const next = await service.buildApp(refined, context);
    assert.equal(next.revision, 1);
    assert.equal((await service.listAppRevisions(built.app_id))?.active_revision, 1);
    assert.equal((await service.getApp(built.app_id, "latest"))?.revision, 1);
    const restored = await service.activateRevision(built.app_id, 0);
    assert.equal(restored.revision, 0);
    assert.equal((await service.listApps()).apps.find((app) => app.app_id === built.app_id)?.revision, 0);
    assert.equal((await service.getApp(built.app_id, "latest"))?.revision, 0);
    assert.equal((await service.getApp(built.app_id, 1))?.revision, 1, "rollback retains the newer revision");
    assert.equal((await service.exportApp(built.app_id)).manifest_hash, (await service.getApp(built.app_id, 0))?.app_hash);
    assert.equal((service.state.getDocument(`${built.app_id}:meeting`)?.data as { value: number }).value, 80, "rollback preserves the shared document");
    const forked = structuredClone(plan);
    forked.app.description += " New branch after rollback.";
    const branch = await service.buildApp(forked, context);
    assert.equal(branch.revision, 2, "new builds append after the highest stored revision");
    assert.equal((await service.getApp(built.app_id, 2))?.bundle.previous_revision, 0, "lineage follows the active rollback target");
    await service.activateRevision(built.app_id, 1);
    const incompatible = structuredClone(plan);
    incompatible.documents[0].schema.fields.push({ name: "new_field", type: { kind: "string", encoding: "utf-8", max_bytes: 100 }, optional: true });
    await assert.rejects(() => service!.buildApp(incompatible, context), /Composition plan has blockers|explicit data migration/);
    assert.equal((await service.getApp(built.app_id, "latest"))?.revision, 1);
    const olderRuntime = structuredClone((await service.getApp(built.app_id, 1))!.bundle);
    olderRuntime.revision = 3;
    olderRuntime.storage_migrations = olderRuntime.storage_migrations.filter((migration) => migration.version !== 5);
    service.state.saveApp({
      app_id: olderRuntime.app_id, revision: 3, title: olderRuntime.title, status: "verified",
      app_hash: olderRuntime.app_hash, bundle: olderRuntime, created_at: new Date().toISOString(),
    });
    service.state.activateApp(built.app_id, 1);
    await assert.rejects(() => service!.activateRevision(built.app_id, 3), /cannot read state migration 5/);
    assert.equal((await service.getApp(built.app_id, "latest"))?.revision, 1);
    const altered = structuredClone((await service.getApp(built.app_id, 1))!.bundle);
    altered.revision = 4;
    altered.app_hash = "f".repeat(64);
    service.state.saveApp({
      app_id: altered.app_id, revision: 4, title: altered.title, status: "verified",
      app_hash: altered.app_hash, bundle: altered, created_at: new Date().toISOString(),
    });
    service.state.activateApp(built.app_id, 1);
    await assert.rejects(() => service!.activateRevision(built.app_id, 4), /stored artifact verification/);
    assert.equal((await service.getApp(built.app_id, "latest"))?.revision, 1);

    const alternate = structuredClone(getAuthoredNotebookIntakes()[0].request);
    if (alternate.implementation.kind !== "typescript") throw new Error("Formula fixture must be TypeScript");
    alternate.implementation.files[0].content += "\n// Alternate source revision exercises package replacement.\n";
    const intake = await service.intake(alternate);
    assert.equal(intake.accepted, true);
    const replacement = await service.buildCapability(intake.intake_id, context);
    assert.notEqual(replacement.package_id, plan.instances.find((instance) => instance.instance === "formula")?.package_id);
    const reportPackage = (await service.listCapabilities()).packages.find((pkg) => pkg.definition.id === "splice.example.budget_report")?.package_id;
    assert.ok(reportPackage);
    const secondRecipe = budgetBoardPlan(plan, replacement.package_id, reportPackage);
    assert.equal(secondRecipe.instances.length, 2);
    assert.equal(secondRecipe.bindings.length, 1);
    const budgetValidation = await service.validatePlan(secondRecipe);
    assert.equal(budgetValidation.ok, true, JSON.stringify(budgetValidation.errors));
    const unboundBudget = structuredClone(secondRecipe);
    unboundBudget.bindings = [];
    assert.ok((await service.validatePlan(unboundBudget)).errors.some((item) => item.code === "required_port_unbound"));
    const otherApp = await service.buildApp(secondRecipe, context);
    assert.notEqual(otherApp.app_id, built.app_id);
    assert.equal((await service.getApp(otherApp.app_id, "latest"))?.status, "verified");
    const budgetPreview = await service.previewApp(otherApp.app_id, { workflow: "compute_budget", input: { formula: "=A1*B1", cells: { A1: 9, B1: 12 }, label: "Operating budget" }, document_edits: [] });
    assert.equal((budgetPreview.documents.budget as { total: number }).total, 108);
    assert.equal((budgetPreview.documents.budget as { html: string }).html, "<p>Operating budget: <strong>108.00</strong></p>");
    const budgetExport = await service.exportApp(otherApp.app_id);
    assert.ok(budgetExport.files.some((file) => file.path === "host/main.js"));
  } finally {
    service?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a restart after the app commit completes the original job without another revision", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-recombination-replay-"));
  const first = new FilesystemRecombinationService(root);
  let restarted: FilesystemRecombinationService | null = null;
  try {
    await first.seedAuthored();
    const plan = await first.notebookPlan();
    let committedResolve: (result: { app_id: string; revision: number }) => void = () => {};
    let committedReject: (error: unknown) => void = () => {};
    const committed = new Promise<{ app_id: string; revision: number }>((resolve, reject) => {
      committedResolve = resolve;
      committedReject = reject;
    });
    const jobs = new JobManager(root);
    const started = jobs.start("application_build", hashJson({ plan }), async (job) => {
      try {
        const result = await first.buildApp(plan, job);
        committedResolve(result);
        await new Promise(() => {}); // Simulate a process lost before writing its job result.
        return { result_ref: `app:${result.app_id}:${result.revision}` };
      } catch (error) {
        committedReject(error);
        throw error;
      }
    }, { kind: "application_build", request: { plan } });
    const saved = await committed;
    assert.equal(saved.revision, 0);
    assert.equal(first.state.getAppByBuildJob(started.job_id)?.revision, 0);
    first.close();

    restarted = new FilesystemRecombinationService(root);
    const recoveredJobs = new JobManager(root);
    createRecombinationRouter(restarted, recoveredJobs);
    await recoveredJobs.wait(started.job_id);
    assert.equal(recoveredJobs.get(started.job_id)?.status, "succeeded");
    assert.equal(recoveredJobs.get(started.job_id)?.result_ref, `app:${saved.app_id}:0`);
    assert.equal(restarted.state.listApps().filter((record) => record.app_id === saved.app_id).length, 1);
  } finally {
    try { first.close(); } catch { /* Already closed after the simulated crash. */ }
    restarted?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
