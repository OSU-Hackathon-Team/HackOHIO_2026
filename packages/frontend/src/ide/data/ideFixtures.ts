import {
  FeatureSpec,
  FeatureBlueprint,
  SynthesisBundle,
  type ToolCallRecord,
  type SourceSnippet,
} from "@splice/contracts";
import inkwellSpecJson from "../../../../../fixtures/hand-authored/specs/inkwell.wikilink_graph.json";
import recallSpecJson from "../../../../../fixtures/hand-authored/specs/recall.sm2_scheduler.json";
import inkwellBpJson from "../../../../../fixtures/hand-authored/blueprints/inkwell.wikilink_graph.json";
import recallBpJson from "../../../../../fixtures/hand-authored/blueprints/recall.sm2_scheduler.json";
import studyRoomBundleJson from "../../../../../fixtures/bundles/_seed/study-room.json";

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
export const IDE_DEFAULT_BUNDLE = SynthesisBundle.parse(studyRoomBundleJson);

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
];
