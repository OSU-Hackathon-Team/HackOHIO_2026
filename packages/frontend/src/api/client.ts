import {
  Pantry, PipelineEvent, SynthEvent, HealthResponse, FeatureBlueprint,
  NativeSubsystemSpec, FeatureSpec, DecompTarget, DecompRun, DecompRunEvent,
  NativeLibrary, SavedAnalysis,
  NativeExtraction, NativeExtractionEvent, type NativeExtractionRequest, type AddLibraryFeatureRequest,
  NativeDiscoveryReport, NativeDiscoveryEvent, type NativeDiscoveryRequest,
  type DecompRunRequest, type RefineRequest,
} from "@splice/contracts";
import { z } from "zod";
import { streamGet, streamPost } from "./sse";
import { mockApi } from "./mock";

export interface Api {
  library?(signal?: AbortSignal): Promise<NativeLibrary>;
  savedAnalysis?(id: string, signal?: AbortSignal): Promise<SavedAnalysis>;
  savedExtractions?(id: string, signal?: AbortSignal): Promise<NativeExtraction[]>;
  libraryFeatures?(signal?: AbortSignal): Promise<NativeExtraction[]>;
  addLibraryFeature?(request: AddLibraryFeatureRequest, signal?: AbortSignal): Promise<NativeExtraction>;
  extractSavedAnalysis?(id: string, request: NativeExtractionRequest, on: (event: NativeExtractionEvent) => void, signal?: AbortSignal): Promise<void>;
  savedDiscoveries?(id: string, signal?: AbortSignal): Promise<NativeDiscoveryReport[]>;
  discoverSavedAnalysis?(id: string, request: NativeDiscoveryRequest, on: (event: NativeDiscoveryEvent) => void, signal?: AbortSignal): Promise<void>;
  health(signal?: AbortSignal): Promise<HealthResponse>;
  pantry(signal?: AbortSignal): Promise<Pantry>;
  extract(
    appId: string,
    featureId: string,
    on: (e: PipelineEvent) => void,
    signal?: AbortSignal,
    opts?: { force_mode?: "live" | "replay" },
  ): Promise<void>;
  implement(
    spec: FeatureSpec,
    on: (e: PipelineEvent) => void,
    signal?: AbortSignal,
    opts?: { force_mode?: "live" | "replay" },
  ): Promise<void>;
  synthesize(
    blueprints: FeatureBlueprint[],
    prompt: string,
    on: (e: SynthEvent) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  refine(
    req: RefineRequest,
    on: (e: SynthEvent) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  blueprints?(signal?: AbortSignal): Promise<FeatureBlueprint[]>;
  nativeSpec?(dossierArtifact: string, signal?: AbortSignal): Promise<{ artifact: string; spec: NativeSubsystemSpec }>;
  getNativeSpec?(artifact: string, signal?: AbortSignal): Promise<NativeSubsystemSpec>;
  listNativeSpecs?(signal?: AbortSignal): Promise<Array<{ artifact: string; spec: NativeSubsystemSpec }>>;
  adaptNativeSpec?(
    req: { spec?: NativeSubsystemSpec; artifact?: string; feature_id?: string },
    signal?: AbortSignal
  ): Promise<FeatureSpec>;
  /** UI-triggered native decompilation on the EC2 worker (backend: routes/decompRuns.ts). */
  decompTargets?(signal?: AbortSignal): Promise<{ enabled: boolean; targets: DecompTarget[] }>;
  startDecompRun?(req: DecompRunRequest, signal?: AbortSignal): Promise<DecompRun>;
  reimportDecompRun?(runId: string, signal?: AbortSignal): Promise<DecompRun>;
  streamDecompRun?(runId: string, on: (e: DecompRunEvent) => void, signal?: AbortSignal): Promise<void>;
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
  return response.json();
}

export const liveApi: Api = {
  async library(signal) { return NativeLibrary.parse(await getJson("/api/library", signal)); },
  async savedAnalysis(id, signal) { return SavedAnalysis.parse(await getJson(`/api/library/analyses/${encodeURIComponent(id)}`, signal)); },
  async savedExtractions(id, signal) {
    return z.object({ extractions: z.array(NativeExtraction) }).parse(await getJson(`/api/library/analyses/${encodeURIComponent(id)}/extractions`, signal)).extractions;
  },
  async libraryFeatures(signal) {
    return z.object({ features: z.array(NativeExtraction) }).parse(await getJson("/api/library/features", signal)).features;
  },
  async addLibraryFeature(request, signal) {
    const response = await fetch("/api/library/features", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal });
    if (!response.ok) throw new Error(`Save building block: ${response.status} ${await response.text()}`);
    return z.object({ feature: NativeExtraction }).parse(await response.json()).feature;
  },
  extractSavedAnalysis: (id, request, on, signal) => streamPost(`/api/library/analyses/${encodeURIComponent(id)}/extract`, request,
    on, { signal, schema: NativeExtractionEvent }),
  async savedDiscoveries(id, signal) {
    return z.object({ discoveries: z.array(NativeDiscoveryReport) }).parse(await getJson(`/api/library/analyses/${encodeURIComponent(id)}/discoveries`, signal)).discoveries;
  },
  discoverSavedAnalysis: (id, request, on, signal) => streamPost(`/api/library/analyses/${encodeURIComponent(id)}/discover`, request,
    on, { signal, schema: NativeDiscoveryEvent }),
  async health(signal) {
    const value = await getJson("/api/health", signal);
    const parsed = HealthResponse.safeParse(value);
    if (!parsed.success) throw new Error("Backend health response is incomplete; live pipeline status is unknown.");
    return parsed.data;
  },
  async pantry(signal) {
    return Pantry.parse(await getJson("/api/pantry", signal));
  },
  extract: (app_id, feature_id, on, signal, opts) =>
    streamPost(
      "/api/extract",
      { app_id, feature_id, ...(opts?.force_mode ? { force_mode: opts.force_mode } : {}) },
      on,
      { signal, schema: PipelineEvent },
    ),
  implement: (spec, on, signal, opts) =>
    streamPost(
      "/api/implement",
      { spec, ...(opts?.force_mode ? { force_mode: opts.force_mode } : {}) },
      on,
      { signal, schema: PipelineEvent },
    ),
  synthesize: (blueprints, prompt, on, signal) =>
    streamPost("/api/synthesize", { blueprints, prompt }, on, { signal, schema: SynthEvent }),
  refine: (req, on, signal) =>
    streamPost("/api/refine", req, on, { signal, schema: SynthEvent }),
  async blueprints(signal) {
    const value = await getJson("/api/blueprints", signal);
    return z.array(FeatureBlueprint).parse(value);
  },
  async nativeSpec(dossierArtifact, signal) {
    const res = await fetch("/api/native-specs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dossier_artifact: dossierArtifact }),
      signal,
    });
    if (!res.ok) throw new Error(`/api/native-specs: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const parsed = z.object({ artifact: z.string().regex(/^[a-f0-9]{64}$/), spec: NativeSubsystemSpec }).parse(data);
    return parsed;
  },
  async getNativeSpec(artifact, signal) {
    const value = await getJson(`/api/native-specs/${artifact}`, signal);
    return NativeSubsystemSpec.parse(value);
  },
  async listNativeSpecs(signal) {
    const value = z.object({
      specs: z.array(z.object({
        artifact: z.string().regex(/^[a-f0-9]{64}$/),
        spec: NativeSubsystemSpec,
      })),
    }).parse(await getJson("/api/native-specs", signal));
    return value.specs;
  },
  async adaptNativeSpec(req, signal) {
    const res = await fetch("/api/native-specs/adapt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });
    if (!res.ok) throw new Error(`/api/native-specs/adapt: ${res.status} ${await res.text()}`);
    const data = z.object({
      spec: FeatureSpec.optional(),
      feature_spec: FeatureSpec.optional(),
    }).refine(value => value.spec !== undefined || value.feature_spec !== undefined, {
      message: "Native adapter response did not include a FeatureSpec",
    }).parse(await res.json());
    return data.spec ?? data.feature_spec!;
  },
  async decompTargets(signal) {
    return z.object({ enabled: z.boolean(), targets: z.array(DecompTarget) })
      .parse(await getJson("/api/decomp/targets", signal));
  },
  async startDecompRun(req, signal) {
    const res = await fetch("/api/decomp/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `/api/decomp/runs: ${res.status}`);
    return z.object({ run: DecompRun }).parse(data).run;
  },
  async reimportDecompRun(runId, signal) {
    const response = await fetch(`/api/decomp/runs/${encodeURIComponent(runId)}/reimport`, { method: "POST", signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((data as { error?: string }).error ?? `Re-import ${runId}: ${response.status}`);
    return z.object({ run: DecompRun }).parse(data).run;
  },
  streamDecompRun: (runId, on, signal) =>
    streamGet(`/api/decomp/runs/${encodeURIComponent(runId)}/events`, on, { signal, schema: DecompRunEvent }),
};

export const developmentMode =
  (import.meta as any).env?.VITE_API_MODE === "mock" ||
  (typeof location !== "undefined" && new URLSearchParams(location.search).get("mode") === "development");

export const replayMode =
  !developmentMode &&
  (typeof location !== "undefined" && new URLSearchParams(location.search).get("mode") === "replay");

export const api: Api = developmentMode ? mockApi : liveApi;

