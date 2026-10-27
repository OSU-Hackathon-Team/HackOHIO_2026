import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { getAuthoredNotebookIntakes } from "../example/notebook.js";
import { generateCapabilityClientFiles } from "./clientGen.js";

test("schema-derived client and host wrapper compile with the workspace types", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-clientgen-test-"));
  try {
    const workspaceModules = fileURLToPath(new URL("../../../../node_modules/", import.meta.url));
    fs.symlinkSync(workspaceModules, path.join(root, "node_modules"));
    const definition = getAuthoredNotebookIntakes()[0].definition;
    const files = generateCapabilityClientFiles(definition);
    for (const file of files) {
      const target = path.join(root, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.data);
    }
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true, skipLibCheck: true, types: ["node"] };
    const program = ts.createProgram(files.filter((file) => file.path.endsWith(".ts")).map((file) => path.join(root, file.path)), options);
    const errors = ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
    assert.deepEqual(errors, []);
    assert.match(fs.readFileSync(path.join(root, "client", "client.ts"), "utf8"), /createSpliceExampleFormulaClient/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
