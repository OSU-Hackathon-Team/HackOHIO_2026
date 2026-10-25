"""Original-execution probe adapter for the Calc token Clone/copy family.

Calls the real libforlo.so methods through their exported symbols (System V:
`this` is the first pointer argument) on fabricated Plain-Old-Data objects.
Only null/POD paths are exercised: string slots are always null so the
shared-string acquire path is never taken, and FUN_0010e9a8 (landing-pad
cleanup that resumes unwinding) is deliberately never invoked.

Observed values are flat JSON scalars (never addresses) so cases are
deterministic across runs. Library dependencies are preloaded by absolute
path because probe subprocesses run with a scrubbed environment.
"""

import ctypes
import json
import os
import struct
import sys

LO_PROGRAM = "/usr/lib/libreoffice/program"


def _ensure_loader_path() -> None:
    """Re-exec with the LibreOffice lib dir visible (probe env is scrubbed)."""
    current = os.environ.get("LD_LIBRARY_PATH", "")
    if LO_PROGRAM in current.split(":"):
        return
    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = LO_PROGRAM + (":" + current if current else "")
    os.execve(sys.executable, [sys.executable, os.path.abspath(__file__), *sys.argv[1:]], env)


def _u16(buf: bytes, off: int) -> int:
    return struct.unpack_from("<H", buf, off)[0]


def _u8(buf: bytes, off: int) -> int:
    return buf[off]


def _u64(buf: bytes, off: int) -> int:
    return struct.unpack_from("<Q", buf, off)[0]


def _vtable_nonnull(buf: bytes) -> int:
    return 1 if _u64(buf, 0) != 0 else 0


def _bind(lib: ctypes.CDLL, symbol: str, argtypes, restype=None):
    fn = getattr(lib, symbol)
    fn.argtypes = argtypes
    fn.restype = restype
    return fn


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: calc_token_probe_adapter.py <libforlo.so>")
    _ensure_loader_path()
    lib = ctypes.CDLL(str(sys.argv[1]))
    request = json.load(sys.stdin)
    op = request["operation"]
    c_void_p = ctypes.c_void_p

    if op == "base_init":
        fn = _bind(lib, "_ZN7formula12FormulaTokenC1ENS_8StackVarE6OpCode",
                   [c_void_p, ctypes.c_uint8, ctypes.c_uint16])
        buf = ctypes.create_string_buffer(0x40)
        fn(ctypes.addressof(buf), request["stack_var"], request["opcode"])
        raw = bytes(buf.raw)
        print(json.dumps({"opcode": _u16(raw, 8), "b10": _u8(raw, 10),
                          "b11": _u8(raw, 11), "w12": _u64(raw, 12) & 0xFFFFFFFF,
                          "vtable_nonnull": _vtable_nonnull(raw)}))
        return

    if op == "base_copy":
        fn = _bind(lib, "_ZN7formula12FormulaTokenC1ERKS0_", [c_void_p, c_void_p])
        src = ctypes.create_string_buffer(0x40)
        struct.pack_into("<H", src, 8, request["opcode"])
        src[10] = request["b10"]
        dst = ctypes.create_string_buffer(0x40)
        fn(ctypes.addressof(dst), ctypes.addressof(src))
        raw = bytes(dst.raw)
        print(json.dumps({"opcode": _u16(raw, 8), "b10": _u8(raw, 10),
                          "b11": _u8(raw, 11), "w12": _u64(raw, 12) & 0xFFFFFFFF,
                          "vtable_nonnull": _vtable_nonnull(raw)}))
        return

    if op == "singlevec_init":
        fn = _bind(lib, "_ZN7formula20SingleVectorRefTokenC1ERKNS_14VectorRefArrayEm",
                   [c_void_p, c_void_p, ctypes.c_uint64])
        n = int(request["n"])
        data = (ctypes.c_double * n)(*[float(i + 1) for i in range(n)])
        vec = (ctypes.c_uint64 * 3)(ctypes.addressof(data) if n else 0, 0,
                                    request["tail"])
        obj = ctypes.create_string_buffer(0x40)
        fn(ctypes.addressof(obj), ctypes.addressof(vec), request["index"])
        raw = bytes(obj.raw)
        print(json.dumps({"opcode": _u16(raw, 8),
                          "kind": _u8(raw, 10),
                          "a_nonnull": 1 if _u64(raw, 0x10) else 0,
                          "b_null": 1 if not _u64(raw, 0x18) else 0,
                          "tail": _u64(raw, 0x20),
                          "index": _u64(raw, 0x28),
                          "vtable_nonnull": _vtable_nonnull(raw)}))
        return

    if op == "singlevec_clone":
        init = _bind(lib, "_ZN7formula20SingleVectorRefTokenC1ERKNS_14VectorRefArrayEm",
                     [c_void_p, c_void_p, ctypes.c_uint64])
        clone = _bind(lib, "_ZNK7formula20SingleVectorRefToken5CloneEv",
                      [c_void_p], c_void_p)
        n = int(request["n"])
        data = (ctypes.c_double * n)(*[float(i + 1) for i in range(n)])
        vec = (ctypes.c_uint64 * 3)(ctypes.addressof(data) if n else 0, 0,
                                    request["tail"])
        src = ctypes.create_string_buffer(0x40)
        init(ctypes.addressof(src), ctypes.addressof(vec), request["index"])
        out = clone(ctypes.addressof(src))
        if not out:
            raise RuntimeError("Clone returned null")
        raw = ctypes.string_at(out, 0x30)
        print(json.dumps({"opcode": _u16(raw, 8),
                          "kind": _u8(raw, 10),
                          "a_matches_src": 1 if _u64(raw, 0x10) == _u64(bytes(src.raw), 0x10) else 0,
                          "index": _u64(raw, 0x28),
                          "heap_nonnull": 1,
                          "vtable_nonnull": _vtable_nonnull(raw)}))
        return

    if op == "doublevec_move":
        fn = _bind(lib, "_ZN7formula20DoubleVectorRefTokenC1EOSt6vectorINS_14VectorRefArrayESaIS2_EEmmbb",
                   [c_void_p, c_void_p, ctypes.c_uint64, ctypes.c_uint64,
                    ctypes.c_bool, ctypes.c_bool])
        n = int(request["n"])
        data = (ctypes.c_double * n)(*[float(10 * (i + 1)) for i in range(n)])
        base = ctypes.addressof(data) if n else 0
        vec3 = (ctypes.c_uint64 * 3)(base, base + 8 * n, base + 8 * n)
        obj = ctypes.create_string_buffer(0x48)
        fn(ctypes.addressof(obj), ctypes.addressof(vec3),
           request["u28"], request["u30"], request["f1"], request["f2"])
        raw = bytes(obj.raw)
        print(json.dumps({"opcode": _u16(raw, 8),
                          "kind": _u8(raw, 10),
                          "moved_n": (_u64(raw, 0x18) - _u64(raw, 0x10)) // 8 if n else 0,
                          "u28": _u64(raw, 0x28), "u30": _u64(raw, 0x30),
                          "flags": raw[0x38] & 0x03,
                          "src_zeroed": 1 if bytes(vec3) == b"\0" * 24 else 0,
                          "vtable_nonnull": _vtable_nonnull(raw)}))
        return

    if op == "doublevec_clone":
        init = _bind(lib, "_ZN7formula20DoubleVectorRefTokenC1EOSt6vectorINS_14VectorRefArrayESaIS2_EEmmbb",
                     [c_void_p, c_void_p, ctypes.c_uint64, ctypes.c_uint64,
                      ctypes.c_bool, ctypes.c_bool])
        clone = _bind(lib, "_ZNK7formula20DoubleVectorRefToken5CloneEv",
                      [c_void_p], c_void_p)
        n = int(request["n"])
        data = (ctypes.c_double * n)(*[float(10 * (i + 1)) for i in range(n)])
        base = ctypes.addressof(data) if n else 0
        vec3 = (ctypes.c_uint64 * 3)(base, base + 8 * n, base + 8 * n)
        src = ctypes.create_string_buffer(0x48)
        init(ctypes.addressof(src), ctypes.addressof(vec3),
             request["u28"], request["u30"], request["f1"], request["f2"])
        src_raw = bytes(src.raw)
        out = clone(ctypes.addressof(src))
        if not out:
            raise RuntimeError("Clone returned null")
        raw = ctypes.string_at(out, 0x40)
        cloned_n = (_u64(raw, 0x18) - _u64(raw, 0x10)) // 8
        first = struct.unpack_from("<d", ctypes.string_at(_u64(raw, 0x10), 8))[0] if cloned_n else 0.0
        print(json.dumps({"n": cloned_n,
                          "first": first,
                          "kind": raw[10],
                          "arrays_differ": 1 if _u64(raw, 0x10) != _u64(src_raw, 0x10) else 0,
                          "u28": _u64(raw, 0x28), "u30": _u64(raw, 0x30),
                          "flags": raw[0x38] & 0x03,
                          "vtable_nonnull": _vtable_nonnull(raw)}))
        return

    if op in ("string_copy_null", "strname_copy_null", "strop_copy_null"):
        symbols = {
            "string_copy_null": "_ZN7formula18FormulaStringTokenC1ERKS0_",
            "strname_copy_null": "_ZN7formula22FormulaStringNameTokenC1ERKS0_",
            "strop_copy_null": "_ZN7formula20FormulaStringOpTokenC1ERKS0_",
        }
        fn = _bind(lib, symbols[op], [c_void_p, c_void_p])
        src = ctypes.create_string_buffer(0x40)
        dst = ctypes.create_string_buffer(0x40)
        fn(ctypes.addressof(dst), ctypes.addressof(src))
        raw = bytes(dst.raw)
        observed = {"s10_null": 1 if not _u64(raw, 0x10) else 0,
                    "s18_null": 1 if not _u64(raw, 0x18) else 0,
                    "vtable_nonnull": _vtable_nonnull(raw)}
        if op == "strop_copy_null":
            observed["extra"] = _u16(raw, 0x20)
        print(json.dumps(observed))
        return

    if op in ("string_clone_null", "strname_clone_null", "strop_clone_null"):
        copy_symbols = {
            "string_clone_null": "_ZN7formula18FormulaStringTokenC1ERKS0_",
            "strname_clone_null": "_ZN7formula22FormulaStringNameTokenC1ERKS0_",
            "strop_clone_null": "_ZN7formula20FormulaStringOpTokenC1ERKS0_",
        }
        clone_symbols = {
            "string_clone_null": "_ZNK7formula18FormulaStringToken5CloneEv",
            "strname_clone_null": "_ZNK7formula22FormulaStringNameToken5CloneEv",
            "strop_clone_null": "_ZNK7formula20FormulaStringOpToken5CloneEv",
        }
        copy = _bind(lib, copy_symbols[op], [c_void_p, c_void_p])
        clone = _bind(lib, clone_symbols[op], [c_void_p], c_void_p)
        seed = ctypes.create_string_buffer(0x40)
        src = ctypes.create_string_buffer(0x40)
        copy(ctypes.addressof(src), ctypes.addressof(seed))
        out = clone(ctypes.addressof(src))
        if not out:
            raise RuntimeError("Clone returned null")
        size = 0x28 if op == "strop_clone_null" else 0x20
        raw = ctypes.string_at(out, size)
        observed = {"s10_null": 1 if not _u64(raw, 0x10) else 0,
                    "s18_null": 1 if not _u64(raw, 0x18) else 0,
                    "heap_nonnull": 1,
                    "vtable_nonnull": _vtable_nonnull(raw)}
        if op == "strop_clone_null":
            observed["extra"] = _u16(raw, 0x20)
        print(json.dumps(observed))
        return

    raise ValueError(f"unknown probe operation: {op}")


if __name__ == "__main__":
    main()
