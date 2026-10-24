import test from "node:test";
import assert from "node:assert/strict";
import { SynthesisBundle } from "@splice/contracts";
import { serializeProjectArchive, exportProjectBundle } from "../src/lib/exportZip";

test("exportProjectBundle serializes runnable Vite+TS archive with provenance and locked engines", () => {
  const dummyBundle: SynthesisBundle = {
    bundle_id: "bundle_test123",
    revision: 1,
    app_title: "MedStudy Workspace",
    app_description: "Study room application with backlinks and flashcards",
    mode: "live",
    dependencies: {
      "lucide-react": "^0.475.0",
      clsx: "^2.1.1",
    },
    engine_paths: ["/engines/wikilinkGraph.ts", "/engines/sm2Scheduler.ts"],
    generated_paths: ["/App.tsx", "/index.html"],
    files: {
      "/App.tsx": "export default function App() { return <div>App</div>; }",
      "/engines/wikilinkGraph.ts": "export function parseWikiLinks() { return []; }",
      "/engines/sm2Scheduler.ts": "export function scheduleReview() { return {}; }",
    },
  };

  const archive = serializeProjectArchive(dummyBundle, "MedStudy Custom Title");

  assert.equal(archive.format, "splice-vite-typescript-v1");
  assert.equal(archive.projectTitle, "MedStudy Custom Title");
  assert.equal(archive.bundleId, "bundle_test123");
  assert.equal(archive.revision, 1);
  assert.equal(archive.enginePaths.length, 2);
  assert.ok(archive.files["/package.json"]);
  assert.ok(archive.files["/vite.config.ts"]);
  assert.ok(archive.files["/README.md"]);
  assert.ok(archive.files["/engines/wikilinkGraph.ts"]);
  assert.ok(archive.files["/App.tsx"]);

  const packageJson = JSON.parse(archive.files["/package.json"]);
  assert.equal(packageJson.name, "medstudy-custom-title");
  assert.equal(packageJson.dependencies["lucide-react"], "^0.475.0");
  assert.equal(packageJson.dependencies["react"], "^18.3.1");

  assert.match(archive.files["/README.md"], /MedStudy Custom Title/);
  assert.match(archive.files["/README.md"], /\/engines\/wikilinkGraph\.ts/);

  // Calling exportProjectBundle in Node environment executes safely without crashing
  assert.doesNotThrow(() => {
    exportProjectBundle(dummyBundle, "MedStudy Custom Title");
  });
});
