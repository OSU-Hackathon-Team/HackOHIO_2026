import { useState, useMemo } from "react";
import { useIdeStore, type NoteItem } from "../store/useIdeStore";
import { IDE_FEATURES } from "../data/ideFixtures";
import {
  Undo2,
  Redo2,
  Plus,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  Maximize2,
  Minimize2,
  Trash2,
  BookOpen,
  Calendar,
  X,
} from "lucide-react";

// ============================================================================
// Clean-Room Wiki-Link Parser (REQ-1 .. REQ-5)
// ============================================================================

export interface ExtractedWikiLink {
  raw: string;
  target: string;
  heading: string | null;
  alias: string | null;
}

const FENCE_PATTERN = /^```/;
const WIKILINK_PATTERN = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

/**
 * REQ-1: Extracts [[Target]], [[Target|alias]], and [[Target#Heading|alias]] links
 * while ignoring fenced code blocks and inline code spans.
 */
export function parseWikiLinks(markdown: string): ExtractedWikiLink[] {
  const links: ExtractedWikiLink[] = [];
  let inFence = false;
  const lines = markdown.split(/\r?\n/);

  for (const rawLine of lines) {
    if (FENCE_PATTERN.test(rawLine.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const lineWithoutCode = rawLine.replace(/`[^`]*`/g, "");
    WIKILINK_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = WIKILINK_PATTERN.exec(lineWithoutCode)) !== null) {
      links.push({
        raw: match[0],
        target: match[1].trim(),
        heading: match[2] ? match[2].trim() : null,
        alias: match[3] ? match[3].trim() : null,
      });
    }
  }

  return links;
}

/**
 * REQ-2: Normalizes titles by trimming whitespace, lowercasing, and collapsing internal whitespace.
 */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

interface GraphComputation {
  incomingBacklinks: Record<string, NoteItem[]>;
  outgoingResolved: Record<string, NoteItem[]>;
  unresolvedTargets: Record<string, string[]>;
  nodeDegrees: Record<string, { inDegree: number; outDegree: number; degree: number }>;
}

function computeWikiLinkGraph(notes: NoteItem[]): GraphComputation {
  const noteByNormTitle = new Map<string, NoteItem>();
  for (const n of notes) {
    noteByNormTitle.set(normalizeTitle(n.title), n);
  }

  const incomingBacklinks: Record<string, NoteItem[]> = {};
  const outgoingResolved: Record<string, NoteItem[]> = {};
  const unresolvedTargets: Record<string, string[]> = {};
  const seenEdges = new Set<string>();
  const inDegreeMap: Record<string, number> = {};
  const outDegreeMap: Record<string, number> = {};

  for (const n of notes) {
    incomingBacklinks[n.id] = [];
    outgoingResolved[n.id] = [];
    unresolvedTargets[n.id] = [];
    inDegreeMap[n.id] = 0;
    outDegreeMap[n.id] = 0;
  }

  for (const note of notes) {
    const extracted = parseWikiLinks(note.body);
    for (const link of extracted) {
      const targetNote = noteByNormTitle.get(normalizeTitle(link.target));
      if (!targetNote) {
        // REQ-4: Unresolved target
        if (!unresolvedTargets[note.id].includes(link.target)) {
          unresolvedTargets[note.id].push(link.target);
        }
        continue;
      }

      // REQ-3: Discard self-links
      if (targetNote.id === note.id) {
        continue;
      }

      // REQ-3: Deduplicated directed edges
      const edgeKey = `${note.id}->${targetNote.id}`;
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        outgoingResolved[note.id].push(targetNote);
        incomingBacklinks[targetNote.id].push(note);
        outDegreeMap[note.id] = (outDegreeMap[note.id] || 0) + 1;
        inDegreeMap[targetNote.id] = (inDegreeMap[targetNote.id] || 0) + 1;
      }
    }
  }

  // REQ-5: Node degree = inDegree + outDegree
  const nodeDegrees: Record<string, { inDegree: number; outDegree: number; degree: number }> = {};
  for (const n of notes) {
    const inD = inDegreeMap[n.id] || 0;
    const outD = outDegreeMap[n.id] || 0;
    nodeDegrees[n.id] = {
      inDegree: inD,
      outDegree: outD,
      degree: inD + outD,
    };
  }

  return {
    incomingBacklinks,
    outgoingResolved,
    unresolvedTargets,
    nodeDegrees,
  };
}

// ============================================================================
// StudioView Component: 100% Code-Free "My App" Live Preview
// ============================================================================

export function StudioView() {
  const includedFeatureIds = useIdeStore(s => s.includedFeatureIds);
  const layout = useIdeStore(s => s.layout);
  const pastLayouts = useIdeStore(s => s.pastLayouts);
  const futureLayouts = useIdeStore(s => s.futureLayouts);
  const undoLayout = useIdeStore(s => s.undoLayout);
  const redoLayout = useIdeStore(s => s.redoLayout);
  const toggleBlockWidth = useIdeStore(s => s.toggleBlockWidth);
  const removeBlock = useIdeStore(s => s.removeBlock);
  const notes = useIdeStore(s => s.notes);
  const selectedNoteId = useIdeStore(s => s.selectedNoteId);
  const selectNote = useIdeStore(s => s.selectNote);
  const updateNote = useIdeStore(s => s.updateNote);
  const addNote = useIdeStore(s => s.addNote);
  const reviews = useIdeStore(s => s.reviews);
  const gradeFlashcard = useIdeStore(s => s.gradeFlashcard);
  const bundle = useIdeStore(s => s.bundle);
  const selectFeature = useIdeStore(s => s.selectFeature);
  const toggleCopilot = useIdeStore(s => s.toggleCopilot);
  const statusError = useIdeStore(s => s.statusError);
  const clearStatusError = useIdeStore(s => s.clearStatusError);

  // Active note resolution
  const activeNote = useMemo(() => {
    return notes.find(n => n.id === selectedNoteId) ?? notes[0] ?? {
      id: "note-default",
      title: "Untitled Note",
      body: "",
    };
  }, [notes, selectedNoteId]);

  // Wiki-link graph computation
  const graph = useMemo(() => computeWikiLinkGraph(notes), [notes]);

  // Local flashcard feedback
  const [lastGraded, setLastGraded] = useState<{ noteId: string; label: string } | null>(null);

  const handleGrade = (noteId: string, grade: number, label: string) => {
    gradeFlashcard(noteId, grade);
    setLastGraded({ noteId, label });
  };

  const handleCreateNoteFromTopic = (topicTitle: string) => {
    const id = `note-${Date.now()}`;
    const newNote: NoteItem = {
      id,
      title: topicTitle,
      body: `Notes on ${topicTitle}.`,
    };
    useIdeStore.setState(s => ({
      notes: [...s.notes, newNote],
      selectedNoteId: id,
      reviews: {
        ...s.reviews,
        [id]: { reps: 0, interval: 1, ease: 2.5, lapses: 0, due: "Due today", leech: false },
      },
    }));
  };

  return (
    <div className="flex h-full flex-col bg-[#181614] text-[#f5f2eb]">
      {/* ==================================================================== */}
      {/* 1. Clean Top Bar                                                     */}
      {/* ==================================================================== */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#332e29] bg-[#211e1b] px-6 py-2.5">
        {/* Left: Active Building Blocks as friendly clickable pills */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-[#a8a29e]">Powered by:</span>
          {includedFeatureIds.map(fId => {
            const feat = IDE_FEATURES.find(f => f.featureId === fId);
            const label =
              fId === "inkwell.wikilink_graph"
                ? "Connected Notes & Backlinks"
                : fId === "recall.sm2_scheduler"
                ? "Smart Flashcard Scheduler"
                : feat?.title ?? fId;

            return (
              <button
                type="button"
                key={fId}
                onClick={() => selectFeature(fId)}
                title={`Click to view ${label} feature specifications`}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#10b981]/30 bg-[#064e3b]/60 px-3 py-1 text-xs font-medium text-[#34d399] hover:bg-[#064e3b]/90 transition-colors"
              >
                <CheckCircle2 size={12} aria-hidden="true" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>

        {/* Right: Customize with AI + Undo / Redo */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => toggleCopilot(true)}
            className="flex items-center gap-1.5 rounded-lg border border-[#10b981]/30 bg-[#064e3b]/60 px-3.5 py-1.5 text-xs font-medium text-[#34d399] hover:bg-[#064e3b]/90 transition-colors"
          >
            <Sparkles size={14} aria-hidden="true" />
            <span>Customize with AI</span>
          </button>

          <div className="h-4 border-l border-[#332e29]" />

          <div role="toolbar" aria-label="Layout history controls" className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Undo layout edit"
              disabled={pastLayouts.length === 0}
              onClick={undoLayout}
              className="flex items-center justify-center rounded-lg border border-[#332e29] bg-[#282420] p-2 text-[#f5f2eb] hover:bg-[#332e29] disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
            >
              <Undo2 size={14} aria-hidden="true" />
            </button>

            <button
              type="button"
              aria-label="Redo layout edit"
              disabled={futureLayouts.length === 0}
              onClick={redoLayout}
              className="flex items-center justify-center rounded-lg border border-[#332e29] bg-[#282420] p-2 text-[#f5f2eb] hover:bg-[#332e29] disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
            >
              <Redo2 size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      {/* Status Error Banner (if any) */}
      {statusError && (
        <div
          role="alert"
          className="flex items-center justify-between border-b border-red-500/30 bg-[#7f1d1d]/30 px-6 py-2 text-xs text-red-200"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} aria-hidden="true" className="shrink-0 text-red-400" />
            <p className="text-pretty">{statusError}</p>
          </div>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={clearStatusError}
            className="rounded p-1 text-red-300 hover:bg-[#7f1d1d]/50"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* ==================================================================== */}
      {/* 2. Spacious Live Application Canvas                                  */}
      {/* ==================================================================== */}
      <main className="flex-1 overflow-y-auto p-6 bg-[#181614]">
        <div className="mx-auto max-w-5xl space-y-6">
          {/* App Title & Header */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#332e29] pb-4">
            <div>
              <h1 className="text-xl font-semibold text-[#f5f2eb] text-balance">
                {bundle.app_title || "My Study App"}
              </h1>
              <p className="mt-1 text-sm text-[#a8a29e] text-pretty">
                {bundle.app_description || "Connected medical knowledge vault with bi-directional notes and smart flashcards."}
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#10b981]/30 bg-[#064e3b]/60 px-3 py-1 text-xs font-medium text-[#34d399]">
              <CheckCircle2 size={13} aria-hidden="true" />
              <span>Live App Mode</span>
            </span>
          </div>

          {/* Dynamic Layout Blocks */}
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {layout
              .filter(block => block.visible)
              .map(block => {
                const isFullWidth = block.width === "full";

                return (
                  <section
                    key={block.id}
                    aria-labelledby={`block-heading-${block.id}`}
                    className={`rounded-xl border border-[#332e29] bg-[#282420] p-5 shadow-sm ${
                      isFullWidth ? "col-span-1 md:col-span-2" : "col-span-1"
                    }`}
                  >
                    {/* Block Header with Width Toggle & Remove */}
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-4 pb-2 border-b border-[#332e29]">
                      <div>
                        <h2
                          id={`block-heading-${block.id}`}
                          className="text-base font-semibold text-[#f5f2eb] text-balance"
                        >
                          {block.title}
                        </h2>
                        {block.description && (
                          <p className="mt-0.5 text-xs text-[#a8a29e] text-pretty">
                            {block.description}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        {/* 1-Click Width Toggle */}
                        <button
                          type="button"
                          onClick={() => toggleBlockWidth(block.id)}
                          aria-label={`Toggle ${block.title} width (currently ${block.width})`}
                          className="flex items-center gap-1.5 rounded-md border border-[#332e29] bg-[#211e1b] px-2.5 py-1 text-xs text-[#a8a29e] hover:text-[#f5f2eb] hover:bg-[#332e29] transition-colors"
                        >
                          {block.width === "full" ? (
                            <>
                              <Minimize2 size={13} aria-hidden="true" />
                              <span>Half Width</span>
                            </>
                          ) : (
                            <>
                              <Maximize2 size={13} aria-hidden="true" />
                              <span>Full Width</span>
                            </>
                          )}
                        </button>

                        {/* Remove button for custom text sections */}
                        {block.kind === "text" && (
                          <button
                            type="button"
                            onClick={() => removeBlock(block.id)}
                            aria-label={`Remove section ${block.title}`}
                            className="flex items-center gap-1 rounded-md border border-red-500/30 bg-[#7f1d1d]/30 px-2 py-1 text-xs text-red-300 hover:bg-[#7f1d1d]/60 transition-colors"
                          >
                            <Trash2 size={12} aria-hidden="true" />
                            <span>Remove</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Section 1: Notes ("My Study Notes") */}
                    {block.kind === "notes" && (
                      <div className="space-y-4">
                        {/* Note Selector Tabs & Add Button */}
                        <div className="flex flex-wrap items-center gap-1.5 pb-1">
                          {notes.map(n => {
                            const isSelected = n.id === activeNote.id;
                            return (
                              <button
                                type="button"
                                key={n.id}
                                onClick={() => selectNote(n.id)}
                                className={`rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors ${
                                  isSelected
                                    ? "border border-[#10b981]/50 bg-[#064e3b]/80 text-[#34d399]"
                                    : "border border-[#332e29] bg-[#211e1b] text-[#f5f2eb] hover:bg-[#332e29]"
                                }`}
                              >
                                {n.title}
                              </button>
                            );
                          })}

                          <button
                            type="button"
                            onClick={addNote}
                            className="flex items-center gap-1.5 rounded-lg border border-dashed border-[#10b981]/40 bg-[#064e3b]/30 px-3 py-1.5 text-xs font-medium text-[#34d399] hover:bg-[#064e3b]/50 transition-colors"
                          >
                            <Plus size={13} aria-hidden="true" />
                            <span>New Note</span>
                          </button>
                        </div>

                        {/* Note Title Input */}
                        <div>
                          <label
                            htmlFor={`note-title-input-${block.id}`}
                            className="mb-1.5 block text-xs font-medium text-[#a8a29e]"
                          >
                            Note Title
                          </label>
                          <input
                            id={`note-title-input-${block.id}`}
                            type="text"
                            value={activeNote.title}
                            onChange={e => updateNote(activeNote.id, e.target.value, activeNote.body)}
                            className="w-full rounded-lg border border-[#332e29] bg-[#211e1b] px-3.5 py-2 text-sm text-[#f5f2eb] focus:border-[#10b981] focus:outline-none focus:ring-1 focus:ring-[#10b981]"
                          />
                        </div>

                        {/* Note Content Textarea with Helper Hint */}
                        <div>
                          <div className="mb-1.5 flex items-center justify-between">
                            <label
                              htmlFor={`note-body-textarea-${block.id}`}
                              className="text-xs font-medium text-[#a8a29e]"
                            >
                              Note Content
                            </label>
                            <span className="text-[11px] text-[#a8a29e] italic text-pretty">
                              Tip: Wrap any topic in [[double brackets]] to link it to another note.
                            </span>
                          </div>
                          <textarea
                            id={`note-body-textarea-${block.id}`}
                            rows={6}
                            value={activeNote.body}
                            onChange={e => updateNote(activeNote.id, activeNote.title, e.target.value)}
                            className="w-full resize-y rounded-lg border border-[#332e29] bg-[#211e1b] px-3.5 py-2.5 font-sans text-sm leading-relaxed text-[#f5f2eb] focus:border-[#10b981] focus:outline-none focus:ring-1 focus:ring-[#10b981]"
                          />
                        </div>

                        {/* Connected Topics Pills */}
                        <div className="rounded-lg border border-[#332e29] bg-[#211e1b] p-3.5">
                          <span className="mb-2 block text-xs font-medium text-[#a8a29e]">
                            Connected Topics:
                          </span>
                          {(() => {
                            const extracted = parseWikiLinks(activeNote.body);
                            if (extracted.length === 0) {
                              return (
                                <p className="text-xs italic text-[#a8a29e] text-pretty">
                                  No connected topics yet. Type <code className="rounded bg-[#282420] px-1 py-0.5 text-[#f5f2eb]">[[Topic Name]]</code> to link ideas.
                                </p>
                              );
                            }

                            return (
                              <div className="flex flex-wrap gap-2">
                                {extracted.map((link, idx) => {
                                  const resolved = notes.find(
                                    n => normalizeTitle(n.title) === normalizeTitle(link.target)
                                  );

                                  if (resolved) {
                                    return (
                                      <button
                                        type="button"
                                        key={idx}
                                        onClick={() => selectNote(resolved.id)}
                                        title={`Open note: ${resolved.title}`}
                                        className="inline-flex items-center gap-1.5 rounded-full border border-[#10b981]/30 bg-[#064e3b]/60 px-3 py-1 text-xs font-medium text-[#34d399] hover:bg-[#064e3b]/90 transition-colors"
                                      >
                                        <BookOpen size={12} aria-hidden="true" />
                                        <span>{link.alias ?? link.target}</span>
                                      </button>
                                    );
                                  }

                                  return (
                                    <span
                                      key={idx}
                                      className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-[#78350f]/30 px-3 py-1 text-xs text-amber-200"
                                    >
                                      <AlertTriangle size={12} aria-hidden="true" className="text-amber-400" />
                                      <span>{link.target}</span>
                                      <span className="text-[10px] text-amber-400 uppercase font-medium">Unwritten Topic</span>
                                    </span>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    )}

                    {/* Section 2: Backlinks ("Connected Ideas & Backlinks") */}
                    {block.kind === "backlinks" && (
                      <div className="space-y-4">
                        {/* Notes Mentioning Selected Note */}
                        <div>
                          <span className="mb-2 block text-xs font-medium text-[#f5f2eb]">
                            Notes Mentioning &ldquo;{activeNote.title}&rdquo; (Backlinks):
                          </span>
                          {graph.incomingBacklinks[activeNote.id]?.length ? (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              {graph.incomingBacklinks[activeNote.id].map(sourceNote => (
                                <button
                                  type="button"
                                  key={sourceNote.id}
                                  onClick={() => selectNote(sourceNote.id)}
                                  className="flex items-center justify-between rounded-lg border border-[#332e29] bg-[#211e1b] p-3 text-left hover:border-[#10b981]/50 hover:bg-[#282420] transition-colors"
                                >
                                  <div className="min-w-0">
                                    <p className="text-xs font-medium text-[#f5f2eb] truncate">{sourceNote.title}</p>
                                    <p className="text-[11px] text-[#a8a29e] truncate mt-0.5">{sourceNote.body.slice(0, 50)}...</p>
                                  </div>
                                  <ArrowRight size={14} className="text-[#a8a29e] shrink-0 ml-2" aria-hidden="true" />
                                </button>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs italic text-[#a8a29e] text-pretty">
                              No other notes link to this note yet.
                            </p>
                          )}
                        </div>

                        {/* Topics Mentioned in Selected Note */}
                        <div>
                          <span className="mb-2 block text-xs font-medium text-[#f5f2eb]">
                            Topics Mentioned in &ldquo;{activeNote.title}&rdquo;:
                          </span>
                          {graph.outgoingResolved[activeNote.id]?.length ? (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              {graph.outgoingResolved[activeNote.id].map(targetNote => (
                                <button
                                  type="button"
                                  key={targetNote.id}
                                  onClick={() => selectNote(targetNote.id)}
                                  className="flex items-center justify-between rounded-lg border border-[#10b981]/30 bg-[#064e3b]/40 p-3 text-left hover:bg-[#064e3b]/70 transition-colors"
                                >
                                  <div className="min-w-0">
                                    <p className="text-xs font-medium text-[#34d399] truncate">{targetNote.title}</p>
                                    <p className="text-[11px] text-[#a8a29e] truncate mt-0.5">{targetNote.body.slice(0, 50)}...</p>
                                  </div>
                                  <ArrowRight size={14} className="text-[#34d399] shrink-0 ml-2" aria-hidden="true" />
                                </button>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs italic text-[#a8a29e] text-pretty">
                              No outgoing links to existing notes.
                            </p>
                          )}
                        </div>

                        {/* Unwritten Topics to Create Later */}
                        {graph.unresolvedTargets[activeNote.id]?.length > 0 && (
                          <div className="rounded-lg border border-amber-500/30 bg-[#78350f]/20 p-3.5">
                            <span className="mb-2 block text-xs font-medium text-amber-200">
                              Unwritten Topics to Create Later:
                            </span>
                            <div className="flex flex-wrap gap-2">
                              {graph.unresolvedTargets[activeNote.id].map((target, idx) => (
                                <div
                                  key={idx}
                                  className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-[#211e1b] pl-3 pr-1.5 py-1 text-xs text-amber-200"
                                >
                                  <span>{target}</span>
                                  <button
                                    type="button"
                                    onClick={() => handleCreateNoteFromTopic(target)}
                                    className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-300 hover:bg-amber-500/30 transition-colors"
                                  >
                                    + Create Note
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Section 3: Reviews ("Daily Flashcard Practice") */}
                    {block.kind === "reviews" && (
                      <div className="space-y-3">
                        {lastGraded && (
                          <div className="rounded-lg border border-[#10b981]/30 bg-[#064e3b]/40 p-2.5 text-xs text-[#34d399]">
                            <p className="text-pretty">Saved score &ldquo;{lastGraded.label}&rdquo; for {notes.find(n => n.id === lastGraded.noteId)?.title}. Scheduled next review!</p>
                          </div>
                        )}

                        <div className="space-y-3">
                          {notes.map(n => {
                            const rev = reviews[n.id] ?? {
                              reps: 0,
                              interval: 1,
                              ease: 2.5,
                              lapses: 0,
                              due: "Due today",
                              leech: false,
                            };
                            const isLeech = rev.lapses >= 8 || rev.leech;
                            const isCurrent = n.id === activeNote.id;

                            return (
                              <div
                                key={n.id}
                                className={`rounded-xl border p-4 transition-colors ${
                                  isCurrent
                                    ? "border-[#10b981]/40 bg-[#211e1b]"
                                    : "border-[#332e29] bg-[#211e1b]"
                                }`}
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-semibold text-[#f5f2eb]">
                                      {n.title}
                                    </span>
                                    {isCurrent && (
                                      <span className="rounded bg-[#282420] px-2 py-0.5 text-[10px] font-medium text-[#a8a29e]">
                                        Currently Viewing
                                      </span>
                                    )}
                                  </div>

                                  <div className="flex items-center gap-2">
                                    {isLeech ? (
                                      <span className="inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-[#7f1d1d]/40 px-2.5 py-0.5 text-[11px] font-medium text-red-300">
                                        <AlertTriangle size={11} aria-hidden="true" />
                                        <span>Tricky Card</span>
                                      </span>
                                    ) : null}

                                    <span className="inline-flex items-center gap-1 rounded-full border border-[#332e29] bg-[#282420] px-2.5 py-0.5 text-xs text-[#a8a29e]">
                                      <Calendar size={11} aria-hidden="true" />
                                      <span className="tabular-nums">{rev.due}</span>
                                    </span>

                                    <span className="rounded-full border border-[#10b981]/30 bg-[#064e3b]/40 px-2.5 py-0.5 text-xs text-[#34d399] tabular-nums">
                                      Streak: {rev.reps} {rev.reps === 1 ? "review" : "reviews"}
                                    </span>
                                  </div>
                                </div>

                                {/* Flashcard Excerpt */}
                                <p className="text-xs text-[#a8a29e] line-clamp-2 text-pretty mb-3 bg-[#282420] rounded-lg p-2.5 border border-[#332e29]">
                                  {n.body}
                                </p>

                                {/* 4 Friendly Everyday Rating Buttons */}
                                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#332e29]">
                                  <span className="text-xs text-[#a8a29e]">How well did you remember this?</span>
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => handleGrade(n.id, 1, "Forgot")}
                                      className="rounded-lg border border-red-500/30 bg-[#7f1d1d]/30 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-[#7f1d1d]/60 transition-colors"
                                    >
                                      Forgot
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleGrade(n.id, 3, "Hard")}
                                      className="rounded-lg border border-amber-500/30 bg-[#78350f]/30 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-[#78350f]/60 transition-colors"
                                    >
                                      Hard
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleGrade(n.id, 4, "Good")}
                                      className="rounded-lg border border-[#10b981]/30 bg-[#064e3b]/40 px-3 py-1.5 text-xs font-medium text-[#34d399] hover:bg-[#064e3b]/70 transition-colors"
                                    >
                                      Good
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleGrade(n.id, 5, "Easy!")}
                                      className="rounded-lg border border-[#10b981]/50 bg-[#064e3b]/80 px-3.5 py-1.5 text-xs font-semibold text-[#34d399] hover:bg-[#064e3b] transition-colors"
                                    >
                                      Easy!
                                    </button>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Section 4: Text Blocks Added by AI Assistant */}
                    {block.kind === "text" && (
                      <div className="rounded-xl border border-[#332e29] bg-[#211e1b] p-4">
                        <p className="text-sm text-[#a8a29e] text-pretty">
                          {block.description}
                        </p>
                      </div>
                    )}
                  </section>
                );
              })}
          </div>
        </div>
      </main>
    </div>
  );
}
