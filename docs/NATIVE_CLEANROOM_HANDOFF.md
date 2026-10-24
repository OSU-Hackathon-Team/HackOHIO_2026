# Native cleanroom handoff

The implementer artifact is a behavioral specification, not a decompilation report.
It must let someone implement the requested interface, state changes, input validation,
error results, boundary values, and original behavior examples without seeing the
binary, disassembly, source rendering, draft pseudocode, or analysis notes.

## Separation

1. Analysts may inspect the original and produce an immutable dossier. They resolve
   missing behavior, direct-call contracts, review conflicts, and original-case links.
2. A ready dossier is reduced to reviewed behavioral facts and input/output examples.
   The regular Step 2 `spec_writer` drafts the public spec. Validation requires every
   supported fact to be covered and rejects source-like text. The draft is held for
   human review; model output and claim IDs alone do not prove accuracy.
3. Source addresses, raw evidence, review notes, model identity, and claim mappings
   live in a separate immutable audit artifact. Analysts use it to verify the public
   prose. The implementer receives only the public spec artifact, in an environment
   without access to the analysis state or original.
4. The implementer independently chooses structure, names, and algorithms, then
   checks behavior against the public examples and separate held-out black-box cases.
   A passing finite test set is evidence of agreement on those cases only.

Public requirements should state observable rules precisely, including constants,
widths, signedness, byte order, ordering, overflow, persistent state, and errors when
established. High-level behavior steps may summarize the sequence in ordinary words.
They must not translate source control flow line by line. Original examples are data,
not executable tests or copied code. If a required behavior is unresolved, keep the
dossier partial and collect evidence; do not fill the public spec with guesses or
`unknown` placeholders.

## Review before implementation

- Confirm the public artifact contains no source text, assembly, source-like
  pseudocode, declarations, executable tests, addresses, or analyst metadata.
- Compare each requirement and example to the analyst-only audit and original
  observations. Challenge unsupported detail and omitted state or error behavior.
- Confirm the interface and exclusions preserve observable behavior. Record any
  adaptation in deviations; do not silently drop platform behavior.
- Keep analyst and implementer permissions separate. Do not give an implementer
  the dossier or artifact store, even though the public API exposes only schema 2
  specs. Preserve review and handoff records for provenance.
- Check the target's ownership, license, acquisition method, contract terms, and
  applicable law with qualified counsel before using the workflow on third-party
  software. This pipeline does not determine those rights.

The separation aims to communicate functional behavior while limiting transfer of
protected expression. U.S. copyright law distinguishes methods and processes from
copyrightable expression in [17 U.S.C. § 102(b)](https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title17-section102),
and the [U.S. Copyright Office](https://www.copyright.gov/register/tx-programs.html)
notes that copyright can protect expression in a computer program. The
[Copyright Office summary of Sega v. Accolade](https://www.copyright.gov/fair-use/summaries/segaenters-accolade-9thcir1992.pdf)
addresses reverse engineering under its own facts. None of these sources makes this
workflow automatically lawful or a legal cleanroom. Contracts and other rights may
matter independently.

Historical schema 1 specs were report-style artifacts and must not be handed to an
implementer. The schema 2 API rejects them. The telemetry dossier cited in the
2026-10-24 end-to-end report has 26 claims without original-case links and remains
partial; it cannot publish a new public spec until that evidence gap is resolved.
