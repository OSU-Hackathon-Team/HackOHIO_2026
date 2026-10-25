/* Clean-room reimplementation of the Calc formula grammar bitmask.
 *
 * Written from spec/modules/calc_formula_engine.md section 3 ("Formula Grammar
 * & Syntax Mapping") alone. The grammar value is a 32-bit word:
 *
 *   bits 31..25  reserved
 *   bit  24      English convention    (0x01000000)
 *   bits 23..16  address convention    ((convention + 2) << 16)
 *   bits 15..0   syntax family
 *
 * Names, layout and control flow here are the implementer's own; only the
 * observable mapping is taken from the spec.
 */
#ifndef REIMPL_FORMULA_GRAMMAR_H
#define REIMPL_FORMULA_GRAMMAR_H

#include <stdbool.h>
#include <stdint.h>

#define FG_ENGLISH_BIT 0x01000000u

/* Documented syntax standards (spec section 3.3). */
#define FG_GRAM_ODFF 0x01030001u
#define FG_GRAM_PODF 0x00030003u
#define FG_GRAM_EXCEL_A1 0x01020006u
#define FG_GRAM_NATIVE 0x00020003u

/* Force or clear the English convention bit; every other bit is preserved. */
uint32_t fg_set_english_bit(uint32_t grammar, bool english);

/* Replace the address-convention field, keeping family and English state. */
uint32_t fg_merge_to_grammar(uint32_t grammar, int convention);

/* Map the API's two switches onto a syntax standard. */
uint32_t fg_map_api_to_grammar(bool english, bool odf);

/* Whether a grammar word names a supported syntax standard. */
bool fg_is_supported(uint32_t grammar);

#endif
