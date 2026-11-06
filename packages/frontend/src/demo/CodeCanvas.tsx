import { useEffect, useRef, useState } from "react";
import type { ShowcaseCodeRevision, ShowcasePreviewBridge } from "@splice/contracts";
import { projectTotal, tableTotal, tableValues, type ShowcaseAction, type ShowcaseProject } from "./showcaseModel";
import { activeShowcaseProject, useShowcase } from "./showcaseStore";

type Bridge = ShowcasePreviewBridge<ShowcaseProject, ShowcaseAction>;
declare global { interface Window { __spliceShowcaseBridge?: Bridge } }

export function CodeCanvas({ projectId, revision, light }: { projectId: string; revision: string | null; light: boolean }) {
  const selected = useShowcase(state => state.selectedSectionId);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [frameHeight, setFrameHeight] = useState(420);
  const [source, setSource] = useState<ShowcaseCodeRevision | null>(null);
  useEffect(() => {
    setSrc(""); setError(""); setReady(false); setSource(null); setFrameHeight(420);
    if (!revision) { delete window.__spliceShowcaseBridge; return; }
    const current = () => { const state = useShowcase.getState(); return state.activeId === projectId && state.codeVersions[projectId]?.current === revision; };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bridge: Bridge = {
      revision,
      getProject: () => activeShowcaseProject(useShowcase.getState()),
      subscribe: listener => useShowcase.subscribe(state => { if (current()) listener(activeShowcaseProject(state)); }),
      apply: actions => { if (current()) useShowcase.getState().apply(actions); },
      select: id => { if (current()) useShowcase.getState().selectSection(id); },
      tableValues: tableId => current() ? tableValues(activeShowcaseProject(useShowcase.getState()), tableId) : [],
      total: tableId => { const p = activeShowcaseProject(useShowcase.getState()); return current() ? tableId ? tableTotal(p, tableId) : projectTotal(p) : 0; },
      reportReady: () => { if (current()) { setReady(true); if (timer) clearTimeout(timer); } },
      reportError: message => { if (current()) setError(message); },
    };
    window.__spliceShowcaseBridge = bridge;
    setSrc(`/api/showcase/code/revisions/${revision}/index.html`);
    timer = setTimeout(() => { if (current()) setError(previous => previous || "The feature preview did not start. Restore the previous code version."); }, 10_000);
    return () => { clearTimeout(timer); if (window.__spliceShowcaseBridge === bridge) delete window.__spliceShowcaseBridge; };
  }, [projectId, revision]);
  useEffect(() => {
    if (!ready || !src) return;
    let root: HTMLElement | null;
    try { root = frameRef.current?.contentDocument?.getElementById("root") ?? null; }
    catch { return; }
    if (!root) return;
    const measure = () => {
      const top = root!.getBoundingClientRect().top;
      const bottom = Math.max(0, ...[...root!.children].map(child => child.getBoundingClientRect().bottom - top));
      if (bottom > 0) {
        const height = Math.max(180, Math.min(900, Math.ceil(bottom)));
        setFrameHeight(current => current === height ? current : height);
      }
    };
    measure();
    const timer = setInterval(measure, 400);
    return () => clearInterval(timer);
  }, [ready, src]);
  if (!revision) return null;
  return <section className={`mb-5 overflow-hidden rounded-xl border ${light ? "border-slate-200 bg-white" : "border-stone-700 bg-[#232323]"} ${selected === `code:${revision}` ? "ring-2 ring-[var(--accent)]" : ""}`}>
    <div className={`flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-sm ${light ? "border-slate-200" : "border-stone-700"}`}><span>Splice-built feature {ready ? "· live" : "· loading"}</span><div className="flex flex-wrap gap-x-3 gap-y-1"><button className="underline" onClick={() => useShowcase.getState().selectSection(`code:${revision}`)}>Select feature</button><button className="underline" onClick={async () => { try { if (source) { setSource(null); return; } const response = await fetch(`/api/showcase/code/revisions/${revision}/source`); if (!response.ok) throw new Error("Source unavailable"); setSource(await response.json()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }}>Compare code</button><button className="underline" onClick={() => useShowcase.getState().revertCode()}>Revert code change</button></div></div>
    {error && <div role="alert" className={`px-4 py-3 text-sm ${light ? "bg-red-50 text-red-800" : "bg-red-950/30 text-red-300"}`}>{error} <button className="underline" onClick={() => useShowcase.getState().revertCode()}>Restore last working version</button></div>}
    {src && <iframe ref={frameRef} key={revision} title="Splice feature preview" src={src} style={{ height: frameHeight }} className={`w-full border-0 ${light ? "bg-white" : "bg-[#181818]"}`} />}
    {source && <div className={`border-t p-4 text-xs ${light ? "border-slate-200" : "border-stone-700"}`}><p className="mb-3">Changed files: {source.files.join(", ")}</p>{source.files.map(name => { const key = name.replace(/^deleted /, ""); return <div key={name} className="mb-4"><strong>{name}</strong><div className="mt-1 grid grid-cols-1 gap-2 md:grid-cols-2"><div className="min-w-0"><span>Before</span><pre className={`max-h-64 overflow-auto whitespace-pre-wrap break-all rounded p-3 ${light ? "bg-slate-100" : "bg-black/30"}`}>{source.parentSource[key] ?? "(new file)"}</pre></div><div className="min-w-0"><span>After</span><pre className={`max-h-64 overflow-auto whitespace-pre-wrap break-all rounded p-3 ${light ? "bg-slate-100" : "bg-black/30"}`}>{source.source[key] ?? "(deleted)"}</pre></div></div></div>; })}</div>}
  </section>;
}
