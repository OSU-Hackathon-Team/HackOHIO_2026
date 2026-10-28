import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIGRATIONS } from "./migrations.js";
import { AppActiveRevisionConflictError, checkSqliteIntegrity, openStateStore, restoreStateStore } from "./store.js";

test("migration preserves existing app revisions and records one revision per build job", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-app-build-job-"));
  const appId = `app_${"a".repeat(32)}`;
  const jobId = `job_${"b".repeat(32)}`;
  const old = openStateStore(root, { migrations: MIGRATIONS.slice(0, 3) });
  assert.equal(old.migrationBackupPath, null, "a new database has no pre-migration state to snapshot");
  old.dbHandle.prepare(
    "INSERT INTO apps (app_id, revision, title, status, app_hash, bundle, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(appId, 0, "Existing app", "verified", "a".repeat(64), "{}", new Date().toISOString());
  old.close();

  const upgraded = openStateStore(root);
  try {
    assert.ok(upgraded.migrationBackupPath, "opening older state takes a pre-migration snapshot");
    assert.equal(checkSqliteIntegrity(upgraded.migrationBackupPath).ok, true);
    const restored = restoreStateStore(upgraded.migrationBackupPath, path.join(root, "restored"), { migrations: MIGRATIONS.slice(0, 3) });
    try {
      assert.deepEqual(restored.appliedMigrations(), [1, 2, 3]);
      assert.equal((restored.dbHandle.prepare("SELECT title FROM apps WHERE app_id = ? AND revision = 0").get(appId) as { title: string }).title, "Existing app");
    } finally { restored.close(); }
    assert.deepEqual(upgraded.appliedMigrations(), MIGRATIONS.map((migration) => migration.version));
    assert.equal(upgraded.getApp(appId, 0)?.build_job_id, null);
    assert.equal(upgraded.activeApp(appId)?.revision, 0, "migration selects the latest verified stored revision");
    const record = {
      app_id: appId,
      revision: 1,
      title: "New app",
      status: "verified" as const,
      app_hash: "b".repeat(64),
      bundle: {},
      created_at: new Date().toISOString(),
      build_job_id: jobId,
    };
    upgraded.saveApp(record);
    assert.equal(upgraded.getAppByBuildJob(jobId)?.revision, 1);
    assert.equal(upgraded.activeApp(appId)?.revision, 1);
    upgraded.saveApp(record);
    assert.throws(() => upgraded.saveApp({ ...record, revision: 2 }), /UNIQUE constraint failed/);
    assert.equal(upgraded.getApp(appId, 2), null);
    assert.throws(() => upgraded.saveApp({ ...record, revision: 2, build_job_id: `job_${"c".repeat(32)}` }, 0), AppActiveRevisionConflictError);
    assert.equal(upgraded.getApp(appId, 2), null, "a stale build cannot insert a revision");
    assert.throws(() => upgraded.activateApp(appId, 0, 0), AppActiveRevisionConflictError);
    assert.equal(upgraded.activateApp(appId, 0, 1).revision, 0);
    assert.equal(upgraded.activeApp(appId)?.revision, 0);
  } finally {
    upgraded.close();
  }
  const restarted = openStateStore(root);
  try {
    assert.equal(restarted.migrationBackupPath, null, "a restart without pending migrations does not create another snapshot");
    assert.equal(restarted.getAppByBuildJob(jobId)?.revision, 1);
    assert.equal(restarted.activeApp(appId)?.revision, 0);
  } finally {
    restarted.close();
  }
});

test("a failed storage migration leaves a verified snapshot of the old database", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-failed-migration-"));
  try {
    const old = openStateStore(root, { migrations: MIGRATIONS.slice(0, 3) });
    old.putDocument("saved", { value: 60 }, null);
    old.close();
    const broken = [...MIGRATIONS.slice(0, 3), { version: 4, name: "broken", sql: "CREATE TABLE scratch (id INTEGER); INVALID SQL;" }];
    assert.throws(() => openStateStore(root, { migrations: broken }), /Migration 4.*failed/);
    const backups = fs.readdirSync(root).filter((name) => name.startsWith("state.db.before-migration-") && name.endsWith(".db"));
    assert.equal(backups.length, 1);
    assert.equal(checkSqliteIntegrity(path.join(root, backups[0])).ok, true);
    const reopened = openStateStore(root, { migrations: MIGRATIONS.slice(0, 3) });
    try {
      assert.deepEqual(reopened.appliedMigrations(), [1, 2, 3]);
      assert.deepEqual(reopened.getDocument("saved")?.data, { value: 60 });
    } finally { reopened.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
