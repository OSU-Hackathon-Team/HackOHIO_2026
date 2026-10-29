# LibreOffice Calc Table Operations: decomp handoff

Dossier readiness: **partial**. Functions drafted 19/20, independently reviewed 19.
Claim verdicts: contradicted 6, supported_static 35, uncertain 5.

## Using this for a FeatureSpec

- `supported_static` claims are candidate requirements. `uncertain` claims need runtime confirmation. Drop `contradicted` claims. `unreviewed` claims are unverified.
- `observed_cases` are real results from LibreOffice Calc Table Operations 420(Build:2); use them as acceptance-test examples.
- 2 held-out cases are deliberately withheld for independent checking. Do not ask for them.
- C++ mechanics (offsets, vtables, constructors) are not requirements; list them under `stripped_glue` if needed.
- `native_spec.json` (artifact `53d57ff38af4d1cdb3fb42f6635209d0246d3027f31482218daef4e85088f7a9`) is a **draft**: the evidence is incomplete, so the adapter refuses it. Use it as a starting point and hand-author the FeatureSpec in the format of `fixtures/hand-authored/specs/*.json`.

## Readiness blockers (details in evidence.json)

- claim_needs_resolution: 11
- claim_probe_disagreements: 1
- claims_not_linked_to_original_probes: 1
- dependency_contracts_need_review: 1
- direct_calls_without_bound_dependencies: 1
- independent_review_gaps: 1
- missing_function_drafts: 1
- unresolved_scope_edge: 72

## Functions

### `ScDocumentPool::newItem_Callback(SfxPoolItem const&) const` (005a7d00)
Draft unreviewed, review reviewed.
- [contradicted] If a SfxPoolItem has token 156 at conceptual position 12 and integer value 1 at position 8, then the function assigns an incremented document-unique token to both an internal counter and the item’s identifier field
- [supported_static] If either condition over positions 12 or 8 evaluates false, no update occurs and execution halts without effect

### `ScDocument::GetDBAtArea(short, short, int, short, int)` (005b8dc0)
Draft unreviewed, review reviewed.
- [contradicted] Delegates to a shared routine with extended parameters when a collection exists

### `ScDocument::EndListeningFormulaCells(std::vector<ScFormulaCell*, std::allocator<ScFormulaCell*> >&)` (005d13d0)
Draft unreviewed, review reviewed.
- [supported_static] Processing is skipped when the input range of formula cell pointers is empty
- [supported_static] A listening context is initialized prior to traversing the formula cells
- [supported_static] Each formula cell in the input range receives a request to cease broadcasting
- [supported_static] The context discards any broadcast entries that no longer have active listeners
- [supported_static] Shared references are conditionally decremented or specialized cleanup is triggered based on stored count values
- [supported_static] Temporary span-related bookkeeping structures are finalized upon exit

### `ScDocument::GetTableCount() const` (005d9db0)
Draft unreviewed, review reviewed.
- [supported_static] Returns the difference between two 64-bit values stored at fixed offsets within the input object, divided by eight
- [uncertain] Interprets the result as a count derived from a pointer-based container

### `ScDocument::GetAnonymousDBData()` (005da0d0)
Draft unreviewed, review reviewed.

### `ScDocument::HasTable(short) const` (005db6d0)
Draft unreviewed, review reviewed.
- [supported_static] Returns false for table indices greater than 9999
- [contradicted] Returns false when the table index is greater than or equal to the total table count
- [uncertain] Returns true if a table exists at the specified index in the internal registry

### `ScDocument::DeleteCol(int, short, int, short, short, unsigned long, ScDocument*, bool*, ScMarkData const*)` (005e8aa0)
Draft unreviewed, review reviewed.
- [supported_static] The function inspects whether column indices and row indices overlap with the current table dimensions before modifying content
- [uncertain] The function adjusts internal column references to reflect shifted positions after deleting columns
- [supported_static] Caller receives an indication via output parameter that some action occurred

### `ScDocument::DeleteRow(short, short, short, short, int, unsigned long, ScDocument*, bool*, ScMarkData const*)` (005e9310)
Draft unreviewed, review reviewed.
- [supported_static] Adjusts row range bounds when initial range exceeds sheet limits
- [supported_static] Skips deletion if no rows fall within existing sheet dimensions
- [supported_static] Shifts cell contents up by row count when deleting from middle of sheet
- [supported_static] Clears shifted region and updates formula references accordingly
- [supported_static] Updates sheet dimension counters after successful deletions
- [supported_static] Invalidates calculation caches and triggers recalculation sequence
- [supported_static] Notifies registered listeners of structural changes
- [uncertain] Purges internal temporary storage and hash tables before exit

### `ScDocument::InsertCol(int, short, int, short, short, unsigned long, ScDocument*, ScMarkData const*)` (005e9b60)
Draft unreviewed, review reviewed.
- [supported_static] Swaps initial sheet indices when the first exceeds the second
- [contradicted] Caps column end index to not exceed column start when misordered
- [supported_static] Returns success without iteration when no selection mask is passed

### `ScDocument::InsertRow(short, short, short, short, int, unsigned long, ScDocument*, ScMarkData const*)` (005ea350)
Draft unreviewed, review reviewed.
- [supported_static] Operation succeeds only when document contains at least one sheet
- [supported_static] Inserted row range gets adjusted when starting position exceeds ending position
- [uncertain] Operation affects all sheets when no specific sheet selection is provided
- [contradicted] Only explicitly selected sheets participate in the insert when mark data is present
- [supported_static] Cell content shifts vertically downward beginning at start row within affected sheets

### `ScDocument::CopyToDocument(short, int, short, short, int, short, InsertDeleteFlags, bool, ScDocument&, ScMarkData const*, bool)` (005edde0)
Draft unreviewed, review reviewed.
- [supported_static] Returns without effect when either the first coordinate or eighth parameter exceed the value 9999
- [supported_static] Delegates to internal routine when all position arguments are within 0 to 9999 inclusive

### `ScDocument::EndListeningGroups(std::vector<ScAddress, std::allocator<ScAddress> > const&)` (005f8210)
Draft unreviewed, review reviewed.

### `ScBroadcastAreaSlotMachine::EnterBulkBroadcast()` (004adc70)
Draft unreviewed, review reviewed.
- [supported_static] Increases the bulk broadcast mode nesting level associated with the object instance

### `std::_Sp_counted_base<(__gnu_cxx::_Lock_policy)2>::_M_release_last_use_cold()` (004e9d00)
Draft unreviewed, review reviewed.
- [supported_static] The operation checks a global storage location to determine execution mode and selects between atomic and non-atomic update paths accordingly.

### `sc::ColumnSpanSet::~ColumnSpanSet()` (005872b0)
Draft partial, review None.

### `lcl_GetFirstTabRange(short&, short&, ScMarkData const*, short) [clone .part.0]` (005d8c70)
Draft unreviewed, review reviewed.
- [supported_static] Returns early without modifying outputs when the provided count is zero or negative
- [supported_static] Scans sequential indices starting from zero to determine selected table entries using a predicate check
- [supported_static] Upon finding the first selected table entry, stores a derived value obtained via secondary query into the first output location
- [contradicted] Continues scanning subsequent indices after initial selection to find consecutive selections and saves the upper bound index minus one into the second output location

### `ScFormulaCell::EndListeningTo(sc::EndListeningContext&)` (006a6970)
Draft unreviewed, review reviewed.

### `sc::EndListeningContext::EndListeningContext(ScDocument&, ScTokenArray*)` (006cbb80)
Draft unreviewed, review reviewed.
- [supported_static] Associates the provided document handle with the context at initialization time

### `sc::EndListeningContext::purgeEmptyBroadcasters()` (006cbe60)
Draft unreviewed, review reviewed.
- [supported_static] If the stack integrity check fails after execution, control transfers to an error routine.

### `sc::AutoCalcSwitch::AutoCalcSwitch(ScDocument&, bool)` (00927350)
Draft unreviewed, review reviewed.
- [supported_static] Records the initial calculation enablement state from the document before modifying it
- [supported_static] Saves the incoming document reference directly into the AutoCalcSwitch object for later restoration
- [supported_static] Changes the live calculation flag inside the referenced ScDocument structure

