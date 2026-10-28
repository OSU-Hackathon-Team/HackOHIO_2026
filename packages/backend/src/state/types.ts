import type { JsonValue } from "@splice/contracts";

export interface DocumentRecord {
  document: string;
  revision: number;
  data: JsonValue;
  updated_at: string;
}

export interface AppRevisionRecord {
  app_id: string;
  revision: number;
  title: string;
  status: "verified" | "failed";
  app_hash: string;
  bundle: unknown;
  created_at: string;
  build_job_id?: string | null;
}

export interface OutboxItem {
  id: string;
  topic: string;
  payload: JsonValue;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  created_at: string;
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Durable application state. Revisions are optimistic: a write with a stale expected revision
 * must fail, so a late formula or transcript result cannot overwrite a newer edit.
 */
export interface StateStore {
  readonly path: string | null;
  getDocument(document: string): DocumentRecord | null;
  /** `expectedRevision` null means "create or replace only if absent". */
  putDocument(document: string, data: JsonValue, expectedRevision: number | null): DocumentRecord;
  listDocuments(): DocumentRecord[];
  saveApp(record: AppRevisionRecord, expectedActiveRevision?: number | null): void;
  getApp(app_id: string, revision: number): AppRevisionRecord | null;
  getAppByBuildJob(job_id: string): AppRevisionRecord | null;
  latestApp(app_id: string): AppRevisionRecord | null;
  activeApp(app_id: string): AppRevisionRecord | null;
  activateApp(app_id: string, revision: number, expectedActiveRevision?: number | null): AppRevisionRecord;
  listApps(): AppRevisionRecord[];
  enqueue(item: Omit<OutboxItem, "id" | "created_at" | "status" | "attempts">): OutboxItem;
  pendingOutbox(limit?: number): OutboxItem[];
  markOutbox(id: string, status: OutboxItem["status"]): void;
  appliedMigrations(): number[];
  transaction<T>(fn: () => T): T;
  close(): void;
}
