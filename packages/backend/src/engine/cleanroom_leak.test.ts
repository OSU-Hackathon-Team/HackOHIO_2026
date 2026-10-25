// Regression test to ensure clean‑room implementation prompt never contains raw source snippets
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { formatSpecForImplementer } from "./prompt.js";
import type { FeatureSpec } from "@splice/contracts";
import { makeSpec } from "./testFixtures.js"; // helper to create a valid spec

// Extend a spec with a fabricated source snippet that would be sensitive if leaked
function specWithSnippet(): FeatureSpec {
  const base = makeSpec();
  // Insert a snippet of source code that should never be emitted to the LLM
  const sensitiveSnippet = {
    location: "app.asar:src/sensitive/secret.js",
    symbol: "secretFunction",
    language: "javascript" as const,
    code: "function secretFunction() { return 'TOP‑SECRET'; }",
    full_module: true,
  };
  // @ts-ignore – we purposely mutate for the test
  base.provenance.snippets = [...base.provenance.snippets, sensitiveSnippet];
  return base;
}

describe("Clean‑room prompt sanity", () => {
  test("formatSpecForImplementer does not embed raw source snippets", () => {
    const spec = specWithSnippet();
    const prompt = formatSpecForImplementer(spec);
    // The raw snippet code must not appear anywhere in the prompt text
    assert.ok(!prompt.includes("function secretFunction"), "source snippet leaked into prompt");
    // Also ensure the snippet path is not emitted (only allowed via location reference in source_refs elsewhere)
    assert.ok(!prompt.includes("secret.js"), "snippet location leaked into prompt");
  });
});
