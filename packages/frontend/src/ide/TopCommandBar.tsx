import { useState, useRef, useEffect } from "react";
import {
  Undo2,
  Redo2,
  Play,
  Share2,
  Sparkles,
  Edit2,
  Check,
  Layers,
  Search,
} from "lucide-react";
import { useIdeStore } from "./store/useIdeStore";
import { exportProjectBundle } from "../lib/exportZip";
import { cn } from "../lib/cn";

export function TopCommandBar() {
  const projectTitle = useIdeStore((s) => s.projectTitle);
  const setProjectTitle = useIdeStore((s) => s.setProjectTitle);
  const undoLayout = useIdeStore((s) => s.undoLayout);
  const redoLayout = useIdeStore((s) => s.redoLayout);
  const pastLayouts = useIdeStore((s) => s.pastLayouts);
  const futureLayouts = useIdeStore((s) => s.futureLayouts);
  const setCommandPaletteOpen = useIdeStore((s) => s.setCommandPaletteOpen);
  const runAllVerificationTests = useIdeStore((s) => s.runAllVerificationTests);
  const isRunningTests = useIdeStore((s) => s.isRunningTests);
  const bundle = useIdeStore((s) => s.bundle);
  const sidebarOpen = useIdeStore((s) => s.sidebarOpen);
  const activeActivity = useIdeStore((s) => s.activeActivity);
  const toggleCopilot = useIdeStore((s) => s.toggleCopilot);

  const isCopilotActive = sidebarOpen && activeActivity === "chat";

  const [isEditing, setIsEditing] = useState(false);
  const [localTitle, setLocalTitle] = useState(projectTitle);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLocalTitle(projectTitle);
  }, [projectTitle]);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const handleTitleSubmit = () => {
    const trimmed = localTitle.trim();
    if (trimmed) {
      setProjectTitle(trimmed);
    } else {
      setLocalTitle(projectTitle);
    }
    setIsEditing(false);
  };

  return (
    <header className="h-12 w-full bg-[#141210] border-b border-[#332e29] px-3 flex items-center justify-between gap-2 shrink-0 select-none z-20">
      {/* Left section: Splice Badge + Editable Title + Undo/Redo */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#282420] border border-[#332e29] shadow-sm shrink-0">
          <span className="size-2 rounded-full bg-[#fbbf24]" aria-hidden="true" />
          <span className="text-xs font-bold text-[#f5f2eb] flex items-center gap-1">
            <Layers className="size-3.5 text-[#fbbf24]" aria-hidden="true" />
            Splice
          </span>
        </div>

        {/* Project Title (Editable) */}
        <div className="flex items-center min-w-0 max-w-[200px] lg:max-w-[280px]">
          {isEditing ? (
            <div className="flex items-center gap-1">
              <input
                ref={inputRef}
                type="text"
                aria-label="Edit project name"
                value={localTitle}
                onChange={(e) => setLocalTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleTitleSubmit();
                  if (e.key === "Escape") {
                    setLocalTitle(projectTitle);
                    setIsEditing(false);
                  }
                }}
                onBlur={handleTitleSubmit}
                className="h-7 text-xs font-medium text-[#f5f2eb] bg-[#282420] border border-[#fbbf24] rounded px-2 outline-none w-44"
              />
              <button
                type="button"
                aria-label="Save project name"
                onClick={handleTitleSubmit}
                className="size-7 flex items-center justify-center rounded bg-[#282420] border border-[#332e29] hover:bg-[#332e29] text-[#34d399]"
              >
                <Check className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              aria-label={`Project name: ${projectTitle}. Click to rename`}
              onClick={() => setIsEditing(true)}
              className="group flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[#211e1b] text-left truncate transition-colors"
            >
              <span className="text-xs font-semibold text-[#f5f2eb] truncate">{projectTitle}</span>
              <Edit2
                className="size-3 text-[#a8a29e] opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                aria-hidden="true"
              />
            </button>
          )}
        </div>

        <div className="h-4 w-px bg-[#332e29] mx-1 shrink-0" aria-hidden="true" />

        {/* Undo / Redo */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            aria-label="Undo layout edit"
            disabled={pastLayouts.length === 0}
            onClick={undoLayout}
            className="size-7 flex items-center justify-center rounded text-[#a8a29e] hover:text-[#f5f2eb] hover:bg-[#211e1b] disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <Undo2 className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Redo layout edit"
            disabled={futureLayouts.length === 0}
            onClick={redoLayout}
            className="size-7 flex items-center justify-center rounded text-[#a8a29e] hover:text-[#f5f2eb] hover:bg-[#211e1b] disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <Redo2 className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Center: Clean Switch View or Search (Ctrl+P) */}
      <div className="flex items-center justify-center flex-1 max-w-md px-2">
        <button
          type="button"
          onClick={() => setCommandPaletteOpen(true)}
          aria-label="Switch view or search (Ctrl+P)"
          className="w-full max-w-sm h-7 px-3 flex items-center justify-between gap-2 text-xs font-medium rounded-md bg-[#282420] border border-[#332e29] text-[#a8a29e] hover:text-[#f5f2eb] hover:border-[#fbbf24]/50 shadow-sm transition-colors"
        >
          <span className="flex items-center gap-1.5 truncate">
            <Search className="size-3 text-[#a8a29e]" aria-hidden="true" />
            <span className="truncate">Switch View or Search...</span>
          </span>
          <kbd className="font-mono text-[10px] bg-[#211e1b] px-1.5 py-0.2 rounded text-[#a8a29e] border border-[#332e29] shrink-0">
            Ctrl+P
          </kbd>
        </button>
      </div>

      {/* Right: Verify Behavior + Save / Share + AI Assistant */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Verify Behavior */}
        <button
          type="button"
          aria-label="Verify app behavior and rules"
          disabled={isRunningTests}
          onClick={runAllVerificationTests}
          className="h-7 px-2.5 flex items-center gap-1.5 text-xs font-medium rounded bg-[#064e3b] text-[#34d399] border border-[#10b981]/40 hover:bg-[#065f46] disabled:opacity-50 transition-colors shadow-sm"
        >
          <Play
            className={cn("size-3", isRunningTests && "animate-spin")}
            aria-hidden="true"
          />
          <span className="hidden sm:inline">
            {isRunningTests ? "Checking..." : "Verify Behavior"}
          </span>
        </button>

        {/* Save / Share */}
        <button
          type="button"
          aria-label="Save and share project"
          onClick={() => exportProjectBundle(bundle, projectTitle)}
          className="h-7 px-2.5 flex items-center gap-1.5 text-xs font-medium rounded bg-[#282420] text-[#f5f2eb] border border-[#332e29] hover:bg-[#332e29] transition-colors shadow-sm"
        >
          <Share2 className="size-3 text-[#a8a29e]" aria-hidden="true" />
          <span className="hidden md:inline">Save / Share</span>
        </button>

        {/* AI Assistant Toggle Button */}
        <button
          type="button"
          aria-label={isCopilotActive ? "Close AI Assistant" : "Open AI Assistant"}
          aria-pressed={isCopilotActive}
          onClick={() => toggleCopilot()}
          className={cn(
            "h-7 px-2.5 flex items-center gap-1.5 text-xs font-medium rounded border transition-colors shadow-sm",
            isCopilotActive
              ? "bg-[#451a03]/80 text-[#fbbf24] border-[#f59e0b]/50"
              : "bg-[#282420] text-[#f5f2eb] border-[#332e29] hover:bg-[#332e29]"
          )}
        >
          <Sparkles className="size-3 text-[#fbbf24]" aria-hidden="true" />
          <span className="hidden md:inline">AI Assistant</span>
        </button>
      </div>
    </header>
  );
}
