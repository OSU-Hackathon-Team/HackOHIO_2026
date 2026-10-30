// Notes with embedded Calc tables: a note body is Markdown with ```calc fences of pipe-separated rows.
// Table maths and operations run on the unmodified run-2 Calc engine.
import { evaluateFormula, executeTableOperation, type TableOperationParams } from "./engines/calcTables";

export type Cell = string | number;
export type Grid = Cell[][];
export type Segment = { kind: "markdown"; text: string } | { kind: "calc"; grid: Grid };

const FENCE = /```calc\n([\s\S]*?)\n```/g;

export function splitNote(body: string): Segment[] {
  const segments: Segment[] = [];
  let at = 0;
  for (const match of body.matchAll(FENCE)) {
    if (match.index! > at) segments.push({ kind: "markdown", text: body.slice(at, match.index) });
    segments.push({ kind: "calc", grid: parseGrid(match[1]) });
    at = match.index! + match[0].length;
  }
  if (at < body.length) segments.push({ kind: "markdown", text: body.slice(at) });
  return segments;
}

export function joinNote(segments: Segment[]): string {
  return segments.map((s) => (s.kind === "markdown" ? s.text : "```calc\n" + serializeGrid(s.grid) + "\n```")).join("");
}

export function parseGrid(source: string): Grid {
  const rows = source.split("\n").filter((line) => line.trim()).map((line) =>
    line.split("|").map((raw) => {
      const value = raw.trim();
      return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
    }));
  const width = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => [...r, ...new Array<Cell>(width - r.length).fill("")]);
}

export function serializeGrid(grid: Grid): string {
  return grid.map((row) => row.map(String).join(" | ")).join("\n");
}

export function colName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

const isFormula = (cell: Cell) => typeof cell === "string" && cell.startsWith("=");
export const hasFormulas = (grid: Grid) => grid.some((row) => row.some(isFormula));

/** Display values: formulas evaluated by the Calc engine; "#ERR" for non-finite results. */
export function evaluateGrid(grid: Grid): Grid {
  const numbers: Record<string, number> = {};
  grid.forEach((row, r) => row.forEach((cell, c) => {
    if (typeof cell === "number") numbers[colName(c) + (r + 1)] = cell;
  }));
  // shortcut: formulas evaluate in row-major order, so a formula may only reference cells above or left of it; add a dependency graph if notes need forward references.
  return grid.map((row, r) => row.map((cell, c) => {
    if (!isFormula(cell)) return cell;
    const value = evaluateFormula(String(cell), numbers);
    if (!Number.isFinite(value)) return "#ERR";
    numbers[colName(c) + (r + 1)] = value;
    return value;
  }));
}

export type TableAction =
  | { type: "sort"; column: number; ascending: boolean }
  | { type: "insert_row" | "delete_row" | "insert_column" | "delete_column"; index: number };

/** Runs one table operation on the Calc engine and returns the resulting grid. */
export function applyTableOp(grid: Grid, action: TableAction): Grid {
  const rows = grid.length, cols = grid[0]?.length ?? 0;
  const cells: Record<string, Cell> = {};
  grid.forEach((row, r) => row.forEach((cell, c) => { cells[colName(c) + (r + 1)] = cell; }));
  const range = (r: number, c: number) => `A1:${colName(c - 1)}${r}`;
  const op: TableOperationParams =
    action.type === "sort" ? { type: "sort_range", range: range(rows, cols), keys: [{ column: action.column, ascending: action.ascending }], contains_header: true }
    : action.type === "insert_row" ? { type: "insert_rows", index: action.index, count: 1, output_range: range(rows + 1, cols) }
    : action.type === "delete_row" ? { type: "delete_rows", index: action.index, count: 1, output_range: range(rows - 1, cols) }
    : action.type === "insert_column" ? { type: "insert_columns", index: action.index, count: 1, output_range: range(rows, cols + 1) }
    : { type: "delete_columns", index: action.index, count: 1, output_range: range(rows, cols - 1) };
  return executeTableOperation(op, cells);
}

/** The run-2 renderer passes raw HTML through; escape tags outside code fences before rendering. */
export function neutralizeHtml(markdown: string): string {
  let inFence = false;
  // shortcut: escapes `<` only, not a sanitizer; use DOMPurify if notes ever come from untrusted input.
  return markdown.split("\n").map((line) => {
    if (line.startsWith("```")) inFence = !inFence;
    return inFence || line.startsWith("```") ? line : line.replace(/</g, "&lt;");
  }).join("\n");
}
