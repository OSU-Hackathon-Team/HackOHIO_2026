import { test } from "node:test";
import assert from "node:assert/strict";
import { CompositionPlan } from "@splice/contracts";
import { getAuthoredNotebookIntakes, notebookPlan } from "../example/notebook.js";
import { openMemoryStateStore } from "../state/store.js";
import { WorkflowEngine, type WorkflowCapabilityClient } from "./workflows.js";

function fixturePlan() {
  const intakes = getAuthoredNotebookIntakes();
  const ids = new Map(intakes.map((item, index) => [item.definition.id, `pkg_${String(index + 1).repeat(32)}`]));
  return { intakes, plan: CompositionPlan.parse(notebookPlan(ids)) };
}

test("a later step merges from its checked document revision, preserving an intervening edit", async () => {
  const { intakes, plan } = fixturePlan();
  const definitions = new Map([
    ["formula", intakes[0].definition],
    ["markdown", intakes[1].definition],
    ["transcript", intakes[2].definition],
  ]);
  const clients = new Map<string, WorkflowCapabilityClient>([
    ["transcript", { async call(_operation, input) { return { segments: input.segments }; } }],
    ["formula", { async call() { return { value: 60 }; } }],
    ["markdown", { async call() { return { html: "<p>computed</p>" }; } }],
  ]);
  const store = openMemoryStateStore();
  const originalTransaction = store.transaction.bind(store);
  const external = [{ id: "external", start_ms: 0, end_ms: 500, text: "Later editor change" }];
  let depth = 0;
  let injected = false;
  store.transaction = <T>(fn: () => T): T => {
    depth += 1;
    try {
      const result = originalTransaction(fn);
      if (depth === 1 && !injected) {
        injected = true;
        const current = store.getDocument("meeting");
        assert.ok(current);
        store.putDocument("meeting", { ...(current.data as Record<string, unknown>), transcript: external }, current.revision);
      }
      return result;
    } finally {
      depth -= 1;
    }
  };
  try {
    const engine = new WorkflowEngine(store, definitions, clients);
    const result = await engine.run(plan, "update_notebook", {
      segments: [{ id: "original", start_ms: 0, end_ms: 500, text: "Original" }],
      formula: "=B2*C2", cells: { B2: 3, C2: 20 }, markdown: "Value {{value}}",
    });
    assert.equal(result.status, "succeeded");
    assert.deepEqual((store.getDocument("meeting")?.data as Record<string, unknown>).transcript, external);
    assert.deepEqual((result.documents.meeting as Record<string, unknown>).transcript, external);
  } finally {
    store.close();
  }
});

test("a stale write rolls back every document write and returns the committed state", async () => {
  const { intakes, plan } = fixturePlan();
  const formulaStep = plan.workflows[0].steps.find((step) => step.id === "calculate")!;
  formulaStep.writes = [
    { document: "meeting", path: "value", from: "$steps.calculate.value" },
    { document: "audit", path: "count", from: "$steps.calculate.value" },
  ];
  plan.workflows[0].steps = [formulaStep];
  plan.documents.push({
    id: "audit", kind: "document", owner_instance: null, revisioned: true,
    description: "Concurrent audit state",
    schema: { kind: "object", additional: false, fields: [{ name: "count", type: { kind: "float", bits: 64 }, optional: false }] },
  });
  const store = openMemoryStateStore();
  store.putDocument("audit", { count: 0 }, null);
  const clients = new Map<string, WorkflowCapabilityClient>([["formula", {
    async call() {
      const current = store.getDocument("audit")!;
      store.putDocument("audit", { count: 99 }, current.revision);
      return { value: 60 };
    },
  }]]);
  try {
    const engine = new WorkflowEngine(store, new Map([["formula", intakes[0].definition]]), clients);
    const result = await engine.run(plan, "update_notebook", {
      segments: [], formula: "=B2*C2", cells: { B2: 3, C2: 20 }, markdown: "",
    });
    assert.equal(result.status, "failed");
    assert.match(result.errors.calculate, /revision/);
    assert.equal(store.getDocument("meeting"), null);
    assert.equal(result.documents.meeting, undefined);
    assert.deepEqual(store.getDocument("audit")?.data, { count: 99 });
    assert.deepEqual(result.documents.audit, { count: 99 });
  } finally {
    store.close();
  }
});
