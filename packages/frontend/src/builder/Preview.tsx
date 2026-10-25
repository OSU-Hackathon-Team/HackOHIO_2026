import { useState } from "react";
import { BookOpen, ArrowUpRight, Check, Plus } from "lucide-react";
import type { BuilderBlock } from "@splice/contracts";
import { parseLinks } from "../../../../fixtures/engines/_seed/wikiLinks";
import { useBuilder } from "./useBuilder";
import { activeProject } from "./store";
import { Action, Field } from "./ui";
export function SectionContent({ block, interactive }: { block: BuilderBlock; interactive: boolean }) {
  const state = useBuilder(s => s), project = activeProject(state)!;
  const [title,setTitle] = useState(""), [body,setBody] = useState(""), [error,setError] = useState("");
  if (block.kind === "text") return <div className="py-3"><h3 className="text-balance text-2xl font-semibold text-slate-900">{block.title}</h3>{block.description && <p className="mt-3 text-pretty text-sm leading-6 text-slate-500">{block.description}</p>}</div>;
  return <><div className="mb-5"><h3 className="text-balance text-lg font-semibold text-slate-900">{block.title}</h3>{block.description && <p className="mt-1 text-pretty text-sm text-slate-500">{block.description}</p>}</div>
    {block.kind === "notes" && <div>
      <form className="mb-5 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4" onSubmit={event => { event.preventDefault(); if (!interactive) return; if (!title.trim()) { setError("Give your note a title."); return; } if (project.notes.some(n => n.title.toLowerCase() === title.trim().toLowerCase())) { setError("Choose a different title; that note already exists."); return; } state.addNote(title,body); setTitle(""); setBody(""); setError(""); }}>
        <fieldset disabled={!interactive} className="grid gap-3"><Field label="Note title" value={title} onChange={setTitle} maxLength={100} placeholder="A new idea…" /><Field label="Note text" value={body} onChange={setBody} multiline placeholder="Connect ideas with [[Cardiology]]" /><Action type="submit" isDisabled={!interactive} className="justify-self-start"><Plus size={15} aria-hidden="true" />Add note</Action></fieldset>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      </form>
      <ul className="grid gap-3 sm:grid-cols-2">{project.notes.map(note => <li key={note.id} className="rounded-xl border border-slate-200 p-4"><h4 className="flex items-center gap-2 text-sm font-semibold"><BookOpen size={14} className="shrink-0 text-blue-600" aria-hidden="true" />{note.title}</h4><p className="mt-2 text-pretty text-sm leading-6 text-slate-500">{note.body}</p>{!!parseLinks(note.body).length && <div className="mt-3 flex flex-wrap gap-1">{parseLinks(note.body).map((link,i) => <span key={i} className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700">{link}</span>)}</div>}</li>)}</ul>
    </div>}
    {block.kind === "backlinks" && <ul className="divide-y divide-slate-100">{project.notes.map(note => {
      const backlinks = project.notes.filter(other => other.id !== note.id && parseLinks(other.body).some(t => t.toLowerCase().replace(/\s+/g," ").trim() === note.title.toLowerCase().replace(/\s+/g," ").trim()));
      return <li key={note.id} className="py-3"><p className="flex items-center gap-2 text-sm font-medium"><ArrowUpRight size={14} className="text-blue-600" aria-hidden="true" />{note.title}</p><p className="mt-1 pl-5 text-pretty text-xs leading-5 text-slate-500">{backlinks.length ? backlinks.map(n => n.title).join(" · ") : "No notes link here yet"}</p></li>;
    })}</ul>}
    {block.kind === "reviews" && <ul className="divide-y divide-slate-100">{project.notes.map(note => <li key={note.id} className="py-4"><p className="text-sm font-semibold">{note.title}</p><p className="mt-1 text-pretty text-xs leading-5 text-slate-500">{project.reviews[note.id] ? `Next review: ${project.reviews[note.id].dueDate} · ${project.reviews[note.id].intervalDays} days` : "Ready for your first review"}</p><Action className="mt-3 min-h-11 text-xs" isDisabled={!interactive} aria-label={`Review ${note.title}, grade 4`} onPress={() => state.reviewNote(note.id,4)}><Check size={14} aria-hidden="true" />I remembered it · grade 4</Action></li>)}</ul>}
  </>;
}

