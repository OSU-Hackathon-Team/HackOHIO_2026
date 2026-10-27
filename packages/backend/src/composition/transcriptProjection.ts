import { encodeWireValue, type CompositionPlan, type JsonValue, type TranscriptionSession } from "@splice/contracts";
import type { StateStore } from "../state/types.js";
import { TranscriptionStore } from "../state/transcriptions.js";
import { writePath } from "./bindings.js";

/** Project one session snapshot into its declared document under the caller's state transaction. */
export function projectTranscript(
  state: StateStore,
  transcriptions: TranscriptionStore,
  plan: CompositionPlan,
  session: TranscriptionSession,
  segments: TranscriptionSession["segments"],
): void {
  const projection = session.projection;
  if (!projection) return;
  const declared = plan.providers.find((item) => item.id === projection.provider_id)?.document_projection;
  if (!declared || declared.document !== projection.document || declared.path !== projection.path || declared.id_prefix !== projection.id_prefix) {
    throw new Error("Provider document projection changed during transcription");
  }
  const definition = plan.documents.find((item) => item.id === projection.document);
  if (!definition) throw new Error(`Document ${projection.document} is unavailable during transcription`);
  const current = state.getDocument(projection.document);
  if (!current || current.revision !== projection.revision) throw new Error(`Document ${projection.document} changed during transcription`);
  if (!current.data || typeof current.data !== "object" || Array.isArray(current.data)) throw new Error(`Document ${projection.document} is not an object`);
  const data = structuredClone(current.data) as Record<string, unknown>;
  writePath(data, projection.path, segments.map((item) => ({
    id: `${projection.id_prefix}-${item.index}`, start_ms: item.start_ms, end_ms: item.end_ms, text: item.text,
  })));
  const validated = encodeWireValue(definition.schema, data) as JsonValue;
  const saved = state.putDocument(projection.document, validated, projection.revision);
  transcriptions.setProjectionRevision(session.session_id, session.attempt, saved.revision);
}
