import {
  Sparkles,
  LayoutGrid,
  Layers,
  Puzzle,
  Smartphone,
  Activity,
} from "lucide-react";
import { useIdeStore, type ActivityId } from "./store/useIdeStore";
import { cn } from "../lib/cn";

interface ActivityItem {
  id: ActivityId;
  label: string;
  icon: typeof LayoutGrid;
  description: string;
}

const ACTIVITIES: ActivityItem[] = [
  {
    id: "chat",
    label: "AI Assistant",
    icon: Sparkles,
    description: "Ask questions and design your app in plain English",
  },
  {
    id: "explorer",
    label: "All Views",
    icon: LayoutGrid,
    description: "Browse all windows, source apps, and building blocks",
  },
  {
    id: "decompiler",
    label: "Source Apps",
    icon: Layers,
    description: "Inspect Inkwell Notes and Recall Flashcards",
  },
  {
    id: "specs",
    label: "Building Blocks",
    icon: Puzzle,
    description: "Plain-English behavior rules and interactive examples",
  },
  {
    id: "studio",
    label: "My App",
    icon: Smartphone,
    description: "Your assembled study application and live layout",
  },
];

export function ActivityBar() {
  const activeActivity = useIdeStore((s) => s.activeActivity);
  const sidebarOpen = useIdeStore((s) => s.sidebarOpen);
  const setActiveActivity = useIdeStore((s) => s.setActiveActivity);
  const bottomPanelOpen = useIdeStore((s) => s.bottomPanelOpen);
  const toggleBottomPanel = useIdeStore((s) => s.toggleBottomPanel);

  return (
    <aside
      aria-label="Navigation Rail"
      className="w-12 h-full bg-[#141210] border-r border-[#332e29] flex flex-col justify-between items-center py-2 shrink-0 select-none z-20"
    >
      {/* Top: Primary Navigation Activities */}
      <nav aria-label="Main activities" className="flex flex-col items-center gap-1 w-full">
        {ACTIVITIES.map((act) => {
          const isActive = sidebarOpen && activeActivity === act.id;
          const Icon = act.icon;
          return (
            <button
              key={act.id}
              type="button"
              aria-label={act.label}
              aria-pressed={isActive}
              title={`${act.label} — ${act.description}`}
              onClick={() => setActiveActivity(act.id)}
              className={cn(
                "relative size-10 flex items-center justify-center rounded-lg transition-colors group",
                isActive
                  ? "bg-[#282420] text-[#f5f2eb] shadow-sm font-semibold"
                  : "text-[#a8a29e] hover:text-[#f5f2eb] hover:bg-[#211e1b]"
              )}
            >
              {isActive && (
                <span
                  className="absolute left-0 top-1.5 bottom-1.5 w-1 bg-[#fbbf24] rounded-r"
                  aria-hidden="true"
                />
              )}
              <Icon
                className={cn(
                  "size-5",
                  act.id === "chat" && (isActive ? "text-[#fbbf24]" : "text-[#fbbf24]/80"),
                  act.id === "specs" && (isActive ? "text-[#38bdf8]" : "text-[#38bdf8]/80"),
                  act.id === "studio" && (isActive ? "text-[#34d399]" : "text-[#34d399]/80")
                )}
                aria-hidden="true"
              />
            </button>
          );
        })}
      </nav>

      {/* Bottom: Activity & Checks Toggle */}
      <div className="flex flex-col items-center gap-1 w-full pt-2 border-t border-[#332e29]">
        <button
          type="button"
          aria-label={bottomPanelOpen ? "Hide Activity & Checks" : "Show Activity & Checks"}
          aria-pressed={bottomPanelOpen}
          title={bottomPanelOpen ? "Hide Activity & Checks" : "Show Activity & Checks"}
          onClick={() => toggleBottomPanel()}
          className={cn(
            "relative size-10 flex items-center justify-center rounded-lg transition-colors",
            bottomPanelOpen
              ? "bg-[#282420] text-[#34d399] shadow-sm font-semibold"
              : "text-[#a8a29e] hover:text-[#f5f2eb] hover:bg-[#211e1b]"
          )}
        >
          {bottomPanelOpen && (
            <span
              className="absolute left-0 top-1.5 bottom-1.5 w-1 bg-[#34d399] rounded-r"
              aria-hidden="true"
            />
          )}
          <Activity className="size-4.5" aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
