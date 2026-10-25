// Live Step 3 test bench: implement engines from authored specs, then fuse them, against the real backend.
// Specs come straight from fixtures/ (no REA or spec-writing step). Every run calls Bedrock.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  SandpackProvider,
  SandpackLayout,
  SandpackPreview,
  SandpackCodeEditor,
  SandpackFileExplorer,
  type SandpackFiles,
} from "@codesandbox/sandpack-react";
import { Download, FlaskConical, Square } from "lucide-react";
import {
  FeatureSpec,
  type FeatureBlueprint,
  type HealthResponse,
  type SynthesisBundle,
} from "@splice/contracts";
import { liveApi } from "../api/client";
import { useIdeStore } from "./store/useIdeStore";
import { exportBundleJson } from "../lib/exportZip";
import { exportElectronProject } from "../lib/electronProject";
import { WorkspaceButton } from "./WorkspaceButton";
import { cn } from "../lib/cn";

const SOURCES = {
  handAuthored: {
    label: "Eng 2 · hand-authored",
    files: import.meta.glob("@fixtures/hand-authored/specs/*.json", { eager: true, import: "default" }),
  },
  seed: {
    label: "Authored seeds",
    files: import.meta.glob("@fixtures/specs/_seed/*.json", { eager: true, import: "default" }),
  },
  native: {
    label: "Native · Task Priority (ELF)",
    files: import.meta.glob("@fixtures/specs/_seed/mockpriority*.json", { eager: true, import: "default" }),
  },
} as const;
type SourceId = keyof typeof SOURCES;

/** Must match the "study" recipe in packages/backend/src/scripts/testSynthesis.ts. */
const STUDY_PROMPT =
  "Build a study app for a medical student: notes link to each other with [[wiki links]], show each note's backlinks, and turn every note into a flashcard scheduled with spaced repetition. Show what's due today.";

function loadSpecs(source: SourceId): { specs: FeatureSpec[]; errors: string[] } {
  const specs: FeatureSpec[] = [], errors: string[] = [];
  for (const [file, value] of Object.entries(SOURCES[source].files)) {
    const parsed = FeatureSpec.safeParse(value);
    if (parsed.success) specs.push(parsed.data);
    else errors.push(`${file.split("/").pop()}: ${parsed.error.issues[0]?.message ?? "invalid spec"}`);
  }
  return { specs, errors };
}

interface EngineRun {
  status: "running" | "passed" | "failed" | "cancelled";
  message: string;
  testsPassed: number;
  testsRun: number;
  blueprint?: FeatureBlueprint;
  error?: string;
  seconds?: number;
}
interface LogLine { at: number; tag: string; text: string; tone?: "error" | "ok" }

export function PipelineTest() {
  const [source, setSource] = useState<SourceId>("handAuthored");
  const nativeHandoff = useIdeStore(s => s.nativeHandoff);
  const { specs, errors: specErrors } = useMemo(() => {
    const loaded = loadSpecs(source);
    if (source !== "native" || !nativeHandoff) return loaded;
    return {
      ...loaded,
      specs: [
        ...loaded.specs.filter(spec => spec.feature_id !== nativeHandoff.spec.feature_id),
        nativeHandoff.spec,
      ],
    };
  }, [source, nativeHandoff]);
  const [selected, setSelected] = useState<string[]>([]);
  const [runs, setRuns] = useState<Record<string, EngineRun>>({});
  const [prompt, setPrompt] = useState(STUDY_PROMPT);
  const [phase, setPhase] = useState<"idle" | "implementing" | "synthesizing">("idle");
  const [bundle, setBundle] = useState<SynthesisBundle | null>(null);
  const [synthError, setSynthError] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [health, setHealth] = useState<HealthResponse | string | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    if (nativeHandoff) setSource("native");
  }, [nativeHandoff]);
  useEffect(() => {
    setSelected(specs.map(s => s.feature_id));
    const handoffSpec = nativeHandoff && specs.find(s => s.feature_id === nativeHandoff.spec.feature_id);
    setRuns(handoffSpec ? {
      [handoffSpec.feature_id]: {
        status: "passed",
        message: "Native engine implementation verified",
        testsPassed: nativeHandoff.blueprint.verification.passed,
        testsRun: nativeHandoff.blueprint.verification.total,
        blueprint: nativeHandoff.blueprint,
      },
    } : {});
    setBundle(null);
  }, [specs, nativeHandoff]);
  useEffect(() => {
    const abort = new AbortController();
    liveApi.health(abort.signal).then(setHealth, (e: Error) => { if (!abort.signal.aborted) setHealth(e.message); });
    return () => abort.abort();
  }, []);
  useEffect(() => () => controller.current?.abort(), []);

  const append = (tag: string, text: string, tone?: LogLine["tone"]) =>
    setLog(l => [...l.slice(-400), { at: Date.now(), tag, text, tone }]);
  const patch = (id: string, value: Partial<EngineRun>) =>
    setRuns(r => ({ ...r, [id]: { ...r[id], ...value } }));

  async function implementOne(spec: FeatureSpec, signal: AbortSignal) {
    const id = spec.feature_id, started = performance.now();
    let blueprint: FeatureBlueprint | undefined;
    let done = false, ok = false, fatal: string | undefined;
    setRuns(r => ({ ...r, [id]: { status: "running", message: "Starting", testsPassed: 0, testsRun: 0 } }));
    try {
      await liveApi.implement(spec, e => {
        if (e.type === "stage") {
          patch(id, { message: e.message, ...(e.stage === "testing" ? { testsPassed: 0, testsRun: 0 } : {}) });
          append(id, `${e.stage} · ${e.message}`);
        } else if (e.type === "llm_progress") {
          patch(id, { message: `${e.phase === "implementing" ? "Writing engine" : "Repairing engine"} · ${e.output_chars.toLocaleString()} chars` });
        } else if (e.type === "test_result") {
          setRuns(r => ({ ...r, [id]: { ...r[id], testsRun: r[id].testsRun + 1, testsPassed: r[id].testsPassed + (e.passed ? 1 : 0) } }));
          if (!e.passed) append(id, `✗ ${e.name}${e.error ? ` — ${e.error}` : ""}`, "error");
        } else if (e.type === "blueprint") {
          blueprint = e.blueprint;
          const v = e.blueprint.verification;
          append(id, `${v.status} · ${v.passed}/${v.total} tests · ${v.repair_attempts} repairs · ${v.model} (${v.mode})`, v.status === "passed" ? "ok" : "error");
        } else if (e.type === "error") {
          append(id, e.message, "error");
          if (e.fatal) {
            fatal = e.message;
            patch(id, { error: e.message });
          }
        } else if (e.type === "done") {
          done = true;
          ok = e.ok;
        }
      }, signal, { force_mode: "live" });
      const passed = done && ok && !fatal && blueprint?.feature_id === id &&
        blueprint.verification.status === "passed" &&
        blueprint.verification.total > 0 &&
        blueprint.verification.passed === blueprint.verification.total &&
        blueprint.verification.purity_violations.length === 0 &&
        blueprint.verification.type_errors.length === 0;
      patch(id, { status: passed ? "passed" : "failed", blueprint, message: passed ? "Engine verified" : fatal ?? "Engine did not pass", seconds: (performance.now() - started) / 1000 });
    } catch (error) {
      const cancelled = signal.aborted;
      patch(id, { status: cancelled ? "cancelled" : "failed", message: cancelled ? "Cancelled" : "Request failed", error: cancelled ? undefined : (error as Error).message, seconds: (performance.now() - started) / 1000 });
      if (!cancelled) append(id, (error as Error).message, "error");
    }
  }

  async function implementSelected() {
    const abort = new AbortController(); controller.current = abort;
    setPhase("implementing"); setBundle(null); setSynthError(null);
    await Promise.all(specs.filter(s => selected.includes(s.feature_id)).map(s => implementOne(s, abort.signal)));
    setPhase("idle");
  }

  const passedBlueprints = specs
    .filter(spec => runs[spec.feature_id]?.status === "passed")
    .map(spec => runs[spec.feature_id].blueprint)
    .filter((bp): bp is FeatureBlueprint => bp?.verification.status === "passed");
  const excluded = specs.filter(s => selected.includes(s.feature_id) && runs[s.feature_id] &&
    runs[s.feature_id].status !== "running" && runs[s.feature_id].status !== "passed");

  async function synthesize() {
    const abort = new AbortController(); controller.current = abort;
    setPhase("synthesizing"); setBundle(null); setSynthError(null);
    let failure: string | null = null;
    let candidate: SynthesisBundle | undefined;
    let done = false, ok = false;
    try {
      await liveApi.synthesize(passedBlueprints, prompt.trim(), e => {
        if (e.type === "stage") append("synthesize", `${e.stage} · ${e.message}`);
        else if (e.type === "validation") append("synthesize", e.ok ? "Validation passed" : `Validation failed: ${e.errors.join("; ")}`, e.ok ? "ok" : "error");
        else if (e.type === "bundle") candidate = e.bundle;
        else if (e.type === "error") { append("synthesize", e.message, "error"); if (e.fatal) failure = e.message; }
        else if (e.type === "done") { done = true; ok = e.ok; }
      }, abort.signal);
      if (!failure && done && ok && candidate) {
        setBundle(candidate);
        append("synthesize", `Bundle ready · ${Object.keys(candidate.files).length} files (${candidate.mode})`, "ok");
      } else {
        failure ??= "Synthesis did not produce a successful bundle";
      }
    } catch (error) {
      failure = abort.signal.aborted ? "Cancelled" : (error as Error).message;
    }
    setSynthError(failure);
    setPhase("idle");
  }

  const busy = phase !== "idle";
  const healthy = typeof health === "object" && health !== null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-stone-800 px-8">
        <h1 className="flex items-center gap-2 text-sm font-medium">
          <FlaskConical className="size-4 text-amber-400" aria-hidden="true" />
          Pipeline test
        </h1>
        <p className="text-xs text-stone-400" role="status">
          {health === null ? "Checking backend…"
            : healthy ? <>Backend connected · LLM {health.llm_mode} · {health.models.engine_writer ?? health.model}</>
            : <span className="text-red-300">Backend unreachable. Run <code>npm run dev</code>. ({health})</span>}
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto grid max-w-6xl gap-6">
          <p className="max-w-3xl text-pretty text-sm leading-6 text-stone-400">
            Implements an engine from each spec with the configured model, runs its acceptance tests in the sandbox,
            then fuses the passing engines into an app. This skips REA and spec writing. Every run calls Bedrock and costs money.
          </p>
          {nativeHandoff && source === "native" && (
            <p role="status" className="text-xs text-emerald-300">
              Native engine implementation verified · ready to fuse into a Studio preview.
            </p>
          )}
          {healthy && health.llm_mode === "replay" && (
            <p role="alert" className="rounded-lg border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-200">
              The backend is in LLM replay mode. Engines are forced live, but synthesis will replay a recording if one exists.
            </p>
          )}

          <section aria-labelledby="specs-heading" className="rounded-xl border border-stone-800 bg-stone-900/40 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="specs-heading" className="text-base font-semibold">1. Implement engines</h2>
              <div role="radiogroup" aria-label="Spec source" className="flex rounded-lg bg-stone-900 p-1">
                {(Object.keys(SOURCES) as SourceId[]).map(id => (
                  <button key={id} type="button" role="radio" aria-checked={source === id} disabled={busy}
                    onClick={() => setSource(id)}
                    className={cn("min-h-9 rounded-md px-3 text-xs font-medium text-stone-400 disabled:opacity-40",
                      source === id && "bg-stone-800 text-stone-100")}>
                    {SOURCES[id].label}
                  </button>
                ))}
              </div>
            </div>
            {specErrors.map(e => <p key={e} role="alert" className="mt-3 text-sm text-red-300">{e}</p>)}
            <ul className="mt-4 grid gap-3 md:grid-cols-2">
              {specs.map(spec => {
                const run = runs[spec.feature_id];
                return (
                  <li key={spec.feature_id} className="rounded-lg border border-stone-800 bg-[#1d1a17] p-4">
                    <label className="flex items-start gap-3">
                      <input type="checkbox" className="mt-1 size-4 accent-amber-400" disabled={busy}
                        checked={selected.includes(spec.feature_id)}
                        onChange={e => setSelected(s => e.target.checked ? [...s, spec.feature_id] : s.filter(id => id !== spec.feature_id))} />
                      <span className="min-w-0">
                        <span className="block font-medium">{spec.consumer_title}</span>
                        <span className="block font-mono text-xs text-stone-500">{spec.feature_id}</span>
                        <span className="mt-1 block text-xs text-stone-400">
                          Spec {spec.status} · oracle {spec.oracle.status} ({spec.oracle.passed}/{spec.oracle.total}) · {spec.requirements.length} requirements
                        </span>
                      </span>
                    </label>
                    {run && (
                      <div className="mt-3 border-t border-stone-800 pt-3 text-xs" aria-live="polite">
                        <p className={cn("font-medium",
                          run.status === "passed" ? "text-emerald-400" : run.status === "running" ? "text-amber-300" : "text-red-300")}>
                          {run.status === "running" ? run.message : `${run.status.toUpperCase()} · ${run.message}`}
                        </p>
                        <p className="mt-1 tabular-nums text-stone-400">
                          {run.blueprint
                            ? `${run.blueprint.verification.passed}/${run.blueprint.verification.total} tests · ${run.blueprint.verification.repair_attempts} repairs · purity ${run.blueprint.verification.purity_violations.length} · type errors ${run.blueprint.verification.type_errors.length}`
                            : `${run.testsPassed}/${run.testsRun} tests so far`}
                          {run.seconds !== undefined && ` · ${run.seconds.toFixed(1)} s`}
                        </p>
                        {run.error && <p className="mt-1 break-words text-red-300">{run.error}</p>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              <WorkspaceButton primary isDisabled={busy || !healthy || !selected.length} onPress={() => void implementSelected()}>
                {phase === "implementing" ? "Implementing…" : `Implement ${selected.length} engine${selected.length === 1 ? "" : "s"}`}
              </WorkspaceButton>
              {busy && (
                <WorkspaceButton onPress={() => controller.current?.abort()}>
                  <Square className="size-3.5" aria-hidden="true" /> Cancel
                </WorkspaceButton>
              )}
            </div>
          </section>

          <section aria-labelledby="fuse-heading" className="rounded-xl border border-stone-800 bg-stone-900/40 p-5">
            <h2 id="fuse-heading" className="text-base font-semibold">2. Fuse into an app</h2>
            <label htmlFor="fuse-prompt" className="mt-4 block text-sm text-stone-400">App request</label>
            <textarea id="fuse-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} disabled={busy} maxLength={2000} rows={3}
              className="mt-2 w-full rounded-lg border border-stone-700 bg-stone-950 p-3 text-sm outline-none focus:ring-2 focus:ring-amber-400" />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <WorkspaceButton primary isDisabled={busy || !healthy || !passedBlueprints.length || prompt.trim().length < 3}
                onPress={() => void synthesize()}>
                {phase === "synthesizing" ? "Fusing…" : `Fuse ${passedBlueprints.length} verified engine${passedBlueprints.length === 1 ? "" : "s"}`}
              </WorkspaceButton>
              {!passedBlueprints.length && <span className="text-xs text-stone-500">Needs at least one engine that passed.</span>}
            </div>
            {!!excluded.length && (
              <p className="mt-3 text-xs text-amber-200">
                Left out because their engines did not pass: {excluded.map(s => s.consumer_title).join(", ")}. The app will not include them.
              </p>
            )}
            {synthError && <p role="alert" className="mt-3 break-words text-sm text-red-300">{synthError}</p>}
          </section>

          <section aria-labelledby="log-heading">
            <div className="flex items-center justify-between">
              <h2 id="log-heading" className="text-sm font-semibold">Activity</h2>
              {!!log.length && <WorkspaceButton isDisabled={busy} onPress={() => setLog([])} className="min-h-8 text-xs">Clear</WorkspaceButton>}
            </div>
            <ol className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-stone-800 bg-[#100e0d] p-3 font-mono text-xs leading-5" aria-live="polite">
              {!log.length && <li className="text-stone-500">No runs yet.</li>}
              {log.map((line, i) => (
                <li key={i} className={cn("break-words", line.tone === "error" ? "text-red-300" : line.tone === "ok" ? "text-emerald-400" : "text-stone-300")}>
                  <time className="text-stone-600">{new Date(line.at).toLocaleTimeString()}</time>{" "}
                  <span className="text-amber-300/80">{line.tag}</span> {line.text}
                </li>
              ))}
            </ol>
          </section>

          {bundle && <BundlePreview bundle={bundle} />}
        </div>
      </div>
    </div>
  );
}

/** Sandpack copies <script> tags from /public/index.html without running them, so inject Tailwind here. */
const TAILWIND_CDN = ["https://cdn.tailwindcss.com/3.4.17"];

function BundlePreview({ bundle }: { bundle: SynthesisBundle }) {
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const files = useMemo(() => Object.fromEntries(Object.entries(bundle.files).map(([path, code]) => [path, {
    code,
    readOnly: bundle.engine_paths.includes(path) || !bundle.generated_paths.includes(path),
    hidden: path === "/public/index.html" || path === "/styles.css",
    active: path === "/App.tsx",
  }])) as SandpackFiles, [bundle]);
  return (
    <section aria-labelledby="bundle-heading" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="bundle-heading" className="text-base font-semibold">{bundle.app_title}</h2>
          <p className="text-xs text-stone-400">{bundle.mode === "replay" ? "Replay" : "Live"} bundle · revision {bundle.revision} · engines in /engines are locked</p>
        </div>
        <div className="flex gap-1">
          {(["preview", "code"] as const).map(t => (
            <WorkspaceButton key={t} aria-pressed={tab === t} onPress={() => setTab(t)} className={cn(tab === t && "bg-stone-800 text-stone-100")}>
              {t === "preview" ? "Preview" : "Code"}
            </WorkspaceButton>
          ))}
          <WorkspaceButton onPress={() => exportBundleJson(bundle)}>
            <Download className="size-4" aria-hidden="true" /> Bundle JSON
          </WorkspaceButton>
          <WorkspaceButton onPress={() => void exportElectronProject(bundle)}>
            <Download className="size-4" aria-hidden="true" /> Electron project
          </WorkspaceButton>
        </div>
      </div>
      {!!bundle.warnings.length && (
        <ul className="text-xs text-amber-200">{bundle.warnings.map(w => <li key={w}>{w}</li>)}</ul>
      )}
      <SandpackProvider key={`${bundle.bundle_id}:${bundle.revision}`} template="react-ts" theme="dark" files={files}
        customSetup={{ dependencies: bundle.dependencies }}
        options={{ recompileMode: "delayed", recompileDelay: 500, externalResources: TAILWIND_CDN }}>
        <SandpackLayout style={{ height: 640 }}>
          {tab === "code" && (
            <div className="flex h-full w-full min-w-0">
              <div className="w-40 shrink-0 overflow-auto"><SandpackFileExplorer /></div>
              <div className="min-w-0 flex-1"><SandpackCodeEditor showTabs showLineNumbers style={{ height: "100%" }} /></div>
            </div>
          )}
          <div className="h-full w-full min-w-0" style={{ display: tab === "preview" ? "flex" : "none" }}>
            <SandpackPreview showOpenInCodeSandbox={false} showRefreshButton style={{ height: "100%", flex: 1 }} />
          </div>
        </SandpackLayout>
      </SandpackProvider>
    </section>
  );
}
