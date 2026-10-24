// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/08_sandpack_studio.md §3
import { useState, type KeyboardEvent } from "react";
import { useStudio } from "../../store/useStudio";

const SUGGESTIONS = [
  "Add a 'Due today' filter",
  "Add a dark mode toggle",
  "Show a mini graph of note links",
];

export function RefineChat() {
  const synth = useStudio(s => s.synth);
  const refine = useStudio(s => s.refine);
  const [input, setInput] = useState("");
  const isRunning = synth.status === "running";

  const handleSend = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isRunning) return;
    void refine("edit", trimmed);
    setInput("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend(input);
    }
  };

  return (
    <div className="refine-chat" aria-label="Refine application">
      <div className="refine-chat-header">
        <h3 className="small">Refine application</h3>
        <p className="small muted">Describe changes to the interface</p>
      </div>

      {synth.chat.length > 0 && (
        <div className="chat-messages" role="log" aria-label="Refinement conversation">
          {synth.chat.map((msg, i) => (
            <div key={i} className={`chat-bubble ${msg.role}`}>
              <span className="eyebrow">{msg.role === "user" ? "You" : "Splice"}</span>
              <p>{msg.text}</p>
            </div>
          ))}
        </div>
      )}

      <div className="suggestion-chips" aria-label="Suggested refinements">
        {SUGGESTIONS.map((suggestion, i) => (
          <button
            key={i}
            type="button"
            className="chip"
            disabled={isRunning}
            onClick={() => handleSend(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>

      <div className="chat-input-row">
        <textarea
          aria-label="Refinement instructions"
          placeholder="Ask for an edit or refinement... (Enter to send, Shift+Enter for newline)"
          value={input}
          rows={2}
          disabled={isRunning}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="primary"
          disabled={!input.trim() || isRunning}
          onClick={() => handleSend(input)}
        >
          {isRunning ? "Updating..." : "Send"}
        </button>
      </div>
      <p className="small muted">Engines are locked. Refinements only change the UI.</p>
    </div>
  );
}
