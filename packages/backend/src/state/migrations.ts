// Ordered, hashed schema migrations for the durable application state.
// The runner applies pending migrations atomically and refuses a database that was written by a
// newer build or whose migration SQL no longer matches the recorded hash.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const CORE_MIGRATION: Migration = {
  version: 1,
  name: "core_documents_apps_outbox_jobs",
  sql: `
CREATE TABLE IF NOT EXISTS documents (
  document TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS apps (
  app_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified', 'failed')),
  app_hash TEXT NOT NULL,
  bundle TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, revision)
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  progress TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  result_ref TEXT,
  error TEXT,
  request_hash TEXT NOT NULL
);
`.trim(),
};

export const INDEX_MIGRATION: Migration = {
  version: 2,
  name: "query_indexes",
  sql: `
CREATE INDEX IF NOT EXISTS idx_apps_latest ON apps (app_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_apps_status ON apps (app_id, status, revision DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox (status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents (updated_at);
`.trim(),
};

/**
 * Streaming operations dedupe events across restarts. The scope is a plan workflow/step pair so
 * two workflows never hide each other's events.
 */
export const PROCESSED_EVENTS_MIGRATION: Migration = {
  version: 3,
  name: "processed_events",
  sql: `
CREATE TABLE IF NOT EXISTS processed_events (
  scope TEXT NOT NULL,
  event_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, event_key)
);
`.trim(),
};

/** Tie a persisted app revision to the build job that produced it for restart replay. */
export const APP_BUILD_JOB_MIGRATION: Migration = {
  version: 4,
  name: "app_build_job_identity",
  sql: `
ALTER TABLE apps ADD COLUMN build_job_id TEXT;
CREATE UNIQUE INDEX idx_apps_build_job ON apps (build_job_id) WHERE build_job_id IS NOT NULL;
`.trim(),
};

/** Keep a durable active revision so a verified older build can be restored without deleting history. */
export const ACTIVE_APP_REVISION_MIGRATION: Migration = {
  version: 5,
  name: "active_app_revision",
  sql: `
CREATE TABLE IF NOT EXISTS app_active_revisions (
  app_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (app_id, revision) REFERENCES apps (app_id, revision)
);
INSERT INTO app_active_revisions (app_id, revision, updated_at)
SELECT app_id, MAX(revision), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM apps WHERE status = 'verified' GROUP BY app_id;
`.trim(),
};

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  CORE_MIGRATION,
  INDEX_MIGRATION,
  PROCESSED_EVENTS_MIGRATION,
  APP_BUILD_JOB_MIGRATION,
  ACTIVE_APP_REVISION_MIGRATION,
]);

export type MigrationErrorCode =
  | "migration_unknown"
  | "migration_hash_mismatch"
  | "migration_order"
  | "migration_failed";

export class MigrationError extends Error {
  constructor(
    readonly code: MigrationErrorCode,
    message: string,
    readonly version: number | null = null,
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

/** Content identity of one migration. Recorded in `schema_migrations` and checked on open. */
export function migrationHash(migration: Pick<Migration, "version" | "name" | "sql">): string {
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
    .digest("hex");
}

export interface AppliedMigrationRow {
  version: number;
  name: string;
  hash: string;
  applied_at: string;
}

const CREATE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  hash TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`.trim();

function prepareMigrations(migrations: readonly Migration[]): Migration[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const seen = new Set<number>();
  for (const migration of sorted) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new MigrationError("migration_order", `Migration version ${migration.version} is not a positive integer`, migration.version);
    }
    if (seen.has(migration.version)) {
      throw new MigrationError("migration_order", `Duplicate migration version ${migration.version}`, migration.version);
    }
    if (!migration.name || !migration.sql.trim()) {
      throw new MigrationError("migration_order", `Migration ${migration.version} needs a name and SQL`, migration.version);
    }
    seen.add(migration.version);
  }
  return sorted;
}

export function readAppliedMigrations(db: DatabaseSync): AppliedMigrationRow[] {
  db.exec(CREATE_MIGRATIONS_TABLE);
  const rows = db
    .prepare("SELECT version, name, hash, applied_at FROM schema_migrations ORDER BY version ASC")
    .all() as Array<{ version: number | bigint; name: string; hash: string; applied_at: string }>;
  return rows.map((row) => ({
    version: Number(row.version),
    name: String(row.name),
    hash: String(row.hash),
    applied_at: String(row.applied_at),
  }));
}

/**
 * Refuse unknown/newer versions and edited migrations before any pending migration runs.
 * A newer database is never downgraded: the caller must open a newer build instead.
 */
export function checkAppliedMigrations(
  applied: readonly AppliedMigrationRow[],
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  const known = new Map(prepareMigrations(migrations).map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const knownMigration = known.get(row.version);
    if (!knownMigration) {
      throw new MigrationError(
        "migration_unknown",
        `Database migration ${row.version} (${row.name}) is unknown to this build; refusing to open a newer state store`,
        row.version,
      );
    }
    const expected = migrationHash(knownMigration);
    if (expected !== row.hash) {
      throw new MigrationError(
        "migration_hash_mismatch",
        `Migration ${row.version} (${row.name}) changed after it was applied: recorded ${row.hash}, expected ${expected}`,
        row.version,
      );
    }
  }
}

/**
 * Applies every pending migration in one transaction. Returns the versions now applied.
 * Unknown/hash-mismatched already-applied migrations throw `MigrationError` first.
 */
export function applyMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => string = () => new Date().toISOString(),
): number[] {
  const ordered = prepareMigrations(migrations);
  db.exec(CREATE_MIGRATIONS_TABLE);
  const applied = readAppliedMigrations(db);
  checkAppliedMigrations(applied, ordered);

  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = ordered.filter((migration) => !appliedVersions.has(migration.version));
  if (pending.length === 0) return applied.map((row) => row.version);

  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, hash, applied_at) VALUES (?, ?, ?, ?)",
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of pending) {
      try {
        db.exec(migration.sql);
      } catch (error) {
        throw new MigrationError(
          "migration_failed",
          `Migration ${migration.version} (${migration.name}) failed: ${error instanceof Error ? error.message : String(error)}`,
          migration.version,
        );
      }
      insert.run(migration.version, migration.name, migrationHash(migration), now());
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original failure is more useful than a rollback failure.
    }
    throw error;
  }

  return readAppliedMigrations(db).map((row) => row.version);
}
