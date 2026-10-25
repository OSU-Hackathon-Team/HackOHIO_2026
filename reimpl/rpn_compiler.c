/* Clean-room reimplementation of the Calc precedence chain and RPN evaluator.
 * See rpn_compiler.h for scope and provenance.
 */
#include "rpn_compiler.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

typedef struct parser {
    const char *cursor;
    rpn_item *out;
    int count;
    int capacity;
    int failed;
} parser;

static void emit(parser *self, rpn_item item)
{
    if (self->count >= self->capacity) {
        self->failed = 1;
        return;
    }
    self->out[self->count++] = item;
}

static void emit_op(parser *self, uint16_t opcode)
{
    rpn_item item;

    item.is_operator = 1;
    item.opcode = opcode;
    item.number = 0.0;
    emit(self, item);
}

static void emit_number(parser *self, double value)
{
    rpn_item item;

    item.is_operator = 0;
    item.opcode = 0;
    item.number = value;
    emit(self, item);
}

static void skip_spaces(parser *self)
{
    while (*self->cursor == ' ' || *self->cursor == '\t')
        ++self->cursor;
}

/* True when the next characters are `text`, consuming them. Longest operators
 * are tested first so "<=" is never read as "<" then "=". */
static int take(parser *self, const char *text)
{
    size_t length = strlen(text);

    skip_spaces(self);
    if (strncmp(self->cursor, text, length) != 0)
        return 0;
    self->cursor += length;
    return 1;
}

static int parse_expression(parser *self);

/* Factor: literal number or a parenthesized expression. */
static int parse_factor(parser *self)
{
    char *end = NULL;
    double value;

    skip_spaces(self);
    if (*self->cursor == '(') {
        ++self->cursor;
        if (!parse_expression(self))
            return 0;
        skip_spaces(self);
        if (*self->cursor != ')')
            return 0;
        ++self->cursor;
        return 1;
    }
    value = strtod(self->cursor, &end);
    if (end == self->cursor)
        return 0;
    self->cursor = end;
    emit_number(self, value);
    return 1;
}

/* Levels 8..10 (union, intersect, range) exist in the chain but only bind
 * reference tokens, which this stage does not produce yet. */
static int parse_range(parser *self)
{
    return parse_factor(self);
}

static int parse_intersect(parser *self)
{
    return parse_range(self);
}

static int parse_union(parser *self)
{
    return parse_intersect(self);
}

/* Level 7: prefix + and -, emitted after their operand. */
static int parse_unary(parser *self)
{
    uint16_t pending[32];
    int depth = 0;

    for (;;) {
        skip_spaces(self);
        if (*self->cursor == '-' || *self->cursor == '+') {
            if (depth == (int)(sizeof(pending) / sizeof(pending[0])))
                return 0;
            pending[depth++] = *self->cursor == '-' ? RPN_OC_NEG : RPN_OC_UNARY_PLUS;
            ++self->cursor;
            continue;
        }
        break;
    }
    if (!parse_union(self))
        return 0;
    while (depth > 0)
        emit_op(self, pending[--depth]);
    return 1;
}

/* Level 6: postfix percent. */
static int parse_postop(parser *self)
{
    if (!parse_unary(self))
        return 0;
    while (take(self, "%"))
        emit_op(self, RPN_OC_PERCENT);
    return 1;
}

/* Level 5: exponentiation, left associative per the specification table. */
static int parse_pow(parser *self)
{
    if (!parse_postop(self))
        return 0;
    while (take(self, "^")) {
        if (!parse_postop(self))
            return 0;
        emit_op(self, RPN_OC_POW);
    }
    return 1;
}

/* Level 4: multiplication and division. */
static int parse_muldiv(parser *self)
{
    if (!parse_pow(self))
        return 0;
    for (;;) {
        uint16_t opcode;

        skip_spaces(self);
        if (*self->cursor == '*')
            opcode = RPN_OC_MUL;
        else if (*self->cursor == '/')
            opcode = RPN_OC_DIV;
        else
            return 1;
        ++self->cursor;
        if (!parse_pow(self))
            return 0;
        emit_op(self, opcode);
    }
}

/* Level 3: addition and subtraction. */
static int parse_addsub(parser *self)
{
    if (!parse_muldiv(self))
        return 0;
    for (;;) {
        uint16_t opcode;

        skip_spaces(self);
        if (*self->cursor == '+')
            opcode = RPN_OC_ADD;
        else if (*self->cursor == '-')
            opcode = RPN_OC_SUB;
        else
            return 1;
        ++self->cursor;
        if (!parse_muldiv(self))
            return 0;
        emit_op(self, opcode);
    }
}

/* Level 2: string concatenation. */
static int parse_concat(parser *self)
{
    if (!parse_addsub(self))
        return 0;
    while (take(self, "&")) {
        if (!parse_addsub(self))
            return 0;
        emit_op(self, RPN_OC_AMPERSAND);
    }
    return 1;
}

static int take_comparison(parser *self, uint16_t *opcode)
{
    if (take(self, "<>")) {
        *opcode = RPN_OC_NOT_EQUAL;
        return 1;
    }
    if (take(self, "<=")) {
        *opcode = RPN_OC_LESS_EQUAL;
        return 1;
    }
    if (take(self, ">=")) {
        *opcode = RPN_OC_GREATER_EQUAL;
        return 1;
    }
    if (take(self, "=")) {
        *opcode = RPN_OC_EQUAL;
        return 1;
    }
    if (take(self, "<")) {
        *opcode = RPN_OC_LESS;
        return 1;
    }
    if (take(self, ">")) {
        *opcode = RPN_OC_GREATER;
        return 1;
    }
    return 0;
}

/* Level 1: comparisons, the loosest binding level. */
static int parse_compare(parser *self)
{
    if (!parse_concat(self))
        return 0;
    for (;;) {
        uint16_t opcode;

        skip_spaces(self);
        if (!take_comparison(self, &opcode))
            return 1;
        if (!parse_concat(self))
            return 0;
        emit_op(self, opcode);
    }
}

static int parse_expression(parser *self)
{
    return parse_compare(self);
}

int rpn_compile(const char *formula, rpn_item *out, int capacity)
{
    parser self;

    if (formula == NULL || out == NULL || capacity <= 0)
        return -1;
    self.cursor = formula;
    self.out = out;
    self.count = 0;
    self.capacity = capacity;
    self.failed = 0;
    if (!parse_expression(&self) || self.failed)
        return -1;
    skip_spaces(&self);
    if (*self.cursor != '\0')
        return -1;
    return self.count;
}

int rpn_evaluate(const rpn_item *items, int count, double *result)
{
    double stack[64];
    int depth = 0;

    if (items == NULL || result == NULL)
        return -1;
    for (int index = 0; index < count; ++index) {
        const rpn_item *item = &items[index];
        double left;
        double right;
        double value;

        if (!item->is_operator) {
            if (depth == 64)
                return -2;
            stack[depth++] = item->number;
            continue;
        }
        switch (item->opcode) {
        case RPN_OC_NEG:
        case RPN_OC_UNARY_PLUS:
            if (depth < 1)
                return -2;
            if (item->opcode == RPN_OC_NEG)
                stack[depth - 1] = -stack[depth - 1];
            continue;
        case RPN_OC_PERCENT:
            if (depth < 1)
                return -2;
            stack[depth - 1] /= 100.0;
            continue;
        default:
            break;
        }
        if (depth < 2)
            return -2;
        right = stack[--depth];
        left = stack[--depth];
        switch (item->opcode) {
        case RPN_OC_ADD:
            value = left + right;
            break;
        case RPN_OC_SUB:
            value = left - right;
            break;
        case RPN_OC_MUL:
            value = left * right;
            break;
        case RPN_OC_DIV:
            value = left / right;
            break;
        case RPN_OC_POW:
            value = pow(left, right);
            break;
        case RPN_OC_EQUAL:
            value = left == right ? 1.0 : 0.0;
            break;
        case RPN_OC_NOT_EQUAL:
            value = left != right ? 1.0 : 0.0;
            break;
        case RPN_OC_LESS:
            value = left < right ? 1.0 : 0.0;
            break;
        case RPN_OC_GREATER:
            value = left > right ? 1.0 : 0.0;
            break;
        case RPN_OC_LESS_EQUAL:
            value = left <= right ? 1.0 : 0.0;
            break;
        case RPN_OC_GREATER_EQUAL:
            value = left >= right ? 1.0 : 0.0;
            break;
        default:
            /* Concatenation and the reference operators need value planes this
             * stage does not model. */
            return -3;
        }
        stack[depth++] = value;
    }
    if (depth != 1)
        return -2;
    *result = stack[0];
    return 0;
}
