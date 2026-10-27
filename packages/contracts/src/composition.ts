// Executable composition plans, revisions and generated application artifacts.
import { z } from "zod";
import {
  Artifact,
  Hash,
  HostEffect,
  JsonValueSchema,
  Meaning,
  PlatformSupport,
  PortSpec,
  Readiness,
  VerificationReport,
} from "./capability.js";
import { WireObjectSchema } from "./wire.js";

export const InstanceId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const DocumentId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const WorkflowId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const PortRef = z
  .object({ instance: InstanceId, port: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/) })
  .strict();
export type PortRef = z.infer<typeof PortRef>;

export const MappingTransform = z.enum([
  "identity",
  "string",
  "number",
  "int64_decimal",
  "timestamp_ms_to_s",
  "timestamp_s_to_ms",
  "unit_scale",
  "json",
]);
export type MappingTransform = z.infer<typeof MappingTransform>;

export const DataMapping = z
  .object({
    /** `$input.x`, `$steps.<id>.x`, or `$doc.<document>.x`; dotted paths index objects. */
    from: z.string().min(1).max(300),
    to: z.string().min(1).max(120),
    transform: MappingTransform,
    factor: z.number().finite().nullable().default(null),
  })
  .strict();
export type DataMapping = z.infer<typeof DataMapping>;

export const PackageInstance = z
  .object({
    instance: InstanceId,
    package_id: z.string().regex(/^pkg_[a-f0-9]{32}$/),
    definition_hash: Hash,
    config: z.record(z.string(), JsonValueSchema).default({}),
    permissions: z.array(HostEffect).default([]),
  })
  .strict();
export type PackageInstance = z.infer<typeof PackageInstance>;

export const UnitBridge = z
  .object({
    from: z.string().min(1).max(80),
    to: z.string().min(1).max(80),
    factor: z.number().finite(),
    provenance: z.literal("new_composition_logic"),
    tested: z.boolean(),
  })
  .strict();

export const Binding = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    from: PortRef,
    to: PortRef,
    mappings: z.array(DataMapping).min(1),
    unit_bridge: UnitBridge.nullable().default(null),
    notes: z.array(z.string()).default([]),
  })
  .strict();
export type Binding = z.infer<typeof Binding>;

export const DocumentDef = z
  .object({
    id: DocumentId,
    kind: z.enum(["document", "workbook", "transcript", "audio_asset", "block_binding", "custom"]),
    schema: WireObjectSchema,
    /** null = composition owns the document and its revision. */
    owner_instance: InstanceId.nullable(),
    revisioned: z.boolean(),
    description: z.string().max(500),
    initial: JsonValueSchema.optional(),
  })
  .strict();
export type DocumentDef = z.infer<typeof DocumentDef>;

export const WorkflowStep = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    operation: PortRef,
    input: z.array(DataMapping).min(1),
    depends_on: z.array(z.string()).default([]),
    timeout_ms: z.number().int().min(1).max(600_000).default(30_000),
    retries: z.number().int().min(0).max(5).default(0),
    retry_on_codes: z.array(z.string()).default([]),
    idempotency: z.enum(["none", "key"]).default("none"),
    on_error: z.enum(["fail", "continue"]).default("fail"),
    cancellation: z.enum(["propagate", "isolated"]).default("propagate"),
    /** Reject a result whose document revision no longer matches the revision the step read. */
    stale_guard: z
      .object({ document: DocumentId, revision_path: z.string().default("revision") })
      .strict()
      .nullable()
      .default(null),
    /** Transactional projections of this step's output into composition-owned documents. */
    writes: z
      .array(
        z
          .object({
            document: DocumentId,
            path: z.string().min(1).max(200),
            from: z.string().min(1).max(300),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const Workflow = z
  .object({
    id: WorkflowId,
    name: z.string().min(1).max(160),
    trigger: z.enum(["user", "event"]),
    input: WireObjectSchema,
    output: WireObjectSchema,
    steps: z.array(WorkflowStep).min(1),
  })
  .strict()
  .superRefine((workflow, ctx) => {
    const ids = new Set<string>();
    for (const step of workflow.steps) {
      if (ids.has(step.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Workflow ${workflow.id} repeats step ${step.id}` });
      }
      ids.add(step.id);
    }
    for (const step of workflow.steps) {
      for (const dependency of step.depends_on) {
        if (!ids.has(dependency)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Step ${step.id} depends on unknown step ${dependency}` });
        }
        if (dependency === step.id) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Step ${step.id} depends on itself` });
        }
      }
    }
  });
export type Workflow = z.infer<typeof Workflow>;

export const UiBinding = z
  .object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/),
    source: z.string().min(1).max(300),
    operation: PortRef.nullable().default(null),
  })
  .strict();

export const UiAction = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    label: z.string().min(1).max(80),
    workflow: WorkflowId,
  })
  .strict();

export const UiSurface = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    kind: z.enum(["document", "table", "transcript", "form", "list"]),
    title: z.string().min(1).max(120),
    bindings: z.array(UiBinding).default([]),
    actions: z.array(UiAction).default([]),
  })
  .strict();
export type UiSurface = z.infer<typeof UiSurface>;

export const PermissionGrant = z
  .object({
    instance: InstanceId,
    effect: HostEffect,
    scope: z.string().min(1).max(200),
    reason: z.string().min(1).max(300),
  })
  .strict();

export const ProviderConfig = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    capability: z.string().min(1).max(120),
    transport: z.enum(["env", "user", "local_model"]),
    required: z.boolean(),
    config_schema: WireObjectSchema,
    replacement_for: z.string().nullable(),
    document_projection: z.object({ document: DocumentId, path: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/), id_prefix: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/) }).strict().optional(),
  })
  .strict();
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const ScenarioStep = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("invoke"),
      workflow: WorkflowId,
      input: JsonValueSchema,
      expect_status: z.enum(["succeeded", "failed"]).default("succeeded"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_document"),
      document: DocumentId,
      path: z.string().min(1).max(200),
      value: JsonValueSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("assert_document"),
      document: DocumentId,
      path: z.string().min(1).max(200),
      equals: JsonValueSchema,
    })
    .strict(),
  z.object({ kind: z.literal("restart") }).strict(),
  z
    .object({
      kind: z.literal("cancel"),
      workflow: WorkflowId,
      after_ms: z.number().int().min(0).max(60_000),
      expect_status: z.literal("cancelled"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("deny_permission"),
      instance: InstanceId,
      effect: HostEffect,
    })
    .strict(),
  z
    .object({
      kind: z.literal("provider_fault"),
      provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
      mode: z.enum(["disconnect", "duplicate_events", "stale"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("replace_package"),
      instance: InstanceId,
      package_id: z.string().regex(/^pkg_[a-f0-9]{32}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("assert_workflow"),
      workflow: WorkflowId,
      status: z.enum(["succeeded", "failed", "cancelled"]),
    })
    .strict(),
]);
export type ScenarioStep = z.infer<typeof ScenarioStep>;

export const AcceptanceScenario = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    name: z.string().min(1).max(200),
    steps: z.array(ScenarioStep).min(1),
  })
  .strict();

export const CompositionPlan = z
  .object({
    schema_version: z.literal(1),
    app: z
      .object({
        title: z.string().min(1).max(120),
        description: z.string().min(1).max(1000),
      })
      .strict(),
    instances: z.array(PackageInstance).min(1),
    bindings: z.array(Binding),
    documents: z.array(DocumentDef),
    workflows: z.array(Workflow).min(1),
    ui: z.array(UiSurface).min(1),
    permissions: z.array(PermissionGrant),
    providers: z.array(ProviderConfig),
    acceptance_scenarios: z.array(AcceptanceScenario).min(1),
    notes: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const instances = new Set<string>();
    for (const instance of plan.instances) {
      if (instances.has(instance.instance)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate instance ${instance.instance}` });
      }
      instances.add(instance.instance);
    }
    const documents = new Set(plan.documents.map((document) => document.id));
    for (const workflow of plan.workflows) {
      for (const step of workflow.steps) {
        if (!instances.has(step.operation.instance)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Workflow ${workflow.id} step ${step.id} targets unknown instance ${step.operation.instance}`,
          });
        }
        if (step.stale_guard && !documents.has(step.stale_guard.document)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Step ${step.id} stale guard references unknown document` });
        }
        for (const write of step.writes) {
          if (!documents.has(write.document)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Step ${step.id} writes to unknown document ${write.document}` });
          }
        }
      }
    }
    for (const binding of plan.bindings) {
      if (!instances.has(binding.from.instance) || !instances.has(binding.to.instance)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Binding ${binding.id} references an unknown instance` });
      }
      if (binding.from.instance === binding.to.instance && binding.from.port === binding.to.port) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Binding ${binding.id} connects a port to itself` });
      }
    }
    const workflowIds = new Set(plan.workflows.map((workflow) => workflow.id));
    for (const surface of plan.ui) {
      for (const action of surface.actions) {
        if (!workflowIds.has(action.workflow)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `UI action ${action.id} references unknown workflow ${action.workflow}` });
        }
      }
    }
  });
export type CompositionPlan = z.infer<typeof CompositionPlan>;

export const PlanError = z
  .object({
    code: z.string().min(1).max(80),
    path: z.string().min(1).max(300),
    message: z.string().min(1).max(1000),
    owner: z.enum(["upstream", "downstream", "user"]),
    question: z.string().max(1000).nullable(),
  })
  .strict();
export type PlanError = z.infer<typeof PlanError>;

export const CompositionValidateRequest = z.object({ plan: CompositionPlan }).strict();
export type CompositionValidateRequest = z.infer<typeof CompositionValidateRequest>;

export const CompositionValidateResponse = z
  .object({
    ok: z.boolean(),
    plan_hash: Hash,
    errors: z.array(PlanError),
    warnings: z.array(z.string()),
    checked_bindings: z.array(
      z
        .object({
          id: z.string(),
          ok: z.boolean(),
          checked_fields: z.array(z.string()),
          notes: z.array(z.string()),
        })
        .strict(),
    ),
    readiness: Readiness,
  })
  .strict();
export type CompositionValidateResponse = z.infer<typeof CompositionValidateResponse>;

export const ApplicationFile = z
  .object({
    path: z.string().min(1).max(400),
    content: z.string().nullable(),
    encoding: z.enum(["utf8", "base64"]),
    sha256: Hash,
  })
  .strict();
export type ApplicationFile = z.infer<typeof ApplicationFile>;

export const StorageMigration = z
  .object({
    version: z.number().int().positive(),
    name: z.string().min(1).max(120),
    sql: z.string().min(1),
    hash: Hash,
  })
  .strict();
export type StorageMigration = z.infer<typeof StorageMigration>;

export const PackageLockEntry = z
  .object({
    instance: InstanceId,
    package_id: z.string().regex(/^pkg_[a-f0-9]{32}$/),
    definition_hash: Hash,
    build_hash: Hash,
    artifact_hashes: z.array(z.object({ path: z.string(), sha256: Hash, kind: Artifact.shape.kind }).strict()),
    permissions: z.array(HostEffect),
  })
  .strict();

export const ApplicationBundle = z
  .object({
    schema_version: z.literal(1),
    app_id: z.string().regex(/^app_[a-f0-9]{32}$/),
    revision: z.number().int().nonnegative(),
    plan_hash: Hash,
    app_hash: Hash,
    title: z.string().min(1).max(120),
    description: z.string().max(2000),
    package_lock: z.array(PackageLockEntry).min(1),
    files: z.array(ApplicationFile).min(1),
    storage_migrations: z.array(StorageMigration).min(1),
    launch: z
      .object({
        command: z.string().min(1),
        env: z.array(
          z
            .object({
              name: z.string().min(1),
              required: z.boolean(),
              description: z.string().max(300),
            })
            .strict(),
        ),
        platforms: z.array(PlatformSupport).min(1),
      })
      .strict(),
    verification: z
      .object({
        composition: VerificationReport,
        application: VerificationReport,
        packaging: VerificationReport,
      })
      .strict(),
    previous_revision: z.number().int().nonnegative().nullable(),
    status: z.enum(["verified", "failed"]),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type ApplicationBundle = z.infer<typeof ApplicationBundle>;

export const ApplicationBuildRequest = z.object({ plan: CompositionPlan }).strict();
export type ApplicationBuildRequest = z.infer<typeof ApplicationBuildRequest>;

export const ApplicationRecord = z
  .object({
    app_id: z.string(),
    revision: z.number().int().nonnegative(),
    status: z.enum(["verified", "failed"]),
    app_hash: Hash,
    bundle: ApplicationBundle,
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type ApplicationRecord = z.infer<typeof ApplicationRecord>;

export const ApplicationListResponse = z
  .object({
    apps: z.array(
      z
        .object({
          app_id: z.string(),
          revision: z.number().int(),
          title: z.string(),
          status: z.enum(["verified", "failed"]),
          created_at: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type ApplicationListResponse = z.infer<typeof ApplicationListResponse>;

export const ApplicationRevisionListResponse = z.object({
  app_id: z.string().regex(/^app_[a-f0-9]{32}$/),
  active_revision: z.number().int().nonnegative().nullable(),
  revisions: z.array(z.object({
    revision: z.number().int().nonnegative(),
    status: z.enum(["verified", "failed"]),
    app_hash: Hash,
    created_at: z.string().datetime({ offset: true }),
  }).strict()),
}).strict();
export type ApplicationRevisionListResponse = z.infer<typeof ApplicationRevisionListResponse>;

export const ApplicationExportResponse = z
  .object({
    filename: z.string().min(1),
    manifest_hash: Hash,
    files: z.array(ApplicationFile),
    launch: ApplicationBundle.shape.launch,
    verification: ApplicationBundle.shape.verification,
  })
  .strict();
export type ApplicationExportResponse = z.infer<typeof ApplicationExportResponse>;

export const JobKind = z.enum(["capability_build", "composition_validate", "application_build", "export", "transcription"]);
export type JobKind = z.infer<typeof JobKind>;

export const JobStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobProgress = z
  .object({
    stage: z.string(),
    pct: z.number().min(0).max(100),
    message: z.string().max(1000),
    checkpoint: z.string().nullable(),
  })
  .strict();
export type JobProgress = z.infer<typeof JobProgress>;

export const JobRecord = z
  .object({
    job_id: z.string().regex(/^job_[a-f0-9]{32}$/),
    kind: JobKind,
    status: JobStatus,
    progress: JobProgress,
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
    result_ref: z.string().nullable(),
    error: z.string().nullable(),
    request_hash: Hash,
  })
  .strict();
export type JobRecord = z.infer<typeof JobRecord>;

export const JobEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), job_id: z.string(), ts: z.number(), stage: z.string(), pct: z.number(), message: z.string() }),
  z.object({ type: z.literal("log"), job_id: z.string(), ts: z.number(), message: z.string() }),
  z.object({ type: z.literal("result"), job_id: z.string(), ts: z.number(), result_ref: z.string() }),
  z.object({ type: z.literal("error"), job_id: z.string(), ts: z.number(), message: z.string(), fatal: z.boolean() }),
  z.object({ type: z.literal("done"), job_id: z.string(), ts: z.number(), ok: z.boolean() }),
  z.object({ type: z.literal("transcription_reset"), job_id: z.string(), ts: z.number(), attempt: z.number().int().positive() }),
  z.object({ type: z.literal("transcription_segment"), job_id: z.string(), ts: z.number(), attempt: z.number().int().positive(), index: z.number().int().nonnegative(), start_ms: z.number().int().nonnegative(), end_ms: z.number().int().nonnegative(), text: z.string().max(10_000), final: z.boolean() }),
]);
export type JobEvent = z.infer<typeof JobEvent>;

export const PreviewRequest = z
  .object({
    workflow: WorkflowId,
    input: JsonValueSchema,
    document_edits: z
      .array(z.object({ document: DocumentId, path: z.string(), value: JsonValueSchema }).strict())
      .default([]),
  })
  .strict();
export type PreviewRequest = z.infer<typeof PreviewRequest>;

export const PreviewResponse = z
  .object({
    ok: z.boolean(),
    status: z.enum(["succeeded", "failed", "cancelled"]),
    documents: z.record(z.string(), JsonValueSchema),
    step_results: z.record(z.string(), JsonValueSchema),
    unsupported: z.array(z.string()),
    error: z.string().nullable(),
  })
  .strict();
export type PreviewResponse = z.infer<typeof PreviewResponse>;

/** Opt-in external provider stream. Audio is an uploaded, hash-addressed workspace blob. */
export const TranscriptionAvailabilityResponse = z.object({
  configured: z.boolean(),
  provider: z.literal("aws_transcribe_streaming").nullable(),
  detail: z.string(),
}).strict();
export type TranscriptionAvailabilityResponse = z.infer<typeof TranscriptionAvailabilityResponse>;

export const TranscriptionEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), provider: z.literal("aws_transcribe_streaming"), audio: z.object({ id: Hash, size: z.number().int().positive() }).strict(), sample_rate_hz: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("segment"), index: z.number().int().nonnegative(), start_ms: z.number().int().nonnegative(), end_ms: z.number().int().nonnegative(), text: z.string(), final: z.boolean() }).strict(),
  z.object({ type: z.literal("done"), final_segments: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string(), retryable: z.boolean() }).strict(),
]);
export type TranscriptionEvent = z.infer<typeof TranscriptionEvent>;

/** Durable status of one external transcription request, including its latest ordered segments. */
export const TranscriptionSegment = z.object({
  index: z.number().int().nonnegative(),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  text: z.string().max(10_000),
  final: z.boolean(),
}).strict();
export type TranscriptionSegment = z.infer<typeof TranscriptionSegment>;

export const TranscriptionSession = z.object({
  session_id: z.string().regex(/^tr_[a-f0-9]{32}$/),
  job_id: z.string().regex(/^job_[a-f0-9]{32}$/).nullable(),
  provider: z.literal("aws_transcribe_streaming"),
  audio: z.object({ id: Hash, size: z.number().int().positive() }).strict(),
  sample_rate_hz: z.number().int().min(8_000).max(48_000),
  language: z.string().nullable(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  attempt: z.number().int().nonnegative(),
  segments: z.array(TranscriptionSegment).max(5_000),
  projection: z.object({ app_id: z.string(), provider_id: z.string(), document: DocumentId, path: z.string(), id_prefix: z.string(), revision: z.number().int().positive() }).strict().nullable(),
  error: z.string().nullable(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
}).strict();
export type TranscriptionSession = z.infer<typeof TranscriptionSession>;

export const TranscriptionStartResponse = z.object({ session: TranscriptionSession, job: JobRecord }).strict();
export type TranscriptionStartResponse = z.infer<typeof TranscriptionStartResponse>;

export const CompositionRequest = z.object({ plan: CompositionPlan }).strict();
