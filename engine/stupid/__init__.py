"""Stupid decomp engine: agents decide, code only plumbs.

Code owns: artifact hashing, Ghidra evidence export, parallel fan-out,
probe execution, JSON plumbing. All scope/decomp/review/spec judgment
is made by model agents via prompts in `prompts.py`.
See STUPID_ENGINE_PLAN.md.
"""
