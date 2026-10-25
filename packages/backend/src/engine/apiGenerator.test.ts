// Round-trip tests for the deterministic API Router & Client Generator
// Feeds recall.sm2_scheduler and inkwell.wikilink_graph specs into the generator,
// mounts the generated router on an Express test instance, and executes simulated
// client requests through fetch, confirming arguments pass into the pure engine and
// return expected results with matching types.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import express from "express";
import { generateExpressRouter, generateApiClient, extractParamNames, typeToZod } from "./apiGenerator.js";
import { FeatureSpec } from "@splice/contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

// ---------------------------------------------------------------------------
// Spec loaders
// ---------------------------------------------------------------------------

function loadSpec(relativePath: string): FeatureSpec {
  const fullPath = path.join(REPO_ROOT, relativePath);
  assert.ok(fs.existsSync(fullPath), `Spec fixture not found: ${fullPath}`);
  return FeatureSpec.parse(JSON.parse(fs.readFileSync(fullPath, "utf-8")));
}

const recallSpec = loadSpec("fixtures/hand-authored/specs/recall.sm2_scheduler.json");
const inkwellSpec = loadSpec("fixtures/hand-authored/specs/inkwell.wikilink_graph.json");

// ---------------------------------------------------------------------------
// SM-2 engine (matches the spec's interface)
// ---------------------------------------------------------------------------

const SM2_ENGINE = `
export interface CardState {
  reps: number;
  interval: number;
  ease: number;
  lapses?: number;
  due?: number;
  leech?: boolean;
}

export function scheduleReview(card: CardState, grade: number, now: number): CardState {
  if (!Number.isInteger(grade) || grade < 0 || grade > 5) {
    throw new RangeError("grade must be an integer 0-5");
  }
  const next: CardState = { ...card };
  if (grade >= 3) {
    next.interval = card.reps === 0 ? 1 : card.reps === 1 ? 6 : Math.round(card.interval * card.ease);
    next.reps = card.reps + 1;
  } else {
    next.reps = 0;
    next.interval = 1;
    next.lapses = (card.lapses || 0) + 1;
  }
  next.ease = Math.max(1.3, Math.round((card.ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02))) * 100) / 100);
  next.due = now + next.interval * 24 * 60 * 60 * 1000;
  next.leech = (next.lapses || 0) >= 8;
  return next;
}

export function updateEase(ease: number, grade: number): number {
  if (!Number.isInteger(grade) || grade < 0 || grade > 5) {
    throw new RangeError("grade must be an integer 0-5");
  }
  return Math.max(1.3, Math.round((ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02))) * 100) / 100);
}
`;

// ---------------------------------------------------------------------------
// Wiki-links engine (matches the spec's interface)
// Uses simple string methods instead of regex to avoid template escaping issues.
// ---------------------------------------------------------------------------

const WIKI_ENGINE = `
export interface WikiLink {
  target: string;
  heading: string | null;
  alias: string | null;
}

export interface NoteInput {
  id: string;
  title: string;
  body: string;
}

export interface GraphNode {
  id: string;
  title: string;
  degree: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  backlinks: Record<string, string[]>;
  unresolved: Record<string, string[]>;
}

function extractWikiLinks(line: string): Array<{ target: string; heading: string | null; alias: string | null }> {
  const results: Array<{ target: string; heading: string | null; alias: string | null }> = [];
  let idx = 0;
  while (idx < line.length) {
    const start = line.indexOf("[[", idx);
    if (start === -1) break;
    const end = line.indexOf("]]", start + 2);
    if (end === -1) break;
    const content = line.substring(start + 2, end);
    const pipeIdx = content.indexOf("|");
    const hashIdx = content.indexOf("#");
    let target = content;
    let heading: string | null = null;
    let alias: string | null = null;
    if (pipeIdx !== -1) {
      alias = content.substring(pipeIdx + 1).trim();
      target = content.substring(0, pipeIdx);
    }
    if (hashIdx !== -1 && (pipeIdx === -1 || hashIdx < pipeIdx)) {
      heading = content.substring(hashIdx + 1).trim();
      target = content.substring(0, hashIdx);
    }
    target = target.trim();
    if (target) {
      results.push({ target, heading, alias });
    }
    idx = end + 2;
  }
  return results;
}

function stripCodeSpans(text: string): string {
  const parts = text.split(String.fromCharCode(96));
  let result = "";
  for (let i = 0; i < parts.length; i += 2) {
    result += parts[i];
  }
  return result;
}

export function parseWikiLinks(markdown: string): WikiLink[] {
  const links: WikiLink[] = [];
  const lines = markdown.split("\\n");
  let inFence = false;
  const fence = String.fromCharCode(96, 96, 96);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith(fence)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = stripCodeSpans(rawLine);
    for (const link of extractWikiLinks(line)) {
      links.push(link);
    }
  }
  return links;
}

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\\s+/g, " ");
}

export function buildLinkGraph(notes: NoteInput[]): GraphResult {
  const byTitle = new Map<string, string>();
  for (const n of notes) byTitle.set(normalizeTitle(n.title), n.id);
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const backlinks: Record<string, string[]> = {};
  const unresolved: Record<string, string[]> = {};
  for (const n of notes) backlinks[n.id] = [];
  for (const note of notes) {
    for (const link of parseWikiLinks(note.body)) {
      const targetId = byTitle.get(normalizeTitle(link.target));
      if (!targetId) {
        (unresolved[note.id] = unresolved[note.id] || []).push(link.target);
        continue;
      }
      if (targetId === note.id) continue;
      const edgeKey = note.id + "->" + targetId;
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);
      edges.push({ from: note.id, to: targetId });
      backlinks[targetId].push(note.id);
    }
  }
  const degree: Record<string, number> = {};
  for (const e of edges) {
    degree[e.from] = (degree[e.from] || 0) + 1;
    degree[e.to] = (degree[e.to] || 0) + 1;
  }
  const nodes = notes.map((n) => ({ id: n.id, title: n.title, degree: degree[n.id] || 0 }));
  return { nodes, edges, backlinks, unresolved };
}
`;

// ---------------------------------------------------------------------------
// Helpers for building test modules
// ---------------------------------------------------------------------------

function stripEngineImport(routerCode: string): string {
  return routerCode
    .split("\n")
    .filter((line) => !line.includes("@/engines/"))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("apiGenerator — deterministic Express router and typed client generator", () => {

  describe("extractParamNames", () => {
    it("extracts param names from simple function signature", () => {
      assert.deepEqual(extractParamNames("(card: CardState, grade: number, now: number) => CardState"), ["card", "grade", "now"]);
    });
    it("extracts param names from single param", () => {
      assert.deepEqual(extractParamNames("(markdown: string) => WikiLink[]"), ["markdown"]);
    });
    it("returns empty for no params", () => {
      assert.deepEqual(extractParamNames("() => void"), []);
    });
    it("handles generic types in params", () => {
      assert.deepEqual(extractParamNames("(items: Array<string>) => number"), ["items"]);
    });
  });

  describe("typeToZod", () => {
    it("maps primitives to Zod", () => {
      assert.equal(typeToZod("string", ""), "z.string()");
      assert.equal(typeToZod("number", ""), "z.number()");
      assert.equal(typeToZod("boolean", ""), "z.boolean()");
    });
    it("maps arrays to Zod", () => {
      assert.equal(typeToZod("string[]", ""), "z.array(z.string())");
    });
    it("falls back to unknown for interface types", () => {
      assert.equal(typeToZod("CardState", "export interface CardState {}"), "z.unknown() as unknown as CardState");
    });
    it("handles optional marker", () => {
      assert.equal(typeToZod("number?", ""), "z.number()");
    });
  });

  describe("generateExpressRouter — recall.sm2_scheduler", () => {
    it("generates a router module string for the spec", () => {
      const code = generateExpressRouter(recallSpec, "@/engines/sm2Scheduler");
      assert.ok(code.includes("import { Router, type Request, type Response } from \"express\""));
      assert.ok(code.includes("import { z } from \"zod\""));
      assert.ok(code.includes("import { scheduleReview, updateEase } from \"@/engines/sm2Scheduler\""));
      assert.ok(code.includes('router.post("/api/recall.sm2_scheduler/scheduleReview"'));
      assert.ok(code.includes('router.post("/api/recall.sm2_scheduler/updateEase"'));
      assert.ok(code.includes("export default router;"));
    });

    it("mounts the generated router on an Express app and handles valid requests", async () => {
      const routerCode = generateExpressRouter(recallSpec, "@/engines/sm2Scheduler");
      const importsRemoved = stripEngineImport(routerCode);

      const combinedModule = SM2_ENGINE + "\n" + importsRemoved;

      const tmpDir = path.join(__dirname, "_test_router");
      fs.mkdirSync(tmpDir, { recursive: true });
      const modulePath = path.join(tmpDir, "sm2Router.ts");
      fs.writeFileSync(modulePath, combinedModule, "utf-8");

      try {
        const esbuild = await import("esbuild");
        await esbuild.build({
          entryPoints: [modulePath],
          bundle: true,
          outfile: path.join(tmpDir, "sm2Router.js"),
          format: "esm",
          platform: "node",
          target: "node18",
          external: ["express", "zod"],
        });

        const mod = await import(path.join(tmpDir, "sm2Router.js"));
        const router = mod.default;
        const testApp = express();
        testApp.use(express.json());
        testApp.use(router);
        const testServer = testApp.listen(0, "127.0.0.1");
        await new Promise<void>((resolve) => testServer.once("listening", resolve));
        const addr = testServer.address() as any;
        const testBaseUrl = `http://127.0.0.1:${addr.port}`;

        try {
          // Test scheduleReview endpoint
          const res1 = await fetch(`${testBaseUrl}/api/recall.sm2_scheduler/scheduleReview`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              card: { reps: 0, interval: 0, ease: 2.5, lapses: 0 },
              grade: 5,
              now: 1730000000000,
            }),
          });
          assert.equal(res1.status, 200);
          const body1 = (await res1.json()) as any;
          assert.equal(body1.ok, true);
          assert.equal(body1.result.reps, 1);
          assert.equal(body1.result.interval, 1);
          assert.equal(body1.result.ease, 2.6);

          // Test second review
          const res2 = await fetch(`${testBaseUrl}/api/recall.sm2_scheduler/scheduleReview`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              card: { reps: 1, interval: 1, ease: 2.6, lapses: 0 },
              grade: 4,
              now: 1730000000000,
            }),
          });
          assert.equal(res2.status, 200);
          const body2 = (await res2.json()) as any;
          assert.equal(body2.ok, true);
          assert.equal(body2.result.reps, 2);
          assert.equal(body2.result.interval, 6);

          // Test updateEase endpoint
          const res3 = await fetch(`${testBaseUrl}/api/recall.sm2_scheduler/updateEase`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ease: 2.5, grade: 5 }),
          });
          assert.equal(res3.status, 200);
          const body3 = (await res3.json()) as any;
          assert.equal(body3.ok, true);
          assert.ok(Math.abs(body3.result - 2.6) < 0.001, "updateEase(2.5, 5) should be approximately 2.6");

          // Test invalid grade -> 400
          const res4 = await fetch(`${testBaseUrl}/api/recall.sm2_scheduler/updateEase`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ease: 2.5, grade: 6 }),
          });
          assert.equal(res4.status, 400);
          const errBody = (await res4.json()) as any;
          assert.equal(errBody.error, "Validation failed");

          // Test missing field -> 400
          const res5 = await fetch(`${testBaseUrl}/api/recall.sm2_scheduler/scheduleReview`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ card: { reps: 0 } }),
          });
          assert.equal(res5.status, 400);
        } finally {
          await new Promise<void>((resolve) => testServer.close(() => resolve()));
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("generates a typed client for the spec", () => {
      const clientCode = generateApiClient(recallSpec);
      assert.ok(clientCode.includes("export const apiClient = {"));
      assert.ok(clientCode.includes('"recall.sm2_scheduler": {'));
      assert.ok(clientCode.includes("scheduleReview: async"));
      assert.ok(clientCode.includes("updateEase: async"));
      assert.ok(clientCode.includes("export type ApiClient = typeof apiClient;"));
      assert.ok(clientCode.includes("Promise<CardState>"));
    });
  });

  describe("generateExpressRouter — inkwell.wikilink_graph", () => {
    it("generates a router module string for the spec", () => {
      const code = generateExpressRouter(inkwellSpec, "@/engines/wikilinkGraph");
      assert.ok(code.includes('router.post("/api/inkwell.wikilink_graph/parseWikiLinks"'));
      assert.ok(code.includes('router.post("/api/inkwell.wikilink_graph/normalizeTitle"'));
      assert.ok(code.includes('router.post("/api/inkwell.wikilink_graph/buildLinkGraph"'));
      assert.ok(code.includes("parseWikiLinks"));
      assert.ok(code.includes("normalizeTitle"));
      assert.ok(code.includes("buildLinkGraph"));
    });

    it("mounts the generated router and handles valid requests", async () => {
      const routerCode = generateExpressRouter(inkwellSpec, "@/engines/wikilinkGraph");
      const importsRemoved = stripEngineImport(routerCode);

      const combinedModule = WIKI_ENGINE + "\n" + importsRemoved;

      const tmpDir = path.join(__dirname, "_test_wiki");
      fs.mkdirSync(tmpDir, { recursive: true });
      const modulePath = path.join(tmpDir, "wikiRouter.ts");
      fs.writeFileSync(modulePath, combinedModule, "utf-8");

      try {
        const esbuild = await import("esbuild");
        await esbuild.build({
          entryPoints: [modulePath],
          bundle: true,
          outfile: path.join(tmpDir, "wikiRouter.js"),
          format: "esm",
          platform: "node",
          target: "node18",
          external: ["express", "zod"],
        });

        const mod = await import(path.join(tmpDir, "wikiRouter.js"));
        const router = mod.default;
        const testApp = express();
        testApp.use(express.json());
        testApp.use(router);
        const testServer = testApp.listen(0, "127.0.0.1");
        await new Promise<void>((resolve) => testServer.once("listening", resolve));
        const addr = testServer.address() as any;
        const testBaseUrl = `http://127.0.0.1:${addr.port}`;

        try {
          // Test parseWikiLinks
          const res1 = await fetch(`${testBaseUrl}/api/inkwell.wikilink_graph/parseWikiLinks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ markdown: "Read [[Architecture]] or [[Guide|the guide]]" }),
          });
          assert.equal(res1.status, 200);
          const body1 = (await res1.json()) as any;
          assert.equal(body1.ok, true);
          assert.equal(body1.result.length, 2);
          assert.equal(body1.result[0].target, "Architecture");
          assert.equal(body1.result[1].target, "Guide");
          assert.equal(body1.result[1].alias, "the guide");

          // Test normalizeTitle
          const res2 = await fetch(`${testBaseUrl}/api/inkwell.wikilink_graph/normalizeTitle`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "  My   Note  " }),
          });
          assert.equal(res2.status, 200);
          const body2 = (await res2.json()) as any;
          assert.equal(body2.ok, true);
          assert.equal(body2.result, "my note");

          // Test buildLinkGraph
          const res3 = await fetch(`${testBaseUrl}/api/inkwell.wikilink_graph/buildLinkGraph`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              notes: [
                { id: "1", title: "Index", body: "Links to [[Guide]]" },
                { id: "2", title: "Guide", body: "Back to [[Index]]" },
              ],
            }),
          });
          assert.equal(res3.status, 200);
          const body3 = (await res3.json()) as any;
          assert.equal(body3.ok, true);
          assert.equal(body3.result.nodes.length, 2);
          assert.equal(body3.result.edges.length, 2);
          assert.deepEqual(body3.result.backlinks["1"], ["2"]);
          assert.deepEqual(body3.result.backlinks["2"], ["1"]);

          // Test code blocks are ignored by parseWikiLinks
          const res4 = await fetch(`${testBaseUrl}/api/inkwell.wikilink_graph/parseWikiLinks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ markdown: "`[[Hidden]]` and ```[[AlsoHidden]]```" }),
          });
          assert.equal(res4.status, 200);
          const body4 = (await res4.json()) as any;
          assert.equal(body4.ok, true);
          assert.equal(body4.result.length, 0);
        } finally {
          await new Promise<void>((resolve) => testServer.close(() => resolve()));
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("generates a typed client for the spec", () => {
      const clientCode = generateApiClient(inkwellSpec);
      assert.ok(clientCode.includes('"inkwell.wikilink_graph": {'));
      assert.ok(clientCode.includes("parseWikiLinks: async"));
      assert.ok(clientCode.includes("normalizeTitle: async"));
      assert.ok(clientCode.includes("buildLinkGraph: async"));
      assert.ok(clientCode.includes("Promise<WikiLink[]>"));
      assert.ok(clientCode.includes("Promise<string>"));
      assert.ok(clientCode.includes("Promise<GraphResult>"));
    });
  });

  describe("generateApiClient — error handling", () => {
    it("includes proper error handling in generated client methods", () => {
      const clientCode = generateApiClient(recallSpec);
      assert.ok(clientCode.includes('throw new Error(err.error'));
      assert.ok(clientCode.includes('throw new Error(body.error'));
    });
  });

  describe("Round-trip: client code matches router expectations", () => {
    it("client method signatures match router route parameters for recall.sm2_scheduler", () => {
      const routerCode = generateExpressRouter(recallSpec, "@/engines/sm2Scheduler");
      const clientCode = generateApiClient(recallSpec);

      assert.ok(routerCode.includes("/api/recall.sm2_scheduler/scheduleReview"));
      assert.ok(clientCode.includes("/api/recall.sm2_scheduler/scheduleReview"));
      assert.ok(routerCode.includes("/api/recall.sm2_scheduler/updateEase"));
      assert.ok(clientCode.includes("/api/recall.sm2_scheduler/updateEase"));
    });

    it("client method signatures match router route parameters for inkwell.wikilink_graph", () => {
      const routerCode = generateExpressRouter(inkwellSpec, "@/engines/wikilinkGraph");
      const clientCode = generateApiClient(inkwellSpec);

      assert.ok(routerCode.includes("/api/inkwell.wikilink_graph/parseWikiLinks"));
      assert.ok(clientCode.includes("/api/inkwell.wikilink_graph/parseWikiLinks"));
      assert.ok(routerCode.includes("/api/inkwell.wikilink_graph/normalizeTitle"));
      assert.ok(clientCode.includes("/api/inkwell.wikilink_graph/normalizeTitle"));
      assert.ok(routerCode.includes("/api/inkwell.wikilink_graph/buildLinkGraph"));
      assert.ok(clientCode.includes("/api/inkwell.wikilink_graph/buildLinkGraph"));
    });
  });
});
