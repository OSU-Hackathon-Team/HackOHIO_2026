import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WireObjectSchema,
  canonicalJson,
  decodeWireValue,
  encodeWireValue,
  wireSchemaProblems,
  wireTsType,
  type WireType,
} from "../dist/index.js";

const i64: WireType = { kind: "int", bits: 64, signed: true };
const u8: WireType = { kind: "int", bits: 8, signed: false };
const f64: WireType = { kind: "float", bits: 64 };
const text: WireType = { kind: "string", encoding: "utf-8", max_bytes: 64 };

describe("wire schemas", () => {
  it("accepts a bounded object schema and rejects untyped objects", () => {
    const schema = WireObjectSchema.parse({
      kind: "object",
      fields: [{ name: "value", type: { kind: "int", bits: 64, signed: true }, optional: false }],
      additional: false,
    });
    assert.equal(schema.fields.length, 1);
    assert.deepEqual(wireSchemaProblems(schema), []);
    assert.deepEqual(
      wireSchemaProblems({ kind: "object", fields: [], additional: false }),
      ["$: object has no fields"],
    );
  });

  it("rejects reserved field names and duplicate object fields", () => {
    assert.throws(() =>
      WireObjectSchema.parse({
        kind: "object",
        fields: [
          { name: "$tag", type: { kind: "null" }, optional: false },
          { name: "a", type: { kind: "null" }, optional: false },
          { name: "a", type: { kind: "null" }, optional: false },
        ],
        additional: false,
      }),
    );
  });
});

describe("lossless wire encoding", () => {
  it("round-trips int64 beyond Number.MAX_SAFE_INTEGER", () => {
    const encoded = encodeWireValue(i64, "9223372036854775807");
    assert.deepEqual(encoded, { $int: "9223372036854775807" });
    assert.equal(decodeWireValue(i64, encoded), 9223372036854775807n);
    assert.equal(decodeWireValue(i64, { $int: "-9223372036854775808" }), -9223372036854775808n);
    assert.throws(() => encodeWireValue(i64, "9223372036854775808"), /out of range/);
  });

  it("round-trips NaN and infinities", () => {
    assert.deepEqual(encodeWireValue(f64, NaN), { $float: "nan" });
    assert.equal(Number.isNaN(decodeWireValue(f64, { $float: "nan" })), true);
    assert.equal(decodeWireValue(f64, { $float: "infinity" }), Infinity);
    assert.equal(decodeWireValue(f64, { $float: "-infinity" }), -Infinity);
  });

  it("preserves bytes and enforces bounds", () => {
    const bytes: WireType = { kind: "bytes", max_bytes: 4 };
    const encoded = encodeWireValue(bytes, new Uint8Array([0, 1, 254, 255]));
    assert.deepEqual(encoded, { $bytes: "AAH+/w==" });
    assert.deepEqual([...decodeWireValue(bytes, encoded)], [0, 1, 254, 255]);
    assert.throws(() => encodeWireValue(bytes, new Uint8Array(5)), /exceed/);
  });

  it("round-trips nested objects, arrays, unions and integers", () => {
    const schema: WireType = {
      kind: "object",
      additional: false,
      fields: [
        { name: "name", type: text, optional: false },
        { name: "grade", type: u8, optional: false },
        { name: "values", type: { kind: "array", items: i64, max_items: 4, ordered: true }, optional: false },
        {
          name: "event",
          type: {
            kind: "union",
            tag: "kind",
            variants: [
              { tag: "started", type: { kind: "object", additional: false, fields: [] } },
              { tag: "value", type: i64 },
            ],
          },
          optional: false,
        },
      ],
    };
    const encoded = encodeWireValue(schema, {
      name: "unit",
      grade: 255,
      values: ["1", 2n, 3],
      event: { kind: "value", value: "9007199254740993" },
    });
    assert.deepEqual(encoded, {
      name: "unit",
      grade: 255,
      values: [{ $int: "1" }, { $int: "2" }, { $int: "3" }],
      event: { $tag: "value", value: { $int: "9007199254740993" } },
    });
    assert.deepEqual(decodeWireValue(schema, encoded), {
      name: "unit",
      grade: 255,
      values: [1n, 2n, 3n],
      event: { kind: "value", value: 9007199254740993n },
    });
  });

  it("rejects unknown fields, missing fields and out-of-range values", () => {
    const schema = WireObjectSchema.parse({
      kind: "object",
      additional: false,
      fields: [{ name: "value", type: u8, optional: false }],
    });
    assert.throws(() => encodeWireValue(schema, { value: 256 }), /out of range/);
    assert.throws(() => encodeWireValue(schema, {}), /missing field/);
    assert.throws(() => encodeWireValue(schema, { value: 1, extra: true }), /unexpected field/);
    assert.throws(() => decodeWireValue(schema, { value: "1" }), /expected integer/);
  });

  it("formats a TypeScript type for generated clients", () => {
    assert.equal(wireTsType(i64), "bigint");
    assert.equal(wireTsType(u8), "number");
    assert.equal(
      wireTsType({ kind: "object", additional: false, fields: [{ name: "a b", type: text, optional: true }] }),
      '{ "a b"?: string }',
    );
  });
});

describe("canonical JSON", () => {
  it("sorts keys recursively and is order independent", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }), '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  });

  it("rejects values JSON cannot represent", () => {
    assert.throws(() => canonicalJson({ a: NaN }), /non-finite/);
    assert.throws(() => canonicalJson({ a: undefined }), /undefined/);
  });
});
