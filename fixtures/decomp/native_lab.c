/* Source-known native evaluation target. Analysts receive stripped builds only. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

struct state {
    uint32_t total;
    uint32_t accepted;
    uint32_t last_value;
};

typedef int (*accept_callback)(uint32_t value, void *context);

static struct state current;

int accept_even(uint32_t value, void *context) {
    uint32_t *seen = (uint32_t *)context;
    if (seen != NULL) {
        *seen += 1;
    }
    return (value & 1U) == 0;
}

void reset_state(void) {
    current.total = 0;
    current.accepted = 0;
    current.last_value = 0;
}

/* Return -1 on malformed input, -2 on callback rejection, else the decoded value. */
int32_t parse_frame(const uint8_t *data, uint32_t length,
                    accept_callback callback, void *context) {
    if (data == NULL || length < 4 || data[0] != 0x5a) {
        return -1;
    }
    uint32_t value = (uint32_t)data[1] | ((uint32_t)data[2] << 8);
    if (data[3] != (uint8_t)(data[1] ^ data[2] ^ 0x5a)) {
        return -1;
    }
    current.total++;
    current.last_value = value;
    if (callback != NULL && !callback(value, context)) {
        return -2;
    }
    current.accepted++;
    return (int32_t)value;
}

uint32_t read_total(void) { return current.total; }
uint32_t read_accepted(void) { return current.accepted; }
uint32_t read_last(void) { return current.last_value; }

/* Bound recursion in callers; this function exposes a recursive dependency. */
uint32_t fold_depth(uint32_t value, uint32_t depth) {
    if (depth == 0) {
        return value;
    }
    return fold_depth((value ^ depth) + 1U, depth - 1);
}

int main(int argc, char **argv) {
    uint32_t value = argc > 1 ? (uint32_t)strtoul(argv[1], NULL, 0) : 42;
    uint8_t frame[4] = {0x5a, (uint8_t)value, (uint8_t)(value >> 8), 0};
    frame[3] = (uint8_t)(frame[1] ^ frame[2] ^ 0x5a);
    uint32_t callbacks = 0;
    int32_t result = parse_frame(frame, sizeof(frame), accept_even, &callbacks);
    printf("result=%d total=%u accepted=%u callbacks=%u\n",
           result, read_total(), read_accepted(), callbacks);
    return result < 0 ? 1 : 0;
}
