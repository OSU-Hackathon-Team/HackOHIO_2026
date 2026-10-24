import { useState } from "react";
import { DialogTrigger, ModalOverlay, Modal, Dialog, Heading, DropZone, FileTrigger } from "react-aria-components";
import { ArrowRight, FileUp, Layers3, BookOpen, Trash2, Plus } from "lucide-react";
import { useBuilder } from "./useBuilder";
import { Action, Field, modalOverlay, modalPanel } from "./ui";

export function Home() {
  const { projects, create, open, deleteProject, storageError } = useBuilder(s => s);
  const [goal, setGoal] = useState(""), [sources, setSources] = useState<{ name: string; size: number }[]>([]), [error, setError] = useState("");
  function attach(files: File[]) {
    if (files.length > 20) { setError("Choose up to 20 application files."); return; }
    setSources(files.map(f => ({ name: f.name, size: f.size }))); setError("");
  }
  return <div className="min-h-dvh bg-slate-50">
    <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4 md:px-10"><Brand /><span className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-500">Local-first prototype</span></header>
    <main className="mx-auto max-w-5xl px-5 py-12 md:py-16">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-blue-700"><span className="size-1.5 rounded-full bg-blue-600" />A different starting point</div>
      <h1 className="max-w-3xl text-balance text-4xl font-semibold leading-tight text-slate-900 md:text-5xl">Build from the features<br className="hidden sm:block" /> you already love.</h1>
      <p className="mt-5 max-w-xl text-pretty text-base leading-7 text-slate-500">Explore an application, choose what matters, and make something of your own. No code required.</p>
      {storageError && <p role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{storageError}</p>}
      <div className="mt-9 grid gap-5 md:grid-cols-[1fr_280px]">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-balance text-lg font-semibold">What would you like to reuse?</h2>
          <DropZone aria-label="Application files" onDrop={async event => { const files = await Promise.all(event.items.filter(item => item.kind === "file").map(item => item.kind === "file" ? item.getFile() : Promise.reject())); if (files.length) attach(files); }} className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center outline-none data-[drop-target]:border-blue-600 data-[drop-target]:bg-blue-50">
            <FileUp className="mx-auto size-6 text-slate-400" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium text-slate-700">{sources.length ? `${sources.length} file${sources.length === 1 ? "" : "s"} attached` : "Drop your application here"}</p>
            <p className="mt-1 text-pretty text-xs leading-5 text-slate-500">Only names and sizes are saved. Files are not uploaded or analyzed in this prototype.</p>
            <FileTrigger allowsMultiple onSelect={files => files && attach(Array.from(files))}><Action tone="quiet" className="mt-2 text-blue-700">Choose application files</Action></FileTrigger>
            {sources.map((f,i) => <p key={i} className="mt-1 truncate text-xs text-slate-600">{f.name} <span className="tabular-nums text-slate-400">· {(f.size / 1024).toFixed(1)} KB</span></p>)}
          </DropZone>
          <div className="mt-5"><Field label="Describe what you want to find" value={goal} onChange={setGoal} multiline placeholder="I want the way this app connects notes and helps me remember what I learn…" /></div>
          {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
          <Action tone="primary" className="mt-5 w-full" isDisabled={!sources.length || !goal.trim()} onPress={() => create(goal,sources,false)}>Create project <ArrowRight size={16} aria-hidden="true" /></Action>
          <p className="mt-3 text-pretty text-xs leading-5 text-slate-500">Native analysis is not connected yet. You can attach files for a future connection or explore our sample.</p>
        </section>
        <section className="flex flex-col justify-between rounded-2xl border border-blue-100 bg-blue-50 p-6">
          <div><BookOpen className="size-6 text-blue-600" aria-hidden="true" /><p className="mt-7 text-xs font-medium text-blue-700">TRY A WORKING EXAMPLE</p><h2 className="mt-2 text-balance text-2xl font-semibold text-slate-900">A place to learn.<br />Built your way.</h2><p className="mt-4 text-pretty text-sm leading-6 text-slate-600">Combine linked notes and spaced repetition into your own study space.</p><p className="mt-3 text-xs leading-5 text-slate-500">Authored sample findings and locally checked engines. Not a recording of real extraction.</p></div>
          <Action className="mt-8 justify-between" onPress={() => create("Build a study space from linked notes and spaced repetition.",[],true)}>Try the study app <ArrowRight size={16} aria-hidden="true" /></Action>
        </section>
      </div>
      {!!projects.length && <section className="mt-12"><div className="mb-4 flex items-center justify-between"><h2 className="text-balance text-lg font-semibold">Pick up where you left off</h2><span className="text-xs text-slate-500">Saved on this device</span></div>
        <ul className="grid gap-3 sm:grid-cols-2">{projects.map(project => <li key={project.id} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
          <Action tone="quiet" className="min-w-0 flex-1 justify-start p-2 text-left" onPress={() => open(project.id)}><span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-slate-100"><Layers3 size={18} aria-hidden="true" /></span><span className="min-w-0"><span className="block truncate font-semibold">{project.title}</span><span className="block text-xs font-normal text-slate-500">{project.featureIds.length} features · {project.layout.length} sections</span></span></Action>
          <DialogTrigger><Action tone="quiet" aria-label={`Delete ${project.title}`}><Trash2 size={16} aria-hidden="true" /></Action><ModalOverlay className={modalOverlay}><Modal className={modalPanel}><Dialog role="alertdialog" className="outline-none">{({ close }) => <><Heading slot="title" className="text-lg font-semibold">Delete this local project?</Heading><p className="mt-3 text-pretty text-sm text-slate-600">Its layout, notes, and conversation will be removed from this device. This cannot be undone.</p><div className="mt-6 flex justify-end gap-2"><Action autoFocus onPress={close}>Keep project</Action><Action tone="danger" onPress={() => { deleteProject(project.id); close(); }}>Delete project</Action></div></>}</Dialog></Modal></ModalOverlay></DialogTrigger>
        </li>)}</ul>
      </section>}
      <footer className="mt-10 border-t border-slate-200 pt-5 text-xs leading-5 text-slate-400">Your files stay yours. Sample analysis is always labeled. AI edits never change the feature engines.</footer>
    </main>
  </div>;
}
export function Brand() { return <span className="inline-flex items-center gap-2.5 text-lg font-semibold text-slate-900"><span className="flex size-8 items-center justify-center rounded-lg bg-blue-600 text-white"><Layers3 size={18} aria-hidden="true" /></span>splice<span className="ml-1 text-xs font-normal text-slate-400">studio</span></span>; }

