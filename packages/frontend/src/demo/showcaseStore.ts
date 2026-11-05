import { create } from "zustand";
import { z } from "zod";
import type { ShowcaseCodeJob } from "@splice/contracts";
import { DEMO_NOTES } from "./notes";
import { withLiveBudgetTables } from "./showcaseRecipe";
import { applyShowcaseActions, projectTotal, tableTotal, tableValues, ShowcaseAction, ShowcaseProject, showcaseId } from "./showcaseModel";

const KEY = "splice.showcase.projects.v1";
export type ShowcaseMessage = { id: string; role: "user" | "assistant"; text: string; model?: string; actions?: number; revision?: number };
export type ChatMode = "auto" | "edit" | "feature";
type CodeVersion = { current: string | null; past: string[] };
const message = z.object({ id: z.string(), role: z.enum(["user", "assistant"]), text: z.string(), model: z.string().optional(), actions: z.number().optional(), revision: z.number().int().nonnegative().optional() });
const Saved = z.object({ projects: z.array(ShowcaseProject).min(1), activeId: z.string(), messages: z.array(message), chats: z.record(z.array(message)).default({}), histories: z.record(z.object({ past: z.array(ShowcaseProject).max(50), future: z.array(ShowcaseProject).max(50) })).default({}), codeVersions: z.record(z.object({ current: z.string().uuid().nullable(), past: z.array(z.string().uuid()) })).default({}) }).refine(value => value.projects.some(p => p.id === value.activeId), "The selected project is missing");
type Saved = z.infer<typeof Saved>;

function makeProject(recipe: "blank" | "trip" | "budget" | "study" = "blank"): ShowcaseProject {
  const p: ShowcaseProject = { version: 1, id: showcaseId(), revision: 0, title: "Untitled app", capabilities: [], notes: [], tables: [], tasks: [], sections: [], theme: { mode: "dark", accent: "amber", density: "comfortable" } };
  if (recipe === "blank") return p;
  if (recipe === "trip") {
    p.title = "Trip planner";
    p.capabilities = ["notes", "calc", "tasks", "metrics", "search", "tags"];
    p.notes = [{ id: showcaseId(), title: "Itinerary", body: "# Itinerary\n\nPlan flights, lodging, and places to visit. See [[Budget]].", tags: ["travel"] }, { id: showcaseId(), title: "Budget", body: "# Budget\n\nCosts update when you edit the table.", tags: ["finance"] }];
    p.tables = [{ id: showcaseId(), title: "Trip budget", grid: [["Item", "Qty", "Unit cost", "Total"], ["Flights", 1, 400, "=B2*C2"], ["Hotel nights", 3, 120, "=B3*C3"], ["Grand total", "", "", "=D2+D3"]] }];
    p.tasks = [{ id: showcaseId(), title: "Book flights", done: false }, { id: showcaseId(), title: "Pack luggage", done: false }];
    p.sections = [{ id: showcaseId(), kind: "metric", ref: "all", title: "Trip total", visible: true, width: "half" }, { id: showcaseId(), kind: "notes", ref: "all", title: "Notes", visible: true, width: "half" }, { id: showcaseId(), kind: "table", ref: p.tables[0].id, title: "Trip budget", visible: true, width: "full" }, { id: showcaseId(), kind: "tasks", ref: "all", title: "Packing and bookings", visible: true, width: "half" }];
  } else if (recipe === "budget") {
    p.title = "Event budget";
    p.capabilities = ["notes", "calc", "metrics", "charts", "tasks", "search"];
    p.notes = DEMO_NOTES.map(n => ({ ...n, tags: [] }));
    p.tables = [{ id: showcaseId(), title: "Event costs", grid: [["Item", "Qty", "Unit cost", "Total"], ["Posters", 4, 25, "=B2*C2"], ["Stickers", 200, 0.5, "=B3*C3"], ["Snacks", 30, 3, "=B4*C4"], ["Grand total", "", "", "=D2+D3+D4"]] }];
    p.sections = [{ id: showcaseId(), kind: "metric", ref: "all", title: "Event total", visible: true, width: "half" }, { id: showcaseId(), kind: "chart", ref: p.tables[0].id, title: "Costs by item", visible: true, width: "half" }, { id: showcaseId(), kind: "notes", ref: "all", title: "Project notes", visible: true, width: "full" }, { id: showcaseId(), kind: "table", ref: p.tables[0].id, title: "Event costs", visible: true, width: "full" }];
  } else {
    p.title = "Study notebook";
    p.capabilities = ["notes", "tasks", "search", "tags"];
    p.notes = [{ id: showcaseId(), title: "Topics", body: "# Topics\n\nStart a new note and link it with [[Topics]].", tags: ["study"] }];
    p.tasks = [{ id: showcaseId(), title: "Review notes", done: false }];
    p.sections = [{ id: showcaseId(), kind: "notes", ref: "all", title: "Study notes", visible: true, width: "full" }, { id: showcaseId(), kind: "tasks", ref: "all", title: "Study tasks", visible: true, width: "half" }];
  }
  return ShowcaseProject.parse(withLiveBudgetTables(p));
}

function initial(): { saved: Saved; storageError?: string } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = Saved.parse(JSON.parse(raw));
      const projects = saved.projects.map(project => {
        const upgraded = withLiveBudgetTables(project);
        return upgraded === project ? project : { ...upgraded, revision: project.revision + 1 };
      });
      if (projects.some((project, index) => project !== saved.projects[index])) {
        const upgraded = Saved.parse({ ...saved, projects });
        try { localStorage.setItem(KEY, JSON.stringify(upgraded)); }
        catch { return { saved: upgraded, storageError: "The recipe was upgraded in memory, but local storage could not save it. Retry save when space is available." }; }
        return { saved: upgraded };
      }
      return { saved };
    }
  } catch { return { saved: { projects: [makeProject()], activeId: "", messages: [], chats: {}, histories: {}, codeVersions: {} }, storageError: "Saved projects could not be read. This session is in memory; the stored data was left untouched." }; }
  const p = makeProject();
  return { saved: { projects: [p], activeId: p.id, messages: [{ id: showcaseId(), role: "assistant", text: "Describe an app to build, or start with a recipe. I can add notes, tables, tasks, summary cards, charts, and change the layout." }], chats: {}, histories: {}, codeVersions: {} } };
}

const boot = initial();
let controller: AbortController | undefined;
let generation = 0;
let runningCodeJob: string | undefined;
function appliedMessage(actions: ShowcaseAction[]): string {
  const verbs: Record<string, string> = {
    "project.rename": "renamed the app", "capability.enable": "added a capability", "capability.disable": "removed a capability", "section.add": "added a section", "section.update": "updated a section", "section.move": "moved a section", "section.remove": "removed a section",
    "note.create": "created a note", "note.update": "edited a note", "note.embedTable": "embedded a live table in a note", "note.duplicate": "duplicated a note", "note.delete": "deleted a note", "table.create": "created a table", "table.rename": "renamed a table", "table.delete": "deleted a table", "table.cell": "updated a cell", "table.addRow": "added a table row", "table.deleteRow": "removed a table row", "table.addColumn": "added a table column", "table.deleteColumn": "removed a table column", "table.sort": "sorted a table", "table.filter": "filtered a table",
    "task.create": "created a task", "task.update": "updated a task", "task.delete": "deleted a task", "theme.update": "changed the theme",
  };
  const summary = [...new Set(actions.map(a => verbs[a.type]))];
  return `Done: ${summary.join(", ")}.`;
}
function quickAction(prompt: string, p: ShowcaseProject): ShowcaseAction[] | null {
  const make = (type: ShowcaseAction["type"], target: string, data: Record<string, unknown> = {}): ShowcaseAction => ({ type, target, data });
  const note = prompt.match(/^(?:create|add|make) (?:a |new )?note (?:called|named|titled) ["“]?(.+?)["”]?$/i);
  if (note) return [make("note.create", "", { title: note[1].trim() })];
  const task = prompt.match(/^(?:create|add) (?:a |new )?task (?:to )?(.+)$/i);
  if (task) return [make("task.create", "", { title: task[1].trim() })];
  const theme = prompt.match(/^(?:make|change|set) (?:it |the (?:app |theme )?)?(?:to )?(?:a )?(green|blue|violet|amber|light|dark)(?: theme)?$/i);
  if (theme) return [make("theme.update", "", ["light", "dark"].includes(theme[1].toLowerCase()) ? { mode: theme[1].toLowerCase() } : { accent: theme[1].toLowerCase() })];
  if (/^(?:add|create) (?:a |new )?(?:budget )?table$/i.test(prompt)) return [make("table.create", "", { title: `Table ${p.tables.length + 1}`, grid: [["Item", "Qty", "Unit cost", "Total"], ["Example", 1, 10, "=B2*C2"]] })];
  return null;
}
function codeDerived(project: ShowcaseProject) { return { total: projectTotal(project), tableTotals: Object.fromEntries(project.tables.map(t => [t.id, tableTotal(project, t.id)])), tableValues: Object.fromEntries(project.tables.map(t => [t.id, tableValues(project, t.id)])) }; }

interface ShowcaseState extends Saved {
  busy: boolean; busyStage?: string; codeJob?: ShowcaseCodeJob; error?: string; storageError?: string; savedOk: boolean; selectedSectionId: string | null;
  create(recipe?: "blank" | "trip" | "budget" | "study"): void;
  open(id: string): void; duplicate(): void; remove(id: string): void;
  apply(actions: ShowcaseAction[], summary?: string, model?: string): void;
  undo(): void; redo(): void; send(text: string, mode?: ChatMode): Promise<void>; cancel(): void; revertCode(): void; loadPrepared(): Promise<void>;
  selectSection(id: string | null): void; importProject(raw: string): void; reset(recipe: "blank" | "trip" | "budget" | "study"): void;
  retrySave(): void;
}

export const useShowcase = create<ShowcaseState>((set, get) => {
  const persist = () => {
    try {
      set(s => ({ chats: { ...s.chats, [s.activeId]: s.messages } }));
      localStorage.setItem(KEY, JSON.stringify({ projects: get().projects, activeId: get().activeId, messages: get().messages, chats: get().chats, histories: get().histories, codeVersions: get().codeVersions }));
      set({ savedOk: true, storageError: undefined });
    } catch { set({ savedOk: false, storageError: "Changes are in memory, but saving failed. Export this project before closing the page." }); }
  };
  const active = () => get().projects.find(p => p.id === get().activeId);
  const replace = (p: ShowcaseProject) => { set(s => ({ projects: s.projects.map(x => x.id === p.id ? p : x), savedOk: false })); persist(); };
  const cancel = () => { generation++; controller?.abort(); if (runningCodeJob) { void fetch(`/api/showcase/code/jobs/${runningCodeJob}`, { method: "DELETE" }).catch(() => {}); runningCodeJob = undefined; } set({ busy: false, busyStage: undefined }); };
  return {
    ...boot.saved, activeId: boot.saved.activeId || boot.saved.projects[0]?.id || "", busy: false, storageError: boot.storageError, savedOk: !boot.storageError, selectedSectionId: null,
    create(recipe = "blank") { cancel(); const p = makeProject(recipe); set(s => ({ projects: [p, ...s.projects], chats: { ...s.chats, [s.activeId]: s.messages }, activeId: p.id, messages: [], selectedSectionId: null, error: undefined })); persist(); },
    open(id) { if (!get().projects.some(p => p.id === id)) return; cancel(); set(s => ({ chats: { ...s.chats, [s.activeId]: s.messages }, activeId: id, messages: s.chats[id] ?? [], selectedSectionId: null, error: undefined })); persist(); },
    duplicate() { const p = active(); if (!p) return; cancel(); const copy = { ...structuredClone(p), id: showcaseId(), title: `${p.title} copy`, revision: 0 }; set(s => ({ projects: [copy, ...s.projects], chats: { ...s.chats, [s.activeId]: s.messages }, activeId: copy.id, messages: [], selectedSectionId: null })); persist(); },
    remove(id) { if (get().projects.length <= 1) return; cancel(); set(s => {
      const projects = s.projects.filter(p => p.id !== id), chats = { ...s.chats }, histories = { ...s.histories }, codeVersions = { ...s.codeVersions };
      delete chats[id];
      delete histories[id];
      delete codeVersions[id];
      if (s.activeId !== id) chats[s.activeId] = s.messages;
      const activeId = s.activeId === id ? projects[0].id : s.activeId;
      return { projects, chats, histories, codeVersions, activeId, messages: s.activeId === id ? chats[activeId] ?? [] : s.messages, selectedSectionId: null };
    }); persist(); },
    apply(actions, summary, model) {
      const p = active(); if (!p) return;
      try {
        const next = applyShowcaseActions(p, actions);
        const h = get().histories[p.id] ?? { past: [], future: [] };
        set(s => ({ histories: { ...s.histories, [p.id]: { past: [...h.past.slice(-49), p], future: [] } } }));
        replace(next);
        if (summary) { set(s => ({ messages: [...s.messages, { id: showcaseId(), role: "assistant", text: summary, model, actions: actions.length, revision: next.revision }] })); persist(); }
        set({ error: undefined });
      } catch (error) { set({ error: error instanceof Error ? error.message : "Unable to apply changes" }); throw error; }
    },
    undo() { const p = active(); if (!p) return; const h = get().histories[p.id], previous = h?.past.at(-1); if (!previous) return; cancel(); set(s => ({ histories: { ...s.histories, [p.id]: { past: h.past.slice(0,-1), future: [p, ...h.future].slice(0,50) } } })); replace({ ...previous, revision: p.revision + 1 }); },
    redo() { const p = active(); if (!p) return; const h = get().histories[p.id], next = h?.future[0]; if (!next) return; cancel(); set(s => ({ histories: { ...s.histories, [p.id]: { past: [...h.past, p].slice(-50), future: h.future.slice(1) } } })); replace({ ...next, revision: p.revision + 1 }); },
    revertCode() { const p = active(); if (!p) return; cancel(); const version = get().codeVersions[p.id]; if (!version?.current) return; const previous = version.past.at(-1) ?? null; set(s => ({ codeVersions: { ...s.codeVersions, [p.id]: { current: previous, past: version.past.slice(0, -1) } }, selectedSectionId: s.selectedSectionId?.startsWith("code:") ? null : s.selectedSectionId, messages: [...s.messages, { id: showcaseId(), role: "assistant", text: "Restored the previous code version. Your app data is unchanged." }] })); persist(); },
    async loadPrepared() {
      const p = active(); if (!p || get().busy) return;
      const token = ++generation, parentRevision = get().codeVersions[p.id]?.current ?? null;
      controller = new AbortController(); const signal = controller.signal;
      set({ busy: true, busyStage: "Building prepared example…", error: undefined });
      try {
        const response = await fetch("/api/showcase/code/prepared", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: p, derived: codeDerived(p), parentRevision }), signal });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "Could not build prepared example");
        if (signal.aborted || token !== generation || active()?.id !== p.id) return;
        if (active()?.revision !== p.revision || (get().codeVersions[p.id]?.current ?? null) !== parentRevision) throw new Error("The app changed while loading the prepared example. Try again.");
        set(s => ({ codeVersions: { ...s.codeVersions, [p.id]: { current: result.revision, past: [...(s.codeVersions[p.id]?.past ?? []), ...(parentRevision ? [parentRevision] : [])].slice(-20) } }, selectedSectionId: s.selectedSectionId?.startsWith("code:") ? `code:${result.revision}` : s.selectedSectionId, messages: [...s.messages, { id: showcaseId(), role: "assistant", text: "Loaded a banner prepared before the showcase. It is connected to your current budget data; this was not a live model generation.", model: "Prepared example" }] })); persist();
      } catch (error) { if (!signal.aborted && token === generation) set({ error: error instanceof Error ? error.message : "Prepared example unavailable" }); }
      finally { if (token === generation) set({ busy: false, busyStage: undefined }); }
    },
    selectSection(id) { set({ selectedSectionId: id }); }, cancel, retrySave: persist,
    importProject(raw) {
      const p = ShowcaseProject.parse(withLiveBudgetTables(ShowcaseProject.parse(JSON.parse(raw))));
      const copy = { ...p, id: showcaseId(), title: `${p.title} (imported)`, revision: 0 };
      cancel(); set(s => ({ projects: [copy, ...s.projects], activeId: copy.id, messages: [], selectedSectionId: null, error: undefined })); persist();
    },
    reset(recipe) { cancel(); const p = active(); if (!p) return; const fresh = { ...makeProject(recipe), id: p.id, revision: p.revision + 1 }; set(s => { const histories = { ...s.histories }, codeVersions = { ...s.codeVersions }; delete histories[p.id]; delete codeVersions[p.id]; return { histories, codeVersions }; }); replace(fresh); set({ messages: [], selectedSectionId: null, error: undefined }); persist(); },
    async send(raw, mode = "auto") {
      const prompt = raw.trim(), p = active(); if (!prompt || !p || get().busy) return;
      const token = ++generation; controller = new AbortController(); const signal = controller.signal;
      set(s => ({ messages: [...s.messages, { id: showcaseId(), role: "user", text: prompt }], busy: true, busyStage: mode === "feature" ? "Planning feature…" : "Understanding your request…", error: undefined, codeJob: undefined })); persist();
      try {
        const featureRequest = async () => {
          const parentRevision = get().codeVersions[p.id]?.current ?? null;
          const start = await fetch("/api/showcase/code/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: p.id, prompt, project: p, derived: codeDerived(p), parentRevision, selectedSectionId: get().selectedSectionId, history: get().messages.slice(-6).map(m => ({ role: m.role, text: m.text })) }), signal });
          const started = await start.json().catch(() => ({}));
          if (!start.ok) throw new Error(started.error || `Could not start code job (${start.status})`);
          runningCodeJob = started.id;
          while (!signal.aborted) {
            await new Promise<void>((resolve, reject) => { const abort = () => { clearTimeout(timer); reject(new Error("Cancelled")); }; const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 700); signal.addEventListener("abort", abort, { once: true }); });
            const response = await fetch(`/api/showcase/code/jobs/${started.id}`, { signal });
            const job: ShowcaseCodeJob = await response.json();
            if (!response.ok) throw new Error("Code job status is unavailable");
            if (token !== generation || active()?.id !== p.id) return;
            set({ codeJob: job, busyStage: ({ planning: "Planning feature…", writing: "Writing files…", checking: "Checking candidate…", ready: "Ready", failed: "Failed", cancelled: "Cancelled" } as Record<string, string>)[job.status] });
            if (job.status === "ready") {
              runningCodeJob = undefined;
              if (!job.revision) throw new Error("Code job returned no revision");
              if ((get().codeVersions[p.id]?.current ?? null) !== parentRevision) throw new Error("The code changed during generation. Candidate kept as a draft; retry the feature on the current code.");
              if (active()?.revision !== p.revision) {
                set({ busyStage: "Rechecking with current data…" });
                const latest = active()!;
                const check = await fetch(`/api/showcase/code/revisions/${job.revision}/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: latest, derived: codeDerived(latest) }), signal });
                const result = await check.json().catch(() => ({}));
                if (!check.ok) throw new Error(`Candidate kept as a draft because the current-data check failed: ${result.error || check.status}`);
                if (token !== generation || active()?.id !== p.id || (get().codeVersions[p.id]?.current ?? null) !== parentRevision) return;
              }
              set(s => ({ codeVersions: { ...s.codeVersions, [p.id]: { current: job.revision!, past: [...(s.codeVersions[p.id]?.past ?? []), ...(parentRevision ? [parentRevision] : [])].slice(-20) } }, selectedSectionId: s.selectedSectionId?.startsWith("code:") ? `code:${job.revision}` : s.selectedSectionId, messages: [...s.messages, { id: showcaseId(), role: "assistant", text: `${job.summary || "Feature ready."}\nChanged: ${(job.files ?? []).join(", ")}. Checked with TypeScript, a local build, and browser boot.`, model: job.model }] })); persist(); return;
            }
            if (job.status === "failed" || job.status === "cancelled") { runningCodeJob = undefined; throw new Error(job.error || "Code job stopped"); }
          }
        };
        if (mode === "feature" || (mode === "auto" && get().selectedSectionId?.startsWith("code:") && /\b(this|feature|component|banner|widget)\b/i.test(prompt))) { await featureRequest(); return; }
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const response = await fetch("/api/showcase/edits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, revision: p.revision, project: p, selectedSectionId: get().selectedSectionId, derived: { today, total: projectTotal(p), tableTotals: p.tables.map(t => ({ id: t.id, title: t.title, total: tableTotal(p, t.id) })), tasksComplete: p.tasks.filter(t => t.done).length, tasksOverdue: p.tasks.filter(t => !t.done && /^\d{4}-\d{2}-\d{2}$/.test(t.due ?? "") && t.due! < today).map(t => ({ title: t.title, due: t.due! })) }, history: get().messages.slice(-6).map(m => ({ role: m.role, text: m.text })) }), signal });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Assistant request failed (${response.status})`);
        if (signal.aborted || token !== generation || active()?.id !== p.id) return;
        if (active()?.revision !== p.revision) throw new Error("The app changed while I was working. Send the request again for the current version.");
        if (body.outcome === "unsupported" && mode === "auto" && /\b(banner|widget|calculator|view|dashboard|component|layout|feature|group|highlight|visual|panel|interface|button)\b/i.test(prompt)) { await featureRequest(); return; }
        if (body.outcome === "apply") {
          const actions = z.array(ShowcaseAction).min(1).max(20).parse(body.actions);
          get().apply(actions, appliedMessage(actions), body.model);
        } else {
          set(s => ({ messages: [...s.messages, { id: showcaseId(), role: "assistant", text: String(body.message || "I need more detail to make that change."), model: body.model }] })); persist();
        }
      } catch (error) {
        if (!signal.aborted && token === generation) {
          const current = active();
          const quick = mode !== "feature" && current?.revision === p.revision ? quickAction(prompt, current) : null;
          if (quick) {
            try { get().apply(quick, `${appliedMessage(quick)} Applied locally while Codex was unavailable.`, "Local quick action"); }
            catch { /* The action executor already reported the error. */ }
          } else set({ error: error instanceof Error ? error.message : "Assistant unavailable" });
        }
      } finally { if (token === generation) set({ busy: false, busyStage: undefined }); }
    },
  };
});

export const activeShowcaseProject = (s: ShowcaseState) => s.projects.find(p => p.id === s.activeId)!;
export const showcaseTotal = (p: ShowcaseProject) => projectTotal(p);
