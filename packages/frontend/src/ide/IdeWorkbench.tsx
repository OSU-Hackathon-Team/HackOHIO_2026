import { useState, useRef, useEffect, type FormEvent, type KeyboardEvent } from "react";
import {
  X,
  Plus,
  Columns2,
  AlertOctagon,
  Layers,
  Puzzle,
  Smartphone,
  Split,
  Search,
  Sparkles,
  Bot,
  User,
  Send,
  Loader2,
  ArrowRight,
  AppWindow,
  Check,
} from "lucide-react";
import { useIdeStore, PRESET_WINDOWS } from "./store/useIdeStore";
import { TopCommandBar } from "./TopCommandBar";
import { ActivityBar } from "./ActivityBar";
import { PrimarySidebar } from "./PrimarySidebar";
import { CopilotPanel } from "./CopilotPanel";
import { BottomPanel } from "./BottomPanel";
import { StatusBar } from "./StatusBar";
import { DecompiledView } from "./views/DecompiledView";
import { SpecsView } from "./views/SpecsView";
import { StudioView } from "./views/StudioView";
import { cn } from "../lib/cn";

export function IdeWorkbench() {
  const tabs = useIdeStore((s) => s.tabs);
  const activeTabId = useIdeStore((s) => s.activeTabId);
  const setActiveTab = useIdeStore((s) => s.setActiveTab);
  const closeTab = useIdeStore((s) => s.closeTab);
  const closeAllTabs = useIdeStore((s) => s.closeAllTabs);
  const secondaryTabId = useIdeStore((s) => s.secondaryTabId);
  const openTab = useIdeStore((s) => s.openTab);
  const splitView = useIdeStore((s) => s.splitView);
  const toggleSplitView = useIdeStore((s) => s.toggleSplitView);
  const sidebarOpen = useIdeStore((s) => s.sidebarOpen);
  const toggleSidebar = useIdeStore((s) => s.toggleSidebar);
  const activeActivity = useIdeStore((s) => s.activeActivity);
  const commandPaletteOpen = useIdeStore((s) => s.commandPaletteOpen);
  const setCommandPaletteOpen = useIdeStore((s) => s.setCommandPaletteOpen);
  const statusError = useIdeStore((s) => s.statusError);
  const clearStatusError = useIdeStore((s) => s.clearStatusError);
  const chatMessages = useIdeStore((s) => s.chatMessages);
  const chatBusy = useIdeStore((s) => s.chatBusy);
  const sendCopilotPrompt = useIdeStore((s) => s.sendCopilotPrompt);

  const [landingInput, setLandingInput] = useState("");
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const addMenuRef = useRef<HTMLDivElement>(null);
  const paletteInputRef = useRef<HTMLInputElement>(null);

  // Global Keyboard Shortcuts (Ctrl+P / Cmd+P and Ctrl+B / Cmd+B)
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      }
      if (e.key === "Escape") {
        if (commandPaletteOpen) setCommandPaletteOpen(false);
        if (isAddMenuOpen) setIsAddMenuOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [commandPaletteOpen, isAddMenuOpen, setCommandPaletteOpen, toggleSidebar]);

  // Focus command palette input
  useEffect(() => {
    if (commandPaletteOpen) {
      setPaletteQuery("");
      setTimeout(() => paletteInputRef.current?.focus(), 50);
    }
  }, [commandPaletteOpen]);

  // Close + dropdown menu on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setIsAddMenuOpen(false);
      }
    };
    if (isAddMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isAddMenuOpen]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const secondaryTab =
    tabs.find((t) => t.id === secondaryTabId) ??
    tabs.find((t) => t.id !== activeTabId) ??
    tabs[0];

  const handleLandingSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = landingInput.trim();
    if (!trimmed || chatBusy) return;
    setLandingInput("");
    sendCopilotPrompt(trimmed);
  };

  const handleLandingKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleLandingSubmit();
    }
  };

  const renderTabView = (tabKind?: string) => {
    switch (tabKind) {
      case "decompiled":
        return <DecompiledView />;
      case "specs":
        return <SpecsView />;
      case "studio":
        return <StudioView />;
      default:
        return (
          <div className="flex-1 flex items-center justify-center p-8 text-[#a8a29e] text-sm">
            Select a view from the tab bar or explorer.
          </div>
        );
    }
  };

  const getTabIcon = (kind: string) => {
    switch (kind) {
      case "decompiled":
        return Layers;
      case "specs":
        return Puzzle;
      case "studio":
      default:
        return Smartphone;
    }
  };

  const filteredWindows = PRESET_WINDOWS.filter((w) => {
    if (!paletteQuery.trim()) return true;
    const q = paletteQuery.toLowerCase();
    return (
      w.title.toLowerCase().includes(q) ||
      (w.subtitle && w.subtitle.toLowerCase().includes(q)) ||
      w.kind.toLowerCase().includes(q)
    );
  });

  return (
    <div className="h-dvh flex flex-col bg-[#181614] text-[#f5f2eb] overflow-hidden select-none font-sans">
      {/* Top Command Bar */}
      <TopCommandBar />

      {/* Dismissible Error Alert Banner */}
      {statusError && (
        <div
          role="alert"
          aria-live="assertive"
          className="bg-[#450a0a]/90 text-[#fecaca] border-b border-[#ef4444]/40 px-4 py-2 flex items-center justify-between text-xs shrink-0 z-30 shadow-sm"
        >
          <div className="flex items-center gap-2 min-w-0 pr-2">
            <AlertOctagon className="size-4 text-[#f87171] shrink-0" aria-hidden="true" />
            <span className="font-medium text-pretty">{statusError}</span>
          </div>
          <button
            type="button"
            aria-label="Dismiss alert"
            onClick={clearStatusError}
            className="p-1 hover:bg-[#7f1d1d] rounded text-[#fecaca] transition-colors shrink-0"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Main Workspace Body */}
      <div className="flex-1 min-h-0 flex flex-row overflow-hidden relative">
        {/* Left: 48px Activity Rail */}
        <ActivityBar />

        {/* Single Left Sidebar Slot Only (Never two sidebars at once) */}
        {sidebarOpen && (
          activeActivity === "chat" ? <CopilotPanel /> : <PrimarySidebar />
        )}

        {/* Center: Main Stage Area */}
        <main className="flex-1 min-w-0 flex flex-col bg-[#181614] overflow-hidden relative">
          {tabs.length === 0 ? (
            /* Calm Centered Welcome + AI Copilot Landing View */
            <div className="flex-1 min-h-0 overflow-y-auto p-6 lg:p-8 flex flex-col items-center">
              <div className="max-w-3xl w-full mx-auto space-y-6">
                {/* Friendly Header */}
                <div className="text-center space-y-2 pt-2">
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#282420] border border-[#332e29] shadow-sm text-xs font-semibold text-[#f5f2eb]">
                    <span className="size-2 rounded-full bg-[#fbbf24]" aria-hidden="true" />
                    <span>Splice App Studio</span>
                    <span className="text-[#a8a29e]">·</span>
                    <span className="text-[#a8a29e]">Clean-Room Builder</span>
                  </div>
                  <h1 className="text-2xl font-bold text-[#f5f2eb] text-balance">
                    Build Your Own App from Existing Apps
                  </h1>
                  <p className="text-sm text-[#a8a29e] text-pretty max-w-xl mx-auto">
                    Pick capabilities from apps you love, see how they work in plain English, and combine them using natural language.
                  </p>
                </div>

                {/* 3 Clickable Step Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* Card 01 · Step 1 */}
                  <button
                    type="button"
                    onClick={() => openTab(PRESET_WINDOWS[0])}
                    className="p-4 rounded-xl bg-[#282420] border border-[#332e29] hover:border-[#fbbf24]/60 hover:shadow-lg text-left transition-all space-y-2 group"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-[#451a03]/80 text-[#fbbf24] border border-[#f59e0b]/30">
                        01
                      </span>
                      <Layers className="size-4 text-[#fbbf24]" aria-hidden="true" />
                    </div>
                    <div className="font-semibold text-sm text-[#f5f2eb] group-hover:text-[#fbbf24] transition-colors">
                      Step 1: Explore Source Apps
                    </div>
                    <p className="text-xs text-[#a8a29e] text-pretty leading-relaxed">
                      See what building blocks were discovered inside Inkwell Notes and Recall Flashcards.
                    </p>
                  </button>

                  {/* Card 02 · Step 2 */}
                  <button
                    type="button"
                    onClick={() => openTab(PRESET_WINDOWS[2])}
                    className="p-4 rounded-xl bg-[#282420] border border-[#332e29] hover:border-[#38bdf8]/60 hover:shadow-lg text-left transition-all space-y-2 group"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-[#0c4a6e]/80 text-[#38bdf8] border border-[#38bdf8]/30">
                        02
                      </span>
                      <Puzzle className="size-4 text-[#38bdf8]" aria-hidden="true" />
                    </div>
                    <div className="font-semibold text-sm text-[#f5f2eb] group-hover:text-[#38bdf8] transition-colors">
                      Step 2: Inspect Building Blocks
                    </div>
                    <p className="text-xs text-[#a8a29e] text-pretty leading-relaxed">
                      Read plain-English behavior rules and try interactive examples.
                    </p>
                  </button>

                  {/* Card 03 · Step 3 */}
                  <button
                    type="button"
                    onClick={() => openTab(PRESET_WINDOWS[4])}
                    className="p-4 rounded-xl bg-[#282420] border border-[#332e29] hover:border-[#34d399]/60 hover:shadow-lg text-left transition-all space-y-2 group"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-[#064e3b]/80 text-[#34d399] border border-[#10b981]/30">
                        03
                      </span>
                      <Smartphone className="size-4 text-[#34d399]" aria-hidden="true" />
                    </div>
                    <div className="font-semibold text-sm text-[#f5f2eb] group-hover:text-[#34d399] transition-colors">
                      Step 3: Use & Customize My App
                    </div>
                    <p className="text-xs text-[#a8a29e] text-pretty leading-relaxed">
                      Try your assembled study app live and customize its layout with AI.
                    </p>
                  </button>
                </div>

                {/* Quick Window Pills */}
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-[#a8a29e]">
                    Quick Open Views
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {PRESET_WINDOWS.map((win) => (
                      <button
                        key={win.id}
                        type="button"
                        onClick={() => openTab(win)}
                        className="px-2.5 py-1 rounded-lg bg-[#282420] border border-[#332e29] hover:border-[#fbbf24]/50 hover:bg-[#332e29] text-xs font-medium text-[#f5f2eb] flex items-center gap-1.5 shadow-sm transition-colors"
                      >
                        <AppWindow className="size-3 text-[#a8a29e]" aria-hidden="true" />
                        <span>{win.title}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Embedded Copilot Chat & Prompt Input */}
                <div className="rounded-xl bg-[#282420] border border-[#332e29] p-4 space-y-3 shadow-sm">
                  <div className="flex items-center justify-between pb-2 border-b border-[#332e29]">
                    <div className="flex items-center gap-2">
                      <Sparkles className="size-4 text-[#fbbf24]" aria-hidden="true" />
                      <span className="font-bold text-sm text-[#f5f2eb]">AI App Assistant</span>
                    </div>
                    <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[#064e3b]/60 text-[#34d399] border border-[#10b981]/30">
                      Ready
                    </span>
                  </div>

                  {/* Messages Feed */}
                  <div className="space-y-3 max-h-60 overflow-y-auto text-xs pr-1">
                    {chatMessages.map((msg) => (
                      <div
                        key={msg.id}
                        className={cn(
                          "rounded-lg p-3 space-y-1.5 border",
                          msg.role === "user"
                            ? "bg-[#211e1b] border-[#332e29] ml-8"
                            : "bg-[#181614] border-[#332e29] mr-8"
                        )}
                      >
                        <div className="flex items-center gap-1.5 text-[10px] text-[#a8a29e] font-medium">
                          {msg.role === "user" ? (
                            <>
                              <User className="size-3" aria-hidden="true" />
                              <span className="text-[#f5f2eb]">You</span>
                            </>
                          ) : (
                            <>
                              <Bot className="size-3 text-[#fbbf24]" aria-hidden="true" />
                              <span className="font-semibold text-[#f5f2eb]">AI Assistant</span>
                            </>
                          )}
                        </div>

                        {msg.badges && msg.badges.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {msg.badges.map((b) => (
                              <span
                                key={b}
                                className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#282420] text-[#fbbf24] border border-[#332e29]"
                              >
                                {b}
                              </span>
                            ))}
                          </div>
                        )}

                        <p className="text-xs text-[#f5f2eb] text-pretty leading-relaxed whitespace-pre-wrap">
                          {msg.text}
                        </p>

                        {/* Interactive Navigation Actions */}
                        {msg.actions && msg.actions.length > 0 && (
                          <div className="pt-1 flex flex-wrap gap-1.5">
                            {msg.actions.map((act) => (
                              <button
                                key={act.label}
                                type="button"
                                onClick={() => openTab(act.tab)}
                                className="px-2.5 py-1 rounded bg-[#0c4a6e] text-[#38bdf8] border border-[#38bdf8]/30 hover:bg-[#075985] text-[11px] font-medium transition-colors flex items-center gap-1 shadow-sm"
                              >
                                <span>{act.label}</span>
                                <ArrowRight className="size-3" aria-hidden="true" />
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}

                    {chatBusy && (
                      <div className="flex items-center gap-2 p-2 rounded-lg bg-[#181614] border border-[#332e29] text-[#a8a29e] text-xs">
                        <Loader2 className="size-3.5 animate-spin text-[#fbbf24]" aria-hidden="true" />
                        <span>Updating your app layout...</span>
                      </div>
                    )}
                  </div>

                  {/* Landing Prompt Input */}
                  <form onSubmit={handleLandingSubmit} className="pt-1 flex flex-col gap-2">
                    <div className="relative">
                      <textarea
                        aria-label="Tell the AI Assistant how you want your app to look or behave"
                        rows={2}
                        value={landingInput}
                        onChange={(e) => setLandingInput(e.target.value)}
                        onKeyDown={handleLandingKeyDown}
                        placeholder="Tell the AI Assistant how you want your app to look or behave..."
                        className="w-full text-xs text-[#f5f2eb] bg-[#181614] border border-[#332e29] rounded-lg p-2.5 pr-10 outline-none focus:ring-1 focus:ring-[#fbbf24] resize-none placeholder:text-[#a8a29e]/50"
                      />
                      <button
                        type="submit"
                        aria-label="Send message to AI Assistant"
                        disabled={chatBusy || !landingInput.trim()}
                        className="absolute right-2 bottom-3 size-7 flex items-center justify-center rounded bg-[#fbbf24] text-[#141210] hover:bg-[#f59e0b] disabled:opacity-40 transition-colors shadow-sm"
                      >
                        <Send className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            </div>
          ) : (
            /* True VS Code Tab Strip + Editor Area */
            <>
              {/* Tab Strip */}
              <div
                role="tablist"
                aria-label="Editor tabs"
                className="h-9 w-full bg-[#141210] border-b border-[#332e29] flex items-center justify-between shrink-0 overflow-x-auto"
              >
                {/* Left: Open Tabs + Plus Dropdown */}
                <div className="flex items-center h-full min-w-0">
                  {tabs.map((tab) => {
                    const isActive = tab.id === activeTabId;
                    const Icon = getTabIcon(tab.kind);

                    return (
                      <div
                        key={tab.id}
                        role="tab"
                        aria-selected={isActive}
                        tabIndex={isActive ? 0 : -1}
                        onClick={() => setActiveTab(tab.id)}
                        className={cn(
                          "h-full px-3 flex items-center gap-2 text-xs border-r border-[#332e29] cursor-pointer transition-colors max-w-[220px] truncate",
                          isActive
                            ? "bg-[#282420] text-[#f5f2eb] font-semibold border-t-2 border-t-[#fbbf24]"
                            : "bg-[#141210] text-[#a8a29e] hover:bg-[#211e1b] hover:text-[#f5f2eb]"
                        )}
                      >
                        <Icon
                          className={cn(
                            "size-3.5 shrink-0",
                            tab.kind === "specs" && "text-[#38bdf8]",
                            tab.kind === "studio" && "text-[#34d399]",
                            tab.kind === "decompiled" && "text-[#fbbf24]"
                          )}
                          aria-hidden="true"
                        />
                        <span className="truncate">{tab.title}</span>

                        {/* Close Tab button */}
                        <button
                          type="button"
                          aria-label={`Close tab ${tab.title}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            closeTab(tab.id);
                          }}
                          className="size-4 ml-1 flex items-center justify-center rounded hover:bg-[#332e29] text-[#a8a29e] hover:text-[#f5f2eb] transition-colors"
                        >
                          <X className="size-3" aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })}

                  {/* + Button and Preset Windows Dropdown */}
                  <div ref={addMenuRef} className="relative h-full flex items-center px-1">
                    <button
                      type="button"
                      aria-label="Open window"
                      aria-expanded={isAddMenuOpen}
                      onClick={() => setIsAddMenuOpen(!isAddMenuOpen)}
                      className="size-6 flex items-center justify-center rounded hover:bg-[#282420] text-[#a8a29e] hover:text-[#f5f2eb] transition-colors"
                    >
                      <Plus className="size-3.5" aria-hidden="true" />
                    </button>

                    {isAddMenuOpen && (
                      <div
                        role="menu"
                        className="absolute left-0 top-full mt-0.5 w-64 bg-[#282420] border border-[#332e29] rounded-lg shadow-xl py-1 z-30 divide-y divide-[#332e29]/70"
                      >
                        <div className="px-2.5 py-1 text-[10px] font-bold text-[#a8a29e]">
                          Open View
                        </div>
                        <div className="py-1">
                          {PRESET_WINDOWS.map((win) => {
                            const isOpen = tabs.some((t) => t.id === win.id);
                            return (
                              <button
                                key={win.id}
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  openTab(win);
                                  setIsAddMenuOpen(false);
                                }}
                                className="w-full px-2.5 py-1.5 text-left text-xs hover:bg-[#332e29] flex items-center justify-between transition-colors"
                              >
                                <div className="truncate pr-1">
                                  <div className="font-medium text-[#f5f2eb] truncate">
                                    {win.title}
                                  </div>
                                  {win.subtitle && (
                                    <div className="text-[10px] text-[#a8a29e] truncate">
                                      {win.subtitle}
                                    </div>
                                  )}
                                </div>
                                {isOpen && (
                                  <Check className="size-3 text-[#34d399] shrink-0" aria-hidden="true" />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Right: Close All + Split View */}
                <div className="flex items-center gap-1 px-2 shrink-0">
                  <button
                    type="button"
                    aria-label="Close all tabs"
                    onClick={closeAllTabs}
                    className="h-6 px-2 text-[11px] font-medium rounded hover:bg-[#282420] text-[#a8a29e] hover:text-[#f5f2eb] transition-colors"
                  >
                    Close All
                  </button>

                  <button
                    type="button"
                    aria-label={splitView ? "Disable side-by-side view" : "Split view side-by-side"}
                    aria-pressed={splitView}
                    title={splitView ? "Disable split view" : "Split view side-by-side"}
                    onClick={() => toggleSplitView()}
                    className={cn(
                      "p-1.5 rounded transition-colors text-xs flex items-center gap-1",
                      splitView
                        ? "bg-[#282420] text-[#38bdf8] border border-[#38bdf8]/30 shadow-sm"
                        : "text-[#a8a29e] hover:text-[#f5f2eb] hover:bg-[#282420]"
                    )}
                  >
                    <Columns2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>

              {/* Editor Content (Single or Split) */}
              <div className="flex-1 min-h-0 flex overflow-hidden">
                {!splitView ? (
                  // Single Pane View
                  <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                    {renderTabView(activeTab?.kind)}
                  </div>
                ) : (
                  // Side-by-Side Split Panes
                  <div className="flex-1 min-h-0 flex flex-row overflow-hidden divide-x divide-[#332e29]">
                    {/* Left Pane (Primary active tab) */}
                    <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
                      <div className="h-7 px-3 bg-[#211e1b] border-b border-[#332e29] flex items-center justify-between text-[11px] font-semibold text-[#a8a29e] shrink-0">
                        <span className="flex items-center gap-1.5 truncate text-[#f5f2eb]">
                          <Split className="size-3 text-[#fbbf24]" aria-hidden="true" />
                          Pane 1: {activeTab?.title}
                        </span>
                        <span className="text-[10px] text-[#a8a29e]">Primary</span>
                      </div>
                      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                        {renderTabView(activeTab?.kind)}
                      </div>
                    </div>

                    {/* Right Pane (Secondary tab with selector) */}
                    <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
                      <div className="h-7 px-3 bg-[#211e1b] border-b border-[#332e29] flex items-center justify-between text-[11px] shrink-0">
                        <span className="font-semibold text-[#a8a29e] truncate">Pane 2:</span>
                        <div className="flex items-center gap-1.5">
                          <select
                            aria-label="Secondary view selector"
                            value={secondaryTab?.id ?? ""}
                            onChange={(e) => {
                              const target =
                                tabs.find((t) => t.id === e.target.value) ||
                                PRESET_WINDOWS.find((w) => w.id === e.target.value);
                              if (target) openTab(target, true);
                            }}
                            className="text-[11px] font-medium bg-[#282420] text-[#f5f2eb] border border-[#332e29] rounded px-2 py-0.5 outline-none cursor-pointer"
                          >
                            {tabs.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.title}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            aria-label="Close split pane"
                            onClick={() => toggleSplitView(false)}
                            className="size-5 flex items-center justify-center rounded hover:bg-[#332e29] text-[#a8a29e] hover:text-[#f5f2eb] transition-colors"
                          >
                            <X className="size-3" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                        {renderTabView(secondaryTab?.kind)}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Bottom Dock Panel (Activity & Checks) */}
          <BottomPanel />
        </main>
      </div>

      {/* Bottom: 28px Status Bar */}
      <StatusBar />

      {/* Command Palette Modal (Ctrl+P / Cmd+P) */}
      {commandPaletteOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Command Palette"
          className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/60 backdrop-blur-xs p-4"
          onClick={() => setCommandPaletteOpen(false)}
        >
          <div
            className="w-full max-w-lg bg-[#282420] border border-[#332e29] rounded-xl shadow-2xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-3 border-b border-[#332e29] flex items-center gap-2 bg-[#211e1b]">
              <Search className="size-4 text-[#a8a29e] shrink-0" aria-hidden="true" />
              <input
                ref={paletteInputRef}
                type="text"
                value={paletteQuery}
                aria-label="Search views, source apps, or building blocks"
                onChange={(e) => setPaletteQuery(e.target.value)}
                placeholder="Search views, source apps, or building blocks..."
                className="w-full bg-transparent text-xs text-[#f5f2eb] outline-none font-medium placeholder:text-[#a8a29e]/50"
              />
              <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#181614] text-[#a8a29e] border border-[#332e29] shrink-0">
                ESC
              </kbd>
            </div>
            <div className="max-h-72 overflow-y-auto p-1.5 space-y-1">
              {filteredWindows.length === 0 ? (
                <div className="p-4 text-center text-xs text-[#a8a29e]">
                  No matching views found.
                </div>
              ) : (
                filteredWindows.map((win) => {
                  const isOpen = tabs.some((t) => t.id === win.id);

                  return (
                    <button
                      key={win.id}
                      type="button"
                      onClick={() => {
                        openTab(win);
                        setCommandPaletteOpen(false);
                      }}
                      className="w-full p-2 rounded-lg text-left flex items-center justify-between hover:bg-[#332e29] transition-colors group"
                    >
                      <div className="min-w-0 pr-2">
                        <div className="text-xs font-semibold text-[#f5f2eb] flex items-center gap-1.5 truncate">
                          <span>{win.title}</span>
                          {isOpen && (
                            <span className="size-1.5 rounded-full bg-[#34d399]" aria-hidden="true" />
                          )}
                        </div>
                        {win.subtitle && (
                          <div className="text-[10px] text-[#a8a29e] truncate">
                            {win.subtitle}
                          </div>
                        )}
                      </div>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#211e1b] text-[#a8a29e] shrink-0">
                        {win.kind === "decompiled"
                          ? "Source App"
                          : win.kind === "specs"
                          ? "Building Block"
                          : "My App"}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
