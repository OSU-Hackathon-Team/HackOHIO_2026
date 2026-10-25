import { useEffect, useState } from "react";
import type { NativeExtraction, SavedAnalysis } from "@splice/contracts";
import { api } from "../api/client";
import { NativeExtractionPanel } from "./NativeExtractionPanel";
import { WorkspaceButton } from "./WorkspaceButton";

export interface SavedLibrarySelection { analysisId: string; featureId?: string }

export function SavedBuildingBlocksWorkspace({ selection, addedFeatureIds, onAdded, onBlockSaved }: {
  selection: SavedLibrarySelection; addedFeatureIds: string[]; onAdded: (feature: NativeExtraction) => void;
  onBlockSaved?: () => void;
}) {
  const [analysis, setAnalysis] = useState<SavedAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setAnalysis(null); setError(null);
    api.savedAnalysis?.(selection.analysisId, controller.signal).then(value => {
      if (!controller.signal.aborted) setAnalysis(value);
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [selection.analysisId, retry]);
  return <div className="mx-auto max-w-3xl" aria-label="Building block workspace" role="region">
    <p className="mb-4 text-xs text-stone-500">Saved applications <span className="mx-2">/</span> Building blocks</p>
    {error ? <div><p role="alert" className="text-pretty text-sm text-red-300">{error}</p><WorkspaceButton onPress={() => setRetry(n => n + 1)}>Retry loading saved data</WorkspaceButton></div>
      : !analysis ? <div role="status" className="space-y-4"><p className="text-sm text-stone-400">Loading saved application…</p><div className="h-8 rounded bg-stone-800" /><div className="h-24 rounded bg-stone-800" /></div>
      : <>
        <h2 className="text-balance text-2xl font-semibold">{analysis.title}</h2>
        <p className="mt-3 text-pretty text-sm leading-6 text-stone-400">Discover the reusable capabilities in its saved reverse-engineering evidence. Review each generated description and behavior, then choose which candidates to save to App library.</p>
        <dl className="mt-5 grid grid-cols-3 gap-4 border-y border-stone-800 py-4 text-sm">
          <div><dt className="text-xs text-stone-500">Saved functions</dt><dd className="mt-1 tabular-nums">{analysis.functions.length}</dd></div>
          <div><dt className="text-xs text-stone-500">Reviewed functions</dt><dd className="mt-1 tabular-nums">{analysis.result.functions.reviewed}</dd></div>
          <div><dt className="text-xs text-stone-500">Evidence readiness</dt><dd className="mt-1">{analysis.result.readiness ?? "Unassessed"}</dd></div>
        </dl>
        <NativeExtractionPanel key={analysis.id} analysis={analysis} initialSelection={selection.featureId}
          addedFeatureIds={addedFeatureIds} onAdded={onAdded} onBlockSaved={onBlockSaved} />
      </>}
  </div>;
}
