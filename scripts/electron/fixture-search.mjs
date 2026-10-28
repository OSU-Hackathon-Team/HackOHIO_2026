/**
 * Mechanical fixture search.
 *
 * When a handler is unreachable because a fixture lacks a file or an object field, the failure
 * itself names what is missing ("reading 'push' of undefined", "ENOENT ... open '/…/decks/x.json'").
 * This module repairs the fixture set by adding the named field at every candidate object location
 * and retrying, breadth first, until the channel returns a value or the budget runs out. It knows
 * nothing about the application; it only explores the fixture shape.
 */
import path from "node:path";
import { runCase } from "./oracle.mjs";

const BASES = ["userData", "documents", "logs", "temp"];
const EMPTY_VALUES = [[], {}, "", 0, false];
const MAX_ATTEMPTS = 160;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function jsonPaths(value, prefix = []) {
  const paths = [[]];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (item && typeof item === "object") for (const child of jsonPaths(item, [...prefix, index])) paths.push(child);
    });
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value))
      if (child && typeof child === "object") for (const nested of jsonPaths(child, [...prefix, key])) paths.push(nested);
  }
  return paths;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectAt(root, keys) {
  let cursor = root;
  for (const key of keys) cursor = cursor[key];
  return cursor;
}

function fixtureFieldNames(fixtures) {
  const names = new Set();
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) { names.add(key); visit(child); }
  };
  fixtures.forEach(fixture => visit(fixture.content));
  return [...names];
}

function fixtureKey(fixtures) {
  return JSON.stringify(fixtures.map(({ base, path: file, content }) => ({ base, path: file, content })));
}

function missingField(error) {
  const message = String(error?.message ?? "");
  const match = /reading '([^']+)'/.exec(message);
  if (!match) return null;
  return match[1];
}

function missingPath(error) {
  const message = String(error?.message ?? "");
  const match = /ENOENT: no such file or directory, (?:open|stat) '([^']+)'/.exec(message);
  if (!match) return null;
  /* The oracle reports paths relative to their storage root, so the named file may appear either as
     an absolute path or already as `userData/notes/x.txt`. */
  const file = match[1].replace(/\\/g, path.sep);
  for (const base of BASES) {
    const token = `${path.sep}${base}${path.sep}`;
    const index = file.lastIndexOf(token);
    if (index >= 0)
      return { base, path: file.slice(index + token.length).split(path.sep).join("/") };
    if (file.startsWith(`${base}${path.sep}`))
      return { base, path: file.slice(base.length + 1).split(path.sep).join("/") };
  }
  return null;
}

/** Add a plausible value to a missing file path named by the error. */
function pathRepair(fixtures, missing) {
  if (fixtures.some(fixture => fixture.base === missing.base && fixture.path === missing.path)) return null;
  return [...fixtures, { base: missing.base, path: missing.path, content: {} }];
}

/**
 * Variants that add a candidate missing property at every object location in every JSON fixture.
 * The failure names the operation (for example "reading 'push'"); the missing data may be any
 * property of the receiver, so the caller supplies the method name plus every key already present
 * anywhere in the fixture set. Root locations are tried before nested ones.
 */
function fieldRepairs(fixtures, names) {
  const variants = new Map();
  const unique = [...new Set(names)].filter(Boolean).slice(0, 24);
  const locations = [];
  fixtures.forEach((fixture, index) => {
    if (!isPlainObject(fixture.content)) return;
    for (const keys of jsonPaths(fixture.content)) {
      if (!isPlainObject(objectAt(fixture.content, keys))) continue;
      locations.push({ index, keys });
    }
  });
  locations.sort((a, b) => a.keys.length - b.keys.length);
  for (const { index, keys } of locations) {
    for (const name of unique) {
      if (name in objectAt(fixtures[index].content, keys)) continue;
      for (const value of EMPTY_VALUES) {
        const copy = clone(fixtures);
        objectAt(copy[index].content, keys)[name] = value;
        variants.set(fixtureKey(copy), copy);
      }
    }
  }
  return [...variants.values()];
}

function runOutcome(result) {
  return result.outcomes[result.outcomes.length - 1];
}

/**
 * Search the fixture space for a call that succeeds. Returns the repaired fixtures and the
 * successful observation, or the failures encountered.
 */
export async function findFixture({ appDir, channel, args = [], fixtures = [], timeout = 20000 }) {
  const root = path.resolve(appDir);
  const visited = new Set();
  const attempts = [];
  let queue = [{ fixtures, call: { channel, args } }];
  while (queue.length && attempts.length < MAX_ATTEMPTS) {
    const next = queue.shift();
    const key = fixtureKey(next.fixtures);
    if (visited.has(key)) continue;
    visited.add(key);
    let result;
    try {
      result = await runCase({ appDir: root, case: { fixtures: next.fixtures, calls: [next.call] }, timeout });
    } catch (error) {
      attempts.push({ fixtures: next.fixtures, error: { name: error.name ?? "Error", message: error.message } });
      continue;
    }
    const outcome = runOutcome(result);
    attempts.push({ fixtures: next.fixtures, outcome: outcome.ok ? { ok: true } : { ok: false, error: outcome.error } });
    if (outcome.ok) return { found: true, fixtures: next.fixtures, result, attempts: attempts.length };
    const field = missingField(outcome.error);
    const repairs = field ? fieldRepairs(next.fixtures, [field, ...fixtureFieldNames(next.fixtures)]) : [];
    const missing = missingPath(outcome.error);
    if (missing) {
      const repaired = pathRepair(next.fixtures, missing);
      if (repaired) repairs.push(repaired);
    }
    for (const repaired of repairs) queue.push({ fixtures: repaired, call: next.call });
    if (!repairs.length && missingField(outcome.error)) {
      // A field on a non-object value (for example a scalar) needs the containing object, which
      // the next breadth level may create; keep going only while there is a queue.
      continue;
    }
  }
  return { found: false, attempts: attempts.length, failures: attempts.slice(-8) };
}
