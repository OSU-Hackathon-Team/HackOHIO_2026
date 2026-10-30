// Demo-mode source apps (Obsidian, LibreOffice Calc) for the App library, built from recorded run 2.
// Archive/binary hashes, function addresses, original outputs and package IDs are the real recorded values;
// requirement wording is curated for presentation.
import {
  FeatureBlueprint, FeatureSpec, NativeSubsystemSpec,
  type ArtifactType, type Category, type TestCaseResult,
} from "@splice/contracts";
import type { DecompiledTarget, IdeFeatureRecord } from "../ide/data/ideFixtures";
import obsidianHandoff from "../../../../docs/handoffs/obsidian-renderer/public-handoff.json";
import calcOracle from "../../../../docs/handoffs/libreoffice-calc-tables/public-oracle.json";

export const OBSIDIAN_FEATURE = "obsidian.markdown_editor";
export const CALC_FEATURE = "libreoffice_calc.table_engine";
const OBSIDIAN_SHA = "3a349274f789b62c5b35ad19de10311909a94e8783033569c2210a4bac491780";
const CALC_SHA = "c5af49a66872a24fff540ae334e90ba9f2608d9ad2ddb5b7c197e044d26efd40";
const RUN2_MODEL = "qwen.qwen3-coder-480b-a35b-v1:0";
const RECORDED_AT = "2026-10-29T01:52:00.000Z";

interface Rule { id: string; statement: string; title: string; example: [string, string]; addresses?: string[] }

const OBSIDIAN_RULES: Rule[] = [
  { id: "REQ-1", title: "Headings", statement: "Lines starting with # through ###### render as h1–h6 headings.", example: ["## Milestones", "<h2>Milestones</h2>"] },
  { id: "REQ-2", title: "Text formatting", statement: "*italic*, **bold** and ~~strikethrough~~ render as em, strong and del.", example: ["**Total** is ~~90~~ 100", "<strong>Total</strong> is <del>90</del> 100"] },
  { id: "REQ-3", title: "Code blocks and callouts", statement: "Fenced code renders in pre/code with a language class; > [!NOTE] renders as a callout.", example: ["> [!NOTE] Goal", "a note callout"] },
  { id: "REQ-4", title: "Nested lists", statement: "Indented bullet items render as nested ul/li lists.", example: ["- Prep\n  - Posters", "a list inside a list"] },
  { id: "REQ-5", title: "External links", statement: "[text](url) renders as an external-link anchor with rel=\"noopener nofollow\".", example: ["[site](https://example.com)", "an external link"] },
  { id: "REQ-6", title: "Internal links", statement: "[[Note]] renders as an internal-link anchor whose data-href names the linked note.", example: ["[[Budget]]", "a link to the Budget note"] },
  { id: "REQ-7", title: "Editing", statement: "Replacing or appending text updates the document and re-renders it.", example: ["append \"\\n\\nDone\"", "the note gains a Done paragraph"] },
];

const CALC_RULES: Rule[] = [
  { id: "REQ-1", title: "Sort with a header row", statement: "Sorting a range with a header keeps the header first and orders data rows by the key column.", example: ["Pear, Apple, Peach", "Apple, Peach, Pear"] },
  { id: "REQ-2", title: "Multi-key sort", statement: "Rows are ordered by the first key; ties are broken by the next key.", example: ["Count ↓ then Item ↑", "Clip 7, Nut 7, Bolt 4, Washer 2"] },
  { id: "REQ-3", title: "Insert rows", statement: "Inserting a row shifts the rows below it down and leaves an empty row.", example: ["insert at row 3", "Ada, (empty), Sam"], addresses: ["0x005ea350"] },
  { id: "REQ-4", title: "Delete rows", statement: "Deleting a row shifts the rows below it up.", example: ["delete row 3", "Ada, Lee"], addresses: ["0x005e9310"] },
  { id: "REQ-5", title: "Insert columns", statement: "Inserting a column shifts the columns to its right and leaves it empty.", example: ["insert at column B", "Name, (empty), Score"], addresses: ["0x005e9b60"] },
  { id: "REQ-6", title: "Delete columns", statement: "Deleting a column shifts the columns to its right left.", example: ["delete column B", "Name, Group"], addresses: ["0x005e8aa0"] },
  { id: "REQ-7", title: "Cell formulas", statement: "Arithmetic formulas over cell references evaluate with + − × ÷ and parentheses.", example: ["=B2*C2 with 3 and 20", "60"] },
  { id: "REQ-8", title: "Comparisons", statement: "Comparison formulas return 1 when true and 0 when false.", example: ["=10>2", "1"] },
];

const OBSIDIAN_SUITES: [string, string[]][] = [
  ["render_headings_and_formatting", ["REQ-1", "REQ-2"]], ["render_code_and_callout", ["REQ-3"]],
  ["render_tables", ["REQ-3"]], ["render_lists_and_links", ["REQ-4", "REQ-5", "REQ-6"]], ["edit_operations", ["REQ-7"]],
];
const CALC_SUITES: [string, string[]][] = [
  ["calc_binary_comparisons", ["REQ-8"]], ["calc_arithmetic_formulas", ["REQ-7"]],
  ["calc_table_sort", ["REQ-1", "REQ-2"]], ["calc_table_row_col_mutations", ["REQ-3", "REQ-4", "REQ-5", "REQ-6"]],
];
const CALC_CASE_REQ: Record<string, string> = {
  table_sort_text_ascending: "REQ-1", table_sort_multikey_descending: "REQ-2", table_insert_row_middle: "REQ-3",
  table_delete_row_middle: "REQ-4", table_insert_column_middle: "REQ-5", table_delete_column_middle: "REQ-6",
};
const OBSIDIAN_CASE_REQ: Record<string, string> = {
  "headings-and-formatting": "REQ-1 REQ-2", "blocks-and-tables": "REQ-3", "lists-and-links": "REQ-4 REQ-5 REQ-6",
};

const named = (suites: [string, string[]][]) => suites.map(([name, reqs]) => `${reqs.join(" ")}: ${name}`);
const result = (name: string, kind: TestCaseResult["kind"], ms: number): TestCaseResult => ({ name, kind, passed: true, error: null, duration_ms: ms });

export const OBSIDIAN_ORACLE_TESTS = obsidianHandoff.cases.map((c) => `${OBSIDIAN_CASE_REQ[c.case_id]}: original ${c.case_id}`);
export const CALC_ORACLE_TESTS = calcOracle.cases.map((c) => `${CALC_CASE_REQ[c.id]}: original ${c.id}`);
export const OBSIDIAN_TESTS = named(OBSIDIAN_SUITES);
export const CALC_TESTS = named(CALC_SUITES);

function behaviorSpec(title: string, purpose: string, rules: Rule[], examples: NativeSubsystemSpec["examples"]): NativeSubsystemSpec {
  return NativeSubsystemSpec.parse({
    schema: 2, kind: "native_subsystem_spec", status: "ready_for_review", title, purpose, boundary: "subsystem",
    interface: { inputs: ["The document or table the user is editing"], outputs: ["The rendered or recalculated result"], state: [] },
    requirements: rules.map((r) => ({ id: r.id, statement: r.statement })),
    behavior_steps: ["Apply each requirement in order and return the observable result."],
    examples, acceptance_criteria: ["Every example matches the original application's recorded output."],
    deviations: [], exclusions: [],
  });
}

interface FeatureInput {
  featureId: string; appId: string; sourceApp: string; icon: string; artifactType: ArtifactType; path: string; sha256: string;
  title: string; description: string; category: Category; moduleName: string; exports: [string, string][];
  rules: Rule[]; tests: string[]; oracleTests: string[];
}

function featureSpec(f: FeatureInput): FeatureSpec {
  const testCode = f.tests.map((t) => `test(${JSON.stringify(t)}, () => {});`).join("\n");
  return FeatureSpec.parse({
    schema_version: 1, feature_id: f.featureId, app_id: f.appId, source_app: f.sourceApp, source_icon: f.icon,
    artifact_type: f.artifactType, consumer_title: f.title, consumer_description: f.description, category: f.category,
    requirements: f.rules.map((r) => ({ id: r.id, kind: "behavior", statement: r.statement, source_refs: r.addresses ?? ["recorded original observation"] })),
    interface: {
      module_name: f.moduleName,
      exports: f.exports.map(([name, signature]) => ({ name, kind: "function", signature, description: name })),
      types_code: f.exports.map(([name, signature]) => `export declare const ${name}: ${signature};`).join("\n"),
    },
    inputs: [], outputs: [], acceptance_tests: testCode,
    coverage: f.rules.map((r) => ({ requirement_id: r.id, test_names: f.tests.filter((t) => t.split(":")[0].split(" ").includes(r.id)) })),
    allowed_deviations: [], stripped_glue: ["Desktop window, file and IPC handling stay with the host app."],
    oracle: { status: "passed", adapter_code: null, tests: f.oracleTests.map((t) => result(t, "oracle", 40)), passed: f.oracleTests.length, total: f.oracleTests.length },
    status: "verified", open_issues: [], repair_attempts: 0,
    provenance: {
      mode: "replay", target: { path: f.path, artifact_type: f.artifactType, sha256: f.sha256 }, rea_package_version: "6.7.0",
      tool_calls: [], snippets: [], limitations: [], unknowns: [], collected_at: RECORDED_AT, specified_at: RECORDED_AT, model: RUN2_MODEL,
    },
  });
}

function blueprint(spec: FeatureSpec, tests: string[], engineFile: string, durationMs: number): FeatureBlueprint {
  return FeatureBlueprint.parse({
    schema_version: 1, feature_id: spec.feature_id, spec,
    implementation: { module_name: spec.interface.module_name, portable_code: `// Run-2 engine: packages/frontend/src/demo/engines/${engineFile}`, notes: [] },
    verification: {
      status: "passed", tests: tests.map((t) => result(t, "acceptance", 3)), passed: tests.length, total: tests.length,
      purity_violations: [], type_errors: [], repair_attempts: 1, duration_ms: durationMs, implemented_at: RECORDED_AT, model: RUN2_MODEL, mode: "replay",
    },
  });
}

const obsidianSpec = featureSpec({
  featureId: OBSIDIAN_FEATURE, appId: "obsidian", sourceApp: "Obsidian", icon: "NotebookPen", artifactType: "electron_asar",
  path: `uploads/${OBSIDIAN_SHA}.asar`, sha256: OBSIDIAN_SHA, title: "Markdown notes editor",
  description: "Obsidian's Markdown reading view and note editing, rebuilt clean-room from observed UI behavior.",
  category: "parser", moduleName: "obsidianRenderer",
  exports: [["renderMarkdown", "(markdown: string) => { html: string }"], ["editMarkdown", "(doc: string, action: \"replace\" | \"append\", text: string) => { markdown: string; html: string }"]],
  rules: OBSIDIAN_RULES, tests: [...OBSIDIAN_TESTS], oracleTests: OBSIDIAN_ORACLE_TESTS,
});
const calcSpec = featureSpec({
  featureId: CALC_FEATURE, appId: "libreoffice-calc", sourceApp: "LibreOffice Calc", icon: "Sheet", artifactType: "native_elf",
  path: "libreoffice/program/libsclo.so", sha256: CALC_SHA, title: "Spreadsheet tables and formulas",
  description: "LibreOffice Calc's range sorting, row and column edits and cell formulas, rebuilt clean-room from the native library.",
  category: "calculator", moduleName: "calcTables",
  exports: [["evaluateFormula", "(formula: string, cells: Record<string, number>) => number"], ["executeTableOperation", "(op: TableOperationParams, cells: Record<string, string | number>) => (string | number)[][]"]],
  rules: CALC_RULES, tests: [...CALC_TESTS], oracleTests: CALC_ORACLE_TESTS,
});

export const DEMO_SPECS = [obsidianSpec, calcSpec];
export const DEMO_BLUEPRINTS = [
  blueprint(obsidianSpec, [...OBSIDIAN_TESTS, ...OBSIDIAN_ORACLE_TESTS], "obsidianRenderer.ts", 412_000),
  blueprint(calcSpec, [...CALC_TESTS, ...CALC_ORACLE_TESTS], "calcTables.ts", 368_000),
];

const obsidianNativeSpec = behaviorSpec(
  "Obsidian Markdown reading view and editing",
  "Render Markdown notes the way Obsidian's reading view does and apply note edits.",
  OBSIDIAN_RULES,
  obsidianHandoff.cases.map((c) => ({ name: c.case_id, input: { markdown: c.input_markdown }, expected_output: { html: c.expected_html }, observation_kind: "executable" as const })),
);
const calcNativeSpec = behaviorSpec(
  "LibreOffice Calc table operations and formulas",
  "Sort ranges, insert and delete rows and columns, and evaluate cell formulas as LibreOffice Calc does.",
  CALC_RULES,
  calcOracle.cases.map((c) => ({ name: c.id, input: c.input, expected_output: c.observed, observation_kind: "executable" as const })),
);

const steps = (items: [string, string][]) => items.map(([title, description], i) => ({ stepNumber: String(i + 1).padStart(2, "0"), title, description }));

export const DEMO_TARGETS: DecompiledTarget[] = [
  {
    id: "obsidian", name: "Obsidian", friendlyCategory: "Electron desktop app",
    tagline: "Markdown notes with a live reading view.", engineKind: "rea_js", artifactType: "electron_asar",
    targetPath: `uploads/${OBSIDIAN_SHA}.asar`, sha256: OBSIDIAN_SHA,
    description: "Obsidian's 28.18 MB app archive was uploaded and driven through its real UI. An agent created a vault, typed Markdown and recorded the rendered output; every observation was replayed against a fresh copy of the original before any requirement was accepted.",
    flowSteps: steps([
      ["Runtime inventory", "Lists the archive's 47 main-process IPC channels and finds that rendering lives in the UI, not the main process."],
      ["UI discovery and replay", "Drives the original editor, records Markdown inputs with their rendered output, and replays all 15 observations."],
      ["Clean-room engine", "A separate agent implements the renderer from the requirements and public cases only; 3 held-out cases check it."],
    ]),
    highlights: ["Electron app archive", "15 replayed UI observations", "3/3 held-out cases match"],
    files: [], nativeSpec: obsidianNativeSpec,
  },
  {
    id: "libreoffice-calc", name: "LibreOffice Calc", friendlyCategory: "Native ELF Subsystem",
    tagline: "Spreadsheet tables, sorting and formulas.", engineKind: "ghidra_native", artifactType: "native_binary",
    targetPath: "libreoffice/program/libsclo.so", sha256: CALC_SHA,
    description: "LibreOffice 24.2's native spreadsheet library was decompiled with Ghidra. 20 table functions were analyzed and independently reviewed, and the original program was driven over UNO to record real outputs.",
    flowSteps: steps([
      ["Ghidra decompilation", "Imports the native library and decompiles 20 functions around row, column and range operations."],
      ["Semantic review and probes", "19 functions drafted and independently reviewed; 6 original LibreOffice outputs recorded over UNO."],
      ["Clean-room engine", "Implements a portable TypeScript engine from the behavioral spec; all 6 original cases agree."],
    ]),
    highlights: ["Native ELF Subsystem", "20 functions · 46 reviewed claims", "6/6 original outputs agree"],
    files: [],
    nativeDossier: {
      campaign: "73d6658a039172fedb081e8d989f8daea3403cf28638c3bb46dbbb55435b5079", binarySha256: CALC_SHA, scopeRevision: 1,
      readiness: "ready_for_spec",
      scopeRequest: { mode: "function_subsystem", query: "table and range operations", seeds: ["ScDocument::InsertRow", "ScDocument::DeleteRow"], expectedObservables: ["cell grid"] },
      boundaries: [], unresolvedEdges: [], functions: [], dependencyContracts: [], probes: [],
      claims: CALC_RULES.map((r) => ({
        id: r.id, subject: r.title, statement: r.statement, reviewState: "supported_static" as const, executionState: "case_agreement" as const,
        evidenceArtifact: "decompiled_c", addresses: r.addresses ?? [], assumptions: [], probeLinks: [],
      })),
      coverage: {
        includedFunctions: 20, draftedFunctions: 19, claims: 46, staticSupportedClaims: 35, independentReviewGaps: 0,
        reviewedDependencyContracts: 0, claimsWithCaseAgreement: 8, originalProbeCases: 6, originalProbeAgreements: 6,
      },
    },
    nativeSpec: calcNativeSpec,
  },
];

function feature(target: DecompiledTarget, featureId: string, builderId: IdeFeatureRecord["builderId"], rules: Rule[],
  scenarios: IdeFeatureRecord["verifiedScenarios"], extra: Pick<IdeFeatureRecord, "title" | "category" | "summary" | "everydayBenefit" | "limitation">): IdeFeatureRecord {
  return {
    featureId, builderId, targetId: target.id, sourceApp: target.name, readiness: "verified", friendlyStatusLabel: "Ready to Use",
    oracleStatus: "passed", engineStatus: "passed", dependencies: [], ...extra,
    plainRules: rules.map((r) => ({ id: r.id, category: "How it works" as const, title: r.title, explanation: r.statement, exampleInput: r.example[0], exampleOutput: r.example[1] })),
    verifiedScenarios: scenarios,
    spec: DEMO_SPECS.find((s) => s.feature_id === featureId), blueprint: DEMO_BLUEPRINTS.find((b) => b.feature_id === featureId),
  };
}

export const DEMO_FEATURES: IdeFeatureRecord[] = [
  feature(DEMO_TARGETS[0], OBSIDIAN_FEATURE, "obsidian-editor", OBSIDIAN_RULES,
    obsidianHandoff.cases.map((c, i) => ({ id: `SCEN-${i + 1}`, title: c.case_id.replace(/-/g, " "), whatWeChecked: `Typed this note into the original Obsidian editor:\n${c.input_markdown}`, outcomeText: "The rebuilt renderer matched Obsidian's reading view.", matchedOriginal: true })),
    { title: "Markdown notes editor", category: "Notes", summary: "Write notes in Markdown and read them rendered, with headings, callouts, lists, tables and links between notes.", everydayBenefit: "Your notes look the way Obsidian shows them, inside any app you build.", limitation: "Plugins, themes and graph view were outside the reconstructed scope." }),
  feature(DEMO_TARGETS[1], CALC_FEATURE, "calc-tables", CALC_RULES,
    calcOracle.cases.map((c, i) => ({ id: `SCEN-${i + 1}`, title: c.id.replace(/^table_/, "").replace(/_/g, " "), whatWeChecked: `Ran "${c.input.operation.type}" on the original LibreOffice ${calcOracle.application_version.replace("LibreOffice ", "")}.`, outcomeText: "The rebuilt engine produced the same cells as LibreOffice.", matchedOriginal: true })),
    { title: "Spreadsheet tables and formulas", category: "Spreadsheets", summary: "Embed tables in notes, sort them, insert or delete rows and columns, and use formulas like =B2*C2.", everydayBenefit: "Budgets and lists stay live inside your notes.", limitation: "Functions such as SUM, charts and macros were outside the reconstructed scope." }),
];
