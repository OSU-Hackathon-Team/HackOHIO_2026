import { useEffect, useRef, useState } from "react";
import { Checkbox, Disclosure, DisclosurePanel, Heading, Input, Label, TextField } from "react-aria-components";
import type { NativeExtraction, SavedAnalysis } from "@splice/contracts";
import { api } from "../api/client";
import { WorkspaceButton } from "./WorkspaceButton";

export function NativeExtractionPanel({ analysis, initialSelection, addedFeatureIds, onAdded }: {
  analysis: SavedAnalysis; initialSelection?: string; addedFeatureIds: string[]; onAdded: (feature: NativeExtraction) => void;
}) {
  const [history, setHistory] = useState<NativeExtraction[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [intent, setIntent] = useState("");
  const [scope, setScope] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelection ?? null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ id: string; message: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const saveController = useRef<AbortController | null>(null);
  const supported = analysis.functions.filter(fn => fn.review_state === "reviewed" && fn.claims.some(c => c.review?.outcome === "supported_static"));

  useEffect(() => {
    const request = new AbortController();
    setLoading(true); setHistoryError(null);
    api.savedExtractions?.(analysis.id, request.signal).then(records => {
      if (!request.signal.aborted) setHistory(records);
    }).catch(e => { if (!request.signal.aborted) setHistoryError(e.message); })
      .finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => { request.abort(); controller.current?.abort(); saveController.current?.abort(); };
  }, [analysis.id, refresh]);

  async function extract() {
    if (!api.extractSavedAnalysis || controller.current || !confirmed) return;
    const request = new AbortController(); controller.current = request;
    setBusy(true); setConfirmed(false); setError(null); setMessage("Preparing saved evidence…");
    let result: NativeExtraction | undefined;
    let doneOk = false, failure: string | undefined;
    try {
      await api.extractSavedAnalysis(analysis.id, { confirm_cost: true, intent, function_entries: scope ? [scope] : [] }, event => {
        if (request.signal.aborted) return;
        if (event.type === "stage") setMessage(event.message);
        if (event.type === "progress") setMessage(`Writing draft · ${event.output_chars.toLocaleString()} characters`);
        if (event.type === "extraction") result = event.extraction;
        if (event.type === "error") failure = event.message;
        if (event.type === "done") doneOk = event.ok;
      }, request.signal);
      request.signal.throwIfAborted();
      if (failure || !doneOk || !result) throw new Error(failure ?? "The stream did not finish with a saved extraction");
      const saved = result;
      setHistory(records => [saved, ...records.filter(record => record.id !== saved.id)]);
      setSelectedId(saved.id);
      setMessage("Draft saved to S3. Review its requirements and remaining gaps below.");
    } catch (e) {
      if (!request.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally { controller.current = null; setBusy(false); }
  }

  async function addToLibrary(record: NativeExtraction) {
    if (!api.addLibraryFeature || saveController.current || addedFeatureIds.includes(record.id)) return;
    const request = new AbortController(); saveController.current = request;
    setSavingId(record.id); setSaveError(null);
    try {
      const feature = await api.addLibraryFeature({ analysis_id: analysis.id, extraction_id: record.id }, request.signal);
      if (feature.id !== record.id || feature.analysis_id !== analysis.id) throw new Error("Saved building block does not match this candidate");
      if (!request.signal.aborted) onAdded(feature);
    } catch (error) {
      if (!request.signal.aborted) setSaveError({ id: record.id, message: error instanceof Error ? error.message : String(error) });
    } finally { saveController.current = null; setSavingId(null); }
  }

  const inspected = history.find(record => record.id === selectedId) ?? history[0];

  if (!api.extractSavedAnalysis) return null;
  return <section aria-label="Extract features from saved evidence" className="mt-5 rounded-lg border border-stone-700 p-4">
    <h3 className="text-balance text-base font-medium">Create a building block</h3>
    <p className="mt-2 text-pretty text-sm leading-6 text-stone-400">The requirements engine creates a name, description and behavior specification from supported facts. Each result starts as a candidate for review.</p>
    <div className="mt-4 grid gap-3">
      <TextField value={intent} onChange={setIntent} isDisabled={busy} maxLength={2000} className="grid gap-2">
        <Label className="text-xs text-stone-400">What should this building block do?</Label>
        <Input placeholder="For example, describe how numeric comparisons behave" className="rounded-lg border border-stone-700 bg-stone-950 p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-amber-400" />
      </TextField>
      <label className="grid gap-2 text-xs text-stone-400">Extraction scope
        <select value={scope} onChange={e => setScope(e.target.value)} disabled={busy} className="rounded-lg border border-stone-700 bg-stone-950 p-3 text-sm text-stone-200">
          <option value="">All reviewed functions</option>
          {supported.map(fn => <option key={fn.entry} value={fn.entry}>{fn.name ?? fn.entry}</option>)}
        </select>
      </label>
      <Checkbox isSelected={confirmed} onChange={setConfirmed} isDisabled={busy} className="group flex cursor-pointer items-start gap-2 text-sm leading-6 text-stone-300">
        <span aria-hidden="true" className="mt-1 size-4 shrink-0 rounded border border-stone-500 group-data-[selected]:border-amber-400 group-data-[selected]:bg-amber-400 group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-amber-400" />
        I approve paid model calls for this extraction (up to three attempts).
      </Checkbox>
      <div className="flex items-center gap-3">
        <WorkspaceButton primary isDisabled={busy || loading || !confirmed || !supported.length} onPress={() => void extract()}>Extract draft features</WorkspaceButton>
        {busy && <WorkspaceButton onPress={() => { setMessage("Extraction cancelled. Refresh drafts to check whether publication finished."); controller.current?.abort(); }}>Cancel extraction</WorkspaceButton>}
      </div>
      {!supported.length && <p className="text-pretty text-sm text-amber-200">No supported claims are available. More evidence or review is needed before extraction.</p>}
      {message && <p role="status" className="text-sm text-stone-400 tabular-nums">{message}</p>}
      {error && <p role="alert" className="text-pretty text-sm text-red-300">{error}</p>}
    </div>
    <div className="mb-2 mt-6 flex items-center justify-between gap-2"><h4 className="text-sm font-medium">Candidate building blocks</h4>
      <WorkspaceButton isDisabled={busy || loading} onPress={() => setRefresh(value => value + 1)} className="text-xs">Refresh drafts</WorkspaceButton></div>
    {loading && <p role="status" className="text-xs text-stone-400">Loading saved drafts…</p>}
    {historyError && <p role="alert" className="text-xs text-red-300">Saved drafts unavailable: {historyError}</p>}
    {!loading && !historyError && !history.length && <p className="text-pretty text-sm text-stone-500">No building blocks yet. Describe a capability above to create the first candidate.</p>}
    <div className="mt-4 grid grid-cols-2 gap-3">{history.map(record => <article key={record.id} aria-label={`Candidate: ${record.spec.title}`} className="flex flex-col rounded-lg border border-stone-700 p-4">
      <span className="mb-3 text-xs text-amber-200">{addedFeatureIds.includes(record.id) ? "In App library · needs review" : "Candidate · needs review"}</span>
      <h5 className="text-balance text-sm font-semibold">{record.spec.title}</h5>
      <p className="mt-2 text-pretty text-sm leading-6 text-stone-400">{record.spec.purpose}</p>
      <p className="mb-3 mt-3 text-xs text-stone-500 tabular-nums">{record.spec.requirements.length} behavior rules · {record.claim_sources.length} supporting facts</p>
      <div className="mt-auto grid gap-1">
        <WorkspaceButton aria-pressed={inspected?.id === record.id} onPress={() => setSelectedId(record.id)} className="border border-stone-700">View details</WorkspaceButton>
        <WorkspaceButton primary isDisabled={addedFeatureIds.includes(record.id) || savingId !== null || !api.addLibraryFeature} onPress={() => void addToLibrary(record)}>
          {addedFeatureIds.includes(record.id) ? "Added to App library" : savingId === record.id ? "Saving…" : "Add to App library"}
        </WorkspaceButton>
      </div>
      {saveError?.id === record.id && <p role="alert" className="mt-2 text-pretty text-xs text-red-300">{saveError.message}</p>}
    </article>)}</div>
    {inspected && <CandidateDetails record={inspected} />}
  </section>;
}

function CandidateDetails({ record }: { record: NativeExtraction }) {
  const interfaceSections: [string, string[]][] = [["Inputs", record.spec.interface.inputs], ["Outputs", record.spec.interface.outputs], ["State", record.spec.interface.state]];
  return <article aria-label="Building block details" className="mt-6 border-t border-stone-700 pt-5">
      <h5 className="text-balance font-medium">{record.spec.title} <span className="text-xs text-amber-200">Draft · implementation blocked</span></h5>
      <p className="mt-2 text-pretty text-sm text-stone-300">{record.spec.purpose}</p>
      <p className="mt-2 text-xs text-stone-500">{new Date(record.created_at).toLocaleString()} · {record.model}</p>
      <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">{interfaceSections.map(([label, values]) => <div key={label}>
        <dt className="mb-2 text-xs font-medium text-stone-400">{label}</dt><dd><ul className="space-y-1 text-pretty leading-6 text-stone-300">{values.map((value, i) => <li key={i}>{value}</li>)}{!values.length && <li className="text-stone-500">None specified.</li>}</ul></dd>
      </div>)}</dl>
      <h6 className="mt-5 text-sm font-medium">Behavior rules</h6>
      <ol className="mt-3 space-y-3">{record.spec.requirements.map(requirement => {
        const ids = record.requirement_sources.find(link => link.requirement_id === requirement.id)?.claim_ids ?? [];
        return <li key={requirement.id} className="border-l border-stone-700 pl-3">
          <p className="text-sm leading-6"><span className="text-stone-400">{requirement.id}</span> {requirement.statement}</p>
          <p className="text-xs text-stone-500">Supporting facts: {ids.join(", ")}</p>
          <Disclosure>
            <Heading level={6}><WorkspaceButton slot="trigger" className="px-0 text-xs">Inspect supporting facts for {requirement.id}</WorkspaceButton></Heading>
            <DisclosurePanel className="space-y-3 pb-2">{record.claim_sources.filter(fact => ids.includes(fact.id)).map(fact => <div key={fact.id}>
              <p className="text-xs text-stone-500">{fact.id} · function {fact.function_entry}</p>
              <p className="mt-1 text-sm text-stone-300">{fact.statement}</p>
              <p className="mt-1 text-pretty text-xs leading-5 text-stone-400">Static review: {fact.review_reason}</p>
            </div>)}</DisclosurePanel>
          </Disclosure>
        </li>;
      })}</ol>
      <ul className="mt-4 list-disc space-y-1 pl-4 text-pretty text-xs leading-5 text-amber-200">{record.limitations.map((limit, i) => <li key={i}>{limit}</li>)}</ul>
      <p className="mt-2 text-xs text-stone-400 tabular-nums">{record.claim_sources.length} supported facts used · {record.omitted_claims.length} claims excluded</p>
      <h6 className="mt-4 text-sm font-medium">Checks still needed</h6>
      <ul className="mt-2 list-disc space-y-1 pl-4 text-pretty text-sm leading-6 text-stone-400">{record.spec.acceptance_criteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul>
      <p className="mt-4 text-pretty text-xs leading-5 text-stone-500">Saving this candidate to the library preserves its draft status. App reuse requires an implementation-ready specification and a passing engine.</p>
    </article>;
}
