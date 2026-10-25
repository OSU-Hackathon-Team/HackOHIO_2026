import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import type { EntityDef, SynthesisBundle } from "@splice/contracts";
import {
  endpointSegment,
  fileBase,
  generatePersistenceBackend,
  persistenceEntities,
  synthesizePersistenceSuite,
} from "./persistenceGenerator.js";

const note: EntityDef = {
  name: "Note",
  key: "id",
  fields: [
    { name: "id", type: "string", description: "Note identifier" },
    { name: "title", type: "string", description: "Note title" },
    { name: "tags", type: "string[]", description: "Note tags" },
  ],
};

const cardDeck: EntityDef = {
  name: "Card Deck",
  key: "id",
  fields: [{ name: "id", type: "string", description: "Deck identifier" }],
};

/** Every generated file must at least be valid TypeScript. */
function parseErrors(path: string, code: string): string[] {
  const sf = ts.createSourceFile(path, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  return ((sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []).map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, " "),
  );
}

const bundle: SynthesisBundle = {
  bundle_id: "b_1",
  app_title: "Study Room",
  app_description: "Notes and reviews",
  files: { "/App.tsx": "export default function App() { return null; }" },
  dependencies: {},
  engine_paths: [],
  generated_paths: ["/App.tsx"],
  backend_paths: {},
  contract_path: null,
  has_backend: false,
  feature_ids: [],
  warnings: [],
  mode: "live",
  revision: 0,
};

test("a persistent entity gets a contract, a repository, CRUD routes and a server", () => {
  const { paths, contractPath } = generatePersistenceBackend([note]);

  assert.deepEqual(Object.keys(paths).sort(), [
    "/backend/contract.ts",
    "/backend/db.ts",
    "/backend/repositories/note.ts",
    "/backend/routes/note.ts",
    "/backend/server.ts",
  ]);
  assert.equal(contractPath, "/backend/contract.ts");
  assert.equal(paths[contractPath], paths["/backend/contract.ts"]);

  // Contract: the entity record and the route table the client builds against.
  assert.match(paths["/backend/contract.ts"], /export interface Note \{\n {2}id: string;\n {2}title: string;\n {2}tags: string\[\];\n\}/);
  assert.match(paths["/backend/contract.ts"], /notes: "\/api\/notes",/);

  // Repository interface: get / list / put / delete, backed in memory.
  assert.match(paths["/backend/db.ts"], /get\(key: string\): Promise<T \| undefined>/);
  assert.match(paths["/backend/db.ts"], /list\(\): Promise<T\[\]>/);
  assert.match(paths["/backend/db.ts"], /put\(entity: T\): Promise<T>/);
  assert.match(paths["/backend/db.ts"], /delete\(key: string\): Promise<boolean>/);
  assert.match(paths["/backend/repositories/note.ts"], /export const note: Repository<Note> = new InMemoryRepository<Note>/);

  // Endpoints: GET /api/note, POST /api/note, DELETE /api/note/:id — mounted on the server.
  const route = paths["/backend/routes/note.ts"];
  assert.match(route, /noteRouter\.get\("\/"/);
  assert.match(route, /noteRouter\.post\("\/"/);
  assert.match(route, /noteRouter\.delete\("\/:id"/);
  assert.match(paths["/backend/server.ts"], /app\.use\("\/api\/notes", noteRouter\);/);
});

test("plural names become valid identifiers, file names and URL segments", () => {
  const { paths } = generatePersistenceBackend([cardDeck]);
  assert.equal(fileBase(cardDeck), "card-deck");
  assert.equal(endpointSegment(cardDeck), "card-decks");
  assert.ok(paths["/backend/routes/card-deck.ts"]);
  assert.match(paths["/backend/routes/card-deck.ts"], /cardDeckRouter\.delete\("\/:id"/);
  assert.match(paths["/backend/server.ts"], /app\.use\("\/api\/card-decks", cardDeckRouter\);/);
});

test("the entity key drives the repository lookup and the delete parameter", () => {
  const slugged: EntityDef = { name: "Page", key: "slug", fields: [{ name: "slug", type: "string", description: "URL slug" }] };
  const { paths } = generatePersistenceBackend([slugged]);
  assert.match(paths["/backend/repositories/page.ts"], /\(record\) => record\.slug/);
  assert.match(paths["/backend/routes/page.ts"], /pageRouter\.delete\("\/:slug"/);
  assert.match(paths["/backend/routes/page.ts"], /slug: body\.slug \?\? randomUUID\(\)/);
});

test("every generated file parses as TypeScript", () => {
  const { paths } = generatePersistenceBackend([note, cardDeck]);
  for (const [path, code] of Object.entries(paths)) {
    assert.deepEqual(parseErrors(path, code), [], `${path} must parse`);
  }
});

test("persistenceEntities takes only persistent specs and de-duplicates by name", () => {
  const entities = persistenceEntities([
    { spec: { effects: ["persistence"], entities: [note] } },
    { spec: { effects: [], entities: [{ ...note, name: "Ignored", key: "id", fields: [] }] } },
    { spec: { effects: ["persistence"], entities: [note, cardDeck] } },
  ]);
  assert.deepEqual(entities.map((e) => e.name), ["Note", "Card Deck"]);
});

test("synthesizePersistenceSuite adds the backend without touching the client map", () => {
  const b = synthesizePersistenceSuite([note], bundle);

  assert.equal(b.has_backend, true);
  assert.equal(b.contract_path, "/backend/contract.ts");
  assert.deepEqual(Object.keys(b.backend_paths).sort(), [
    "/backend/contract.ts",
    "/backend/db.ts",
    "/backend/repositories/note.ts",
    "/backend/routes/note.ts",
    "/backend/server.ts",
  ]);
  // The Sandpack file map and generated_paths stay client-only.
  assert.deepEqual(b.files, bundle.files);
  assert.deepEqual(b.generated_paths, ["/App.tsx"]);
});

test("a bundle with no persistent entity is left untouched", () => {
  assert.deepEqual(synthesizePersistenceSuite([], bundle), bundle);
});
