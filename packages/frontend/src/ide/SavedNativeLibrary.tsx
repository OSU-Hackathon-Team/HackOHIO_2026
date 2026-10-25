import { useEffect, useState } from "react";
import { Disclosure, DisclosurePanel, Heading, Dialog, Modal, ModalOverlay } from "react-aria-components";
import { Database, ChevronRight, X } from "lucide-react";
import type { NativeLibrary, SavedAnalysis, SavedBlock, NativeExtraction } from "@splice/contracts";
import { api } from "../api/client";
import { WorkspaceButton } from "./WorkspaceButton";
import { useIdeStore } from "./store/useIdeStore";
import type { SavedLibrarySelection } from "./SavedBuildingBlocksWorkspace";

export function SavedNativeLibrary({ revision, features, onFeatures, onOpen }: {
  revision: number; features: NativeExtraction[]; onFeatures: (features: NativeExtraction[]) => void;
  onOpen: (selection: SavedLibrarySelection) => void;
}) {
  const finishedRun = useIdeStore(s => s.decompRun?.finished ? s.decompRun.runId : null);
  const [catalog, setCatalog] = useState<NativeLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [featureError, setFeatureError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<SavedAnalysis | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError(null); setFeatureError(null);
    api.library?.(controller.signal).then(value => { if (!controller.signal.aborted) setCatalog(value); }).catch(e => {
      if (!controller.signal.aborted) setError(e.message);
    });
    api.libraryFeatures?.(controller.signal).then(value => { if (!controller.signal.aborted) onFeatures(value); }).catch(e => {
      if (!controller.signal.aborted) setFeatureError(e.message);
    });
    return () => controller.abort();
  }, [refresh, finishedRun, revision, onFeatures]);
  useEffect(() => {
    if (!selection) return;
    const controller = new AbortController();
    setAnalysis(null); setDetailError(null);
    api.savedAnalysis?.(selection, controller.signal).then(value => {
      if (!controller.signal.aborted) setAnalysis(value);
    }).catch(e => { if (!controller.signal.aborted) setDetailError(e.message); });
    return () => controller.abort();
  }, [selection]);
  if (!api.library) return null;
  return <section aria-label="Saved native library" className="mb-6 border-b border-stone-800 pb-5">
    <div className="flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-balance text-sm font-semibold"><Database className="size-4 text-amber-400" aria-hidden="true" />Saved library</h2>
      <WorkspaceButton onPress={() => setRefresh(n => n + 1)} className="text-xs">Refresh</WorkspaceButton>
    </div>
    {featureError && <p role="alert" className="mt-2 text-pretty text-xs text-red-300">Saved building blocks unavailable: {featureError}</p>}
    {error ? <p role="alert" className="mt-2 text-pretty text-xs text-red-300">{error}</p>
      : !catalog ? <p role="status" className="mt-2 text-xs text-stone-400">Loading saved results…</p>
      : !catalog.enabled ? <p className="mt-2 text-pretty text-xs text-stone-400">Saved storage is unavailable on this backend.</p>
      : <>
        <p className="mb-2 text-pretty text-xs leading-5 text-stone-400">Saved to S3. Partial evidence stays available for inspection.</p>
        {!catalog.analyses.length && !catalog.blocks.length && <p className="text-pretty text-xs text-stone-400">No saved results yet. Analyze an application to save its evidence here.</p>}
        {catalog.analyses.map(item => <Disclosure key={item.id} className="group border-b border-stone-800 py-2">
          <Heading level={3}><WorkspaceButton slot="trigger" className="w-full justify-start px-1 text-left">
            <ChevronRight className="size-4 shrink-0 group-data-[expanded]:rotate-90" aria-hidden="true" /><span>{item.title}</span>
          </WorkspaceButton></Heading>
          <DisclosurePanel className="space-y-2 pb-3 pl-5">
            <p className="text-xs text-stone-400 tabular-nums">{item.result.functions.included} functions · {item.result.readiness ?? "Unassessed"}</p>
            <p className="text-xs text-stone-500">{new Date(item.created_at).toLocaleString()}</p>
            <WorkspaceButton onPress={() => onOpen({ analysisId: item.id })} className="w-full justify-start text-amber-200">Create building blocks</WorkspaceButton>
            <WorkspaceButton onPress={() => setSelection(item.id)} className="w-full justify-start text-xs">Inspect saved evidence</WorkspaceButton>
            {features.filter(feature => feature.analysis_id === item.id).map(feature => <WorkspaceButton key={feature.id}
              onPress={() => onOpen({ analysisId: item.id, featureId: feature.id })} className="w-full flex-col items-start border-l border-stone-700 text-left">
              <span>{feature.spec.title}</span><span className="text-xs font-normal text-amber-200">Needs review</span>
            </WorkspaceButton>)}
          </DisclosurePanel>
        </Disclosure>)}
        {!!catalog.blocks.length && <h3 className="mb-2 mt-4 text-xs font-medium text-stone-400">Reusable building blocks</h3>}
        {catalog.blocks.map(block => <SavedBuildingBlock key={block.id} block={block} />)}
      </>}
    <ModalOverlay isOpen={selection !== null} onOpenChange={open => { if (!open) setSelection(null); }} isDismissable
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-8">
      <Modal className="max-h-[85dvh] w-full max-w-4xl overflow-y-auto rounded-xl border border-stone-700 bg-stone-900 p-6">
        <Dialog aria-label="Saved decompilation evidence" className="outline-none">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div><Heading slot="title" className="text-balance text-lg font-semibold">{analysis?.title ?? "Saved analysis"}</Heading>
              <p className="mt-1 text-pretty text-sm text-stone-400">Analysis evidence. These functions are not verified reusable engines.</p></div>
            <WorkspaceButton autoFocus aria-label="Close saved analysis" onPress={() => setSelection(null)}><X className="size-4" aria-hidden="true" /></WorkspaceButton>
          </div>
          {detailError ? <p role="alert" className="text-red-300">{detailError}</p> : !analysis ? <p role="status">Loading evidence…</p> : <>
            <p className="text-sm text-stone-300 tabular-nums">{analysis.result.functions.reviewed}/{analysis.result.functions.included} functions reviewed · Dossier {analysis.result.readiness}</p>
            {analysis.result.spec_error && <p className="mt-3 text-pretty text-sm text-amber-200">Specification unavailable: {analysis.result.spec_error}</p>}
            <p className="mt-2 text-pretty text-xs text-stone-400">Original observations do not establish candidate equivalence. Held-out inputs and results are withheld.</p>
            <div className="mt-5 divide-y divide-stone-800">
              {analysis.functions.map(fn => <Disclosure key={fn.entry} className="group py-2">
                <Heading level={3}><WorkspaceButton slot="trigger" className="w-full justify-start text-left">
                  <ChevronRight className="size-4 shrink-0 group-data-[expanded]:rotate-90" aria-hidden="true" />
                  <span className="min-w-0 break-words font-mono text-xs">{fn.name ?? fn.entry}</span>
                </WorkspaceButton></Heading>
                <DisclosurePanel className="space-y-3 px-4 pb-4">
                  <p className="text-xs text-stone-400">Draft: {fn.draft_state} · Review: {fn.review_state ?? "Not reviewed"}</p>
                  {fn.claims.map((claim, i) => <div key={i} className="border-l border-stone-700 pl-3">
                    <p className="text-sm leading-6">{claim.statement}</p>
                    <p className="text-xs text-stone-400">{claim.review?.outcome.replace(/_/g, " ") ?? "Unreviewed"}</p>
                    {claim.review && <p className="mt-1 text-pretty text-xs leading-5 text-stone-500">{claim.review.reason}</p>}
                  </div>)}
                  {!!fn.unknowns.length && <ul className="list-disc space-y-1 pl-4 text-xs text-amber-200">{fn.unknowns.map((unknown, i) => <li key={i}>{unknown}</li>)}</ul>}
                  {fn.decompilation ? <><h4 className="text-xs font-medium text-stone-400">Ghidra decompilation · read only</h4><pre className="max-h-80 overflow-auto rounded-lg bg-stone-950 p-4 text-xs leading-5">{fn.decompilation}</pre></>
                    : <p className="text-xs text-stone-500">No decompilation was exported for this function.</p>}
                </DisclosurePanel>
              </Disclosure>)}
            </div>
            <h3 className="mb-3 mt-6 text-sm font-medium">Public original observations</h3>
            <ul className="space-y-2">{analysis.observed_cases.map(item => <li key={item.id} className="flex justify-between gap-4 border-b border-stone-800 py-2 font-mono text-xs"><span>{item.formula}</span><span>{JSON.stringify(item.observed)}</span></li>)}</ul>
          </>}
        </Dialog>
      </Modal>
    </ModalOverlay>
  </section>;
}

function SavedBuildingBlock({ block }: { block: SavedBlock }) {
  const blueprint = block.blueprint;
  return <Disclosure className="group py-2">
    <Heading level={3}><WorkspaceButton slot="trigger" className="w-full justify-start text-left"><ChevronRight className="size-4 shrink-0 group-data-[expanded]:rotate-90" aria-hidden="true" />{blueprint.spec.consumer_title}</WorkspaceButton></Heading>
    <DisclosurePanel className="space-y-3 pl-4">
      <p className="text-pretty text-xs leading-5 text-stone-400">{blueprint.spec.consumer_description}</p>
      <p className="text-xs tabular-nums">Engine tests: {blueprint.verification.passed}/{blueprint.verification.total} · Spec: {blueprint.spec.status}</p>
      {blueprint.spec.status !== "verified" && <p className="text-pretty text-xs text-amber-200">Original behavior is not fully verified. Engine tests passing does not verify the source specification.</p>}
      <pre className="max-h-64 overflow-auto rounded-lg bg-stone-950 p-3 text-xs">{blueprint.implementation.portable_code}</pre>
      <WorkspaceButton onPress={() => { const state = useIdeStore.getState(); state.setNativeHandoff(blueprint.spec, blueprint); state.setWorkspacePage("pipeline"); }}>Use in app builder</WorkspaceButton>
    </DisclosurePanel>
  </Disclosure>;
}
