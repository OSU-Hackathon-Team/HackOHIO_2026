import {
  canonicalJson,
  type CapabilityDefinition,
  type CapabilityPackage,
  type CompositionPlan,
  type CompositionValidateResponse,
  type DataMapping,
  type HostEffect,
  type Meaning,
  type OperationSpec,
  type PlanError,
  type PortSpec,
  type Readiness,
  type WireObjectType,
  type WireType,
} from "@splice/contracts";
import type { CapabilityResolver } from "../capabilities/types.js";
import { capabilityGate } from "../verification/gates.js";
import { hashJson } from "../capabilities/identity.js";

interface LoadedInstance {
  pkg: CapabilityPackage;
  definition: CapabilityDefinition;
}

const ready = (status: Readiness[keyof Readiness]["status"], detail: string, evidenceHash: string | null = null) => ({
  status,
  detail,
  at: status === "passed" ? new Date().toISOString() : null,
  evidence_hash: evidenceHash,
});

function sameType(a: WireType, b: WireType): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function typeCompatible(source: WireType, target: WireType, mapping: DataMapping): boolean {
  if (mapping.transform === "identity") return sameType(source, target);
  if (mapping.transform === "string") return target.kind === "string" && ["string", "enum", "int", "float", "bool"].includes(source.kind);
  if (mapping.transform === "number") return ["int", "float"].includes(source.kind) && ["int", "float"].includes(target.kind);
  if (mapping.transform === "int64_decimal") return source.kind === "int" && source.bits === 64 && target.kind === "string";
  if (mapping.transform === "timestamp_ms_to_s" || mapping.transform === "timestamp_s_to_ms") return source.kind === "timestamp" && target.kind === "timestamp";
  if (mapping.transform === "unit_scale") return ["int", "float"].includes(source.kind) && ["int", "float"].includes(target.kind) && mapping.factor !== null;
  return mapping.transform === "json" && ["object", "array", "map"].includes(source.kind) && ["object", "array", "map"].includes(target.kind);
}

function fieldType(schema: WireObjectType, path: string): WireType | null {
  let current: WireType = schema;
  for (const part of path.split(".")) {
    if (current.kind !== "object") return null;
    const field: WireObjectType["fields"][number] | undefined = current.fields.find((entry) => entry.name === part);
    if (!field) return null;
    current = field.type;
  }
  return current;
}

function sourceFieldType(
  expression: string,
  workflowInput: WireObjectType,
  documents: Map<string, WireObjectType>,
  stepResults: Map<string, WireObjectType>,
  bindings: Map<string, WireObjectType> = new Map(),
): { type: WireType | null; kind: string } {
  const inputMatch = /^\$input\.(.+)$/.exec(expression);
  if (inputMatch) return { type: fieldType(workflowInput, inputMatch[1]), kind: "input" };
  const documentMatch = /^\$doc\.([a-z][a-z0-9_-]{0,63})\.(.+)$/.exec(expression);
  if (documentMatch) return { type: documents.has(documentMatch[1]) ? fieldType(documents.get(documentMatch[1])!, documentMatch[2]) : null, kind: "document" };
  const stepMatch = /^\$steps\.([a-z][a-z0-9_]{0,63})\.(.+)$/.exec(expression);
  if (stepMatch) return { type: stepResults.has(stepMatch[1]) ? fieldType(stepResults.get(stepMatch[1])!, stepMatch[2]) : null, kind: "step" };
  const bindingMatch = /^\$bindings\.([a-z][a-z0-9_-]{0,63})\.(.+)$/.exec(expression);
  if (bindingMatch) return { type: bindings.has(bindingMatch[1]) ? fieldType(bindings.get(bindingMatch[1])!, bindingMatch[2]) : null, kind: "binding" };
  return { type: null, kind: "unknown" };
}

function meaningProblems(from: Meaning, to: Meaning, hasBridge: boolean): string[] {
  const problems: string[] = [];
  for (const key of ["id_domain", "timezone", "ordering", "null_semantics", "cardinality", "value_scale"] as const) {
    if (to[key] !== null && from[key] !== to[key]) problems.push(`${key} differs (${from[key] ?? "unspecified"} → ${to[key]})`);
  }
  if (to.units !== null && from.units !== to.units && !hasBridge) problems.push(`units differ (${from.units ?? "unspecified"} → ${to.units}) without a declared unit bridge`);
  return problems;
}

function addError(errors: PlanError[], code: string, path: string, message: string, owner: PlanError["owner"] = "user", question: string | null = null): void {
  errors.push({ code, path, message, owner, question });
}

function isTransitiveDependency(stepId: string, targetId: string, steps: Map<string, CompositionPlan["workflows"][number]["steps"][number]>): boolean {
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const current = steps.get(id);
    if (!current) return false;
    return current.depends_on.some((dependency) => dependency === targetId || visit(dependency));
  };
  return visit(stepId);
}

function cycleNodes(steps: CompositionPlan["workflows"][number]["steps"]): string[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles = new Set<string>();
  const visit = (id: string, stack: string[]) => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      for (const node of stack.slice(start)) cycles.add(node);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const step = byId.get(id);
    if (step) for (const dependency of step.depends_on) visit(dependency, [...stack, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.id, []);
  return [...cycles];
}

function operationFor(instances: Map<string, LoadedInstance>, ref: { instance: string; port: string }): OperationSpec | null {
  return instances.get(ref.instance)?.definition.operations.find((operation) => operation.name === ref.port) ?? null;
}

export async function validateCompositionPlan(
  plan: CompositionPlan,
  registry: CapabilityResolver,
): Promise<CompositionValidateResponse> {
  const errors: PlanError[] = [];
  const warnings: string[] = [];
  const checkedBindings: CompositionValidateResponse["checked_bindings"] = [];
  const loaded = new Map<string, LoadedInstance>();
  const definitionsByPackage = new Map<string, CapabilityDefinition>();
  const instancesById = new Map(plan.instances.map((instance) => [instance.instance, instance]));

  for (const instance of plan.instances) {
    const pkg = await registry.getPackage(instance.package_id);
    if (!pkg) {
      addError(errors, "missing_package", `instances.${instance.instance}`, `Unknown package ${instance.package_id}`, "user", "Install or build this capability package before composing the application.");
      continue;
    }
    if (pkg.definition.hash !== instance.definition_hash) {
      addError(errors, "definition_hash_mismatch", `instances.${instance.instance}.definition_hash`, "Package definition hash does not match the plan pin", "user", "Refresh the package pin from the registry and validate the plan again.");
      continue;
    }
    const definition = await registry.getDefinition(instance.package_id);
    if (!definition) {
      addError(errors, "missing_definition", `instances.${instance.instance}`, "Package has no readable definition artifact", "downstream", "Rebuild the package with its hash-pinned definition artifact.");
      continue;
    }
    definitionsByPackage.set(instance.package_id, definition);
    loaded.set(instance.instance, { pkg, definition });
    if (instance.permissions.some((effect, index) => instance.permissions.indexOf(effect) !== index)) {
      addError(errors, "permission_duplicate", `instances.${instance.instance}.permissions`, "Instance requests a host effect more than once");
    }
    const gate = capabilityGate(pkg);
    for (const finding of gate.findings) addError(errors, finding.code, `instances.${instance.instance}`, finding.message, finding.owner, null);
    const grants = plan.permissions.filter((grant) => grant.instance === instance.instance);
    for (const declaration of definition.host_effects) {
      if (!instance.permissions.includes(declaration.effect)) {
        addError(errors, "effect_not_requested", `instances.${instance.instance}.permissions`, `Package requires ${declaration.effect}, but the instance did not request it`, "user", `Grant ${declaration.effect} only if the application should allow: ${declaration.reason}`);
      }
      if (!grants.some((grant) => grant.effect === declaration.effect && grant.scope === declaration.scope)) {
        addError(errors, "effect_not_granted", `permissions.${instance.instance}`, `Host effect ${declaration.effect} scope ${declaration.scope} has no user grant`, "user", `Grant or remove this declared effect: ${declaration.reason}`);
      }
    }
    for (const effect of instance.permissions) {
      if (!definition.host_effects.some((declaration) => declaration.effect === effect)) {
        addError(errors, "undeclared_permission", `instances.${instance.instance}.permissions`, `Instance requests undeclared effect ${effect}`, "user", "Remove the permission or update the capability contract and review it.");
      }
    }
  }

  for (const grant of plan.permissions) {
    if (!instancesById.has(grant.instance)) addError(errors, "unknown_permission_instance", "permissions", `Permission references unknown instance ${grant.instance}`);
    const declaration = loaded.get(grant.instance)?.definition.host_effects.find((entry) => entry.effect === grant.effect && entry.scope === grant.scope);
    if (!declaration) addError(errors, "permission_not_declared", `permissions.${grant.instance}`, `${grant.effect} scope ${grant.scope} is not declared by the package`);
  }

  const outgoingRequired = new Set<string>();
  const bindingTargets = new Map<string, WireObjectType>();
  for (const binding of plan.bindings) {
    const source = loaded.get(binding.from.instance)?.definition.provides.find((port) => port.port === binding.from.port);
    const target = loaded.get(binding.to.instance)?.definition.requires.find((port) => port.port === binding.to.port);
    const checkedFields: string[] = [];
    const notes: string[] = [];
    let bindingOk = true;
    if (!source) {
      addError(errors, "missing_provided_port", `bindings.${binding.id}.from`, `No provided port ${binding.from.instance}.${binding.from.port}`);
      bindingOk = false;
    }
    if (!target) {
      addError(errors, "missing_required_port", `bindings.${binding.id}.to`, `No required port ${binding.to.instance}.${binding.to.port}`);
      bindingOk = false;
    }
    const requiredKey = `${binding.to.instance}.${binding.to.port}`;
    if (outgoingRequired.has(requiredKey)) {
      addError(errors, "ambiguous_binding", `bindings.${binding.id}.to`, `Required port ${requiredKey} is already bound`);
      bindingOk = false;
    }
    outgoingRequired.add(requiredKey);
    if (source && target) {
      const providedOperation = loaded.get(binding.from.instance)?.definition.operations.find((operation) => operation.name === binding.from.port);
      if (!providedOperation || !sameType(providedOperation.result, source.schema)) {
        addError(errors, "binding_source_not_executable", "bindings." + binding.id + ".from", "Provided port must match an operation name and its result schema");
        bindingOk = false;
      }
      bindingTargets.set(binding.id, target.schema);
      const meaning = meaningProblems(source.meaning, target.meaning, binding.unit_bridge !== null);
      for (const problem of meaning) {
        addError(errors, "meaning_mismatch", `bindings.${binding.id}`, problem, "user", "Add a tested, explicit adapter or choose a semantically compatible port.");
        bindingOk = false;
      }
      if (binding.unit_bridge) {
        if (!binding.unit_bridge.tested || binding.unit_bridge.from !== source.meaning.units || binding.unit_bridge.to !== target.meaning.units) {
          addError(errors, "unit_bridge_invalid", `bindings.${binding.id}.unit_bridge`, "Unit bridge must be tested and name the exact source and target units");
          bindingOk = false;
        }
        notes.push("unit conversion is new composition logic and requires its own verification");
      }
      const targets = new Set<string>();
      for (const mapping of binding.mappings) {
        const fromPath = mapping.from.replace(/^\$from\./, "");
        const fromType = fieldType(source.schema, fromPath);
        const toType = fieldType(target.schema, mapping.to);
        if (!fromType || !toType) {
          addError(errors, "mapping_field_missing", `bindings.${binding.id}.mappings`, `Mapping ${mapping.from} → ${mapping.to} names a field absent from a port schema`);
          bindingOk = false;
          continue;
        }
        if (!typeCompatible(fromType, toType, mapping)) {
          addError(errors, "mapping_type_mismatch", `bindings.${binding.id}.mappings`, `Mapping ${mapping.from} → ${mapping.to} cannot convert ${fromType.kind} to ${toType.kind} using ${mapping.transform}`);
          bindingOk = false;
        }
        if (targets.has(mapping.to)) {
          addError(errors, "mapping_target_duplicate", `bindings.${binding.id}.mappings`, `Target field ${mapping.to} is mapped more than once`);
          bindingOk = false;
        }
        targets.add(mapping.to);
        checkedFields.push(`${fromPath} → ${mapping.to}`);
      }
      for (const field of target.schema.fields) {
        if (!field.optional && !targets.has(field.name)) {
          addError(errors, "mapping_target_missing", `bindings.${binding.id}.mappings`, `Required target field ${field.name} is not mapped`);
          bindingOk = false;
        }
      }
    }
    checkedBindings.push({ id: binding.id, ok: bindingOk, checked_fields: checkedFields, notes });
  }

  for (const instance of plan.instances) {
    const definition = loaded.get(instance.instance)?.definition;
    if (!definition) continue;
    for (const required of definition.requires) {
      if (!outgoingRequired.has(`${instance.instance}.${required.port}`)) {
        addError(errors, "required_port_unbound", `instances.${instance.instance}.requires.${required.port}`, `Required port ${required.port} is not bound`, "user", "Add a compatible capability instance and explicit binding.");
      }
    }
  }

  const documents = new Map(plan.documents.map((document) => [document.id, document]));
  for (const document of plan.documents) {
    if (document.owner_instance !== null && !instancesById.has(document.owner_instance)) {
      addError(errors, "document_owner_missing", `documents.${document.id}.owner_instance`, `Unknown owner instance ${document.owner_instance}`);
    }
  }
  for (const provider of plan.providers) {
    if (![...loaded.entries()].some(([instance, value]) => instance === provider.capability || value.definition.id === provider.capability)) {
      addError(errors, "provider_capability_missing", `providers.${provider.id}`, `Provider capability ${provider.capability} is not selected in the plan`);
    }
  }
  const workflowIds = new Set<string>();
  for (const workflow of plan.workflows) {
    if (workflowIds.has(workflow.id)) addError(errors, "duplicate_workflow", `workflows.${workflow.id}`, `Workflow ${workflow.id} is duplicated`);
    workflowIds.add(workflow.id);
    const steps = new Map(workflow.steps.map((step) => [step.id, step]));
    const stepResults = new Map<string, WireObjectType>();
    for (const step of workflow.steps) {
      const operation = operationFor(loaded, step.operation);
      if (operation) stepResults.set(step.id, operation.result);
    }
    for (const step of workflow.steps) {
      const operation = operationFor(loaded, step.operation);
      if (!operation) {
        addError(errors, "missing_operation", `workflows.${workflow.id}.steps.${step.id}`, `Unknown operation ${step.operation.instance}.${step.operation.port}`);
        continue;
      }
      if (step.retries > 0 && (!operation.idempotent || step.idempotency !== "key")) {
        addError(errors, "unsafe_retry", `workflows.${workflow.id}.steps.${step.id}.retries`, "Retries require an idempotent operation and an idempotency key");
      }
      if (step.idempotency === "key") {
        const keyField = operation.request.fields.find((field) => field.name === "idempotency_key");
        if (!keyField || keyField.type.kind !== "string") addError(errors, "idempotency_contract_missing", `workflows.${workflow.id}.steps.${step.id}.idempotency`, `Operation ${operation.name} must declare a string idempotency_key request field`);
      }
      for (const dependency of step.depends_on) if (!steps.has(dependency)) addError(errors, "unknown_dependency", `workflows.${workflow.id}.steps.${step.id}.depends_on`, `Unknown step ${dependency}`);
      const inputTargets = new Set<string>();
      for (const mapping of step.input) {
        const from = sourceFieldType(mapping.from, workflow.input, documents.size ? new Map([...documents].map(([id, value]) => [id, value.schema])) : new Map(), stepResults, bindingTargets);
        const to = fieldType(operation.request, mapping.to);
        if (from.kind === "step") {
          const ref = /^\$steps\.([a-z][a-z0-9_]{0,63})\./.exec(mapping.from)?.[1];
          if (ref && !steps.has(ref)) addError(errors, "mapping_step_unknown", `workflows.${workflow.id}.steps.${step.id}.input`, `Unknown source step ${ref}`);
          else if (ref && !isTransitiveDependency(step.id, ref, steps)) addError(errors, "mapping_step_order", `workflows.${workflow.id}.steps.${step.id}.input`, `Step ${step.id} reads ${ref} without depending on it`);
        }
        if (from.kind === "binding") {
          const bindingId = /^\$bindings\.([a-z][a-z0-9_-]{0,63})\./.exec(mapping.from)?.[1];
          const binding = plan.bindings.find((candidate) => candidate.id === bindingId);
          if (!binding) addError(errors, "mapping_binding_unknown", "workflows." + workflow.id + ".steps." + step.id + ".input", "Unknown binding " + bindingId);
          else {
            if (step.operation.instance !== binding.to.instance) addError(errors, "mapping_binding_target", "workflows." + workflow.id + ".steps." + step.id + ".input", "Binding " + binding.id + " is not targeted at " + step.operation.instance);
            const sourceStep = workflow.steps.find((candidate) => candidate.operation.instance === binding.from.instance && candidate.operation.port === binding.from.port);
            if (!sourceStep || !isTransitiveDependency(step.id, sourceStep.id, steps)) addError(errors, "mapping_binding_order", "workflows." + workflow.id + ".steps." + step.id + ".input", "Binding " + binding.id + " requires a preceding source step dependency");
          }
        }
        if (!from.type || !to) {
          addError(errors, "workflow_mapping_field_missing", `workflows.${workflow.id}.steps.${step.id}.input`, `Mapping ${mapping.from} → ${mapping.to} references a missing field`);
          continue;
        }
        if (!typeCompatible(from.type, to, mapping)) addError(errors, "workflow_mapping_type_mismatch", `workflows.${workflow.id}.steps.${step.id}.input`, `Mapping ${mapping.from} → ${mapping.to} cannot convert ${from.type.kind} to ${to.kind}`);
        if (inputTargets.has(mapping.to)) addError(errors, "workflow_mapping_duplicate", `workflows.${workflow.id}.steps.${step.id}.input`, `Request field ${mapping.to} is mapped more than once`);
        inputTargets.add(mapping.to);
      }
      for (const field of operation.request.fields) {
        if (!field.optional && !inputTargets.has(field.name)) addError(errors, "workflow_mapping_missing", `workflows.${workflow.id}.steps.${step.id}.input`, `Required request field ${field.name} is not mapped`);
      }
      if (step.stale_guard) {
        const document = documents.get(step.stale_guard.document);
        if (!document || !document.revisioned) addError(errors, "stale_guard_invalid", `workflows.${workflow.id}.steps.${step.id}.stale_guard`, "Stale guard requires a revisioned document");
      }
      for (const write of step.writes) {
        const document = documents.get(write.document);
        const target = document ? fieldType(document.schema, write.path) : null;
        if (!document) addError(errors, "write_document_missing", `workflows.${workflow.id}.steps.${step.id}.writes`, `Unknown document ${write.document}`);
        else if (document.owner_instance !== null) addError(errors, "write_not_composition_owned", `workflows.${workflow.id}.steps.${step.id}.writes`, `Document ${write.document} is owned by ${document.owner_instance}, not the composition`);
        if (document && !target) addError(errors, "write_path_missing", `workflows.${workflow.id}.steps.${step.id}.writes`, `Document ${write.document} has no field ${write.path}`);
        const from = sourceFieldType(write.from, workflow.input, new Map([...documents].map(([id, value]) => [id, value.schema])), stepResults);
        if (!from.type && write.from !== `$steps.${step.id}`) addError(errors, "write_source_missing", `workflows.${workflow.id}.steps.${step.id}.writes`, `Write source ${write.from} is not available`);
        if (from.type && target && !sameType(from.type, target)) addError(errors, "write_type_mismatch", `workflows.${workflow.id}.steps.${step.id}.writes`, `Write ${write.from} cannot populate ${write.document}.${write.path}`);
        if (from.kind === "step") {
          const ref = /^\$steps\.([a-z][a-z0-9_]{0,63})\./.exec(write.from)?.[1];
          if (ref && ref !== step.id && !isTransitiveDependency(step.id, ref, steps)) addError(errors, "write_step_order", `workflows.${workflow.id}.steps.${step.id}.writes`, `Step ${step.id} writes from ${ref} without depending on it`);
        }
      }
    }
    for (const stepId of cycleNodes(workflow.steps)) addError(errors, "workflow_cycle", `workflows.${workflow.id}.steps.${stepId}`, `Workflow contains a dependency cycle through ${stepId}`);
    for (const missing of workflow.output.fields) {
      if (!workflow.steps.some((step) => step.id === missing.name)) warnings.push(`Workflow ${workflow.id} output ${missing.name} has no direct step with that id`);
    }
  }

  for (const surface of plan.ui) {
    for (const binding of surface.bindings) {
      const source = sourceFieldType(binding.source, { kind: "object", fields: [], additional: false }, new Map([...documents].map(([id, value]) => [id, value.schema])), new Map());
      if (source.kind === "document" && !source.type) addError(errors, "ui_binding_missing", `ui.${surface.id}.bindings.${binding.name}`, `UI binding source ${binding.source} is missing`);
      if (binding.operation && !operationFor(loaded, binding.operation)) addError(errors, "ui_operation_missing", `ui.${surface.id}.bindings.${binding.name}`, `UI binding operation ${binding.operation.instance}.${binding.operation.port} is missing`);
    }
    for (const action of surface.actions) if (!workflowIds.has(action.workflow)) addError(errors, "ui_workflow_missing", `ui.${surface.id}.actions.${action.id}`, `Action references unknown workflow ${action.workflow}`);
  }

  for (const scenario of plan.acceptance_scenarios) {
    for (const [index, step] of scenario.steps.entries()) {
      const at = `acceptance_scenarios.${scenario.id}.steps.${index}`;
      if ((step.kind === "invoke" || step.kind === "assert_workflow" || step.kind === "cancel") && !workflowIds.has(step.workflow)) addError(errors, "scenario_workflow_missing", at, `Unknown workflow ${step.workflow}`);
      if ((step.kind === "set_document" || step.kind === "assert_document") && !documents.has(step.document)) addError(errors, "scenario_document_missing", at, `Unknown document ${step.document}`);
      if (step.kind === "deny_permission" && !instancesById.has(step.instance)) addError(errors, "scenario_instance_missing", at, `Unknown instance ${step.instance}`);
      if (step.kind === "replace_package" && !(await registry.getPackage(step.package_id))) addError(errors, "scenario_package_missing", at, `Replacement package ${step.package_id} is not installed`);
    }
  }

  const readiness: Readiness = {
    upstream_review: ready("passed", "Upstream readiness was checked for each pinned package", hashJson([...loaded.values()].map(({ pkg }) => pkg.readiness.upstream_review))),
    implementation_checks: ready(errors.some((entry) => entry.code.endsWith("not_passed") || entry.code.includes("test_failed")) ? "failed" : "passed", "Pinned package implementation checks were inspected", hashJson([...loaded.values()].map(({ pkg }) => pkg.verification.report_hash))),
    independent_behavior_checks: ready([...loaded.values()].every(({ pkg }) => ["passed", "not_applicable"].includes(pkg.readiness.independent_behavior_checks.status)) ? "passed" : "not_run", "Independent behavior readiness is retained per package", hashJson([...loaded.values()].map(({ pkg }) => pkg.readiness.independent_behavior_checks))),
    composition_checks: errors.length === 0 ? { status: "not_run", detail: "Structural plan checks passed; workflow scenarios have not executed", at: null, evidence_hash: hashJson(plan) } : { status: "failed", detail: `${errors.length} composition blockers`, at: new Date().toISOString(), evidence_hash: hashJson(errors) },
    packaging_checks: { status: "not_run", detail: "Application has not been compiled or exported", at: null, evidence_hash: null },
  };
  return {
    ok: errors.length === 0,
    plan_hash: hashJson(plan),
    errors,
    warnings,
    checked_bindings: checkedBindings,
    readiness,
  };
}

export function getOperation(
  instances: Map<string, LoadedInstance>,
  instance: string,
  operation: string,
): OperationSpec | null {
  return instances.get(instance)?.definition.operations.find((candidate) => candidate.name === operation) ?? null;
}

export function effectsOfPackage(definition: CapabilityDefinition): HostEffect[] {
  return [...new Set(definition.host_effects.map((entry) => entry.effect))];
}
