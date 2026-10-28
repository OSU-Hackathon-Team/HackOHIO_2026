/**
 * Where an Electron application's main process starts.
 *
 * `package.json` names the entry, and for a packaged application that name is usually honoured.
 * A launcher that ships its payload as a second archive does not always do that: the package it
 * declares describes the launcher, and the archive holds a differently named module. Both the
 * static inventory and the oracle must resolve the same file, so resolution lives here.
 */

export const SCRIPT_EXTENSIONS = [".js", ".cjs", ".mjs"];

/* Conventional entry names, in the order a launcher or packaging tool would try them. They are
   only consulted when the declared entry is absent, and the caller reports that it did. */
export const CONVENTIONAL_ENTRIES = ["main.js", "index.js", "electron.js", "main.cjs", "index.cjs",
  "main.mjs", "index.mjs"];

export function isScriptFile(name) {
  return SCRIPT_EXTENSIONS.some(extension => name.endsWith(extension));
}

/** The file `package.json` names, if it is inside the archive and is a script. */
export function declaredEntryCandidates(declaredMain) {
  const base = String(declaredMain).replaceAll("\\", "/").replace(/^\.\//, "");
  return [base, ...SCRIPT_EXTENSIONS.map(extension => base + extension),
    ...SCRIPT_EXTENSIONS.map(extension => (base === "." ? "" : `${base}/`) + `index${extension}`)];
}

/**
 * Resolve the main entry against a name predicate (`has`).
 *
 * Returns `{ entry, fallback }`: `fallback` says the declared entry did not exist and a
 * conventional name was used, which the caller reports rather than hides. `entry` is null when
 * nothing usable exists.
 */
export function resolveMainEntry(declaredMain, has) {
  const declared = declaredEntryCandidates(declaredMain).find(name => has(name) && isScriptFile(name));
  if (declared) return { entry: declared, declared: declaredMain, fallback: false };
  const conventional = CONVENTIONAL_ENTRIES.find(name => has(name));
  return { entry: conventional ?? null, declared: declaredMain, fallback: Boolean(conventional) };
}
