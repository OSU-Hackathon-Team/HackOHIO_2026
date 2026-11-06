import { useEffect, useRef, useState, type FormEvent } from "react";
import { Download, FilePlus2, Redo2, Send, Square, Undo2, Upload } from "lucide-react";
import { parseCsv, ShowcaseProject, type ShowcaseAction } from "./showcaseModel";
import { activeShowcaseProject, useShowcase } from "./showcaseStore";
import { ShowcaseHistory } from "./ShowcaseHistory";
import { CodeCanvas } from "./CodeCanvas";
import { ShowcasePreviewPanels } from "./ShowcasePreviewPanels";
import { action, download } from "./showcaseUiUtils";
import type { ChatMode } from "./showcaseStore";

const accentColors = { amber: "#f6b84c", green: "#4ade80", blue: "#60a5fa", violet: "#a78bfa" };
const lightAccentText = { amber: "#9a5600", green: "#166534", blue: "#1d4ed8", violet: "#6d28d9" };
const recipes = [{ id: "trip", name: "Trip planner" }, { id: "budget", name: "Event budget" }, { id: "study", name: "Study notebook" }] as const;
const suggestions = ["Make a trip planner with notes, a budget, and packing tasks", "Add a taxi ride costing $40 to the budget", "Put the total at the top and make it green", "Add a task to book flights"];
function useAction() {
  const apply = useShowcase(s => s.apply);
  return (actions: ShowcaseAction[], summary?: string) => { try { apply(actions, summary); } catch { /* Store displays the error. */ } };
}
export function ShowcaseWorkspace() {
  const s = useShowcase();
  const p = activeShowcaseProject(s);
  const apply = useAction();
  const [prompt, setPrompt] = useState("");
  const [chatMode, setChatMode] = useState<ChatMode>("auto");
  const [pane, setPane] = useState<"app" | "library" | "history">("app");
  const [resetOpen, setResetOpen] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  useEffect(() => { if (mounted.current) end.current?.scrollIntoView({ block: "end", behavior: "smooth" }); else mounted.current = true; }, [s.messages, s.busy]);
  const submit = (e: FormEvent) => { e.preventDefault(); if (prompt.trim() && !s.busy) { void s.send(prompt, chatMode); setPrompt(""); } };
  const light = p.theme.mode === "light";
  const text = light ? "text-slate-900" : "text-stone-100";
  const card = light ? "bg-white border-slate-200" : "bg-[#232323] border-stone-700";
  const soft = light ? "text-slate-500" : "text-stone-400";
  const button = `rounded-lg border px-3 py-1.5 text-sm transition hover:opacity-75 ${light ? "border-slate-300 bg-white" : "border-stone-700 bg-[#292929]"}`;
  const compactControl = `h-8 w-[76px] rounded-lg border px-1.5 text-xs transition hover:opacity-75 ${light ? "border-slate-300 bg-white" : "border-stone-700 bg-[#292929]"}`;
  const headerButton = `${compactControl} inline-flex items-center justify-center gap-1 whitespace-nowrap`;
  const headerSelect = `${compactControl} text-center`;
  const chatButton = `inline-flex h-8 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg border px-2 text-xs transition hover:opacity-75 ${light ? "border-slate-300 bg-white" : "border-stone-700 bg-[#292929]"}`;
  return <div className={`flex min-h-dvh min-w-0 flex-col lg:h-dvh lg:flex-row ${text} ${light ? "showcase-light" : ""}`} style={{ background: light ? "#f6f7f8" : "#181818", fontFamily: "Inter, ui-sans-serif, system-ui", ["--accent" as string]: accentColors[p.theme.accent], ["--accent-ink" as string]: light ? lightAccentText[p.theme.accent] : accentColors[p.theme.accent] }}>
    <aside className={`flex w-full shrink-0 flex-col border-b lg:h-auto lg:w-[320px] lg:border-b-0 lg:border-r xl:w-[360px] ${light ? "border-slate-200 bg-white" : "border-stone-800 bg-[#141414]"}`}>
      <header className={`flex items-center justify-between border-b px-5 py-4 ${light ? "border-slate-200" : "border-stone-800"}`}>
        <div><div className="text-lg font-semibold tracking-tight">Splice <span className="text-xs font-normal" style={{ color: "var(--accent-ink)" }}>SHOWCASE</span></div><p className={`text-xs ${soft}`}>Describe your app. Use it immediately.</p></div>
        <button className={button} onClick={() => s.create()} title="New project"><FilePlus2 size={16} aria-hidden="true" /></button>
      </header>
      <div className={`border-b px-5 py-3 ${light ? "border-slate-200" : "border-stone-800"}`}>
        <label className={`block text-xs ${soft}`} htmlFor="showcase-project">Project</label>
        <select id="showcase-project" className={`mt-1 w-full rounded-lg border px-2 py-2 text-sm ${light ? "border-slate-200 bg-white" : "border-stone-700 bg-[#242424]"}`} value={p.id} onChange={e => s.open(e.target.value)}>{s.projects.map(x => <option value={x.id} key={x.id}>{x.title}</option>)}</select>
        <div className="mt-2 flex flex-wrap gap-2"><button className={button} onClick={() => s.duplicate()}>{s.codeVersions[p.id]?.current ? "Duplicate data" : "Duplicate"}</button><button className={button} onClick={() => setResetOpen(!resetOpen)}>Recipes</button><button className={button} onClick={() => setPane(pane === "library" ? "app" : "library")}>{pane === "library" ? "App" : "Library"}</button><button className={button} onClick={() => setPane(pane === "history" ? "app" : "history")}>{pane === "history" ? "App" : "History"}</button><button className={button} disabled={s.busy} onClick={() => { void s.loadPrepared(); setPane("app"); }}>Prepared banner</button>{s.projects.length > 1 && <button className={button} onClick={() => { if (window.confirm(`Delete “${p.title}”? Export it first if you want to keep it.`)) s.remove(p.id); }}>Delete</button>}</div>
        {resetOpen && <div className="mt-2 flex flex-wrap gap-2">{recipes.map(r => <button key={r.id} className={button} onClick={() => { s.create(r.id); setResetOpen(false); setPane("app"); }}>{r.name}</button>)}<button className={button} onClick={() => { s.create("blank"); setResetOpen(false); }}>Blank</button></div>}
      </div>
      <div className="max-h-52 min-h-0 flex-1 overflow-y-auto px-5 py-5 lg:max-h-none" role="log" aria-label="Conversation" aria-live="polite">
        {s.messages.length === 0 && <div className={`mb-5 rounded-xl border p-4 ${card}`}><p className="font-medium">What would you like to build?</p><p className={`mt-2 text-sm ${soft}`}>Try one of these prompts or choose a recipe. Existing Obsidian and Calc engines supply the core note and table behavior.</p></div>}
        <div className="space-y-4">{s.messages.map((m,i) => <div key={m.id} className={`rounded-xl border p-3 text-sm leading-6 ${m.role === "user" ? light ? "border-blue-200 bg-blue-50" : "border-stone-600 bg-[#303030]" : card}`}><div className={`mb-1 text-xs font-semibold ${soft}`}>{m.role === "user" ? "You" : m.model ? `Splice · ${m.model}` : "Splice"}</div><p className="whitespace-pre-wrap">{m.text}</p>{m.actions && m.revision === p.revision && i === s.messages.length - 1 ? <button className="mt-2 text-xs underline" onClick={() => s.undo()}>Undo this change</button> : null}</div>)}</div>
        {s.busy && <p role="status" className={`mt-5 text-sm ${soft}`}>{s.busyStage || "Working…"}</p>}
        {s.codeJob?.status === "ready" && <p className={`mt-2 text-xs ${soft}`}>Code check: TypeScript, build, browser boot · {s.codeJob.elapsedMs ? `${Math.round(s.codeJob.elapsedMs / 1000)}s` : "ready"}{s.codeJob.repairs ? ` · ${s.codeJob.repairs} repair` : ""}{s.codeJob.tokensUsed ? ` · ${s.codeJob.tokensUsed.toLocaleString()} tokens` : ""}</p>}
        <div ref={end} />
      </div>
      <div className={`border-t px-5 pb-5 pt-4 ${light ? "border-slate-200" : "border-stone-800"}`}>
        {s.error && <p role="alert" className="mb-3 rounded-lg bg-red-950/30 p-3 text-sm text-red-300">{s.error} {s.codeJob?.status === "ready" ? <button className="underline" onClick={() => { setChatMode("feature"); setPrompt([...s.messages].reverse().find(m => m.role === "user")?.text ?? ""); }}>Retry on current app</button> : <button className="underline" onClick={() => setPane("library")}>Use quick actions</button>}</p>}
        {!s.messages.some(m => m.role === "user") && <div className="mb-3 flex flex-wrap gap-2">{suggestions.map(x => <button key={x} className={`${button} text-xs`} onClick={() => setPrompt(x)}>{x}</button>)}</div>}
        <form onSubmit={submit} className={`rounded-xl border p-3 ${light ? "border-slate-300 bg-slate-50" : "border-stone-600 bg-[#222]"}`}>
          {s.selectedSectionId && <div className={`mb-2 flex items-center justify-between rounded px-2 py-1 text-xs ${light ? "bg-slate-200" : "bg-stone-700"}`}><span>Selected: {s.selectedSectionId.startsWith("code:") ? "built feature" : p.sections.find(section => section.id === s.selectedSectionId)?.title ?? "app section"}</span><button type="button" className="underline" onClick={() => s.selectSection(null)}>Clear</button></div>}
          <label className={`mb-2 block text-xs ${soft}`} htmlFor="showcase-chat-mode">Chat mode</label><select id="showcase-chat-mode" value={chatMode} onChange={e => setChatMode(e.target.value as ChatMode)} className={`mb-2 w-full rounded border px-2 py-1.5 text-sm ${light ? "border-slate-300 bg-white" : "border-stone-600 bg-[#292929]"}`}><option value="auto">Auto · edit data or build a feature</option><option value="edit">Edit app data</option><option value="feature">Build feature · write code</option></select>
          <label className="sr-only" htmlFor="showcase-chat">Describe a change</label><textarea id="showcase-chat" className="h-20 w-full resize-none bg-transparent text-sm outline-none" placeholder="Make me a trip planner with a budget…" value={prompt} maxLength={2000} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (prompt.trim()) submit(e); } }} />
          <div className="flex items-center justify-between gap-2"><span className={`min-w-0 text-xs ${soft}`}>Enter to send · Shift+Enter for newline</span>{s.busy ? <button type="button" className={chatButton} onClick={() => s.cancel()}><Square size={13} /> Stop</button> : <button type="submit" disabled={!prompt.trim()} className={chatButton} style={{ color: "var(--accent-ink)" }}><Send size={13} /> Send</button>}</div>
        </form>
        <p className={`mt-3 text-xs ${soft}`}>Live chat uses local Codex. Direct editing and recipes work without it.</p>
      </div>
    </aside>
    <main className="flex min-h-[75dvh] min-w-0 flex-1 flex-col lg:min-h-0" id="showcase-preview">
      <header className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-4 sm:px-7 ${light ? "border-slate-200" : "border-stone-800"}`}>
        <div><h1 className="text-xl font-semibold">{p.title}</h1><p className={`text-xs ${soft}`}>{pane === "app" ? "Live app preview" : pane === "library" ? "Available building blocks" : "Recorded provenance and live local checks"} · {s.savedOk ? "Saved locally" : "Unsaved"}</p></div>
        <div className="flex flex-wrap items-center gap-2"><button className={headerButton} aria-label="Toggle light theme" onClick={() => apply([action("theme.update", "", { mode: light ? "dark" : "light" })])}>{light ? "Dark" : "Light"}</button><select aria-label="Accent color" value={p.theme.accent} onChange={e => apply([action("theme.update", "", { accent: e.target.value })])} className={headerSelect}>{Object.keys(accentColors).map(color => <option key={color} value={color}>{color}</option>)}</select><button className={headerButton} title="Undo" aria-label="Undo" onClick={() => s.undo()}><Undo2 size={16} /></button><button className={headerButton} title="Redo" aria-label="Redo" onClick={() => s.redo()}><Redo2 size={16} /></button><button className={headerButton} onClick={() => download(`${p.title.replace(/[^a-z0-9]+/gi,"-").toLowerCase()}.json`, JSON.stringify(p, null, 2))}><Download size={15} /> {s.codeVersions[p.id]?.current ? "Export data" : "Export"}</button><button className={headerButton} onClick={() => file.current?.click()}><Upload size={15} /> Import</button><input ref={file} className="hidden" type="file" accept="application/json,.json" onChange={async e => { const input = e.currentTarget; const selected = input.files?.[0]; if (!selected) return; try { s.importProject(await selected.text()); } catch (error) { alert(error instanceof Error ? error.message : "Could not import project"); } input.value = ""; }} /></div>
      </header>
      {s.storageError && <div role="alert" className="border-b border-amber-700 bg-amber-950/30 px-7 py-2 text-sm text-amber-300">{s.storageError} <button className="underline" onClick={() => s.retrySave()}>Retry save</button></div>}
      {pane === "history" ? <ShowcaseHistory card={card} button={button} soft={soft} /> : pane === "library" ? <Library p={p} apply={apply} card={card} button={button} soft={soft} open={() => setPane("app")} /> : <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-7">
        {p.sections.filter(x => x.visible).length === 0 && <div className={`mx-auto mt-12 max-w-2xl rounded-2xl border p-8 text-center ${card}`}><h2 className="text-2xl font-semibold">Your app starts here</h2><p className={`mt-3 ${soft}`}>Describe it in chat, select a recipe, or add a building block from the library.</p><div className="mt-5 flex justify-center gap-2">{recipes.map(r => <button key={r.id} className={button} onClick={() => s.create(r.id)}>{r.name}</button>)}</div></div>}
        <CodeCanvas projectId={p.id} revision={s.codeVersions[p.id]?.current ?? null} light={light} />
        {s.codeVersions[p.id]?.current && <p className={`mb-3 text-xs ${soft}`}>Core editor · recovered notes and tables remain available below the generated preview.</p>}
        <ShowcasePreviewPanels p={p} apply={apply} selectedSectionId={s.selectedSectionId} selectSection={s.selectSection} />
      </div>}
      <footer className={`flex flex-wrap items-center justify-between gap-1 border-t px-4 py-2 text-xs sm:px-7 ${soft} ${light ? "border-slate-200" : "border-stone-800"}`}><span>Recovered: Obsidian notes · LibreOffice Calc tables. Authored in Splice: chat, tasks, charts, themes.</span><span>{p.capabilities.length} capabilities · revision {p.revision}</span></footer>
    </main>
  </div>;
}

/** The real reconstructed-capability preview, reused by generated showcase code. */
function Library({ p, apply, card, button, soft, open }: { p: ShowcaseProject; apply: ReturnType<typeof useAction>; card: string; button: string; soft: string; open: () => void }) {
  const csvFile = useRef<HTMLInputElement>(null);
  const markdownFile = useRef<HTMLInputElement>(null);
  const entries = [
    { id: "notes", name: "Markdown notes", source: "Recovered from Obsidian", detail: "Write, preview, and link notes." },
    { id: "calc", name: "Spreadsheet tables", source: "Recovered from LibreOffice Calc", detail: "Edit cells, formulas, and sort ordinary tables." },
    { id: "tasks", name: "Tasks", source: "Built by Splice", detail: "Track and complete work." },
    { id: "search", name: "Search", source: "Built by Splice", detail: "Find notes by title or content." },
    { id: "tags", name: "Tags", source: "Built by Splice", detail: "Organize and filter notes." },
    { id: "metrics", name: "Summary cards", source: "Built by Splice", detail: "Show totals and task progress." },
    { id: "charts", name: "Charts", source: "Built by Splice", detail: "Visualize table values." },
  ] as const;
  const add = (id: typeof entries[number]["id"]) => {
    const steps: ShowcaseAction[] = [action("capability.enable", id)];
    if (id === "notes" && !p.sections.some(s => s.kind === "notes")) steps.push(action("section.add", "", { kind: "notes", title: "Notes" }));
    if (id === "tasks" && !p.sections.some(s => s.kind === "tasks")) steps.push(action("section.add", "", { kind: "tasks", title: "Tasks" }));
    if (id === "metrics" && !p.sections.some(s => s.kind === "metric")) steps.push(action("section.add", "", { kind: "metric", title: "Summary" }));
    if (id === "charts" && p.tables[0] && !p.sections.some(s => s.kind === "chart")) steps.push(action("section.add", "", { kind: "chart", title: "Chart", ref: p.tables[0].id }));
    if (id === "calc" && !p.tables.length) steps.push(action("table.create", "", { title: "New table", grid: [["Item", "Qty", "Unit cost", "Total"], ["Example", 1, 10, "=B2*C2"]] }));
    apply(steps); open();
  };
  return <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-7"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-2xl font-semibold">Building blocks</h2><p className={`mb-6 mt-2 text-sm ${soft}`}>Available now. The recovered engines remain unchanged.</p></div><div className="flex flex-wrap gap-2"><button className={button} onClick={() => markdownFile.current?.click()}>Import Markdown</button><button className={button} onClick={() => csvFile.current?.click()}>Import CSV table</button><input ref={markdownFile} className="hidden" type="file" accept=".md,text/markdown,text/plain" onChange={async e => { const input = e.currentTarget; const file = input.files?.[0]; if (!file) return; try { if (file.size > 100_000) throw new Error("Markdown file exceeds 100 KB"); const body = await file.text(); const base = file.name.replace(/\.md$/i, "") || "Imported note"; const title = p.notes.some(n => n.title === base) ? `${base} ${Date.now()}` : base; apply([action("note.create", "", { title, body })]); open(); } catch (error) { alert(error instanceof Error ? error.message : "Could not import Markdown"); } input.value = ""; }} /><input ref={csvFile} className="hidden" type="file" accept=".csv,text/csv" onChange={async e => { const input = e.currentTarget; const file = input.files?.[0]; if (!file) return; try { const rows = parseCsv(await file.text()); const base = file.name.replace(/\.csv$/i, "") || "Imported table"; const title = p.tables.some(t => t.title === base) ? `${base} ${Date.now()}` : base; apply([action("table.create", "", { title, grid: rows })]); open(); } catch (error) { alert(error instanceof Error ? error.message : "Could not import CSV"); } input.value = ""; }} /></div></div><div className="grid grid-cols-1 gap-4 md:grid-cols-2">{entries.map(x => { const needsSection = (x.id === "tasks" && !p.sections.some(s => s.kind === "tasks")) || (x.id === "notes" && !p.sections.some(s => s.kind === "notes")) || (x.id === "metrics" && !p.sections.some(s => s.kind === "metric")) || (x.id === "calc" && !p.tables.length); return <div key={x.id} className={`rounded-xl border p-5 ${card}`}><div className="flex items-start justify-between gap-2"><h3 className="font-semibold">{x.name}</h3><span className="text-xs" style={{ color: "var(--accent-ink)" }}>{p.capabilities.includes(x.id) ? "Added" : "Available"}</span></div><p className={`mt-1 text-xs ${soft}`}>{x.source}</p><p className="my-4 text-sm">{x.detail}</p><button className={button} onClick={() => add(x.id)}>{p.capabilities.includes(x.id) && !needsSection ? "Open app" : "Add to app"}</button>{p.capabilities.includes(x.id) && <button className="ml-3 text-xs underline opacity-60" onClick={() => apply([action("capability.disable", x.id)])}>Remove</button>}</div>; })}</div></div>;
}
