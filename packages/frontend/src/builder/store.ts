import { createStore } from "zustand/vanilla";
import { z } from "zod";
import { applyBuilderOperations, BuilderBlock, BuilderLayout, assertLayoutFeatures, type BuilderEditRequest, type BuilderEditResponse } from "@splice/contracts";
import { Project, newProject, addFeatureToScene, projectId, type Scene } from "./project";

export type EditClient = (request: BuilderEditRequest, signal?: AbortSignal) => Promise<BuilderEditResponse>;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const KEY = "splice.builder.projects.v1";
export interface BuilderState {
  projects: Project[]; activeId: string | null; selectedFeature: string | null; selectedBlock: string | null;
  trying: boolean; busy: boolean; error?: string; storageError?: string; saved: boolean;
  past: Scene[]; future: Scene[];
  create(goal: string, sources: Project["sources"], sample: boolean): void;
  open(id: string | null): void; deleteProject(id: string): void; useSample(): void;
  mode(mode: Project["mode"]): void; rename(title: string): void;
  selectFeature(id: string | null): void; selectBlock(id: string | null): void; tryApp(value: boolean): void;
  addFeature(id: string, index?: number): void; addText(): void; updateBlock(block: BuilderBlock): void;
  removeBlock(id: string): void; moveBlock(id: string, index: number): void;
  undo(): void; redo(): void; send(text: string): Promise<void>; cancel(): void; retrySave(): void;
  addNote(title: string, body: string): void; reviewNote(id: string, grade: number): void;
}
import { reviewCard } from "../../../../fixtures/engines/_seed/sm2Scheduler";
export function activeProject(state: Pick<BuilderState, "projects" | "activeId">) { return state.projects.find(p => p.id === state.activeId); }
export function createBuilderStore(client: EditClient, storage?: Storage) {
  let projects: Project[] = [], storageError: string | undefined, blockedSave = false;
  try { const raw = storage?.getItem(KEY); if (raw) projects = z.array(Project).parse(JSON.parse(raw)); }
  catch { storageError = "Saved projects could not be restored. Existing storage is untouched; this session will stay in memory."; blockedSave = true; }
  let controller: AbortController | undefined, generation = 0;
  return createStore<BuilderState>((set, get) => {
    const persist = () => {
      try {
        if (blockedSave) return;
        if (!storage) throw new Error();
        storage.setItem(KEY, JSON.stringify(get().projects)); set({ saved: true, storageError: undefined });
      } catch { set({ saved: false, storageError: "Your changes are in memory, but could not be saved on this device. Retry saving before closing the page." }); }
    };
    const patch = (value: Partial<Project>) => {
      const project = activeProject(get()); if (!project) return;
      const updated = Project.parse({ ...project, ...value });
      set(s => ({ projects: s.projects.map(p => p.id === project.id ? updated : p), saved: false })); persist();
    };
    const scene = (next: Scene) => {
      const project = activeProject(get()); if (!project) return;
      assertLayoutFeatures(BuilderLayout.parse(next.layout), next.featureIds);
      set(s => ({ past: [...s.past.slice(-49), { layout: project.layout, featureIds: project.featureIds }], future: [], error: undefined }));
      patch({ ...next, revision: project.revision + 1 });
    };
    const safely = (fn: () => void) => { if (get().busy) return; try { fn(); } catch (e) { set({ error: (e as Error).message }); } };
    return {
      projects, activeId: null, selectedFeature: null, selectedBlock: null, trying: false, busy: false, saved: !storageError, storageError, past: [], future: [],
      create(goal, sources, sample) {
        get().cancel(); const project = newProject(goal, sources, sample);
        set(s => ({ projects: [project, ...s.projects], activeId: project.id, selectedFeature: null, selectedBlock: null, past: [], future: [], trying: false, error: undefined })); persist();
      },
      open(id) { get().cancel(); set({ activeId: id, selectedFeature: null, selectedBlock: null, past: [], future: [], error: undefined, trying: false }); },
      deleteProject(id) { get().cancel(); set(s => ({ projects: s.projects.filter(p => p.id !== id), activeId: s.activeId === id ? null : s.activeId })); persist(); },
      useSample() { patch({ sampleAnalysis: true }); },
      mode(mode) { patch({ mode }); set({ selectedFeature: null, selectedBlock: null, trying: false }); },
      rename(title) { if (title.trim()) patch({ title: title.trim().slice(0,100) }); },
      selectFeature(id) { set({ selectedFeature: id, selectedBlock: null }); },
      selectBlock(id) { set({ selectedBlock: id, selectedFeature: null }); },
      tryApp(trying) { set({ trying, selectedBlock: null }); },
      addFeature(id, index) { safely(() => { const p = activeProject(get()); if (!p?.sampleAnalysis) throw new Error("Load the explicitly labeled sample analysis first."); const next = addFeatureToScene(p, id, index); if (next !== p) scene(next); }); },
      addText() { safely(() => { const p = activeProject(get()); if (p) scene({ featureIds: p.featureIds, layout: [...p.layout, { id: projectId(), kind: "text", title: "A little context", description: "Add a heading or introduction to your app.", visible: true, width: "full" }] }); }); },
      updateBlock(block) { safely(() => { const p = activeProject(get()); if (p) scene({ featureIds: p.featureIds, layout: p.layout.map(b => b.id === block.id ? BuilderBlock.parse(block) : b) }); }); },
      removeBlock(id) { safely(() => { const p = activeProject(get()); if (p) { scene({ featureIds: p.featureIds, layout: p.layout.filter(b => b.id !== id) }); set({ selectedBlock: null }); } }); },
      moveBlock(id, index) { safely(() => { const p = activeProject(get()); if (!p) return; const blocks = [...p.layout], from = blocks.findIndex(b => b.id === id); if (from < 0) return; const [block] = blocks.splice(from,1); blocks.splice(Math.max(0,Math.min(index,blocks.length)),0,block); scene({ layout: blocks, featureIds: p.featureIds }); }); },
      undo() { safely(() => { const p = activeProject(get()), previous = get().past.at(-1); if (!p || !previous) return; set(s => ({ past: s.past.slice(0,-1), future: [{ layout: p.layout, featureIds: p.featureIds }, ...s.future], selectedBlock: null })); patch({ ...previous, revision: p.revision + 1 }); }); },
      redo() { safely(() => { const p = activeProject(get()), next = get().future[0]; if (!p || !next) return; set(s => ({ future: s.future.slice(1), past: [...s.past, { layout: p.layout, featureIds: p.featureIds }], selectedBlock: null })); patch({ ...next, revision: p.revision + 1 }); }); },
      cancel() { generation++; controller?.abort(); set({ busy: false }); },
      retrySave: persist,
      async send(text) {
        const p = activeProject(get()); if (!p || get().busy || !text.trim()) return;
        if (!p.sampleAnalysis) { set({ error: "Your application has not been analyzed. Open the sample analysis to prototype a layout." }); return; }
        const token = ++generation; controller = new AbortController(); const signal = controller.signal;
        patch({ chat: [...p.chat, { role: "user", text: text.trim() }] }); set({ busy: true, error: undefined });
        try {
          const response = await client({ revision: p.revision, instruction: text.trim(), selectedBlockId: get().selectedBlock, layout: p.layout, featureIds: p.featureIds }, signal);
          const current = activeProject(get());
          if (signal.aborted || token !== generation || current?.id !== p.id) return;
          if (response.revision !== p.revision || current.revision !== p.revision) throw new Error("The project changed while the assistant was working. Your layout was preserved; send the request again.");
          const layout = applyBuilderOperations(current.layout, response.operations, current.featureIds);
          if (response.operations.length) scene({ layout, featureIds: current.featureIds });
          patch({ chat: [...activeProject(get())!.chat, { role: "assistant", text: response.summary, model: response.model }] });
        } catch (e) { if (!signal.aborted && token === generation) set({ error: (e as Error).message }); }
        finally { if (token === generation) set({ busy: false }); }
      },
      addNote(title, body) { const p = activeProject(get()); if (!p || !title.trim()) return; if (p.notes.some(n => n.title.toLowerCase() === title.trim().toLowerCase())) { set({ error: "A note with that title already exists." }); return; } patch({ notes: [...p.notes, { id: projectId(), title: title.trim(), body }] }); },
      reviewNote(id, grade) { const p = activeProject(get()); if (!p) return; const state = p.reviews[id] ?? { repetitions: 0, intervalDays: 0, easeFactor: 2.5, lapses: 0 }; patch({ reviews: { ...p.reviews, [id]: reviewCard(state, grade, new Date().toISOString().slice(0,10)) } }); },
    };
  });
}
