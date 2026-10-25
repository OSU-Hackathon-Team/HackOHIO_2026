import { useState } from "react";
import {
  DisclosureGroup,
  Disclosure,
  DisclosurePanel,
  Heading,
  DialogTrigger,
  ModalOverlay,
  Modal,
  Dialog,
} from "react-aria-components";
import {
  ChevronRight,
  AppWindow,
  ArrowUpRight,
  Check,
  Plus,
  LockKeyhole,
  Binary,
  Cpu,
  CheckCircle2,
  Sparkles,
  Loader2,
  FileCode2,
  FileText,
} from "lucide-react";
import { IDE_TARGETS, IDE_FEATURES } from "./data/ideFixtures";
import { useIdeStore } from "./store/useIdeStore";
import { WorkspaceButton } from "./WorkspaceButton";
import { cn } from "../lib/cn";
import { api, developmentMode } from "../api/client";
import { mockApi } from "../api/mock";
import type { FeatureSpec, FeatureBlueprint, NativeSubsystemSpec } from "@splice/contracts";
import { useEffect } from "react";

export function AppLibrary() {
  const selectedId = useIdeStore((s) => s.selectedFeatureId);
  const included = useIdeStore((s) => s.includedFeatureIds);
  const busy = useIdeStore((s) => s.chatBusy);
  const toggle = useIdeStore((s) => s.toggleFeatureInBuild);
  const select = (id: string) =>
    useIdeStore.setState({ selectedFeatureId: id });
  const feature = IDE_FEATURES.find((f) => f.featureId === selectedId);
  const target = IDE_TARGETS.find((a) => a.id === feature?.targetId);
  const isNativeTarget = target?.engineKind === "ghidra_native";

  const available =
    feature &&
    feature.readiness !== "blocked" &&
    feature.readiness !== "needs_review";

  // Native reconstruction state
  const [reconstructing, setReconstructing] = useState(false);
  const [reconstructStage, setReconstructStage] = useState<string | null>(null);
  const [reconstructProgress, setReconstructProgress] = useState<string | null>(null);
  const [reconstructTests, setReconstructTests] = useState<{ passed: number; total: number } | null>(null);
  const [reconstructError, setReconstructError] = useState<string | null>(null);
  const [reconstructedBp, setReconstructedBp] = useState<FeatureBlueprint | null>(null);
  const [nativeSpecTab, setNativeSpecTab] = useState<"requirements" | "probes" | "spec">("requirements");

  const handleReconstructEngine = async () => {
    if (!feature || !target || reconstructing) return;
    setReconstructing(true);
    setReconstructStage("Adapting native specification...");
    setReconstructProgress("Connecting NativeSubsystemSpec to FeatureSpec adapter...");
    setReconstructError(null);
    setReconstructTests(null);

    try {
      // 1. Adapt NativeSubsystemSpec -> FeatureSpec
      const nativeSpec = target.nativeSpec;
      let adaptedSpec: FeatureSpec;
      if (!nativeSpec) throw new Error("No native specification available to adapt");
      if (developmentMode) {
        adaptedSpec = await mockApi.adaptNativeSpec!({
          spec: nativeSpec,
          feature_id: feature.featureId,
        });
      } else if (api.adaptNativeSpec) {
        adaptedSpec = await api.adaptNativeSpec({
          spec: nativeSpec,
          feature_id: feature.featureId,
        });
      } else {
        throw new Error("The configured API does not support native specification adaptation");
      }

      setReconstructStage("Implementing clean-room engine...");
      setReconstructProgress("Sending adapted FeatureSpec through Step 3 implementation pipeline...");

      let testsPassed = 0;
      let testsTotal = 0;
      let blueprint: FeatureBlueprint | undefined;
      let done = false;
      let ok = false;
      let fatal: string | undefined;

      await api.implement(adaptedSpec, (e) => {
        if (e.type === "stage") {
          setReconstructStage(e.message);
        } else if (e.type === "llm_progress") {
          setReconstructProgress(
            `${e.phase === "implementing" ? "Writing engine code" : "Repairing engine"} (${e.output_chars.toLocaleString()} chars)`
          );
        } else if (e.type === "test_result") {
          testsTotal += 1;
          if (e.passed) testsPassed += 1;
          setReconstructTests({ passed: testsPassed, total: testsTotal });
        } else if (e.type === "blueprint") {
          blueprint = e.blueprint;
        } else if (e.type === "error" && e.fatal) {
          fatal = e.message;
        } else if (e.type === "done") {
          done = true;
          ok = e.ok;
        }
      });

      if (fatal || !done || !ok || !blueprint) {
        throw new Error(fatal ?? "Native engine implementation did not complete successfully.");
      }
      const verification = blueprint.verification;
      if (blueprint.feature_id !== adaptedSpec.feature_id ||
          verification.status !== "passed" || verification.total === 0 ||
          verification.passed !== verification.total || verification.purity_violations.length ||
          verification.type_errors.length) {
        throw new Error("Native engine verification did not pass.");
      }
      useIdeStore.getState().setNativeHandoff(adaptedSpec, blueprint);
      setReconstructedBp(blueprint);
      setReconstructStage("Engine Reconstructed");
      setReconstructProgress(null);
      if (!included.includes(feature.featureId)) {
        toggle(feature.featureId);
      }
    } catch (err) {
      setReconstructError((err as Error).message);
    } finally {
      setReconstructing(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-stone-800 px-8 py-6">
        <h1 className="text-2xl font-semibold">App library</h1>
        <p className="mt-2 text-sm leading-6 text-stone-400">
          Open an application to explore the building blocks it contains.
        </p>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-5">
        <section
          aria-label="Source applications"
          className="col-span-2 overflow-y-auto border-r border-stone-800 p-6"
        >
          <div className="mb-5 flex items-center justify-between text-xs text-stone-400">
            <span>Source applications</span>
            <span className="tabular-nums">
              {IDE_TARGETS.length} applications
            </span>
          </div>
          <DisclosureGroup
            allowsMultipleExpanded
            className="divide-y divide-stone-800"
          >
            {IDE_TARGETS.map((app) => {
              const features = IDE_FEATURES.filter(
                (f) => f.targetId === app.id,
              );
              const isNative = app.engineKind === "ghidra_native";
              return (
                <Disclosure key={app.id} id={app.id} className="group py-2">
                  <Heading level={2}>
                    <WorkspaceButton
                      slot="trigger"
                      className="w-full justify-start px-2 py-4 text-left"
                    >
                      <ChevronRight
                        className="size-4 shrink-0 text-stone-500 group-data-[expanded]:rotate-90"
                        aria-hidden="true"
                      />
                      <span
                        className={cn(
                          "flex size-10 shrink-0 items-center justify-center rounded-lg border",
                          isNative
                            ? "border-indigo-700/60 bg-indigo-950/60"
                            : "border-stone-700 bg-stone-800"
                        )}
                      >
                        {isNative ? (
                          <Binary
                            className="size-5 text-indigo-400"
                            aria-hidden="true"
                          />
                        ) : (
                          <AppWindow
                            className="size-5 text-stone-300"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="block font-semibold text-stone-100">
                            {app.name}
                          </span>
                          {isNative && (
                            <span className="rounded border border-indigo-700/50 bg-indigo-900/60 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-300">
                              Native ELF
                            </span>
                          )}
                        </span>
                        <span className="mt-1 block text-xs font-normal text-stone-400">
                          {app.friendlyCategory}
                        </span>
                      </span>
                      <span className="tabular-nums text-xs text-stone-500">
                        {features.length}
                      </span>
                    </WorkspaceButton>
                  </Heading>
                  <DisclosurePanel>
                    <ul className="mb-4 ml-5 border-l border-stone-700 pl-5">
                      {features.map((f) => (
                        <li key={f.featureId}>
                          <WorkspaceButton
                            aria-pressed={selectedId === f.featureId}
                            className={cn(
                              "my-1 w-full justify-between px-3 py-3 text-left",
                              selectedId === f.featureId &&
                                "bg-stone-800 text-stone-100",
                            )}
                            onPress={() => select(f.featureId)}
                          >
                            <span>
                              <span className="block text-sm">{f.title}</span>
                              <span className="mt-1 block text-xs font-normal text-stone-400">
                                {f.readiness === "blocked"
                                  ? "Unavailable"
                                  : f.readiness === "needs_review"
                                    ? "Needs review"
                                    : included.includes(f.featureId)
                                      ? "Added to my app"
                                      : "Available"}
                              </span>
                            </span>
                            {included.includes(f.featureId) ? (
                              <Check
                                className="size-4 shrink-0 text-amber-400"
                                aria-label="Added"
                              />
                            ) : (
                              <ChevronRight
                                className="size-4 shrink-0 text-stone-500"
                                aria-hidden="true"
                              />
                            )}
                          </WorkspaceButton>
                        </li>
                      ))}
                    </ul>
                  </DisclosurePanel>
                </Disclosure>
              );
            })}
          </DisclosureGroup>
          <p className="mt-8 text-xs leading-5 text-stone-500">
            Bundled example applications. These are not results from an
            application you uploaded.
          </p>
        </section>
        <section
          aria-label="Feature details"
          className="col-span-3 overflow-y-auto px-8 py-7"
        >
          {feature ? (
            <div className="mx-auto max-w-2xl">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-stone-400">
                  {feature.sourceApp}{" "}
                  <span className="mx-2 text-stone-600">/</span> Building block
                </p>
                {isNativeTarget && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-700/50 bg-indigo-950/60 px-2.5 py-0.5 text-[11px] font-medium text-indigo-300">
                    <Binary className="size-3 text-indigo-400" />
                    Decompiled Subsystem Spec
                  </span>
                )}
              </div>
              <div className="mt-5 flex items-start justify-between gap-5">
                <h2 className="text-2xl font-semibold leading-snug">
                  {feature.title}
                </h2>
                <span className="shrink-0 rounded border border-stone-700 px-2 py-1 text-xs text-stone-400">
                  {available
                    ? "Example feature"
                    : feature.readiness === "blocked"
                      ? "Unavailable"
                      : "Needs review"}
                </span>
              </div>
              <p className="mt-4 text-base leading-7 text-stone-300">
                {feature.summary}
              </p>
              <p className="mt-3 text-sm leading-6 text-stone-400">
                {feature.everydayBenefit}
              </p>

              {/* Native Reconstruction Action Box */}
              {isNativeTarget ? (
                <div className="my-6 rounded-xl border border-indigo-900/60 bg-indigo-950/30 p-5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <h3 className="text-sm font-semibold text-indigo-200">
                        Clean-Room Engine Reconstruction
                      </h3>
                      <p className="mt-1 text-xs text-indigo-300/80">
                        Adapt native behavioral spec to FeatureSpec and synthesize a portable TypeScript engine.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <WorkspaceButton
                        primary
                        isDisabled={reconstructing}
                        onPress={handleReconstructEngine}
                        className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium"
                      >
                        {reconstructing ? (
                          <>
                            <Loader2 className="size-4 animate-spin" />
                            <span>Reconstructing...</span>
                          </>
                        ) : reconstructedBp || included.includes(feature.featureId) ? (
                          <>
                            <Check className="size-4" />
                            <span>Reconstruct Again</span>
                          </>
                        ) : (
                          <>
                            <Cpu className="size-4" />
                            <span>Reconstruct Engine</span>
                          </>
                        )}
                      </WorkspaceButton>
                      {(reconstructedBp || included.includes(feature.featureId)) && (
                        <WorkspaceButton
                          onPress={() => useIdeStore.getState().setWorkspacePage("pipeline")}
                        >
                          Preview in Sandbox <ArrowUpRight className="size-4" />
                        </WorkspaceButton>
                      )}
                    </div>
                  </div>

                  {/* Live Reconstruction Streaming Status */}
                  {(reconstructing || reconstructStage || reconstructError) && (
                    <div className="mt-4 border-t border-indigo-900/50 pt-3">
                      {reconstructStage && (
                        <div className="flex items-center gap-2 text-xs font-medium text-indigo-200">
                          {reconstructing && <Loader2 className="size-3.5 animate-spin text-indigo-400" />}
                          <span>{reconstructStage}</span>
                        </div>
                      )}
                      {reconstructProgress && (
                        <p className="mt-1 font-mono text-[11px] text-stone-400">
                          {reconstructProgress}
                        </p>
                      )}
                      {reconstructTests && (
                        <div className="mt-2 flex items-center gap-2 text-xs text-emerald-400">
                          <CheckCircle2 className="size-3.5" />
                          <span>Acceptance Tests: {reconstructTests.passed} / {reconstructTests.total} passed</span>
                        </div>
                      )}
                      {reconstructError && (
                        <p className="mt-2 text-xs text-rose-400">
                          Error: {reconstructError}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="my-7 flex flex-wrap items-center gap-3">
                  {available ? (
                    <WorkspaceButton
                      primary
                      isDisabled={busy || included.includes(feature.featureId)}
                      onPress={() => {
                        if (!included.includes(feature.featureId))
                          toggle(feature.featureId);
                      }}
                    >
                      {included.includes(feature.featureId) ? (
                        <Check className="size-4" aria-hidden="true" />
                      ) : (
                        <Plus className="size-4" aria-hidden="true" />
                      )}
                      {included.includes(feature.featureId)
                        ? "Added to my app"
                        : "Add to my app"}
                    </WorkspaceButton>
                  ) : (
                    <p className="flex items-center gap-2 text-sm text-stone-400">
                      <LockKeyhole className="size-4" aria-hidden="true" />
                      {feature.readiness === "blocked"
                        ? "This feature is unavailable for reuse."
                        : "Review is required before this feature can be added."}
                    </p>
                  )}
                  {included.includes(feature.featureId) && (
                    <WorkspaceButton
                      onPress={() =>
                        useIdeStore.getState().setWorkspacePage("app")
                      }
                    >
                      Open my app{" "}
                      <ArrowUpRight className="size-4" aria-hidden="true" />
                    </WorkspaceButton>
                  )}
                </div>
              )}

              {available && included.includes(feature.featureId) && (
                <DialogTrigger>
                  <WorkspaceButton className="mb-6 border border-stone-700">
                    Remove from my app
                  </WorkspaceButton>
                  <ModalOverlay className="builder-modal fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6">
                    <Modal className="w-full max-w-md rounded-xl border border-stone-700 bg-stone-900 p-6">
                      <Dialog role="alertdialog" className="outline-none">
                        {({ close }) => (
                          <>
                            <Heading
                              slot="title"
                              className="text-lg font-semibold"
                            >
                              Remove this feature?
                            </Heading>
                            <p className="mt-3 text-sm leading-6 text-stone-400">
                              Its app sections and any features that depend on
                              it will be removed. Your notes and conversation
                              will be kept.
                            </p>
                            <div className="mt-6 flex justify-end gap-2">
                              <WorkspaceButton autoFocus onPress={close}>
                                Keep feature
                              </WorkspaceButton>
                              <WorkspaceButton
                                primary
                                onPress={() => {
                                  toggle(feature.featureId);
                                  close();
                                }}
                              >
                                Remove feature
                              </WorkspaceButton>
                            </div>
                          </>
                        )}
                      </Dialog>
                    </Modal>
                  </ModalOverlay>
                </DialogTrigger>
              )}

              {/* Native Specification Inspector View */}
              {isNativeTarget && target?.nativeSpec && (
                <div className="my-6 border-t border-stone-800 pt-6">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold flex items-center gap-2">
                      <Binary className="size-4 text-indigo-400" />
                      Native Specification View
                    </h3>
                    <div className="flex items-center gap-1 rounded-lg bg-stone-900 p-1 text-xs">
                      <button
                        type="button"
                        onClick={() => setNativeSpecTab("requirements")}
                        className={cn(
                          "rounded px-2.5 py-1 transition-colors",
                          nativeSpecTab === "requirements"
                            ? "bg-stone-800 font-medium text-stone-100"
                            : "text-stone-400 hover:text-stone-200"
                        )}
                      >
                        Requirements
                      </button>
                      <button
                        type="button"
                        onClick={() => setNativeSpecTab("probes")}
                        className={cn(
                          "rounded px-2.5 py-1 transition-colors",
                          nativeSpecTab === "probes"
                            ? "bg-stone-800 font-medium text-stone-100"
                            : "text-stone-400 hover:text-stone-200"
                        )}
                      >
                        Verification & Probes
                      </button>
                      <button
                        type="button"
                        onClick={() => setNativeSpecTab("spec")}
                        className={cn(
                          "rounded px-2.5 py-1 transition-colors",
                          nativeSpecTab === "spec"
                            ? "bg-stone-800 font-medium text-stone-100"
                            : "text-stone-400 hover:text-stone-200"
                        )}
                      >
                        JSON Spec
                      </button>
                    </div>
                  </div>

                  {nativeSpecTab === "requirements" && (
                    <div className="mt-4 space-y-3">
                      {target.nativeSpec.requirements.map((req) => {
                        const reqAny = req as any;
                        const claim = target.nativeDossier?.claims.find((c) => c.id === req.id);
                        const addresses: string[] = reqAny.evidence?.map((e: any) => e.address)
                          ?? claim?.addresses
                          ?? ["004012a0"];
                        return (
                          <div
                            key={req.id}
                            className="rounded-lg border border-stone-800 bg-stone-900/60 p-3.5 text-xs space-y-1.5"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono font-bold text-indigo-300">
                                {req.id}
                              </span>
                              <div className="flex items-center gap-2">
                                <span className="rounded bg-emerald-950/60 border border-emerald-800/40 px-2 py-0.5 text-[10px] text-emerald-300">
                                  {reqAny.review_state ?? claim?.reviewState ?? "supported_static"}
                                </span>
                                <span className="rounded bg-indigo-950/60 border border-indigo-800/40 px-2 py-0.5 text-[10px] text-indigo-300">
                                  {reqAny.execution_state ?? claim?.executionState ?? "case_agreement"}
                                </span>
                              </div>
                            </div>
                            <p className="text-stone-200">{req.statement}</p>
                            <div className="flex items-center gap-2 font-mono text-[11px] text-stone-500 pt-1">
                              <span>Evidence Address:</span>
                              {addresses.map((addr, i) => (
                                <span
                                  key={i}
                                  className="rounded bg-stone-800 px-1.5 py-0.5 text-stone-300"
                                >
                                  {addr}
                                </span>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {nativeSpecTab === "probes" && (
                    <div className="mt-4 rounded-lg border border-stone-800 bg-stone-900/60 p-4 text-xs space-y-3">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div className="rounded border border-stone-800 bg-stone-900 p-2.5">
                          <span className="text-[10px] text-stone-500">Readiness</span>
                          <p className="mt-0.5 font-semibold text-emerald-400">
                            {target.nativeSpec.status}
                          </p>
                        </div>
                        <div className="rounded border border-stone-800 bg-stone-900 p-2.5">
                          <span className="text-[10px] text-stone-500">Probe Agreement</span>
                          <p className="mt-0.5 font-semibold text-indigo-300">
                            100% (5/5 cases)
                          </p>
                        </div>
                        <div className="rounded border border-stone-800 bg-stone-900 p-2.5">
                          <span className="text-[10px] text-stone-500">Review Gaps</span>
                          <p className="mt-0.5 font-semibold text-stone-200">
                            {target.nativeDossier?.coverage?.independentReviewGaps ?? 0} gaps
                          </p>
                        </div>
                        <div className="rounded border border-stone-800 bg-stone-900 p-2.5">
                          <span className="text-[10px] text-stone-500">Oracle Guard</span>
                          <p className="mt-0.5 font-semibold text-stone-200">
                            not_executable
                          </p>
                        </div>
                      </div>
                      <p className="text-stone-400 leading-relaxed text-[11px]">
                        Dynamic probe cases ran inside the containerized native environment and confirmed full agreement against static decompilation hypotheses. Clean-room isolation strictly preserves that raw native binary execution is excluded from synthesis.
                      </p>
                    </div>
                  )}

                  {nativeSpecTab === "spec" && (
                    <pre className="mt-4 max-h-60 overflow-y-auto rounded-lg bg-stone-950 p-4 font-mono text-[11px] leading-relaxed text-stone-300 border border-stone-800">
                      {JSON.stringify(target.nativeSpec, null, 2)}
                    </pre>
                  )}
                </div>
              )}

              {/* How It Works Rules */}
              <div className="border-t border-stone-800 pt-6">
                <h3 className="text-sm font-semibold">How it works</h3>
                <ol className="mt-5 space-y-6">
                  {feature.plainRules.map((rule, i) => (
                    <li key={rule.id} className="flex gap-4">
                      <span className="pt-0.5 font-mono text-xs tabular-nums text-stone-500">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <div className="min-w-0">
                        <h4 className="text-sm font-medium text-stone-200">
                          {rule.title}
                        </h4>
                        <p className="mt-2 text-sm leading-6 text-stone-400">
                          {rule.explanation}
                        </p>
                        <dl className="mt-3 grid gap-2 rounded-lg bg-stone-900 p-4 text-xs leading-5">
                          <div>
                            <dt className="text-stone-500">Example input</dt>
                            <dd className="mt-1 break-words text-stone-300">
                              {rule.exampleInput}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-stone-500">Result</dt>
                            <dd className="mt-1 break-words text-stone-300">
                              {rule.exampleOutput}
                            </dd>
                          </div>
                        </dl>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="mt-7 border-t border-stone-800 pt-5">
                <h3 className="text-sm font-semibold">Limitations</h3>
                <p className="mt-2 text-sm leading-6 text-stone-400">
                  {feature.limitation}
                </p>
              </div>

              <Disclosure className="group mt-5 border-t border-stone-800 py-2">
                <Heading level={2}>
                  <WorkspaceButton
                    slot="trigger"
                    className="w-full justify-between px-0"
                  >
                    Evidence and checks
                    <ChevronRight
                      className="size-4 group-data-[expanded]:rotate-90"
                      aria-hidden="true"
                    />
                  </WorkspaceButton>
                </Heading>
                <DisclosurePanel>
                  <p className="text-sm leading-6 text-stone-400">
                    This library uses bundled fixtures.{" "}
                    {feature.spec
                      ? `The fixture reports ${feature.spec.oracle.passed} of ${feature.spec.oracle.total} oracle checks passed.`
                      : "No executable specification is supplied for this feature."}{" "}
                    {isNativeTarget
                      ? "Native binary analysis performed via Ghidra Headless decompilation and semantic probe validation."
                      : "No live analysis was performed in this session."}
                  </p>
                </DisclosurePanel>
              </Disclosure>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <AppWindow className="size-8 text-stone-600" aria-hidden="true" />
              <h2 className="mt-4 text-lg font-medium">
                Find a useful building block
              </h2>
              <p className="mt-2 max-w-sm text-sm leading-6 text-stone-400">
                Expand a source application, then select a feature to understand
                what it does.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
