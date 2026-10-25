# Clean-room reimplementation of the Calc formula engine

Source for the implementation side of the handoff: code written from
`spec/modules/calc_formula_engine.md`, plus the checks that compare it with the
real binary. Nothing here is copied from the target; structure, names and
algorithms are the implementer's own, and the spec is the only behavior source.

Ladder, small to large. A stage only counts as done when its check passes.

| Stage | Spec section | Files | Verified by |
|---|---|---|---|
| 1. Grammar word | §3 | `formula_grammar.{c,h}` | `scripts/check_formula_grammar_reimpl.py` — 1,243,644 differential cases, 0 mismatches |
| 2. Vector slice | §4 | `vector_ref_array.{c,h}` | `scripts/check_vector_ref_array_reimpl.py` — object bytes in a poison buffer, 26 cases, 0 mismatches |
| 3. Precedence chain + RPN evaluator | §2, §5 | `rpn_compiler.{c,h}` | `tests/test_calc_rpn_reimpl.py` — 20 spec-derived cases, all passing |

## Running the checks

```bash
python3 scripts/check_formula_grammar_reimpl.py    # needs decomp-state/fixtures/calc/libforlo.so
python3 scripts/check_vector_ref_array_reimpl.py
python3 -m unittest discover -s tests -p "test_calc_rpn_reimpl.py"
```

Stages 1 and 2 are **differential**: the same inputs go to the clean-room
library and to `libforlo.so`, and the answers must be identical. Stage 2 also
compares the full 0x20-byte window around each object, so writing a different
number of bytes than the original fails the check.

Stage 3 is **spec-derived only**. Its expectations come from the specification's
opcode table and evaluation rules, not from executing the original, because the
precedence chain is reachable only through `FormulaCompiler`, which needs a
document, an address convention and a symbol table to construct. Closing that
gap needs a context harness that can drive the real compiler; until then a
passing stage 3 means "agrees with the spec", not "agrees with the binary".

## What the checks already caught

- `mergeToGrammar` shifts the biased address convention whole; the spec's
  pseudocode implies a byte-sized field, but conventions outside 0..253 carry
  into the upper bytes. Stage 1 failed on all 25 sampled negative conventions
  until the implementation stopped masking.
- `isSupported` is not a family test: it accepts any grammar whose family field
  is `0x8000`, whatever the upper bits hold, plus seventeen exact composite
  values. The spec says nothing about this; the supported set was established by
  probing and is now pinned by a family sweep plus random 32-bit sampling.
- The vector slice writes exactly 17 bytes and leaves its 7 padding bytes alone.
  A `memset`-style implementation fails stage 2 on the tail compare.

## Deliberate scope limits at stage 3

- The lexer accepts numbers, parentheses and operators. Cell references, names
  and function calls are not tokenized, so the range, intersect and union levels
  exist in the chain but never bind, and `:`/`!`/`~`/`,` are rejected.
- Evaluation covers numbers; `&` compiles but returns "not evaluated", since
  string formatting is a separate contract.
- Array/short-circuit rules for `AND`/`OR` (§5.2) are not modeled: they apply to
  the array evaluation path, not to the scalar evaluator here.
