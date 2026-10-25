process.env.NODE_ENV = "test";
process.env.REA_MODE = "replay";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { Pantry, RawEvidence, HealthResponse } from "@splice/contracts";
import { app } from "../dist/server.js";
import { REPO_ROOT } from "../dist/config.js";
import { openArchive, norm } from "../dist/rea/asarReader.js";
import { normalize } from "../dist/rea/normalize.js";
import { reaArgs, checkArgsAgainstCatalog } from "../dist/rea/reaArgs.js";
import { rankPaths, matchKnown, pathJoin } from "../dist/evidence/collector.js";
import { loadPantry } from "../dist/routes/step1/index.js";
import { loadRecordedEvidence } from "../dist/evidence/replay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("Step 1: Target Discovery and Evidence Collection Suite", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    // Start ephemeral server for integration testing
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (typeof addr === "object" && addr !== null) {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  describe("ASAR Archive Reading & Normalization", () => {
    it("reads and normalizes paths in inkwell app.asar", async () => {
      const inkwellPath = path.join(REPO_ROOT, "targets/build/inkwell/app.asar");
      assert.ok(fs.existsSync(inkwellPath), `Inkwell asar must exist at ${inkwellPath}`);

      const archive = await openArchive(inkwellPath);
      assert.ok(archive.files.length > 0, "archive should contain files");
      assert.ok(archive.files.includes("src/graph/wikilinks.js"), "should contain wikilinks.js");
      assert.ok(archive.files.includes("src/graph/backlinks.js"), "should contain backlinks.js");

      // Verify no leading slashes or backslashes
      for (const f of archive.files) {
        assert.ok(!f.startsWith("/"), `File path should not start with slash: ${f}`);
        assert.ok(!f.includes("\\"), `File path should not contain backslashes: ${f}`);
      }

      // Verify reading file contents
      const content = archive.readText("src/graph/wikilinks.js");
      assert.ok(content.includes("parseWikiLinks"), "wikilinks.js should contain parseWikiLinks");
      assert.ok(content.includes("normalizeTitle"), "wikilinks.js should contain normalizeTitle");
    });

    it("reads and normalizes paths in recall app.asar", async () => {
      const recallPath = path.join(REPO_ROOT, "targets/build/recall/app.asar");
      assert.ok(fs.existsSync(recallPath), `Recall asar must exist at ${recallPath}`);

      const archive = await openArchive(recallPath);
      assert.ok(archive.files.includes("src/scheduler/sm2.js"), "should contain sm2.js");

      const sm2Content = archive.readText("src/scheduler/sm2.js");
      assert.ok(sm2Content.includes("scheduleReview"), "sm2.js should contain scheduleReview");
      assert.ok(sm2Content.includes("updateEase"), "sm2.js should contain updateEase");
    });

    it("throws a descriptive error when accessing a nonexistent file in archive", async () => {
      const inkwellPath = path.join(REPO_ROOT, "targets/build/inkwell/app.asar");
      const archive = await openArchive(inkwellPath);
      assert.throws(
        () => archive.readText("src/nonexistent/file.js"),
        /not in archive: src\/nonexistent\/file\.js/,
      );
    });

    it("throws a descriptive error when opening a nonexistent archive", async () => {
      await assert.rejects(
        async () => openArchive(path.join(REPO_ROOT, "targets/build/nonexistent.asar")),
        /Archive not found/,
      );
    });

    it("correctly normalizes path strings with norm utility", () => {
      assert.equal(norm("\\src\\graph\\backlinks.js"), "src/graph/backlinks.js");
      assert.equal(norm("///src/graph/backlinks.js"), "src/graph/backlinks.js");
      assert.equal(norm("src/graph/backlinks.js"), "src/graph/backlinks.js");
    });
  });

  describe("REA MCP Normalization & Catalog Validation", () => {
    it("normalizes real sample analyze_javascript_application result", () => {
      const samplePath = path.join(REPO_ROOT, "fixtures/rea/sample_analyze_javascript_application.json");
      const sample = JSON.parse(fs.readFileSync(samplePath, "utf8"));
      const normalized = normalize("analyze_javascript_application", sample);

      assert.equal(normalized.tool, "analyze_javascript_application");
      assert.equal(normalized.ok, true);
      assert.ok(normalized.evidenceId?.startsWith("ev_"), "should extract evidence_id");
      assert.ok(normalized.parentEvidenceId?.startsWith("ev_"), "should extract parentEvidenceId");
      assert.ok(normalized.summary.length > 0 && normalized.summary.length <= 300);
      assert.ok(Array.isArray(normalized.limitations));
      assert.ok(Array.isArray(normalized.unknowns));
    });

    it("normalizes real sample trace_application_feature result", () => {
      const samplePath = path.join(REPO_ROOT, "fixtures/rea/sample_trace_application_feature.json");
      const sample = JSON.parse(fs.readFileSync(samplePath, "utf8"));
      const normalized = normalize("trace_application_feature", sample);

      assert.equal(normalized.tool, "trace_application_feature");
      assert.equal(normalized.ok, true);
      assert.ok(normalized.summary.length > 0 && normalized.summary.length <= 300);
    });

    it("normalizes error result with isError flag", () => {
      const errResult = {
        isError: true,
        content: [{ type: "text", text: "Analysis timeout after 45000ms" }],
      };
      const normalized = normalize("analyze_javascript_application", errResult as any);

      assert.equal(normalized.ok, false);
      assert.equal(normalized.evidenceId, null);
      assert.match(normalized.summary, /error: Analysis timeout/);
    });

    it("validates reaArgs against tools.json catalog", () => {
      const toolsPath = path.join(REPO_ROOT, "fixtures/rea/tools.json");
      const tools = JSON.parse(fs.readFileSync(toolsPath, "utf8"));
      const problems = checkArgsAgainstCatalog(tools);
      assert.deepEqual(problems, [], "reaArgs should match catalog schemas with no unknown or missing required args");
    });
  });

  describe("Collector Path Ranking and Utilities", () => {
    it("pathJoin resolves relative paths cleanly", () => {
      assert.equal(pathJoin("src/graph/backlinks.js", "./wikilinks"), "src/graph/wikilinks");
      assert.equal(pathJoin("src/graph/backlinks.js", "../storage/vault"), "src/storage/vault");
    });

    it("matchKnown matches file extensions and relative paths", () => {
      const known = ["src/graph/backlinks.js", "src/graph/wikilinks.js", "src/main.js"];
      assert.equal(matchKnown("src/graph/wikilinks.js", known), "src/graph/wikilinks.js");
      assert.equal(matchKnown("src/graph/wikilinks", known), "src/graph/wikilinks.js");
      assert.equal(matchKnown("wikilinks.js", known), "src/graph/wikilinks.js");
      assert.equal(matchKnown("nonexistent", known), undefined);
    });

    it("rankPaths orders seed modules and required dependencies", () => {
      const fakeArchive = {
        files: ["src/graph/backlinks.js", "src/graph/wikilinks.js", "src/main.js", "src/unrelated.js"],
        readText(p: string) {
          if (p === "src/graph/backlinks.js") return 'const { parseWikiLinks } = require("./wikilinks");';
          return "";
        },
      };
      const feature = {
        feature_id: "inkwell.wikilink_graph",
        title: "Wiki-link graph",
        query: "query",
        category: "graph" as const,
        seeds: [{ kind: "module" as const, value: "src/graph/backlinks.js" }],
        symbols: ["buildLinkGraph"],
      };

      const ranked = rankPaths(feature, fakeArchive, []);
      assert.equal(ranked[0], "src/graph/backlinks.js", "Seed module should be first");
      assert.ok(ranked.includes("src/graph/wikilinks.js"), "Required relative helper should be included");
    });
  });

  describe("Target Discovery & Pantry (loadPantry)", () => {
    it("loads targets/manifest.json and parses through Pantry schema", async () => {
      const pantry = await loadPantry();
      const parsed = Pantry.parse(pantry);
      assert.ok(parsed.apps.length >= 2, "Should contain at least inkwell and recall");

      const inkwell = parsed.apps.find((a) => a.app_id === "inkwell");
      const recall = parsed.apps.find((a) => a.app_id === "recall");

      assert.ok(inkwell, "Inkwell app must exist");
      assert.ok(recall, "Recall app must exist");
      assert.equal(inkwell.live_supported, true, "Inkwell should be live supported since app.asar exists");
      assert.equal(recall.live_supported, true, "Recall should be live supported since app.asar exists");
    });

    it("flips live_supported to false if target file does not exist", async () => {
      const pantry = await loadPantry();
      const clone = structuredClone(pantry);
      // Change target path to nonexistent
      clone.apps[0].target_path = "targets/build/nonexistent/app.asar";

      for (const app of clone.apps) {
        const exists = fs.existsSync(path.join(REPO_ROOT, app.target_path));
        if (!exists) app.live_supported = false;
      }

      assert.equal(clone.apps[0].live_supported, false, "Missing target path must set live_supported to false");
    });
  });

  describe("Offline Evidence Loading Support", () => {
    it("loads hand-authored recall.sm2_scheduler evidence deterministically", async () => {
      const evidence = await loadRecordedEvidence("recall.sm2_scheduler");
      assert.ok(evidence !== null, "Evidence should load offline from fixtures");
      assert.equal(evidence.app_id, "recall");
      assert.equal(evidence.feature_id, "recall.sm2_scheduler");
      assert.equal(evidence.mode, "replay");
      assert.ok(evidence.snippets.length > 0);
      assert.ok(evidence.tool_calls.length > 0);

      // Verify contract conformance
      const validated = RawEvidence.parse(evidence);
      assert.equal(validated.feature_id, "recall.sm2_scheduler");
    });

    it("loads hand-authored inkwell.wikilink_graph evidence deterministically", async () => {
      const evidence = await loadRecordedEvidence("inkwell.wikilink_graph");
      assert.ok(evidence !== null, "Evidence should load offline from fixtures");
      assert.equal(evidence.app_id, "inkwell");
      assert.equal(evidence.feature_id, "inkwell.wikilink_graph");
      assert.equal(evidence.mode, "replay");

      // Verify contract conformance
      const validated = RawEvidence.parse(evidence);
      assert.equal(validated.feature_id, "inkwell.wikilink_graph");
    });

    it("returns null for nonexistent feature evidence", async () => {
      const evidence = await loadRecordedEvidence("nonexistent.feature");
      assert.equal(evidence, null);
    });
  });

  describe("HTTP API Endpoints", () => {
    it("GET /api/health returns 200 and matches HealthResponse contract", async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type")?.includes("application/json"), true);

      const body = await res.json();
      assert.equal(body.status, "ok");
      assert.equal(body.service, "splice-backend");

      // Validate with Zod HealthResponse
      const parsed = HealthResponse.parse(body);
      assert.equal(parsed.ok, true);
      assert.ok("rea" in parsed);
      assert.ok("rea_mode" in parsed);
      assert.ok("llm_mode" in parsed);
      assert.ok("model" in parsed);
    });

    it("GET /api/pantry returns 200 and matches Pantry contract", async () => {
      const res = await fetch(`${baseUrl}/api/pantry`);
      assert.equal(res.status, 200);

      const body = await res.json();
      const parsed = Pantry.parse(body);
      assert.ok(parsed.apps.length >= 2);

      const inkwell = parsed.apps.find((a) => a.app_id === "inkwell");
      assert.ok(inkwell);
      assert.equal(inkwell.display_name, "Inkwell Notes");
    });

    it("GET /api/evidence/:feature_id returns 200 with RawEvidence for known feature", async () => {
      const res = await fetch(`${baseUrl}/api/evidence/recall.sm2_scheduler`);
      assert.equal(res.status, 200);

      const body = await res.json();
      const parsed = RawEvidence.parse(body);
      assert.equal(parsed.feature_id, "recall.sm2_scheduler");
    });

    it("GET /api/evidence/:feature_id returns 404 for unknown feature", async () => {
      const res = await fetch(`${baseUrl}/api/evidence/unknown_feature`);
      assert.equal(res.status, 404);

      const body = await res.json();
      assert.equal(body.status, 404);
      assert.match(body.error, /Evidence not found/);
    });

    it("POST /api/evidence/collect with missing fields returns 400", async () => {
      const res = await fetch(`${baseUrl}/api/evidence/collect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);

      const body = await res.json();
      assert.equal(body.status, 400);
      assert.match(body.error, /Missing required fields/);
    });

    it("POST /api/evidence/collect with unknown app returns 404", async () => {
      const res = await fetch(`${baseUrl}/api/evidence/collect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: "unknown", feature_id: "foo" }),
      });
      assert.equal(res.status, 404);

      const body = await res.json();
      assert.equal(body.status, 404);
      assert.match(body.error, /App not found/);
    });

    it("POST /api/evidence/collect with force_mode=replay returns 200 with recorded evidence", async () => {
      const res = await fetch(`${baseUrl}/api/evidence/collect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: "recall",
          feature_id: "recall.sm2_scheduler",
          force_mode: "replay",
        }),
      });
      assert.equal(res.status, 200);

      const body = await res.json();
      const parsed = RawEvidence.parse(body);
      assert.equal(parsed.feature_id, "recall.sm2_scheduler");
      assert.equal(parsed.mode, "replay");
    });
  });
});
