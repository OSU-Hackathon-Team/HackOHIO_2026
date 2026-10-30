// "My app" in demo mode: Obsidian-style notes with embedded Calc tables, running on the run-2 engines.
import { useState, type MouseEvent } from "react";
import { ArrowDown, ArrowUp, BookOpen, FilePlus2, Pencil, Sheet } from "lucide-react";
import { useIdeStore } from "../ide/store/useIdeStore";
import { WorkspaceButton } from "../ide/WorkspaceButton";
import { cn } from "../lib/cn";
import { renderMarkdown } from "./engines/obsidianRenderer";
import { CALC_FEATURE, OBSIDIAN_FEATURE } from "./fixtures";
import {
  applyTableOp, colName, evaluateGrid, hasFormulas, joinNote, neutralizeHtml, splitNote,
  type Grid, type Segment, type TableAction,
} from "./notesDocument";

export function NotesCalcApp() {
  const s = useIdeStore();
  const [editing, setEditing] = useState(false);
  const hasEditor = s.includedFeatureIds.includes(OBSIDIAN_FEATURE);
  const hasCalc = s.includedFeatureIds.includes(CALC_FEATURE);

  if (!hasEditor) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-10 text-center">
        <BookOpen className="size-8 text-stone-600" aria-hidden="true" />
        <h2 className="text-lg font-semibold">Your app is empty</h2>
        <p className="max-w-md text-sm leading-6 text-stone-400">
          Rebuild Obsidian's Markdown notes editor in the App library to start writing. Add LibreOffice Calc's tables to make the budget live.
        </p>
        <WorkspaceButton primary onPress={() => s.setWorkspacePage("library")}>Open App library</WorkspaceButton>
      </div>
    );
  }

  const note = s.notes.find((n) => n.id === s.selectedNoteId) ?? s.notes[0];
  const segments: Segment[] = hasCalc ? splitNote(note.body) : [{ kind: "markdown", text: note.body }];
  const updateTable = (index: number, grid: Grid) =>
    s.updateNote(note.id, note.title, joinNote(segments.map((seg, i) => (i === index ? { kind: "calc", grid } : seg))));

  const followLink = (event: MouseEvent) => {
    const link = (event.target as HTMLElement).closest("a");
    if (!link) return;
    event.preventDefault();
    if (link.classList.contains("internal-link")) {
      const target = s.notes.find((n) => n.title.toLowerCase() === (link.dataset.href ?? "").toLowerCase());
      if (target) s.selectNote(target.id);
    } else if (/^https?:/.test(link.getAttribute("href") ?? "")) {
      window.open(link.getAttribute("href")!, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div className="flex h-full min-h-0 bg-[#1e1e1e]">
      <nav aria-label="Notes" className="flex w-56 shrink-0 flex-col border-r border-stone-800 bg-[#191919] p-3">
        <div className="mb-2 flex items-center justify-between px-2">
          <span className="text-xs font-medium uppercase tracking-wide text-stone-500">Vault</span>
          <button type="button" aria-label="New note" onClick={() => { s.addNote(); setEditing(true); }}
            className="rounded p-1 text-stone-400 hover:bg-stone-800 hover:text-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400">
            <FilePlus2 className="size-4" aria-hidden="true" />
          </button>
        </div>
        {s.notes.map((n) => (
          <button key={n.id} type="button" aria-current={n.id === note.id ? "page" : undefined} onClick={() => s.selectNote(n.id)}
            className={cn("truncate rounded px-2 py-1.5 text-left text-sm text-stone-400 hover:bg-stone-800 hover:text-stone-100",
              n.id === note.id && "bg-stone-800 text-stone-100")}>
            {n.title}
          </button>
        ))}
      </nav>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-stone-800 px-6">
          <span className="truncate text-sm text-stone-400">{note.title}</span>
          <WorkspaceButton aria-label={editing ? "Switch to reading view" : "Edit note"} onPress={() => setEditing(!editing)}>
            {editing ? <BookOpen className="size-4" aria-hidden="true" /> : <Pencil className="size-4" aria-hidden="true" />}
            {editing ? "Reading view" : "Edit"}
          </WorkspaceButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-10 py-8">
          <div className="mx-auto max-w-3xl">
            {editing ? (
              <div className="grid gap-3">
                <input aria-label="Note title" value={note.title} onChange={(e) => s.updateNote(note.id, e.target.value, note.body)}
                  className="bg-transparent text-2xl font-semibold text-stone-100 outline-none focus-visible:ring-2 focus-visible:ring-violet-400" />
                <textarea aria-label="Note Markdown" value={note.body} spellCheck={false} onChange={(e) => s.updateNote(note.id, note.title, e.target.value)}
                  className="min-h-[60vh] resize-none rounded-lg border border-stone-800 bg-[#191919] p-4 font-mono text-sm leading-6 text-stone-200 outline-none focus-visible:ring-2 focus-visible:ring-violet-400" />
              </div>
            ) : (
              segments.map((seg, i) =>
                seg.kind === "markdown" ? (
                  <div key={i} className="obsidian-preview" onClick={followLink}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(neutralizeHtml(seg.text)).html }} />
                ) : (
                  <CalcTable key={i} grid={seg.grid} onChange={(grid) => updateTable(i, grid)} />
                ),
              )
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function CalcTable({ grid, onChange }: { grid: Grid; onChange: (grid: Grid) => void }) {
  const [selected, setSelected] = useState<[number, number]>([grid.length - 1, 0]);
  const values = evaluateGrid(grid);
  const formulas = hasFormulas(grid);
  const [row, col] = [Math.min(selected[0], grid.length - 1), Math.min(selected[1], (grid[0]?.length ?? 1) - 1)];
  const run = (action: TableAction) => onChange(applyTableOp(grid, action));
  const tool = "rounded border border-stone-700 px-2 py-1 text-xs text-stone-300 hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400";

  return (
    <figure className="my-5 overflow-hidden rounded-lg border border-stone-700 bg-[#191919]">
      <figcaption className="flex flex-wrap items-center gap-2 border-b border-stone-800 px-3 py-2 text-xs text-stone-400">
        <Sheet className="size-3.5 text-emerald-400" aria-hidden="true" />
        <span className="mr-auto">LibreOffice Calc engine · selected {colName(col)}{row + 1}</span>
        <button type="button" className={tool} disabled={row === 0} onClick={() => run({ type: "insert_row", index: row })}>Insert row</button>
        <button type="button" className={tool} disabled={row === 0 || grid.length <= 2} onClick={() => run({ type: "delete_row", index: row })}>Delete row</button>
        <button type="button" className={tool} onClick={() => run({ type: "insert_column", index: col })}>Insert column</button>
        <button type="button" className={tool} disabled={(grid[0]?.length ?? 0) <= 1} onClick={() => run({ type: "delete_column", index: col })}>Delete column</button>
      </figcaption>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {values[0]?.map((head, c) => (
              <th key={c} scope="col" className="border-b border-stone-700 px-3 py-2 text-left font-semibold text-stone-100">
                <span className="inline-flex items-center gap-1">
                  {String(head)}
                  {[true, false].map((ascending) => (
                    <button key={String(ascending)} type="button" disabled={formulas}
                      aria-label={`Sort by ${head} ${ascending ? "ascending" : "descending"}`}
                      title={formulas ? "Tables with formulas can't be sorted yet (references are not adjusted)" : undefined}
                      onClick={() => run({ type: "sort", column: c, ascending })}
                      className="rounded p-0.5 text-stone-500 hover:text-stone-100 disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400">
                      {ascending ? <ArrowUp className="size-3" aria-hidden="true" /> : <ArrowDown className="size-3" aria-hidden="true" />}
                    </button>
                  ))}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {values.slice(1).map((cells, r) => (
            <tr key={r} className="border-b border-stone-800 last:border-0">
              {cells.map((value, c) => {
                const raw = grid[r + 1][c], isFormula = typeof raw === "string" && raw.startsWith("=");
                return (
                  <td key={c} tabIndex={0} aria-selected={row === r + 1 && col === c} title={isFormula ? String(raw) : undefined}
                    onClick={() => setSelected([r + 1, c])}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected([r + 1, c]); } }}
                    className={cn("cursor-pointer px-3 py-1.5 text-stone-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400", typeof value === "number" && "text-right tabular-nums",
                      isFormula && "text-emerald-300", row === r + 1 && col === c && "outline outline-1 outline-violet-400")}>
                    {String(value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
