import { useEffect, useState } from "react";
import type { ShowcaseCodeRevision, ShowcasePreviewBridge } from "@splice/contracts";
import { projectTotal, tableTotal, tableValues, type ShowcaseAction, type ShowcaseProject } from "./showcaseModel";
import { activeShowcaseProject, useShowcase } from "./showcaseStore";

type Bridge = ShowcasePreviewBridge<ShowcaseProject, ShowcaseAction>;
declare global { interface Window { __spliceShowcaseBridge?: Bridge } }

export function CodeCanvas({ projectId, revision }: { projectId: string; revision: string | null }) {
  const selected = useShowcase(state => state.selectedSectionId);
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [source, setSource] = useState<ShowcaseCodeRevision | null>(null);
  useEffect(() => {
    setSrc(""); setError(""); setReady(false); setSource(null);
    if (!revision) { delete window.__spliceShowcaseBridge; return; }
    const current = () => { const state = useShowcase.getState(); return state.activeId === projectId && state.codeVersions[projectId]?.current === revision; };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bridge: Bridge = {
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
  if (!revision) return null;
  return <section className={`mb-5 overflow-hidden rounded-xl border border-stone-700 bg-[#232323] ${selected === `code:${revision}` ? "ring-2 ring-[var(--accent)]" : ""}`}>
    <div className="flex items-center justify-between border-b border-stone-700 px-4 py-2 text-sm"><span>Splice-built feature {ready ? "· live" : "· loading"}</span><div className="flex gap-3"><button className="underline" onClick={() => useShowcase.getState().selectSection(`code:${revision}`)}>Select feature</button><button className="underline" onClick={async () => { try { if (source) { setSource(null); return; } const response = await fetch(`/api/showcase/code/revisions/${revision}/source`); if (!response.ok) throw new Error("Source unavailable"); setSource(await response.json()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }}>Compare code</button><button className="underline" onClick={() => useShowcase.getState().revertCode()}>Revert code change</button></div></div>
    {error && <div role="alert" className="bg-red-950/30 px-4 py-3 text-sm text-red-300">{error} <button className="underline" onClick={() => useShowcase.getState().revertCode()}>Restore last working version</button></div>}
    {src && <iframe key={revision} title="Splice feature preview" src={src} className="h-[420px] w-full border-0 bg-transparent" />}
    {source && <div className="border-t border-stone-700 p-4 text-xs"><p className="mb-3">Changed files: {source.files.join(", ")}</p>{source.files.map(name => { const key = name.replace(/^deleted /, ""); return <div key={name} className="mb-4"><strong>{name}</strong><div className="mt-1 grid grid-cols-2 gap-2"><div><span>Before</span><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-3">{source.parentSource[key] ?? "(new file)"}</pre></div><div><span>After</span><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-3">{source.source[key] ?? "(deleted)"}</pre></div></div></div>; })}</div>}
  </section>;
}
