import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Download, FilePlus2, Plus, Redo2, Send, Square, Undo2, Upload } from "lucide-react";
import { renderMarkdown } from "./engines/obsidianRenderer";
import { hasFormulas } from "./notesDocument";
import { cellLabel, parseCsv, projectTotal, ShowcaseProject, tableCsv, tableTotal, tableValues, type ShowcaseAction } from "./showcaseModel";
import { activeShowcaseProject, useShowcase } from "./showcaseStore";
import { ShowcaseHistory } from "./ShowcaseHistory";

const accentColors = { amber: "#f6b84c", green: "#4ade80", blue: "#60a5fa", violet: "#a78bfa" };
const recipes = [{ id: "trip", name: "Trip planner" }, { id: "budget", name: "Event budget" }, { id: "study", name: "Study notebook" }] as const;
const suggestions = ["Make a trip planner with notes, a budget, and packing tasks", "Add a taxi ride costing $40 to the budget", "Put the total at the top and make it green", "Add a task to book flights"];
function download(name: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
function safeHtml(markdown: string): string {
  const doc = new DOMParser().parseFromString(renderMarkdown(markdown).html, "text/html");
  const allowed = new Set("div p h1 h2 h3 h4 h5 h6 a strong em b i code pre blockquote ul ol li hr br del s span table thead tbody tr th td".split(" "));
  const walk = (root: Element) => {
    for (const child of [...root.children]) {
      if (!allowed.has(child.tagName.toLowerCase())) { child.replaceWith(doc.createTextNode(child.textContent ?? "")); continue; }
      const internalLink = child.tagName === "A" && child.classList.contains("internal-link");
      const callout = child.classList.contains("callout");
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        const safeLink = name === "href" && /^(https?:\/\/|#)/i.test(attr.value);
        if (name === "class" && (internalLink || callout)) { child.setAttribute("class", internalLink ? "internal-link" : "callout"); continue; }
        const internal = (name === "data-href" && internalLink) || (name === "data-callout" && callout);
        if (!safeLink && !internal) child.removeAttribute(attr.name);
      }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}
function useAction() {
  const apply = useShowcase(s => s.apply);
  return (actions: ShowcaseAction[], summary?: string) => { try { apply(actions, summary); } catch { /* Store displays the error. */ } };
}
const action = (type: ShowcaseAction["type"], target = "", data: Record<string, unknown> = {}): ShowcaseAction => ({ type, target, data });

export function ShowcaseWorkspace() {
  const s = useShowcase();
  const p = activeShowcaseProject(s);
  const apply = useAction();
  const [prompt, setPrompt] = useState("");
  const [pane, setPane] = useState<"app" | "library" | "history">("app");
  const [resetOpen, setResetOpen] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  useEffect(() => { if (mounted.current) end.current?.scrollIntoView({ block: "end", behavior: "smooth" }); else mounted.current = true; }, [s.messages, s.busy]);
  const submit = (e: FormEvent) => { e.preventDefault(); if (prompt.trim() && !s.busy) { void s.send(prompt); setPrompt(""); } };
  const light = p.theme.mode === "light";
  const text = light ? "text-slate-900" : "text-stone-100";
  const card = light ? "bg-white border-slate-200" : "bg-[#232323] border-stone-700";
  const soft = light ? "text-slate-500" : "text-stone-400";
  const button = `rounded-lg border px-3 py-1.5 text-sm transition hover:opacity-75 ${light ? "border-slate-300 bg-white" : "border-stone-700 bg-[#292929]"}`;
  return <div className={`flex h-dvh min-w-[850px] ${text} ${light ? "showcase-light" : ""}`} style={{ background: light ? "#f6f7f8" : "#181818", fontFamily: "Inter, ui-sans-serif, system-ui", ["--accent" as string]: accentColors[p.theme.accent] }}>
    <aside className={`flex w-[360px] shrink-0 flex-col border-r ${light ? "border-slate-200 bg-white" : "border-stone-800 bg-[#141414]"}`}>
      <header className={`flex items-center justify-between border-b px-5 py-4 ${light ? "border-slate-200" : "border-stone-800"}`}>
        <div><div className="text-lg font-semibold tracking-tight">Splice <span className="text-xs font-normal" style={{ color: "var(--accent)" }}>SHOWCASE</span></div><p className={`text-xs ${soft}`}>Describe your app. Use it immediately.</p></div>
        <button className={button} onClick={() => s.create()} title="New project"><FilePlus2 size={16} aria-hidden="true" /></button>
      </header>
      <div className={`border-b px-5 py-3 ${light ? "border-slate-200" : "border-stone-800"}`}>
        <label className={`block text-xs ${soft}`} htmlFor="showcase-project">Project</label>
        <select id="showcase-project" className={`mt-1 w-full rounded-lg border px-2 py-2 text-sm ${light ? "border-slate-200 bg-white" : "border-stone-700 bg-[#242424]"}`} value={p.id} onChange={e => s.open(e.target.value)}>{s.projects.map(x => <option value={x.id} key={x.id}>{x.title}</option>)}</select>
        <div className="mt-2 flex flex-wrap gap-2"><button className={button} onClick={() => s.duplicate()}>Duplicate</button><button className={button} onClick={() => setResetOpen(!resetOpen)}>Recipes</button><button className={button} onClick={() => setPane(pane === "library" ? "app" : "library")}>{pane === "library" ? "App" : "Library"}</button><button className={button} onClick={() => setPane(pane === "history" ? "app" : "history")}>{pane === "history" ? "App" : "History"}</button>{s.projects.length > 1 && <button className={button} onClick={() => { if (window.confirm(`Delete “${p.title}”? Export it first if you want to keep it.`)) s.remove(p.id); }}>Delete</button>}</div>
        {resetOpen && <div className="mt-2 flex flex-wrap gap-2">{recipes.map(r => <button key={r.id} className={button} onClick={() => { s.create(r.id); setResetOpen(false); setPane("app"); }}>{r.name}</button>)}<button className={button} onClick={() => { s.create("blank"); setResetOpen(false); }}>Blank</button></div>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" role="log" aria-label="Conversation" aria-live="polite">
        {s.messages.length === 0 && <div className={`mb-5 rounded-xl border p-4 ${card}`}><p className="font-medium">What would you like to build?</p><p className={`mt-2 text-sm ${soft}`}>Try one of these prompts or choose a recipe. Existing Obsidian and Calc engines supply the core note and table behavior.</p></div>}
        <div className="space-y-4">{s.messages.map((m,i) => <div key={m.id} className={`rounded-xl border p-3 text-sm leading-6 ${m.role === "user" ? light ? "border-blue-200 bg-blue-50" : "border-stone-600 bg-[#303030]" : card}`}><div className={`mb-1 text-xs font-semibold ${soft}`}>{m.role === "user" ? "You" : m.model ? `Splice · ${m.model}` : "Splice"}</div><p className="whitespace-pre-wrap">{m.text}</p>{m.actions && m.revision === p.revision && i === s.messages.length - 1 ? <button className="mt-2 text-xs underline" onClick={() => s.undo()}>Undo this change</button> : null}</div>)}</div>
        {s.busy && <p role="status" className={`mt-5 text-sm ${soft}`}>Understanding your request…</p>}
        <div ref={end} />
      </div>
      <div className={`border-t px-5 pb-5 pt-4 ${light ? "border-slate-200" : "border-stone-800"}`}>
        {s.error && <p role="alert" className="mb-3 rounded-lg bg-red-950/30 p-3 text-sm text-red-300">{s.error} <button className="underline" onClick={() => setPane("library")}>Use quick actions</button></p>}
        {!s.messages.some(m => m.role === "user") && <div className="mb-3 flex flex-wrap gap-2">{suggestions.map(x => <button key={x} className={`${button} text-xs`} onClick={() => setPrompt(x)}>{x}</button>)}</div>}
        <form onSubmit={submit} className={`rounded-xl border p-3 ${light ? "border-slate-300 bg-slate-50" : "border-stone-600 bg-[#222]"}`}>
          <label className="sr-only" htmlFor="showcase-chat">Describe a change</label><textarea id="showcase-chat" className="h-20 w-full resize-none bg-transparent text-sm outline-none" placeholder="Make me a trip planner with a budget…" value={prompt} maxLength={2000} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (prompt.trim()) submit(e); } }} />
          <div className="flex items-center justify-between"><span className={`text-xs ${soft}`}>Enter to send · Shift+Enter for newline</span>{s.busy ? <button type="button" className={button} onClick={() => s.cancel()}><Square size={14} /> Stop</button> : <button type="submit" disabled={!prompt.trim()} className={button} style={{ color: "var(--accent)" }}><Send size={15} /> Send</button>}</div>
        </form>
        <p className={`mt-3 text-xs ${soft}`}>Live chat uses local Codex. Direct editing and recipes work without it.</p>
      </div>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col" id="showcase-preview">
      <header className={`flex items-center justify-between border-b px-7 py-4 ${light ? "border-slate-200" : "border-stone-800"}`}>
        <div><h1 className="text-xl font-semibold">{p.title}</h1><p className={`text-xs ${soft}`}>{pane === "app" ? "Live app preview" : pane === "library" ? "Available building blocks" : "Recorded provenance and live local checks"} · {s.savedOk ? "Saved locally" : "Unsaved"}</p></div>
        <div className="flex items-center gap-2"><button className={button} aria-label="Toggle light theme" onClick={() => apply([action("theme.update", "", { mode: light ? "dark" : "light" })])}>{light ? "Dark" : "Light"}</button><select aria-label="Accent color" value={p.theme.accent} onChange={e => apply([action("theme.update", "", { accent: e.target.value })])} className={button}>{Object.keys(accentColors).map(color => <option key={color} value={color}>{color}</option>)}</select><button className={button} title="Undo" aria-label="Undo" onClick={() => s.undo()}><Undo2 size={16} /></button><button className={button} title="Redo" aria-label="Redo" onClick={() => s.redo()}><Redo2 size={16} /></button><button className={button} onClick={() => download(`${p.title.replace(/[^a-z0-9]+/gi,"-").toLowerCase()}.json`, JSON.stringify(p, null, 2))}><Download size={15} /> Export</button><button className={button} onClick={() => file.current?.click()}><Upload size={15} /> Import</button><input ref={file} className="hidden" type="file" accept="application/json,.json" onChange={async e => { const input = e.currentTarget; const selected = input.files?.[0]; if (!selected) return; try { s.importProject(await selected.text()); } catch (error) { alert(error instanceof Error ? error.message : "Could not import project"); } input.value = ""; }} /></div>
      </header>
      {s.storageError && <div role="alert" className="border-b border-amber-700 bg-amber-950/30 px-7 py-2 text-sm text-amber-300">{s.storageError} <button className="underline" onClick={() => s.retrySave()}>Retry save</button></div>}
      {pane === "history" ? <ShowcaseHistory card={card} button={button} soft={soft} /> : pane === "library" ? <Library p={p} apply={apply} card={card} button={button} soft={soft} open={() => setPane("app")} /> : <div className="min-h-0 flex-1 overflow-y-auto p-7">
        {p.sections.filter(x => x.visible).length === 0 && <div className={`mx-auto mt-12 max-w-2xl rounded-2xl border p-8 text-center ${card}`}><h2 className="text-2xl font-semibold">Your app starts here</h2><p className={`mt-3 ${soft}`}>Describe it in chat, select a recipe, or add a building block from the library.</p><div className="mt-5 flex justify-center gap-2">{recipes.map(r => <button key={r.id} className={button} onClick={() => s.create(r.id)}>{r.name}</button>)}</div></div>}
        <div className="grid grid-cols-2 gap-4">{p.sections.filter(x => x.visible).map((section, index) => <section key={section.id} onClick={() => s.selectSection(section.id)} className={`min-w-0 rounded-xl border ${card} ${section.width === "full" ? "col-span-2" : "col-span-1"} ${s.selectedSectionId === section.id ? "ring-2 ring-[var(--accent)]" : ""}`}>
          <div className={`flex items-center justify-between border-b px-4 py-3 ${light ? "border-slate-200" : "border-stone-700"}`}><h2 className="font-semibold">{section.title}</h2><div className="flex gap-1"><button title="Move up" aria-label={`Move ${section.title} up`} disabled={index === 0} className={button} onClick={e => { e.stopPropagation(); apply([action("section.move", section.id, { index: index - 1 })]); }}><ArrowUp size={13} /></button><button title="Move down" aria-label={`Move ${section.title} down`} disabled={index === p.sections.filter(x => x.visible).length - 1} className={button} onClick={e => { e.stopPropagation(); apply([action("section.move", section.id, { index: index + 1 })]); }}><ArrowDown size={13} /></button><button title="Toggle width" className={button} onClick={e => { e.stopPropagation(); apply([action("section.update", section.id, { width: section.width === "full" ? "half" : "full" })]); }}>{section.width === "full" ? "½" : "↔"}</button></div></div>
          <div className={p.theme.density === "compact" ? "p-3" : "p-5"}>{section.kind === "notes" ? <NotesPanel p={p} apply={apply} button={button} soft={soft} light={light} /> : section.kind === "table" ? <TablePanel p={p} id={section.ref} apply={apply} button={button} soft={soft} light={light} /> : section.kind === "tasks" ? <TasksPanel p={p} apply={apply} button={button} soft={soft} /> : section.kind === "metric" ? <MetricPanel p={p} section={section} apply={apply} soft={soft} light={light} /> : <ChartPanel p={p} id={section.ref} soft={soft} />}</div>
        </section>)}</div>
      </div>}
      <footer className={`flex items-center justify-between border-t px-7 py-2 text-xs ${soft} ${light ? "border-slate-200" : "border-stone-800"}`}><span>Recovered: Obsidian notes · LibreOffice Calc tables. Authored in Splice: chat, tasks, charts, themes.</span><span>{p.capabilities.length} capabilities · revision {p.revision}</span></footer>
    </main>
  </div>;
}

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
    if (id === "charts" && p.tables[0]) steps.push(action("section.add", "", { kind: "chart", title: "Chart", ref: p.tables[0].id }));
    if (id === "calc" && !p.tables.length) steps.push(action("table.create", "", { title: "New table", grid: [["Item", "Qty", "Unit cost", "Total"], ["Example", 1, 10, "=B2*C2"]] }));
    apply(steps); open();
  };
  return <div className="min-h-0 flex-1 overflow-y-auto p-7"><div className="flex items-center justify-between"><div><h2 className="text-2xl font-semibold">Building blocks</h2><p className={`mb-6 mt-2 text-sm ${soft}`}>Available now. The recovered engines remain unchanged.</p></div><div className="flex gap-2"><button className={button} onClick={() => markdownFile.current?.click()}>Import Markdown</button><button className={button} onClick={() => csvFile.current?.click()}>Import CSV table</button><input ref={markdownFile} className="hidden" type="file" accept=".md,text/markdown,text/plain" onChange={async e => { const input = e.currentTarget; const file = input.files?.[0]; if (!file) return; try { if (file.size > 100_000) throw new Error("Markdown file exceeds 100 KB"); const body = await file.text(); const base = file.name.replace(/\.md$/i, "") || "Imported note"; const title = p.notes.some(n => n.title === base) ? `${base} ${Date.now()}` : base; apply([action("note.create", "", { title, body })]); open(); } catch (error) { alert(error instanceof Error ? error.message : "Could not import Markdown"); } input.value = ""; }} /><input ref={csvFile} className="hidden" type="file" accept=".csv,text/csv" onChange={async e => { const input = e.currentTarget; const file = input.files?.[0]; if (!file) return; try { const rows = parseCsv(await file.text()); const base = file.name.replace(/\.csv$/i, "") || "Imported table"; const title = p.tables.some(t => t.title === base) ? `${base} ${Date.now()}` : base; apply([action("table.create", "", { title, grid: rows })]); open(); } catch (error) { alert(error instanceof Error ? error.message : "Could not import CSV"); } input.value = ""; }} /></div></div><div className="grid grid-cols-2 gap-4">{entries.map(x => <div key={x.id} className={`rounded-xl border p-5 ${card}`}><div className="flex items-start justify-between gap-2"><h3 className="font-semibold">{x.name}</h3><span className="text-xs" style={{ color: "var(--accent)" }}>{p.capabilities.includes(x.id) ? "Added" : "Available"}</span></div><p className={`mt-1 text-xs ${soft}`}>{x.source}</p><p className="my-4 text-sm">{x.detail}</p><button className={button} onClick={() => add(x.id)}>{p.capabilities.includes(x.id) ? "Open app" : "Add to app"}</button>{p.capabilities.includes(x.id) && <button className="ml-3 text-xs underline opacity-60" onClick={() => apply([action("capability.disable", x.id)])}>Remove</button>}</div>)}</div></div>;
}

function NotesPanel({ p, apply, button, soft, light }: { p: ShowcaseProject; apply: ReturnType<typeof useAction>; button: string; soft: string; light: boolean }) {
  const [selected, setSelected] = useState<string | null>(null), [search, setSearch] = useState(""), [tag, setTag] = useState(""), [editing, setEditing] = useState(false);
  const note = p.notes.find(n => n.id === selected) ?? p.notes[0];
  const tags = [...new Set(p.notes.flatMap(n => n.tags))];
  const visible = p.notes.filter(n => (!search || `${n.title} ${n.body}`.toLowerCase().includes(search.toLowerCase())) && (!tag || n.tags.includes(tag)));
  const follow = (e: React.MouseEvent) => { const el = (e.target as HTMLElement).closest("a"); if (!el) return; e.preventDefault(); if (el.classList.contains("internal-link")) { const title = el.getAttribute("data-href") || el.textContent || ""; const target = p.notes.find(n => n.title.toLowerCase() === title.toLowerCase()); if (target) { setSelected(target.id); setEditing(false); } } else { const href = el.getAttribute("href"); if (href && /^https?:\/\//.test(href)) window.open(href, "_blank", "noopener,noreferrer"); } };
  return <div className="grid min-h-64 grid-cols-[170px_1fr] gap-4"><div className={`border-r pr-3 ${light ? "border-slate-200" : "border-stone-700"}`}><button className={`${button} mb-3 w-full`} onClick={() => apply([action("note.create", "", { title: `New note ${p.notes.length + 1}` })])}><Plus size={13} /> New note</button>{p.capabilities.includes("search") && <input aria-label="Search notes" className={`mb-2 w-full rounded border px-2 py-1 text-xs ${light ? "bg-white" : "bg-[#282828] border-stone-700"}`} placeholder="Search notes" value={search} onChange={e => setSearch(e.target.value)} />}{p.capabilities.includes("tags") && tags.length > 0 && <select aria-label="Filter tags" value={tag} onChange={e => setTag(e.target.value)} className={`mb-2 w-full rounded border px-2 py-1 text-xs ${light ? "bg-white" : "bg-[#282828] border-stone-700"}`}><option value="">All tags</option>{tags.map(t => <option key={t}>{t}</option>)}</select>}{visible.map(n => <button key={n.id} className={`mb-1 block w-full truncate rounded px-2 py-1 text-left text-sm ${note?.id === n.id ? light ? "bg-blue-50" : "bg-stone-700" : ""}`} onClick={() => { setSelected(n.id); setEditing(false); }}>{n.title}</button>)}{visible.length === 0 && <p className={`text-xs ${soft}`}>No notes found.</p>}</div><div className="min-w-0">{!note ? <p className={soft}>Create your first note.</p> : <><div className="mb-3 flex items-center justify-between gap-2"><h3 className="truncate font-semibold">{note.title}</h3><div className="flex gap-1"><button className={button} onClick={() => setEditing(!editing)}>{editing ? "Preview" : "Edit"}</button><button className={button} onClick={() => apply([action("note.duplicate", note.id, {})])}>Duplicate</button><button className={button} onClick={() => apply([action("note.delete", note.id, {})])}>Delete</button><button className={button} onClick={() => download(`${note.title}.md`, note.body, "text/markdown")}>↓</button></div></div>{editing ? <NoteEditor key={note.id} note={note} apply={apply} light={light} /> : <div className="obsidian-preview max-h-[480px] overflow-y-auto text-sm" onClick={follow} dangerouslySetInnerHTML={{ __html: safeHtml(note.body) }} />}</>}</div></div>;
}
function NoteEditor({ note, apply, light }: { note: ShowcaseProject["notes"][number]; apply: ReturnType<typeof useAction>; light: boolean }) {
  const [title, setTitle] = useState(note.title), [body, setBody] = useState(note.body), [tags, setTags] = useState(note.tags.join(", "));
  useEffect(() => { setTitle(note.title); setBody(note.body); setTags(note.tags.join(", ")); }, [note.id, note.title, note.body, note.tags]);
  const field = `w-full rounded-lg border p-2 text-sm ${light ? "border-slate-200 bg-white" : "border-stone-700 bg-[#181818]"}`;
  const save = () => { if (title !== note.title || body !== note.body || tags !== note.tags.join(", ")) apply([action("note.update", note.id, { title, body, tags: tags.split(",").map(t => t.trim()).filter(Boolean) })]); };
  return <div className="space-y-2"><input aria-label="Note title" className={field} value={title} onChange={e => setTitle(e.target.value)} onBlur={save} /><textarea aria-label="Note Markdown" rows={10} className={field} value={body} onChange={e => setBody(e.target.value)} onBlur={save} /><input aria-label="Note tags" placeholder="Tags, comma separated" className={field} value={tags} onChange={e => setTags(e.target.value)} onBlur={save} /></div>;
}

function TablePanel({ p, id, apply, button, soft, light }: { p: ShowcaseProject; id: string; apply: ReturnType<typeof useAction>; button: string; soft: string; light: boolean }) {
  const table = p.tables.find(t => t.id === id); if (!table) return null;
  const values = tableValues(p, id), formulas = hasFormulas(table.grid);
  return <div className="overflow-x-auto"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><span className={`text-xs ${soft}`}>Live LibreOffice Calc engine · edit cells directly</span><div className="flex gap-2"><button className={button} onClick={() => download(`${table.title}.csv`, tableCsv(p, id), "text/csv")}>CSV</button><button className={button} title="Add row" onClick={() => apply([action("table.addRow", id, {})])}><Plus size={13} /> Row</button>{!formulas && <button className={button} onClick={() => apply([action("table.addColumn", id, { title: "New column" })])}><Plus size={13} /> Column</button>}</div></div><table className="w-full border-collapse text-sm"><thead><tr>{table.grid[0].map((head, col) => <th key={col} className={`border-b p-2 text-left ${light ? "border-slate-200" : "border-stone-700"}`}><CellInput value={head} label={cellLabel(0,col)} onSave={value => apply([action("table.cell", id, { row: 0, col, value })])} light={light} />{!formulas && <span className="ml-1"><button title={`Sort ${head} ascending`} onClick={() => apply([action("table.sort", id, { column: col, ascending: true })])}>↑</button><button title={`Sort ${head} descending`} onClick={() => apply([action("table.sort", id, { column: col, ascending: false })])}>↓</button></span>}</th>)}</tr></thead><tbody>{table.grid.slice(1).map((row, r) => <tr key={r}>{row.map((raw, c) => <td key={c} className={`border-b p-1 ${light ? "border-slate-100" : "border-stone-800"}`}><CellInput value={raw} label={cellLabel(r+1,c)} computed={typeof raw === "string" && raw.startsWith("=") ? values[r+1]?.[c] : undefined} onSave={value => apply([action("table.cell", id, { row: r+1, col: c, value })])} light={light} /></td>)}</tr>)}</tbody></table></div>;
}
function CellInput({ value, label, computed, onSave, light }: { value: string | number; label: string; computed?: string | number; onSave: (value: string | number) => void; light: boolean }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => { const next = /^-?\d+(?:\.\d+)?$/.test(draft.trim()) ? Number(draft.trim()) : draft; if (next !== value) onSave(next); };
  return <div><input aria-label={`Cell ${label}`} className={`min-w-20 w-full rounded px-2 py-1 outline-none focus:ring-1 focus:ring-[var(--accent)] ${light ? "bg-slate-50" : "bg-[#191919]"}`} value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />{computed !== undefined && <div className="px-2 text-xs" style={{ color: "var(--accent)" }}>= {String(computed)}</div>}</div>;
}
function TasksPanel({ p, apply, button, soft }: { p: ShowcaseProject; apply: ReturnType<typeof useAction>; button: string; soft: string }) {
  const [title, setTitle] = useState("");
  const [filter, setFilter] = useState<"all" | "open" | "done">("all");
  const tasks = p.tasks.filter(t => filter === "all" || t.done === (filter === "done"));
  return <div>
    <form className="mb-3 flex gap-2" onSubmit={e => { e.preventDefault(); if (title.trim()) { apply([action("task.create", "", { title })]); setTitle(""); } }}><input aria-label="New task" placeholder="Add a task" className="min-w-0 flex-1 rounded border border-stone-600 bg-transparent px-2 py-1 text-sm" value={title} onChange={e => setTitle(e.target.value)} /><button className={button} type="submit"><Plus size={14} /></button></form>
    <div className="mb-2 flex gap-2">{(["all", "open", "done"] as const).map(value => <button key={value} className={`text-xs ${filter === value ? "underline" : soft}`} onClick={() => setFilter(value)}>{value}</button>)}</div>
    {tasks.length === 0 && <p className={`text-sm ${soft}`}>No {filter === "all" ? "" : `${filter} `}tasks.</p>}
    {tasks.map(t => <label key={t.id} className="flex items-center gap-2 py-1.5 text-sm"><input type="checkbox" checked={t.done} onChange={e => apply([action("task.update", t.id, { done: e.target.checked })])} /><span className={t.done ? "line-through opacity-50" : ""}>{t.title}</span>{t.due && <small className={`ml-auto ${soft}`}>{t.due}</small>}<button className="ml-auto text-xs opacity-60 hover:opacity-100" aria-label={`Delete ${t.title}`} onClick={e => { e.preventDefault(); apply([action("task.delete", t.id, {})]); }}>×</button></label>)}
  </div>;
}
function MetricPanel({ p, section, apply, soft, light }: { p: ShowcaseProject; section: ShowcaseProject["sections"][number]; apply: ReturnType<typeof useAction>; soft: string; light: boolean }) {
  const done = p.tasks.filter(t => t.done).length;
  const value = section.ref === "tasks" ? `${done} / ${p.tasks.length}` : `$${(section.ref === "all" ? projectTotal(p) : tableTotal(p, section.ref)).toFixed(2)}`;
  return <div><div className="text-4xl font-semibold" style={{ color: "var(--accent)" }}>{value}</div><p className={`mt-2 text-sm ${soft}`}>{section.ref === "tasks" ? "Tasks complete" : section.ref === "all" ? "Across all tables" : p.tables.find(t => t.id === section.ref)?.title}</p><select aria-label={`Source for ${section.title}`} value={section.ref} onChange={e => apply([action("section.update", section.id, { ref: e.target.value })])} className={`mt-3 rounded border px-2 py-1 text-xs ${light ? "border-slate-200 bg-white" : "border-stone-700 bg-[#282828]"}`}><option value="all">All tables</option><option value="tasks">Tasks completed</option>{p.tables.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></div>;
}
function ChartPanel({ p, id, soft }: { p: ShowcaseProject; id: string; soft: string }) {
  const table = p.tables.find(t => t.id === id); if (!table) return null;
  const rows = tableValues(p, id).slice(1).filter(row => !/total/i.test(String(row[0]))).map(row => ({ label: String(row[0]), value: [...row].reverse().find(x => typeof x === "number") as number | undefined })).filter(row => typeof row.value === "number");
  const max = Math.max(1, ...rows.map(r => Math.abs(r.value!)));
  return <div className="space-y-2">{rows.map((r,i) => <div key={`${r.label}-${i}`} className="grid grid-cols-[100px_1fr_70px] items-center gap-2 text-xs"><span className="truncate">{r.label}</span><div className="h-4 rounded bg-stone-700/30"><div className="h-4 rounded" style={{ width: `${Math.max(2,Math.abs(r.value!)/max*100)}%`, background: "var(--accent)" }} /></div><span className="text-right tabular-nums">{r.value}</span></div>)}{rows.length === 0 && <p className={soft}>Add numeric table rows to see a chart.</p>}</div>;
}
