// Scripted reconstruction runs for demo mode: the stages and figures of recorded run 2, played on a timer.
import type { FeatureSpec, PipelineEvent, PipelineStage } from "@splice/contracts";
import { demoSpeed } from "./mode";
import {
  CALC_FEATURE, CALC_ORACLE_TESTS, CALC_TESTS, DEMO_BLUEPRINTS, DEMO_SPECS,
  OBSIDIAN_FEATURE, OBSIDIAN_ORACLE_TESTS, OBSIDIAN_TESTS,
} from "./fixtures";

type Step = [PipelineStage, string, number];

const SCRIPTS: Record<string, { before: Step[]; codeChars: number; repair: string; oracle: string; complete: string }> = {
  [OBSIDIAN_FEATURE]: {
    before: [
      ["analyzing", "Reading the Obsidian app archive (28.18 MB, sha256 3a349274…)", 1200],
      ["analyzing", "Runtime inventory: 47 main-process IPC channels; none render Markdown, so switching to UI discovery", 1800],
      ["tracing", "Driving the original editor in an isolated display: created a vault and a fixture note", 2000],
      ["tracing", "Recorded 15 UI observations; replaying them against a fresh copy of Obsidian", 2000],
      ["tracing", "Replay passed: all 15 observations reproduce on the original", 1000],
      ["specifying", "Writing 7 behavioral requirements, each citing a replayed observation", 2000],
      ["checking_oracle", "Sealing 3 held-out original cases away from the implementer", 1000],
    ],
    codeChars: 10_037,
    repair: "Repair 1/2: nested list and blockquote closing tags tightened",
    oracle: "Held-out check: comparing against Obsidian's recorded reading view",
    complete: "Engine verified: 8/8 checks pass · 6/6 mutants killed",
  },
  [CALC_FEATURE]: {
    before: [
      ["analyzing", "Importing the LibreOffice 24.2.7.2 Calc library into Ghidra (sha256 c5af49a6…)", 1200],
      ["analyzing", "Runtime triage over UNO: tracing sort, insert and delete calls into the library", 1800],
      ["tracing", "Decompiling 20 functions: ScDocument::InsertRow, DeleteRow, InsertCol, DeleteCol…", 2000],
      ["tracing", "19 functions drafted and independently reviewed: 46 claims, 35 statically supported", 2000],
      ["checking_oracle", "Recorded 6 original LibreOffice outputs over UNO", 1000],
      ["specifying", "Writing 8 behavioral requirements from reviewed claims and original cases", 2000],
      ["checking_oracle", "Sealing the original outputs away from the implementer", 1000],
    ],
    codeChars: 10_029,
    repair: "Repair 1/2: multi-key sort tie-breaking corrected",
    oracle: "Original-behavior check: replaying LibreOffice's recorded outputs",
    complete: "Engine verified: 10/10 checks pass · 8/8 mutants killed",
  },
};
const TESTS: Record<string, [string[], string[]]> = {
  [OBSIDIAN_FEATURE]: [OBSIDIAN_TESTS, OBSIDIAN_ORACLE_TESTS],
  [CALC_FEATURE]: [CALC_TESTS, CALC_ORACLE_TESTS],
};

export const isDemoFeature = (featureId: string | undefined) => !!featureId && featureId in SCRIPTS;

export function demoSpec(featureId: string): FeatureSpec {
  const spec = DEMO_SPECS.find((s) => s.feature_id === featureId);
  if (!spec) throw new Error(`No demo specification for ${featureId}`);
  return spec;
}

async function pause(ms: number, speed: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("Cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms / speed);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Plays one feature's reconstruction (about 20 s at speed 1) and ends with its verified blueprint. */
export async function playDemoRun(spec: FeatureSpec, on: (e: PipelineEvent) => void, signal?: AbortSignal, speed = demoSpeed) {
  const script = SCRIPTS[spec.feature_id], blueprint = DEMO_BLUEPRINTS.find((b) => b.feature_id === spec.feature_id);
  if (!script || !blueprint) throw new Error(`No demo run for ${spec.feature_id}`);
  const [acceptance, oracle] = TESTS[spec.feature_id];
  const base = { run_id: `run-${spec.app_id}-2`, feature_id: spec.feature_id };
  const emit = (e: Record<string, unknown>) => on({ ...base, ts: Date.now(), ...e } as PipelineEvent);
  const stage = (s: PipelineStage, message: string) => emit({ type: "stage", stage: s, message });

  emit({ type: "stage", stage: "queued", message: `Reconstructing ${spec.consumer_title} from ${spec.source_app}` });
  for (const [s, message, ms] of script.before) { stage(s, message); await pause(ms, speed, signal); }

  stage("implementing", `Implementing ${spec.interface.module_name} from ${spec.requirements.length} requirements (original source withheld)`);
  for (let i = 1; i <= 8; i++) {
    await pause(400, speed, signal);
    emit({ type: "llm_progress", phase: "implementing", output_chars: Math.round((script.codeChars * i) / 8) });
  }
  stage("repairing_engine", script.repair);
  await pause(1200, speed, signal);

  stage("testing", `Running ${acceptance.length} public test suites against the new engine`);
  for (const name of acceptance) { await pause(300, speed, signal); emit({ type: "test_result", name, kind: "acceptance", passed: true, error: null }); }
  stage("testing", script.oracle);
  for (const name of oracle) { await pause(250, speed, signal); emit({ type: "test_result", name, kind: "oracle", passed: true, error: null }); }

  stage("complete", script.complete);
  emit({ type: "blueprint", blueprint });
  emit({ type: "done", ok: true, replayed: true });
}
