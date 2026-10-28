import type { CapabilityDefinition, CapabilityIntakeRequest, CompositionPlan } from "@splice/contracts";
import { hashJson } from "../capabilities/identity.js";
import { getAuthoredNotebookIntakes } from "./notebook.js";

/** Authored development fixture for the second recipe; it is not recovered app behavior. */
export function getAuthoredBudgetReportIntake(): { definition: CapabilityDefinition; request: CapabilityIntakeRequest } {
  const markdown = getAuthoredNotebookIntakes()[1].definition;
  const calculationPort = markdown.requires.find((port) => port.port === "calculation");
  if (!calculationPort) throw new Error("Notebook Markdown fixture has no calculation port");
  const artifact = { kind: "authored_development", id: "budget_report", version: 1 };
  const definition: CapabilityDefinition = {
    ...structuredClone(markdown),
    id: "splice.example.budget_report",
    title: "Budget summary renderer",
    description: "An authored development renderer that escapes a label and formats a calculated value.",
    origin: {
      kind: "authored", artifact_hash: hashJson(artifact), artifact_ref: "authored_development/budget_report@1",
      source_app: "Splice authored development fixture", stage: "downstream_authored",
    },
    selected_behavior: ["escape a caller-supplied label as HTML", "format a finite calculated value with two decimal places"],
    exclusions: ["not a source-app budget renderer", "no locale-sensitive currency formatting"],
    operations: [{
      ...structuredClone(markdown.operations[0]),
      name: "render_budget",
      summary: "Render an escaped budget label and calculated value.",
      request: { kind: "object", additional: false, fields: [
        { name: "label", type: { kind: "string", encoding: "utf-8", max_bytes: 200 }, optional: false },
        { name: "value", type: { kind: "float", bits: 64 }, optional: false },
      ] },
      result: { kind: "object", additional: false, fields: [
        { name: "html", type: { kind: "string", encoding: "utf-8", max_bytes: 1000 }, optional: false },
      ] },
    }],
    requires: [structuredClone(calculationPort)],
    assumptions: ["The value is a unitless decimal for this development recipe"],
    public_tests: [{ name: "escaped budget report", requirement_ids: ["BUDGET-1"], kind: "public" }],
  };
  const implementation = `
function escapeHtml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
export const operations = { render_budget: ({ label, value }: { label: string; value: number }) => ({ html: "<p>" + escapeHtml(label) + ": <strong>" + value.toFixed(2) + "</strong></p>" }) };
`;
  return {
    definition,
    request: {
      definition,
      origin_artifact: artifact,
      review_attestation: null,
      implementation: { kind: "typescript", entry: "index.ts", files: [{ path: "index.ts", content: implementation, encoding: "utf8" }] },
      public_tests: [{
        name: "escaped budget report", requirement_ids: ["BUDGET-1"], harness: "ts",
        code: 'let out = await ctx.call("render_budget", { label: "Office <supplies> & travel", value: 60 }); ctx.assert.equal(out.html, "<p>Office &lt;supplies&gt; &amp; travel: <strong>60.00</strong></p>"); out = await ctx.call("render_budget", { label: "Operating budget", value: 84 }); ctx.assert.equal(out.html, "<p>Operating budget: <strong>84.00</strong></p>");',
      }],
      independent_verdict: null,
    },
  };
}

/** A distinct two-package recipe with a formula-to-report binding and durable budget document. */
export function budgetBoardPlan(notebook: CompositionPlan, formulaPackageId: string, reportPackageId: string): CompositionPlan {
  const plan = structuredClone(notebook);
  const reportDefinition = getAuthoredBudgetReportIntake().definition;
  const formulaInstance = plan.instances.find((instance) => instance.instance === "formula");
  const markdownInstance = plan.instances.find((instance) => instance.instance === "markdown");
  const notebookBinding = plan.bindings.find((binding) => binding.id === "formula_markdown");
  const calculation = notebook.workflows[0].steps.find((step) => step.id === "calculate");
  const rendering = notebook.workflows[0].steps.find((step) => step.id === "render");
  const valueType = notebook.workflows[0].output.fields.find((field) => field.name === "value")?.type;
  const labelType = reportDefinition.operations[0].request.fields.find((field) => field.name === "label")?.type;
  const htmlType = reportDefinition.operations[0].result.fields.find((field) => field.name === "html")?.type;
  if (!formulaInstance || !markdownInstance || !notebookBinding || !calculation || !rendering || !valueType || !labelType || !htmlType) {
    throw new Error("Notebook fixture lacks a budget capability or binding");
  }
  plan.app = { title: "Budget board", description: "An authored budget calculator and report built from pinned formula and budget-renderer packages." };
  formulaInstance.package_id = formulaPackageId;
  const reportInstance = { ...markdownInstance, instance: "budget_report", package_id: reportPackageId, definition_hash: hashJson(reportDefinition) };
  plan.instances = [formulaInstance, reportInstance];
  const reportBinding = structuredClone(notebookBinding);
  reportBinding.id = "formula_budget_report";
  reportBinding.to = { instance: "budget_report", port: "calculation" };
  reportBinding.notes = ["Formula output is explicitly mapped into the budget report"];
  plan.bindings = [reportBinding];
  plan.providers = [];
  plan.documents = [{
    id: "budget", kind: "document", owner_instance: null, revisioned: true,
    description: "A stored budget calculation and report with its own document revision.",
    schema: { kind: "object", additional: false, fields: [
      { name: "total", type: valueType, optional: false }, { name: "html", type: htmlType, optional: false },
    ] },
  }];
  delete plan.document_migrations;
  const budgetStep = structuredClone(calculation);
  budgetStep.input = budgetStep.input.map((mapping) => mapping.to === "cells" ? { ...mapping, from: "$input.cells" } : mapping);
  budgetStep.stale_guard = null;
  budgetStep.writes = [{ document: "budget", path: "total", from: "$steps.calculate.value" }];
  const reportStep = structuredClone(rendering);
  reportStep.operation = { instance: "budget_report", port: "render_budget" };
  reportStep.input = [
    { from: "$input.label", to: "label", transform: "identity", factor: null },
    { from: "$bindings.formula_budget_report.value", to: "value", transform: "identity", factor: null },
  ];
  reportStep.depends_on = ["calculate"];
  reportStep.writes = [{ document: "budget", path: "html", from: "$steps.render.html" }];
  plan.workflows = [{
    id: "compute_budget", name: "Compute budget report", trigger: "user",
    input: { ...notebook.workflows[0].input, fields: [
      ...notebook.workflows[0].input.fields.filter((field) => field.name === "formula"),
      { name: "cells", type: { kind: "map", values: { kind: "float", bits: 64 }, max_entries: 2048 }, optional: false },
      { name: "label", type: labelType, optional: false },
    ] },
    output: { kind: "object", additional: false, fields: [
      { name: "value", type: valueType, optional: false }, { name: "html", type: htmlType, optional: false },
    ] },
    steps: [budgetStep, reportStep],
  }];
  plan.ui = [{
    id: "budget", kind: "document", title: "Budget board",
    bindings: [{ name: "total", source: "$doc.budget.total", operation: null }, { name: "report", source: "$doc.budget.html", operation: null }],
    actions: [{ id: "compute", label: "Compute report", workflow: "compute_budget" }],
  }];
  plan.acceptance_scenarios = [{
    id: "budget_recalculation", name: "Budget total and report change and survive restart", steps: [
      { kind: "invoke", workflow: "compute_budget", input: { formula: "=A1*B1", cells: { A1: 5, B1: 12 }, label: "Operating budget" }, expect_status: "succeeded" },
      { kind: "assert_document", document: "budget", path: "total", equals: 60 },
      { kind: "assert_document", document: "budget", path: "html", equals: "<p>Operating budget: <strong>60.00</strong></p>" },
      { kind: "restart" },
      { kind: "assert_document", document: "budget", path: "total", equals: 60 },
      { kind: "assert_document", document: "budget", path: "html", equals: "<p>Operating budget: <strong>60.00</strong></p>" },
      { kind: "invoke", workflow: "compute_budget", input: { formula: "=A1*B1", cells: { A1: 7, B1: 12 }, label: "Operating budget" }, expect_status: "succeeded" },
      { kind: "assert_document", document: "budget", path: "total", equals: 84 },
      { kind: "assert_document", document: "budget", path: "html", equals: "<p>Operating budget: <strong>84.00</strong></p>" },
    ],
  }];
  plan.notes = ["Authored development fixture: no source-app equivalence claim."];
  return plan;
}
