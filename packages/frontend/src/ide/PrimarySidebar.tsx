import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  LayoutGrid,
  Layers,
  Puzzle,
  AppWindow,
} from "lucide-react";
import { useIdeStore, PRESET_WINDOWS } from "./store/useIdeStore";
import { cn } from "../lib/cn";

interface FriendlyFeature {
  featureId: string;
  name: string;
  sourceApp: string;
  statusLabel: string;
  statusClass: string;
  description: string;
  isIncluded: boolean;
  canToggle: boolean;
}

export function PrimarySidebar() {
  const sidebarOpen = useIdeStore((s) => s.sidebarOpen);
  const toggleSidebar = useIdeStore((s) => s.toggleSidebar);
  const tabs = useIdeStore((s) => s.tabs);
  const activeTabId = useIdeStore((s) => s.activeTabId);
  const openTab = useIdeStore((s) => s.openTab);
  const selectTarget = useIdeStore((s) => s.selectTarget);
  const selectFeature = useIdeStore((s) => s.selectFeature);
  const includedFeatureIds = useIdeStore((s) => s.includedFeatureIds);
  const toggleFeatureInBuild = useIdeStore((s) => s.toggleFeatureInBuild);

  const [openSections, setOpenSections] = useState({
    views: true,
    sourceApps: true,
    buildingBlocks: true,
  });

  const toggleSection = (section: keyof typeof openSections) => {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  if (!sidebarOpen) return null;

  const sourceApps = [
    {
      id: "inkwell",
      name: "Inkwell Notes",
      category: "Personal Notes & Knowledge Base",
      description: "Note-taking application with automatic backlink discovery.",
    },
    {
      id: "recall",
      name: "Recall Flashcards",
      category: "Spaced Repetition & Study",
      description: "Memory learning app that schedules reviews at optimal intervals.",
    },
  ];

  const buildingBlocks: FriendlyFeature[] = [
    {
      featureId: "inkwell.wikilink_graph",
      name: "Connected Notes",
      sourceApp: "Inkwell Notes",
      statusLabel: "Ready to Use",
      statusClass: "bg-[#064e3b]/60 text-[#34d399] border-[#10b981]/30",
      description: "Finds and links [[Note Name]] tags across all your study documents.",
      isIncluded: includedFeatureIds.includes("inkwell.wikilink_graph"),
      canToggle: true,
    },
    {
      featureId: "recall.sm2_scheduler",
      name: "Smart Flashcard Scheduler",
      sourceApp: "Recall Flashcards",
      statusLabel: "Ready to Use",
      statusClass: "bg-[#064e3b]/60 text-[#34d399] border-[#10b981]/30",
      description: "Schedules reviews using memory science to maximize retention.",
      isIncluded: includedFeatureIds.includes("recall.sm2_scheduler"),
      canToggle: true,
    },
    {
      featureId: "inkwell.fuzzy_search",
      name: "Instant Title Search",
      sourceApp: "Inkwell Notes",
      statusLabel: "Needs Review",
      statusClass: "bg-[#451a03]/60 text-[#fbbf24] border-[#f59e0b]/30",
      description: "Searches note titles as you type with typo tolerance.",
      isIncluded: includedFeatureIds.includes("inkwell.fuzzy_search"),
      canToggle: false,
    },
    {
      featureId: "inkwell.cloud_sync",
      name: "Cloud Folder Sync",
      sourceApp: "Inkwell Notes",
      statusLabel: "Unavailable",
      statusClass: "bg-[#450a0a]/60 text-[#f87171] border-[#ef4444]/30",
      description: "Requires external cloud servers and account login.",
      isIncluded: includedFeatureIds.includes("inkwell.cloud_sync"),
      canToggle: false,
    },
  ];

  return (
    <aside
      aria-label="Workspace Sidebar"
      className="w-72 border-r border-[#332e29] h-full bg-[#211e1b] flex flex-col shrink-0 select-none overflow-hidden z-10"
    >
      {/* Sidebar Header */}
      <div className="h-10 px-3 bg-[#141210] border-b border-[#332e29] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <LayoutGrid className="size-3.5 text-[#fbbf24]" aria-hidden="true" />
          <h2 className="text-xs font-bold text-[#f5f2eb] truncate">
            Workspace Explorer
          </h2>
        </div>
        <button
          type="button"
          aria-label="Collapse sidebar"
          onClick={() => toggleSidebar(false)}
          className="size-6 flex items-center justify-center rounded text-[#a8a29e] hover:text-[#f5f2eb] hover:bg-[#332e29] transition-colors"
        >
          <PanelLeftClose className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* Sidebar Scrollable Body */}
      <div className="flex-1 overflow-y-auto divide-y divide-[#332e29]/70 text-xs">
        {/* Top Section: Views (PRESET_WINDOWS) */}
        <section aria-label="Views">
          <button
            type="button"
            aria-expanded={openSections.views}
            onClick={() => toggleSection("views")}
            className="w-full px-3 py-2 flex items-center justify-between font-semibold text-[#f5f2eb] hover:bg-[#282420] text-left transition-colors"
          >
            <span className="flex items-center gap-1.5 text-[11px] text-[#a8a29e]">
              {openSections.views ? (
                <ChevronDown className="size-3.5" aria-hidden="true" />
              ) : (
                <ChevronRight className="size-3.5" aria-hidden="true" />
              )}
              Views ({PRESET_WINDOWS.length})
            </span>
          </button>

          {openSections.views && (
            <div className="px-2 pb-2 space-y-1">
              {PRESET_WINDOWS.map((win) => {
                const isOpen = tabs.some((t) => t.id === win.id);
                const isActive = activeTabId === win.id;

                return (
                  <button
                    key={win.id}
                    type="button"
                    onClick={() => openTab(win)}
                    className={cn(
                      "w-full px-2 py-1.5 rounded text-left flex items-center justify-between gap-1.5 transition-all text-xs font-medium border",
                      isActive
                        ? "bg-[#282420] text-[#f5f2eb] border-[#fbbf24]/50 shadow-sm font-semibold"
                        : isOpen
                        ? "bg-[#282420]/60 text-[#f5f2eb] border-[#332e29] hover:bg-[#282420]"
                        : "bg-transparent text-[#a8a29e] border-transparent hover:bg-[#282420] hover:text-[#f5f2eb]"
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <AppWindow
                        className={cn(
                          "size-3.5 shrink-0",
                          win.kind === "decompiled" && "text-[#fbbf24]",
                          win.kind === "specs" && "text-[#38bdf8]",
                          win.kind === "studio" && "text-[#34d399]"
                        )}
                        aria-hidden="true"
                      />
                      <div className="truncate">
                        <div className="truncate text-xs leading-tight">{win.title}</div>
                        {win.subtitle && (
                          <div className="text-[10px] text-[#a8a29e] truncate">
                            {win.subtitle}
                          </div>
                        )}
                      </div>
                    </div>

                    {isOpen && (
                      <span
                        title="Window is open in tab bar"
                        className="size-1.5 rounded-full bg-[#34d399] shrink-0"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Section 2: Source Apps */}
        <section aria-label="Source Apps">
          <button
            type="button"
            aria-expanded={openSections.sourceApps}
            onClick={() => toggleSection("sourceApps")}
            className="w-full px-3 py-2 flex items-center justify-between font-semibold text-[#f5f2eb] hover:bg-[#282420] text-left transition-colors"
          >
            <span className="flex items-center gap-1.5 text-[11px] text-[#a8a29e]">
              {openSections.sourceApps ? (
                <ChevronDown className="size-3.5" aria-hidden="true" />
              ) : (
                <ChevronRight className="size-3.5" aria-hidden="true" />
              )}
              Source Apps ({sourceApps.length})
            </span>
          </button>

          {openSections.sourceApps && (
            <div className="px-2 pb-2 space-y-1.5">
              {sourceApps.map((app) => (
                <button
                  key={app.id}
                  type="button"
                  onClick={() => selectTarget(app.id)}
                  className="w-full p-2 rounded-lg bg-[#282420] border border-[#332e29] hover:border-[#fbbf24]/40 text-left transition-all space-y-0.5 group"
                >
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Layers className="size-3.5 text-[#fbbf24] shrink-0" aria-hidden="true" />
                      <span className="font-semibold text-[#f5f2eb] group-hover:text-[#fbbf24] transition-colors truncate">
                        {app.name}
                      </span>
                    </div>
                  </div>
                  <p className="text-[11px] text-[#a8a29e] text-pretty leading-relaxed">
                    {app.description}
                  </p>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Section 3: Building Blocks */}
        <section aria-label="Building Blocks">
          <button
            type="button"
            aria-expanded={openSections.buildingBlocks}
            onClick={() => toggleSection("buildingBlocks")}
            className="w-full px-3 py-2 flex items-center justify-between font-semibold text-[#f5f2eb] hover:bg-[#282420] text-left transition-colors"
          >
            <span className="flex items-center gap-1.5 text-[11px] text-[#a8a29e]">
              {openSections.buildingBlocks ? (
                <ChevronDown className="size-3.5" aria-hidden="true" />
              ) : (
                <ChevronRight className="size-3.5" aria-hidden="true" />
              )}
              Building Blocks ({buildingBlocks.length})
            </span>
          </button>

          {openSections.buildingBlocks && (
            <div className="px-2 pb-2 space-y-1.5">
              {buildingBlocks.map((block) => (
                <div
                  key={block.featureId}
                  className="p-2 rounded-lg bg-[#282420] border border-[#332e29] space-y-1.5 transition-all"
                >
                  <div className="flex items-start justify-between gap-1.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {block.canToggle && (
                        <input
                          type="checkbox"
                          id={`block-check-${block.featureId}`}
                          aria-label={`Include ${block.name} in My App`}
                          checked={block.isIncluded}
                          onChange={() => toggleFeatureInBuild(block.featureId)}
                          className="size-3.5 rounded border-[#332e29] bg-[#181614] text-[#34d399] focus:ring-[#10b981] cursor-pointer"
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => selectFeature(block.featureId)}
                        className="text-left font-semibold text-[#f5f2eb] hover:text-[#38bdf8] truncate text-xs transition-colors"
                      >
                        {block.name}
                      </button>
                    </div>

                    <span
                      className={cn(
                        "px-1.5 py-0.2 rounded border text-[10px] font-medium shrink-0",
                        block.statusClass
                      )}
                    >
                      {block.statusLabel}
                    </span>
                  </div>

                  <p className="text-[11px] text-[#a8a29e] text-pretty leading-relaxed">
                    {block.description}
                  </p>

                  <div className="text-[10px] text-[#a8a29e]">
                    From: <span className="text-[#f5f2eb] font-medium">{block.sourceApp}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
