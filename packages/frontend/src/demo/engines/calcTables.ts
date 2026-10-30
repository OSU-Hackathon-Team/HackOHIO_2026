
export interface EvaluateInput {
  formula: string;
  cells: Record<string, number>;
}

export interface EvaluateResult {
  value: number;
}

export interface TableSortKey {
  column: number;
  ascending: boolean;
}

export interface TableOperationParams {
  type: "sort_range" | "insert_rows" | "delete_rows" | "insert_columns" | "delete_columns";
  range?: string;
  keys?: TableSortKey[];
  contains_header?: boolean;
  index?: number;
  count?: number;
  output_range?: string;
}

export interface TableOperationInput {
  operation: TableOperationParams;
  cells: Record<string, string | number>;
}

export interface TableOperationResult {
  cells: Array<Array<string | number>>;
}

export function evaluateComparison(left: number, op: string, right: number): number {
  if (op === "=" || op === "==") {
    return left === right ? 1 : 0;
  }
  if (op === ">") {
    return left > right ? 1 : 0;
  }
  if (op === "<=") {
    return left <= right ? 1 : 0;
  }
  if (op === "<") {
    return left < right ? 1 : 0;
  }
  if (op === ">=") {
    return left >= right ? 1 : 0;
  }
  if (op === "!=") {
    return left !== right ? 1 : 0;
  }
  return 0;
}

export function parseRange(rangeStr: string): { startCol: number; startRow: number; endCol: number; endRow: number } {
  const parts = rangeStr.split(":");
  const parseCell = (s: string) => {
    const m = s.match(/^([A-Za-z]+)(\d+)$/);
    if (!m) return { col: 0, row: 0 };
    let col = 0;
    const colStr = m[1].toUpperCase();
    for (let i = 0; i < colStr.length; i++) {
      col = col * 26 + (colStr.charCodeAt(i) - 64);
    }
    return { col: col - 1, row: parseInt(m[2], 10) - 1 };
  };
  const start = parseCell(parts[0]);
  const end = parts.length > 1 ? parseCell(parts[1]) : start;
  return { startCol: start.col, startRow: start.row, endCol: end.col, endRow: end.row };
}

function colName(c: number): string {
  let name = "";
  let n = c + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export function evaluateFormula(formula: string, cells: Record<string, number>): number {
  const trimmed = formula.trim();
  const expr = trimmed.startsWith("=") ? trimmed.slice(1).trim() : trimmed;

  // 1. Check for binary comparison: e.g. 5=5, 2>10, 4<=4
  const compMatch = expr.match(/^([^<>=!]+)(<=|>=|==|!=|=|<|>)([^<>=!]+)$/);
  if (compMatch) {
    const leftVal = evaluateArithmetic(compMatch[1].trim(), cells);
    const op = compMatch[2];
    const rightVal = evaluateArithmetic(compMatch[3].trim(), cells);
    return evaluateComparison(leftVal, op, rightVal);
  }

  return evaluateArithmetic(expr, cells);
}

function evaluateArithmetic(source: string, cells: Record<string, number>): number {
  type Token = { kind: "number" | "cell" | "op" | "eof"; value: string };
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at];
    if (/\s/.test(ch)) { at++; continue; }
    if ("+-*/()".includes(ch)) {
      tokens.push({ kind: "op", value: ch });
      at++;
      continue;
    }
    const numMatch = source.slice(at).match(/^\d+(?:\.\d+)?/);
    if (numMatch) {
      tokens.push({ kind: "number", value: numMatch[0] });
      at += numMatch[0].length;
      continue;
    }
    const cellMatch = source.slice(at).match(/^[A-Za-z]+[1-9]\d*/);
    if (cellMatch) {
      tokens.push({ kind: "cell", value: cellMatch[0].toUpperCase() });
      at += cellMatch[0].length;
      continue;
    }
    at++;
  }
  tokens.push({ kind: "eof", value: "" });

  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];

  const parseExpr = (): number => {
    let val = parseTerm();
    while (peek().value === "+" || peek().value === "-") {
      const op = take().value;
      const rhs = parseTerm();
      val = op === "+" ? val + rhs : val - rhs;
    }
    return val;
  };

  const parseTerm = (): number => {
    let val = parseFactor();
    while (peek().value === "*" || peek().value === "/") {
      const op = take().value;
      const rhs = parseFactor();
      val = op === "*" ? val * rhs : val / rhs;
    }
    return val;
  };

  const parseFactor = (): number => {
    const t = take();
    if (t.value === "+") return parseFactor();
    if (t.value === "-") return -parseFactor();
    if (t.value === "(") {
      const v = parseExpr();
      if (peek().value === ")") take();
      return v;
    }
    if (t.kind === "number") return parseFloat(t.value);
    if (t.kind === "cell") {
      const v = cells[t.value];
      return typeof v === "number" ? v : 0;
    }
    return 0;
  };

  return parseExpr();
}

export function executeTableOperation(
  op: TableOperationParams,
  cellsMap: Record<string, string | number>
): Array<Array<string | number>> {
  if (op.type === "sort_range") {
    const range = parseRange(op.range || "A1:Z100");
    const numRows = range.endRow - range.startRow + 1;
    const numCols = range.endCol - range.startCol + 1;

    const grid: Array<Array<string | number>> = [];
    for (let r = 0; r < numRows; r++) {
      const row: Array<string | number> = [];
      for (let c = 0; c < numCols; c++) {
        const addr = colName(range.startCol + c) + (range.startRow + r + 1);
        const val = cellsMap[addr];
        row.push(val !== undefined ? val : "");
      }
      grid.push(row);
    }

    if (op.contains_header && grid.length > 1) {
      const header = grid[0];
      const dataRows = grid.slice(1);
      const keys = op.keys || [{ column: 0, ascending: true }];

      dataRows.sort((a, b) => {
        for (const k of keys) {
          const valA = a[k.column];
          const valB = b[k.column];
          if (valA === valB) continue;
          let diff = 0;
          if (typeof valA === "number" && typeof valB === "number") {
            diff = valA - valB;
          } else {
            diff = String(valA).localeCompare(String(valB));
          }
          if (diff !== 0) {
            return k.ascending ? diff : -diff;
          }
        }
        return 0;
      });

      return [header, ...dataRows];
    }
    return grid;
  }

  if (op.type === "insert_rows") {
    const outRange = parseRange(op.output_range || "A1:B4");
    const insertIdx = op.index !== undefined ? op.index : 0;
    const count = op.count || 1;
    const numCols = outRange.endCol - outRange.startCol + 1;
    const numRows = outRange.endRow - outRange.startRow + 1;

    const grid: Array<Array<string | number>> = [];
    let origRow = outRange.startRow;

    for (let r = 0; r < numRows; r++) {
      if (r >= insertIdx && r < insertIdx + count) {
        grid.push(new Array(numCols).fill(""));
      } else {
        const row: Array<string | number> = [];
        for (let c = 0; c < numCols; c++) {
          const addr = colName(outRange.startCol + c) + (origRow + 1);
          const val = cellsMap[addr];
          row.push(val !== undefined ? val : "");
        }
        grid.push(row);
        origRow++;
      }
    }
    return grid;
  }

  if (op.type === "delete_rows") {
    const outRange = parseRange(op.output_range || "A1:B3");
    const deleteIdx = op.index !== undefined ? op.index : 0;
    const count = op.count || 1;
    const numCols = outRange.endCol - outRange.startCol + 1;
    const numRows = outRange.endRow - outRange.startRow + 1;

    const grid: Array<Array<string | number>> = [];
    let origRow = outRange.startRow;

    while (grid.length < numRows) {
      if (origRow >= deleteIdx && origRow < deleteIdx + count) {
        origRow++;
        continue;
      }
      const row: Array<string | number> = [];
      for (let c = 0; c < numCols; c++) {
        const addr = colName(outRange.startCol + c) + (origRow + 1);
        const val = cellsMap[addr];
        row.push(val !== undefined ? val : "");
      }
      grid.push(row);
      origRow++;
    }
    return grid;
  }

  if (op.type === "insert_columns") {
    const outRange = parseRange(op.output_range || "A1:D2");
    const insertIdx = op.index !== undefined ? op.index : 0;
    const count = op.count || 1;
    const numCols = outRange.endCol - outRange.startCol + 1;
    const numRows = outRange.endRow - outRange.startRow + 1;

    const grid: Array<Array<string | number>> = [];
    for (let r = 0; r < numRows; r++) {
      const row: Array<string | number> = [];
      let origCol = outRange.startCol;
      for (let c = 0; c < numCols; c++) {
        if (c >= insertIdx && c < insertIdx + count) {
          row.push("");
        } else {
          const addr = colName(origCol) + (outRange.startRow + r + 1);
          const val = cellsMap[addr];
          row.push(val !== undefined ? val : "");
          origCol++;
        }
      }
      grid.push(row);
    }
    return grid;
  }

  if (op.type === "delete_columns") {
    const outRange = parseRange(op.output_range || "A1:C2");
    const deleteIdx = op.index !== undefined ? op.index : 0;
    const count = op.count || 1;
    const numCols = outRange.endCol - outRange.startCol + 1;
    const numRows = outRange.endRow - outRange.startRow + 1;

    const grid: Array<Array<string | number>> = [];
    for (let r = 0; r < numRows; r++) {
      const row: Array<string | number> = [];
      let origCol = outRange.startCol;
      while (row.length < numCols) {
        if (origCol >= deleteIdx && origCol < deleteIdx + count) {
          origCol++;
          continue;
        }
        const addr = colName(origCol) + (outRange.startRow + r + 1);
        const val = cellsMap[addr];
        row.push(val !== undefined ? val : "");
        origCol++;
      }
      grid.push(row);
    }
    return grid;
  }

  return [];
}

export const operations = {
  evaluate: async (input: EvaluateInput) => {
    return { value: evaluateFormula(input.formula, input.cells || {}) };
  },
  table_operation: async (input: TableOperationInput) => {
    return { cells: executeTableOperation(input.operation, input.cells || {}) };
  }
};
export default operations;
