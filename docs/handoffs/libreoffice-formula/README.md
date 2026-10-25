# LibreOffice Calc formula evaluation: decomp handoff

Dossier readiness: **partial**. Functions drafted 38/40, independently reviewed 38.
Claim verdicts: contradicted 9, supported_static 77, uncertain 6.

## Using this for a FeatureSpec

- `supported_static` claims are candidate requirements. `uncertain` claims need runtime confirmation. Drop `contradicted` claims. `unreviewed` claims are unverified.
- `observed_cases` are real results from LibreOffice 420(Build:2); use them as acceptance-test examples.
- 10 held-out cases are deliberately withheld for independent checking. Do not ask for them.
- C++ mechanics (offsets, vtables, constructors) are not requirements; list them under `stripped_glue` if needed.
- No spec was generated (ValueError: spec contains source-like or report-card text). Hand-author the FeatureSpec in the format of `fixtures/hand-authored/specs/*.json`.

## Readiness blockers (details in evidence.json)

- claim_needs_resolution: 15
- claims_not_linked_to_original_probes: 1
- dependency_contracts_need_review: 1
- direct_calls_without_bound_dependencies: 1
- independent_review_gaps: 1
- missing_function_drafts: 1
- unresolved_scope_edge: 141

## Functions

### `ScValueIterator::ScValueIterator(ScInterpreterContext&, ScRange const&, SubtotalFlags, bool)` (005a0830)
Draft unreviewed, review reviewed.
- [supported_static] Sets initial row and column bounds from input range before applying clamping
- [supported_static] Stores contextual configuration flags including subtotal filters and recursion control bits
- [supported_static] Zero-initializes several internal accumulator arrays used during iteration scanning
- [supported_static] Adjusts maximum allowed sheet index according to system-wide upper bound if exceeded or invalid
- [supported_static] Constrains final iteration limits using current table dimensions fetched dynamically from context

### `ScDocument::GetNumberFormat(ScInterpreterContext const&, ScAddress const&) const` (005ddbb0)
Draft unreviewed, review reviewed.
- [supported_static] Returns zero when the sheet identifier extracted from the third parameter does not correspond to an existing document sheet
- [supported_static] Returns zero when internal attribute array resolution for the given sheet yields a null reference

### `ScTable::GetNumberFormat(ScInterpreterContext const&, ScAddress const&) const` (00722c30)
Draft unreviewed, review reviewed.
- [supported_static] Returns zero when the input column index is outside the range from 0 inclusive to the table's column capacity exclusive
- [supported_static] Returns zero when the input row index is outside the range from 0 inclusive to the table's row capacity exclusive

### `(anonymous namespace)::ConventionOOO_A1::getSpecialSymbol(ScCompiler::Convention::SpecialSymbolType) const` (007b5220)
Draft unreviewed, review reviewed.
- [supported_static] Returns period character code 46 when input is zero
- [supported_static] Returns dollar sign character code 36 when input is one
- [contradicted] Returns zero for all other input values

### `ScCompiler::ParseDoubleReference(rtl::OUString const&, rtl::OUString const*)` (007bd200)
Draft unreviewed, review reviewed.
- [supported_static] Encodes bit flags from the parse result into two separate byte-sized storage locations
- [contradicted] Conditionally marks tab references as deleted based on specific bit flags in parse result

### `ScCompiler::HasPossibleNamedRangeConflict(short) const` (007bda00)
Draft unreviewed, review reviewed.
- [supported_static] Returns one if an initial global range name exists and its updated flag indicates a naming conflict
- [supported_static] Returns zero when no named ranges exist or all checked ranges lack detected conflicts after optional conflict resolution
- [supported_static] Returns one if a parameterized range name exists and its updated flag indicates a naming conflict

### `ScCompiler::NextSymbol(bool)` (007c2da0)
Draft partial, review None.

### `ScInterpreter::ScEqual()` (007f1ef0)
Draft unreviewed, review reviewed.
- [supported_static] Function performs numerical equality checking between top two interpreter stack values using bitwise comparison including signed zero handling
- [supported_static] When either operand has matrix type 5 detected by GetStackType, execution enters matrix-specific comparison branch

### `ScInterpreter::ScGreater()` (007f21d0)
Draft unreviewed, review reviewed.
- [supported_static] Function checks if the top stack element has type 5 (matrix)
- [supported_static] If first element is not matrix type 5, function checks if second element is matrix type 5
- [supported_static] When both operands are matrices, performs matrix comparison with ScQueryOp::Greater (value 2)
- [uncertain] Matrix comparison result pushes either result matrix or illegal parameter error
- [contradicted] For non-matrix operands, performs scalar floating point greater-than comparison

### `ScInterpreter::ScLessEqual()` (007f22c0)
Draft unreviewed, review reviewed.
- [supported_static] If either of the top two stack elements has type matrix, then a matrix-based less-than-or-equal comparison is executed
- [supported_static] When both operands are scalars, the function performs a scalar less-than-or-equal comparison using floating point values
- [supported_static] Scalar comparisons produce a boolean integer result pushed onto the interpreter stack (1 for true, 0 for false)
- [supported_static] The stack guard check determines control flow through normal exit or error handling path

### `ScInterpreter::GetString()` (0084b4b0)
Draft rejected, review None.

### `ScInterpreter::ScSub()` (0085e100)
Draft unreviewed, review reviewed.
- [uncertain] Performs subtraction between two operands popped from the interpreter stack
- [supported_static] Propagates matrix operations when either operand is a matrix

### `ScAttrArray::GetPattern(int) const` (0049f990)
Draft unreviewed, review reviewed.
- [supported_static] Returns null pattern reference for out-of-range positive positions during main array bypass
- [supported_static] Returns null pattern reference for all negative input positions during validation check
- [supported_static] Queries sorted attribute entries using position-based search helper

### `ScDocument::GetRangeName(short) const` (005b85a0)
Draft unreviewed, review reviewed.
- [uncertain] Returns a range name handle when given a valid sheet-local index
- [supported_static] Returns zero when no range exists for the given index

### `ScDocument::GetRangeName() const` (005b85d0)
Draft unreviewed, review reviewed.
- [supported_static] Returns current range name without modifying state when already present
- [uncertain] Replaces inactive range name storage with a newly constructed one

### `ScDocument::GetDocOptions() const` (005bbdf0)
Draft unreviewed, review reviewed.
- [supported_static] The operation yields a value derived from the document's internal configuration representation

### `ScDocument::GetExternalRefManager() const` (005be4c0)
Draft unreviewed, review reviewed.
- [supported_static] Returns the manager currently assigned to the document without modifying state when present.
- [supported_static] Constructs a new manager instance and assigns it to the document when no manager is currently assigned.
- [contradicted] Replaces any outdated manager already associated during construction, releasing the previous instance.

### `ScDocument::GetTableCount() const` (005d9db0)
Draft unreviewed, review reviewed.
- [supported_static] Returns a count derived from the difference of two 64-bit object fields divided by eight
- [supported_static] The result reflects the number of elements assuming each element occupies 8 bytes

### `ScDocument::HasTable(short) const` (005db6d0)
Draft unreviewed, review reviewed.
- [supported_static] Returns false for any sheet index strictly greater than 9999
- [contradicted] Returns false when the given sheet index is greater than or equal to the sheet count returned by GetTableCount
- [supported_static] Returns true when the slot at the sheet index in the document's table array holds a non-null entry, and all prior checks pass

### `ScGlobal::getLocaleData()` (006c40f0)
Draft unreviewed, review reviewed.
- [supported_static] The function prepares an argument pointing to a fixed memory location before transferring execution
- [supported_static] Control is transferred unconditionally to a target function

### `ScGlobal::getCharClass()` (006c4100)
Draft unreviewed, review reviewed.

### `ScRange::Parse(rtl::OUString const&, ScDocument const&, ScAddress::Details const&, ScAddress::ExternalInfo*, com::sun::star::uno::Sequence<com::sun::star::sheet::ExternalLinkInfo> const*, rtl::OUString const*)` (0077de00)
Draft unreviewed, review reviewed.
- [supported_static] Returns 0 immediately when the input string descriptor has zero elements
- [supported_static] Execution enters dedicated XL header parsing branch when fourth parameter holds value exactly equal to 3
- [supported_static] If the fourth argument is either 2 or 5 then proceeds to split-range attempt by scanning for unescaped colons before delegating parsing
- [contradicted] Branch taken for argument value 4 preserves original sixth argument when passing it to subroutine at 0077df01

### `ScCompiler::SetError(FormulaError)` (007b53a0)
Draft unreviewed, review reviewed.
- [supported_static] Sets a 16-bit error field in a nested object when the current error value is zero
- [supported_static] Skips updating the error field if it already contains a nonzero value

### `ScInterpreter::Compare(ScQueryOp)` (007f1170)
Draft unreviewed, review reviewed.
- [uncertain] Evaluates comparison between two values popped from internal stack using operation specified by unsigned 32-bit operator input

### `ScInterpreter::CompareMat(ScQueryOp, sc::CompareOptions*)` (007f1590)
Draft unreviewed, review reviewed.

### `ScInterpreter::PopError()` (00844090)
Draft unreviewed, review reviewed.
- [supported_static] When error count starts at zero and the current error code is also zero, this operation sets the current error code to 518.
- [supported_static] Decrements the error count by one whenever its initial value is greater than zero.
- [supported_static] Stores the result produced by a conditional virtual function invocation into the conceptual field for current error code.

### `ScInterpreter::PushMatrix(sc::RangeMatrix const&)` (00846d20)
Draft unreviewed, review reviewed.
- [uncertain] The function checks validity of the input matrix before proceeding with stack operations

### `ScInterpreter::PushIllegalParameter()` (008474e0)
Draft unreviewed, review reviewed.
- [supported_static] Sets a flag field to 504 when the current flag is zero

### `ScInterpreter::GetStackType(unsigned char)` (00847600)
Draft unreviewed, review reviewed.
- [supported_static] Returns type identifier 1 when the stack element's type field equals either 21 or 12
- [supported_static] Returns the raw stack element type value if it is neither 21 nor 12 and the index is valid
- [contradicted] Returns default value 23 when requested stack index exceeds the current maximum tracked index

### `ScRangeName::checkHasPossibleAddressConflict() const` (0088a680)
Draft unreviewed, review reviewed.
- [supported_static] Upon entry, clears the two least significant bits of a conceptual flag associated with the receiver object
- [supported_static] Sets the least significant bit of the same conceptual flag if a predicate evaluated on elements along a linked sequence ever yields true

### `ScSingleRefData::InitAddress(ScAddress const&)` (008936e0)
Draft unreviewed, review reviewed.

### `ScSingleRefData::SetTabDeleted(bool)` (008937d0)
Draft unreviewed, review reviewed.
- [supported_static] When called with any object reference and a nonzero flag, subsequent queries observing the tab-deleted status will see it as true
- [supported_static] When called with any object reference and a zero flag, subsequent queries observing the tab-deleted status will see it as false

### `ScComplexRefData::SetRange(ScSheetLimits const&, ScRange const&, ScAddress const&)` (00894790)
Draft unreviewed, review reviewed.
- [supported_static] Adjusts stored column value by subtracting the second element of adjustment array when flag bit 0 is set
- [supported_static] Marks stored column as deleted if source column is negative or exceeds maximum allowed column in sheet limits
- [supported_static] Adjusts stored row value by subtracting the first element of adjustment array when flag bit 2 is set
- [supported_static] Marks stored row as deleted if source row is negative or exceeds maximum allowed row in sheet limits
- [supported_static] Adjusts stored tab value by subtracting the fourth element of adjustment array when flag bit 4 is set
- [supported_static] Sets bit 5 in flags whenever stored tab identifier reaches or exceeds 10000

### `ScMatrix::DecRef() const` (008ca600)
Draft unreviewed, review reviewed.
- [supported_static] The reference count of the ScMatrix instance decreases by one.
- [supported_static] If the updated reference count equals zero, the ScMatrix instance undergoes finalization and resource release.

### `ScRawToken::SetDoubleReference(ScComplexRefData const&)` (0092de90)
Draft unreviewed, review reviewed.
- [supported_static] Sets the token type field to 4 indicating a double reference type

### `ScRawToken::SetExternalDoubleRef(unsigned short, rtl::OUString const&, ScComplexRefData const&)` (0092df50)
Draft unreviewed, review reviewed.
- [supported_static] Sets the token's sheet identifier to the value of the second input parameter
- [supported_static] Initializes the token's primary type field to zero
- [supported_static] Stores a type marker with decimal value 16 in the token's secondary type field

### `ScExternalRefManager::getRealTableName(unsigned short, rtl::OUString const&) const` (00b7cb00)
Draft unreviewed, review reviewed.
- [supported_static] The second parameter is widened from 16 bits to 32 bits using MOVZX before being used in subsequent operations.
- [contradicted] A fixed offset of 48 is added to the first parameter before branching to shared logic.

### `ScAttrArray::Search(int, unsigned long&, std::optional<int>) const` (0049f8e0)
Draft unreviewed, review reviewed.
- [supported_static] Finds target key position through iterative interval halving across ordered elements accessed by calculated sixteen-step strides
- [supported_static] Advances left edge of active segment whenever tested element proves smaller than desired key
- [supported_static] Sets final index result and signals success once a candidate element meets positional adjacency criteria relative to key ordering
- [contradicted] Treats optional fourth parameter's upper bits as control flag where nonzero enables reading secondary word as customized initial minimum bound

### `ScGlobal::FindUnquoted(rtl::OUString const&, char16_t, int)` (006c3c30)
Draft unreviewed, review reviewed.
- [supported_static] Function searches for target character starting at specified index in UTF-16 string buffer
- [supported_static] Returns character index divided by two when unquoted target character is found
- [supported_static] Single quotes toggle quoting state during character traversal
- [supported_static] -1 is returned when target character is not found before string end
- [supported_static] Consecutive single quotes within quoted sections are treated as escaped quote pairs

### `lcl_ScRange_Parse_XL_A1(ScRange&, char16_t const*, ScDocument const&, bool, ScAddress::ExternalInfo*, com::sun::star::uno::Sequence<com::sun::star::sheet::ExternalLinkInfo> const*, int*, rtl::OUString const*)` (0077cfc0)
Draft unreviewed, review reviewed.
- [supported_static] Sets initial control flags to fixed constants 33792 and 1024 stored in uStack_5e and sStack_5c respectively
- [supported_static] Stores consumed character count divided by two into ExternalInfo->field_0 when ExternalInfo parameter is supplied and input advanced

