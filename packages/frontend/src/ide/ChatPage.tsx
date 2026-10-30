import { useEffect, useRef, useState } from "react";
import { TextField, TextArea, Label } from "react-aria-components";
import { ArrowUp, ArrowUpRight, Square, MessageSquare } from "lucide-react";
import { useIdeStore } from "./store/useIdeStore";
import { WorkspaceButton } from "./WorkspaceButton";
import { cn } from "../lib/cn";
import { demoMode } from "../demo/mode";
import { DEMO_SUGGESTIONS } from "../demo/chatScript";

export function ChatPage() {
  const state = useIdeStore();
  const [input, setInput] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.workspacePage === "chat")
      end.current?.scrollIntoView({ behavior: "instant", block: "end" });
  }, [state.chatMessages, state.chatBusy, state.workspacePage]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-16 shrink-0 items-center justify-between border-b border-stone-800 px-8">
        <h1 className="text-sm font-medium text-stone-200">Chat</h1>
        <span className="text-xs text-stone-500">App design assistant</span>
      </div>
      <div
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        aria-busy={state.chatBusy}
        className="min-h-0 flex-1 overflow-y-auto px-8 py-10"
      >
        <div className="mx-auto max-w-3xl space-y-9">
          {state.chatMessages.map((message, index) => (
            <article
              key={message.id}
              className={cn(
                message.role === "user" &&
                  "ml-16 rounded-2xl bg-stone-800 px-5 py-4",
              )}
            >
              <p className="mb-3 flex items-center gap-2 text-xs font-medium text-stone-500">
                {message.role === "user" ? (
                  "You"
                ) : (
                  <>
                    <span
                      className="size-1.5 rounded-full bg-amber-400"
                      aria-hidden="true"
                    />
                    {index === 0
                      ? "Splice"
                      : message.model === "Project guide"
                        ? "Project guide"
                        : "Assistant"}
                  </>
                )}
              </p>
              <p className="whitespace-pre-wrap text-base leading-8 text-stone-200">
                {message.text}
              </p>
              {message.actions?.length ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {message.actions.map((action) => (
                    <WorkspaceButton
                      key={action.label}
                      className="border border-stone-700"
                      onPress={() => state.openTab(action.tab)}
                    >
                      {action.label}
                      <ArrowUpRight className="size-4" aria-hidden="true" />
                    </WorkspaceButton>
                  ))}
                </div>
              ) : null}
              {message.model &&
                message.model !== "AI Assistant" &&
                message.model !== "Project guide" && (
                  <p className="mt-3 break-all text-xs text-stone-500">
                    {message.model}
                  </p>
                )}
            </article>
          ))}
          {state.chatBusy && (
            <div role="status" className="space-y-3">
              <p className="text-sm text-stone-400">Preparing your changes…</p>
              <div
                aria-hidden="true"
                className="h-2 w-1/2 rounded bg-stone-800"
              />
              <div
                aria-hidden="true"
                className="h-2 w-1/3 rounded bg-stone-800"
              />
            </div>
          )}
          <div ref={end} />
        </div>
      </div>
      <div className="shrink-0 px-8 pb-7 pt-4">
        <div className="mx-auto max-w-3xl">
          {state.statusError && (
            <p
              role="alert"
              className="mb-4 border-l-2 border-red-400 bg-red-950/20 px-4 py-3 text-sm leading-6 text-red-200"
            >
              {state.statusError}
            </p>
          )}
          {state.chatMessages.length === 1 && (
            <div className="mb-4 flex flex-wrap gap-2">
              {(demoMode ? DEMO_SUGGESTIONS : [
                "Add a study goals introduction",
                "Arrange my app sections side by side",
              ]).map((text) => (
                <WorkspaceButton
                  key={text}
                  className="border border-stone-800 text-xs"
                  onPress={() => setInput(text)}
                >
                  {text}
                </WorkspaceButton>
              ))}
            </div>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (input.trim() && !state.chatBusy) {
                void state.sendCopilotPrompt(input);
                setInput("");
              }
            }}
            className="rounded-xl border border-stone-700 bg-stone-900 p-4 focus-within:border-stone-500"
          >
            <TextField value={input} onChange={setInput}>
              <Label className="sr-only">Message Splice</Label>
              <TextArea
                maxLength={2000}
                rows={3}
                placeholder="What would you like to build or change?"
                className="w-full resize-none bg-transparent text-sm leading-6 text-stone-100 outline-none placeholder:text-stone-500"
              />
            </TextField>
            <div className="mt-3 flex items-center justify-between gap-4">
              <WorkspaceButton
                className="min-h-11 px-1 text-xs text-stone-400"
                onPress={() => state.setWorkspacePage("library")}
              >
                <MessageSquare className="size-3.5" aria-hidden="true" />
                {state.includedFeatureIds.length} features in your app
              </WorkspaceButton>
              {state.chatBusy ? (
                <WorkspaceButton
                  aria-label="Cancel request"
                  onPress={state.cancelCopilotPrompt}
                >
                  <Square className="size-4" aria-hidden="true" />
                  Stop
                </WorkspaceButton>
              ) : (
                <WorkspaceButton
                  primary
                  type="submit"
                  aria-label="Send message"
                  isDisabled={!input.trim()}
                >
                  <ArrowUp className="size-4" aria-hidden="true" />
                </WorkspaceButton>
              )}
            </div>
          </form>
          <p className="mt-3 text-center text-xs leading-5 text-stone-500">
            Describe changes in plain language. Feature engines remain
            unchanged.
          </p>
        </div>
      </div>
    </div>
  );
}
