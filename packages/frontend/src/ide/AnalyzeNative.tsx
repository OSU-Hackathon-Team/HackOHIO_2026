// Start a native decompilation run from Studio and follow it live (backend: /api/decomp/*).
// A run costs real model spend on the EC2 worker, so the estimate is shown and confirmed first.

import { useEffect, useState } from "react";
import { Dialog, DialogTrigger, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Binary, CheckCircle2, Loader2, Play, TriangleAlert } from "lucide-react";
import type { DecompTarget } from "@splice/contracts";
import { api } from "../api/client";
import { liveNativeTargetId } from "./data/liveNative";
import { useIdeStore } from "./store/useIdeStore";
import { WorkspaceButton } from "./WorkspaceButton";

const STAGE_LABELS: Record<string, string> = {
  queued: "Queued", uploading: "Packaging analysis code", instance_starting: "Starting the analysis worker",
  setup: "Preparing tools", triage: "Observing the program at runtime", analyze: "Decompiling the observed functions",
  scope: "Choosing the functions to analyse", claims: "Drafting and reviewing behavior claims",
  oracle: "Checking results from the real program", dossier: "Assembling the evidence", spec: "Writing the specification",
  importing: "Importing results", complete: "Complete", failed: "Failed",
};

export function AnalyzeNative() {
  const run = useIdeStore((s) => s.decompRun);
  const [targets, setTargets] = useState<DecompTarget[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [budget, setBudget] = useState<number | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.decompTargets?.(controller.signal)
      .then((value) => {
        setEnabled(value.enabled);
        setTargets(value.targets);
        setTargetId(value.targets[0]?.id ?? null);
        setBudget(value.targets[0]?.function_budgets[0] ?? null);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setEnabled(false);
        setUnavailable(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, []);

  const target = targets.find((t) => t.id === targetId) ?? targets[0];
  if (!api.decompTargets) return null; // offline mock mode has no worker
  if (!target) {
    return (
      <div className="mb-6 rounded-xl border border-indigo-900/60 bg-indigo-950/30 p-4 text-xs leading-5 text-stone-400">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-indigo-100">
          <Binary className="size-4 text-indigo-400" aria-hidden="true" /> Analyze a native application
        </h2>
        <p className="mt-1">
          {unavailable
            ? `The backend did not answer /api/decomp/targets (${unavailable}). Restart it from the current code.`
            : "Checking the analysis worker..."}
        </p>
      </div>
    );
  }
  const running = run !== null && !run.finished;
  const cost = budget ? target.estimated_cost_usd[String(budget)] : undefined;

  const start = async () => {
    if (!budget) return;
    setStartError(null);
    try {
      await useIdeStore.getState().startDecompRun(target.id, budget);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    }
  };

  const openResult = () => {
    const artifact = run?.result?.spec_artifact;
    if (artifact) useIdeStore.setState({ selectedFeatureId: `${liveNativeTargetId(artifact)}.subsystem` });
  };

  return (
    <div className="mb-6 rounded-xl border border-indigo-900/60 bg-indigo-950/30 p-4">
      <div className="flex items-start gap-3">
        <Binary className="mt-0.5 size-5 shrink-0 text-indigo-400" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-indigo-100">Analyze a native application</h2>
          <p className="mt-1 text-xs leading-5 text-indigo-300/80">
            {target.name}: {target.description}
          </p>
        </div>
      </div>

      {enabled === false ? (
        <p className="mt-3 text-xs leading-5 text-stone-400">
          Runs are disabled on this backend. Set <code>DECOMP_EC2_ENABLED=1</code>,{" "}
          <code>DECOMP_EC2_INSTANCE_ID</code> and <code>DECOMP_EC2_BUCKET</code> in the backend environment.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="text-xs text-stone-400" htmlFor="decomp-target">Application</label>
          <select
            id="decomp-target"
            className="rounded border border-stone-700 bg-stone-900 px-2 py-1 text-xs text-stone-200"
            value={target.id}
            disabled={running}
            onChange={(e) => {
              const next = targets.find((t) => t.id === e.target.value);
              setTargetId(e.target.value);
              setBudget(next?.function_budgets[0] ?? null);
            }}
          >
            {targets.map((t) => (
              <option key={t.id} value={t.id}>{t.name}{t.driver === "cli" ? " (command line)" : ""}</option>
            ))}
          </select>
          <label className="text-xs text-stone-400" htmlFor="decomp-budget">Functions</label>
          <select
            id="decomp-budget"
            className="rounded border border-stone-700 bg-stone-900 px-2 py-1 text-xs text-stone-200"
            value={budget ?? ""}
            disabled={running}
            onChange={(e) => setBudget(Number(e.target.value))}
          >
            {target.function_budgets.map((b) => (
              <option key={b} value={b}>{b} (about ${target.estimated_cost_usd[String(b)]?.toFixed(2)})</option>
            ))}
          </select>
          <DialogTrigger>
            <WorkspaceButton primary isDisabled={running || !budget || enabled === null}
              className="bg-indigo-600 text-white hover:bg-indigo-500">
              {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              {running ? "Analyzing..." : "Analyze"}
            </WorkspaceButton>
            <ModalOverlay className="builder-modal fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6">
              <Modal className="w-full max-w-md rounded-xl border border-stone-700 bg-stone-900 p-6">
                <Dialog role="alertdialog" className="outline-none">
                  {({ close }) => (
                    <>
                      <Heading slot="title" className="text-lg font-semibold">Start a decompilation run?</Heading>
                      <p className="mt-3 text-sm leading-6 text-stone-400">
                        This analyses {target.name}. It starts the analysis worker and uses model calls for {budget} functions,
                        estimated at <strong className="text-stone-200">${cost?.toFixed(2)}</strong>. It takes
                        about 10 to 20 minutes, and the worker stops itself when finished.
                      </p>
                      <div className="mt-6 flex justify-end gap-2">
                        <WorkspaceButton autoFocus onPress={close}>Cancel</WorkspaceButton>
                        <WorkspaceButton primary onPress={() => { close(); void start(); }}>Start run</WorkspaceButton>
                      </div>
                    </>
                  )}
                </Dialog>
              </Modal>
            </ModalOverlay>
          </DialogTrigger>
        </div>
      )}

      {startError && <p className="mt-2 text-xs text-rose-400">Could not start: {startError}</p>}

      {run && (
        <div className="mt-4 border-t border-indigo-900/50 pt-3 text-xs" aria-live="polite">
          <div className="flex items-center gap-2 font-medium text-indigo-200">
            {running && <Loader2 className="size-3.5 animate-spin text-indigo-400" />}
            {run.finished && run.ok && <CheckCircle2 className="size-3.5 text-emerald-400" />}
            {run.finished && !run.ok && <TriangleAlert className="size-3.5 text-rose-400" />}
            <span>{STAGE_LABELS[run.stage] ?? run.stage}</span>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-stone-400">{run.message}</p>
          {run.drafted && (
            <p className="mt-2 tabular-nums text-stone-300">
              Drafted {run.drafted.done}/{run.drafted.total}
              {run.reviewed && <> · reviewed {run.reviewed.done}/{run.reviewed.total}</>}
            </p>
          )}
          {run.error && <p className="mt-2 text-rose-400">{run.error}</p>}
          {run.result && (
            <div className="mt-3 space-y-1 text-stone-300">
              <p>
                Evidence <strong>{run.result.readiness ?? "unknown"}</strong>
                {" · "}The original program confirmed {run.result.oracle.public_agreement} public and{" "}
                {run.result.oracle.held_out_agreement} held-out cases
              </p>
              <p className="tabular-nums">
                Claims: {Object.entries(run.result.claim_outcomes).map(([k, v]) => `${k.replace("_static", "")} ${v}`).join(", ") || "none"}
                {" · "}{(run.result.tokens.input / 1000).toFixed(0)}k input tokens
              </p>
              <p>
                {run.result.spec_artifact
                  ? `Specification: ${run.result.spec_status === "draft" ? "draft (needs more evidence before reconstruction)" : "ready for review"}`
                  : `No specification${run.result.spec_error ? `: ${run.result.spec_error}` : ""}`}
              </p>
              {run.result.handoff_path && <p className="text-stone-400">Handoff written to {run.result.handoff_path}</p>}
              {run.result.spec_artifact && (
                <WorkspaceButton className="mt-2 border border-indigo-800" onPress={openResult}>
                  View the result
                </WorkspaceButton>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
