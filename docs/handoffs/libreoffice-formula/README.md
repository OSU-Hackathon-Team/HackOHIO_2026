# LibreOffice Calc: decomp handoff

Dossier readiness: **partial**. Functions drafted 19/20, independently reviewed 19.
Claim verdicts: contradicted 4, supported_static 37, uncertain 3.

## Using this for a FeatureSpec

- `supported_static` claims are candidate requirements. `uncertain` claims need runtime confirmation. Drop `contradicted` claims. `unreviewed` claims are unverified.
- `observed_cases` are real results from LibreOffice Calc 420(Build:2); use them as acceptance-test examples.
- 10 held-out cases are deliberately withheld for independent checking. Do not ask for them.
- C++ mechanics (offsets, vtables, constructors) are not requirements; list them under `stripped_glue` if needed.
- `native_spec.json` (artifact `2822255a266137ea962536b5476cc91d7f43bc67d810eacf152ef5325493bf0a`) is a **draft**: the evidence is incomplete, so the adapter refuses it. Use it as a starting point and hand-author the FeatureSpec in the format of `fixtures/hand-authored/specs/*.json`.

## Readiness blockers (details in evidence.json)

- claim_needs_resolution: 7
- claims_not_linked_to_original_probes: 1
- dependency_contracts_need_review: 1
- direct_calls_without_bound_dependencies: 1
- independent_review_gaps: 1
- missing_function_drafts: 1
- unresolved_scope_edge: 112

## Functions

### `ScValueIterator::ScValueIterator(ScInterpreterContext&, ScRange const&, SubtotalFlags, bool)` (005a0830)
Draft unreviewed, review reviewed.
- [supported_static] The input ScInterpreterContext reference becomes accessible via the constructed iterator's context interface
- [supported_static] If an input table index is below zero or exceeds the document's last table index, that index is reset to the document's last table index
- [supported_static] If an input row index is below zero or exceeds the document's last row index, that index is reset to the document's last row index
- [contradicted] If an input column index is above 9999 or exceeds the document's last column index, that index is reset to the document's last column index or 9999, whichever is smaller

### `ScDocument::GetNumberFormat(ScInterpreterContext const&, ScAddress const&) const` (005ddbb0)
Draft unreviewed, review reviewed.
- [supported_static] Returns zero when the sheet index derived from the third parameter does not correspond to an existing table
- [supported_static] Returns zero when table metadata for the requested sheet index is null or uninitialized
- [uncertain] Jumps to external routine at 7482416 when all validation checks pass and format lookup succeeds

### `ScTable::GetNumberFormat(ScInterpreterContext const&, ScAddress const&) const` (00722c30)
Draft unreviewed, review reviewed.
- [supported_static] Returns numerical zero when the column coordinate from the third argument is below zero
- [supported_static] Returns numerical zero when the column coordinate meets or exceeds a derived upper column bound
- [supported_static] Returns numerical zero when the row coordinate from the third argument is below zero
- [supported_static] Returns numerical zero when the row coordinate meets or exceeds a derived upper row bound

### `(anonymous namespace)::ConventionOOO_A1::getSpecialSymbol(ScCompiler::Convention::SpecialSymbolType) const` (007b5220)
Draft unreviewed, review reviewed.
- [supported_static] The function returns 46 when the input convention type is zero
- [supported_static] The function returns 36 when the input convention type is exactly one
- [supported_static] The function returns zero for any input convention type that is neither zero nor one

### `ScCompiler::ParseDoubleReference(rtl::OUString const&, rtl::OUString const*)` (007bd200)
Draft unreviewed, review reviewed.
- [uncertain] Transforms textual cell range descriptors like "B1:B3" into internal structured reference formats when input is well-formed

### `ScCompiler::HasPossibleNamedRangeConflict(short) const` (007bda00)
Draft unreviewed, review reviewed.
- [supported_static] Returns 1 if the default named range retrieved from the document has its lowest bit set in the status byte after necessary cleanup
- [supported_static] Returns 1 if a named range matching the provided short identifier has its lowest bit set in the status byte after necessary cleanup

### `ScCompiler::NextSymbol(bool)` (007c2da0)
Draft partial, review None.

### `ScInterpreter::ScEqual()` (007f1ef0)
Draft unreviewed, review reviewed.
- [contradicted] Pushes numeric 0.0 onto the interpreter stack when comparing unequal finite double operands
- [supported_static] Pushes numeric 1.0 onto the interpreter stack when comparing equal finite double operands

### `ScInterpreter::ScGreater()` (007f21d0)
Draft unreviewed, review reviewed.
- [supported_static] Function evaluates a greater-than relation between two operands from the interpreter stack
- [supported_static] If either operand is a matrix, the function prepares storage for a matrix-based evaluation context
- [contradicted] The function pushes a numeric boolean result when evaluating non-matrix comparisons

### `ScInterpreter::ScLessEqual()` (007f22c0)
Draft unreviewed, review reviewed.
- [supported_static] Evaluates a less-than-or-equal comparison between the top two interpreter operands if they are convertible to numbers
- [uncertain] Pushes a boolean result indicating whether the comparison holds, or pushes an error if not

### `ScInterpreter::GetString()` (0084b4b0)
Draft unreviewed, review reviewed.

### `ScInterpreter::ScSub()` (0085e100)
Draft unreviewed, review reviewed.
- [supported_static] The function configures for a subtraction operation then dispatches to a shared arithmetic handler

### `ScAttrArray::GetPattern(int) const` (0049f990)
Draft unreviewed, review reviewed.
- [supported_static] If the object's data end equals data start then a valid index between zero and a secondary limit returns a default item

### `ScDocument::GetDocOptions() const` (005bbdf0)
Draft unreviewed, review reviewed.

### `ScDocument::GetTableCount() const` (005d9db0)
Draft unreviewed, review reviewed.
- [supported_static] The function computes a count based on the difference between two memory locations

### `ScDocument::HasTable(short) const` (005db6d0)
Draft unreviewed, review reviewed.
- [supported_static] Returns false for table indices greater than 9999
- [contradicted] Returns false when table index is greater than or equal to the total table count
- [supported_static] Returns true when table index is less than table count and corresponding registry entry is non-null

### `ScRange::Parse(rtl::OUString const&, ScDocument const&, ScAddress::Details const&, ScAddress::ExternalInfo*, com::sun::star::uno::Sequence<com::sun::star::sheet::ExternalLinkInfo> const*, rtl::OUString const*)` (0077de00)
Draft unreviewed, review reviewed.
- [supported_static] Returns zero flag value immediately when passed a document string with zero length field
- [supported_static] Returns control without further processing after integrity checks if mode parameter equals three
- [supported_static] Delegates to simplified single-component parser when mode is two or four passing first three input parameters adjusted
- [supported_static] Searches input for first unquoted colon separator using external utility when mode is neither two nor three nor four
- [supported_static] Produces separate substrings before and after colon delimiter for independent coordinate interpretation
- [supported_static] Automatically swaps endpoint coordinates to ascending order per dimension when final positions violate canonical form
- [supported_static] Combines validity flags from both parsed coordinate endpoints into final integer return value encoding success or failure modes

### `ScSingleRefData::InitAddress(ScAddress const&)` (008936e0)
Draft unreviewed, review reviewed.

### `ScSingleRefData::SetTabDeleted(bool)` (008937d0)
Draft unreviewed, review reviewed.
- [supported_static] Sets the tab deleted flag when the flag input is nonzero
- [supported_static] Clears the tab deleted flag when the flag input is zero
- [supported_static] Preserves all other bits in the target field during modification

### `ScComplexRefData::SetRange(ScSheetLimits const&, ScRange const&, ScAddress const&)` (00894790)
Draft unreviewed, review reviewed.
- [supported_static] Adjusts the column index in the complex reference data based on input parameters and flags
- [supported_static] Marks columns as deleted when the column index exceeds sheet limits or is negative
- [supported_static] Adjusts the row index in the complex reference data based on input parameters and flags
- [supported_static] Marks rows as deleted when the row index exceeds sheet limits or is negative

