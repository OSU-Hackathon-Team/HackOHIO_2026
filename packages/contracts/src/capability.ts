// Downstream capability contracts. These are additive: frozen upstream FeatureSpec,
// NativeSubsystemSpec and Electron handoff schemas stay untouched.
import { z } from "zod";
import { WireObjectSchema, WireTypeSchema } from "./wire.js";

export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export type Hash = z.infer<typeof Hash>;

export const Semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
export type Semver = z.infer<typeof Semver>;

export const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);

export const RuntimeKind = z.enum(["ts_worker", "node_worker", "native_sidecar", "renderer_worker"]);
export type RuntimeKind = z.infer<typeof RuntimeKind>;

export const HostEffect = z.enum([
  "storage",
  "filesystem",
  "network",
  "audio_capture",
  "secrets",
  "native_process",
  "renderer_dom",
]);
export type HostEffect = z.infer<typeof HostEffect>;

export const ReviewStatus = z.enum(["approved", "ready_for_review", "draft", "absent"]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export const ReviewAttestation = z
  .object({
    status: ReviewStatus,
    reviewer: z.string().min(1).max(200),
    reviewed_at: z.string().datetime({ offset: true }),
    artifact_hash: Hash,
    notes: z.array(z.string()).default([]),
  })
  .strict();
export type ReviewAttestation = z.infer<typeof ReviewAttestation>;

export const CapabilityOrigin = z
  .object({
    kind: z.enum(["feature_spec", "native_subsystem_spec", "electron_contract", "authored"]),
    artifact_hash: Hash,
    artifact_ref: z.string().min(1),
    source_app: z.string().min(1),
    /** The upstream stage this artifact came from; never inferred from a status badge. */
    stage: z.enum(["requirements", "native_spec", "electron_reconstruction", "downstream_authored"]),
  })
  .strict();
export type CapabilityOrigin = z.infer<typeof CapabilityOrigin>;

/** Meaning is checked separately from structure: two `value:number` ports are not interchangeable. */
export const Meaning = z
  .object({
    units: z.string().max(80).nullable(),
    id_domain: z.string().max(120).nullable(),
    timezone: z.enum(["utc", "local"]).nullable(),
    ordering: z.enum(["ordered", "unordered", "sorted_by_time"]).nullable(),
    null_semantics: z.enum(["forbidden", "means_absent", "means_unknown"]).nullable(),
    cardinality: z.enum(["one", "zero_or_one", "many"]).nullable(),
    value_scale: z.string().max(120).nullable(),
  })
  .strict();
export type Meaning = z.infer<typeof Meaning>;

export const emptyMeaning: Meaning = {
  units: null,
  id_domain: null,
  timezone: null,
  ordering: null,
  null_semantics: null,
  cardinality: null,
  value_scale: null,
};

export const PortSpec = z
  .object({
    port: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/),
    schema: WireObjectSchema,
    meaning: Meaning,
  })
  .strict();
export type PortSpec = z.infer<typeof PortSpec>;

export const OperationSpec = z
  .object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/),
    summary: z.string().min(1).max(500),
    request: WireObjectSchema,
    result: WireObjectSchema,
    error: WireObjectSchema,
    idempotent: z.boolean(),
    cancellable: z.boolean(),
    timeout_ms: z.number().int().min(1).max(600_000),
    streaming: z
      .object({
        event: WireObjectSchema,
        ordering: z.literal("ordered"),
        max_events: z.number().int().min(1).max(1_000_000),
      })
      .strict()
      .nullable(),
    host_effects: z.array(HostEffect).max(8),
  })
  .strict()
  .superRefine((operation, ctx) => {
    const errorFields = operation.error.fields.map((field) => field.name);
    if (!errorFields.includes("code")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Operation ${operation.name} error schema needs a code field` });
    }
    if (!errorFields.includes("message")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Operation ${operation.name} error schema needs a message field` });
    }
  });
export type OperationSpec = z.infer<typeof OperationSpec>;

export const StateSpec = z
  .object({
    ownership: z.enum(["package", "composition"]),
    durable: z.boolean(),
    schema: WireObjectSchema.nullable(),
    migrations: z
      .array(
        z
          .object({ version: z.number().int().positive(), name: z.string().min(1).max(120), hash: Hash })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type StateSpec = z.infer<typeof StateSpec>;

export const LifecycleSpec = z
  .object({
    start_operation: z.string().nullable(),
    dispose_operation: z.string().nullable(),
    restart_policy: z.enum(["always", "on_crash", "never"]),
  })
  .strict();
export type LifecycleSpec = z.infer<typeof LifecycleSpec>;

export const HostEffectDeclaration = z
  .object({
    effect: HostEffect,
    scope: z.string().min(1).max(200),
    reason: z.string().min(1).max(300),
  })
  .strict();
export type HostEffectDeclaration = z.infer<typeof HostEffectDeclaration>;

export const PublicTestSpec = z
  .object({
    name: z.string().min(1).max(200),
    requirement_ids: z.array(z.string().min(1)).min(1),
    kind: z.literal("public"),
  })
  .strict();
export type PublicTestSpec = z.infer<typeof PublicTestSpec>;

export const CapabilityDefinition = z
  .object({
    schema_version: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_-]*)+$/),
    version: Semver,
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(2000),
    origin: CapabilityOrigin,
    selected_behavior: z.array(z.string().min(1)).min(1),
    exclusions: z.array(z.string()),
    operations: z.array(OperationSpec).min(1),
    provides: z.array(PortSpec),
    requires: z.array(PortSpec),
    state: StateSpec,
    lifecycle: LifecycleSpec,
    host_effects: z.array(HostEffectDeclaration),
    assumptions: z.array(z.string()),
    preferred_runtime: RuntimeKind,
    public_tests: z.array(PublicTestSpec).min(1),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const ids = new Set<string>();
    for (const operation of definition.operations) {
      if (ids.has(operation.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate operation ${operation.name}` });
      }
      ids.add(operation.name);
    }
    for (const port of [...definition.provides, ...definition.requires]) {
      if (port.schema.kind !== "object") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Port ${port.port} must be an object schema` });
      }
    }
    if (definition.state.ownership === "composition" && !definition.state.schema) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Composition-owned state needs a schema" });
    }
    const declaredEffects = new Set(definition.host_effects.map((effect) => effect.effect));
    for (const operation of definition.operations) {
      for (const effect of operation.host_effects) {
        if (!declaredEffects.has(effect)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Operation ${operation.name} uses undeclared host effect ${effect}`,
          });
        }
      }
    }
  });
export type CapabilityDefinition = z.infer<typeof CapabilityDefinition>;

export const ReadinessState = z.enum(["passed", "failed", "not_run", "unknown", "not_applicable"]);
export type ReadinessState = z.infer<typeof ReadinessState>;

export const ReadinessCheck = z
  .object({
    status: ReadinessState,
    detail: z.string().max(1000),
    at: z.string().datetime({ offset: true }).nullable(),
    evidence_hash: Hash.nullable(),
  })
  .strict();
export type ReadinessCheck = z.infer<typeof ReadinessCheck>;

export const Readiness = z
  .object({
    upstream_review: ReadinessCheck,
    implementation_checks: ReadinessCheck,
    independent_behavior_checks: ReadinessCheck,
    composition_checks: ReadinessCheck,
    packaging_checks: ReadinessCheck,
  })
  .strict();
export type Readiness = z.infer<typeof Readiness>;

export const emptyReadiness: Readiness = {
  upstream_review: { status: "unknown", detail: "Not reviewed", at: null, evidence_hash: null },
  implementation_checks: { status: "not_run", detail: "Not run", at: null, evidence_hash: null },
  independent_behavior_checks: { status: "not_run", detail: "Not run", at: null, evidence_hash: null },
  composition_checks: { status: "not_run", detail: "Not run", at: null, evidence_hash: null },
  packaging_checks: { status: "not_run", detail: "Not run", at: null, evidence_hash: null },
};

export const TestOutcome = z
  .object({
    name: z.string().min(1).max(200),
    kind: z.enum(["public", "held_out", "mutation", "boundary"]),
    passed: z.boolean(),
    requirement_ids: z.array(z.string()),
    duration_ms: z.number().nonnegative(),
    assertions: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(),
    detail: z.string().max(2000),
  })
  .strict();
export type TestOutcome = z.infer<typeof TestOutcome>;

export const VerificationReport = z
  .object({
    schema_version: z.literal(1),
    generated_at: z.string().datetime({ offset: true }),
    generator: z.string().min(1),
    tests: z.array(TestOutcome),
    mutation: z
      .object({
        total: z.number().int().nonnegative(),
        killed: z.number().int().nonnegative(),
        survivors: z.array(z.string()),
      })
      .strict(),
    purity_violations: z.array(z.string()),
    type_errors: z.array(z.string()),
    boundary_checks: z.array(
      z.object({ name: z.string(), passed: z.boolean(), detail: z.string().max(1000) }).strict(),
    ),
    blockers: z.array(z.string()),
    verdict: z.enum(["passed", "failed"]),
    report_hash: Hash,
  })
  .strict();
export type VerificationReport = z.infer<typeof VerificationReport>;

export const Artifact = z
  .object({
    path: z.string().min(1).max(400),
    sha256: Hash,
    size: z.number().int().nonnegative(),
    kind: z.enum(["source", "binary", "client", "manifest", "migration", "asset", "test"]),
  })
  .strict();
export type Artifact = z.infer<typeof Artifact>;

export const DependencyLockEntry = z
  .object({ name: z.string(), version: z.string(), integrity: z.string().nullable() })
  .strict();
export type DependencyLockEntry = z.infer<typeof DependencyLockEntry>;

export const PlatformSupport = z
  .object({ os: z.enum(["linux", "darwin", "win32"]), arch: z.enum(["x64", "arm64"]) })
  .strict();
export type PlatformSupport = z.infer<typeof PlatformSupport>;

export const CapabilityPackage = z
  .object({
    schema_version: z.literal(1),
    package_id: z.string().regex(/^pkg_[a-f0-9]{32}$/),
    definition: z.object({ id: z.string(), version: Semver, hash: Hash }).strict(),
    runtime_kind: RuntimeKind,
    entrypoints: z
      .array(
        z
          .object({
            kind: z.enum(["module", "sidecar_executable"]),
            path: z.string().min(1),
            protocol: z.enum(["splice-ts-module-v1", "splice-sidecar-v1"]),
          })
          .strict(),
      )
      .min(1),
    platforms: z.array(PlatformSupport).min(1),
    build: z
      .object({
        recipe: z.string().min(1),
        toolchain: z.object({ name: z.string(), version: z.string() }).strict(),
        source_hash: Hash,
        build_hash: Hash,
        reproducible: z.boolean(),
        log_hash: Hash,
        attempts: z.number().int().nonnegative(),
      })
      .strict(),
    artifacts: z.array(Artifact).min(1),
    dependency_lock: z.array(DependencyLockEntry),
    assets: z.array(Artifact),
    verification: VerificationReport,
    independent_verdict_ref: z.string().nullable(),
    readiness: Readiness,
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type CapabilityPackage = z.infer<typeof CapabilityPackage>;

export const IntakeBlocker = z
  .object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(1000),
    owner: z.enum(["upstream", "downstream"]),
    question: z.string().max(1000).nullable(),
  })
  .strict();
export type IntakeBlocker = z.infer<typeof IntakeBlocker>;

export const ImplementationFile = z
  .object({
    path: z.string().min(1).max(300),
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
  })
  .strict();
export type ImplementationFile = z.infer<typeof ImplementationFile>;

export const ImplementationSource = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("typescript"),
      entry: z.string().min(1),
      files: z.array(ImplementationFile).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("c"),
      entry: z.string().min(1),
      files: z.array(ImplementationFile).min(1),
      compiler: z.object({ name: z.literal("gcc"), flags: z.array(z.string()) }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("blueprint"),
      blueprint: z.unknown(),
    })
    .strict(),
]);
export type ImplementationSource = z.infer<typeof ImplementationSource>;

export const PublicTestCase = z
  .object({
    name: z.string().min(1).max(200),
    requirement_ids: z.array(z.string().min(1)).min(1),
    harness: z.enum(["ts", "c"]),
    code: z.string().min(1).max(200_000),
  })
  .strict();
export type PublicTestCase = z.infer<typeof PublicTestCase>;

export const IndependentVerdict = z
  .object({
    evaluator: z.string().min(1).max(200),
    verdict: z.enum(["pass", "fail"]),
    cases: z.number().int().nonnegative(),
    report_hash: Hash,
    at: z.string().datetime({ offset: true }),
  })
  .strict();
export type IndependentVerdict = z.infer<typeof IndependentVerdict>;

export const CapabilityIntakeRequest = z
  .object({
    definition: CapabilityDefinition,
    origin_artifact: z.unknown(),
    review_attestation: ReviewAttestation.nullable(),
    implementation: ImplementationSource,
    public_tests: z.array(PublicTestCase).min(1),
    independent_verdict: IndependentVerdict.nullable(),
  })
  .strict();
export type CapabilityIntakeRequest = z.infer<typeof CapabilityIntakeRequest>;

export const CapabilityIntakeRecord = z
  .object({
    intake_id: z.string().regex(/^int_[a-f0-9]{32}$/),
    accepted: z.boolean(),
    definition_hash: Hash,
    origin_artifact_hash: Hash,
    blockers: z.array(IntakeBlocker),
    readiness: Readiness,
    received_at: z.string().datetime({ offset: true }),
    definition: CapabilityDefinition,
    public_tests: z.array(PublicTestCase),
    implementation: ImplementationSource,
    review_attestation: ReviewAttestation.nullable(),
    independent_verdict: IndependentVerdict.nullable(),
  })
  .strict();
export type CapabilityIntakeRecord = z.infer<typeof CapabilityIntakeRecord>;

export const CapabilityBuildRequest = z
  .object({ intake_id: z.string().regex(/^int_[a-f0-9]{32}$/) })
  .strict();
export type CapabilityBuildRequest = z.infer<typeof CapabilityBuildRequest>;

export const CapabilityListResponse = z
  .object({
    packages: z.array(CapabilityPackage),
    intakes: z.array(
      z
        .object({
          intake_id: z.string(),
          accepted: z.boolean(),
          definition_id: z.string(),
          definition_hash: Hash,
          blockers: z.array(IntakeBlocker),
          received_at: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type CapabilityListResponse = z.infer<typeof CapabilityListResponse>;

export const PackageVerificationReference = z
  .object({
    package_id: z.string(),
    verification_hash: Hash,
    verdict: z.enum(["passed", "failed"]),
  })
  .strict();
