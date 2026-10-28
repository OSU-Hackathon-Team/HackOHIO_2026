import {
  ApplicationBundle,
  type ApplicationRecord,
  type ApplicationRevisionListResponse,
  type JsonValue,
} from "@splice/contracts";
import type { AppRevisionRecord, DocumentRecord, OutboxItem, StateStore } from "../state/types.js";

export function nextApplicationRevision(state: StateStore, appId: string): number {
  return Math.max(-1, ...state.listApps().filter((record) => record.app_id === appId).map((record) => record.revision)) + 1;
}

function toApplicationRecord(record: AppRevisionRecord): ApplicationRecord {
  const bundle = ApplicationBundle.parse(record.bundle);
  if (bundle.app_id !== record.app_id || bundle.revision !== record.revision || bundle.app_hash !== record.app_hash || bundle.status !== record.status) {
    throw new Error(`Stored application ${record.app_id}@${record.revision} disagrees with its bundle identity`);
  }
  return {
    app_id: record.app_id,
    revision: record.revision,
    status: record.status,
    app_hash: record.app_hash,
    bundle,
    created_at: record.created_at,
  };
}

export class ApplicationStore {
  constructor(private readonly state: StateStore) {}

  save(bundle: ApplicationBundle, buildJobId?: string, expectedActiveRevision?: number | null): void {
    this.state.saveApp({
      app_id: bundle.app_id,
      revision: bundle.revision,
      title: bundle.title,
      status: bundle.status,
      app_hash: bundle.app_hash,
      bundle,
      created_at: bundle.created_at,
      build_job_id: buildJobId ?? null,
    }, expectedActiveRevision);
  }

  getByBuildJob(jobId: string): ApplicationRecord | null {
    const record = this.state.getAppByBuildJob(jobId);
    return record ? toApplicationRecord(record) : null;
  }

  get(appId: string, revision: number | "latest"): ApplicationRecord | null {
    const record = revision === "latest"
      ? this.state.activeApp(appId)
        ?? this.state.listApps().filter((entry) => entry.app_id === appId && entry.status === "verified").sort((a, b) => b.revision - a.revision)[0]
        ?? this.state.latestApp(appId)
      : this.state.getApp(appId, revision);
    return record ? toApplicationRecord(record) : null;
  }

  list(): { apps: Array<{ app_id: string; revision: number; title: string; status: "verified" | "failed"; created_at: string }> } {
    const fallback = new Map<string, AppRevisionRecord>();
    for (const record of this.state.listApps()) {
      const current = fallback.get(record.app_id);
      if (!current || (record.status === "verified" && current.status !== "verified") || (record.status === current.status && record.revision > current.revision)) {
        fallback.set(record.app_id, record);
      }
    }
    return { apps: [...fallback.values()].map((entry) => {
      const { app_id, revision, title, status, created_at } = this.state.activeApp(entry.app_id) ?? entry;
      return { app_id, revision, title, status, created_at };
    }) };
  }

  revisions(appId: string): ApplicationRevisionListResponse | null {
    const records = this.state.listApps().filter((entry) => entry.app_id === appId);
    if (!records.length) return null;
    return {
      app_id: appId,
      active_revision: this.state.activeApp(appId)?.revision ?? null,
      revisions: records.map(({ revision, status, app_hash, created_at }) => ({ revision, status, app_hash, created_at })),
    };
  }

  activate(appId: string, revision: number, expectedActiveRevision?: number | null): ApplicationRecord {
    return toApplicationRecord(this.state.activateApp(appId, revision, expectedActiveRevision));
  }
}

/** Isolate shared-document IDs per app while keeping the durable database shared. */
export class NamespacedStateStore implements StateStore {
  readonly path: string | null;
  constructor(private readonly inner: StateStore, private readonly namespace: string) {
    this.path = inner.path;
  }
  private key(document: string): string { return `${this.namespace}:${document}`; }
  getDocument(document: string): DocumentRecord | null {
    const result = this.inner.getDocument(this.key(document));
    return result ? { ...result, document } : null;
  }
  putDocument(document: string, data: JsonValue, expectedRevision: number | null): DocumentRecord {
    const result = this.inner.putDocument(this.key(document), data, expectedRevision);
    return { ...result, document };
  }
  listDocuments(): DocumentRecord[] {
    const prefix = `${this.namespace}:`;
    return this.inner.listDocuments().filter((item) => item.document.startsWith(prefix)).map((item) => ({ ...item, document: item.document.slice(prefix.length) }));
  }
  saveApp(record: AppRevisionRecord, expectedActiveRevision?: number | null): void { this.inner.saveApp(record, expectedActiveRevision); }
  getApp(appId: string, revision: number): AppRevisionRecord | null { return this.inner.getApp(appId, revision); }
  getAppByBuildJob(jobId: string): AppRevisionRecord | null { return this.inner.getAppByBuildJob(jobId); }
  latestApp(appId: string): AppRevisionRecord | null { return this.inner.latestApp(appId); }
  activeApp(appId: string): AppRevisionRecord | null { return this.inner.activeApp(appId); }
  activateApp(appId: string, revision: number, expectedActiveRevision?: number | null): AppRevisionRecord { return this.inner.activateApp(appId, revision, expectedActiveRevision); }
  listApps(): AppRevisionRecord[] { return this.inner.listApps(); }
  enqueue(item: Omit<OutboxItem, "id" | "created_at" | "status" | "attempts">): OutboxItem { return this.inner.enqueue(item); }
  pendingOutbox(limit?: number): OutboxItem[] { return this.inner.pendingOutbox(limit); }
  markOutbox(id: string, status: OutboxItem["status"]): void { this.inner.markOutbox(id, status); }
  appliedMigrations(): number[] { return this.inner.appliedMigrations(); }
  transaction<T>(fn: () => T): T { return this.inner.transaction(fn); }
  close(): void { this.inner.close(); }
}
