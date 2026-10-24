import { useState, useRef, useEffect, type FormEvent, type KeyboardEvent } from "react";
import {
  Sparkles,
  PanelLeftClose,
  Send,
  Loader2,
  Bot,
  User,
  CornerDownLeft,
  ArrowRight,
} from "lucide-react";
import { useIdeStore } from "./store/useIdeStore";
import { cn } from "../lib/cn";

const SUGGESTION_CHIPS = [
  "Add a study goals banner at the top",
  "Arrange my app sections side-by-side",
  "Show me how Inkwell Notes works",
  "Why is Cloud Sync unavailable?",
];

export function CopilotPanel() {
  const sidebarOpen = useIdeStore((s) => s.sidebarOpen);
  const toggleSidebar = useIdeStore((s) => s.toggleSidebar);
  const chatMessages = useIdeStore((s) => s.chatMessages);
  const chatBusy = useIdeStore((s) => s.chatBusy);
  const sendCopilotPrompt = useIdeStore((s) => s.sendCopilotPrompt);
  const openTab = useIdeStore((s) => s.openTab);

  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (sidebarOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages, chatBusy, sidebarOpen]);

  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || chatBusy) return;
    setInput("");
    sendCopilotPrompt(trimmed);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleChipClick = (prompt: string) => {
    if (chatBusy) return;
    setInput(prompt);
    textareaRef.current?.focus();
    sendCopilotPrompt(prompt);
    setInput("");
  };

  const formatTimestamp = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <aside
      aria-label="AI App Assistant"
      className="w-80 h-full bg-[#211e1b] border-r border-[#332e29] flex flex-col shrink-0 select-none overflow-hidden z-10"
    >
      {/* Copilot Header */}
      <div className="h-10 px-3 bg-[#141210] border-b border-[#332e29] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="size-4 text-[#fbbf24] shrink-0" aria-hidden="true" />
          <h2 className="text-xs font-bold text-[#f5f2eb] truncate">AI App Assistant</h2>
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#064e3b]/60 text-[#34d399] border border-[#10b981]/30">
            Ready
          </span>
        </div>
        <button
          type="button"
          aria-label="Collapse assistant sidebar"
          onClick={() => toggleSidebar(false)}
          className="size-6 flex items-center justify-center rounded text-[#a8a29e] hover:text-[#f5f2eb] hover:bg-[#332e29] transition-colors"
        >
          <PanelLeftClose className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* Suggestion Chips */}
      <div className="p-2 border-b border-[#332e29] bg-[#282420]/50 space-y-1.5 shrink-0">
        <span className="text-[10px] font-semibold text-[#a8a29e]">
          Quick Suggestions
        </span>
        <div className="flex flex-wrap gap-1">
          {SUGGESTION_CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              disabled={chatBusy}
              onClick={() => handleChipClick(chip)}
              className="text-left text-[11px] px-2 py-1 rounded bg-[#282420] border border-[#332e29] text-[#f5f2eb] hover:border-[#fbbf24]/50 hover:bg-[#332e29] disabled:opacity-40 transition-colors"
            >
              {chip}
            </button>
          ))}
        </div>
      </div>

      {/* Message History */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
        {chatMessages.map((msg) => {
          const isUser = msg.role === "user";

          return (
            <div
              key={msg.id}
              className={cn(
                "flex flex-col space-y-1",
                isUser ? "items-end" : "items-start"
              )}
            >
              {/* Message Header */}
              <div className="flex items-center gap-1.5 px-1 text-[10px] text-[#a8a29e]">
                {isUser ? (
                  <>
                    <span className="tabular-nums font-mono">{formatTimestamp(msg.ts)}</span>
                    <span className="font-semibold text-[#f5f2eb]">You</span>
                    <User className="size-3 text-[#a8a29e]" aria-hidden="true" />
                  </>
                ) : (
                  <>
                    <Bot className="size-3 text-[#fbbf24]" aria-hidden="true" />
                    <span className="font-semibold text-[#f5f2eb]">AI Assistant</span>
                    <span className="tabular-nums font-mono">{formatTimestamp(msg.ts)}</span>
                  </>
                )}
              </div>

              {/* Message Bubble Card */}
              <div
                className={cn(
                  "rounded-lg p-2.5 max-w-[94%] space-y-2 shadow-sm border",
                  isUser
                    ? "bg-[#282420] text-[#f5f2eb] border-[#332e29]"
                    : "bg-[#282420] text-[#f5f2eb] border-[#332e29]"
                )}
              >
                {/* Badges List (Friendly labels only) */}
                {msg.badges && msg.badges.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {msg.badges.map((b) => (
                      <span
                        key={b}
                        className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#141210] text-[#fbbf24] border border-[#332e29]"
                      >
                        {b}
                      </span>
                    ))}
                  </div>
                )}

                {/* Message Body */}
                <p className="text-pretty whitespace-pre-wrap leading-relaxed text-xs">
                  {msg.text}
                </p>

                {/* Action Buttons for Tab Navigation */}
                {msg.actions && msg.actions.length > 0 && (
                  <div className="pt-1 flex flex-wrap gap-1.5">
                    {msg.actions.map((act) => (
                      <button
                        key={act.label}
                        type="button"
                        onClick={() => openTab(act.tab)}
                        className="px-2 py-1 rounded bg-[#0c4a6e] text-[#38bdf8] border border-[#38bdf8]/30 hover:bg-[#075985] text-[11px] font-medium transition-colors flex items-center gap-1 shadow-sm"
                      >
                        <span>{act.label}</span>
                        <ArrowRight className="size-3" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Busy Indicator */}
        {chatBusy && (
          <div className="flex items-center gap-2 p-2 rounded-lg bg-[#282420] border border-[#332e29] text-[#a8a29e] text-xs">
            <Loader2 className="size-3.5 animate-spin text-[#fbbf24]" aria-hidden="true" />
            <span>Thinking and updating your app layout...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Form */}
      <form
        onSubmit={handleSubmit}
        className="p-2.5 bg-[#141210] border-t border-[#332e29] flex flex-col gap-1.5 shrink-0"
      >
        <label htmlFor="copilot-input-sidebar" className="sr-only">
          Ask AI Assistant
        </label>
        <div className="relative">
          <textarea
            ref={textareaRef}
            id="copilot-input-sidebar"
            aria-label="Ask AI Assistant"
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Tell the assistant how you want your app to look..."
            className="w-full text-xs text-[#f5f2eb] bg-[#282420] border border-[#332e29] rounded-lg p-2 pr-9 outline-none focus:ring-1 focus:ring-[#fbbf24] resize-none placeholder:text-[#a8a29e]/50"
          />
          <button
            type="submit"
            aria-label="Send message to AI Assistant"
            disabled={chatBusy || !input.trim()}
            className="absolute right-1.5 bottom-2.5 size-6 flex items-center justify-center rounded bg-[#fbbf24] text-[#141210] hover:bg-[#f59e0b] disabled:opacity-40 transition-colors"
          >
            <Send className="size-3" aria-hidden="true" />
          </button>
        </div>
        <div className="flex items-center justify-between text-[10px] text-[#a8a29e] px-0.5">
          <span>Customizes layout & explains behaviors.</span>
          <span className="flex items-center gap-0.5">
            <CornerDownLeft className="size-2.5" aria-hidden="true" /> Enter
          </span>
        </div>
      </form>
    </aside>
  );
}
