# 02 — Demo Targets: Inkwell & Recall (H1–H3)

## 1. Why we build our own targets

- **Legal and honest.** Obsidian's terms forbid reverse engineering. Anki is open source (AGPL)
  and written in Rust/Python, so there is no `anki_core.dll`. Windows Calculator is MIT on GitHub,
  so there's nothing to decompile. Judges who know these apps will catch invented evidence.
- **Reliable.** We control the code, so REA's output is predictable and the source line numbers
  in requirements stay stable.
- **Realistic.** Both apps are real Electron apps, packaged as `app.asar` the same way shipping
  apps are. Domain logic is mixed with Electron glue (`ipcMain`, `BrowserWindow`, `fs`), which the
  pipeline must strip out.

Pitch line: *"We built two small Electron apps as stand-ins. REA treats them exactly like any
shipped Electron app, because it only sees the packaged `.asar`."*

> Optional stretch (only after CP2): run the same pipeline on a real, permissively licensed
> open-source Electron app. Check its license first and record the run as evidence.

## 2. Directory layout

```
targets/
├── manifest.json
├── src/
│   ├── inkwell/                       # "Inkwell Notes" — markdown vault with wiki links
│   │   ├── package.json
│   │   └── src/
│   │       ├── main.js                # Electron glue (BrowserWindow, ipcMain)
│   │       ├── preload.js
│   │       ├── storage/vault.js       # fs glue
│   │       ├── graph/wikilinks.js     # FEATURE: link parser
│   │       ├── graph/backlinks.js     # FEATURE: graph + backlinks
│   │       └── search/fuzzy.js        # FEATURE: fuzzy title search
│   └── recall/                        # "Recall Flashcards" — spaced repetition
│       ├── package.json
│       └── src/
│           ├── main.js
│           ├── db/deckStore.js        # fs glue
│           ├── scheduler/sm2.js       # FEATURE: SM-2 scheduler
│           └── stats/streaks.js       # FEATURE: review streaks
└── build/
    ├── inkwell/app.asar  + app.asar.sha256
    └── recall/app.asar   + app.asar.sha256
```

**Freeze rule:** once Eng 2 records specs (H8+), these source files are frozen **byte for
byte**. Requirements cite line numbers (e.g. `sm2.js:L21-L23`). Any edit means re-recording
every fixture for that app.

## 3. Source — Recall

### `targets/src/recall/package.json`

```json
{
  "name": "recall-flashcards",
  "version": "1.4.2",
  "description": "Spaced-repetition flashcards",
  "main": "src/main.js",
  "author": "Splice demo target",
  "license": "MIT"
}
```

### `targets/src/recall/src/scheduler/sm2.js` (line numbers matter — 34 lines exactly)

```js
"use strict";
const MIN_EASE = 1.3;
const LEECH_THRESHOLD = 8;
function checkGrade(q) {
  if (!Number.isInteger(q) || q < 0 || q > 5) {
    throw new RangeError("grade must be an integer 0-5");
  }
}
function updateEase(ease, q) {
  const next = ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  return Math.max(MIN_EASE, Math.round(next * 100) / 100);
}
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * card: { reps, interval, ease, lapses, due }  (due = epoch ms)
 * q: recall grade 0..5, now: epoch ms
 */
function scheduleReview(card, q, now) {
  checkGrade(q);
  const next = Object.assign({}, card);
  if (q >= 3) {
    next.interval = card.reps === 0 ? 1 : card.reps === 1 ? 6 : Math.round(card.interval * card.ease);
    next.reps = card.reps + 1;
  } else {
    next.reps = 0;
    next.interval = 1;
    next.lapses = (card.lapses || 0) + 1;
  }
  next.ease = updateEase(card.ease, q);
  next.due = now + next.interval * DAY_MS;
  next.leech = (next.lapses || 0) >= LEECH_THRESHOLD;
  return next;
}
module.exports = { scheduleReview, updateEase, DAY_MS };
```

### `targets/src/recall/src/stats/streaks.js`

```js
"use strict";
const DAY = 86400000;

function toDay(iso) {
  return Math.floor(Date.parse(iso + "T00:00:00Z") / DAY);
}

/**
 * reviewDates: array of "YYYY-MM-DD" (duplicates allowed, any order)
 * today: "YYYY-MM-DD"
 * A streak stays "current" if the last review was today or yesterday.
 */
function computeStreak(reviewDates, today) {
  const days = Array.from(new Set(reviewDates.map(toDay))).sort((a, b) => a - b);
  if (days.length === 0) return { current: 0, longest: 0, lastReview: null };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = days[i] === days[i - 1] + 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  const t = toDay(today);
  const last = days[days.length - 1];
  let current = 0;
  if (t - last <= 1) {
    current = 1;
    for (let i = days.length - 1; i > 0 && days[i] === days[i - 1] + 1; i--) current++;
  }
  return { current, longest, lastReview: new Date(last * DAY).toISOString().slice(0, 10) };
}

module.exports = { computeStreak };
```

### `targets/src/recall/src/db/deckStore.js` (glue — must NOT end up in engines)

```js
"use strict";
const fs = require("fs/promises");
const path = require("path");

async function loadDeck(dir, name) {
  const raw = await fs.readFile(path.join(dir, name + ".json"), "utf8");
  return JSON.parse(raw);
}

async function saveDeck(dir, name, deck) {
  await fs.writeFile(path.join(dir, name + ".json"), JSON.stringify(deck, null, 2));
}

module.exports = { loadDeck, saveDeck };
```

### `targets/src/recall/src/main.js` (glue)

```js
"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { loadDeck, saveDeck } = require("./db/deckStore");
const { scheduleReview } = require("./scheduler/sm2");
const { computeStreak } = require("./stats/streaks");

const DATA_DIR = () => path.join(app.getPath("userData"), "decks");

app.whenReady().then(() => {
  ipcMain.handle("card:answer", async (_e, deckName, cardId, grade) => {
    const deck = await loadDeck(DATA_DIR(), deckName);
    const card = deck.cards.find((c) => c.id === cardId);
    Object.assign(card, scheduleReview(card, grade, Date.now()));
    deck.history.push(new Date().toISOString().slice(0, 10));
    await saveDeck(DATA_DIR(), deckName, deck);
    return card;
  });
  ipcMain.handle("stats:streak", async (_e, deckName) => {
    const deck = await loadDeck(DATA_DIR(), deckName);
    return computeStreak(deck.history, new Date().toISOString().slice(0, 10));
  });
  new BrowserWindow({ width: 900, height: 640 }).loadURL("data:text/html,<h1>Recall</h1>");
});
```

## 4. Source — Inkwell

### `targets/src/inkwell/package.json`

```json
{
  "name": "inkwell-notes",
  "version": "2.1.0",
  "description": "Markdown notes with wiki links",
  "main": "src/main.js",
  "author": "Splice demo target",
  "license": "MIT"
}
```

### `targets/src/inkwell/src/graph/wikilinks.js`

```js
"use strict";
const FENCE = /^```/;
const LINK = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

/**
 * Extracts [[Target]], [[Target|alias]] and [[Target#Heading|alias]] links.
 * Links inside fenced code blocks and inline `code` are ignored.
 */
function parseWikiLinks(markdown) {
  const links = [];
  let inFence = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    if (FENCE.test(rawLine.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = rawLine.replace(/`[^`]*`/g, "");
    LINK.lastIndex = 0;
    let m;
    while ((m = LINK.exec(line)) !== null) {
      links.push({
        target: m[1].trim(),
        heading: m[2] ? m[2].trim() : null,
        alias: m[3] ? m[3].trim() : null,
      });
    }
  }
  return links;
}

function normalizeTitle(title) {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

module.exports = { parseWikiLinks, normalizeTitle };
```

### `targets/src/inkwell/src/graph/backlinks.js`

```js
"use strict";
const { parseWikiLinks, normalizeTitle } = require("./wikilinks");

/**
 * notes: Array<{ id, title, body }>
 * Returns nodes with degree, de-duplicated directed edges, backlinks per note,
 * and unresolved link targets per note. Self-links are ignored.
 */
function buildLinkGraph(notes) {
  const byTitle = new Map();
  for (const n of notes) byTitle.set(normalizeTitle(n.title), n.id);

  const edges = [];
  const seen = new Set();
  const backlinks = {};
  const unresolved = {};
  for (const n of notes) backlinks[n.id] = [];

  for (const note of notes) {
    for (const link of parseWikiLinks(note.body)) {
      const targetId = byTitle.get(normalizeTitle(link.target));
      if (!targetId) {
        (unresolved[note.id] = unresolved[note.id] || []).push(link.target);
        continue;
      }
      if (targetId === note.id) continue;
      const key = note.id + "->" + targetId;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: note.id, to: targetId });
      backlinks[targetId].push(note.id);
    }
  }

  const degree = {};
  for (const e of edges) {
    degree[e.from] = (degree[e.from] || 0) + 1;
    degree[e.to] = (degree[e.to] || 0) + 1;
  }
  const nodes = notes.map((n) => ({ id: n.id, title: n.title, degree: degree[n.id] || 0 }));
  return { nodes, edges, backlinks, unresolved };
}

module.exports = { buildLinkGraph };
```

### `targets/src/inkwell/src/search/fuzzy.js`

```js
"use strict";

function isBoundary(text, i) {
  return i === 0 || /[\s\-_/.]/.test(text[i - 1]);
}

/** Subsequence match. Returns null if not all query chars appear in order. Higher = better. */
function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === " ") continue;
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) { found = ti; break; }
      ti++;
    }
    if (found === -1) return null;
    score += 1;
    if (found === prev + 1) score += 5;
    if (isBoundary(text, found)) score += 10;
    if (found === 0) score += 3;
    prev = found;
    ti = found + 1;
  }
  score -= Math.floor((t.length - q.length) / 10);
  return score;
}

function rankNotes(query, notes, limit) {
  const out = [];
  for (const n of notes) {
    const s = fuzzyScore(query, n.title);
    if (s !== null) out.push({ id: n.id, title: n.title, score: s });
  }
  out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return out.slice(0, limit === undefined ? 10 : limit);
}

module.exports = { fuzzyScore, rankNotes };
```

### `targets/src/inkwell/src/storage/vault.js` (glue)

```js
"use strict";
const fs = require("fs/promises");
const path = require("path");

async function loadVault(dir) {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
  return Promise.all(files.map(async (f) => {
    const body = await fs.readFile(path.join(dir, f), "utf8");
    const heading = body.match(/^#\s+(.+)$/m);
    return { id: f, title: heading ? heading[1].trim() : f.replace(/\.md$/, ""), body };
  }));
}

module.exports = { loadVault };
```

### `targets/src/inkwell/src/main.js` and `preload.js` (glue)

```js
"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { loadVault } = require("./storage/vault");
const { buildLinkGraph } = require("./graph/backlinks");
const { rankNotes } = require("./search/fuzzy");

let vault = [];

app.whenReady().then(async () => {
  vault = await loadVault(path.join(app.getPath("documents"), "Inkwell"));
  ipcMain.handle("graph:get", () => buildLinkGraph(vault));
  ipcMain.handle("search:query", (_e, q) => rankNotes(q, vault, 20));
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.loadURL("data:text/html,<h1>Inkwell</h1>");
});
```

```js
// preload.js
"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("inkwell", {
  graph: () => ipcRenderer.invoke("graph:get"),
  search: (q) => ipcRenderer.invoke("search:query", q),
});
```

## 5. Build script — `scripts/build-targets.mjs`

Install once at the root: `npm install -D --save-exact @electron/asar@3.2.17`. (Use whatever 3.x
npm resolves, then keep it pinned by the lockfile.)

```js
// scripts/build-targets.mjs
import { createPackage } from "@electron/asar";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPS = ["inkwell", "recall"];

async function sha256(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

for (const app of APPS) {
  const src = path.join(ROOT, "targets/src", app);
  const outDir = path.join(ROOT, "targets/build", app);
  const out = path.join(outDir, "app.asar");
  await fs.mkdir(outDir, { recursive: true });
  await createPackage(src, out);
  const hash = await sha256(out);
  await fs.writeFile(out + ".sha256", hash + "\n");
  console.log(`${app.padEnd(8)} → ${path.relative(ROOT, out)}  sha256=${hash.slice(0, 16)}…`);
}
```

Commit `targets/build/**`. Every machine must analyze byte-identical archives, because the
hashes go into provenance.

## 6. The pantry — `targets/manifest.json`

```json
{
  "apps": [
    {
      "app_id": "inkwell",
      "display_name": "Inkwell Notes",
      "icon": "BookOpen",
      "description": "Electron markdown vault with [[wiki links]], backlinks and fuzzy search.",
      "artifact_type": "electron_asar",
      "target_path": "targets/build/inkwell/app.asar",
      "live_supported": true,
      "features": [
        {
          "feature_id": "inkwell.wikilink_graph",
          "title": "Wiki-link graph & backlinks",
          "query": "How Inkwell finds [[wiki links]] in notes and builds the note graph with backlinks and unresolved links",
          "category": "graph",
          "seeds": [{ "kind": "module", "value": "src/graph/backlinks.js" }],
          "symbols": ["buildLinkGraph", "parseWikiLinks", "normalizeTitle"]
        },
        {
          "feature_id": "inkwell.fuzzy_search",
          "title": "Fuzzy title search",
          "query": "How Inkwell scores and ranks note titles for a fuzzy search query",
          "category": "search",
          "seeds": [{ "kind": "module", "value": "src/search/fuzzy.js" }],
          "symbols": ["fuzzyScore", "rankNotes"]
        }
      ]
    },
    {
      "app_id": "recall",
      "display_name": "Recall Flashcards",
      "icon": "Clock",
      "description": "Electron flashcard app with SM-2 scheduling and review streaks.",
      "artifact_type": "electron_asar",
      "target_path": "targets/build/recall/app.asar",
      "live_supported": true,
      "features": [
        {
          "feature_id": "recall.sm2_scheduler",
          "title": "SM-2 spaced repetition",
          "query": "How Recall schedules the next review of a card after the user grades their recall",
          "category": "scheduling",
          "seeds": [{ "kind": "module", "value": "src/scheduler/sm2.js" }],
          "symbols": ["scheduleReview", "updateEase"]
        },
        {
          "feature_id": "recall.review_streaks",
          "title": "Review streaks",
          "query": "How Recall computes the current and longest daily review streak",
          "category": "utility",
          "seeds": [{ "kind": "module", "value": "src/stats/streaks.js" }],
          "symbols": ["computeStreak"]
        }
      ]
    }
  ]
}
```

> `seed.value` format (`src/...` relative to the archive root vs. with a leading `/`) must match
> what `trace_application_feature` expects. Verify with the H1 catalog and adjust the manifest,
> not the code.

## 7. Seed evidence for Eng 2 (H2, hand-built, deleted at CP2)

For each of the four features, write `fixtures/evidence/_seed/<feature_id>.json` as a valid
`RawEvidence`:
- `mode: "replay"`, `tool_calls: []`, `rea_package_version: "6.7.0"`
- `target.sha256` from the `.sha256` file
- `snippets`: the seed module (`full_module: true`), plus every module it `require`s with a
  relative path (e.g. backlinks.js → wikilinks.js), plus `main.js` (so Eng 2's prompt learns to
  ignore glue)
- `related_paths`: the same list of paths

Small helper so nobody types file contents into JSON by hand:

```ts
// packages/backend/src/scripts/makeSeedEvidence.ts
import fs from "node:fs/promises";
import path from "node:path";
import { RawEvidence, Pantry } from "@splice/contracts";
import { REPO_ROOT } from "../config.js";

const pantry = Pantry.parse(JSON.parse(await fs.readFile(path.join(REPO_ROOT, "targets/manifest.json"), "utf8")));
for (const app of pantry.apps) {
  for (const f of app.features) {
    const seedPath = f.seeds[0].value;
    const srcRoot = path.join(REPO_ROOT, "targets/src", app.app_id);
    const seedCode = await fs.readFile(path.join(srcRoot, seedPath), "utf8");
    const rel = [...seedCode.matchAll(/require\("(\.[^"]+)"\)/g)]
      .map((m) => path.posix.normalize(path.posix.join(path.posix.dirname(seedPath), m[1])) + ".js");
    const paths = [seedPath, ...rel, "src/main.js"];
    const snippets = await Promise.all(paths.map(async (p) => ({
      location: `app.asar:${p}`,
      symbol: f.symbols.find((s) => seedCode.includes(`function ${s}`)) ?? null,
      language: "javascript" as const,
      code: await fs.readFile(path.join(srcRoot, p), "utf8"),
      full_module: true,
    })));
    const sha = (await fs.readFile(path.join(REPO_ROOT, app.target_path + ".sha256"), "utf8")).trim();
    const ev = RawEvidence.parse({
      app_id: app.app_id, feature_id: f.feature_id,
      target: { path: app.target_path, artifact_type: app.artifact_type, sha256: sha },
      rea_package_version: "6.7.0", mode: "replay", tool_calls: [], snippets, related_paths: paths,
      limitations: ["Seed evidence assembled from source, not from REA"], unknowns: [],
      collected_at: new Date().toISOString(),
    });
    const out = path.join(REPO_ROOT, "fixtures/evidence/_seed", `${f.feature_id}.json`);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(ev, null, 2));
    console.log("wrote", path.relative(REPO_ROOT, out));
  }
}
```
