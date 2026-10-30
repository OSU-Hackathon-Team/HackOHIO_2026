// Scripted assistant for demo mode: a few keyword intents that edit notes through the run-2 engines.
import type { NoteItem } from "../ide/store/useIdeStore";
import { CALC_FEATURE, OBSIDIAN_FEATURE } from "./fixtures";
import { applyTableOp, evaluateGrid, hasFormulas, joinNote, splitNote, type Grid, type Segment } from "./notesDocument";

export const DEMO_SUGGESTIONS = ["Add an equipment table", "Sort the inventory by units", "Summarize the budget", "Create a note called Travel"];
const CAPABILITIES = "In this demo I can add a table, sort the inventory, summarize the budget, or create a note.";

export interface DemoContext { notes: NoteItem[]; selectedNoteId: string; included: string[] }
export interface DemoReply { text: string; notes?: NoteItem[]; selectedNoteId?: string }

const fence = "```";
const tables = (note: NoteItem) => splitNote(note.body).filter((s): s is Extract<Segment, { kind: "calc" }> => s.kind === "calc");

function updateTable(note: NoteItem, pick: (grid: Grid) => boolean, change: (grid: Grid) => Grid): string | null {
  let changed = false;
  const segments = splitNote(note.body).map((s) => {
    if (changed || s.kind !== "calc" || !pick(s.grid)) return s;
    changed = true;
    return { ...s, grid: change(s.grid) };
  });
  return changed ? joinNote(segments) : null;
}

export function demoReply(prompt: string, ctx: DemoContext): DemoReply {
  const lower = prompt.toLowerCase();
  if (!ctx.included.includes(OBSIDIAN_FEATURE))
    return { text: "Your app has no notes editor yet. Reconstruct the Obsidian Markdown notes editor in the App library first." };
  const needsCalc = /table|sort|budget|total|summar/.test(lower);
  if (needsCalc && !ctx.included.includes(CALC_FEATURE))
    return { text: "Tables need the LibreOffice Calc engine. Reconstruct “Spreadsheet tables and formulas” in the App library, then ask again." };
  const active = ctx.notes.find((n) => n.id === ctx.selectedNoteId) ?? ctx.notes[0];
  const replace = (note: NoteItem, body: string) => ctx.notes.map((n) => (n.id === note.id ? { ...n, body } : n));

  const named = prompt.match(/(?:called|named|titled)\s+["“]?([^"”]+?)["”]?\s*$/i);
  if (named || /\b(new|create)\b.*\bnote\b/.test(lower)) {
    const title = named?.[1]?.trim() || `Note ${ctx.notes.length + 1}`;
    const note: NoteItem = { id: `note-${Date.now()}`, title, body: `# ${title}\n\nLinked from [[${active.title}]].` };
    return { text: `Created “${title}” and linked it back to ${active.title}.`, notes: [...ctx.notes, note], selectedNoteId: note.id };
  }

  if (/sort/.test(lower)) {
    const note = ctx.notes.find((n) => tables(n).some((t) => !hasFormulas(t.grid)));
    if (!note) return { text: "There is no formula-free table to sort. Tables with formulas cannot be sorted in this version." };
    const grid = tables(note).find((t) => !hasFormulas(t.grid))!.grid;
    const column = Math.max(0, grid[0].findIndex((h) => lower.includes(String(h).toLowerCase())));
    // Numeric columns default to largest first; explicit wording wins.
    const ascending = /\basc|smallest|lowest|a to z|alphabet/.test(lower) || !/desc|most|largest|highest|biggest|units|qty|count/.test(lower);
    const body = updateTable(note, (g) => !hasFormulas(g), (g) => applyTableOp(g, { type: "sort", column, ascending }));
    return { text: `Sorted the ${note.title} table by ${grid[0][column]} (${ascending ? "A to Z, smallest first" : "largest first"}) with the LibreOffice Calc engine.`, notes: replace(note, body!), selectedNoteId: note.id };
  }

  if (/summar|total/.test(lower)) {
    const note = ctx.notes.find((n) => tables(n).some((t) => hasFormulas(t.grid)));
    if (!note) return { text: "I couldn't find a table with formulas to summarize." };
    const values = evaluateGrid(tables(note).find((t) => hasFormulas(t.grid))!.grid);
    const total = values.at(-1)!.filter((v) => typeof v === "number").at(-1) ?? 0;
    const body = `${note.body}\n\n> [!NOTE] Summary\n> The ${note.title.toLowerCase()} total is **${total}**.`;
    return { text: `Added a summary callout to ${note.title}: the total is ${total}, calculated by the Calc engine.`, notes: replace(note, body), selectedNoteId: note.id };
  }

  if (/table/.test(lower)) {
    const body = `${active.body}\n\n## Equipment\n\n${fence}calc\nItem | Qty | Unit cost | Total\nMonitors | 2 | 150 | =B2*C2\nCables | 6 | 8 | =B3*C3\nTotal | | | =D2+D3\n${fence}`;
    return { text: `Added an equipment table to ${active.title}. Its totals are live Calc formulas.`, notes: replace(active, body), selectedNoteId: active.id };
  }

  return { text: CAPABILITIES };
}
