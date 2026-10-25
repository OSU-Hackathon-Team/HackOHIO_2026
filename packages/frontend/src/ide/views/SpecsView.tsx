import React, { useState } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  AlertOctagon,
  Check,
  Plus,
  BookOpen,
  Clock,
  Search,
  CloudOff,
  Sparkles,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  RotateCcw,
  Flame,
  Binary,
} from "lucide-react";
import { useIdeStore } from "../store/useIdeStore";
import { IDE_FEATURES, type IdeFeatureRecord } from "../data/ideFixtures";
import { cn } from "../../lib/cn";

export function SpecsView() {
  const selectedFeatureId = useIdeStore((s) => s.selectedFeatureId);
  const includedFeatureIds = useIdeStore((s) => s.includedFeatureIds);
  const statusError = useIdeStore((s) => s.statusError);
  const selectFeature = useIdeStore((s) => s.selectFeature);
  const toggleFeatureInBuild = useIdeStore((s) => s.toggleFeatureInBuild);
  const clearStatusError = useIdeStore((s) => s.clearStatusError);
  const selectTarget = useIdeStore((s) => s.selectTarget);
  const openTab = useIdeStore((s) => s.openTab);
  const setStudioSubMode = useIdeStore((s) => s.setStudioSubMode);

  const [activeSubTab, setActiveSubTab] = useState<"rules" | "try" | "verified">("rules");

  // Interactive tester state for Connected Notes
  const [wikiInput, setWikiInput] = useState(
    "The [[Heart]] connects [[Anatomy]] with [[Physiology]]."
  );

  // Interactive tester state for Flashcard Scheduler
  const [reviewCount, setReviewCount] = useState(1);
  const [intervalDays, setIntervalDays] = useState(1);
  const [streak, setStreak] = useState(1);
  const [lastAction, setLastAction] = useState<string>("Brand new flashcard ready for first review.");

  const feature: IdeFeatureRecord =
    IDE_FEATURES.find((f) => f.featureId === selectedFeatureId) ?? IDE_FEATURES[0];

  const isIncludedInApp = includedFeatureIds.includes(feature.featureId);
  const isGated = feature.readiness === "needs_review" || feature.readiness === "blocked";

  // Parse live topic tags from the wiki link input
  const extractedTopics = Array.from(
    new Set(
      Array.from(wikiInput.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)).map((m) =>
        m[1].trim()
      )
    )
  ).filter(Boolean);

  const handleFlashcardRating = (rating: "forgot" | "hard" | "easy") => {
    if (rating === "forgot") {
      setIntervalDays(1);
      setStreak(0);
      setLastAction("Card missed: wait time reset to 1 day so you can re-learn it tomorrow.");
    } else if (rating === "hard") {
      const nextDays = streak === 0 ? 1 : streak === 1 ? 4 : Math.round(intervalDays * 1.5);
      setIntervalDays(nextDays);
      setStreak((s) => s + 1);
      setReviewCount((c) => c + 1);
      setLastAction(`Remembered with effort: next review spaced out to ${nextDays} days.`);
    } else {
      const nextDays = streak === 0 ? 1 : streak === 1 ? 6 : Math.round(intervalDays * 2.3);
      setIntervalDays(nextDays);
      setStreak((s) => s + 1);
      setReviewCount((c) => c + 1);
      setLastAction(`Easy recall! Memory deepened: next review scheduled in ${nextDays} days.`);
    }
  };

  const handleResetFlashcardSim = () => {
    setReviewCount(1);
    setIntervalDays(1);
    setStreak(1);
    setLastAction("Brand new flashcard ready for first review.");
  };

  const handleTryInMyApp = () => {
    openTab({
      id: "studio-app",
      kind: "studio",
      title: "My App: Live Study Space",
    });
    setStudioSubMode("canvas");
  };

  return (
    <div className="w-full h-full min-h-0 flex flex-col bg-[#181614] text-[#f5f2eb] overflow-y-auto">
      {/* 1. Top Building Block Selector Bar */}
      <header className="sticky top-0 z-20 border-b border-[#332e29] bg-[#211e1b] px-4 py-3 shadow-md">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4 flex-wrap">
          {/* Building Block Pills */}
          <div className="flex items-center gap-2 overflow-x-auto pb-0.5">
            {IDE_FEATURES.map((f) => {
              const isSelected = f.featureId === feature.featureId;

              return (
                <button
                  type="button"
                  key={f.featureId}
                  onClick={() => {
                    selectFeature(f.featureId);
                    setActiveSubTab("rules");
                  }}
                  className={cn(
                    "inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg border text-xs font-medium transition-all shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8]",
                    isSelected
                      ? "bg-[#282420] text-[#f5f2eb] border-[#38bdf8]/60 shadow-sm font-semibold"
                      : "bg-[#282420]/50 text-[#a8a29e] border-[#332e29] hover:bg-[#282420] hover:text-[#f5f2eb]"
                  )}
                >
                  {f.targetId === "mockpriority" ? (
                    <Binary className="w-3.5 h-3.5 text-indigo-400" aria-hidden="true" />
                  ) : f.builderId === "wiki-links" ? (
                    <BookOpen className="w-3.5 h-3.5 text-[#38bdf8]" aria-hidden="true" />
                  ) : f.builderId === "spaced-review" ? (
                    <Clock className="w-3.5 h-3.5 text-indigo-400" aria-hidden="true" />
                  ) : f.builderId === "fuzzy-search" ? (
                    <Search className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
                  ) : (
                    <CloudOff className="w-3.5 h-3.5 text-rose-400" aria-hidden="true" />
                  )}

                  <span>{f.title}</span>

                  <span
                    className={cn(
                      "w-2 h-2 rounded-full",
                      f.readiness === "verified" && "bg-[#34d399]",
                      f.readiness === "needs_review" && "bg-amber-400",
                      f.readiness === "blocked" && "bg-rose-400"
                    )}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>

          {/* Right side: Friendly Status Badge & Action Buttons */}
          <div className="flex items-center gap-2.5 shrink-0 ml-auto flex-wrap">
            {/* Friendly Status Badge */}
            {feature.friendlyStatusLabel === "Ready to Use" && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold text-[#34d399] bg-[#064e3b]/60 border border-[#10b981]/30">
                <CheckCircle2 className="w-3.5 h-3.5 text-[#34d399]" aria-hidden="true" />
                Ready to Use
              </span>
            )}
            {feature.friendlyStatusLabel === "Needs Review" && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold text-amber-300 bg-amber-950/60 border border-amber-500/30">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
                Needs Review
              </span>
            )}
            {feature.friendlyStatusLabel === "Unavailable" && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold text-rose-300 bg-rose-950/60 border border-rose-500/30">
                <AlertOctagon className="w-3.5 h-3.5 text-rose-400" aria-hidden="true" />
                Unavailable
              </span>
            )}

            {/* Included in My App / Add to My App Button */}
            <button
              type="button"
              onClick={() => toggleFeatureInBuild(feature.featureId)}
              className={cn(
                "inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8]",
                isIncludedInApp
                  ? "bg-[#064e3b]/80 hover:bg-[#064e3b] text-[#34d399] border border-[#10b981]/40"
                  : isGated
                  ? "bg-[#282420] text-[#a8a29e] border border-[#332e29] opacity-75 cursor-not-allowed"
                  : "bg-[#38bdf8] hover:bg-[#0284c7] text-[#181614] font-semibold"
              )}
            >
              {isIncludedInApp ? (
                <>
                  <Check className="w-3.5 h-3.5 text-[#34d399]" aria-hidden="true" />
                  <span>Included in My App ✓</span>
                </>
              ) : isGated ? (
                <span>Gated from App</span>
              ) : (
                <>
                  <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Add to My App</span>
                </>
              )}
            </button>

            {/* Try in My App Button */}
            <button
              type="button"
              onClick={handleTryInMyApp}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#282420] hover:bg-[#332e29] text-[#f5f2eb] border border-[#332e29] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8]"
            >
              <Sparkles className="w-3.5 h-3.5 text-[#38bdf8]" aria-hidden="true" />
              <span>Try in My App</span>
            </button>
          </div>
        </div>

        {/* Status Error Alert if triggered */}
        {statusError && (
          <div className="max-w-5xl mx-auto mt-2.5">
            <div
              role="alert"
              className="flex items-center justify-between gap-3 p-3 bg-rose-950/70 border border-rose-500/40 text-rose-200 rounded-lg text-xs"
            >
              <div className="flex items-center gap-2">
                <AlertOctagon className="w-4 h-4 text-rose-400 shrink-0" aria-hidden="true" />
                <span className="font-medium text-pretty">{statusError}</span>
              </div>
              <button
                type="button"
                aria-label="Dismiss message"
                onClick={clearStatusError}
                className="text-rose-300 hover:text-white font-semibold px-2 py-0.5 rounded hover:bg-rose-900/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </header>

      {/* Main Container */}
      <main className="max-w-4xl mx-auto p-6 space-y-6 w-full">
        {/* Hero Summary Card */}
        <section className="bg-[#282420] border border-[#332e29] rounded-xl p-6 shadow-sm space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-1">
              <h1 className="text-2xl font-bold text-[#f5f2eb] text-balance">{feature.title}</h1>
              <p className="text-xs text-[#a8a29e]">
                Extracted Building Block &middot; Category: {feature.category}
              </p>
            </div>

            {/* Clickable Discovered in Source App */}
            <button
              type="button"
              onClick={() => selectTarget(feature.targetId)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-[#38bdf8] bg-[#0c4a6e]/40 border border-[#38bdf8]/30 hover:bg-[#0c4a6e]/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8] shrink-0"
            >
              <span>Discovered in {feature.sourceApp}</span>
              <ExternalLink className="w-3.5 h-3.5 text-[#38bdf8]/80" aria-hidden="true" />
            </button>
          </div>

          <p className="text-sm text-[#f5f2eb] text-pretty leading-relaxed">
            {feature.summary}
          </p>

          <div className="pt-3 border-t border-[#332e29] flex items-start gap-2.5 text-xs text-[#a8a29e]">
            <Sparkles className="w-4 h-4 text-[#38bdf8] shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-pretty">
              <strong className="text-[#f5f2eb] font-semibold">Everyday Benefit:</strong>{" "}
              {feature.everydayBenefit}
            </p>
          </div>
        </section>

        {/* When Feature is Verified (Connected Notes or Smart Flashcard Scheduler) */}
        {feature.readiness === "verified" ? (
          <div className="space-y-6">
            {/* 3 Plain-English Sub-Tabs Navigation */}
            <nav
              aria-label="Building Block Explorer Tabs"
              className="flex items-center gap-2 border-b border-[#332e29]"
            >
              <button
                type="button"
                onClick={() => setActiveSubTab("rules")}
                className={cn(
                  "pb-3 px-3.5 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8]",
                  activeSubTab === "rules"
                    ? "border-[#38bdf8] text-[#38bdf8] font-semibold"
                    : "border-transparent text-[#a8a29e] hover:text-[#f5f2eb]"
                )}
              >
                <span>How It Behaves</span>
                <span className="font-mono text-xs tabular-nums bg-[#211e1b] text-[#f5f2eb] px-1.5 py-0.2 rounded border border-[#332e29]">
                  {feature.plainRules.length} Rules
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveSubTab("try")}
                className={cn(
                  "pb-3 px-3.5 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8]",
                  activeSubTab === "try"
                    ? "border-[#38bdf8] text-[#38bdf8] font-semibold"
                    : "border-transparent text-[#a8a29e] hover:text-[#f5f2eb]"
                )}
              >
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Try It Yourself (Interactive Tester)</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveSubTab("verified")}
                className={cn(
                  "pb-3 px-3.5 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8]",
                  activeSubTab === "verified"
                    ? "border-[#38bdf8] text-[#38bdf8] font-semibold"
                    : "border-transparent text-[#a8a29e] hover:text-[#f5f2eb]"
                )}
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-[#34d399]" aria-hidden="true" />
                <span>Verified Against Original App</span>
                <span className="text-xs font-semibold text-[#34d399] bg-[#064e3b]/60 border border-[#10b981]/30 px-1.5 py-0.2 rounded tabular-nums">
                  {feature.verifiedScenarios.length}/{feature.verifiedScenarios.length} Matched
                </span>
              </button>
            </nav>

            {/* Sub-Tab 1: How It Behaves */}
            {activeSubTab === "rules" && (
              <div className="space-y-4">
                <p className="text-xs text-[#a8a29e] text-pretty">
                  Plain-English rules for how this building block operates in your fused app.
                </p>

                <div className="space-y-4">
                  {feature.plainRules.map((rule) => (
                    <article
                      key={rule.id}
                      className="bg-[#282420] border border-[#332e29] rounded-xl p-5 space-y-3"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={cn(
                            "px-2.5 py-0.5 rounded-full text-xs font-semibold border",
                            rule.category === "How it works" &&
                              "bg-[#0c4a6e]/50 text-[#38bdf8] border-[#38bdf8]/30",
                            rule.category === "Smart rule" &&
                              "bg-purple-950/50 text-purple-300 border-purple-500/30",
                            rule.category === "Safety check" &&
                              "bg-amber-950/50 text-amber-300 border-amber-500/30"
                          )}
                        >
                          {rule.category}
                        </span>
                        <h2 className="text-base font-bold text-[#f5f2eb] text-balance">
                          {rule.title}
                        </h2>
                      </div>

                      <p className="text-sm text-[#a8a29e] text-pretty leading-relaxed">
                        {rule.explanation}
                      </p>

                      {/* Visual Example Two-Box Card */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                        <div className="bg-[#211e1b] border border-[#332e29] rounded-lg p-3 space-y-1">
                          <span className="text-xs font-semibold text-[#a8a29e] uppercase block">
                            When you do:
                          </span>
                          <p className="text-xs text-[#f5f2eb] font-medium text-pretty">
                            {rule.exampleInput}
                          </p>
                        </div>

                        <div className="bg-[#064e3b]/30 border border-[#10b981]/30 rounded-lg p-3 space-y-1">
                          <span className="text-xs font-semibold text-[#34d399] uppercase block">
                            What happens:
                          </span>
                          <p className="text-xs text-[#f5f2eb] font-medium text-pretty">
                            {rule.exampleOutput}
                          </p>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            )}

            {/* Sub-Tab 2: Try It Yourself (Interactive Tester) */}
            {activeSubTab === "try" && (
              <div className="space-y-4">
                <p className="text-xs text-[#a8a29e] text-pretty">
                  Test this building block live right now before adding it to your workspace.
                </p>

                {feature.featureId === "inkwell.wikilink_graph" && (
                  <div className="bg-[#282420] border border-[#332e29] rounded-xl p-6 space-y-5">
                    <div className="space-y-1">
                      <h2 className="text-base font-bold text-[#f5f2eb]">
                        Live [[Wiki Link]] Topic Extractor
                      </h2>
                      <p className="text-xs text-[#a8a29e] text-pretty">
                        Type any sentence and wrap words in double brackets like{" "}
                        <code className="text-[#38bdf8] font-mono">[[Anatomy]]</code> to see topic
                        connections form automatically.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <label
                        htmlFor="wikilink-playground"
                        className="block text-xs font-semibold text-[#a8a29e] uppercase"
                      >
                        Type a sample sentence with [[Double Brackets]]:
                      </label>
                      <textarea
                        id="wikilink-playground"
                        value={wikiInput}
                        onChange={(e) => setWikiInput(e.target.value)}
                        rows={3}
                        className="w-full rounded-lg border border-[#332e29] bg-[#211e1b] px-3.5 py-2.5 text-sm text-[#f5f2eb] placeholder-[#a8a29e]/50 focus:border-[#38bdf8] focus:outline-none focus:ring-1 focus:ring-[#38bdf8]"
                        placeholder="e.g. Learning [[Cardiology]] connects with [[Physiology]]..."
                      />
                    </div>

                    {/* Extracted Topic Pills */}
                    <div className="p-4 bg-[#211e1b] border border-[#332e29] rounded-lg space-y-2.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-[#a8a29e] uppercase">
                          Connected Topics Extracted in Real Time:
                        </span>
                        <span className="text-xs text-[#38bdf8] font-semibold tabular-nums">
                          {extractedTopics.length} Connected Topic
                          {extractedTopics.length === 1 ? "" : "s"}
                        </span>
                      </div>

                      {extractedTopics.length > 0 ? (
                        <div className="flex items-center gap-2 flex-wrap">
                          {extractedTopics.map((topic) => (
                            <span
                              key={topic}
                              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[#0c4a6e]/50 text-[#38bdf8] border border-[#38bdf8]/30 shadow-2xs"
                            >
                              <BookOpen className="w-3.5 h-3.5 text-[#38bdf8]" aria-hidden="true" />
                              <span>{topic}</span>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-[#a8a29e] italic">
                          Wrap any word in [[double brackets]] above to see extracted topic pills
                          appear live!
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {feature.featureId === "recall.sm2_scheduler" && (
                  <div className="bg-[#282420] border border-[#332e29] rounded-xl p-6 space-y-6">
                    <div className="space-y-1">
                      <h2 className="text-base font-bold text-[#f5f2eb]">
                        Interactive Flashcard Memory Simulator
                      </h2>
                      <p className="text-xs text-[#a8a29e] text-pretty">
                        Simulate studying a flashcard and see how the interval expands over time
                        when you remember it, or resets to tomorrow when you forget.
                      </p>
                    </div>

                    {/* Simulation Display Dashboard */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="bg-[#211e1b] border border-[#332e29] rounded-xl p-5 space-y-1 text-center">
                        <span className="text-xs font-semibold text-[#a8a29e] uppercase block">
                          Next Review Scheduled In
                        </span>
                        <div className="text-3xl font-extrabold text-[#34d399] tabular-nums py-1">
                          {intervalDays} Day{intervalDays === 1 ? "" : "s"}
                        </div>
                        <span className="text-xs text-[#a8a29e]">
                          Wait time between study sessions
                        </span>
                      </div>

                      <div className="bg-[#211e1b] border border-[#332e29] rounded-xl p-5 space-y-1 text-center">
                        <span className="text-xs font-semibold text-[#a8a29e] uppercase block">
                          Memory Streak
                        </span>
                        <div className="text-3xl font-extrabold text-[#38bdf8] tabular-nums py-1 flex items-center justify-center gap-1.5">
                          <Flame className="w-6 h-6 text-amber-400" aria-hidden="true" />
                          <span>{streak}</span>
                        </div>
                        <span className="text-xs text-[#a8a29e]">
                          Consecutive successful review{streak === 1 ? "" : "s"}
                        </span>
                      </div>
                    </div>

                    {/* Status Feedback Notice */}
                    <div className="p-3.5 bg-[#211e1b] border border-[#332e29] rounded-lg text-xs text-[#f5f2eb] flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-[#38bdf8] shrink-0" aria-hidden="true" />
                        <span className="text-pretty">{lastAction}</span>
                      </div>
                      <span className="text-[#a8a29e] tabular-nums shrink-0">
                        Total Reviews: {reviewCount}
                      </span>
                    </div>

                    {/* Interactive Rating Buttons */}
                    <div className="space-y-2">
                      <span className="text-xs font-semibold text-[#a8a29e] uppercase block">
                        Grade How Well You Remembered It:
                      </span>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <button
                          type="button"
                          onClick={() => handleFlashcardRating("forgot")}
                          className="px-4 py-3 rounded-lg text-sm font-semibold bg-rose-950/60 hover:bg-rose-900/80 text-rose-300 border border-rose-500/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                        >
                          Forgot It (Reset to 1 Day)
                        </button>
                        <button
                          type="button"
                          onClick={() => handleFlashcardRating("hard")}
                          className="px-4 py-3 rounded-lg text-sm font-semibold bg-amber-950/60 hover:bg-amber-900/80 text-amber-300 border border-amber-500/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                        >
                          Remembered with Effort
                        </button>
                        <button
                          type="button"
                          onClick={() => handleFlashcardRating("easy")}
                          className="px-4 py-3 rounded-lg text-sm font-semibold bg-[#064e3b]/80 hover:bg-[#064e3b] text-[#34d399] border border-[#10b981]/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#34d399]"
                        >
                          Easy! (Expand Interval)
                        </button>
                      </div>
                    </div>

                    <div className="flex justify-end pt-1">
                      <button
                        type="button"
                        onClick={handleResetFlashcardSim}
                        className="inline-flex items-center gap-1.5 text-xs text-[#a8a29e] hover:text-[#f5f2eb] px-2.5 py-1 rounded hover:bg-[#211e1b] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8]"
                      >
                        <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Reset Simulator</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Sub-Tab 3: Verified Against Original App */}
            {activeSubTab === "verified" && (
              <div className="space-y-4">
                <p className="text-xs text-[#a8a29e] text-pretty">
                  Splice verified these behavioral scenarios by comparing the clean extracted engine
                  directly with {feature.sourceApp}.
                </p>

                <div className="space-y-3.5">
                  {feature.verifiedScenarios.map((scen) => (
                    <article
                      key={scen.id}
                      className="bg-[#282420] border border-[#332e29] rounded-xl p-5 space-y-2.5"
                    >
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-2">
                          <CheckCircle2
                            className="w-4 h-4 text-[#34d399] shrink-0"
                            aria-hidden="true"
                          />
                          <h2 className="text-base font-bold text-[#f5f2eb] text-balance">
                            {scen.title}
                          </h2>
                        </div>
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#064e3b]/60 text-[#34d399] border border-[#10b981]/30">
                          100% Match
                        </span>
                      </div>

                      <div className="space-y-1 text-xs">
                        <span className="font-semibold text-[#a8a29e] uppercase block">
                          What We Checked:
                        </span>
                        <p className="text-xs text-[#f5f2eb] text-pretty">{scen.whatWeChecked}</p>
                      </div>

                      <div className="p-3 bg-[#064e3b]/30 border border-[#10b981]/30 rounded-lg text-xs text-[#34d399] font-medium text-pretty">
                        {scen.outcomeText}
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* When Feature is NOT verified (Instant Title Search or Cloud Folder Sync) */
          <section
            className={cn(
              "bg-[#282420] border-2 rounded-xl p-6 shadow-sm space-y-5 max-w-2xl mx-auto my-4",
              feature.readiness === "needs_review"
                ? "border-amber-500/40"
                : "border-rose-500/40"
            )}
          >
            <div className="flex items-start gap-4">
              <div
                className={cn(
                  "w-12 h-12 rounded-xl flex items-center justify-center shrink-0 border",
                  feature.readiness === "needs_review"
                    ? "bg-amber-950/60 border-amber-500/40 text-amber-400"
                    : "bg-rose-950/60 border-rose-500/40 text-rose-400"
                )}
              >
                {feature.readiness === "needs_review" ? (
                  <AlertTriangle className="w-6 h-6" aria-hidden="true" />
                ) : (
                  <AlertOctagon className="w-6 h-6" aria-hidden="true" />
                )}
              </div>

              <div className="space-y-1 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-lg font-bold text-[#f5f2eb] text-balance">{feature.title}</h2>
                  <span
                    className={cn(
                      "px-2.5 py-0.5 rounded-full text-xs font-semibold border uppercase",
                      feature.readiness === "needs_review"
                        ? "bg-amber-950/50 text-amber-300 border-amber-500/30"
                        : "bg-rose-950/50 text-rose-300 border-rose-500/30"
                    )}
                  >
                    {feature.friendlyStatusLabel}
                  </span>
                </div>
                <p className="text-xs text-[#a8a29e]">
                  Discovered in {feature.sourceApp} &middot; Category: {feature.category}
                </p>
              </div>
            </div>

            {/* Why Splice Gated This Feature */}
            <div className="p-4 bg-[#211e1b] rounded-lg border border-[#332e29] space-y-2">
              <span className="text-xs font-semibold text-[#f5f2eb] uppercase block">
                Why This Building Block Is Gated:
              </span>
              <p className="text-sm text-[#a8a29e] text-pretty leading-relaxed">
                {feature.limitation}
              </p>
            </div>

            {/* Explanation of Clean-Room Safety */}
            <div className="p-4 bg-[#211e1b]/60 rounded-lg border border-[#332e29] space-y-1.5 text-xs text-[#a8a29e]">
              <span className="font-semibold text-[#f5f2eb] block">Clean-Room Safety Guarantee</span>
              <p className="text-pretty">
                Splice never imports unverified features or components that require private cloud
                accounts into your web app. This ensures your final workspace remains fast, portable,
                and 100% bug-free.
              </p>
            </div>

            {/* Single Primary Action Button */}
            <div className="pt-2">
              <button
                type="button"
                onClick={() => selectTarget(feature.targetId)}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold bg-[#38bdf8] hover:bg-[#0284c7] text-[#181614] hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38bdf8]"
              >
                <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                <span>Back to {feature.sourceApp} Profile</span>
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
