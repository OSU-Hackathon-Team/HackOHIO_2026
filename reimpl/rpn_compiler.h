/* Clean-room reimplementation of the Calc formula precedence chain and its RPN
 * evaluator.
 *
 * Written from spec/modules/calc_formula_engine.md sections 2 and 5: eleven
 * operator levels chained from the loosest to the tightest binding, compiled
 * into a postfix token stream keyed by the documented opcodes, then evaluated
 * under the documented stack discipline.
 *
 * Deliberate limitation: the lexer knows numbers, parentheses and operators
 * only. Cell references, names and function calls are not tokenized, so the
 * range/intersect/union levels have nothing to bind to yet and the reference
 * side of the language is out of scope for this stage.
 */
#ifndef REIMPL_RPN_COMPILER_H
#define REIMPL_RPN_COMPILER_H

#include <stdint.h>

/* Opcodes named by the specification's precedence table. */
enum {
    RPN_OC_PERCENT = 0x18,
    RPN_OC_ADD = 0x33,
    RPN_OC_SUB = 0x32,
    RPN_OC_MUL = 0x35,
    RPN_OC_DIV = 0x34,
    RPN_OC_POW = 0x37,
    RPN_OC_AMPERSAND = 0x36,
    RPN_OC_EQUAL = 0x38,
    RPN_OC_NOT_EQUAL = 0x39,
    RPN_OC_LESS = 0x3A,
    RPN_OC_GREATER = 0x3B,
    RPN_OC_LESS_EQUAL = 0x3C,
    RPN_OC_GREATER_EQUAL = 0x3D,
    RPN_OC_UNION = 0x41,
    RPN_OC_RANGE = 0x42,
    RPN_OC_INTERSECT = 0x40,
    RPN_OC_NEG = 0x46,
    RPN_OC_UNARY_PLUS = 0x47
};

/* A compiled item: a literal number or an opcode. */
typedef struct rpn_item {
    uint8_t is_operator;
    uint16_t opcode;
    double number;
} rpn_item;

/* Compiles an infix formula into postfix items. Returns the item count, or a
 * negative value when the text is not a formula this stage understands. */
int rpn_compile(const char *formula, rpn_item *out, int capacity);

/* Evaluates a compiled stream. Returns 0 on success and fills *result, or a
 * negative value for a malformed stream or an operator it cannot evaluate. */
int rpn_evaluate(const rpn_item *items, int count, double *result);

#endif
