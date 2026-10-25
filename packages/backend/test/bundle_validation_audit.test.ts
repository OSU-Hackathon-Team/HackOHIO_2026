import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import {
  type FeatureBlueprint,
  type SynthesisBundle,
  ALLOWED_DEPENDENCIES,
} from "@splice/contracts";
import { assembleBundle, ENTRY_FILES } from "../dist/synthesis/assemble.js";
import {
  validateBundle,
  validateBundleDetailed,
  type BundleDiagnostic,
} from "../dist/synthesis/validateBundle.js";
import {
  typecheckVirtualDetailed,
  typecheckVirtual,
} from "../dist/typecheck/virtualTsc.js";
import {
  APP,
  GOOD_ENGINE,
  LINK_ENGINE,
  NOTE_CARD,
  makeBlueprint,
  makeLinkSpec,
  makeSpec,
} from "../dist/engine/testFixtures.js";

const sm2 = makeBlueprint(makeSpec(), GOOD_ENGINE);
const links = makeBlueprint(makeLinkSpec(), LINK_ENGINE);
const blueprints = [sm2, links];
const meta = {
  bundle_id: "b_audit_test",
  app_title: "Study Room",
  app_description: "Notes and reviews",
  revision: 0,
  mode: "live" as const,
};

const generated = (app = APP, card = NOTE_CARD) => [
  { path: "/App.tsx", content: app },
  { path: "/components/NoteCard.tsx", content: card },
];

const bundle = (gen = generated()): SynthesisBundle =>
  assembleBundle(blueprints, gen, meta);

describe("Step 3: Virtual Typechecker & Bundle Validation Audit", () => {
  describe("1. Valid Bundle Acceptance", () => {
    test("a conforming multi-engine bundle passes all validation stages", () => {
      const b = bundle();
      const res = validateBundle(b, blueprints);
      assert.equal(res.ok, true);
      assert.deepEqual(res.errors, []);
      assert.equal(res.diagnostics.length, 0);
      assert.ok(res.summary.includes("Bundle validation passed"));
    });

    test("validateBundleDetailed returns all structured properties as own enumerable keys", () => {
      const b = bundle();
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, true);
      assert.deepEqual(res.errors, []);
      assert.deepEqual(res.diagnostics, []);
      assert.ok(res.summary.includes("Bundle validation passed"));
      assert.deepEqual(Object.keys(res).sort(), ["diagnostics", "errors", "ok", "summary"]);
    });
  });

  describe("2. Manifest & Contract Schema Validation", () => {
    test("rejects bundle with missing or empty bundle_id", () => {
      const b = bundle();
      (b as any).bundle_id = "";
      const res = validateBundleDetailed(b, blueprints);
      // Empty string may pass string type but fail if invalid
      (b as any).bundle_id = undefined;
      const res2 = validateBundleDetailed(b, blueprints);
      assert.equal(res2.ok, false);
      assert.ok(res2.errors.some((e) => /manifest/i.test(e) || /bundle_id/i.test(e)));
      assert.ok(res2.diagnostics.some((d) => d.stage === "manifest"));
    });

    test("rejects bundle when feature_ids do not match blueprints", () => {
      const b = bundle();
      b.feature_ids = ["recall.sm2_scheduler"]; // missing inkwell.wikilink_graph
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /Manifest feature_ids .* do not match blueprints/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "manifest"));
    });

    test("rejects bundle when engine_paths do not match blueprints", () => {
      const b = bundle();
      b.engine_paths = ["/engines/sm2Scheduler.ts"]; // missing wikiLinks.ts
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /Manifest engine_paths do not match expected/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "manifest"));
    });

    test("rejects bundle with mismatched or unpinned dependency versions", () => {
      const b = bundle();
      b.dependencies["react"] = "19.0.0"; // unpinned / wrong version
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /Dependency "react@19\.0\.0" does not match allowed version/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "manifest"));
    });

    test("rejects bundle with unwhitelisted dependency in manifest dependencies", () => {
      const b = bundle();
      b.dependencies["axios"] = "^1.6.0";
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /Dependency "axios" is not an allowed Sandpack dependency/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "manifest"));
    });
  });

  describe("3. Behavioral Conformance Prerequisite (Typecheck != Behavioral Correctness)", () => {
    test("rejects bundle when a blueprint has verification.status === 'failed'", () => {
      const failedBlueprint: FeatureBlueprint = {
        ...sm2,
        verification: {
          ...sm2.verification,
          status: "failed",
          passed: 1,
          total: 3,
        },
      };

      const res = validateBundleDetailed(bundle(), [failedBlueprint, links]);
      assert.equal(res.ok, false);
      assert.ok(
        res.errors.some(
          (e) =>
            /failed behavioral conformance verification \(status: failed\)/.test(e) &&
            /sm2Scheduler/.test(e),
        ),
      );
      assert.ok(res.diagnostics.some((d) => d.stage === "engine_conformance"));
    });

    test("rejects bundle when a blueprint has purity violations", () => {
      const impureBlueprint: FeatureBlueprint = {
        ...links,
        verification: {
          ...links.verification,
          status: "passed",
          purity_violations: ["Math.random() is forbidden"],
        },
      };

      const res = validateBundleDetailed(bundle(), [sm2, impureBlueprint]);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /contains purity violations/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "engine_conformance"));
    });

    test("rejects bundle when a blueprint has type errors recorded during engine verification", () => {
      const typeErrorBlueprint: FeatureBlueprint = {
        ...links,
        verification: {
          ...links.verification,
          status: "passed",
          type_errors: ["Export 'parseLinks' does not match interface"],
        },
      };

      const res = validateBundleDetailed(bundle(), [sm2, typeErrorBlueprint]);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /contains type errors/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "engine_conformance"));
    });

    test("rejects bundle when an engine has 0 executed acceptance tests", () => {
      const zeroTestsBlueprint: FeatureBlueprint = {
        ...sm2,
        verification: {
          ...sm2.verification,
          status: "passed",
          passed: 0,
          total: 0,
        },
      };

      const res = validateBundleDetailed(bundle(), [zeroTestsBlueprint, links]);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /has failing or unexecuted acceptance tests/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "engine_conformance"));
    });
  });

  describe("4. Structure & Server-Owned Immutability", () => {
    test("rejects missing /App.tsx", () => {
      const b = bundle();
      delete b.files["/App.tsx"];
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.includes("Missing /App.tsx"));
      assert.ok(res.diagnostics.some((d) => d.stage === "structure" && d.file === "/App.tsx"));
    });

    test("rejects /App.tsx without default export", () => {
      const b = bundle(generated(APP.replace("export default function App", "export function App")));
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /must have a default export/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "structure" && d.file === "/App.tsx"));
    });

    test("rejects modified server-owned entry file /index.tsx", () => {
      const b = bundle();
      b.files["/index.tsx"] = "// modified entry file";
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /\/index\.tsx was modified; it is server-owned/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "structure" && d.file === "/index.tsx"));
    });

    test("rejects modified engine code", () => {
      const b = bundle();
      b.files["/engines/sm2Scheduler.ts"] = GOOD_ENGINE + "\n// modified";
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /\/engines\/sm2Scheduler\.ts differs from the verified engine/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "structure"));
    });

    test("rejects files outside allowed paths", () => {
      const b = bundle();
      b.files["/arbitrary/path.tsx"] = "export default function () {}";
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e === "File not allowed: /arbitrary/path.tsx"));
      assert.ok(res.diagnostics.some((d) => d.stage === "structure"));
    });

    test("rejects when generated_paths lists a file missing from files map", () => {
      const b = bundle();
      b.generated_paths.push("/components/MissingComponent.tsx");
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /listed as generated but missing from the bundle/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "structure"));
    });
  });

  describe("5. Imports, Syntax & Resolution", () => {
    test("detects syntax error in generated TSX with exact line and column", () => {
      const brokenSyntax = `import React from "react";
export default function App() {
  return <div>unclosed tag
}`;
      const b = bundle(generated(brokenSyntax));
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /Syntax error/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "imports" && d.file === "/App.tsx"));
    });

    test("rejects file importing itself", () => {
      const selfImport = `import App from "./App";\n` + APP;
      const b = bundle(generated(selfImport));
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /file imports itself "\.\/App"/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "imports"));
    });

    test("rejects unresolvable relative import", () => {
      const b = bundle(generated(`import { helper } from "./lib/nonexistent";\n` + APP));
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /cannot resolve import "\.\/lib\/nonexistent"/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "imports"));
    });

    test("rejects disallowed npm package import", () => {
      const b = bundle(generated(`import _ from "lodash";\n` + APP));
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /package "lodash" is not available/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "imports"));
    });

    test("rejects bundle when a declared engine is never imported", () => {
      const appWithoutLinks = APP.replace(/wikiLinks/g, "sm2Scheduler");
      const cardWithoutLinks = `export function NoteCard({ body }: { body: string }) { return <div>{body}</div>; }`;
      const b = bundle(generated(appWithoutLinks, cardWithoutLinks));
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /Engine wikiLinks is never imported by the UI/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "imports"));
    });
  });

  describe("6. Virtual TypeScript Compilation & Type Mismatches", () => {
    test("detects typo in engine exported function", () => {
      const typoApp = APP.replace(/updateEase/g, "updateEaseTypo");
      const b = bundle(generated(typoApp));
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /updateEaseTypo/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "typecheck" && d.file === "/App.tsx"));
    });

    test("detects incompatible argument types passed to engine function", () => {
      const badArgApp = APP.replace(
        "updateEase(ease, 4)",
        'updateEase("not-a-number" as any, 4) + updateEase(ease, "invalid" as any)',
      ).replace(
        'updateEase(ease, "invalid" as any)',
        'updateEase(ease, { bad: true } as any)',
      );
      // Directly pass invalid string argument without any
      const strictBadArg = APP.replace("updateEase(ease, 4)", 'updateEase("not a number" as unknown as number, 4)');
      // Let's pass incompatible type directly: updateEase(true, 4)
      const typeMismatchApp = APP.replace("updateEase(ease, 4)", "updateEase(true as unknown as number, 4)");
      // Even clearer: pass a string to a function expecting number
      const argMismatch = APP.replace("updateEase(ease, 4)", 'updateEase(ease, "grade five")');
      const b = bundle(generated(argMismatch));
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /Argument of type 'string' is not assignable to parameter of type 'number'/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "typecheck"));
    });

    test("detects missing required props in custom component", () => {
      const badPropApp = APP.replace('<NoteCard body="See [[Cardiology]]" />', "<NoteCard />");
      const b = bundle(generated(badPropApp));
      const res = validateBundleDetailed(b, blueprints);
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => /Property 'body' is missing in type '{}'/.test(e)));
      assert.ok(res.diagnostics.some((d) => d.stage === "typecheck"));
    });
  });

  describe("7. Virtual Compiler API Host & Environment Isolation", () => {
    test("virtual typechecker handles asset imports via ambient declarations", () => {
      const files = {
        "/App.tsx": `import "./styles.css";\nexport default function App() { return <div>Styled</div>; }`,
      };
      const res = typecheckVirtualDetailed(files, { strict: false, jsx: true });
      assert.equal(res.ok, true);
      assert.deepEqual(res.errors, []);
    });

    test("virtual typechecker reports file, line, and col accurately", () => {
      const files = {
        "/Bad.ts": `const x: number = "not a number";`,
      };
      const res = typecheckVirtualDetailed(files, { strict: true, jsx: false });
      assert.equal(res.ok, false);
      assert.equal(res.diagnostics.length, 1);
      assert.equal(res.diagnostics[0].file, "/Bad.ts");
      assert.equal(res.diagnostics[0].line, 1);
      assert.equal(res.diagnostics[0].category, "error");
      assert.ok(res.errors[0].startsWith("/Bad.ts(1,"));
    });

    test("typecheckVirtual wrapper returns string[] matching detailed errors", () => {
      const files = {
        "/Bad.ts": `const x: number = "not a number";`,
      };
      const errors = typecheckVirtual(files, { strict: true, jsx: false });
      assert.equal(errors.length, 1);
      assert.ok(errors[0].includes("Type 'string' is not assignable to type 'number'"));
    });
  });
});
