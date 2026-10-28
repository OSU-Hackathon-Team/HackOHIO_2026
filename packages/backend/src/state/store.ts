// Durable SQLite state behind the `StateStore` interface: revisioned documents, app revisions,
// an outbox for cross-process work, migration tracking, transactions and backups.
//
// `node:sqlite` prints an ExperimentalWarning on Node 22. Tests keep it visible unless they
// deliberately filter it; a real SQLite failure must never be mistaken for that warning.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, type JsonValue } from "@splice/contracts";
import { applyMigrations, checkAppliedMigrations, MIGRATIONS, readAppliedMigrations } from "./migrations.js";
import type { AppRevisionRecord, DocumentRecord, Migration, OutboxItem, StateStore } from "./types.js";

export const STATE_DB_FILENAME = "state.db";

export class StateStoreClosedError extends Error {
  constructor() {
    super("state store is closed");
    this.name = "StateStoreClosedError";
  }
}

/** A write computed from an older revision lost the race with a newer edit. */
export class RevisionConflictError extends Error {
  readonly code = "revision_conflict";
  constructor(
    readonly document: string,
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null,
  ) {
    super(
      expectedRevision === null
        ? `document ${document} already exists at revision ${actualRevision}; expected it to be absent`
        : `document ${document} is at revision ${actualRevision ?? "absent"}, expected ${expectedRevision}`,
    );
    this.name = "RevisionConflictError";
  }
}

/** App revisions are immutable: the same (app_id, revision) cannot be rewritten with new content. */
export class AppRevisionConflictError extends Error {
  readonly code = "app_revision_conflict";
  constructor(
    readonly app_id: string,
    readonly revision: number,
  ) {
    super(`app ${app_id} revision ${revision} already exists with different content`);
    this.name = "AppRevisionConflictError";
  }
}

export class AppActiveRevisionConflictError extends Error {
  readonly code = "app_active_revision_conflict";
  readonly status = 409;
  constructor(readonly app_id: string, readonly expectedRevision: number | null, readonly actualRevision: number | null) {
    super(`app ${app_id} active revision changed from ${expectedRevision ?? "none"} to ${actualRevision ?? "none"}`);
    this.name = "AppActiveRevisionConflictError";
  }
}

export class StateCorruptionError extends Error {
  readonly code = "state_corruption";
  constructor(message: string) {
    super(message);
    this.name = "StateCorruptionError";
  }
}

export interface SqliteStateStoreOptions {
  /** Test seam; production uses the system clock. */
  clock?: () => Date;
  migrations?: readonly Migration[];
}

export interface IntegrityResult {
  ok: boolean;
  problems: string[];
}

type Row = Record<string, string | number | bigint | null>;

function decodeJson(text: string, what: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new StateCorruptionError(
      `${what} holds invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Validates a value through the canonical encoder before it reaches a JSON column. */
function encodeJson(value: unknown, what: string): string {
  try {
    return canonicalJson(value);
  } catch (error) {
    throw new TypeError(
      `${what} is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function asNumber(value: string | number | bigint | null, what: string): number {
  const num = Number(value);
  if (!Number.isSafeInteger(num)) throw new StateCorruptionError(`${what} is not a safe integer: ${String(value)}`);
  return num;
}

function asString(value: string | number | bigint | null, what: string): string {
  if (typeof value !== "string") throw new StateCorruptionError(`${what} is not text: ${String(value)}`);
  return value;
}

export class SqliteStateStore implements StateStore {
  readonly path: string | null;
  private readonly db: DatabaseSync;
  private readonly clock: () => Date;
  private transactionDepth = 0;
  private closed = false;
  readonly migrationBackupPath: string | null;

  constructor(file: string, options: SqliteStateStoreOptions = {}) {
    this.path = file === ":memory:" ? null : path.resolve(file);
    const existingFile = this.path !== null && existsSync(this.path);
    this.migrationBackupPath = null;
    this.clock = options.clock ?? (() => new Date());
    this.db = new DatabaseSync(file);
    try {
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA busy_timeout = 5000");
      if (this.path !== null) {
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA synchronous = NORMAL");
      }
      const migrations = options.migrations ?? MIGRATIONS;
      const applied = readAppliedMigrations(this.db);
      checkAppliedMigrations(applied, migrations);
      if (existingFile && this.path && migrations.some((migration) => !applied.some((row) => row.version === migration.version))) {
        const target = `${this.path}.before-migration-${randomUUID()}.db`;
        this.backupTo(target);
        this.migrationBackupPath = target;
      }
      applyMigrations(this.db, migrations, () => this.now());
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // Keep the original failure.
      }
      throw error;
    }
  }

  get dbHandle(): DatabaseSync {
    this.assertOpen();
    return this.db;
  }

  getDocument(document: string): DocumentRecord | null {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT document, revision, data, updated_at FROM documents WHERE document = ?")
      .get(document) as Row | undefined;
    return row ? this.rowToDocument(row) : null;
  }

  /**
   * Optimistic document write. `expectedRevision === null` creates the document and fails if it
   * already exists; a number must match the stored revision, which is then incremented by one.
   */
  putDocument(document: string, data: JsonValue, expectedRevision: number | null): DocumentRecord {
    this.assertOpen();
    if (!document) throw new TypeError("document id is required");
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
      throw new RangeError(`expectedRevision must be a positive integer or null, got ${expectedRevision}`);
    }
    const encoded = encodeJson(data, `document ${document}`);

    return this.transaction(() => {
      const current = this.getDocument(document);
      const now = this.now();
      if (expectedRevision === null) {
        if (current) throw new RevisionConflictError(document, null, current.revision);
        this.db
          .prepare("INSERT INTO documents (document, revision, data, updated_at) VALUES (?, 1, ?, ?)")
          .run(document, encoded, now);
        return { document, revision: 1, data: decodeJson(encoded, `document ${document}`), updated_at: now };
      }
      const result = this.db
        .prepare("UPDATE documents SET revision = revision + 1, data = ?, updated_at = ? WHERE document = ? AND revision = ?")
        .run(encoded, now, document, expectedRevision);
      if (Number(result.changes) !== 1) {
        const actual = this.getDocument(document);
        throw new RevisionConflictError(document, expectedRevision, actual?.revision ?? null);
      }
      return {
        document,
        revision: expectedRevision + 1,
        data: decodeJson(encoded, `document ${document}`),
        updated_at: now,
      };
    });
  }

  listDocuments(): DocumentRecord[] {
    this.assertOpen();
    const rows = this.db
      .prepare("SELECT document, revision, data, updated_at FROM documents ORDER BY document ASC")
      .all() as Row[];
    return rows.map((row) => this.rowToDocument(row));
  }

  saveApp(record: AppRevisionRecord, expectedActiveRevision?: number | null): void {
    this.assertOpen();
    if (!record.app_id) throw new TypeError("app_id is required");
    if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
      throw new RangeError(`app revision must be a non-negative integer, got ${record.revision}`);
    }
    if (record.status !== "verified" && record.status !== "failed") {
      throw new RangeError(`app status must be verified or failed, got ${String(record.status)}`);
    }
    if (record.build_job_id != null && !/^job_[a-f0-9]{32}$/.test(record.build_job_id)) {
      throw new TypeError(`invalid build job id ${record.build_job_id}`);
    }
    const bundle = encodeJson(record.bundle, `app ${record.app_id}@${record.revision} bundle`);
    this.transaction(() => {
      this.assertExpectedActive(record.app_id, expectedActiveRevision);
      const existing = this.getApp(record.app_id, record.revision);
      if (existing) {
        if (existing.app_hash !== record.app_hash || (existing.build_job_id ?? null) !== (record.build_job_id ?? null)) {
          throw new AppRevisionConflictError(record.app_id, record.revision);
        }
        return;
      }
      this.db
        .prepare(
          `INSERT INTO apps (app_id, revision, title, status, app_hash, bundle, created_at, build_job_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.app_id,
          record.revision,
          record.title,
          record.status,
          record.app_hash,
          bundle,
          record.created_at,
          record.build_job_id ?? null,
        );
      if (record.status === "verified") this.setActiveApp(record.app_id, record.revision);
    });
  }

  private setActiveApp(app_id: string, revision: number): void {
    this.db.prepare(
      `INSERT INTO app_active_revisions (app_id, revision, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at`,
    ).run(app_id, revision, this.now());
  }

  private assertExpectedActive(app_id: string, expected: number | null | undefined): void {
    if (expected === undefined) return;
    const actual = this.activeApp(app_id)?.revision ?? null;
    if (actual !== expected) throw new AppActiveRevisionConflictError(app_id, expected, actual);
  }

  getApp(app_id: string, revision: number): AppRevisionRecord | null {
    this.assertOpen();
    const row = this.db
      .prepare(
        "SELECT app_id, revision, title, status, app_hash, bundle, created_at, build_job_id FROM apps WHERE app_id = ? AND revision = ?",
      )
      .get(app_id, revision) as Row | undefined;
    return row ? this.rowToApp(row) : null;
  }

  getAppByBuildJob(job_id: string): AppRevisionRecord | null {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT app_id, revision, title, status, app_hash, bundle, created_at, build_job_id FROM apps WHERE build_job_id = ?")
      .get(job_id) as Row | undefined;
    return row ? this.rowToApp(row) : null;
  }

  latestApp(app_id: string): AppRevisionRecord | null {
    this.assertOpen();
    const row = this.db
      .prepare(
        "SELECT app_id, revision, title, status, app_hash, bundle, created_at, build_job_id FROM apps WHERE app_id = ? ORDER BY revision DESC LIMIT 1",
      )
      .get(app_id) as Row | undefined;
    return row ? this.rowToApp(row) : null;
  }

  activeApp(app_id: string): AppRevisionRecord | null {
    this.assertOpen();
    const row = this.db.prepare(
      `SELECT apps.app_id, apps.revision, apps.title, apps.status, apps.app_hash, apps.bundle, apps.created_at, apps.build_job_id
       FROM app_active_revisions AS active JOIN apps USING (app_id, revision) WHERE active.app_id = ?`,
    ).get(app_id) as Row | undefined;
    return row ? this.rowToApp(row) : null;
  }

  activateApp(app_id: string, revision: number, expectedActiveRevision?: number | null): AppRevisionRecord {
    return this.transaction(() => {
      this.assertExpectedActive(app_id, expectedActiveRevision);
      const record = this.getApp(app_id, revision);
      if (!record) throw new RangeError(`unknown app revision ${app_id}@${revision}`);
      if (record.status !== "verified") throw new RangeError(`app revision ${app_id}@${revision} is not verified`);
      this.setActiveApp(app_id, revision);
      return record;
    });
  }

  listApps(): AppRevisionRecord[] {
    this.assertOpen();
    const rows = this.db
      .prepare(
        "SELECT app_id, revision, title, status, app_hash, bundle, created_at, build_job_id FROM apps ORDER BY app_id ASC, revision DESC",
      )
      .all() as Row[];
    return rows.map((row) => this.rowToApp(row));
  }

  enqueue(item: Omit<OutboxItem, "id" | "created_at" | "status" | "attempts">): OutboxItem {
    this.assertOpen();
    if (!item.topic) throw new TypeError("outbox topic is required");
    const payload = encodeJson(item.payload, `outbox ${item.topic}`);
    const record: OutboxItem = {
      id: `ob_${randomUUID().replace(/-/g, "")}`,
      topic: item.topic,
      payload: decodeJson(payload, `outbox ${item.topic}`),
      status: "pending",
      attempts: 0,
      created_at: this.now(),
    };
    this.db
      .prepare("INSERT INTO outbox (id, topic, payload, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(record.id, record.topic, payload, record.status, record.attempts, record.created_at);
    return record;
  }

  pendingOutbox(limit = 100): OutboxItem[] {
    this.assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("outbox limit must be a positive integer");
    const rows = this.db
      .prepare(
        "SELECT id, topic, payload, status, attempts, created_at FROM outbox WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?",
      )
      .all(Math.min(limit, 1000)) as Row[];
    return rows.map((row) => this.rowToOutbox(row));
  }

  markOutbox(id: string, status: OutboxItem["status"]): void {
    this.assertOpen();
    const result =
      status === "failed"
        ? this.db.prepare("UPDATE outbox SET status = ?, attempts = attempts + 1 WHERE id = ?").run(status, id)
        : this.db.prepare("UPDATE outbox SET status = ? WHERE id = ?").run(status, id);
    if (Number(result.changes) !== 1) throw new RangeError(`unknown outbox item ${id}`);
  }

  /** Streaming dedupe survives a restart; the executor uses it when the store supports it. */
  hasProcessedEvent(scope: string, eventKey: string): boolean {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT 1 AS present FROM processed_events WHERE scope = ? AND event_key = ?")
      .get(scope, eventKey) as Row | undefined;
    return Boolean(row);
  }

  recordProcessedEvent(scope: string, eventKey: string): void {
    this.assertOpen();
    this.db
      .prepare("INSERT OR IGNORE INTO processed_events (scope, event_key, created_at) VALUES (?, ?, ?)")
      .run(scope, eventKey, this.now());
  }

  appliedMigrations(): number[] {
    this.assertOpen();
    return readAppliedMigrations(this.db).map((row) => row.version);
  }

  transaction<T>(fn: () => T): T {
    this.assertOpen();
    const outer = this.transactionDepth === 0;
    const savepoint = `splice_sp_${this.transactionDepth}`;
    if (outer) this.db.exec("BEGIN IMMEDIATE");
    else this.db.exec(`SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = fn();
      this.transactionDepth -= 1;
      if (outer) this.db.exec("COMMIT");
      else this.db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.transactionDepth -= 1;
      try {
        if (outer) this.db.exec("ROLLBACK");
        else {
          this.db.exec(`ROLLBACK TO ${savepoint}`);
          this.db.exec(`RELEASE ${savepoint}`);
        }
      } catch {
        // The original failure is the useful one.
      }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.transactionDepth > 0) {
      this.transactionDepth = 0;
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Nothing to roll back.
      }
    }
    this.db.close();
  }

  /**
   * Consistent snapshot through `VACUUM INTO` (includes committed WAL pages), then an integrity
   * check of the produced file. Never overwrites an existing backup.
   */
  backupTo(destination: string): { path: string; sha256: string; integrity: IntegrityResult } {
    this.assertOpen();
    const target = path.resolve(destination);
    if (existsSync(target)) throw new Error(`backup destination already exists: ${target}`);
    mkdirSync(path.dirname(target), { recursive: true });
    this.db.prepare("VACUUM INTO ?").run(target);
    const integrity = checkSqliteIntegrity(target);
    if (!integrity.ok) throw new StateCorruptionError(`backup integrity check failed: ${integrity.problems.join("; ")}`);
    return { path: target, sha256: fileSha256(target), integrity };
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private assertOpen(): void {
    if (this.closed) throw new StateStoreClosedError();
  }

  private rowToDocument(row: Row): DocumentRecord {
    const document = asString(row.document, "documents.document");
    return {
      document,
      revision: asNumber(row.revision, `documents[${document}].revision`),
      data: decodeJson(asString(row.data, `documents[${document}].data`), `document ${document}`),
      updated_at: asString(row.updated_at, `documents[${document}].updated_at`),
    };
  }

  private rowToApp(row: Row): AppRevisionRecord {
    const app_id = asString(row.app_id, "apps.app_id");
    const revision = asNumber(row.revision, `apps[${app_id}].revision`);
    return {
      app_id,
      revision,
      title: asString(row.title, `apps[${app_id}@${revision}].title`),
      status: asString(row.status, `apps[${app_id}@${revision}].status`) as "verified" | "failed",
      app_hash: asString(row.app_hash, `apps[${app_id}@${revision}].app_hash`),
      bundle: decodeJson(asString(row.bundle, `apps[${app_id}@${revision}].bundle`), `app ${app_id}@${revision} bundle`),
      created_at: asString(row.created_at, `apps[${app_id}@${revision}].created_at`),
      build_job_id: row.build_job_id === null ? null : asString(row.build_job_id, `apps[${app_id}@${revision}].build_job_id`),
    };
  }

  private rowToOutbox(row: Row): OutboxItem {
    const id = asString(row.id, "outbox.id");
    const status = asString(row.status, `outbox[${id}].status`);
    if (status !== "pending" && status !== "delivered" && status !== "failed") {
      throw new StateCorruptionError(`outbox[${id}].status is invalid: ${status}`);
    }
    return {
      id,
      topic: asString(row.topic, `outbox[${id}].topic`),
      payload: decodeJson(asString(row.payload, `outbox[${id}].payload`), `outbox ${id}`),
      status,
      attempts: asNumber(row.attempts, `outbox[${id}].attempts`),
      created_at: asString(row.created_at, `outbox[${id}].created_at`),
    };
  }
}

function fileSha256(file: string): string {
  const digest = createHash("sha256");
  const fd = openSync(file, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      digest.update(chunk.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return digest.digest("hex");
}

/** Opens (and creates) `<dir>/state.db`, applying migrations. */
export function openStateStore(dir: string, options: SqliteStateStoreOptions = {}): SqliteStateStore {
  mkdirSync(dir, { recursive: true });
  return new SqliteStateStore(path.join(dir, STATE_DB_FILENAME), options);
}

/** Test helper: an isolated in-memory store. It is not durable and never pretends to be. */
export function openMemoryStateStore(options: SqliteStateStoreOptions = {}): SqliteStateStore {
  return new SqliteStateStore(":memory:", options);
}

/** Opens a SQLite file and runs `PRAGMA integrity_check`. */
export function checkSqliteIntegrity(file: string): IntegrityResult {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, string>>;
    const problems = rows
      .map((row) => Object.values(row)[0])
      .filter((value): value is string => typeof value === "string" && value !== "ok");
    return { ok: problems.length === 0, problems };
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)] };
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore: a failed integrity check already reported the problem.
    }
  }
}

/**
 * Copies a verified backup into `dir/state.db` and opens it. Refuses a corrupt source or an
 * existing state file, so an import can never silently replace live data.
 */
export function restoreStateStore(
  source: string,
  dir: string,
  options: SqliteStateStoreOptions = {},
): SqliteStateStore {
  const sourcePath = path.resolve(source);
  if (!existsSync(sourcePath)) throw new Error(`backup not found: ${sourcePath}`);
  const integrity = checkSqliteIntegrity(sourcePath);
  if (!integrity.ok) throw new StateCorruptionError(`backup integrity check failed: ${integrity.problems.join("; ")}`);

  const verification = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const tables = verification
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map((table) => String(table.name)));
    for (const required of ["schema_migrations", "documents", "apps", "outbox"]) {
      if (!names.has(required)) throw new StateCorruptionError(`backup is missing table ${required}`);
    }
    const applied = readAppliedMigrations(verification).map((row) => ({
      version: row.version,
      name: row.name,
      hash: row.hash,
      applied_at: row.applied_at,
    }));
    checkAppliedMigrations(applied, options.migrations ?? MIGRATIONS);
  } finally {
    verification.close();
  }

  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, STATE_DB_FILENAME);
  if (existsSync(target)) throw new Error(`refusing to overwrite existing state store: ${target}`);
  copyFileSync(sourcePath, target);
  try {
    return new SqliteStateStore(target, options);
  } catch (error) {
    try {
      rmSync(target, { force: true });
    } catch {
      // Keep the original failure.
    }
    throw error;
  }
}
