import {
  CheckCircle2,
  Puzzle,
  Sparkles,
  Activity,
} from "lucide-react";
import { useIdeStore } from "./store/useIdeStore";
import { cn } from "../lib/cn";

export function StatusBar() {
  const setBottomPanelTab = useIdeStore((s) => s.setBottomPanelTab);
  const bottomPanelOpen = useIdeStore((s) => s.bottomPanelOpen);
  const toggleBottomPanel = useIdeStore((s) => s.toggleBottomPanel);
  const includedFeatureIds = useIdeStore((s) => s.includedFeatureIds);

  return (
    <footer
      aria-label="Status Bar"
      className="h-7 w-full bg-[#141210] border-t border-[#332e29] px-3 flex items-center justify-between text-xs text-[#a8a29e] shrink-0 select-none z-20 font-medium"
    >
      {/* Left: Active Building Blocks Summary */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="inline-flex items-center gap-1.5 text-[#f5f2eb]">
          <Puzzle className="size-3 text-[#38bdf8]" aria-hidden="true" />
          <span className="tabular-nums font-semibold">
            {includedFeatureIds.length} Building Blocks Active
          </span>
        </span>
        <span className="text-[#332e29]" aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1.5 text-[#34d399]">
          <span className="size-1.5 rounded-full bg-[#34d399]" aria-hidden="true" />
          <span>Ready to Use</span>
        </span>
      </div>

      {/* Center: Behavior Scenarios Matched (Clickable to open Behavior Checks) */}
      <div className="hidden md:flex items-center gap-3">
        <button
          type="button"
          aria-label="View behavior check scenarios"
          onClick={() => setBottomPanelTab("tests")}
          className="inline-flex items-center gap-1.5 hover:text-[#f5f2eb] transition-colors"
        >
          <CheckCircle2 className="size-3.5 text-[#34d399]" aria-hidden="true" />
          <span className="text-[#f5f2eb] font-semibold">
            6/6 Behavior Scenarios Matched
          </span>
        </button>

        <span className="text-[#332e29]" aria-hidden="true">|</span>

        <span className="inline-flex items-center gap-1 text-[#a8a29e]">
          <span>App Rules Verified</span>
        </span>
      </div>

      {/* Right: AI Assistant Ready + Bottom Dock Toggle */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="inline-flex items-center gap-1 text-[11px] text-[#fbbf24] bg-[#282420] px-2 py-0.5 rounded border border-[#332e29] shadow-sm">
          <Sparkles className="size-3 text-[#fbbf24] shrink-0" aria-hidden="true" />
          <span>AI Assistant Ready</span>
        </span>

        <button
          type="button"
          aria-label={bottomPanelOpen ? "Close checks dock" : "Open checks dock"}
          aria-pressed={bottomPanelOpen}
          onClick={() => toggleBottomPanel()}
          className={cn(
            "p-1 rounded text-[#a8a29e] hover:text-[#f5f2eb] hover:bg-[#282420] transition-colors",
            bottomPanelOpen && "text-[#34d399]"
          )}
        >
          <Activity className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </footer>
  );
}
