import { z } from "zod";
import { applyTableOp, colName, evaluateGrid, hasFormulas, type Grid } from "./notesDocument";

const cell = z.union([z.string().max(500), z.number().finite()]);
const grid = z.array(z.array(cell).min(1).max(16)).min(2).max(100);
const note = z.object({ id: z.string(), title: z.string().min(1).max(100), body: z.string().max(100_000), tags: z.array(z.string().max(40)).max(20) });
const table = z.object({ id: z.string(), title: z.string().min(1).max(100), grid, filter: z.string().max(100).optional() });
const task = z.object({ id: z.string(), title: z.string().min(1).max(200), done: z.boolean(), due: z.string().optional(), priority: z.enum(["low", "medium", "high"]).optional() });
const section = z.object({ id: z.string(), kind: z.enum(["notes", "table", "tasks", "metric", "chart"]), ref: z.string(), title: z.string().max(100), visible: z.boolean(), width: z.enum(["full", "half"]), metric: z.enum(["sum", "count", "average", "completion"]).optional(), categoryColumn: z.number().int().nonnegative().optional(), valueColumn: z.number().int().nonnegative().optional() });

export const ShowcaseProject = z.object({
  version: z.literal(1), id: z.string(), revision: z.number().int().nonnegative(), title: z.string().min(1).max(100),
  capabilities: z.array(z.enum(["notes", "calc", "tasks", "search", "tags", "metrics", "charts"])),
  notes: z.array(note), tables: z.array(table), tasks: z.array(task), sections: z.array(section),
  theme: z.object({ mode: z.enum(["dark", "light"]), accent: z.enum(["amber", "green", "blue", "violet"]), density: z.enum(["comfortable", "compact"]) }),
}).superRefine((p, ctx) => {
  for (const [kind, items] of [["note", p.notes], ["table", p.tables], ["task", p.tasks], ["section", p.sections]] as const) {
    if (new Set(items.map(item => item.id)).size !== items.length) ctx.addIssue({ code: "custom", message: `Duplicate ${kind} IDs` });
  }
  for (const t of p.tables) {
    const width = t.grid[0].length;
    if (t.grid.some(row => row.length !== width)) ctx.addIssue({ code: "custom", message: `Table ${t.title} has uneven rows` });
  }
  for (const s of p.sections) {
    if (s.kind === "table" && !p.tables.some(t => t.id === s.ref)) ctx.addIssue({ code: "custom", message: `Table section ${s.title} has no table` });
    if (s.kind === "chart" && !p.tables.some(t => t.id === s.ref)) ctx.addIssue({ code: "custom", message: `Chart ${s.title} has no table` });
    if (s.kind === "metric" && s.ref !== "all" && s.ref !== "tasks" && !p.tables.some(t => t.id === s.ref)) ctx.addIssue({ code: "custom", message: `Metric ${s.title} has no source` });
    if (s.kind === "metric" && ((s.metric === "completion" && s.ref !== "tasks") || (s.ref === "tasks" && s.metric !== undefined && !["completion", "count"].includes(s.metric)))) ctx.addIssue({ code: "custom", message: `Metric ${s.title} is incompatible with its source` });
    if (s.kind === "chart") {
      const t = p.tables.find(t => t.id === s.ref);
      if (t && ((s.categoryColumn ?? 0) >= t.grid[0].length || (s.valueColumn ?? t.grid[0].length - 1) >= t.grid[0].length)) ctx.addIssue({ code: "custom", message: `Chart ${s.title} column is out of range` });
    }
  }
});
export type ShowcaseProject = z.infer<typeof ShowcaseProject>;

export const ShowcaseAction = z.object({
  type: z.enum(["project.rename", "capability.enable", "capability.disable", "section.add", "section.update", "section.move", "section.remove", "note.create", "note.update", "note.duplicate", "note.delete", "table.create", "table.rename", "table.delete", "table.cell", "table.addRow", "table.deleteRow", "table.addColumn", "table.deleteColumn", "table.sort", "table.filter", "task.create", "task.update", "task.delete", "theme.update"]),
  target: z.string().max(100),
  data: z.record(z.unknown()),
});
export type ShowcaseAction = z.infer<typeof ShowcaseAction>;
export const showcaseId = () => crypto.randomUUID();
const asString = (value: unknown, name: string, max = 100) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be text under ${max} characters`);
  return value.trim();
};
const asIndex = (value: unknown, max: number, name: string) => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) throw new Error(`${name} is out of range`);
  return value;
};
const findByName = <T extends { id: string; title: string }>(items: T[], target: string, kind: string) => {
  const item = items.find(x => x.id === target || x.title.toLowerCase() === target.toLowerCase());
  if (!item) throw new Error(`${kind} “${target}” was not found`);
  return item;
};
const enable = (p: ShowcaseProject, name: string) => {
  const capability = z.enum(["notes", "calc", "tasks", "search", "tags", "metrics", "charts"]).parse(name);
  if (!p.capabilities.includes(capability)) {
    p.capabilities.push(capability);
    p.sections = p.sections.map(s => ({ ...s, visible: s.visible || (capability === "notes" && s.kind === "notes") || (capability === "calc" && s.kind === "table") || (capability === "tasks" && s.kind === "tasks") || (capability === "metrics" && s.kind === "metric") || (capability === "charts" && s.kind === "chart") }));
  }
  if (capability === "calc" || capability === "search" || capability === "tags") enable(p, "notes");
  if (capability === "charts" || capability === "metrics") enable(p, "calc");
};
const disable = (p: ShowcaseProject, name: string) => {
  const capability = z.enum(["notes", "calc", "tasks", "search", "tags", "metrics", "charts"]).parse(name);
  const removed = new Set<string>([capability]);
  if (capability === "notes") { removed.add("calc"); removed.add("search"); removed.add("tags"); }
  if (removed.has("calc")) { removed.add("metrics"); removed.add("charts"); }
  p.capabilities = p.capabilities.filter(c => !removed.has(c));
  p.sections = p.sections.map(s => ({ ...s, visible: s.visible && !(
    (s.kind === "notes" && removed.has("notes")) || (s.kind === "table" && removed.has("calc")) ||
    (s.kind === "tasks" && removed.has("tasks")) || (s.kind === "metric" && removed.has("metrics")) ||
    (s.kind === "chart" && removed.has("charts"))
  ) }));
};
const addSection = (p: ShowcaseProject, kind: ShowcaseProject["sections"][number]["kind"], ref: string, title: string) => {
  p.sections.push({ id: showcaseId(), kind, ref, title, visible: true, width: kind === "notes" ? "full" : "half" });
};

/** All actions are checked on a copy; one invalid action leaves the original untouched. */
export function applyShowcaseActions(current: ShowcaseProject, proposed: unknown[]): ShowcaseProject {
  if (!Array.isArray(proposed) || proposed.length < 1 || proposed.length > 20) throw new Error("An edit must contain 1–20 actions");
  const p = structuredClone(current);
  for (const raw of proposed) {
    const { type, target, data } = ShowcaseAction.parse(raw);
    switch (type) {
      case "project.rename": p.title = asString(data.title, "Project title"); break;
      case "capability.enable": enable(p, target); break;
      case "capability.disable": disable(p, target); break;
      case "note.create": {
        enable(p, "notes");
        const title = asString(data.title, "Note title");
        if (p.notes.some(n => n.title.toLowerCase() === title.toLowerCase())) throw new Error(`Note “${title}” already exists`);
        p.notes.push({ id: showcaseId(), title, body: typeof data.body === "string" ? data.body.slice(0, 100_000) : `# ${title}\n`, tags: [] });
        if (!p.sections.some(s => s.kind === "notes")) addSection(p, "notes", "all", "Notes");
        break;
      }
      case "note.update": {
        const n = findByName(p.notes, target, "Note");
        if (data.title !== undefined) {
          const title = asString(data.title, "Note title");
          if (p.notes.some(other => other.id !== n.id && other.title.toLowerCase() === title.toLowerCase())) throw new Error(`Note “${title}” already exists`);
          n.title = title;
        }
        if (data.body !== undefined) n.body = z.string().max(100_000).parse(data.body);
        if (data.append !== undefined) n.body += z.string().max(20_000).parse(data.append);
        if (data.tags !== undefined) { enable(p, "tags"); n.tags = z.array(z.string().min(1).max(40)).max(20).parse(data.tags); }
        break;
      }
      case "note.delete": p.notes.splice(p.notes.indexOf(findByName(p.notes, target, "Note")), 1); break;
      case "note.duplicate": {
        const original = findByName(p.notes, target, "Note");
        const title = asString(data.title ?? `${original.title} copy`, "Note title");
        if (p.notes.some(n => n.title.toLowerCase() === title.toLowerCase())) throw new Error(`Note “${title}” already exists`);
        p.notes.push({ ...structuredClone(original), id: showcaseId(), title });
        break;
      }
      case "table.create": {
        enable(p, "calc");
        const title = asString(data.title, "Table title");
        if (p.tables.some(t => t.title.toLowerCase() === title.toLowerCase())) throw new Error(`Table “${title}” already exists`);
        const parsed = grid.parse(data.grid);
        if (parsed.some(row => row.length !== parsed[0].length)) throw new Error("Table rows must have the same number of cells");
        const id = showcaseId(); p.tables.push({ id, title, grid: parsed, filter: "" }); addSection(p, "table", id, title);
        break;
      }
      case "table.rename": {
        const t = findByName(p.tables, target, "Table");
        const title = asString(data.title, "Table title");
        if (p.tables.some(other => other.id !== t.id && other.title.toLowerCase() === title.toLowerCase())) throw new Error(`Table “${title}” already exists`);
        t.title = title;
        break;
      }
      case "table.delete": {
        const t = findByName(p.tables, target, "Table");
        p.tables.splice(p.tables.indexOf(t), 1);
        p.sections = p.sections.filter(s => s.ref !== t.id);
        break;
      }
      case "table.cell": {
        const t = findByName(p.tables, target, "Table");
        const row = asIndex(data.row, t.grid.length - 1, "Row"), col = asIndex(data.col, t.grid[0].length - 1, "Column");
        t.grid[row][col] = cell.parse(data.value);
        break;
      }
      case "table.addRow": {
        const t = findByName(p.tables, target, "Table");
        const row = data.row === undefined ? Array(t.grid[0].length).fill("") : z.array(cell).length(t.grid[0].length).parse(data.row);
        const totalRow = /\b(total|sum)\b/i.test(String(t.grid.at(-1)?.[0]));
        const index = data.index === undefined ? (totalRow ? t.grid.length - 1 : t.grid.length) : asIndex(data.index, t.grid.length, "Row position");
        if (t.grid.length >= 100) throw new Error("Table is full");
        if (hasFormulas(t.grid) && totalRow && index !== t.grid.length - 1) throw new Error("Add a row above the total to preserve formula references");
        if (hasFormulas(t.grid) && !totalRow && index < t.grid.length) throw new Error("Only append rows in formula tables without a total row");
        if (hasFormulas(t.grid) && index === t.grid.length - 1) {
          const oldTotal = t.grid.at(-1)!;
          for (let c = 1; c < oldTotal.length; c++) {
            const formula = oldTotal[c];
            if (typeof formula !== "string" || !formula.startsWith("=")) continue;
            const refs = formula.slice(1).split("+");
            if (refs.length && refs.every(ref => new RegExp(`^${colName(c)}[2-9]\\d*$`).test(ref.trim()))) oldTotal[c] = `${formula}+${colName(c)}${index + 1}`;
          }
        }
        t.grid.splice(index, 0, row);
        break;
      }
      case "table.deleteRow": {
        const t = findByName(p.tables, target, "Table");
        const index = asIndex(data.index, t.grid.length - 1, "Row");
        if (index === 0 || t.grid.length <= 2 || hasFormulas(t.grid)) throw new Error("Cannot delete this row while formulas may reference it");
        t.grid.splice(index, 1);
        break;
      }
      case "table.addColumn": {
        const t = findByName(p.tables, target, "Table");
        if (hasFormulas(t.grid)) throw new Error("Column changes in formula tables need reference adjustment");
        if (t.grid[0].length >= 16) throw new Error("Table is full");
        const index = data.index === undefined ? t.grid[0].length : asIndex(data.index, t.grid[0].length, "Column position");
        for (const row of t.grid) row.splice(index, 0, "");
        if (data.title !== undefined) t.grid[0][index] = asString(data.title, "Column title");
        break;
      }
      case "table.deleteColumn": {
        const t = findByName(p.tables, target, "Table");
        if (hasFormulas(t.grid)) throw new Error("Column changes in formula tables need reference adjustment");
        if (t.grid[0].length <= 1) throw new Error("The last column cannot be deleted");
        const index = asIndex(data.index, t.grid[0].length - 1, "Column");
        for (const row of t.grid) row.splice(index, 1);
        break;
      }
      case "table.sort": {
        const t = findByName(p.tables, target, "Table");
        if (hasFormulas(t.grid)) throw new Error("Sorting formula tables requires reference adjustment and is unavailable");
        const col = asIndex(data.column, t.grid[0].length - 1, "Sort column");
        t.grid = applyTableOp(t.grid, { type: "sort", column: col, ascending: data.ascending !== false });
        break;
      }
      case "table.filter": {
        const t = findByName(p.tables, target, "Table");
        t.filter = z.string().max(100).parse(data.query);
        break;
      }
      case "task.create": {
        enable(p, "tasks");
        const title = asString(data.title, "Task title", 200);
        p.tasks.push({ id: showcaseId(), title, done: false, due: typeof data.due === "string" ? data.due : undefined, priority: data.priority === undefined ? undefined : z.enum(["low", "medium", "high"]).parse(data.priority) });
        if (!p.sections.some(s => s.kind === "tasks")) addSection(p, "tasks", "all", "Tasks");
        break;
      }
      case "task.update": {
        const t = findByName(p.tasks, target, "Task");
        if (data.title !== undefined) t.title = asString(data.title, "Task title", 200);
        if (data.done !== undefined) t.done = z.boolean().parse(data.done);
        if (data.due !== undefined) t.due = z.string().parse(data.due);
        if (data.priority !== undefined) t.priority = z.enum(["low", "medium", "high"]).parse(data.priority);
        break;
      }
      case "task.delete": p.tasks.splice(p.tasks.indexOf(findByName(p.tasks, target, "Task")), 1); break;
      case "theme.update": {
        if (data.mode !== undefined) p.theme.mode = z.enum(["dark", "light"]).parse(data.mode);
        if (data.accent !== undefined) p.theme.accent = z.enum(["amber", "green", "blue", "violet"]).parse(data.accent);
        if (data.density !== undefined) p.theme.density = z.enum(["comfortable", "compact"]).parse(data.density);
        break;
      }
      case "section.add": {
        const kind = z.enum(["notes", "tasks", "metric", "chart"]).parse(data.kind);
        if (kind === "metric") enable(p, "metrics");
        if (kind === "chart") enable(p, "charts");
        if (kind === "notes") enable(p, "notes");
        if (kind === "tasks") enable(p, "tasks");
        const ref = kind === "chart" || (kind === "metric" && data.ref && data.ref !== "all" && data.ref !== "tasks") ? findByName(p.tables, asString(data.ref, "Source table"), "Table").id : kind === "metric" && data.ref === "tasks" ? "tasks" : "all";
        addSection(p, kind, ref, asString(data.title ?? kind, "Section title"));
        const added = p.sections.at(-1)!;
        if (kind === "metric") added.metric = data.metric === undefined ? ref === "tasks" ? "completion" : "sum" : z.enum(["sum", "count", "average", "completion"]).parse(data.metric);
        if (kind === "chart") {
          if (data.categoryColumn !== undefined) added.categoryColumn = asIndex(data.categoryColumn, p.tables.find(t => t.id === ref)!.grid[0].length - 1, "Category column");
          if (data.valueColumn !== undefined) added.valueColumn = asIndex(data.valueColumn, p.tables.find(t => t.id === ref)!.grid[0].length - 1, "Value column");
        }
        break;
      }
      case "section.update": {
        const s = findByName(p.sections, target, "Section");
        if (data.title !== undefined) s.title = asString(data.title, "Section title");
        if (data.visible !== undefined) s.visible = z.boolean().parse(data.visible);
        if (data.width !== undefined) s.width = z.enum(["full", "half"]).parse(data.width);
        if (data.ref !== undefined && (s.kind === "metric" || s.kind === "chart")) s.ref = data.ref === "all" || data.ref === "tasks" && s.kind === "metric" ? String(data.ref) : findByName(p.tables, asString(data.ref, "Source table"), "Table").id;
        if (data.metric !== undefined && s.kind === "metric") s.metric = z.enum(["sum", "count", "average", "completion"]).parse(data.metric);
        if (s.kind === "metric" && data.ref !== undefined && data.metric === undefined) s.metric = s.ref === "tasks" ? "completion" : "sum";
        if (s.kind === "chart") {
          const max = p.tables.find(t => t.id === s.ref)!.grid[0].length - 1;
          if (data.ref !== undefined) { s.categoryColumn = 0; s.valueColumn = max; }
          if (data.categoryColumn !== undefined) s.categoryColumn = asIndex(data.categoryColumn, max, "Category column");
          if (data.valueColumn !== undefined) s.valueColumn = asIndex(data.valueColumn, max, "Value column");
        }
        break;
      }
      case "section.move": {
        const s = findByName(p.sections, target, "Section");
        const index = asIndex(data.index, p.sections.length - 1, "Section position");
        p.sections.splice(p.sections.indexOf(s), 1); p.sections.splice(index, 0, s);
        break;
      }
      case "section.remove": p.sections.splice(p.sections.indexOf(findByName(p.sections, target, "Section")), 1); break;
    }
  }
  p.revision++;
  return ShowcaseProject.parse(p);
}

export function tableValues(p: ShowcaseProject, tableId: string): Grid {
  const t = p.tables.find(x => x.id === tableId);
  if (!t) return [];
  return evaluateGrid(t.grid);
}

export function tableTotal(p: ShowcaseProject, tableId: string): number {
  const values = tableValues(p, tableId);
  const final = values.at(-1);
  if (final && /\b(total|sum)\b/i.test(String(final[0]))) return typeof final.at(-1) === "number" ? final.at(-1) as number : 0;
  return values.slice(1).reduce((sum, row) => sum + (typeof row.at(-1) === "number" ? row.at(-1) as number : 0), 0);
}

export function projectTotal(p: ShowcaseProject): number {
  return p.tables.reduce((sum, t) => sum + tableTotal(p, t.id), 0);
}

export function metricValue(p: ShowcaseProject, section: ShowcaseProject["sections"][number]): string {
  if (section.ref === "tasks") {
    const done = p.tasks.filter(t => t.done).length;
    if (section.metric === "count") return String(p.tasks.length);
    return `${p.tasks.length ? Math.round(done / p.tasks.length * 100) : 0}%`;
  }
  const tables = section.ref === "all" ? p.tables : p.tables.filter(t => t.id === section.ref);
  if (section.metric === "count") return String(tables.reduce((sum, t) => sum + t.grid.slice(1).filter(row => !/\b(total|sum)\b/i.test(String(row[0]))).length, 0));
  if (section.metric === "average") {
    const count = tables.reduce((sum, t) => sum + t.grid.slice(1).filter(row => !/\b(total|sum)\b/i.test(String(row[0]))).length, 0);
    return (count ? tables.reduce((sum, t) => sum + tableTotal(p, t.id), 0) / count : 0).toFixed(2);
  }
  return (section.ref === "all" ? projectTotal(p) : tableTotal(p, section.ref)).toFixed(2);
}

export function tableCsv(p: ShowcaseProject, id: string): string {
  return tableValues(p, id).map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
}

export function parseCsv(source: string): Grid {
  if (source.length > 1_000_000) throw new Error("CSV is too large for the showcase (1 MB maximum)");
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, started = false;
  const endField = () => { row.push(field); field = ""; started = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && !started && !field) { quoted = true; started = true; }
    else if (ch === ',') endField();
    else if (ch === "\r" || ch === "\n") { if (ch === "\r" && source[i + 1] === "\n") i++; endRow(); }
    else { field += ch; started = true; }
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field");
  if (field || row.length || started) endRow();
  if (!rows.length || rows[0].every(x => !x.trim())) throw new Error("CSV needs a header row");
  const width = Math.max(...rows.map(r => r.length));
  if (width > 16 || rows.length > 100) throw new Error("CSV exceeds the 16-column or 100-row showcase limit");
  if (rows.length === 1) rows.push(Array(width).fill(""));
  return rows.map((r, index) => Array.from({ length: width }, (_, col) => {
    const value = (r[col] ?? "").trim();
    return index > 0 && /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  }));
}

export function cellLabel(row: number, col: number): string { return `${colName(col)}${row + 1}`; }
