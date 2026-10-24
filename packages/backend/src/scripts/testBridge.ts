import assert from "node:assert/strict";
import path from "node:path";
import { rea } from "../rea/reaClient.js";
import { reaArgs, checkArgsAgainstCatalog } from "../rea/reaArgs.js";
import { REPO_ROOT } from "../config.js";

const t0 = Date.now();
await rea.start();
const tools = await rea.listTools();
console.log(`✓ connected in ${Date.now() - t0}ms, ${tools.length} tools, server ${rea.serverVersion}`);
assert.ok(tools.length > 10, "expected the full REA catalog");
assert.deepEqual(checkArgsAgainstCatalog(tools as any), [], "reaArgs.ts disagrees with tools.json");

const session = await rea.call("binary_session", {});
assert.ok(session.ok, "binary_session failed");
console.log("✓ binary_session:", session.summary);

const target = path.join(REPO_ROOT, "targets/build/inkwell/app.asar");
const a = await rea.call("analyze_javascript_application", reaArgs.analyzeApp(target));
assert.ok(a.ok, `analyze failed: ${a.summary}`);
assert.match(a.parentEvidenceId ?? "", /^ev_[0-9a-f]{64}$/, "summary reply must name the retained analysis");
console.log("✓ analyze:", a.summary, a.parentEvidenceId);

const t = await rea.call(
  "trace_application_feature",
  reaArgs.traceFeature(a.parentEvidenceId!, { kind: "module", value: "src/graph/backlinks.js" }),
);
assert.ok(t.ok, `trace failed: ${t.summary}`);
console.log("✓ trace:", t.summary);

await rea.close();
console.log(`=== bridge OK in ${Date.now() - t0}ms ===`);
process.exit(0);
