import { test } from "node:test";
import assert from "node:assert/strict";
import { purityViolations } from "./purity.js";
import { GOOD_ENGINE } from "./testFixtures.js";

const one = (code: string) => {
  const v = purityViolations(code);
  assert.equal(v.length, 1, `expected one violation for: ${code}\n got: ${JSON.stringify(v)}`);
  return v[0];
};

test("a pure engine has no violations", () => {
  assert.deepEqual(purityViolations(GOOD_ENGINE), []);
});

test("each forbidden construct is caught", () => {
  const cases: [string, RegExp][] = [
    [`import { x } from "y"; export const a = x;`, /imports/],
    [`import "side-effect";`, /imports/],
    [`export { a } from "./b";`, /imports/],
    [`export async function f() { return import("x"); }`, /imports/],
    [`export type T = import("x").T;`, /imports/],
    [`const fs = require("fs");`, /require/],
    [`export const env = process.env.HOME;`, /process/],
    [`export const w = window.innerWidth;`, /browser/],
    [`export function f() { return document; }`, /browser/],
    [`export const s = localStorage.getItem("k");`, /browser/],
    [`export const g = globalThis;`, /globalThis/],
    [`export const p = fetch("https://example.com");`, /network/],
    [`export const x = new XMLHttpRequest();`, /network/],
    [`setTimeout(() => 1, 5);`, /timers/],
    [`export const r = Math.random();`, /Math\.random/],
    [`export const t = Date.now();`, /clock/],
    [`export const d = new Date();`, /clock/],
    [`export const d = new Date;`, /clock/],
    [`export const s = Date();`, /clock/],
    [`export const t = performance.now();`, /clock/],
    [`export const id = crypto.randomUUID();`, /nondeterministic/],
    [`export function f() { console.log(1); }`, /console/],
    [`export const v = eval("1");`, /eval/],
    [`export const f = new Function("return 1");`, /eval/],
  ];
  for (const [code, re] of cases) assert.match(one(code), re, code);
});

test("strings, comments and regex literals never trigger rules", () => {
  const code = `// uses Math.random() and Date.now() in the original, console.log too
/* import x from "y"; require("fs"); window.document */
export const a = "fetch('x') process.env setTimeout(";
export const b = \`new Date() eval(\${1})\`;
export const re = /window\\.document|import\\s+x/;`;
  assert.deepEqual(purityViolations(code), []);
});

test("property names and local declarations are not globals", () => {
  const code = `export interface Ctx { window: number; console: string }
export function f(o: { process: number; document: string }, crypto: number): number {
  const fetch = (n: number) => n + 1;
  const obj = { window: 1, navigator: 2 };
  return o.process + obj.window + fetch(crypto);
}
export const d = new Date("2026-01-01");
export const t = Date.parse("2026-01-01");`;
  assert.deepEqual(purityViolations(code), []);
});

test("violations report the first line and are de-duplicated", () => {
  const v = purityViolations(`export const a = 1;\nexport const r = Math.random();\nexport const s = Math.random();`);
  assert.deepEqual(v, ["Math.random() makes the engine nondeterministic (line 2)"]);
});
