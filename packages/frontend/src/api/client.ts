// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/06_state_and_api_client.md §2
import { Pantry, PipelineEvent, SynthEvent, HealthResponse, type FeatureSpec, type FeatureBlueprint } from "@splice/contracts";
import { streamPost } from "./sse";
import { mockApi } from "./mock";

export interface Api {
  health(signal?: AbortSignal): Promise<HealthResponse>;
  pantry(signal?: AbortSignal): Promise<Pantry>;
  extract(appId: string, featureId: string, on: (e: PipelineEvent) => void, signal?: AbortSignal): Promise<void>;
  implement(spec: FeatureSpec, on: (e: PipelineEvent) => void, signal?: AbortSignal): Promise<void>;
  synthesize(blueprints: FeatureBlueprint[], prompt: string, on: (e: SynthEvent) => void, signal?: AbortSignal): Promise<void>;
}
async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
  return response.json();
}
export const liveApi: Api = {
  async health(signal) {
    const value = await getJson("/api/health", signal);
    const parsed = HealthResponse.safeParse(value);
    if (!parsed.success) throw new Error("Backend health response is incomplete; live pipeline status is unknown.");
    return parsed.data;
  },
  async pantry(signal) { return Pantry.parse(await getJson("/api/pantry", signal)); },
  extract: (app_id, feature_id, on, signal) => streamPost("/api/extract", { app_id, feature_id }, on, { signal, schema: PipelineEvent }),
  implement: (spec, on, signal) => streamPost("/api/implement", { spec }, on, { signal, schema: PipelineEvent }),
  synthesize: (blueprints, prompt, on, signal) => streamPost("/api/synthesize", { blueprints, prompt }, on, { signal, schema: SynthEvent }),
};
export const developmentMode = import.meta.env.VITE_API_MODE === "mock" || (typeof location !== "undefined" && new URLSearchParams(location.search).get("mode") === "development");
export const api: Api = developmentMode ? mockApi : liveApi;
