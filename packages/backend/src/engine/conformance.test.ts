import { test } from "node:test";
import assert from "node:assert/strict";
import { conformanceErrors } from "./conformance.js";
import { GOOD_ENGINE, makeSpec } from "./testFixtures.js";

const spec = makeSpec();

test("a conforming engine has no errors", () => {
  assert.deepEqual(conformanceErrors(spec, GOOD_ENGINE), []);
});

test("a missing function export is reported", () => {
  const errs = conformanceErrors(spec, GOOD_ENGINE.replace("export function review", "function review"));
  assert.ok(errs.some((e) => /review/.test(e)), errs.join("\n"));
});

test("a wrong function signature is reported", () => {
  const errs = conformanceErrors(spec, GOOD_ENGINE.replace("updateEase(ease: number, q: number): number", "updateEase(ease: string, q: number): number"));
  assert.ok(errs.some((e) => e.startsWith('Export "updateEase" does not match the interface:')), errs.join("\n"));
});

test("diagnostics name the export, never the hidden check file or local paths", () => {
  const errs = conformanceErrors(spec, GOOD_ENGINE.replace("export function review", "function review"));
  assert.ok(errs.length > 0);
  for (const e of errs) {
    assert.doesNotMatch(e, /check\.ts|__virtual__|[A-Z]:\//, e);
  }
  assert.match(errs[0], /^Export "review"/);
});

test("a const export is checked against its declared type", () => {
  const missing = conformanceErrors(spec, GOOD_ENGINE.replace("export const MIN_EASE = 1.3;", "const MIN_EASE = 1.3;"));
  assert.ok(missing.some((e) => /MIN_EASE/.test(e)), missing.join("\n"));
  const wrongType = conformanceErrors(spec, GOOD_ENGINE.replace("export const MIN_EASE = 1.3;", 'export const MIN_EASE = "1.3" as unknown as string;\nconst _min = 1.3;')
    .replace(/MIN_EASE, Math/, "_min, Math"));
  assert.ok(wrongType.some((e) => /MIN_EASE/.test(e)), wrongType.join("\n"));
});

test("an exported type with a different shape is reported", () => {
  const errs = conformanceErrors(spec, GOOD_ENGINE.replace("export interface ReviewResult { ease: number; interval: number }", "export interface ReviewResult { ease: number; interval: number; extra: string }")
    .replace("interval: q < 3 ? 1 : Math.round(interval * ease) }", 'interval: q < 3 ? 1 : Math.round(interval * ease), extra: "" }'));
  assert.ok(errs.some((e) => /ReviewResult|extra/.test(e)), errs.join("\n"));
});

test("strict mode applies to the engine", () => {
  const errs = conformanceErrors(spec, GOOD_ENGINE + "\nexport function loose(x) { return x; }\n");
  assert.ok(errs.some((e) => /implicitly has an 'any' type/.test(e)), errs.join("\n"));
});
