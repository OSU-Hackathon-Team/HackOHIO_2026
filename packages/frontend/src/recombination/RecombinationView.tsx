import { useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import { CompositionPlan, type ApplicationRecord, type ApplicationRevisionListResponse, type CapabilityListResponse, type CompositionValidateResponse, type JobRecord, type PreviewResponse, type TranscriptionAvailabilityResponse, type TranscriptionSegment } from "@splice/contracts";
import {
  activateApplicationRevision,
  buildApplication,
  cancelJob,
  cancelTranscriptionSession,
  exportApplication,
  getJob,
  getLatestRevision,
  getRevision,
  getNotebookExample,
  getTranscriptionAvailability,
  getTranscriptionSession,
  listApplications,
  listApplicationRevisions,
  listCapabilities,
  previewApplication,
  seedDevelopmentPackages,
  streamJob,
  startTranscriptionJob,
  streamTranscriptionSession,
  validateComposition,
} from "../api/recombination";
import { startMicrophoneCapture, type MicrophoneCapture } from "./microphone";

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
const ACTIVE_BUILD_KEY = "splice.recombination.activeBuildJob";
const ACTIVE_TRANSCRIPTION_KEY = "splice.recombination.activeTranscriptionSession";
type LiveSegment = TranscriptionSegment;

function embeddedPlan(record: ApplicationRecord): CompositionPlan | null {
  const artifact = record.bundle.files.find((file) => file.path === "splice.plan.json");
  if (!artifact?.content) return null;
  try { return CompositionPlan.parse((JSON.parse(artifact.content) as { plan?: unknown }).plan); }
  catch { return null; }
}

function sampleInput(plan: CompositionPlan, workflow: string): unknown {
  for (const scenario of plan.acceptance_scenarios) {
    const sample = scenario.steps.find((step) => step.kind === "invoke" && step.workflow === workflow);
    if (sample?.kind === "invoke") return sample.input;
  }
  return {};
}

function sampleEdits(plan: CompositionPlan, workflow: string): Array<{ document: string; path: string; value: unknown }> {
  for (const scenario of plan.acceptance_scenarios) {
    const invoke = scenario.steps.findIndex((step) => step.kind === "invoke" && step.workflow === workflow);
    if (invoke >= 0) return scenario.steps.slice(0, invoke).filter((step) => step.kind === "set_document").map((step) => ({ document: step.document, path: step.path, value: step.value }));
  }
  return [];
}

export function RecombinationView() {
  const [catalog, setCatalog] = useState<CapabilityListResponse>({ packages: [], intakes: [] });
  const [apps, setApps] = useState<Array<{ app_id: string; revision: number; title: string; status: string }>>([]);
  const [planText, setPlanText] = useState("");
  const [validation, setValidation] = useState<CompositionValidateResponse | null>(null);
  const [record, setRecord] = useState<ApplicationRecord | null>(null);
  const [history, setHistory] = useState<ApplicationRevisionListResponse | null>(null);
  const [workflow, setWorkflow] = useState("");
  const [inputText, setInputText] = useState("{}");
  const [editsText, setEditsText] = useState("[]");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [activity, setActivity] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcription, setTranscription] = useState<TranscriptionAvailabilityResponse | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [transcriptionToken, setTranscriptionToken] = useState("");
  const [audioId, setAudioId] = useState<string | null>(null);
  const [liveSegments, setLiveSegments] = useState<LiveSegment[]>([]);
  const [transcribing, setTranscribing] = useState(false);
  const [transcriptionNotice, setTranscriptionNotice] = useState("");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const transcriptionAbort = useRef<AbortController | null>(null);
  const microphone = useRef<MicrophoneCapture | null>(null);
  const microphoneGeneration = useRef(0);
  const audioInput = useRef<HTMLInputElement | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    let mounted = true;
    Promise.all([listCapabilities(), listApplications()]).then(([capabilities, applications]) => {
      if (!mounted) return;
      setCatalog(capabilities);
      setApps(applications.apps);
    }).catch((cause) => { if (mounted) setError(message(cause)); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => { setActiveSessionId(localStorage.getItem(ACTIVE_TRANSCRIPTION_KEY)); }, []);

  useEffect(() => {
    const controller = new AbortController();
    getTranscriptionAvailability(controller.signal).then(setTranscription).catch((cause) => {
      if (!controller.signal.aborted) setError(message(cause));
    });
    return () => { controller.abort(); transcriptionAbort.current?.abort(); microphoneGeneration.current += 1; microphone.current?.discard(); };
  }, []);

  useEffect(() => {
    const savedId = localStorage.getItem(ACTIVE_BUILD_KEY);
    if (!savedId) return;
    let mounted = true;
    getJob(savedId).then((saved) => { if (mounted) setJob(saved); }).catch((cause) => {
      if (!mounted) return;
      localStorage.removeItem(ACTIVE_BUILD_KEY);
      setError(message(cause));
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!job?.job_id) return;
    const jobId = job.job_id;
    const controller = new AbortController();
    void (async () => {
      try {
        await streamJob(jobId, (event) => {
          if (event.type === "stage") setActivity((lines) => [...lines.slice(-40), `${Math.round(event.pct)}% ${event.message}`]);
          if (event.type === "error") setActivity((lines) => [...lines.slice(-40), event.message]);
        }, controller.signal);
        const finished = await getJob(jobId, controller.signal);
        setJob(finished);
        localStorage.removeItem(ACTIVE_BUILD_KEY);
        if (finished.status !== "succeeded") throw new Error(finished.error ?? `Application build ${finished.status}`);
        const reference = /^app:(app_[a-f0-9]{32}):(\d+)$/.exec(finished.result_ref ?? "");
        if (!reference) throw new Error(`Unexpected application result reference ${finished.result_ref}`);
        selectRecord(await getRevision(reference[1], Number(reference[2]), controller.signal));
        await refresh();
      } catch (cause) {
        if (!controller.signal.aborted) setError(message(cause));
      }
    })();
    return () => controller.abort();
  }, [job?.job_id]);

  useEffect(() => {
    if (!record) { setHistory(null); return; }
    const controller = new AbortController();
    listApplicationRevisions(record.app_id, controller.signal).then(setHistory).catch((cause) => {
      if (!controller.signal.aborted) setError(message(cause));
    });
    return () => controller.abort();
  }, [record?.app_id, record?.revision]);

  async function refresh() {
    const [capabilities, applications] = await Promise.all([listCapabilities(), listApplications()]);
    setCatalog(capabilities);
    setApps(applications.apps);
  }

  async function perform(action: () => Promise<void>) {
    setError(null); setBusy(true);
    try { await action(); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  function parsePlan(): CompositionPlan { return CompositionPlan.parse(JSON.parse(planText)); }

  function selectRecord(value: ApplicationRecord) {
    setRecord(value); setPreview(null);
    const plan = embeddedPlan(value);
    if (plan) {
      setPlanText(JSON.stringify(plan, null, 2));
      const first = plan.workflows[0]?.id ?? "";
      setWorkflow(first);
      setInputText(JSON.stringify(sampleInput(plan, first), null, 2));
      setEditsText(JSON.stringify(sampleEdits(plan, first), null, 2));
    }
  }

  async function loadExample() {
    const example = await getNotebookExample();
    setPlanText(JSON.stringify(example, null, 2));
    setWorkflow(example.workflows[0]?.id ?? "");
    setInputText(JSON.stringify(sampleInput(example, example.workflows[0]?.id ?? ""), null, 2));
    setEditsText(JSON.stringify(sampleEdits(example, example.workflows[0]?.id ?? ""), null, 2));
    setValidation(null);
  }

  async function buildPlan() {
    const plan = parsePlan();
    const checked = await validateComposition(plan);
    setValidation(checked);
    if (!checked.ok) return;
    const started = await buildApplication(plan);
    setJob(started); setActivity([]);
    localStorage.setItem(ACTIVE_BUILD_KEY, started.job_id);
  }

  async function downloadExport() {
    if (!record) throw new Error("Select a verified application first");
    const exported = await exportApplication(record.app_id);
    const zip = new JSZip();
    for (const file of exported.files) {
      if (file.content === null) throw new Error(`Export file ${file.path} has no content`);
      zip.file(file.path, file.content, {
        base64: file.encoding === "base64",
        unixPermissions: file.path.endsWith("/bin/sidecar") ? "755" : "644",
      });
    }
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exported.filename.replace(/\.splice-source\.json$/, ".zip");
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function startTranscription() {
    if (!audioFile) return;
    let currentInput: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(inputText);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow input must be a JSON object");
      currentInput = value as Record<string, unknown>;
    } catch (cause) { setError(message(cause)); return; }
    const controller = new AbortController();
    transcriptionAbort.current = controller;
    setTranscribing(true); setError(null); setAudioId(null); setLiveSegments([]); setTranscriptionNotice("Transcribing through external AWS provider…");
    try {
      const provider = record && embeddedPlan(record)?.providers.find((item) => item.document_projection);
      const binding = record && provider ? { appId: record.app_id, providerId: provider.id } : undefined;
      const started = await startTranscriptionJob(audioFile, transcriptionToken, binding, controller.signal);
      localStorage.setItem(ACTIVE_TRANSCRIPTION_KEY, started.session.session_id);
      setActiveSessionId(started.session.session_id);
      await observeTranscription(started.session.session_id, currentInput, controller);
    } catch (cause) {
      setTranscriptionNotice(controller.signal.aborted ? "Transcription observation stopped; the job continues" : message(cause));
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      transcriptionAbort.current = null;
      setTranscribing(false);
    }
  }

  async function observeTranscription(sessionId: string, currentInput: Record<string, unknown>, controller: AbortController) {
    let session = await getTranscriptionSession(sessionId, transcriptionToken, controller.signal);
    setAudioId(session.audio.id); setLiveSegments(session.segments);
    if (session.status === "queued" || session.status === "running") {
      let currentAttempt = session.attempt;
      await streamTranscriptionSession(sessionId, transcriptionToken, (event) => {
        if (event.type === "transcription_reset" && event.attempt > currentAttempt) {
          currentAttempt = event.attempt; setLiveSegments([]);
        }
        if (event.type === "transcription_segment" && event.attempt === currentAttempt) {
          const { index, start_ms, end_ms, text, final } = event;
          setLiveSegments((previous) => [...previous.filter((item) => item.index !== index), { index, start_ms, end_ms, text, final }].sort((a, b) => a.index - b.index));
        }
      }, controller.signal);
      session = await getTranscriptionSession(sessionId, transcriptionToken, controller.signal);
    }
    setLiveSegments(session.segments);
    localStorage.removeItem(ACTIVE_TRANSCRIPTION_KEY); setActiveSessionId(null);
    if (session.status !== "succeeded") throw new Error(session.error ?? `Transcription ${session.status}`);
    const segments = session.segments.filter((item) => item.final).map((item) => ({ id: `aws-${item.index}`, start_ms: item.start_ms, end_ms: item.end_ms, text: item.text }));
    if (!segments.length) throw new Error("Provider returned no final speech segments");
    setInputText(JSON.stringify({ ...currentInput, segments }, null, 2));
    setTranscriptionNotice(session.projection
      ? `${segments.length} final segment(s) saved to ${session.projection.document} and added to workflow input.`
      : `${segments.length} final segment(s) added to workflow input. Run preview to save them in a document.`);
  }

  async function reconnectTranscription() {
    if (!activeSessionId) return;
    let currentInput: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(inputText);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow input must be a JSON object");
      currentInput = value as Record<string, unknown>;
    } catch (cause) { setError(message(cause)); return; }
    const controller = new AbortController();
    transcriptionAbort.current = controller; setTranscribing(true); setError(null);
    setTranscriptionNotice("Reconnecting to saved transcription…");
    try { await observeTranscription(activeSessionId, currentInput, controller); }
    catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
      setTranscriptionNotice(message(cause));
    } finally { transcriptionAbort.current = null; setTranscribing(false); }
  }

  async function cancelTranscription() {
    if (!activeSessionId) return;
    try { await cancelTranscriptionSession(activeSessionId, transcriptionToken); }
    catch (cause) { setError(message(cause)); }
  }

  async function recordMicrophone() {
    const generation = ++microphoneGeneration.current;
    if (audioInput.current) audioInput.current.value = "";
    setCapturing(true); setAudioFile(null); setError(null); setTranscriptionNotice("Requesting microphone permission…");
    try {
      const capture = await startMicrophoneCapture();
      if (generation !== microphoneGeneration.current) { capture.discard(); return; }
      microphone.current = capture;
      setCapturing(false);
      setRecording(true);
      setTranscriptionNotice("Recording microphone. Stop when ready; recording ends automatically after five minutes.");
      void capture.finished.then((file) => {
        if (generation !== microphoneGeneration.current) return;
        microphone.current = null; setRecording(false);
        if (file) { setAudioFile(file); setTranscriptionNotice(`${file.name} is ready for transcription.`); }
        else setTranscriptionNotice("Microphone recording discarded.");
      }).catch((cause) => {
        if (generation !== microphoneGeneration.current) return;
        microphone.current = null; setRecording(false); setError(message(cause));
        setTranscriptionNotice("Microphone recording failed.");
      });
    } catch (cause) {
      if (generation !== microphoneGeneration.current) return;
      setCapturing(false);
      setError(message(cause)); setTranscriptionNotice("Microphone capture unavailable.");
    }
  }

  const selectedPlan = record ? embeddedPlan(record) : null;
  const selectedActive = Boolean(record && history?.app_id === record.app_id && history.active_revision === record.revision);
  const acceptsTranscript = Boolean(selectedPlan?.workflows.find((item) => item.id === workflow)?.input.fields.some((field) => field.name === "segments"));
  return (
    <div className="h-full overflow-auto bg-[#181614] px-8 py-7 text-stone-100">
      <div className="mx-auto max-w-6xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Recombine capabilities</h1>
          <p className="mt-2 max-w-3xl text-sm text-stone-400">Build an application from hash-pinned capability packages, explicit bindings, shared documents, and tested workflows. The notebook example uses authored development packages.</p>
        </header>
        {error && <p role="alert" className="rounded border border-red-700 bg-red-950/30 p-3 text-sm text-red-200">{error}</p>}

        <section className="rounded-xl border border-stone-700 bg-[#211e1b] p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-medium">Capability library</h2>
            <div className="flex gap-2">
              <button disabled={busy} onClick={() => void perform(async () => { await seedDevelopmentPackages(); await refresh(); })} className="rounded bg-amber-400 px-3 py-2 text-sm font-medium text-stone-950 disabled:opacity-50">Install notebook example</button>
              <button disabled={busy} onClick={() => void perform(refresh)} className="rounded border border-stone-600 px-3 py-2 text-sm disabled:opacity-50">Refresh</button>
            </div>
          </div>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {catalog.packages.map((pkg) => <li key={pkg.package_id} className="rounded border border-stone-700 bg-[#181614] p-3 text-sm">
              <p className="font-medium">{pkg.definition.id}</p><p className="mt-1 break-all font-mono text-xs text-stone-500">{pkg.package_id}</p>
              <p className="mt-2 text-xs text-stone-400">{pkg.runtime_kind} · {pkg.readiness.implementation_checks.status} checks · {pkg.readiness.independent_behavior_checks.status} independent</p>
            </li>)}
          </ul>
          {catalog.intakes.some((item) => !item.accepted) && <div className="mt-4 space-y-2 text-sm text-amber-200">{catalog.intakes.filter((item) => !item.accepted).map((item) => <div key={item.intake_id}><strong>{item.definition_id}</strong>: {item.blockers.map((blocker) => `${blocker.code}: ${blocker.message}${blocker.question ? ` — ${blocker.question}` : ""}`).join("; ")}</div>)}</div>}
        </section>

        <section className="rounded-xl border border-stone-700 bg-[#211e1b] p-5">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-medium">Composition plan</h2><button disabled={busy} onClick={() => void perform(loadExample)} className="rounded border border-stone-600 px-3 py-2 text-sm disabled:opacity-50">Load notebook plan</button></div>
          <p className="mt-2 text-sm text-stone-400">Edit the plan JSON to select packages and define bindings, workflows, documents, views, and scenarios.</p>
          <textarea aria-label="Composition plan JSON" spellCheck={false} value={planText} onChange={(event) => { setPlanText(event.target.value); setValidation(null); }} className="mt-4 h-72 w-full resize-y rounded border border-stone-600 bg-[#141210] p-3 font-mono text-xs text-stone-200" />
          <div className="mt-3 flex gap-2"><button disabled={busy || !planText} onClick={() => void perform(async () => { setValidation(await validateComposition(parsePlan())); })} className="rounded border border-stone-600 px-3 py-2 text-sm disabled:opacity-50">Validate</button><button disabled={busy || !planText || job?.status === "queued" || job?.status === "running"} onClick={() => void perform(buildPlan)} className="rounded bg-emerald-500 px-3 py-2 text-sm font-medium text-stone-950 disabled:opacity-50">Build application</button></div>
          {validation && <div role="status" className="mt-4 text-sm"><p className={validation.ok ? "text-emerald-300" : "text-amber-200"}>{validation.ok ? "Plan structure and bindings passed" : `${validation.errors.length} plan blocker(s)`}</p>{validation.errors.map((item, index) => <p key={`${item.path}-${index}`} className="mt-1 text-amber-200">{item.path}: {item.message}{item.question ? ` — ${item.question}` : ""}</p>)}</div>}
          {job && <div className="mt-4 rounded border border-stone-700 p-3 text-sm"><div className="flex justify-between"><span>Build job: {job.status}</span>{["queued", "running"].includes(job.status) && <button onClick={() => void perform(async () => { setJob(await cancelJob(job.job_id)); })} className="text-amber-300">Cancel</button>}</div><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-stone-400">{activity.join("\n")}</pre></div>}
        </section>

        <section className="rounded-xl border border-stone-700 bg-[#211e1b] p-5">
          <h2 className="text-lg font-medium">Built applications</h2>
          <div className="mt-3 flex flex-wrap gap-2">{apps.map((app) => <button key={app.app_id} disabled={busy || transcribing} onClick={() => void perform(async () => selectRecord(await getLatestRevision(app.app_id)))} className="rounded border border-stone-600 px-3 py-2 text-sm disabled:opacity-50">{app.title} · revision {app.revision}</button>)}</div>
          {record && <div className="mt-5 space-y-3"><p className="text-sm text-emerald-300">{record.bundle.title} · revision {record.revision} · {record.status}{selectedActive ? " · active" : ""}</p>
            {history?.app_id === record.app_id && history.revisions.length > 1 && <div className="flex items-center gap-3 text-sm">
              <label>Revision <select aria-label="Application revision" disabled={transcribing} value={record.revision} onChange={(event) => void perform(async () => selectRecord(await getRevision(record.app_id, Number(event.target.value))))} className="ml-2 rounded border border-stone-600 bg-[#141210] p-2">{history.revisions.map((entry) => <option key={entry.revision} value={entry.revision}>{entry.revision}{entry.revision === history.active_revision ? " (active)" : ""}</option>)}</select></label>
              <button disabled={busy || selectedActive || record.status !== "verified"} onClick={() => void perform(async () => { const activated = await activateApplicationRevision(record.app_id, record.revision); selectRecord(activated); setHistory(await listApplicationRevisions(record.app_id)); await refresh(); })} className="rounded border border-stone-600 px-3 py-2 disabled:opacity-50">Activate revision</button>
            </div>}
            {history?.app_id === record.app_id && !selectedActive && <p className="text-sm text-amber-200">Activate this revision to preview or export it.</p>}
            <label className="block text-sm">Workflow <select disabled={transcribing} value={workflow} onChange={(event) => { setWorkflow(event.target.value); if (selectedPlan) { setInputText(JSON.stringify(sampleInput(selectedPlan, event.target.value), null, 2)); setEditsText(JSON.stringify(sampleEdits(selectedPlan, event.target.value), null, 2)); } }} className="ml-2 rounded border border-stone-600 bg-[#141210] p-2">{selectedPlan?.workflows.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <textarea aria-label="Workflow input JSON" spellCheck={false} disabled={transcribing} value={inputText} onChange={(event) => setInputText(event.target.value)} className="h-40 w-full resize-y rounded border border-stone-600 bg-[#141210] p-3 font-mono text-xs" />
            <label className="block text-sm">Document edits for preview<textarea aria-label="Document edits JSON" spellCheck={false} disabled={transcribing} value={editsText} onChange={(event) => setEditsText(event.target.value)} className="mt-2 h-28 w-full resize-y rounded border border-stone-600 bg-[#141210] p-3 font-mono text-xs" /></label>
            {selectedActive && acceptsTranscript && <div className="rounded border border-stone-700 p-3 text-sm">
              <p className="font-medium">Import speech with AWS Transcribe</p>
              <p className="mt-1 text-xs text-stone-400">External provider substitution. Record a microphone or upload mono 16-bit PCM WAV; finalized speech segments fill the workflow input.</p>
              <p className="mt-1 text-xs text-stone-400">{transcription?.detail ?? "Checking provider configuration…"}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button disabled={transcribing || recording || capturing} onClick={() => void recordMicrophone()} className="rounded border border-stone-600 px-3 py-2 disabled:opacity-50">Record microphone</button>
                {recording && <><button onClick={() => microphone.current?.stop()} className="rounded border border-stone-600 px-3 py-2">Stop recording</button><button onClick={() => microphone.current?.discard()} className="text-stone-400">Discard recording</button></>}
                <input ref={audioInput} aria-label="Speech WAV file" type="file" accept=".wav,audio/wav" disabled={transcribing || recording || capturing} onChange={(event) => setAudioFile(event.target.files?.[0] ?? null)} className="text-xs" />
                <input aria-label="Transcription access key" type="password" autoComplete="off" value={transcriptionToken} disabled={transcribing} onChange={(event) => setTranscriptionToken(event.target.value)} placeholder="Workspace access key" className="rounded border border-stone-600 bg-[#141210] px-3 py-2 text-xs" />
                <button disabled={!transcription?.configured || !audioFile || transcriptionToken.length < 32 || activeSessionId !== null || transcribing || recording || capturing || busy} onClick={() => void startTranscription()} className="rounded border border-stone-600 px-3 py-2 disabled:opacity-50">Transcribe WAV</button>
                {activeSessionId && !transcribing && <button disabled={transcriptionToken.length < 32} onClick={() => void reconnectTranscription()} className="rounded border border-stone-600 px-3 py-2 disabled:opacity-50">Reconnect saved transcription</button>}
                {activeSessionId && <button disabled={transcriptionToken.length < 32} onClick={() => void cancelTranscription()} className="text-amber-300">Cancel transcription job</button>}
              </div>
              {activeSessionId && <p className="mt-1 font-mono text-xs text-stone-400">Saved transcription: {activeSessionId}. Enter the workspace key to reconnect after a reload.</p>}
              {audioFile && <p className="mt-1 text-xs text-stone-400">Selected audio: {audioFile.name} ({Math.ceil(audioFile.size / 1024)} KiB)</p>}
              {transcriptionNotice && <p role="status" className="mt-2 text-xs text-stone-300">{transcriptionNotice}</p>}
              {audioId && <p className="mt-1 break-all font-mono text-xs text-stone-500">Stored audio: {audioId}</p>}
              {liveSegments.length > 0 && <ol className="mt-2 space-y-1 text-xs text-stone-300">{liveSegments.map((item) => <li key={item.index}>{(item.start_ms / 1000).toFixed(1)}s · {item.text}{item.final ? "" : " …"}</li>)}</ol>}
            </div>}
            <div className="flex gap-2"><button disabled={busy || !workflow || !selectedActive} onClick={() => void perform(async () => setPreview(await previewApplication(record.app_id, { workflow, input: JSON.parse(inputText), document_edits: JSON.parse(editsText) })))} className="rounded bg-amber-400 px-3 py-2 text-sm font-medium text-stone-950 disabled:opacity-50">Run preview</button><button disabled={busy || !selectedActive} onClick={() => void perform(downloadExport)} className="rounded border border-stone-600 px-3 py-2 text-sm disabled:opacity-50">Download Electron source</button></div>
            {preview && <pre aria-live="polite" className="max-h-96 overflow-auto rounded border border-stone-700 bg-[#141210] p-3 text-xs">{JSON.stringify(preview, null, 2)}</pre>}
          </div>}
        </section>
      </div>
    </div>
  );
}
