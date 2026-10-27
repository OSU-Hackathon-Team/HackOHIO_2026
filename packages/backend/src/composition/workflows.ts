import {
  decodeWireValue,
  encodeWireValue,
  type CapabilityDefinition,
  type CompositionPlan,
  type JsonValue,
  type OperationSpec,
  type Workflow,
  type WorkflowStep,
  type WireObjectType,
} from "@splice/contracts";
import { randomUUID } from "node:crypto";
import type { DocumentRecord, StateStore } from "../state/types.js";
import { applyBinding, applyTransform, readPath, writePath, wireField } from "./bindings.js";

export interface WorkflowRunOptions {
  runId?: string;
  signal?: AbortSignal;
  onEvent?(stepId: string, event: unknown): void;
}

export interface WorkflowCapabilityClient {
  call(operation: string, input: Record<string, unknown>, options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    onEvent?(event: unknown): void;
  }): Promise<Record<string, unknown>>;
}

export interface WorkflowRunResult {
  status: "succeeded" | "failed" | "cancelled";
  documents: Record<string, JsonValue>;
  step_results: Record<string, unknown>;
  errors: Record<string, string>;
}

export class WorkflowExecutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkflowExecutionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSource(expression: string): { kind: "input" | "document" | "step" | "binding"; id: string | null; path: string } {
  const input = /^\$input\.(.+)$/.exec(expression);
  if (input) return { kind: "input", id: null, path: input[1] };
  const doc = /^\$doc\.([a-z][a-z0-9_-]{0,63})\.(.+)$/.exec(expression);
  if (doc) return { kind: "document", id: doc[1], path: doc[2] };
  const step = /^\$steps\.([a-z][a-z0-9_]{0,63})(?:\.(.+))?$/.exec(expression);
  if (step) return { kind: "step", id: step[1], path: step[2] ?? "" };
  const binding = /^\$bindings\.([a-z][a-z0-9_-]{0,63})\.(.+)$/.exec(expression);
  if (binding) return { kind: "binding", id: binding[1], path: binding[2] };
  throw new WorkflowExecutionError("mapping_source_invalid", `Unsupported workflow source ${expression}`);
}

function topoSort(workflow: Workflow): WorkflowStep[] {
  const byId = new Map(workflow.steps.map((step) => [step.id, step]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: WorkflowStep[] = [];
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new WorkflowExecutionError("workflow_cycle", `Workflow ${workflow.id} contains a cycle`);
    const step = byId.get(id);
    if (!step) throw new WorkflowExecutionError("unknown_dependency", `Workflow ${workflow.id} references unknown step ${id}`);
    visiting.add(id);
    for (const dependency of step.depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    result.push(step);
  };
  for (const step of workflow.steps) visit(step.id);
  return result;
}

function encodeDocValue(type: ReturnType<typeof wireField>, value: unknown): JsonValue {
  if (!type) throw new WorkflowExecutionError("document_path_missing", "Document schema does not contain the write path");
  return encodeWireValue(type, value) as JsonValue;
}

function decodeDocValue(type: ReturnType<typeof wireField>, value: unknown): unknown {
  if (!type) throw new WorkflowExecutionError("document_path_missing", "Document schema does not contain the source path");
  return decodeWireValue(type, value);
}

export class WorkflowEngine {
  constructor(
    private readonly store: StateStore,
    private readonly definitions: ReadonlyMap<string, CapabilityDefinition>,
    private readonly clients: ReadonlyMap<string, WorkflowCapabilityClient>,
  ) {}

  async run(plan: CompositionPlan, workflowId: string, input: Record<string, unknown>, options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
    const workflow = plan.workflows.find((candidate) => candidate.id === workflowId);
    if (!workflow) throw new WorkflowExecutionError("workflow_missing", `Unknown workflow ${workflowId}`);
    try {
      encodeWireValue(workflow.input, input);
    } catch (error) {
      throw new WorkflowExecutionError("workflow_input_invalid", error instanceof Error ? error.message : String(error));
    }
    const runId = options.runId ?? `run_${randomUUID()}`;
    const stepResults: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    const operationByStep = new Map<string, OperationSpec>();
    for (const step of workflow.steps) {
      const definition = this.definitions.get(step.operation.instance);
      const operation = definition?.operations.find((candidate) => candidate.name === step.operation.port);
      if (!operation) throw new WorkflowExecutionError("operation_missing", `Unknown operation ${step.operation.instance}.${step.operation.port}`);
      operationByStep.set(step.id, operation);
    }
    const documents: Record<string, JsonValue> = {};
    const refreshDocuments = () => {
      for (const document of plan.documents) {
        const stored = this.store.getDocument(document.id);
        if (stored) documents[document.id] = stored.data;
        else delete documents[document.id];
      }
    };
    refreshDocuments();

    for (const step of topoSort(workflow)) {
      refreshDocuments();
      if (options.signal?.aborted && step.cancellation !== "isolated") {
        return { status: "cancelled", documents, step_results: stepResults, errors };
      }
      const operation = operationByStep.get(step.id)!;
      const client = this.clients.get(step.operation.instance);
      if (!client) throw new WorkflowExecutionError("client_missing", `No runtime client for ${step.operation.instance}`);
      const request: Record<string, unknown> = {};
      for (const mapping of step.input) {
        const source = parseSource(mapping.from);
        const sourceValue = this.resolveSource(source, input, stepResults, plan, documents);
        const targetType = wireField(operation.request, mapping.to);
        if (!targetType) throw new WorkflowExecutionError("request_field_missing", `Operation ${operation.name} has no request field ${mapping.to}`);
        const transformed = applyTransform(sourceValue.value, mapping.transform, mapping.factor);
        writePath(request, mapping.to, transformed);
      }
      if (step.idempotency === "key") {
        const keyField = operation.request.fields.find((field) => field.name === "idempotency_key");
        if (!keyField || keyField.type.kind !== "string") {
          throw new WorkflowExecutionError("idempotency_key_missing", `Operation ${operation.name} must declare a string idempotency_key field`);
        }
        request.idempotency_key = `${runId}:${step.id}`;
      }

      const guardDocument = step.stale_guard ? this.store.getDocument(step.stale_guard.document) : null;
      const guardRevision = guardDocument?.revision ?? null;
      const writeSnapshots = new Map<string, DocumentRecord | null>(step.writes.map((write) => [write.document, this.store.getDocument(write.document)]));
      let result: Record<string, unknown> | null = null;
      let lastError: unknown;
      const outbox = this.store.enqueue({
        topic: "workflow.operation",
        payload: {
          run_id: runId,
          workflow: workflow.id,
          step: step.id,
          instance: step.operation.instance,
          operation: operation.name,
          request: encodeWireValue(operation.request, request) as JsonValue,
        },
      });
      for (let attempt = 0; attempt <= step.retries; attempt += 1) {
        try {
          result = await client.call(operation.name, request, {
            signal: step.cancellation === "isolated" ? undefined : options.signal,
            timeoutMs: Math.min(step.timeout_ms, operation.timeout_ms),
            onEvent: (event) => options.onEvent?.(step.id, event),
          });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const code = (error as { code?: string }).code;
          const retryable = (error as { retryable?: boolean }).retryable === true;
          const codeAllowed = step.retry_on_codes.length === 0 || (typeof code === "string" && step.retry_on_codes.includes(code));
          if (attempt >= step.retries || !operation.idempotent || !retryable || !codeAllowed) break;
        }
      }
      if (!result) {
        this.store.markOutbox(outbox.id, "failed");
        const message = lastError instanceof Error ? lastError.message : String(lastError ?? "operation failed");
        errors[step.id] = message;
        if (step.on_error === "fail") {
          refreshDocuments();
          return { status: options.signal?.aborted ? "cancelled" : "failed", documents, step_results: stepResults, errors };
        }
        continue;
      }
      this.store.markOutbox(outbox.id, "delivered");
      if (step.stale_guard) {
        const current = this.store.getDocument(step.stale_guard.document);
        if ((current?.revision ?? null) !== guardRevision) {
          errors[step.id] = `stale result: document ${step.stale_guard.document} changed during operation`;
          refreshDocuments();
          return { status: "failed", documents, step_results: stepResults, errors };
        }
      }
      stepResults[step.id] = result;
      try {
        this.applyWrites(step, result, stepResults, input, plan, documents, writeSnapshots);
      } catch (error) {
        errors[step.id] = error instanceof Error ? error.message : String(error);
        refreshDocuments();
        return { status: "failed", documents, step_results: stepResults, errors };
      }
    }
    refreshDocuments();
    return { status: Object.keys(errors).length ? "failed" : "succeeded", documents, step_results: stepResults, errors };
  }

  private resolveSource(
    source: ReturnType<typeof parseSource>,
    input: Record<string, unknown>,
    stepResults: Record<string, unknown>,
    plan: CompositionPlan,
    documents: Record<string, JsonValue>,
  ): { value: unknown } {
    if (source.kind === "input") return { value: readPath(input, source.path) };
    if (source.kind === "step") {
      if (!Object.hasOwn(stepResults, source.id!)) throw new WorkflowExecutionError("step_result_missing", `Step ${source.id} has no result`);
      return { value: readPath(stepResults[source.id!], source.path) };
    }
    if (source.kind === "binding") {
      const binding = plan.bindings.find((candidate) => candidate.id === source.id);
      if (!binding) throw new WorkflowExecutionError("binding_missing", "Unknown binding " + source.id);
      const sourceStep = plan.workflows.flatMap((workflow) => workflow.steps).find((step) => step.operation.instance === binding.from.instance && step.operation.port === binding.from.port && Object.hasOwn(stepResults, step.id));
      if (!sourceStep) throw new WorkflowExecutionError("binding_source_missing", "Binding " + binding.id + " has no completed source operation");
      const from = this.definitions.get(binding.from.instance)?.provides.find((port) => port.port === binding.from.port);
      const to = this.definitions.get(binding.to.instance)?.requires.find((port) => port.port === binding.to.port);
      if (!from || !to) throw new WorkflowExecutionError("binding_port_missing", "Binding " + binding.id + " has a missing port");
      const mapped = applyBinding(binding, stepResults[sourceStep.id], from, to);
      return { value: readPath(mapped, source.path) };
    }
    const definition = plan.documents.find((document) => document.id === source.id);
    const data = documents[source.id!];
    if (!definition || data === undefined) throw new WorkflowExecutionError("document_missing", `Document ${source.id} is not initialized`);
    const value = readPath(data, source.path);
    const type = wireField(definition.schema, source.path);
    return { value: decodeDocValue(type, value) };
  }

  private applyWrites(
    step: WorkflowStep,
    result: Record<string, unknown>,
    stepResults: Record<string, unknown>,
    input: Record<string, unknown>,
    plan: CompositionPlan,
    currentDocuments: Record<string, JsonValue>,
    writeSnapshots: ReadonlyMap<string, DocumentRecord | null>,
  ): void {
    if (!step.writes.length) return;
    const grouped = new Map<string, Record<string, unknown>>();
    for (const write of step.writes) {
      const definition = plan.documents.find((document) => document.id === write.document);
      if (!definition || definition.owner_instance !== null) throw new WorkflowExecutionError("document_write_denied", `Document ${write.document} is not composition-owned`);
      const currentData = grouped.get(write.document) ?? structuredClone(writeSnapshots.get(write.document)?.data ?? {});
      if (!isRecord(currentData)) throw new WorkflowExecutionError("document_shape_invalid", `Document ${write.document} is not an object`);
      const docData = currentData;
      const source = parseSource(write.from);
      const sourceValue = source.kind === "step"
        ? readPath(stepResults[source.id!], source.path)
        : this.resolveSource(source, input, stepResults, plan, currentDocuments).value;
      const targetType = wireField(definition.schema, write.path);
      writePath(docData, write.path, encodeDocValue(targetType, sourceValue));
      grouped.set(write.document, docData);
    }
    const committed: DocumentRecord[] = [];
    this.store.transaction(() => {
      for (const [document, value] of grouped) {
        committed.push(this.store.putDocument(document, value as JsonValue, writeSnapshots.get(document)?.revision ?? null));
      }
    });
    for (const saved of committed) currentDocuments[saved.document] = saved.data;
  }
}
