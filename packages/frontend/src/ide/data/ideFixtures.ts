import {
  FeatureSpec,
  FeatureBlueprint,
  SynthesisBundle,
  NativeSubsystemSpec,
  type ToolCallRecord,
  type SourceSnippet,
} from "@splice/contracts";
import inkwellSpecJson from "../../../../../fixtures/hand-authored/specs/inkwell.wikilink_graph.json";
import recallSpecJson from "../../../../../fixtures/hand-authored/specs/recall.sm2_scheduler.json";
import inkwellBpJson from "../../../../../fixtures/hand-authored/blueprints/inkwell.wikilink_graph.json";
import recallBpJson from "../../../../../fixtures/hand-authored/blueprints/recall.sm2_scheduler.json";
import studyRoomBundleJson from "../../../../../fixtures/bundles/_seed/study-room.json";
import mockPrioritySpecJson from "../../../../../fixtures/specs/_seed/mockpriority.priority_score.json";
import mockPriorityBpJson from "../../../../../fixtures/blueprints/_seed/mockpriority.priority_score.json";

export interface AppFlowStep {
  stepNumber: string;
  title: string;
  description: string;
}

export interface PlainBehaviorRule {
  id: string;
  category: "How it works" | "Smart rule" | "Safety check";
  title: string;
  explanation: string;
  exampleInput: string;
  exampleOutput: string;
}

export interface VerifiedScenario {
  id: string;
  title: string;
  whatWeChecked: string;
  outcomeText: string;
  matchedOriginal: boolean;
}

export interface ReaGraphNode {
  nodeId: string;
  kind:
    | "electron-main"
    | "context-bridge-api"
    | "ipc-handler"
    | "javascript-module"
    | "javascript-expression"
    | "browser-window"
    | "endpoint"
    | "unknown";
  label: string;
  sourcePath: string;
  startLine: number;
  endLine: number;
  authority: "ast-static-analysis" | "static-relationship-inference" | "artifact-bytes";
  confidence: "exact" | "high" | "low" | "unknown";
  details: string;
  limitations: string[];
}

export interface ReaSemanticFamily {
  family: string;
  status: "complete" | "partial" | "unknown";
  retainedRelations: number;
  unknownCount: number;
}

export interface GhidraInstruction {
  address: string;
  mnemonic: string;
  operands: string;
  comment?: string;
}

export interface GhidraFunctionEvidence {
  entry: string;
  name: string;
  signature: string;
  bodyMin: string;
  bodyMax: string;
  status: "ok" | "external";
  decompilation: string;
  instructions: GhidraInstruction[];
  calls: { site: string; target: string; targetName: string }[];
}

export interface DossierClaim {
  id: string;
  subject: string;
  statement: string;
  reviewState: "supported_static" | "uncertain" | "contradicted" | "unreviewed";
  executionState: "case_agreement" | "case_disagreement" | "untested";
  evidenceArtifact: string;
  addresses: string[];
  assumptions: string[];
  probeLinks: {
    caseId: string;
    observedPointer: string;
    observed: unknown;
    rationale: string;
    agreement: boolean;
  }[];
}

export interface DossierDependencyContract {
  subject: string;
  target: string;
  contract: string;
  reviewState: "supported_static" | "uncertain" | "unreviewed";
  citation: string;
  currentAtSnapshot: boolean;
}

export interface DossierProbeCase {
  id: string;
  target: string;
  input: Record<string, unknown>;
  expectedReturn: number[];
  expectedState: Record<string, unknown>;
  outcome: "agreement" | "disagreement";
}

export interface NativeSubsystemDossier {
  campaign: string;
  binarySha256: string;
  scopeRevision: number;
  readiness: "ready_for_spec" | "partial" | "blocked";
  scopeRequest: {
    mode: string;
    query: string;
    seeds: string[];
    expectedObservables: string[];
  };
  boundaries: { entry: string; name: string; contract: string }[];
  unresolvedEdges: { caller: string; site: string; reason: string }[];
  functions: GhidraFunctionEvidence[];
  claims: DossierClaim[];
  dependencyContracts: DossierDependencyContract[];
  probes: DossierProbeCase[];
  coverage: {
    includedFunctions: number;
    draftedFunctions: number;
    claims: number;
    staticSupportedClaims: number;
    independentReviewGaps: number;
    reviewedDependencyContracts: number;
    claimsWithCaseAgreement: number;
    originalProbeCases: number;
    originalProbeAgreements: number;
  };
}

export interface DecompiledTarget {
  id: string;
  name: string;
  friendlyCategory: string;
  tagline: string;
  engineKind: "rea_js" | "ghidra_native";
  artifactType: "electron_asar" | "native_binary";
  targetPath: string;
  sha256: string;
  description: string;
  flowSteps: AppFlowStep[];
  highlights: string[];
  files: SourceSnippet[];
  reaSummary?: {
    evidenceId: string;
    relevantFiles: number;
    parsedJsFiles: number;
    visitedAstNodes: number;
    findings: number;
    parseFailures: number;
    ipcChannels: string[];
    contextBridgeApis: string[];
    semanticFamilies: ReaSemanticFamily[];
    graphNodes: ReaGraphNode[];
    toolCalls: ToolCallRecord[];
  };
  nativeDossier?: NativeSubsystemDossier;
  nativeSpec?: NativeSubsystemSpec;
}

export type FeatureReadiness = "verified" | "sample" | "needs_review" | "blocked";

export interface IdeFeatureRecord {
  featureId: string;
  builderId: "wiki-links" | "spaced-review" | "fuzzy-search" | "cloud-sync";
  targetId: string;
  title: string;
  sourceApp: string;
  category: string;
  readiness: FeatureReadiness;
  friendlyStatusLabel: "Ready to Use" | "Needs Review" | "Unavailable";
  oracleStatus: "passed" | "failed" | "not_executable";
  engineStatus: "passed" | "unimplemented" | "blocked";
  summary: string;
  everydayBenefit: string;
  limitation: string;
  dependencies: string[];
  plainRules: PlainBehaviorRule[];
  verifiedScenarios: VerifiedScenario[];
  spec?: FeatureSpec;
  blueprint?: FeatureBlueprint;
}

const inkwellSpec = FeatureSpec.parse(inkwellSpecJson);
const recallSpec = FeatureSpec.parse(recallSpecJson);
const inkwellBlueprint = FeatureBlueprint.parse(inkwellBpJson);
const recallBlueprint = FeatureBlueprint.parse(recallBpJson);
export const mockPrioritySpec = FeatureSpec.parse(mockPrioritySpecJson);
export const mockPriorityBlueprint = FeatureBlueprint.parse(mockPriorityBpJson);
export const IDE_DEFAULT_BUNDLE = SynthesisBundle.parse(studyRoomBundleJson);

const mockZero64 = "0".repeat(64);
export const mockNativeSpec: NativeSubsystemSpec = {
  schema: 2,
  kind: "native_subsystem_spec",
  status: "ready_for_review",
  title: "Task Priority Scoring Subsystem",
  purpose: "Calculates urgency and importance score for tasks, scaling overdue work and zeroing completed tasks.",
  boundary: "subsystem",
  interface: {
    inputs: ["TaskView struct with due date, completion status, and importance", "Current epoch timestamp"],
    outputs: ["Calculated priority score as non-negative integer (0-200)"],
    state: ["Stateless calculation across invocations"],
  },
  requirements: [
    {
      id: "REQ-1",
      statement: "Completed tasks score 0 regardless of due date or importance.",
    },
    {
      id: "REQ-2",
      statement: "Overdue tasks gain 40 points per complete day late, capped at 120.",
    },
    {
      id: "REQ-3",
      statement: "Tasks due within 24 hours receive 80 urgency points; tasks due within 7 days receive 35 urgency points.",
    },
    {
      id: "REQ-4",
      statement: "Importance is clamped between 0 and 5, adding 30 points per level.",
    },
    {
      id: "REQ-5",
      statement: "Total score is non-negative and capped at 200.",
    },
  ],
  behavior_steps: [
    "Check if task is marked completed; return 0 immediately.",
    "Calculate overdue duration; add 40 points per full 24h day late up to 120 max.",
    "Calculate upcoming urgency: 80 points if within 24h, 35 points if within 7 days.",
    "Clamp importance to [0, 5] range and multiply by 30 points.",
    "Sum urgency and importance, clamp total between 0 and 200.",
  ],
  examples: [
    {
      name: "completed_task_zero",
      input: { completed: true, importance: 5, days_overdue: 10 },
      expected_output: 0,
    },
    {
      name: "overdue_task_capped",
      input: { completed: false, importance: 1, days_overdue: 4 },
      expected_output: 150,
    },
    {
      name: "due_soon_urgent",
      input: { completed: false, importance: 2, hours_until_due: 12 },
      expected_output: 140,
    },
    {
      name: "importance_clamped",
      input: { completed: false, importance: 7, hours_until_due: 48 },
      expected_output: 150,
    },
    {
      name: "total_score_capped",
      input: { completed: false, importance: 5, days_overdue: 5 },
      expected_output: 200,
    },
  ],
  acceptance_criteria: [
    "Completed tasks always evaluate to 0.",
    "Overdue urgency is capped at 120.",
    "Importance multiplier strictly adheres to 30 points per clamped level.",
    "Total score never exceeds 200.",
  ],
  deviations: [],
  exclusions: [],
  ...({
    campaign: mockZero64,
    binary_sha256: mockZero64,
    provenance: {
      dossier_artifact: mockZero64,
      scope_artifact: mockZero64,
    },
  } as any),
};

export const IDE_TARGETS: DecompiledTarget[] = [
  {
    id: "inkwell",
    name: "Inkwell Notes",
    friendlyCategory: "Desktop Note-Taking App",
    tagline: "Organize study notes and automatically connect related topics together.",
    engineKind: "rea_js",
    artifactType: "electron_asar",
    targetPath: "targets/build/inkwell/app.asar",
    sha256: "37979c1c709c822434e0e72767e0d1edb0fcd7032e8cf4fa08a32bd65f383942",
    description:
      "Inkwell Notes lets writers and students connect ideas using [[double brackets]]. When one note mentions another, Inkwell automatically builds a map of incoming and outgoing connections.",
    flowSteps: [
      {
        stepNumber: "01",
        title: "Write Your Notes Naturally",
        description: "Type everyday notes and wrap any topic name in [[brackets]] to link it to another note.",
      },
      {
        stepNumber: "02",
        title: "Automatic Topic Matching",
        description: "Inkwell cleans up capitalization and extra spaces so [[heart]] and [[Heart]] always connect to the same page.",
      },
      {
        stepNumber: "03",
        title: "Two-Way Backlinks & Missing Topics",
        description: "Every note automatically shows which other notes mention it, and highlights links to topics you haven't written yet.",
      },
    ],
    highlights: [
      "3 Building Blocks Discovered",
      "1 Ready to Use Immediately",
      "3 out of 3 Behavior Scenarios Matched",
    ],
    files: inkwellSpec.provenance.snippets,
  },
  {
    id: "recall",
    name: "Recall Flashcards",
    friendlyCategory: "Memory & Study App",
    tagline: "Turn notes into flashcards and schedule reviews right before you forget.",
    engineKind: "rea_js",
    artifactType: "electron_asar",
    targetPath: "targets/build/recall/app.asar",
    sha256: recallSpec.provenance.target.sha256,
    description:
      "Recall Flashcards spaces out your study sessions based on how easily you remember each card. Easy cards wait longer between reviews, while missed cards come back tomorrow.",
    flowSteps: [
      {
        stepNumber: "01",
        title: "Rate How Well You Remembered",
        description: "After reviewing a card, choose how easy or hard it was to recall.",
      },
      {
        stepNumber: "02",
        title: "Smart Wait-Time Adjustment",
        description: "Cards you know well expand from 1 day to 6 days and beyond; forgotten cards reset to 1 day so you can re-learn them.",
      },
      {
        stepNumber: "03",
        title: "Tricky Card Detection",
        description: "If a card is forgotten 8 times, Recall highlights it as a 'Tricky Card' so you can rewrite or simplify it.",
      },
    ],
    highlights: [
      "1 Building Block Discovered",
      "Ready to Use Immediately",
      "4 out of 4 Behavior Scenarios Matched",
    ],
    files: recallSpec.provenance.snippets,
  },
  {
    id: "mockpriority",
    name: "Mock Task Board",
    friendlyCategory: "Native ELF Subsystem",
    tagline: "Scoring due dates, urgency, and importance from compiled native binary.",
    engineKind: "ghidra_native",
    artifactType: "native_binary",
    targetPath: "fixtures/test-run/mock_task_priority.elf",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    description:
      "Mock Task Board contains a compiled native task-priority engine. Ghidra Headless decompilation and semantic probes verified its scoring bounds, urgency windows, and completed-task invariants.",
    flowSteps: [
      {
        stepNumber: "01",
        title: "Ghidra Function & Symbol Extraction",
        description: "Decompiles binary load segments to identify entry points, calling conventions, and control flow for score_task_priority.",
      },
      {
        stepNumber: "02",
        title: "Semantic Review & Probe Verification",
        description: "Independent static review validates behavioral requirements against dynamic native probes with 100% agreement.",
      },
      {
        stepNumber: "03",
        title: "Clean-Room Specification Handoff",
        description: "Adapts auditable NativeSubsystemSpec into TypeScript FeatureSpec with not_executable oracle and acceptance tests.",
      },
    ],
    highlights: [
      "Native ELF Subsystem",
      "5 Verified Behavioral Requirements",
      "100% Probe Agreement (5/5 Cases)",
    ],
    files: [
      {
        location: "mock_task_priority.elf!0x4012A0",
        symbol: "score_task_priority",
        language: "c",
        code: "/* Recovered native symbol: score_task_priority(TaskView*, int64_t now_epoch) */\nint score_task_priority(TaskView *task, int64_t now_epoch);",
        full_module: false,
      },
    ],
    nativeDossier: {
      campaign: "0".repeat(64),
      binarySha256: "0".repeat(64),
      scopeRevision: 1,
      readiness: "ready_for_spec",
      scopeRequest: {
        mode: "function_subsystem",
        query: "score_task_priority",
        seeds: ["0x4012A0"],
        expectedObservables: ["priority_score"],
      },
      boundaries: [
        { entry: "0x4012A0", name: "score_task_priority", contract: "int(TaskView*, int64_t)" },
      ],
      unresolvedEdges: [],
      functions: [
        {
          entry: "0x4012A0",
          name: "score_task_priority",
          signature: "int score_task_priority(TaskView *task, int64_t now_epoch)",
          bodyMin: "0x4012A0",
          bodyMax: "0x401340",
          status: "ok",
          decompilation: "int score_task_priority(TaskView *task, int64_t now_epoch) { ... }",
          instructions: [],
          calls: [],
        },
      ],
      claims: [
        {
          id: "claim-priority-base",
          subject: "score_task_priority",
          statement: "Base priority score calculation",
          reviewState: "supported_static",
          executionState: "case_agreement",
          evidenceArtifact: "decompiled_c",
          addresses: ["0x4012A0"],
          assumptions: [],
          probeLinks: [],
        },
      ],
      dependencyContracts: [],
      probes: [],
      coverage: {
        includedFunctions: 1,
        draftedFunctions: 1,
        claims: 5,
        staticSupportedClaims: 5,
        independentReviewGaps: 0,
        reviewedDependencyContracts: 0,
        claimsWithCaseAgreement: 5,
        originalProbeCases: 5,
        originalProbeAgreements: 5,
      },
    },
    nativeSpec: mockNativeSpec,
  },
];

export const IDE_FEATURES: IdeFeatureRecord[] = [
  {
    featureId: "inkwell.wikilink_graph",
    builderId: "wiki-links",
    targetId: "inkwell",
    title: "Connected Notes & Backlinks",
    sourceApp: "Inkwell Notes",
    category: "Note Linking",
    readiness: "verified",
    friendlyStatusLabel: "Ready to Use",
    oracleStatus: "passed",
    engineStatus: "passed",
    summary:
      "Automatically connects notes when you type [[Topic]] and shows which notes refer back to each other.",
    everydayBenefit:
      "Helps you see how ideas relate across your study notes and spots topics you still need to write.",
    limitation: "Section headings inside links (like [[Note#Section]]) connect to the main note.",
    dependencies: [],
    plainRules: [
      {
        id: "RULE-1",
        category: "How it works",
        title: "Finds [[Topic]] links while ignoring quoted examples",
        explanation:
          "Whenever you wrap a word or phrase in [[double brackets]], it creates a link—even if you add a custom label like [[Heart|Cardiology]]. Any brackets inside quoted example blocks are safely ignored.",
        exampleInput: "See [[Anatomy]] and [[Heart#Valves|Heart Guide]]",
        exampleOutput: "Connects to: Anatomy, Heart",
      },
      {
        id: "RULE-2",
        category: "Smart rule",
        title: "Matches titles regardless of capitalization or extra spaces",
        explanation:
          "You don't have to worry about uppercase letters or accidental double spaces—links always match the right note title.",
        exampleInput: "[[  clinical   practice ]]",
        exampleOutput: "Matches note: Clinical Practice",
      },
      {
        id: "RULE-3",
        category: "Smart rule",
        title: "Creates clean two-way connections without duplicates",
        explanation:
          "Linking to the same note twice in one paragraph only counts as one connection, and linking a note to itself is ignored.",
        exampleInput: "Note A links to [[Note B]] twice",
        exampleOutput: "1 clean connection between Note A and Note B",
      },
      {
        id: "RULE-4",
        category: "Safety check",
        title: "Highlights links to notes you haven't created yet",
        explanation:
          "If you link to a topic that doesn't have its own note yet, it is listed under 'Unwritten Topics' so you remember to create it later.",
        exampleInput: "Links to [[Anatomy]] and [[New Topic]]",
        exampleOutput: "Flags 'New Topic' as an unwritten note",
      },
    ],
    verifiedScenarios: [
      {
        id: "SCEN-1",
        title: "Links with custom labels and section headings",
        whatWeChecked: "Typed notes with regular [[Links]], custom labels, and quoted text.",
        outcomeText: "Matched Inkwell Notes 100% — connected the right notes and ignored quoted examples.",
        matchedOriginal: true,
      },
      {
        id: "SCEN-2",
        title: "Messy spacing and uppercase/lowercase titles",
        whatWeChecked: "Linked notes using lowercase letters and extra spaces inside brackets.",
        outcomeText: "Matched Inkwell Notes 100% — matched the exact target note every time.",
        matchedOriginal: true,
      },
      {
        id: "SCEN-3",
        title: "Two-way backlinks and unwritten topic alerts",
        whatWeChecked: "Connected multiple notes together and linked to a missing topic.",
        outcomeText: "Matched Inkwell Notes 100% — backlinks and unwritten topic lists agreed completely.",
        matchedOriginal: true,
      },
    ],
    spec: inkwellSpec,
    blueprint: inkwellBlueprint,
  },
  {
    featureId: "recall.sm2_scheduler",
    builderId: "spaced-review",
    targetId: "recall",
    title: "Smart Flashcard Scheduler",
    sourceApp: "Recall Flashcards",
    category: "Study & Memory",
    readiness: "verified",
    friendlyStatusLabel: "Ready to Use",
    oracleStatus: "passed",
    engineStatus: "passed",
    summary:
      "Schedules each note for flashcard review based on how easily you remembered it, spacing out reviews over time.",
    everydayBenefit:
      "Saves study time by showing you hard cards more often and pushing easy cards further into the future.",
    limitation: "Works alongside Connected Notes so your notes can be practiced as flashcards.",
    dependencies: ["inkwell.wikilink_graph"],
    plainRules: [
      {
        id: "RULE-1",
        category: "How it works",
        title: "Expands wait time each time you remember a card",
        explanation:
          "The first time you remember a card, it comes back in 1 day. The second time, it waits 6 days. After that, the wait time multiplies automatically based on how easy the card feels.",
        exampleInput: "Remembered twice in a row",
        exampleOutput: "Next review scheduled in 6 days",
      },
      {
        id: "RULE-2",
        category: "Smart rule",
        title: "Brings forgotten cards back tomorrow",
        explanation:
          "If you forget a card, its streak resets and it is scheduled for review again in 1 day so you don't fall behind.",
        exampleInput: "Marked card as 'Forgot'",
        exampleOutput: "Next review reset to 1 day",
      },
      {
        id: "RULE-3",
        category: "Safety check",
        title: "Keeps card difficulty balanced",
        explanation:
          "Even if a card is missed several times, its difficulty multiplier never drops below a healthy floor (1.3x), preventing cards from getting stuck.",
        exampleInput: "Multiple tough reviews in a row",
        exampleOutput: "Difficulty multiplier stays balanced at 1.3x",
      },
      {
        id: "RULE-4",
        category: "Smart rule",
        title: "Flags 'Tricky Cards' after 8 misses",
        explanation:
          "When a card has been forgotten 8 times, it gets a 'Tricky Card' badge so you know to break the note into simpler pieces.",
        exampleInput: "Forgotten for the 8th time",
        exampleOutput: "Marked with a 'Tricky Card' badge",
      },
    ],
    verifiedScenarios: [
      {
        id: "SCEN-4",
        title: "Growing intervals on successful reviews",
        whatWeChecked: "Reviewed a new flashcard twice with a 'Good' rating.",
        outcomeText: "Matched Recall Flashcards 100% — scheduled for 1 day, then expanded to 6 days.",
        matchedOriginal: true,
      },
      {
        id: "SCEN-5",
        title: "Resetting wait time when a card is forgotten",
        whatWeChecked: "Marked an established card (12-day wait) as 'Forgot'.",
        outcomeText: "Matched Recall Flashcards 100% — reset wait time to 1 day while keeping difficulty balanced.",
        matchedOriginal: true,
      },
      {
        id: "SCEN-6",
        title: "Highlighting tricky cards after 8 misses",
        whatWeChecked: "Missed a card for the 8th time.",
        outcomeText: "Matched Recall Flashcards 100% — automatically added the 'Tricky Card' alert.",
        matchedOriginal: true,
      },
    ],
    spec: recallSpec,
    blueprint: recallBlueprint,
  },
  {
    featureId: "inkwell.fuzzy_search",
    builderId: "fuzzy-search",
    targetId: "inkwell",
    title: "Instant Title Search",
    sourceApp: "Inkwell Notes",
    category: "Search",
    readiness: "needs_review",
    friendlyStatusLabel: "Needs Review",
    oracleStatus: "not_executable",
    engineStatus: "unimplemented",
    summary:
      "Finds notes quickly even when you only type a few letters of the title.",
    everydayBenefit: "Lets you jump to a note without typing its exact full name.",
    limitation:
      "This building block is still being checked against Inkwell Notes to confirm how tied search results are ordered. It isn't ready to add to your app yet.",
    dependencies: [],
    plainRules: [
      {
        id: "RULE-S1",
        category: "How it works",
        title: "Matches letters in order even if you skip words",
        explanation: "Typing 'cardio' or 'cpr' finds 'Cardiology Practice' as long as the letters appear in order.",
        exampleInput: "Search: 'cln'",
        exampleOutput: "Finds: 'Clinical Practice'",
      },
    ],
    verifiedScenarios: [],
  },
  {
    featureId: "inkwell.cloud_sync",
    builderId: "cloud-sync",
    targetId: "inkwell",
    title: "Cloud Folder Sync",
    sourceApp: "Inkwell Notes",
    category: "Backup & Sync",
    readiness: "blocked",
    friendlyStatusLabel: "Unavailable",
    oracleStatus: "not_executable",
    engineStatus: "blocked",
    summary: "Backs up notes to a private cloud folder across computers.",
    everydayBenefit: "Keeps a copy of your notes on another device.",
    limitation:
      "Unavailable: This feature requires private computer folder permissions and an external cloud account, so it cannot be safely copied into your web app.",
    dependencies: ["inkwell.wikilink_graph"],
    plainRules: [],
    verifiedScenarios: [],
  },
  {
    featureId: "mockpriority.priority_score",
    builderId: "spaced-review",
    targetId: "mockpriority",
    title: "Task Priority Scoring Engine",
    sourceApp: "Mock Task Board",
    category: "Task Scoring",
    readiness: "verified",
    friendlyStatusLabel: "Ready to Use",
    oracleStatus: "not_executable",
    engineStatus: "passed",
    summary:
      "Calculates urgency and importance score for tasks, scaling overdue work and zeroing completed tasks.",
    everydayBenefit:
      "Automatically bubbles up urgent and high-priority tasks using proven compiled algorithms.",
    limitation: "Reconstructed from native decompilation into clean-room TypeScript; native binary is not executed in-browser.",
    dependencies: [],
    plainRules: [
      {
        id: "REQ-1",
        category: "Safety check",
        title: "Completed tasks score zero",
        explanation: "Completed tasks evaluate to 0 regardless of how overdue or important they were.",
        exampleInput: "Completed task, importance 5",
        exampleOutput: "Score: 0",
      },
      {
        id: "REQ-2",
        category: "Smart rule",
        title: "Overdue tasks add 40 points per day",
        explanation: "Overdue tasks gain 40 points for each full 24-hour day past their due date, capped at 120.",
        exampleInput: "3 days overdue, importance 1",
        exampleOutput: "Urgency: 120 + Importance: 30 = 150",
      },
      {
        id: "REQ-3",
        category: "How it works",
        title: "Due soon urgency boosts",
        explanation: "Tasks due within 24 hours add 80 points; tasks due within 7 days add 35 points.",
        exampleInput: "Due in 12 hours, importance 2",
        exampleOutput: "Score: 80 + 60 = 140",
      },
      {
        id: "REQ-4",
        category: "Smart rule",
        title: "Importance clamped 0 to 5",
        explanation: "Importance scale is clamped between 0 and 5, multiplying by 30 points per level.",
        exampleInput: "Importance 7 (clamped to 5)",
        exampleOutput: "Importance points: 150",
      },
      {
        id: "REQ-5",
        category: "Safety check",
        title: "Overall score capped at 200",
        explanation: "Total score is bounded to a maximum of 200 to keep task lists normalized.",
        exampleInput: "Urgency 120 + Importance 150 = 270",
        exampleOutput: "Score: 200",
      },
    ],
    verifiedScenarios: [
      {
        id: "completed_zero",
        title: "Completed Task Returns 0",
        whatWeChecked: "Evaluated a finished task with high urgency and importance 5 against native logic.",
        outcomeText: "Returned 0 as expected.",
        matchedOriginal: true,
      },
      {
        id: "overdue_capped",
        title: "Overdue Urgency Capped at 120",
        whatWeChecked: "Evaluated 10-day overdue task to confirm 120 point ceiling.",
        outcomeText: "Urgency capped at 120 points without overflow.",
        matchedOriginal: true,
      },
      {
        id: "score_cap",
        title: "Overall Score Ceiling 200",
        whatWeChecked: "Combined max urgency and max importance.",
        outcomeText: "Score capped strictly at 200.",
        matchedOriginal: true,
      },
    ],
    spec: mockPrioritySpec,
    blueprint: mockPriorityBlueprint,
  },
];

