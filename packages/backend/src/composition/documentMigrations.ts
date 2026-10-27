import { decodeWireValue, encodeWireValue, type CompositionPlan, type DocumentDef, type DocumentMigration } from "@splice/contracts";
import type { StateStore } from "../state/types.js";
import { hashJson } from "../capabilities/identity.js";

type DocumentSet = Pick<CompositionPlan, "documents">;

export function documentSignature(documents: readonly DocumentDef[]): string {
  return hashJson(documents.map((document) => ({
    id: document.id,
    schema: document.schema,
    owner_instance: document.owner_instance,
    revisioned: document.revisioned,
  })).sort((a, b) => a.id.localeCompare(b.id)));
}

/** Resolve only a declared additive transition. A stored older revision may hide newer documents without deleting them. */
export function documentTransition(current: DocumentSet, target: CompositionPlan, allowRetiredDocuments = false): DocumentMigration | null {
  if (documentSignature(current.documents) === documentSignature(target.documents)) return null;
  const old = new Map(current.documents.map((document) => [document.id, document]));
  const next = new Map(target.documents.map((document) => [document.id, document]));
  const sharedChanged = [...old].some(([id, document]) => next.has(id) && documentSignature([document]) !== documentSignature([next.get(id)!]));
  if (sharedChanged) throw new Error("Application document schemas changed; an explicit data migration is required before switching revisions");
  const removed = [...old.keys()].filter((id) => !next.has(id));
  const added = [...next.keys()].filter((id) => !old.has(id)).sort();
  if (removed.length && (added.length || !allowRetiredDocuments)) {
    throw new Error("Application documents were removed; an explicit data migration is required before switching revisions");
  }
  if (!added.length) return null;
  const from = documentSignature(current.documents);
  const to = documentSignature(target.documents);
  const migration = target.document_migrations?.find((item) => item.from_signature === from && item.to_signature === to);
  if (!migration || JSON.stringify([...migration.add_documents].sort()) !== JSON.stringify(added)) {
    throw new Error("Application document schemas changed; an explicit data migration is required before switching revisions");
  }
  for (const id of added) {
    const definition = next.get(id)!;
    if (definition.owner_instance !== null || !definition.revisioned || definition.initial === undefined) {
      throw new Error(`Document migration ${migration.id} requires an initial composition-owned, revisioned document ${id}`);
    }
    encodeWireValue(definition.schema, definition.initial);
  }
  return migration;
}

export function applyDocumentMigration(state: StateStore, target: CompositionPlan, migration: DocumentMigration): void {
  if (migration.to_signature !== documentSignature(target.documents)) throw new Error(`Document migration ${migration.id} has a stale target signature`);
  state.transaction(() => {
    for (const id of migration.add_documents) {
      const definition = target.documents.find((document) => document.id === id);
      if (!definition || definition.owner_instance !== null || !definition.revisioned || definition.initial === undefined) {
        throw new Error(`Document migration ${migration.id} cannot create ${id}`);
      }
      const current = state.getDocument(id);
      if (current) encodeWireValue(definition.schema, current.data);
      else state.putDocument(id, encodeWireValue(definition.schema, definition.initial), null);
    }
  });
}

export function initializeDocuments(state: StateStore, plan: DocumentSet): void {
  state.transaction(() => {
    for (const document of plan.documents) {
      if (document.initial !== undefined && !state.getDocument(document.id)) {
        state.putDocument(document.id, encodeWireValue(document.schema, document.initial), null);
      }
    }
  });
}

/** Check persisted wire data before an installed revision starts or creates missing documents. */
export function validateStoredDocuments(state: StateStore, plan: DocumentSet): void {
  for (const definition of plan.documents) {
    const stored = state.getDocument(definition.id);
    if (!stored) continue;
    try {
      decodeWireValue(definition.schema, stored.data);
    } catch (cause) {
      throw new Error(`Saved document ${definition.id} is incompatible with this application revision; a data migration is required`, { cause });
    }
  }
}
