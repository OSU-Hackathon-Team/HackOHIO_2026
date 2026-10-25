// Owner: Eng 3 (Implementation) — spec: docs/USETHISproposal-backend-generation.md §3
// Deterministic (no model) backend writer for specs that declare effects: ["persistence"].
//
// For every entity it emits a self-contained Express + TypeScript project:
//
//   /backend/contract.ts              shared entity types and API route table
//   /backend/db.ts                    Repository<T> interface + in-memory implementation
//   /backend/repositories/<entity>.ts one typed repository instance per entity
//   /backend/routes/<entity>.ts       GET / POST / DELETE endpoints for that entity
//   /backend/server.ts                mounts every router under /api/<entities>
//
// The files stay out of SynthesisBundle.files (that map is the Sandpack client);
// they travel in SynthesisBundle.backend_paths as path -> source.
import type { EntityDef, SynthesisBundle } from "@splice/contracts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `Card Deck` / `card-deck` -> `CardDeck`, so the name can be a TS type. */
export function typeName(entity: EntityDef): string {
  const words = entity.name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  const name = joined || "Entity";
  return /^[A-Za-z_$]/.test(name) ? name : `Entity${name}`;
}

/** `CardDeck` -> `cardDeck` — the repository instance name. */
export function repositoryVar(entity: EntityDef): string {
  const name = typeName(entity);
  return name[0].toLowerCase() + name.slice(1);
}

/** `CardDeck` -> `card-deck` — the file name under /backend/routes and /repositories. */
export function fileBase(entity: EntityDef): string {
  return typeName(entity).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** `CardDeck` -> `card-decks` — the URL segment under /api. */
export function endpointSegment(entity: EntityDef): string {
  const base = fileBase(entity);
  if (/s$/.test(base)) return base;
  if (/[^aeiou]y$/.test(base)) return `${base.slice(0, -1)}ies`;
  if (/(ch|sh|x|z)$/.test(base)) return `${base}es`;
  return `${base}s`;
}

/** Declared fields, identifier-safe, with the entity key guaranteed present. */
function entityFields(entity: EntityDef): Array<{ name: string; type: string }> {
  const seen = new Set<string>();
  const fields: Array<{ name: string; type: string }> = [];
  const all = entity.fields.some((f) => f.name === entity.key)
    ? entity.fields
    : [{ name: entity.key, type: "string", description: "Primary key" }, ...entity.fields];

  for (const f of all) {
    if (!IDENTIFIER.test(f.name) || seen.has(f.name)) continue;
    seen.add(f.name);
    fields.push({ name: f.name, type: f.type.trim() || "string" });
  }
  return fields;
}

function contractFile(entities: EntityDef[]): string {
  const interfaces = entities
    .map((e) => {
      const body = entityFields(e)
        .map((f) => `  ${f.name}: ${f.type};`)
        .join("\n");
      return `export interface ${typeName(e)} {\n${body}\n}`;
    })
    .join("\n\n");

  const routes = entities
    .map((e) => `  ${endpointSegment(e).replace(/[^A-Za-z0-9_$]/g, "_")}: "/api/${endpointSegment(e)}",`)
    .join("\n");

  return `// Shared contract between the generated client and server.
// Generated from the feature specs' \`entities\`; do not edit by hand.

${interfaces}

export interface ApiError {
  error: string;
}

export const API_ROUTES = {
${routes}
} as const;

export type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES];
`;
}

const DB_FILE = `// Storage abstraction for the generated backend.
//
// The routes only talk to Repository<T>, so swapping the in-memory store for
// SQLite (or anything else) means implementing this interface once — no route changes.

export interface Repository<T> {
  get(key: string): Promise<T | undefined>;
  list(): Promise<T[]>;
  put(entity: T): Promise<T>;
  delete(key: string): Promise<boolean>;
}

export class InMemoryRepository<T> implements Repository<T> {
  private readonly store = new Map<string, T>();
  private readonly keyOf: (entity: T) => string;

  constructor(keyOf: (entity: T) => string) {
    this.keyOf = keyOf;
  }

  async get(key: string): Promise<T | undefined> {
    return this.store.get(key);
  }

  async list(): Promise<T[]> {
    return Array.from(this.store.values());
  }

  async put(entity: T): Promise<T> {
    this.store.set(this.keyOf(entity), entity);
    return entity;
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
}
`;

function repositoryFile(entity: EntityDef): string {
  const type = typeName(entity);
  const variable = repositoryVar(entity);
  return `import type { ${type} } from "../contract.js";
import { InMemoryRepository, type Repository } from "../db.js";

export const ${variable}: Repository<${type}> = new InMemoryRepository<${type}>((record) => record.${entity.key});
`;
}

function routeFile(entity: EntityDef): string {
  const type = typeName(entity);
  const variable = repositoryVar(entity);
  const segment = endpointSegment(entity);
  const key = entity.key;
  return `import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import type { ${type} } from "../contract.js";
import { ${variable} } from "../repositories/${fileBase(entity)}.js";

export const ${variable}Router = Router();

// GET /api/${segment} — every stored ${type}.
${variable}Router.get("/", async (_req: Request, res: Response) => {
  res.json(await ${variable}.list());
});

// POST /api/${segment} — stores one record, generating the key when the body omits it.
${variable}Router.post("/", async (req: Request, res: Response) => {
  const body = req.body as Partial<${type}>;
  const record = { ...body, ${key}: body.${key} ?? randomUUID() } as ${type};
  res.status(201).json(await ${variable}.put(record));
});

// DELETE /api/${segment}/:${key} — 204 when removed, 404 when unknown.
${variable}Router.delete("/:${key}", async (req: Request, res: Response) => {
  const removed = await ${variable}.delete(req.params.${key});
  if (!removed) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
});
`;
}

function serverFile(entities: EntityDef[]): string {
  const imports = entities
    .map((e) => `import { ${repositoryVar(e)}Router } from "./routes/${fileBase(e)}.js";`)
    .join("\n");
  const mounts = entities
    .map((e) => `app.use("/api/${endpointSegment(e)}", ${repositoryVar(e)}Router);`)
    .join("\n");

  return `import express from "express";
${imports}

export const app = express();
app.use(express.json());

${mounts}

// Unknown API routes answer JSON instead of Express' HTML error page.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const port = Number(process.env.PORT ?? 3002);
if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(\`[splice] generated backend listening on http://localhost:\${port}\`);
  });
}

export default app;
`;
}

export interface GeneratedBackend {
  /** Path -> source for every generated server file. */
  paths: Record<string, string>;
  /** Path of the shared client/server contract (always one of `paths`). */
  contractPath: string;
}

/** Generates the whole persistence backend for `entities`. Pure and deterministic. */
export function generatePersistenceBackend(entities: EntityDef[]): GeneratedBackend {
  const paths: Record<string, string> = {
    "/backend/contract.ts": contractFile(entities),
    "/backend/db.ts": DB_FILE,
    "/backend/server.ts": serverFile(entities),
  };
  for (const entity of entities) {
    paths[`/backend/repositories/${fileBase(entity)}.ts`] = repositoryFile(entity);
    paths[`/backend/routes/${fileBase(entity)}.ts`] = routeFile(entity);
  }
  return { paths, contractPath: "/backend/contract.ts" };
}

/**
 * Entities that need a backend: every entity of a spec declaring
 * `effects: ["persistence"]`, de-duplicated by name across specs.
 */
export function persistenceEntities(blueprints: { spec: { effects: string[]; entities: EntityDef[] } }[]): EntityDef[] {
  const byName = new Map<string, EntityDef>();
  for (const b of blueprints) {
    if (!b.spec.effects.includes("persistence")) continue;
    for (const entity of b.spec.entities) if (!byName.has(entity.name)) byName.set(entity.name, entity);
  }
  return [...byName.values()];
}

/**
 * Integration hook: attaches the generated backend to the bundle without
 * touching `files` (the Sandpack client map) or `generated_paths`.
 */
export function synthesizePersistenceSuite(entities: EntityDef[], bundle: SynthesisBundle): SynthesisBundle {
  if (entities.length === 0) return bundle;
  const backend = generatePersistenceBackend(entities);
  return {
    ...bundle,
    backend_paths: { ...bundle.backend_paths, ...backend.paths },
    contract_path: backend.contractPath,
    has_backend: true,
  };
}
