import { createStore } from "zustand/vanilla";
import type { Api } from "../api/client";
import type { FeatureSpec, FeatureBlueprint, HealthResponse, Pantry, PipelineEvent, SynthEvent, SynthesisBundle } from "@splice/contracts";

export const GOLDEN_PROMPT = "Build a study app for a medical student: notes link to each other with [[wiki links]], show each note's backlinks, and turn every note into a flashcard scheduled with spaced repetition. Show what's due today.";
export interface Card {
  feature_id: string; app_id: string; title: string;
  phase: "queued" | "harvesting" | "specifying" | "implementing" | "ready" | "failed";
  message: string; spec?: FeatureSpec; blueprint?: FeatureBlueprint; error?: string;
  replayed: boolean; includeInFusion: boolean;
}
export interface StudioState {
  health?: HealthResponse; pantry?: Pantry; healthError?: string; error?: string;
  selected: string[]; cards: Record<string, Card>; log: { id: number; text: string; feature: string; ts: number }[];
  harvesting: boolean; prompt: string;
  synth: { status: "idle" | "running" | "ready" | "failed"; message: string; error?: string; bundle?: SynthesisBundle; validationErrors: string[] };
  init(): Promise<void>; refreshHealth(): Promise<void>; toggleFeature(id: string): void;
  toggleFusion(id: string): void; setPrompt(prompt: string): void;
  harvest(ids?: string[]): Promise<void>; fuse(): Promise<void>; cancel(): void;
}
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
export function createStudio(api: Api) {
  let harvestVersion = 0, synthesisVersion = 0, logId = 0;
  let harvestController: AbortController | undefined, synthController: AbortController | undefined;
  let initPromise: Promise<void> | undefined;
  return createStore<StudioState>((set, get) => {
    const patch = (id: string, value: Partial<Card>) => set(s => ({ cards: { ...s.cards, [id]: { ...s.cards[id], ...value } } }));
    const log = (feature: string, text: string) => set(s => ({ log: [...s.log.slice(-399), { id: ++logId, feature, text, ts: Date.now() }] }));
    return {
      selected: [], cards: {}, log: [], harvesting: false, prompt: GOLDEN_PROMPT,
      synth: { status: "idle", message: "", validationErrors: [] },
      async refreshHealth() {
        try { set({ health: await api.health(), healthError: undefined }); }
        catch (e) { set({ health: undefined, healthError: message(e) }); }
      },
      async init() {
        if (initPromise) return initPromise;
        initPromise = (async () => {
          await Promise.all([
            get().refreshHealth(),
            api.pantry().then(pantry => set({ pantry, error: undefined })).catch(e => set({ error: message(e) })),
          ]);
        })();
        await initPromise; initPromise = undefined;
      },
      toggleFeature(id) { if (!get().harvesting) set(s => ({ selected: s.selected.includes(id) ? s.selected.filter(x => x !== id) : [...s.selected, id] })); },
      toggleFusion(id) {
        const card = get().cards[id];
        if (card?.phase === "ready" && !get().harvesting && get().synth.status !== "running") patch(id, { includeInFusion: !card.includeInFusion });
      },
      setPrompt(prompt) { set({ prompt }); },
      cancel() {
        harvestVersion++; synthesisVersion++;
        harvestController?.abort(); synthController?.abort();
        set(s => ({
          harvesting: false,
          cards: Object.fromEntries(Object.entries(s.cards).map(([id, c]) => [id, ["queued","harvesting","specifying","implementing"].includes(c.phase) ? { ...c, phase: "failed" as const, error: "Cancelled", message: "Cancelled" } : c])),
          synth: s.synth.status === "running" ? { ...s.synth, status: s.synth.bundle ? "ready" : "idle", message: "Cancelled" } : s.synth,
        }));
      },
      async harvest(requested) {
        if (get().harvesting || get().synth.status === "running" || !get().pantry) return;
        const ids = requested ?? get().selected;
        if (!ids.length) return;
        const version = ++harvestVersion;
        harvestController = new AbortController();
        const signal = harvestController.signal;
        const cards = { ...get().cards };
        for (const id of ids) {
          const app = get().pantry!.apps.find(a => a.features.some(f => f.feature_id === id));
          const feature = app?.features.find(f => f.feature_id === id);
          if (!app || !feature) { set({ error: "Unknown pantry feature" }); return; }
          cards[id] = { feature_id: id, app_id: app.app_id, title: feature.title, phase: "queued", message: "Queued", replayed: false, includeInFusion: false };
        }
        set({ cards, harvesting: true });
        await Promise.all(ids.map(async id => {
          let extracted: FeatureSpec | undefined, blueprint: FeatureBlueprint | undefined;
          try {
            for (const step of ["extract", "implement"] as const) {
              let done = false, ok = false, fatal: string | undefined;
              const on = (e: PipelineEvent) => {
                if (version !== harvestVersion || signal.aborted || e.feature_id !== id) return;
                if (e.type === "stage") { patch(id, { message: e.message, phase: step === "implement" ? "implementing" : e.stage === "specifying" || e.stage === "checking_oracle" || e.stage === "repairing_spec" ? "specifying" : "harvesting" }); log(id, e.message); }
                if (e.type === "spec" && step === "extract") { extracted = e.spec; patch(id, { spec: e.spec, replayed: e.spec.provenance.mode === "replay" }); }
                if (e.type === "blueprint" && step === "implement") { blueprint = e.blueprint; patch(id, { blueprint: e.blueprint, replayed: get().cards[id].replayed || e.blueprint.verification.mode === "replay" }); }
                if (e.type === "tool_call") log(id, e.tool + " " + e.args_preview);
                if (e.type === "tool_result") log(id, e.tool + ": " + e.summary);
                if (e.type === "test_result") log(id, `${e.kind}: ${e.name} — ${e.passed ? "passed" : "failed"}`);
                if (e.type === "llm_progress") patch(id, { message: `${e.phase}: ${e.output_chars.toLocaleString()} characters` });
                if (e.type === "error") { log(id, e.message); if (e.fatal) fatal = e.message; }
                if (e.type === "done") { done = true; ok = e.ok; if (e.replayed) patch(id, { replayed: true }); }
              };
              patch(id, { phase: step === "extract" ? "harvesting" : "implementing" });
              if (step === "extract") await api.extract(cards[id].app_id, id, on, signal);
              else await api.implement(extracted!, on, signal);
              if (version !== harvestVersion || signal.aborted) return;
              if (fatal || !done || !ok) throw new Error(fatal ?? `${step} did not complete successfully`);
              if (step === "extract" && !extracted) throw new Error("Extraction finished without a spec");
            }
            if (!blueprint || blueprint.verification.status !== "passed" || !blueprint.verification.total || blueprint.verification.passed !== blueprint.verification.total || blueprint.verification.purity_violations.length || blueprint.verification.type_errors.length) throw new Error("Engine verification did not pass");
            patch(id, { phase: "ready", includeInFusion: true, message: "Engine checks passed" });
          } catch (e) {
            if (version === harvestVersion && !signal.aborted) { patch(id, { phase: "failed", error: message(e), message: message(e), includeInFusion: false }); log(id, message(e)); }
          }
        }));
        if (version === harvestVersion) set({ harvesting: false });
      },
      async fuse() {
        if (get().harvesting || get().synth.status === "running" || get().prompt.trim().length < 3) return;
        const blueprints = Object.values(get().cards).filter(c => c.phase === "ready" && c.includeInFusion && c.blueprint?.verification.status === "passed").map(c => c.blueprint!);
        if (!blueprints.length) return;
        const version = ++synthesisVersion;
        synthController = new AbortController(); const signal = synthController.signal;
        set(s => ({ synth: { ...s.synth, status: "running", message: "Starting fusion", error: undefined, validationErrors: [] } }));
        let candidate: SynthesisBundle | undefined, done = false, ok = false, fatal: string | undefined;
        try {
          await api.synthesize(blueprints, get().prompt, (e: SynthEvent) => {
            if (version !== synthesisVersion || signal.aborted) return;
            if (e.type === "stage") set(s => ({ synth: { ...s.synth, message: e.message } }));
            if (e.type === "validation") set(s => ({ synth: { ...s.synth, validationErrors: e.errors } }));
            if (e.type === "llm_progress") set(s => ({ synth: { ...s.synth, message: `Generating: ${e.output_chars.toLocaleString()} characters` } }));
            if (e.type === "bundle") candidate = e.bundle;
            if (e.type === "error" && e.fatal) fatal = e.message;
            if (e.type === "done") { done = true; ok = e.ok; }
          }, signal);
          if (version !== synthesisVersion || signal.aborted) return;
          if (fatal || !done || !ok || !candidate) throw new Error(fatal ?? "Fusion ended without a successful bundle");
          set(s => ({ synth: { ...s.synth, status: "ready", message: "App ready", bundle: candidate, error: undefined } }));
        } catch (e) {
          if (version === synthesisVersion && !signal.aborted) set(s => ({ synth: { ...s.synth, status: "failed", error: message(e) } }));
        }
      },
    };
  });
}

