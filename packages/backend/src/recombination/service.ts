import type {
  ApplicationExportResponse,
  ApplicationListResponse,
  ApplicationRecord,
  ApplicationRevisionListResponse,
  CapabilityIntakeRecord,
  CapabilityIntakeRequest,
  CapabilityListResponse,
  CapabilityPackage,
  CompositionPlan,
  CompositionValidateResponse,
  JobRecord,
  PreviewRequest,
  PreviewResponse,
  TranscriptionAvailabilityResponse,
  TranscriptionEvent,
  TranscriptionSession,
  VerificationReport,
  JsonValue,
  CapabilityDefinition,
  DocumentMigration,
} from "@splice/contracts";
import { ApplicationBundle, CompositionPlan as CompositionPlanSchema, canonicalJson, encodeWireValue } from "@splice/contracts";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createCapabilityClient, FsBlobStore, type CapabilityClient, type ProviderAdapter } from "@splice/runtime";
import type { JobContext } from "./jobs.js";
import { assessCapabilityIntake } from "../capabilities/intake.js";
import { FilesystemCapabilityRegistry } from "../capabilities/registry.js";
import { buildTypeScriptPackage } from "../capabilities/tsBuilder.js";
import { buildNativePackage } from "../capabilities/nativeBuilder.js";
import { buildInputManifest, hashJson, sha256Hex } from "../capabilities/identity.js";
import { validateCompositionPlan } from "../composition/plan.js";
import { ApplicationStore, NamespacedStateStore, nextApplicationRevision } from "../composition/appStore.js";
import { compileApplication } from "../composition/compiler.js";
import { readPath, writePath } from "../composition/bindings.js";
import { WorkflowEngine, type WorkflowCapabilityClient } from "../composition/workflows.js";
import { projectTranscript } from "../composition/transcriptProjection.js";
import { applyDocumentMigration, documentTransition, initializeDocuments } from "../composition/documentMigrations.js";
import { openStateStore, type SqliteStateStore } from "../state/store.js";
import { MIGRATIONS } from "../state/migrations.js";
import { applicationGate, exportGate } from "../verification/gates.js";
import { getAuthoredNotebookIntakes, notebookPlan } from "../example/notebook.js";
import { getAuthoredBudgetReportIntake } from "../example/budget.js";
import { AwsTranscribeProvider } from "../example/awsTranscribe.js";
import { TranscriptionStore } from "../state/transcriptions.js";

/**
 * Service seam used by the HTTP routes. It is implemented in service.ts with the real registry,
 * builders and compiler; routes stay small and injectable for tests.
 */
export interface RecombinationService {
  listCapabilities(): Promise<CapabilityListResponse>;
  intake(request: CapabilityIntakeRequest): Promise<CapabilityIntakeRecord>;
  getPackage(packageId: string): Promise<CapabilityPackage | null>;
  seedAuthored(): Promise<CapabilityListResponse>;
  validatePlan(plan: CompositionPlan): Promise<CompositionValidateResponse>;
  buildCapability(intakeId: string, job: JobContext): Promise<{ package_id: string }>;
  buildApp(plan: CompositionPlan, job: JobContext): Promise<{ app_id: string; revision: number }>;
  listApps(): Promise<ApplicationListResponse>;
  getApp(appId: string, revision: number | "latest"): Promise<ApplicationRecord | null>;
  listAppRevisions(appId: string): Promise<ApplicationRevisionListResponse | null>;
  activateRevision(appId: string, revision: number): Promise<ApplicationRecord>;
  exportApp(appId: string): Promise<ApplicationExportResponse>;
  previewApp(appId: string, request: PreviewRequest): Promise<PreviewResponse>;
  notebookPlan(): Promise<unknown>;
  transcriptionAvailability(): Promise<TranscriptionAvailabilityResponse>;
  transcribePcm(input: { pcm: Uint8Array; sampleRateHz: number; language: string | null }, signal?: AbortSignal): AsyncIterable<TranscriptionEvent>;
  prepareTranscription(input: { pcm: Uint8Array; sampleRateHz: number; language: string | null; appId?: string; providerId?: string }): Promise<TranscriptionSession>;
  runTranscription(sessionId: string, job: JobContext): Promise<{ session_id: string }>;
  getTranscriptionSession(sessionId: string): Promise<TranscriptionSession | null>;
  reconcileTranscriptionSession(sessionId: string, status: "failed" | "cancelled", message: string): Promise<TranscriptionSession>;
}

function error(status: number, message: string, errors?: unknown): Error {
  return Object.assign(new Error(message), { status, errors });
}

function report(name: string, outcomes: VerificationReport["tests"], blockers: string[] = []): VerificationReport {
  const value: VerificationReport = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    generator: name,
    tests: outcomes,
    mutation: { total: 0, killed: 0, survivors: [] },
    purity_violations: [],
    type_errors: [],
    boundary_checks: [],
    blockers,
    verdict: blockers.length === 0 && outcomes.length > 0 && outcomes.every((outcome) => outcome.passed) ? "passed" : "failed",
    report_hash: "",
  };
  value.report_hash = hashJson(value);
  return value;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

export class FilesystemRecombinationService implements RecombinationService {
  readonly registry: FilesystemCapabilityRegistry;
  readonly state: SqliteStateStore;
  private readonly apps: ApplicationStore;
  private readonly transcriptions: TranscriptionStore;

  constructor(readonly stateDir: string, private readonly options: { transcriptionProvider?: (blobs: FsBlobStore) => ProviderAdapter } = {}) {
    this.registry = new FilesystemCapabilityRegistry(path.join(stateDir, "capabilities"));
    this.state = openStateStore(stateDir);
    this.apps = new ApplicationStore(this.state);
    this.transcriptions = new TranscriptionStore(this.state);
  }

  close(): void { this.state.close(); }

  async listCapabilities(): Promise<CapabilityListResponse> {
    const [packages, records] = await Promise.all([this.registry.listPackages(), this.registry.listIntakes()]);
    return {
      packages,
      intakes: records.map((record) => ({
        intake_id: record.intake_id,
        accepted: record.accepted,
        definition_id: record.definition.id,
        definition_hash: record.definition_hash,
        blockers: record.blockers,
        received_at: record.received_at,
      })),
    };
  }

  async intake(request: CapabilityIntakeRequest): Promise<CapabilityIntakeRecord> {
    const assessed = assessCapabilityIntake(request);
    const existing = await this.registry.getIntake(assessed.record.intake_id);
    if (existing) return existing;
    await this.registry.putOriginArtifact(assessed.record.origin_artifact_hash, assessed.originArtifact);
    await this.registry.putIntake(assessed.record);
    return assessed.record;
  }

  getPackage(packageId: string): Promise<CapabilityPackage | null> { return this.registry.getPackage(packageId); }

  async seedAuthored(): Promise<CapabilityListResponse> {
    for (const item of [...getAuthoredNotebookIntakes(), getAuthoredBudgetReportIntake()]) {
      const record = await this.intake(item.request);
      if (!record.accepted) throw error(422, `Authored fixture ${item.definition.id} was rejected`, record.blockers);
      await this.buildCapability(record.intake_id, { signal: new AbortController().signal, stage() {}, log() {}, transcriptionReset() {}, transcriptionSegment() {} });
    }
    return this.listCapabilities();
  }

  validatePlan(plan: CompositionPlan): Promise<CompositionValidateResponse> {
    return validateCompositionPlan(plan, this.registry);
  }

  private async matchingPackage(intake: CapabilityIntakeRecord): Promise<CapabilityPackage | null> {
    if (intake.implementation.kind === "blueprint") return null;
    const candidates = (await this.registry.listPackages()).filter((pkg) => pkg.definition.hash === intake.definition_hash);
    const expectedBuildInput = sha256Hex(canonicalJson(buildInputManifest(intake)));
    for (const pkg of candidates) {
      let matches = pkg.artifacts.some((artifact) => artifact.path === "build-input.json" && artifact.sha256 === expectedBuildInput);
      for (const file of intake.implementation.files) {
        const artifactPath = `src/${file.path}`;
        const bytes = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
        const artifact = pkg.artifacts.find((item) => item.path === artifactPath);
        if (!artifact || artifact.sha256 !== sha256Hex(bytes)) { matches = false; break; }
      }
      if (matches) return pkg;
    }
    return null;
  }

  async buildCapability(intakeId: string, job: JobContext): Promise<{ package_id: string }> {
    const intake = await this.registry.getIntake(intakeId);
    if (!intake) throw error(404, `Unknown capability intake ${intakeId}`);
    if (!intake.accepted) throw error(422, `Capability intake ${intakeId} has blockers`, intake.blockers);
    const existing = await this.matchingPackage(intake);
    if (existing) return { package_id: existing.package_id };
    if (intake.implementation.kind === "blueprint") throw error(422, "Blueprint implementation needs an explicit downstream source adapter");
    job.stage("build", `Building ${intake.definition.id}`, 5);
    const input = {
      intake_id: intake.intake_id,
      definition: intake.definition,
      hash_definition: intake.definition_hash,
      implementation: intake.implementation,
      public_tests: intake.public_tests,
      intake_readiness: intake.readiness,
      independent_verdict: intake.independent_verdict,
    };
    const built = intake.implementation.kind === "typescript"
      ? await buildTypeScriptPackage(input, { signal: job.signal, onStage: (stage, message, pct) => job.stage(stage, message, pct), onLog: (message) => job.log(message) })
      : await buildNativePackage(input, { signal: job.signal, onStage: (stage, message, pct) => job.stage(stage, message, pct), onLog: (message) => job.log(message) });
    job.stage("registry", "Verifying and storing package artifacts", 95);
    await this.registry.putPackage(built.package, built.files);
    return { package_id: built.package.package_id };
  }

  async notebookPlan(): Promise<CompositionPlan> {
    const packages = await this.registry.listPackages();
    const byDefinition = new Map(packages.map((pkg) => [pkg.definition.id, pkg.package_id]));
    return CompositionPlanSchema.parse(notebookPlan(byDefinition));
  }

  async transcriptionAvailability(): Promise<TranscriptionAvailabilityResponse> {
    const providerSelected = process.env.SPLICE_TRANSCRIPTION_PROVIDER === "aws";
    const tokenReady = (process.env.SPLICE_TRANSCRIPTION_ACCESS_TOKEN?.length ?? 0) >= 32;
    const configured = providerSelected && tokenReady;
    return {
      configured,
      provider: configured ? "aws_transcribe_streaming" : null,
      detail: configured ? "AWS Transcribe Streaming is configured as an external provider" : providerSelected ? "Set a 32-character or longer SPLICE_TRANSCRIPTION_ACCESS_TOKEN to protect the external provider" : "Set SPLICE_TRANSCRIPTION_PROVIDER=aws to enable external speech recognition",
    };
  }

  async *transcribePcm(input: { pcm: Uint8Array; sampleRateHz: number; language: string | null }, signal?: AbortSignal): AsyncIterable<TranscriptionEvent> {
    if (!(await this.transcriptionAvailability()).configured) throw error(503, "Live transcription provider is not configured");
    const blobs = new FsBlobStore(path.join(this.stateDir, "audio"), { maxBytes: 10 * 1024 * 1024 });
    const audio = await blobs.put(input.pcm, { contentType: "audio/L16" });
    const provider = new AwsTranscribeProvider({ blobs, region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION });
    yield { type: "started", provider: "aws_transcribe_streaming", audio, sample_rate_hz: input.sampleRateHz };
    const final = new Set<number>();
    for await (const segment of provider.transcribe({ audio, language: input.language, format: "pcm_s16le", sampleRateHz: input.sampleRateHz, channels: 1 }, { signal })) {
      if (segment.final) final.add(segment.index);
      yield { type: "segment", index: segment.index, start_ms: segment.startMs, end_ms: segment.endMs, text: segment.text, final: segment.final };
    }
    yield { type: "done", final_segments: final.size };
  }

  async prepareTranscription(input: { pcm: Uint8Array; sampleRateHz: number; language: string | null; appId?: string; providerId?: string }): Promise<TranscriptionSession> {
    if (!(await this.transcriptionAvailability()).configured) throw error(503, "Live transcription provider is not configured");
    if (Boolean(input.appId) !== Boolean(input.providerId)) throw error(400, "Application and provider must be supplied together");
    const blobs = new FsBlobStore(path.join(this.stateDir, "audio"), { maxBytes: 10 * 1024 * 1024 });
    const audio = await blobs.put(input.pcm, { contentType: "audio/L16" });
    return this.state.transaction(() => {
      let projection: TranscriptionSession["projection"] = null;
      if (input.appId && input.providerId) {
        const record = this.apps.get(input.appId, "latest");
        if (!record || record.status !== "verified") throw error(404, `No verified application ${input.appId}`);
        const plan = this.storedPlan(record);
        const provider = plan.providers.find((item) => item.id === input.providerId);
        if (!provider?.document_projection) throw error(400, `Provider ${input.providerId} has no document projection`);
        const document = plan.documents.find((item) => item.id === provider.document_projection!.document);
        if (!document || document.owner_instance !== null || !document.revisioned || document.initial === undefined) throw error(409, "Provider projection document is unavailable");
        projection = { app_id: input.appId, provider_id: input.providerId, ...provider.document_projection, revision: 1 };
        const state = new NamespacedStateStore(this.state, projection.app_id);
        const current = state.getDocument(projection.document)
          ?? state.putDocument(projection.document, encodeWireValue(document.schema, document.initial), null);
        projection.revision = current.revision;
      }
      return this.transcriptions.create({ audio, sample_rate_hz: input.sampleRateHz, language: input.language, projection });
    });
  }

  async getTranscriptionSession(sessionId: string): Promise<TranscriptionSession | null> {
    return this.transcriptions.get(sessionId);
  }

  async reconcileTranscriptionSession(sessionId: string, status: "failed" | "cancelled", message: string): Promise<TranscriptionSession> {
    return this.transcriptions.reconcileTerminal(sessionId, status, message);
  }

  async runTranscription(sessionId: string, job: JobContext): Promise<{ session_id: string }> {
    if (!job.job_id) throw new Error("Transcription requires a durable job id");
    let started: ReturnType<TranscriptionStore["beginAttempt"]>;
    try {
      started = this.state.transaction(() => {
        const value = this.transcriptions.beginAttempt(sessionId, job.job_id!);
        if (value.session.status !== "succeeded" && value.session.projection) this.projectTranscription(value.session, []);
        return value;
      });
    } catch (cause) {
      this.transcriptions.reconcileTerminal(sessionId, "failed", cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
    if (started.session.status === "succeeded") return { session_id: sessionId };
    const attempt = started.session.attempt;
    job.transcriptionReset(attempt);
    job.stage("transcribing", started.replay ? "Restarting transcription from saved audio" : "Transcribing saved audio", 5);
    try {
      if (!(await this.transcriptionAvailability()).configured) throw error(503, "Live transcription provider is not configured");
      if (job.signal.aborted) throw new Error("Transcription cancelled");
      const blobs = new FsBlobStore(path.join(this.stateDir, "audio"), { maxBytes: 10 * 1024 * 1024 });
      const provider = this.options.transcriptionProvider?.(blobs) ?? new AwsTranscribeProvider({ blobs, region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION });
      const session = started.session;
      for await (const raw of provider.transcribe({ audio: session.audio, language: session.language, format: "pcm_s16le", sampleRateHz: session.sample_rate_hz, channels: 1 }, { signal: job.signal })) {
        const segment = { index: raw.index, start_ms: raw.startMs, end_ms: raw.endMs, text: raw.text, final: raw.final };
        this.state.transaction(() => {
          const previous = this.transcriptions.get(sessionId);
          const updated = this.transcriptions.putSegment(sessionId, attempt, segment);
          if (updated.projection && canonicalJson(previous?.segments ?? []) !== canonicalJson(updated.segments)) {
            this.projectTranscription(updated, updated.segments);
          }
        });
        job.transcriptionSegment(attempt, segment);
      }
      if (job.signal.aborted) throw new Error("Transcription cancelled");
      this.transcriptions.succeed(sessionId, attempt);
      return { session_id: sessionId };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.transcriptions.fail(sessionId, attempt, job.signal.aborted ? "cancelled" : "failed", message);
      throw cause;
    }
  }

  private projectTranscription(session: TranscriptionSession, segments: TranscriptionSession["segments"]): void {
    const projection = session.projection;
    if (!projection) return;
    const app = this.apps.get(projection.app_id, "latest");
    if (!app || app.status !== "verified") throw error(409, `Application ${projection.app_id} is unavailable during transcription`);
    projectTranscript(new NamespacedStateStore(this.state, projection.app_id), this.transcriptions, this.storedPlan(app), session, segments);
  }

  private async clients(plan: CompositionPlan): Promise<{ definitions: Map<string, CapabilityDefinition>; clients: Map<string, CapabilityClient>; dispose(): Promise<void> }> {
    const definitions = new Map<string, CapabilityDefinition>();
    const clients = new Map<string, CapabilityClient>();
    try {
      for (const instance of plan.instances) {
        const pkg = await this.registry.getPackage(instance.package_id);
        const definition = await this.registry.getDefinition(instance.package_id);
        if (!pkg || !definition) throw new Error(`Package ${instance.package_id} is unavailable`);
        definitions.set(instance.instance, definition);
        clients.set(instance.instance, await createCapabilityClient(pkg, {
          definition,
          artifactRoot: this.registry.artifactRoot(pkg),
          grantedEffects: instance.permissions,
        }));
      }
      return { definitions, clients, dispose: async () => { await Promise.allSettled([...clients.values()].map((client) => client.dispose())); } };
    } catch (cause) {
      await Promise.allSettled([...clients.values()].map((client) => client.dispose()));
      throw cause;
    }
  }

  private async runScenarios(plan: CompositionPlan, signal?: AbortSignal): Promise<VerificationReport> {
    const outcomes: VerificationReport["tests"] = [];
    const runtime = await this.clients(plan);
    try {
      for (const scenario of plan.acceptance_scenarios) {
        if (signal?.aborted) throw new Error("Application build was cancelled");
        const scenarioDir = fs.mkdtempSync(path.join(os.tmpdir(), "splice-composition-scenario-"));
        let state = openStateStore(scenarioDir);
        let calls = 0;
        let assertions = 0;
        let passed = true;
        let detail = "Acceptance scenario passed";
        const counted = new Map<string, WorkflowCapabilityClient>([...runtime.clients].map(([id, client]) => [id, {
          call: async (operation, request, options) => { calls += 1; return client.call(operation, request, options); },
        }]));
        let engine = new WorkflowEngine(state, runtime.definitions, counted);
        const started = Date.now();
        try {
          for (const step of scenario.steps) {
            if (step.kind === "invoke") {
              const outcome = await engine.run(plan, step.workflow, asObject(step.input, `scenario ${scenario.id} input`), { signal });
              assertions += 1;
              if (outcome.status !== step.expect_status) throw new Error(`Workflow ${step.workflow} ended ${outcome.status}; expected ${step.expect_status}: ${canonicalJson(outcome.errors)}`);
            } else if (step.kind === "set_document") {
              const current = state.getDocument(step.document);
              const value = current?.data && typeof current.data === "object" && !Array.isArray(current.data) ? structuredClone(current.data) as Record<string, unknown> : {};
              writePath(value, step.path, step.value);
              state.putDocument(step.document, value as JsonValue, current?.revision ?? null);
            } else if (step.kind === "assert_document") {
              const current = state.getDocument(step.document);
              if (!current) throw new Error(`Document ${step.document} does not exist`);
              const actual = readPath(current.data, step.path);
              assertions += 1;
              if (canonicalJson(actual) !== canonicalJson(step.equals)) throw new Error(`Document ${step.document}.${step.path} was ${canonicalJson(actual)}; expected ${canonicalJson(step.equals)}`);
            } else if (step.kind === "restart") {
              state.close();
              state = openStateStore(scenarioDir);
              engine = new WorkflowEngine(state, runtime.definitions, counted);
              assertions += 1;
            } else {
              throw new Error(`Scenario step ${step.kind} has no executable verifier yet`);
            }
          }
          if (calls === 0 || assertions === 0) throw new Error("Scenario had no operation calls or assertions");
        } catch (cause) {
          passed = false;
          detail = cause instanceof Error ? cause.message : String(cause);
        } finally {
          state.close();
          fs.rmSync(scenarioDir, { recursive: true, force: true });
        }
        outcomes.push({ name: scenario.name, kind: "public", passed, requirement_ids: [scenario.id], duration_ms: Date.now() - started, assertions, calls, detail });
      }
      // A structural mutation must be visible to validation. Removing an operation is an application failure.
      const mutant = structuredClone(plan);
      mutant.workflows[0].steps[0].operation.port = "removed_operation";
      const detected = !(await this.validatePlan(mutant)).ok;
      outcomes.push({ name: "removed operation is rejected", kind: "mutation", passed: detected, requirement_ids: [], duration_ms: 0, assertions: 1, calls: 0, detail: detected ? "Plan validation rejected a missing operation" : "Plan validation accepted a missing operation" });
      return report("splice.composition.scenarios@1", outcomes);
    } finally {
      await runtime.dispose();
    }
  }

  private storedPlan(record: ApplicationRecord): CompositionPlan {
    const file = record.bundle.files.find((item) => item.path === "splice.plan.json");
    if (!file?.content) throw error(500, `Application ${record.app_id}@${record.revision} has no plan artifact`);
    try {
      const plan = CompositionPlanSchema.parse((JSON.parse(file.content) as { plan?: unknown }).plan);
      if (hashJson(plan) !== record.bundle.plan_hash) throw new Error("plan hash mismatch");
      return plan;
    } catch {
      throw error(500, `Application ${record.app_id}@${record.revision} has an invalid plan artifact`);
    }
  }

  private async assertCompatibleState(current: ApplicationRecord, targetPlan: CompositionPlan, allowRetiredDocuments = false): Promise<DocumentMigration | null> {
    const currentPlan = this.storedPlan(current);
    let migration: DocumentMigration | null;
    try { migration = documentTransition(currentPlan, targetPlan, allowRetiredDocuments); }
    catch (cause) { throw error(409, cause instanceof Error ? cause.message : String(cause)); }
    const oldInstances = new Map(currentPlan.instances.map((instance) => [instance.instance, instance.package_id]));
    const newInstances = new Map(targetPlan.instances.map((instance) => [instance.instance, instance.package_id]));
    for (const instance of new Set([...oldInstances.keys(), ...newInstances.keys()])) {
      const oldPackage = oldInstances.get(instance);
      const newPackage = newInstances.get(instance);
      if (oldPackage === newPackage) continue;
      for (const packageId of [oldPackage, newPackage]) {
        if (!packageId) continue;
        const definition = await this.registry.getDefinition(packageId);
        if (!definition) throw error(409, `Cannot check state compatibility for missing package ${packageId}`);
        if (definition.state.durable) throw error(409, `Package ${packageId} owns durable state; changing it requires a migration`);
      }
    }
    return migration;
  }

  async buildApp(plan: CompositionPlan, job: JobContext): Promise<{ app_id: string; revision: number }> {
    if (job.job_id) {
      const saved = this.apps.getByBuildJob(job.job_id);
      if (saved) {
        if (saved.bundle.plan_hash !== hashJson(plan)) throw new Error(`Build job ${job.job_id} was saved for a different plan`);
        job.stage("stored", `Application ${saved.app_id} revision ${saved.revision} was already stored`, 95);
        return { app_id: saved.app_id, revision: saved.revision };
      }
    }
    const validation = await this.validatePlan(plan);
    if (!validation.ok) throw error(422, "Composition plan has blockers", validation.errors);
    const appId = `app_${hashJson({ title: plan.app.title.trim().toLowerCase() }).slice(0, 32)}`;
    const active = this.apps.get(appId, "latest");
    const documentMigration = active?.status === "verified" ? await this.assertCompatibleState(active, plan) : null;
    job.stage("scenarios", "Executing composition acceptance scenarios", 30);
    const compositionReport = await this.runScenarios(plan, job.signal);
    if (compositionReport.verdict !== "passed") throw error(422, "Composition acceptance scenarios failed", compositionReport.tests.filter((test) => !test.passed));
    const revision = nextApplicationRevision(this.state, appId);
    const previousRevision = active?.status === "verified" ? active.revision : null;
    job.stage("compile", "Compiling the Electron source application", 65);
    const bundle = await compileApplication({ plan, registry: this.registry, validation, compositionReport, previousRevision, revision });
    const gate = applicationGate(bundle);
    if (!gate.ok) throw error(422, "Application verification failed", gate.findings);
    job.signal.throwIfAborted();
    this.state.transaction(() => {
      this.apps.save(bundle, job.job_id, active?.status === "verified" ? active.revision : null);
      if (documentMigration) applyDocumentMigration(new NamespacedStateStore(this.state, appId), plan, documentMigration);
    });
    job.stage("stored", `Application ${bundle.app_id} revision ${bundle.revision} stored`, 95);
    return { app_id: bundle.app_id, revision: bundle.revision };
  }

  async listApps(): Promise<ApplicationListResponse> { return this.apps.list(); }

  async getApp(appId: string, revision: number | "latest"): Promise<ApplicationRecord | null> { return this.apps.get(appId, revision); }

  async listAppRevisions(appId: string): Promise<ApplicationRevisionListResponse | null> { return this.apps.revisions(appId); }

  async activateRevision(appId: string, revision: number): Promise<ApplicationRecord> {
    const candidate = this.apps.get(appId, revision);
    if (!candidate) throw error(404, `No revision ${revision} for ${appId}`);
    if (candidate.status !== "verified") throw error(409, `Revision ${revision} is not verified`);
    const candidatePlan = this.storedPlan(candidate);
    const validation = await this.validatePlan(candidatePlan);
    if (!validation.ok) throw error(409, `Revision ${revision} has unavailable or incompatible packages`, validation.errors);
    const distribution = exportGate(candidate.bundle, {
      filename: `revision-${revision}.zip`, manifest_hash: candidate.app_hash, files: candidate.bundle.files,
      launch: candidate.bundle.launch, verification: candidate.bundle.verification,
    });
    if (!distribution.ok) throw error(409, `Revision ${revision} failed stored artifact verification`, distribution.findings);
    const active = this.apps.get(appId, "latest");
    if (active?.revision === revision) return this.apps.activate(appId, revision, active.revision);
    const expectedMigrations = new Map(MIGRATIONS.map((migration) => [migration.version, sha256Hex(migration.sql)]));
    for (const version of this.state.appliedMigrations()) {
      const expected = expectedMigrations.get(version);
      const included = candidate.bundle.storage_migrations.find((migration) => migration.version === version);
      if (!expected || included?.hash !== expected) {
        throw error(409, `Revision ${revision} cannot read state migration ${version}; rebuild or migrate it before activation`);
      }
    }
    const documentMigration = active?.status === "verified" ? await this.assertCompatibleState(active, candidatePlan, true) : null;
    return this.state.transaction(() => {
      const activated = this.apps.activate(appId, revision, active?.revision ?? null);
      if (documentMigration) applyDocumentMigration(new NamespacedStateStore(this.state, appId), candidatePlan, documentMigration);
      return activated;
    });
  }

  async exportApp(appId: string): Promise<ApplicationExportResponse> {
    const record = this.apps.get(appId, "latest");
    if (!record || record.status !== "verified") throw error(404, `No verified application ${appId}`);
    const bundle = ApplicationBundle.parse(record.bundle);
    const exported: ApplicationExportResponse = {
      filename: `${bundle.title.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-${bundle.revision}.splice-source.json`,
      manifest_hash: bundle.app_hash,
      files: bundle.files,
      launch: bundle.launch,
      verification: bundle.verification,
    };
    const gate = exportGate(bundle, exported);
    if (!gate.ok) throw error(422, "Application export failed verification", gate.findings);
    return exported;
  }

  async previewApp(appId: string, request: PreviewRequest): Promise<PreviewResponse> {
    const record = this.apps.get(appId, "latest");
    if (!record || record.status !== "verified") throw error(404, `No verified application ${appId}`);
    const planFile = record.bundle.files.find((file) => file.path === "splice.plan.json");
    if (!planFile?.content) throw error(500, "Stored application has no plan artifact");
    const manifest = JSON.parse(planFile.content) as { plan: CompositionPlan };
    const plan = CompositionPlanSchema.parse(manifest.plan);
    const unsupported = plan.instances.flatMap((instance) => instance.permissions.filter((effect) => ["audio_capture", "renderer_dom"].includes(effect)).map((effect) => `${instance.instance} requires ${effect}, which this preview host does not provide`));
    if (unsupported.length) return { ok: false, status: "failed", documents: {}, step_results: {}, unsupported, error: "Unsupported host effects" };
    const state = new NamespacedStateStore(this.state, appId);
    initializeDocuments(state, plan);
    state.transaction(() => {
      for (const edit of request.document_edits) {
        const definition = plan.documents.find((document) => document.id === edit.document && document.owner_instance === null);
        if (!definition) throw error(400, `Document ${edit.document} cannot be edited in preview`);
        const current = state.getDocument(edit.document);
        const value = current?.data && typeof current.data === "object" && !Array.isArray(current.data) ? structuredClone(current.data) as Record<string, unknown> : {};
        writePath(value, edit.path, edit.value);
        state.putDocument(edit.document, encodeWireValue(definition.schema, value), current?.revision ?? null);
      }
    });
    const runtime = await this.clients(plan);
    try {
      const engine = new WorkflowEngine(state, runtime.definitions, runtime.clients);
      const result = await engine.run(plan, request.workflow, asObject(request.input, "preview input"));
      return {
        ok: result.status === "succeeded",
        status: result.status,
        documents: result.documents,
        step_results: result.step_results as Record<string, JsonValue>,
        unsupported: [],
        error: Object.values(result.errors).join("; ") || null,
      };
    } finally {
      await runtime.dispose();
    }
  }
}
