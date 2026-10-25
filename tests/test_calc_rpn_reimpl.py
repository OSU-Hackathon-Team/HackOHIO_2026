"""Tests for the clean-room Calc precedence chain and RPN evaluator.

Every expectation comes from spec/modules/calc_formula_engine.md: the level
ordering and opcodes of section 2, and the stack/comparison/percent rules of
section 5. The module is compiled from reimpl/rpn_compiler.c on first use.
"""

from __future__ import annotations

import ctypes
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "reimpl" / "rpn_compiler.c"
BUILD = ROOT / "decomp-state" / "reimpl"
LIBRARY = BUILD / "librpn_compiler_reimpl.so"
CAPACITY = 256


class RpnItem(ctypes.Structure):
    _fields_ = [("is_operator", ctypes.c_uint8),
                ("opcode", ctypes.c_uint16),
                ("number", ctypes.c_double)]


_library: ctypes.CDLL | None = None


def library() -> ctypes.CDLL:
    global _library
    if _library is not None:
        return _library
    BUILD.mkdir(parents=True, exist_ok=True)
    subprocess.run(["gcc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
                    "-shared", "-fPIC", str(SOURCE), "-o", str(LIBRARY), "-lm"],
                   check=True, capture_output=True, text=True)
    lib = ctypes.CDLL(str(LIBRARY))
    lib.rpn_compile.argtypes = [ctypes.c_char_p, ctypes.POINTER(RpnItem), ctypes.c_int]
    lib.rpn_compile.restype = ctypes.c_int
    lib.rpn_evaluate.argtypes = [ctypes.POINTER(RpnItem), ctypes.c_int,
                                 ctypes.POINTER(ctypes.c_double)]
    lib.rpn_evaluate.restype = ctypes.c_int
    _library = lib
    return lib


def compile_formula(formula: str) -> list[tuple]:
    lib = library()
    items = (RpnItem * CAPACITY)()
    count = lib.rpn_compile(formula.encode(), items, CAPACITY)
    if count < 0:
        return []
    return [("op", items[i].opcode) if items[i].is_operator
            else ("num", items[i].number) for i in range(count)]


def evaluate(formula: str) -> tuple[int, float]:
    lib = library()
    items = (RpnItem * CAPACITY)()
    count = lib.rpn_compile(formula.encode(), items, CAPACITY)
    if count < 0:
        return (-1, 0.0)
    result = ctypes.c_double()
    status = lib.rpn_evaluate(items, count, ctypes.byref(result))
    return (status, result.value)


class TestPrecedenceChain(unittest.TestCase):
    """Section 2: level order, associativity and opcode selection."""

    def test_multiplication_binds_tighter_than_addition(self):
        self.assertEqual(compile_formula("1+2*3"),
                         [("num", 1.0), ("num", 2.0), ("num", 3.0),
                          ("op", 0x35), ("op", 0x33)])

    def test_parentheses_override_the_chain(self):
        self.assertEqual(compile_formula("(1+2)*3"),
                         [("num", 1.0), ("num", 2.0), ("op", 0x33),
                          ("num", 3.0), ("op", 0x35)])

    def test_subtraction_is_left_associative(self):
        self.assertEqual(compile_formula("10-3-2"),
                         [("num", 10.0), ("num", 3.0), ("op", 0x32),
                          ("num", 2.0), ("op", 0x32)])

    def test_power_is_left_associative_per_spec_table(self):
        self.assertEqual(compile_formula("2^3^2"),
                         [("num", 2.0), ("num", 3.0), ("op", 0x37),
                          ("num", 2.0), ("op", 0x37)])

    def test_concatenation_is_looser_than_addition(self):
        self.assertEqual(compile_formula("1+2&3"),
                         [("num", 1.0), ("num", 2.0), ("op", 0x33),
                          ("num", 3.0), ("op", 0x36)])

    def test_comparison_is_the_loosest_level(self):
        self.assertEqual(compile_formula("1&2=3"),
                         [("num", 1.0), ("num", 2.0), ("op", 0x36),
                          ("num", 3.0), ("op", 0x38)])

    def test_percent_binds_tighter_than_power(self):
        self.assertEqual(compile_formula("2^3%"),
                         [("num", 2.0), ("num", 3.0), ("op", 0x18),
                          ("op", 0x37)])

    def test_unary_minus_is_prefix_and_emits_after_its_operand(self):
        self.assertEqual(compile_formula("-2+3"),
                         [("num", 2.0), ("op", 0x46), ("num", 3.0),
                          ("op", 0x33)])

    def test_double_negation_emits_both_prefix_operators(self):
        self.assertEqual(compile_formula("--2"),
                         [("num", 2.0), ("op", 0x46), ("op", 0x46)])

    def test_unary_plus_uses_the_identity_opcode(self):
        self.assertEqual(compile_formula("+2"), [("num", 2.0), ("op", 0x47)])

    def test_every_comparison_opcode(self):
        cases = {"1=2": 0x38, "1<>2": 0x39, "1<2": 0x3A, "1>2": 0x3B,
                 "1<=2": 0x3C, "1>=2": 0x3D}
        for formula, opcode in cases.items():
            with self.subTest(formula=formula):
                self.assertEqual(compile_formula(formula)[-1], ("op", opcode))

    def test_division_opcode_differs_from_multiplication(self):
        self.assertEqual(compile_formula("8/4"),
                         [("num", 8.0), ("num", 4.0), ("op", 0x34)])

    def test_malformed_formulas_are_rejected(self):
        for formula in ("", "1+", "(1", "1)", "*2", "1 2", "1:~2"):
            with self.subTest(formula=formula):
                self.assertEqual(compile_formula(formula), [])


class TestEvaluation(unittest.TestCase):
    """Section 5: stack discipline, comparison results, percent divisor."""

    def assertValue(self, formula: str, expected: float):
        status, value = evaluate(formula)
        self.assertEqual(status, 0, formula)
        self.assertAlmostEqual(value, expected, places=12, msg=formula)

    def test_arithmetic_respects_precedence(self):
        self.assertValue("1+2*3", 7.0)
        self.assertValue("(1+2)*3", 9.0)
        self.assertValue("10-3-2", 5.0)
        self.assertValue("8/4/2", 1.0)

    def test_power_chain_evaluates_left_to_right(self):
        self.assertValue("2^3^2", 64.0)

    def test_percent_divides_by_one_hundred(self):
        self.assertValue("50%", 0.5)
        self.assertValue("-50%", -0.5)

    def test_unary_minus_applies_before_addition(self):
        self.assertValue("-2+3", 1.0)
        self.assertValue("--2", 2.0)

    def test_comparisons_return_one_or_zero(self):
        self.assertValue("1<2", 1.0)
        self.assertValue("2<=1", 0.0)
        self.assertValue("1<>1", 0.0)
        self.assertValue("2>=2", 1.0)
        self.assertValue("3=3", 1.0)

    def test_division_by_zero_follows_ieee_doubles(self):
        status, value = evaluate("1/0")
        self.assertEqual(status, 0)
        self.assertEqual(value, float("inf"))

    def test_concatenation_is_out_of_evaluation_scope(self):
        self.assertEqual(evaluate("1&2")[0], -3)


if __name__ == "__main__":
    unittest.main()
