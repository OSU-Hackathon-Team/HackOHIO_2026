/* Clean-room reimplementation of the Calc vector reference slice.
 * See vector_ref_array.h for the layout and provenance.
 */
#include "vector_ref_array.h"

#include <stddef.h>

/* The three fields are written individually and the tail padding is left
 * untouched, matching the observable footprint of the original routines. */
void vrar_init_empty(vrar *self)
{
    self->numbers = NULL;
    self->strings = NULL;
    self->valid = 1;
}

void vrar_init_invalid(vrar *self)
{
    self->numbers = NULL;
    self->strings = NULL;
    self->valid = 0;
}

void vrar_init_numbers(vrar *self, const double *numbers)
{
    self->numbers = numbers;
    self->strings = NULL;
    self->valid = 1;
}

void vrar_init_strings(vrar *self, void **strings)
{
    self->numbers = NULL;
    self->strings = strings;
    self->valid = 1;
}

void vrar_init_mixed(vrar *self, const double *numbers, void **strings)
{
    self->numbers = numbers;
    self->strings = strings;
    self->valid = 1;
}

bool vrar_is_valid(const vrar *self)
{
    return self->valid != 0;
}
