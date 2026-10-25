import { useEffect, useRef, useState } from "react";
import { Checkbox, Disclosure, DisclosurePanel, Heading } from "react-aria-components";
import type { DiscoveredCapability, NativeDiscoveryReport, NativeExtraction, SavedAnalysis, UnassignedClaim } from "@splice/contracts";
import { api } from "../api/client";
import { WorkspaceButton } from "./WorkspaceButton";

// Five capabilities × three writer attempts, plus two discovery attempts (backend limits).
const MAX_MODEL_ATTEMPTS = 17;

type CandidateState = { state: "waiting" | "writing" | "saved" | "failed" | "not_attempted"; message?: string };
interface DiscoveryPlan {
  capabilities: DiscoveredCapability[]; unassigned: UnassignedClaim[]; explanation: string;
  states: Record<string, CandidateState>;
}

function planFromReport(report: NativeDiscoveryReport): DiscoveryPlan {
  const states: Record<string, CandidateState> = {};
  for (const candidate of report.candidates) {
    states[candidate.capability_id] = candidate.status === "saved" ? { state: "saved" }
      : candidate.status === "failed" ? { state: "failed", message: candidate.error }
      : { state: "not_attempted", message: candidate.reason };
  }
  return { capabilities: report.capabilities, unassigned: report.unassigned, explanation: report.explanation, states };
}

function outcomeText(report: NativeDiscoveryReport): string {
  const total = report.capabilities.length;
  const saved = report.candidates.filter(candidate => candidate.status === "saved").length;
  switch (report.status) {
    case "complete": return `Discovery finished: ${saved} draft building block${saved === 1 ? "" : "s"} saved. Review them below.`;
    case "partial": return `${saved} of ${total} drafts saved. The others failed; the saved drafts remain usable.`;
    case "empty": return `No reusable capabilities were found. ${report.explanation}`;
    case "cancelled": return `Discovery was cancelled. ${saved} draft${saved === 1 ? "" : "s"} saved before cancellation remain available.`;
    case "failed": return "Discovery did not save any drafts.";
  }
}

export function NativeExtractionPanel({ analysis, initialSelection, addedFeatureIds, onAdded }: {
  analysis: SavedAnalysis; initialSelection?: string; addedFeatureIds: string[]; onAdded: (feature: NativeExtraction) => void;
}) {
  const [history, setHistory] = useState<NativeExtraction[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<DiscoveryPlan | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelection ?? null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ id: string; message: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const saveController = useRef<AbortController | null>(null);
  const supported = analysis.functions.filter(fn => fn.review_state === "reviewed" && fn.claims.some(c => c.review?.outcome === "supported_static"));

  useEffect(() => {
    const request = new AbortController();
    setLoading(true); setHistoryError(null);
    Promise.all([api.savedExtractions?.(analysis.id, request.signal), api.savedDiscoveries?.(analysis.id, request.signal)])
      .then(([records, reports]) => {
        if (request.signal.aborted) return;
        setHistory(records ?? []);
        // The latest saved report explains the current candidates and the facts left out.
        if (reports?.length && !controller.current) setPlan(planFromReport(reports[0]));
      }).catch(e => { if (!request.signal.aborted) setHistoryError(e.message); })
      .finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => { request.abort(); };
  }, [analysis.id, refresh]);
  useEffect(() => () => { controller.current?.abort(); saveController.current?.abort(); }, []);

  const mark = (id: string, state: CandidateState) =>
    setPlan(current => current && { ...current, states: { ...current.states, [id]: state } });

  async function discover() {
    if (!api.discoverSavedAnalysis || controller.current || !confirmed) return;
    const request = new AbortController(); controller.current = request;
    setBusy(true); setConfirmed(false); setError(null); setPlan(null); setMessage("Preparing saved evidence…");
    let report: NativeDiscoveryReport | undefined, failure: string | undefined, doneOk = false, stage = "";
    let order: string[] = [];
    try {
      await api.discoverSavedAnalysis(analysis.id, { confirm_cost: true }, event => {
        if (request.signal.aborted) return;
        if (event.type === "stage") {
          stage = event.message; setMessage(event.message);
          const writing = /^Writing draft (\d+) of/.exec(event.message);
          if (writing && order[Number(writing[1]) - 1]) mark(order[Number(writing[1]) - 1], { state: "writing" });
        }
        if (event.type === "progress") setMessage(`${stage} · ${event.output_chars.toLocaleString()} characters`);
        if (event.type === "capabilities") {
          order = event.capabilities.map(capability => capability.id);
          setPlan({ capabilities: event.capabilities, unassigned: event.unassigned, explanation: event.explanation,
            states: Object.fromEntries(order.map(id => [id, { state: "waiting" }])) });
        }
        if (event.type === "draft") {
          const saved = event.extraction;
          mark(event.capability_id, { state: "saved" });
          setHistory(records => [saved, ...records.filter(record => record.id !== saved.id)]);
          setSelectedId(current => current ?? saved.id);
        }
        if (event.type === "candidate_failed") mark(event.capability_id, { state: "failed", message: event.message });
        if (event.type === "report") report = event.report;
        if (event.type === "error") failure = event.message;
        if (event.type === "done") doneOk = event.ok;
      }, request.signal);
      request.signal.throwIfAborted();
      if (!report) throw new Error(failure ?? "The stream ended before the discovery report was saved");
      setPlan(planFromReport(report));
      setMessage(outcomeText(report));
      if (!doneOk) setError(failure ?? report.error ?? "Discovery failed");
    } catch (e) {
      if (!request.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally { if (controller.current === request) controller.current = null; setBusy(false); }
  }

  function cancel() {
    controller.current?.abort();
    setMessage("Discovery cancelled. Drafts already saved remain available; Refresh drafts shows the saved report.");
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

  if (!api.discoverSavedAnalysis) return null;
  return <section aria-label="Discover building blocks from saved evidence" className="mt-5 rounded-lg border border-stone-700 p-4">
    <h3 className="text-balance text-base font-medium">Discover building blocks</h3>
    <p className="mt-2 text-pretty text-sm leading-6 text-stone-400">Agents read the reviewed facts, choose up to five reusable capabilities, and write a named draft for each. Every result starts as a candidate for your review.</p>
    <div className="mt-4 grid gap-3">
      <Checkbox isSelected={confirmed} onChange={setConfirmed} isDisabled={busy} className="group flex cursor-pointer items-start gap-2 text-sm leading-6 text-stone-300">
        <span aria-hidden="true" className="mt-1 size-4 shrink-0 rounded border border-stone-500 group-data-[selected]:border-amber-400 group-data-[selected]:bg-amber-400 group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-amber-400" />
        I approve paid model calls for discovery (up to {MAX_MODEL_ATTEMPTS} model attempts).
      </Checkbox>
      <div className="flex items-center gap-3">
        <WorkspaceButton primary isDisabled={busy || loading || !confirmed || !supported.length} onPress={() => void discover()}>Discover building blocks</WorkspaceButton>
        {busy && <WorkspaceButton onPress={cancel}>Cancel discovery</WorkspaceButton>}
      </div>
      {!supported.length && <p className="text-pretty text-sm text-amber-200">Insufficient evidence: no reviewed, supported facts are saved for this application. Analyze more functions before discovering building blocks.</p>}
      {message && <p role="status" className="text-pretty text-sm text-stone-400 tabular-nums">{message}</p>}
      {error && <p role="alert" className="text-pretty text-sm text-red-300">{error}</p>}
    </div>
    {plan && <DiscoveryPlanView plan={plan} />}
    <div className="mb-2 mt-6 flex items-center justify-between gap-2"><h4 className="text-sm font-medium">Candidate building blocks</h4>
      <WorkspaceButton isDisabled={busy || loading} onPress={() => setRefresh(value => value + 1)} className="text-xs">Refresh drafts</WorkspaceButton></div>
    {loading && <p role="status" className="text-xs text-stone-400">Loading saved drafts…</p>}
    {historyError && <p role="alert" className="text-xs text-red-300">Saved drafts unavailable: {historyError}</p>}
    {!loading && !historyError && !history.length && <p className="text-pretty text-sm text-stone-500">No building blocks yet. Discover building blocks to create the first candidates.</p>}
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

const STATE_LABEL: Record<CandidateState["state"], string> = {
  waiting: "Waiting", writing: "Writing draft…", saved: "Draft saved", failed: "Draft failed", not_attempted: "Not attempted",
};
const DISPOSITION_LABEL: Record<UnassignedClaim["disposition"], string> = {
  supporting_only: "Supporting context", insufficient: "Insufficient", deferred: "Deferred",
};

function DiscoveryPlanView({ plan }: { plan: DiscoveryPlan }) {
  return <div aria-label="Discovered capabilities" role="region" className="mt-5 border-t border-stone-800 pt-4">
    <h4 className="text-sm font-medium">Discovered capabilities</h4>
    {plan.explanation && <p className="mt-1 text-pretty text-xs leading-5 text-stone-400">{plan.explanation}</p>}
    {!plan.capabilities.length && <p className="mt-2 text-pretty text-sm text-amber-200">No useful capability is supported by these facts.</p>}
    <ol className="mt-3 space-y-2">{plan.capabilities.map(capability => {
      const state = plan.states[capability.id] ?? { state: "waiting" };
      return <li key={capability.id} className="flex items-start justify-between gap-3 border-l border-stone-700 pl-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{capability.name}</p>
          <p className="text-pretty text-xs leading-5 text-stone-400">{capability.purpose}</p>
          <p className="text-xs text-stone-500 tabular-nums">{capability.claim_ids.length} supporting facts</p>
          {state.message && <p className="mt-1 text-pretty text-xs text-red-300">{state.message}</p>}
        </div>
        <span className={`shrink-0 text-xs ${state.state === "saved" ? "text-emerald-300" : state.state === "failed" ? "text-red-300" : "text-amber-200"}`}>{STATE_LABEL[state.state]}</span>
      </li>;
    })}</ol>
    {!!plan.unassigned.length && <Disclosure className="mt-3">
      <Heading level={5}><WorkspaceButton slot="trigger" className="px-0 text-xs">Facts not used in a capability ({plan.unassigned.length})</WorkspaceButton></Heading>
      <DisclosurePanel><ul className="space-y-1 pb-2">{plan.unassigned.map(item => <li key={item.claim_id} className="text-pretty text-xs leading-5 text-stone-400">
        <span className="text-stone-500">{item.claim_id} · {DISPOSITION_LABEL[item.disposition]}:</span> {item.reason}
      </li>)}</ul></DisclosurePanel>
    </Disclosure>}
  </div>;
}
