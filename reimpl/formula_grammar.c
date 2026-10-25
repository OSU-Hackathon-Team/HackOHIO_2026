/* Clean-room reimplementation of the Calc formula grammar bitmask.
 * See formula_grammar.h for the field layout and provenance.
 */
#include "formula_grammar.h"

#define FG_FAMILY_MASK 0x0000ffffu
#define FG_ENGLISH_MASK 0xfeffffffu
#define FG_CONVENTION_SHIFT 16
#define FG_CONVENTION_BIAS 2

uint32_t fg_set_english_bit(uint32_t grammar, bool english)
{
    if (english)
        return grammar | FG_ENGLISH_BIT;
    return grammar & FG_ENGLISH_MASK;
}

uint32_t fg_merge_to_grammar(uint32_t grammar, int convention)
{
    uint32_t family = grammar & FG_FAMILY_MASK;
    /* The biased convention is shifted whole, not masked to one byte first:
       out-of-range conventions carry into the upper bytes. */
    uint32_t address = (uint32_t)(convention + FG_CONVENTION_BIAS)
                       << FG_CONVENTION_SHIFT;
    bool english = ((grammar >> 24) & 1u) != 0u;

    return fg_set_english_bit(family | address, english);
}

uint32_t fg_map_api_to_grammar(bool english, bool odf)
{
    if (odf)
        return english ? FG_GRAM_ODFF : FG_GRAM_PODF;
    return english ? FG_GRAM_EXCEL_A1 : FG_GRAM_NATIVE;
}

/* Supported values, established by black-box probing: a grammar whose family
   field is the "no address convention" sentinel is supported whatever its
   upper bits say, and the remaining standards must match exactly. */
#define FG_NO_ADDRESS_FAMILY 0x00008000u

bool fg_is_supported(uint32_t grammar)
{
    static const uint32_t exact[] = {
        0x00010003u, 0x00020003u, 0x00030003u, 0x00040003u, 0x00050003u,
        0x01010000u, 0x01010001u, 0x01020000u, 0x01020001u, 0x01020002u,
        0x01020006u, 0x01030000u, 0x01030001u, 0x01040004u, 0x01050004u,
        0x01060004u, 0x01060005u,
    };

    if ((grammar & FG_FAMILY_MASK) == FG_NO_ADDRESS_FAMILY)
        return true;
    for (unsigned i = 0; i < sizeof(exact) / sizeof(exact[0]); ++i)
        if (exact[i] == grammar)
            return true;
    return false;
}
