/* Clean-room reimplementation of the Calc vector reference slice.
 *
 * Written from spec/modules/calc_formula_engine.md section 4 ("Vectorized
 * Reference Slices"): a slice holds either a contiguous block of doubles or a
 * contiguous block of string pointers, or both, plus a validity flag. The
 * object must keep that layout because callers hand it around by pointer:
 *
 *   offset 0x00  const double *numbers
 *   offset 0x08  void **strings
 *   offset 0x10  unsigned char valid   (17 bytes used, 24-byte aligned)
 */
#ifndef REIMPL_VECTOR_REF_ARRAY_H
#define REIMPL_VECTOR_REF_ARRAY_H

#include <stdbool.h>

typedef struct vrar {
    const double *numbers;
    void **strings;
    unsigned char valid;
} vrar;

/* Empty slice: no storage, still valid. */
void vrar_init_empty(vrar *self);

/* Slice that stands for an invalid reference. */
void vrar_init_invalid(vrar *self);

/* Numeric block only. */
void vrar_init_numbers(vrar *self, const double *numbers);

/* String block only. */
void vrar_init_strings(vrar *self, void **strings);

/* Both blocks at once. */
void vrar_init_mixed(vrar *self, const double *numbers, void **strings);

/* True when the slice carries a valid reference. */
bool vrar_is_valid(const vrar *self);

#endif
