import { useMemo } from "react";
import {
  BookOpen,
  Layers,
  Sparkles,
  CheckCircle2,
  Check,
  Plus,
  ArrowRight,
  Info,
  Binary,
  Cpu,
} from "lucide-react";
import { useIdeStore } from "../store/useIdeStore";
import {
  IDE_TARGETS,
  IDE_FEATURES,
  type DecompiledTarget,
  type IdeFeatureRecord,
} from "../data/ideFixtures";

export function DecompiledView() {
  const selectedTargetId = useIdeStore((s) => s.selectedTargetId);
  const selectTarget = useIdeStore((s) => s.selectTarget);
  const selectFeature = useIdeStore((s) => s.selectFeature);
  const toggleFeatureInBuild = useIdeStore((s) => s.toggleFeatureInBuild);
  const includedFeatureIds = useIdeStore((s) => s.includedFeatureIds);

  // Active target app (defaulting to Inkwell Notes)
  const target: DecompiledTarget = useMemo(() => {
    return IDE_TARGETS.find((t) => t.id === selectedTargetId) ?? IDE_TARGETS[0];
  }, [selectedTargetId]);

  // Features discovered inside the current app
  const targetFeatures: IdeFeatureRecord[] = useMemo(() => {
    return IDE_FEATURES.filter((f) => f.targetId === target.id);
  }, [target.id]);

  return (
    <div className="flex flex-col h-full w-full bg-[#181614] text-[#f5f2eb] select-text overflow-y-auto">
      {/* 1. TOP APP SWITCHER BAR */}
      <header className="border-b border-[#332e29] bg-[#211e1b] px-6 py-4 shrink-0">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-sm font-bold text-[#f5f2eb] text-balance">
              Source Applications
            </h1>
            <p className="text-xs text-[#a8a29e] text-pretty">
              Inspect existing apps to discover and reuse proven capabilities.
            </p>
          </div>

          {/* Simple App Switcher Pills */}
          <div className="flex items-center gap-2" role="tablist" aria-label="Select Source Application">
            {IDE_TARGETS.map((t) => {
              const isActive = t.id === target.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => selectTarget(t.id)}
                  className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                    isActive
                      ? t.engineKind === "ghidra_native"
                        ? "bg-[#1e1b4b]/80 border-[#6366f1]/60 text-[#a5b4fc] shadow-sm"
                        : "bg-[#451a03]/60 border-[#f59e0b]/50 text-[#fbbf24] shadow-sm"
                      : "bg-[#282420] border-[#332e29] text-[#a8a29e] hover:text-[#f5f2eb] hover:bg-[#332e29]"
                  }`}
                >
                  {t.engineKind === "ghidra_native" ? (
                    <Binary className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-[#a5b4fc]" : "text-[#a8a29e]"}`} aria-hidden="true" />
                  ) : t.id === "inkwell" ? (
                    <BookOpen className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-[#fbbf24]" : "text-[#a8a29e]"}`} aria-hidden="true" />
                  ) : (
                    <Layers className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-[#fbbf24]" : "text-[#a8a29e]"}`} aria-hidden="true" />
                  )}
                  <span>{t.name}</span>
                  {t.engineKind === "ghidra_native" && (
                    <span className="rounded bg-[#312e81]/60 px-1.5 py-0.5 text-[9px] font-bold text-[#c7d2fe] border border-[#4338ca]/50">
                      Native ELF
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {/* 2. SPACIOUS CENTERED CONTAINER */}
      <main className="flex-1 p-6">
        <div className="max-w-4xl mx-auto space-y-8">
          {/* A. VISUAL APP PROFILE CARD */}
          <section
            className="p-6 sm:p-7 rounded-xl border border-[#332e29] bg-[#282420] space-y-5"
            aria-label={`${target.name} Profile`}
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 border ${
                  target.engineKind === "ghidra_native"
                    ? "bg-[#1e1b4b]/80 border-[#6366f1]/40"
                    : "bg-[#451a03]/60 border-[#f59e0b]/30"
                }`}>
                  {target.engineKind === "ghidra_native" ? (
                    <Binary className="w-5 h-5 text-[#818cf8]" aria-hidden="true" />
                  ) : target.id === "inkwell" ? (
                    <BookOpen className="w-5 h-5 text-[#fbbf24]" aria-hidden="true" />
                  ) : (
                    <Layers className="w-5 h-5 text-[#fbbf24]" aria-hidden="true" />
                  )}
                </div>
                <div>
                  <h2 className="text-xl sm:text-2xl font-bold text-[#f5f2eb] text-balance">
                    {target.name}
                  </h2>
                  <p className="text-xs sm:text-sm font-medium text-[#fbbf24] text-pretty">
                    {target.tagline}
                  </p>
                </div>
              </div>

              <span className="self-start sm:self-center px-3 py-1 rounded-full bg-[#211e1b] border border-[#332e29] text-xs font-medium text-[#a8a29e]">
                {target.friendlyCategory}
              </span>
            </div>

            <p className="text-sm text-[#a8a29e] text-pretty leading-relaxed">
              {target.description}
            </p>

            {/* Highlights Pills */}
            {target.highlights && target.highlights.length > 0 && (
              <div className="pt-2 border-t border-[#332e29] flex flex-wrap items-center gap-2">
                {target.highlights.map((highlight, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#211e1b] border border-[#332e29] text-xs font-medium text-[#f5f2eb]"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-[#fbbf24] shrink-0" aria-hidden="true" />
                    <span>{highlight}</span>
                  </span>
                ))}
              </div>
            )}
          </section>

          {/* B. "HOW THIS APP WORKS" VISUAL FLOW */}
          {target.flowSteps && target.flowSteps.length > 0 && (
            <section className="space-y-4" aria-label="How This App Works">
              <div>
                <h3 className="text-base sm:text-lg font-bold text-[#f5f2eb] text-balance">
                  How This App Works
                </h3>
                <p className="text-xs text-[#a8a29e] text-pretty">
                  The user experience and key behaviors captured from {target.name}.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {target.flowSteps.map((step) => (
                  <div
                    key={step.stepNumber}
                    className="p-5 rounded-xl border border-[#332e29] bg-[#282420] space-y-2.5 flex flex-col justify-between"
                  >
                    <div className="space-y-2">
                      <span className="inline-block px-2 py-0.5 rounded font-mono text-xs font-bold tabular-nums text-[#fbbf24] bg-[#451a03]/60 border border-[#f59e0b]/30">
                        {step.stepNumber}
                      </span>
                      <h4 className="text-sm font-semibold text-[#f5f2eb] text-balance leading-snug">
                        {step.title}
                      </h4>
                    </div>

                    <p className="text-xs text-[#a8a29e] text-pretty leading-relaxed">
                      {step.description}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* C. BUILDING BLOCKS DISCOVERED INSIDE TARGET APP */}
          <section className="space-y-4" aria-label={`Building Blocks Discovered Inside ${target.name}`}>
            <div>
              <h3 className="text-base sm:text-lg font-bold text-[#f5f2eb] text-balance">
                Building Blocks Discovered Inside {target.name}
              </h3>
              <p className="text-xs text-[#a8a29e] text-pretty">
                Every capability extracted from this app can be reviewed, verified, and added directly to your own clean-room app.
              </p>
            </div>

            <div className="space-y-4">
              {targetFeatures.map((feat) => {
                const isIncluded = includedFeatureIds.includes(feat.featureId);
                const isVerified = feat.readiness === "verified";

                return (
                  <article
                    key={feat.featureId}
                    className="p-6 rounded-xl border border-[#332e29] bg-[#282420] space-y-4 hover:border-[#443e37] transition-colors"
                  >
                    {/* Header Row */}
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <h4 className="text-base font-bold text-[#f5f2eb] text-balance">
                            {feat.title}
                          </h4>
                          <span className="px-2 py-0.5 rounded-full bg-[#211e1b] border border-[#332e29] text-[11px] font-medium text-[#a8a29e]">
                            {feat.category}
                          </span>
                        </div>
                        <p className="text-xs text-[#f5f2eb] text-pretty leading-relaxed">
                          {feat.summary}
                        </p>
                      </div>

                      {/* Friendly Status Badge */}
                      <span
                        className={`self-start px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 border ${
                          feat.friendlyStatusLabel === "Ready to Use"
                            ? "bg-[#064e3b]/60 text-[#34d399] border-[#10b981]/30"
                            : feat.friendlyStatusLabel === "Needs Review"
                            ? "bg-[#451a03]/60 text-[#fbbf24] border-[#f59e0b]/30"
                            : "bg-[#4c0519]/60 text-[#fda4af] border-[#f43f5e]/30"
                        }`}
                      >
                        {feat.friendlyStatusLabel}
                      </span>
                    </div>

                    {/* Everyday Benefit */}
                    <div className="text-xs text-[#a8a29e] text-pretty bg-[#211e1b] p-3 rounded-lg border border-[#332e29] flex items-start gap-2">
                      <Sparkles className="w-3.5 h-3.5 text-[#fbbf24] shrink-0 mt-0.5" aria-hidden="true" />
                      <div>
                        <strong className="text-[#f5f2eb] font-semibold">Everyday Benefit: </strong>
                        <span>{feat.everydayBenefit}</span>
                      </div>
                    </div>

                    {/* Verification Line OR Limitation Notice */}
                    {feat.verifiedScenarios && feat.verifiedScenarios.length > 0 ? (
                      <div className="flex items-center gap-2 p-3 rounded-lg bg-[#064e3b]/30 border border-[#10b981]/20 text-xs text-[#34d399]">
                        <CheckCircle2 className="w-4 h-4 shrink-0 text-[#34d399]" aria-hidden="true" />
                        <span>
                          ✓ Verified: Matched {target.name} across{" "}
                          <strong className="font-semibold tabular-nums">{feat.verifiedScenarios.length}</strong> real-world scenarios
                        </span>
                      </div>
                    ) : (
                      <div className="p-3 rounded-lg bg-[#211e1b] border border-[#332e29] text-xs text-[#a8a29e] space-y-1">
                        <div className="flex items-center gap-1.5 font-medium text-[#fbbf24]">
                          <Info className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                          <span>Notice</span>
                        </div>
                        <p className="text-pretty">{feat.limitation}</p>
                      </div>
                    )}

                    {/* Action Buttons Row */}
                    <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-[#332e29]">
                      {/* Button 1: See How It Works -> opens Tab 2 */}
                      <button
                        type="button"
                        onClick={() => selectFeature(feat.featureId)}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#211e1b] hover:bg-[#332e29] text-xs font-medium text-[#f5f2eb] border border-[#332e29] transition-colors"
                      >
                        <ArrowRight className="w-3.5 h-3.5 shrink-0 text-[#fbbf24]" aria-hidden="true" />
                        <span>See How It Works</span>
                      </button>

                      {/* Button 2: Add to My App / Included in My App */}
                      {isVerified ? (
                        <button
                          type="button"
                          onClick={() => toggleFeatureInBuild(feat.featureId)}
                          className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-colors border ${
                            isIncluded
                              ? "bg-[#064e3b]/70 hover:bg-[#064e3b] text-[#34d399] border-[#10b981]/40"
                              : "bg-[#451a03]/80 hover:bg-[#451a03] text-[#fbbf24] border-[#f59e0b]/40"
                          }`}
                        >
                          {isIncluded ? (
                            <>
                              <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                              <span>Included in My App ✓</span>
                            </>
                          ) : (
                            <>
                              <Plus className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                              <span>Add to My App</span>
                            </>
                          )}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#211e1b]/60 text-xs font-medium text-[#78716c] border border-[#332e29]/60 cursor-not-allowed"
                        >
                          <span>Cannot Add ({feat.friendlyStatusLabel})</span>
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
