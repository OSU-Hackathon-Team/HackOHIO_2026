/* Source-known 16+ function native subsystem for queue and quality evaluation. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#define STAGE __attribute__((noinline))

struct telemetry_state {
    uint32_t seen;
    uint32_t accepted;
    uint32_t rejected;
    uint32_t sum;
    uint32_t low;
    uint32_t high;
    uint32_t last;
    uint32_t buckets[4];
};

static struct telemetry_state state;

STAGE void telemetry_reset(void) {
    state = (struct telemetry_state){0};
    state.low = UINT32_MAX;
}

STAGE int marker_ok(const uint8_t *packet, uint32_t length) {
    return packet != NULL && length == 6 && packet[0] == 0xa5;
}

STAGE uint32_t read_kind(const uint8_t *packet) { return packet[1]; }
STAGE uint32_t read_value(const uint8_t *packet) {
    return (uint32_t)packet[2] | ((uint32_t)packet[3] << 8);
}
STAGE uint32_t read_flags(const uint8_t *packet) { return packet[5]; }
STAGE uint32_t calculate_check(const uint8_t *packet) {
    return (packet[1] ^ packet[2] ^ packet[3] ^ packet[5] ^ 0x5a) & 0xff;
}
STAGE int check_matches(const uint8_t *packet, uint32_t calculated) {
    return packet[4] == calculated;
}
STAGE int kind_allowed(uint32_t kind) { return kind >= 1 && kind <= 4; }
STAGE int value_allowed(uint32_t value, uint32_t flags) {
    return value <= ((flags & 1) ? 4095U : 1023U);
}
STAGE uint32_t scale_value(uint32_t value, uint32_t kind) {
    return value * kind;
}
STAGE uint32_t clamp_value(uint32_t value) {
    return value > 10000U ? 10000U : value;
}
STAGE uint32_t choose_bucket(uint32_t value) {
    if (value < 100U) return 0;
    if (value < 1000U) return 1;
    if (value < 5000U) return 2;
    return 3;
}
STAGE void record_seen(void) { state.seen++; }
STAGE void record_rejected(void) { state.rejected++; }
STAGE void record_accepted(uint32_t bucket) {
    state.accepted++;
    state.buckets[bucket]++;
}
STAGE void record_sum(uint32_t value) { state.sum += value; }
STAGE void record_low(uint32_t value) {
    if (value < state.low) state.low = value;
}
STAGE void record_high(uint32_t value) {
    if (value > state.high) state.high = value;
}
STAGE void record_last(uint32_t value) { state.last = value; }

/* -1 malformed packet, -2 valid packet rejected by kind/value policy. */
STAGE int32_t telemetry_apply(const uint8_t *packet, uint32_t length) {
    if (!marker_ok(packet, length)) return -1;
    uint32_t kind = read_kind(packet);
    uint32_t value = read_value(packet);
    uint32_t flags = read_flags(packet);
    if (!check_matches(packet, calculate_check(packet))) return -1;
    record_seen();
    if (!kind_allowed(kind) || !value_allowed(value, flags)) {
        record_rejected();
        return -2;
    }
    uint32_t transformed = clamp_value(scale_value(value, kind));
    uint32_t bucket = choose_bucket(transformed);
    record_accepted(bucket);
    record_sum(transformed);
    record_low(transformed);
    record_high(transformed);
    record_last(transformed);
    return (int32_t)transformed;
}

STAGE struct telemetry_state telemetry_snapshot(void) { return state; }

int main(int argc, char **argv) {
    uint32_t kind = argc > 1 ? (uint32_t)strtoul(argv[1], NULL, 0) : 2;
    uint32_t value = argc > 2 ? (uint32_t)strtoul(argv[2], NULL, 0) : 42;
    uint32_t flags = argc > 3 ? (uint32_t)strtoul(argv[3], NULL, 0) : 0;
    uint8_t packet[6] = {0xa5, (uint8_t)kind, (uint8_t)value,
                         (uint8_t)(value >> 8), 0, (uint8_t)flags};
    packet[4] = (uint8_t)calculate_check(packet);
    telemetry_reset();
    int32_t result = telemetry_apply(packet, sizeof(packet));
    struct telemetry_state snapshot = telemetry_snapshot();
    printf("result=%d seen=%u accepted=%u rejected=%u sum=%u low=%u high=%u last=%u\n",
           result, snapshot.seen, snapshot.accepted, snapshot.rejected,
           snapshot.sum, snapshot.low, snapshot.high, snapshot.last);
    return result < 0 ? 1 : 0;
}
