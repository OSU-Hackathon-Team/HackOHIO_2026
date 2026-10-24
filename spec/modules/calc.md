# Module Specification: Calc (Spreadsheet)

> **Verification Status (2026-10-24, rev.3 — against LO core remote & compiled production binary `libforlo.so` Fresh 26.8.0-2).** **Verified:** `sc/source/core/data/document.cxx` exists and references `document.hxx`, `table.hxx`, `column.hxx`, `formulacell.hxx`, `formulagroup.hxx`, `brdcst.hxx` with `ScDocument::MakeTable`, `maTabs` (`ScTable` per sheet); and binary decompilation of `libforlo.so` verifies the complete recursive-descent formula operator precedence grammar, exact binary opcodes (`ocAdd=51`, `ocSub=50`, `ocMul=53`, `ocDiv=52`, `ocPow=55`, `ocAmpersand=54`, `ocEqual..ocGreaterEqual=56..61`, `ocRange=66`, `ocIntersect=64`, `ocUnion=65`), `FormulaGrammar` bitmasks (`0x01000000` English flag), and `VectorRefArray` column storage layout. See dedicated subsystem specification: [`calc_formula_engine.md`](calc_formula_engine.md). **Still UNVERIFIED:** `mdds` block internals and OpenCL driver setup.

## 1. Overview & Purpose (UNVERIFIED)

The spec claims **LibreOffice Calc** (`sc`, `formula`) is a high-performance spreadsheet computation engine supporting complex mathematical, statistical, financial, and engineering analysis. It features column-oriented contiguous array storage, vectorized calculation groups, multi-threaded formula evaluation, OpenCL GPU offloading, and pivot table modeling.

### Subsystems Covered
- **Document & Data Storage (`sc/source/core/data/`):**
  - Spreadsheet Model (`ScDocument`).
  - Sheet Container (`ScTable`).
  - Column Multi-Type Vector Storage (`ScColumn`, using `mdds::multi_type_vector`).
  - Cell Types (`ScValueCell`, `ScStringCell`, `ScFormulaCell`).
- **Formula Engine (`formula/`, `sc/source/core/tool/`):**
  - Grammatical Tokenizer & Compiler (`ScCompiler`).
  - Stack-Based Formula Interpreter (`ScInterpreter`).
  - OpenFormula (ODF 1.3) and Excel A1/R1C1 syntax support.
- **Dependency & Recalculation Subsystem:**
  - Dependency Tracking DAG (`ScBroadcastAreaSlotMachine`).
  - Dirty Flag Cascading (`SetDirty`).
  - Vectorized Formula Groups (`ScFormulaGroup`).
  - ThreadPool & OpenCL Execution.
- **Analysis & Pivoting:**
  - Pivot Tables / Data Pilot (`ScDPObject`).
  - Auto-Filtering, Sorting, and Conditional Formatting.

---

## 2. Component Architecture & Data Structures

```mermaid
classDiagram
    direction TB
    class ScDocument {
        -List~ScTable~ sheets
        -ScCalculationSettings calcConfig
        +GetValue(ScAddress addr) double
        +GetString(ScAddress addr) string
        +SetFormula(ScAddress addr, string expr) void
        +CalcFormulaTree() void
    }
    class ScTable {
        -List~ScColumn~ columns
        -string sheetName
        +GetColumn(int colIdx) ScColumn
    }
    class ScColumn {
        -MultiTypeVector cellStorage
        -BroadcasterArray broadcasters
        +GetCellType(int rowIdx) CellType
        +SetNumericValue(int rowIdx, double val) void
        +SetFormulaCell(int rowIdx, ScFormulaCell cell) void
    }
    class ScFormulaCell {
        -TokenArray rpnBytecode
        -ResultValue cachedResult
        -boolean isDirty
        -ScFormulaGroup group
        +Interpret() void
        +SetDirty() void
    }
    class ScInterpreter {
        -Stack~FormulaToken~ evaluationStack
        +PushDouble(double val) void
        +PopDouble() double
        +StepOpCode(OpCode code) void
    }

    ScDocument --> ScTable : contains up to 10,000 sheets
    ScTable --> ScColumn : contains 1,024 to 16,384 columns
    ScColumn --> ScFormulaCell : manages formula cells
    ScFormulaCell ..> ScInterpreter : evaluated by
```

### Conceptual Data Structures (UNVERIFIED — no `mdds`/column-storage sources found; limits unverified)

#### 1. Column Multi-Type Vector Storage (`mdds`)
To maximize cache locality and reduce memory overhead, spreadsheet cells are stored column-wise in contiguous memory blocks partitioned by data type:
- **Block Types:** `EmptyBlock`, `NumericBlock` (contiguous IEEE-754 `double` arrays), `StringBlock` (string pointers), `FormulaBlock` (`ScFormulaCell` pointers).
- **Advantage:** Storing 1,000,000 numbers in a column requires only one contiguous array of 8 MB, avoiding object overhead and pointer indirection.

#### 2. `ScAddress` & Spatial Coordinates
- **Representation:** Struct containing 32-bit `Row`, 16-bit `Column`, and 16-bit `Tab` (Sheet index). **VERIFIED:** `sc/inc/types.hxx`: `SCROW=sal_Int32`, `SCCOL/SCTAB=sal_Int16`.
- **Limits:** Supports up to 16,384 columns (`MAXCOLCOUNT=16*1024` in `sc/inc/address.hxx:61`) and up to 10,000 sheets (`MAXTABCOUNT=10000`, `address.hxx:64`) — **VERIFIED**. Rows: default `MAXROWCOUNT=1024*1024` (1,048,576 rows, `address.hxx:60`); 16,777,216 rows applies only to `MAXROWCOUNT_JUMBO=16*1024*1024` (`address.hxx:70`), not the default. **PARTIALLY VERIFIED — prior unconditional “16,777,216 rows” corrected to distinguish default vs jumbo.**

#### 3. Formula Token Bytecode (`TokenArray`)
- Formulas are compiled from text into Reverse Polish Notation (RPN) token arrays. Tokens represent:
  - Immediate Literals (Double, String).
  - Cell References (`SingleRef`, `AreaRef`).
  - OpCodes (**VERIFIED** in `include/formula/opcode.hxx`: `ocAdd=51` (line 93), `ocMul=53` (line 95) — not `ocMultiply`; `ocSum=224` (line 263) — not `ocSUM`; `ocIf=6` (line 39) — not `ocIF`; `ocVLookup=286` (line 327) — not `ocVLOOKUP`). **CORRECTED — prior opcode casing/names were incorrect.** RPN execution order and dirty-propagation sequence remain **UNVERIFIED**.

---

## 3. Behavioral Rules & Algorithms (UNVERIFIED — RPN opcodes, dirty-propagation not verified)

### 3.1 Formula Stack Machine Evaluation

```
Algorithm: InterpretFormulaRPN(formulaCell)
Input: formulaCell (ScFormulaCell)
Output: EvaluationResult

1. Stack := Empty Stack of FormulaTokens
2. InterpreterContext := InitContext(formulaCell.getDocument())

3. For each token in formulaCell.getRPNTokens():
     Switch token.getType():
       Case LITERAL_VALUE:
         Stack.push(token)
         
       Case CELL_REFERENCE:
         Val := FetchCellValue(token.getAddress())
         Stack.push(New Token(Val))
         
       Case AREA_REFERENCE:
         Stack.push(token) // Pushes range descriptor [StartAddr, EndAddr]
         
       Case OPERATOR_ADD:
         Right := Stack.pop().getDouble()
         Left := Stack.pop().getDouble()
         Stack.push(New Token(Left + Right))
         
       Case FUNCTION_SUM:
         RangeToken := Stack.pop()
         SumTotal := 0.0
         For each cell in RangeToken.iterateCells():
           SumTotal := SumTotal + cell.getNumericValue()
         Stack.push(New Token(SumTotal))
         
       Case FUNCTION_IF:
         FalseVal := Stack.pop()
         TrueVal := Stack.pop()
         Condition := Stack.pop().getBoolean()
         If Condition: Stack.push(TrueVal)
         Else: Stack.push(FalseVal)

4. FinalResult := Stack.pop()
5. formulaCell.setCachedResult(FinalResult)
6. formulaCell.clearDirty()
7. Return FinalResult
```

### 3.2 Dependency DAG Dirty Propagation

When a cell value changes:

```
Algorithm: PropagateCellDirty(changedAddress)
Input: changedAddress (ScAddress)
Output: None

1. Queue := Empty Queue of Broadcasters
2. Queue.enqueue(GetBroadcasterAt(changedAddress))

3. While Queue is Not Empty:
     Broadcaster := Queue.dequeue()
     For each listenerCell in Broadcaster.getListeners():
       If Not listenerCell.isDirty():
         listenerCell.setDirty(true)
         // Enqueue listeners that depend on this formula cell
         If listenerCell has Broadcaster:
           Queue.enqueue(listenerCell.getBroadcaster())

4. RegisterAsynchronousRecalculationEvent()
```

---

## 4. State Transitions & Vectorized Formula Groups (UNVERIFIED — formula-group/OpenCL/SIMD claims not observed)

Contiguous formula cells containing identical logic across consecutive rows (e.g., `=A1*B1`, `=A2*B2`, `=A3*B3`) are consolidated into a **Formula Group**:

```mermaid
flowchart TD
    Cell1["Row 1: =A1*B1"] & Cell2["Row 2: =A2*B2"] & Cell3["Row 3: =A3*B3"] --> Group["ScFormulaGroup: Count=3, BaseToken=(A[x] * B[x])"]
    
    Group --> CheckEngine{OpenCL / AVX2 Enabled?}
    CheckEngine -->|Yes: Large Batch| GPU["Dispatch GPU Kernel / SIMD Vector Array"]
    CheckEngine -->|No: ThreadPool| MultiCPU["Partition into Slices & Run on Worker Threads"]
    
    GPU --> Results["Packed Results: [Result1, Result2, Result3]"]
    MultiCPU --> Results
    Results --> Store["Scatter Values to Numeric Column Storage"]
```

- **Vectorized SIMD Execution:** Instead of executing the interpreter loop 1,000,000 times row by row, the engine fetches contiguous memory pointers from columns `A` and `B` and executes vectorized multiplication in native SIMD instructions or an OpenCL GPU kernel.

---

## 5. Error Handling & Edge Cases (PARTIALLY VERIFIED — codes verified; propagation behavior UNVERIFIED)

1. **Circular Reference Detection:** When formula evaluation encounters an indirect cycle ($A1 \to B1 \to C1 \to A1$):
   - The interpreter tracks evaluation depth on the active call stack (`RecursionCounter`). [UNVERIFIED — call-stack tracking not traced in this pass.]
   - If a cell is encountered while already in an evaluating state:
     - If Iterative Calculation is enabled, it stops when reaching `MaxIterations` or `MaxChange`. [UNVERIFIED.]
     - If disabled, evaluation terminates immediately and sets the cell result to error code `522` (**VERIFIED** `FormulaError::CircularReference=522` in `include/formula/errorcodes.hxx:53`; **CORRECTED** — 522 is circular reference, not `#REF!`; `#REF!` is `NoRef=524` at `errorcodes.hxx:55`).
2. **Division by Zero:** Evaluates to error code `532` (`#DIV/0!`) (**VERIFIED** `FormulaError::DivisionByZero=532` in `include/formula/errorcodes.hxx:65`; **CORRECTED — prior `503` was incorrect**: `503` is `IllegalFPOperation // #NUM!` at `errorcodes.hxx:36`). Propagation to dependents without crashing remains **UNVERIFIED**.
3. **Invalid Range Expansion on Deleted Sheet:** When a referenced sheet is deleted from the workbook:
   - References targeting the deleted sheet are rewritten to invalid ref tokens (`#REF!`).
