import assert from "node:assert/strict";
import { test } from "node:test";
import { CompositionPlan } from "@splice/contracts";
import { notebookPlan } from "../example/notebook.js";
import { openMemoryStateStore } from "../state/store.js";
import { NamespacedStateStore } from "./appStore.js";
import { applyDocumentMigration, documentSignature, documentTransition, initializeDocuments, validateStoredDocuments } from "./documentMigrations.js";

function plans() {
  const packages = new Map([
    ["splice.example.formula", `pkg_${"a".repeat(32)}`],
    ["splice.example.markdown", `pkg_${"b".repeat(32)}`],
    ["splice.example.transcription", `pkg_${"c".repeat(32)}`],
  ]);
  const next = CompositionPlan.parse(notebookPlan(packages));
  const old = structuredClone(next);
  old.documents = old.documents.filter((document) => document.id !== "workbook");
  delete old.document_migrations;
  return { old, next };
}

test("an additive document migration preserves existing state across activation and rollback", () => {
  const { old, next } = plans();
  const state = openMemoryStateStore();
  const app = new NamespacedStateStore(state, "app_test");
  try {
    const meeting = app.putDocument("meeting", { transcript: [], formula: "=1", value: 1, html: "<p>saved</p>" }, null);
    const migration = documentTransition(old, next);
    assert.ok(migration);
    applyDocumentMigration(app, next, migration);
    assert.deepEqual(app.getDocument("meeting"), meeting);
    assert.deepEqual(app.getDocument("workbook")?.data, { cells: {} });
    const edited = app.putDocument("workbook", { cells: { B2: 3, C2: 20 } }, 1);
    assert.equal(documentTransition(next, old, true), null, "an old stored revision hides newer documents without deleting data");
    assert.throws(() => documentTransition(next, old), /explicit data migration/);
    applyDocumentMigration(app, next, documentTransition(old, next)!);
    assert.deepEqual(app.getDocument("workbook"), edited, "reactivation retains workbook edits");
    assert.deepEqual(app.getDocument("meeting"), meeting);
  } finally { state.close(); }
});

test("document migration rejects silent schema changes and rolls back partial creation", () => {
  const { old, next } = plans();
  const missing = structuredClone(next);
  delete missing.document_migrations;
  assert.throws(() => documentTransition(old, missing), /explicit data migration/);
  const changed = structuredClone(next);
  changed.documents[0].schema.fields.push({ name: "surprise", type: { kind: "string", encoding: "utf-8", max_bytes: 20 }, optional: true });
  assert.throws(() => documentTransition(old, changed), /explicit data migration/);

  const state = openMemoryStateStore();
  try {
    const target = structuredClone(next);
    target.documents.push({
      id: "settings", kind: "document", owner_instance: null, revisioned: true,
      description: "Settings", schema: { kind: "object", additional: false, fields: [{ name: "enabled", type: { kind: "bool" }, optional: false }] }, initial: { enabled: false },
    });
    target.document_migrations = [{ id: "add_two", from_signature: documentSignature(old.documents), to_signature: documentSignature(target.documents), add_documents: ["workbook", "settings"] }];
    state.putDocument("settings", { invalid: true }, null);
    assert.throws(() => applyDocumentMigration(state, target, target.document_migrations![0]), /unexpected field invalid/);
    assert.equal(state.getDocument("workbook"), null, "all document creations roll back on a later invalid document");
  } finally { state.close(); }
});

test("installed revisions reject incompatible saved documents before initialization", () => {
  const { old, next } = plans();
  const state = openMemoryStateStore();
  try {
    state.putDocument("meeting", { transcript: [], formula: "=1", value: 1, html: "<p>saved</p>", newer_field: true }, null);
    assert.throws(() => validateStoredDocuments(state, old), /Saved document meeting is incompatible/);
    assert.equal(state.getDocument("workbook"), null);
    assert.equal(state.getDocument("meeting")?.revision, 1);

    const compatible = openMemoryStateStore();
    try {
      compatible.putDocument("meeting", { transcript: [], formula: "=1", value: 1, html: "<p>saved</p>" }, null);
      compatible.putDocument("workbook", { cells: { B2: 3 } }, null);
      validateStoredDocuments(compatible, old);
      initializeDocuments(compatible, old);
      assert.deepEqual(compatible.getDocument("workbook")?.data, { cells: { B2: 3 } }, "retired documents remain hidden and intact");
      validateStoredDocuments(compatible, next);
    } finally { compatible.close(); }
  } finally { state.close(); }
});
