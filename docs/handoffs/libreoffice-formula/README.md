# LibreOffice Calc formula evaluation: decomp handoff

Dossier readiness: **partial**. Functions drafted 19/20, independently reviewed 19.
Claim verdicts: contradicted 5, supported_static 27, uncertain 4.

## Using this for a FeatureSpec

- `supported_static` claims are candidate requirements. `uncertain` claims need runtime confirmation. Drop `contradicted` claims. `unreviewed` claims are unverified.
- `observed_cases` are real results from LibreOffice 420(Build:2); use them as acceptance-test examples.
- 10 held-out cases are deliberately withheld for independent checking. Do not ask for them.
- C++ mechanics (offsets, vtables, constructors) are not requirements; list them under `stripped_glue` if needed.
- No spec was generated (dossier not ready). Hand-author the FeatureSpec in the format of `fixtures/hand-authored/specs/*.json`.

## Readiness blockers (details in evidence.json)

- claim_needs_resolution: 9
- claims_not_linked_to_original_probes: 1
- dependency_contracts_need_review: 1
- direct_calls_without_bound_dependencies: 1
- independent_review_gaps: 1
- missing_function_drafts: 1
- unresolved_scope_edge: 112

## Functions

### `ScValueIterator::ScValueIterator(ScInterpreterContext&, ScRange const&, SubtotalFlags, bool)` (005a0830)
Draft unreviewed, review reviewed.

### `ScDocument::GetNumberFormat(ScInterpreterContext const&, ScAddress const&) const` (005ddbb0)
Draft unreviewed, review reviewed.

### `ScTable::GetNumberFormat(ScInterpreterContext const&, ScAddress const&) const` (00722c30)
Draft unreviewed, review reviewed.
- [supported_static] Returns zero when the column index from ScAddress is less than zero
- [supported_static] Returns zero when the row index from ScAddress is less than zero
- [supported_static] Returns zero when the column index from ScAddress is greater than or equal to the table's maximum column count
- [supported_static] Returns zero when the row index from ScAddress is greater than or equal to the table's maximum row count
- [uncertain] Computes a cell-specific number format identifier by accessing pattern information based on column and row indices

### `(anonymous namespace)::ConventionOOO_A1::getSpecialSymbol(ScCompiler::Convention::SpecialSymbolType) const` (007b5220)
Draft unreviewed, review reviewed.
- [supported_static] Returns decimal point character code 46 when the input symbol type equals zero
- [supported_static] Returns dollar sign character code 36 when the input symbol type equals one
- [supported_static] Returns zero for all input symbol types greater than one

### `ScCompiler::ParseDoubleReference(rtl::OUString const&, rtl::OUString const*)` (007bd200)
Draft unreviewed, review reviewed.
- [uncertain] Function parses spreadsheet cell range references from string input and stores structured results

### `ScCompiler::HasPossibleNamedRangeConflict(short) const` (007bda00)
Draft unreviewed, review reviewed.
- [supported_static] Returns 1 when a default named range exists with its conflict flag set after resolving potential staleness
- [supported_static] Returns 0 when no named range reports a conflict after checking both default and indexed lookups including refreshes

### `ScCompiler::NextSymbol(bool)` (007c2da0)
Draft partial, review None.

### `ScInterpreter::ScEqual()` (007f1ef0)
Draft unreviewed, review reviewed.
- [uncertain] Equality test passes when both operands are number five and returns true

### `ScInterpreter::ScGreater()` (007f21d0)
Draft unreviewed, review reviewed.
- [contradicted] Returns false when first operand is less than second operand

### `ScInterpreter::ScLessEqual()` (007f22c0)
Draft unreviewed, review reviewed.
- [contradicted] If the top interpreter stack value is numeric and less than or equal to zero, the function pushes integer 1 onto the stack
- [contradicted] If the top interpreter stack value is numeric and positive, the function pushes integer 0 onto the stack

### `ScInterpreter::GetString()` (0084b4b0)
Draft unreviewed, review reviewed.
- [supported_static] Selector values greater than 21 cause immediate transition to standard expression-loading logic instead of switching

### `ScInterpreter::ScSub()` (0085e100)
Draft unreviewed, review reviewed.
- [supported_static] Prepares an immediate integer token 1 then passes control to general interpreter dispatch at 8771312.

### `ScAttrArray::GetPattern(int) const` (0049f990)
Draft unreviewed, review reviewed.
- [supported_static] Returns a stored pattern pointer when input index matches an interval in the primary array
- [supported_static] Returns null when index search fails to find a matching interval
- [supported_static] Uses secondary object access when primary array pointers are equal
- [uncertain] Returns default item pattern when using secondary path and index is within bounds
- [supported_static] Returns null when using secondary path and index is out of bounds

### `ScDocument::GetDocOptions() const` (005bbdf0)
Draft unreviewed, review reviewed.
- [supported_static] The function retrieves a value stored within the ScDocument object at a fixed byte offset

### `ScDocument::GetTableCount() const` (005d9db0)
Draft unreviewed, review reviewed.
- [supported_static] Returns the difference between two object fields shifted right by three bits

### `ScDocument::HasTable(short) const` (005db6d0)
Draft unreviewed, review reviewed.
- [supported_static] Returns false when table index exceeds 9999
- [contradicted] Returns false when table index is greater than or equal to table count
- [supported_static] Returns true when the table entry at the given index is non-null

### `ScRange::Parse(rtl::OUString const&, ScDocument const&, ScAddress::Details const&, ScAddress::ExternalInfo*, com::sun::star::uno::Sequence<com::sun::star::sheet::ExternalLinkInfo> const*, rtl::OUString const*)` (0077de00)
Draft unreviewed, review reviewed.
- [supported_static] Returns numerical zero immediately without altering output range when initial input length equals zero
- [supported_static] Returns numerical zero when fundamental parse operations signal invalid syntax or structure in substring components post-separation

### `ScSingleRefData::InitAddress(ScAddress const&)` (008936e0)
Draft unreviewed, review reviewed.

### `ScSingleRefData::SetTabDeleted(bool)` (008937d0)
Draft unreviewed, review reviewed.
- [supported_static] The operation updates a status flag within a structured data object by setting or clearing bit 5 of a specific byte field according to the least significant bit of the second argument

### `ScComplexRefData::SetRange(ScSheetLimits const&, ScRange const&, ScAddress const&)` (00894790)
Draft unreviewed, review reviewed.
- [supported_static] Applies adjustments to the stored column index when the least significant flag bit is set
- [supported_static] Marks columns as deleted when the assigned column index falls outside specified boundaries relative to maximum or below minimum allowed index
- [supported_static] Modifies the stored row index according to adjustment values when flag bit 2 is active
- [supported_static] Flags rows as deleted under boundary violations involving the assigned row index compared to permissible extremes
- [supported_static] Alters the recorded sheet index using a predefined subtraction when flag bit 4 is present
- [contradicted] Sets a specific flag bit upon detecting that the sheet index has reached or exceeded the numerical threshold of ten thousand

