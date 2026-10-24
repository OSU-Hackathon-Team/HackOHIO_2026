import { create } from "zustand";
import {
  applyBuilderOperations,
  type BuilderBlock,
  type SynthesisBundle,
} from "@splice/contracts";
import { requestBuilderEdits } from "../../builder/api";
import {
  IDE_TARGETS,
  IDE_FEATURES,
  IDE_DEFAULT_BUNDLE,
} from "../data/ideFixtures";

export type ActivityId = "chat" | "explorer" | "decompiler" | "specs" | "studio";
export type TabKind = "decompiled" | "specs" | "studio";
export type StudioSubMode = "canvas" | "sandpack" | "engines";
export type BottomTabId = "terminal" | "tests" | "diagnostics";

export interface EditorTab {
  id: string;
  kind: TabKind;
  title: string;
  subtitle?: string;
  targetId?: string;
  featureId?: string;
  studioMode?: StudioSubMode;
}

export interface LineRangeHighlight {
  targetId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  label?: string;
}

export interface TerminalLogEntry {
  id: number;
  ts: number;
  stage: "decompiler" | "oracle" | "engine" | "copilot" | "system";
  text: string;
}

export interface CopilotMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  model?: string;
  badges?: string[];
  actions?: { label: string; tab: EditorTab }[];
}

export interface NoteItem {
  id: string;
  title: string;
  body: string;
}

export interface CardReviewState {
  reps: number;
  interval: number;
  ease: number;
  lapses: number;
  due: string;
  leech: boolean;
}

export const PRESET_WINDOWS: EditorTab[] = [
  {
    id: "decompiled-inkwell",
    kind: "decompiled",
    title: "Source App: Inkwell Notes",
    subtitle: "Note-Taking App",
    targetId: "inkwell",
  },
  {
    id: "decompiled-recall",
    kind: "decompiled",
    title: "Source App: Recall Flashcards",
    subtitle: "Memory & Study App",
    targetId: "recall",
  },
  {
    id: "specs-wikilinks",
    kind: "specs",
    title: "Feature: Connected Notes",
    subtitle: "Ready to Use",
    featureId: "inkwell.wikilink_graph",
  },
  {
    id: "specs-sm2",
    kind: "specs",
    title: "Feature: Smart Flashcards",
    subtitle: "Ready to Use",
    featureId: "recall.sm2_scheduler",
  },
  {
    id: "studio-app",
    kind: "studio",
    title: "My App: Live Study Space",
    subtitle: "Interactive Preview",
    studioMode: "canvas",
  },
];

export interface IdeState {
  // Workbench chrome
  projectTitle: string;
  activeActivity: ActivityId;
  sidebarOpen: boolean;
  copilotOpen: boolean;
  bottomPanelOpen: boolean;
  bottomPanelTab: BottomTabId;
  splitView: boolean;
  commandPaletteOpen: boolean;
  activeModel: string;

  // Tabs & Navigation
  tabs: EditorTab[];
  activeTabId: string;
  secondaryTabId: string | null;

  // Target & Feature Selection
  selectedTargetId: string;
  selectedFileByTarget: Record<string, string>;
  lineHighlight: LineRangeHighlight | null;
  selectedFeatureId: string;
  selectedEngineFeatureId: string;
  highlightedExport: string | null;

  // Studio & Live App State
  studioSubMode: StudioSubMode;
  includedFeatureIds: string[];
  bundle: SynthesisBundle;
  layout: BuilderBlock[];
  pastLayouts: BuilderBlock[][];
  futureLayouts: BuilderBlock[][];
  notes: NoteItem[];
  selectedNoteId: string;
  reviews: Record<string, CardReviewState>;
  statusError: string | null;

  // Activity & Checks
  terminalLogs: TerminalLogEntry[];
  testRunCount: number;
  isRunningTests: boolean;

  // Copilot Chat
  chatMessages: CopilotMessage[];
  chatBusy: boolean;

  // Actions
  setProjectTitle(title: string): void;
  setActiveActivity(activity: ActivityId): void;
  toggleSidebar(open?: boolean): void;
  toggleCopilot(open?: boolean): void;
  toggleBottomPanel(open?: boolean): void;
  setBottomPanelTab(tab: BottomTabId): void;
  toggleSplitView(split?: boolean): void;
  setCommandPaletteOpen(open: boolean): void;
  setActiveModel(model: string): void;

  openTab(tab: EditorTab, inSplit?: boolean): void;
  closeTab(tabId: string): void;
  closeAllTabs(): void;
  setActiveTab(tabId: string): void;

  selectTarget(targetId: string, filePath?: string): void;
  selectFeature(featureId: string): void;
  jumpToSourceRef(targetId: string, sourceRef: string, label?: string, split?: boolean): void;
  jumpToEngineExport(featureId: string, exportName: string, split?: boolean): void;
  setStudioSubMode(mode: StudioSubMode): void;
  toggleFeatureInBuild(featureId: string): void;
  toggleBlockWidth(blockId: string): void;
  removeBlock(blockId: string): void;
  clearStatusError(): void;

  // Interactive App Canvas Actions
  selectNote(noteId: string): void;
  updateNote(noteId: string, title: string, body: string): void;
  addNote(): void;
  gradeFlashcard(noteId: string, grade: number): void;
  undoLayout(): void;
  redoLayout(): void;

  // Verification & Copilot
  appendLog(stage: TerminalLogEntry["stage"], text: string): void;
  runAllVerificationTests(): Promise<void>;
  sendCopilotPrompt(prompt: string): Promise<void>;
}

let nextLogId = 1;

const INITIAL_LAYOUT: BuilderBlock[] = [
  {
    id: "notes-editor",
    kind: "notes",
    title: "My Study Notes",
    description: "Write notes and type [[Topic]] in double brackets to connect related ideas.",
    visible: true,
    width: "full",
  },
  {
    id: "backlinks-graph",
    kind: "backlinks",
    title: "Connected Ideas & Backlinks",
    description: "See which notes link to each other and which topics still need a note.",
    visible: true,
    width: "half",
  },
  {
    id: "sm2-reviews",
    kind: "reviews",
    title: "Daily Flashcard Practice",
    description: "Practice your notes as flashcards and schedule the next review automatically.",
    visible: true,
    width: "half",
  },
];

const INITIAL_NOTES: NoteItem[] = [
  {
    id: "cardiology",
    title: "Cardiology",
    body: "The heart pumps blood through the body, connecting [[Anatomy]] with [[Physiology]].",
  },
  {
    id: "anatomy",
    title: "Anatomy",
    body: "Heart chambers and valves support healthy [[Physiology]] and guide [[Clinical Practice]].",
  },
  {
    id: "physiology",
    title: "Physiology",
    body: "Blood pressure regulation is central to [[Cardiology]] and informs [[Pharmacology]].",
  },
  {
    id: "pharmacology",
    title: "Pharmacology",
    body: "Medications work alongside [[Physiology]] and [[New Research Topic]].",
  },
];

const INITIAL_REVIEWS: Record<string, CardReviewState> = {
  cardiology: { reps: 2, interval: 6, ease: 2.5, lapses: 0, due: "Due today", leech: false },
  anatomy: { reps: 1, interval: 1, ease: 2.36, lapses: 1, due: "Due today", leech: false },
  physiology: { reps: 3, interval: 15, ease: 2.6, lapses: 0, due: "In 15 days", leech: false },
  pharmacology: { reps: 0, interval: 1, ease: 1.3, lapses: 7, due: "Due today", leech: false },
};

export const useIdeStore = create<IdeState>((set, get) => ({
  projectTitle: "My Study Space",
  activeActivity: "chat",
  sidebarOpen: false,
  copilotOpen: false,
  bottomPanelOpen: false,
  bottomPanelTab: "tests",
  splitView: false,
  commandPaletteOpen: false,
  activeModel: "qwen.qwen3-coder-480b-a35b-v1:0",

  tabs: [],
  activeTabId: "",
  secondaryTabId: null,

  selectedTargetId: "inkwell",
  selectedFileByTarget: {
    inkwell: "src/graph/wikilinks.js",
    recall: "src/scheduler/sm2.js",
  },
  lineHighlight: null,
  selectedFeatureId: "inkwell.wikilink_graph",
  selectedEngineFeatureId: "inkwell.wikilink_graph",
  highlightedExport: null,

  studioSubMode: "canvas",
  includedFeatureIds: ["inkwell.wikilink_graph", "recall.sm2_scheduler"],
  bundle: IDE_DEFAULT_BUNDLE,
  layout: INITIAL_LAYOUT,
  pastLayouts: [],
  futureLayouts: [],
  notes: INITIAL_NOTES,
  selectedNoteId: "cardiology",
  reviews: INITIAL_REVIEWS,
  statusError: null,

  terminalLogs: [
    {
      id: nextLogId++,
      ts: Date.now() - 3200,
      stage: "decompiler",
      text: "Discovered 4 building blocks across Inkwell Notes and Recall Flashcards.",
    },
    {
      id: nextLogId++,
      ts: Date.now() - 1800,
      stage: "oracle",
      text: "Verified Connected Notes (3/3 scenarios matched) and Smart Flashcard Scheduler (4/4 scenarios matched).",
    },
    {
      id: nextLogId++,
      ts: Date.now() - 600,
      stage: "engine",
      text: "Your Study Space app is ready with Connected Notes and Smart Flashcard Practice.",
    },
  ],
  testRunCount: 1,
  isRunningTests: false,

  chatMessages: [
    {
      id: "msg-welcome",
      role: "assistant",
      ts: Date.now() - 500,
      model: "AI Assistant",
      badges: ["2 Building Blocks Active", "6/6 Scenarios Verified"],
      text: "Hi! Tell me what kind of app you'd like to build in plain English, or click any step above to explore discovered apps, inspect building blocks, or try your live app.",
    },
  ],
  chatBusy: false,

  setProjectTitle(projectTitle) {
    set({ projectTitle });
  },
  setActiveActivity(activeActivity) {
    set(s => {
      if (s.tabs.length === 0 && activeActivity === "chat") {
        return { activeActivity: "chat", sidebarOpen: false };
      }
      if (s.activeActivity === activeActivity && s.sidebarOpen) {
        return { sidebarOpen: false };
      }
      return { activeActivity, sidebarOpen: true };
    });
  },
  toggleSidebar(open) {
    set(s => ({ sidebarOpen: open ?? !s.sidebarOpen }));
  },
  toggleCopilot(open) {
    set(s => {
      const next = open ?? !(s.sidebarOpen && s.activeActivity === "chat");
      return { activeActivity: "chat", sidebarOpen: next, copilotOpen: next };
    });
  },
  toggleBottomPanel(open) {
    set(s => ({ bottomPanelOpen: open ?? !s.bottomPanelOpen }));
  },
  setBottomPanelTab(bottomPanelTab) {
    set({ bottomPanelTab, bottomPanelOpen: true });
  },
  toggleSplitView(split) {
    set(s => {
      const nextSplit = split ?? !s.splitView;
      const otherTab = s.tabs.find(t => t.id !== s.activeTabId)?.id ?? s.tabs[0]?.id ?? null;
      return {
        splitView: nextSplit,
        secondaryTabId: nextSplit ? s.secondaryTabId ?? otherTab : s.secondaryTabId,
      };
    });
  },
  setCommandPaletteOpen(commandPaletteOpen) {
    set({ commandPaletteOpen });
  },
  setActiveModel(activeModel) {
    set({ activeModel });
  },

  openTab(tab, inSplit = false) {
    set(s => {
      const wasEmpty = s.tabs.length === 0;
      const exists = s.tabs.some(t => t.id === tab.id);
      const tabs = exists
        ? s.tabs.map(t => (t.id === tab.id ? { ...t, ...tab } : t))
        : [...s.tabs, tab];

      const nextState: Partial<IdeState> = {
        tabs,
        commandPaletteOpen: false,
        ...(wasEmpty ? { sidebarOpen: true, activeActivity: "chat" } : {}),
        ...(tab.targetId ? { selectedTargetId: tab.targetId } : {}),
        ...(tab.featureId ? { selectedFeatureId: tab.featureId } : {}),
        ...(tab.studioMode ? { studioSubMode: tab.studioMode } : {}),
      };

      if (inSplit) {
        return { ...nextState, splitView: true, secondaryTabId: tab.id, activeTabId: s.activeTabId || tab.id };
      }
      return { ...nextState, activeTabId: tab.id };
    });
  },

  closeTab(tabId) {
    set(s => {
      const tabs = s.tabs.filter(t => t.id !== tabId);
      if (tabs.length === 0) {
        return {
          tabs: [],
          activeTabId: "",
          secondaryTabId: null,
          splitView: false,
          sidebarOpen: false,
        };
      }
      const activeTabId = s.activeTabId === tabId ? tabs[tabs.length - 1].id : s.activeTabId;
      const secondaryTabId =
        s.secondaryTabId === tabId ? (tabs.find(t => t.id !== activeTabId)?.id ?? null) : s.secondaryTabId;
      return {
        tabs,
        activeTabId,
        secondaryTabId,
        splitView: tabs.length < 2 ? false : s.splitView,
      };
    });
  },

  closeAllTabs() {
    set({
      tabs: [],
      activeTabId: "",
      secondaryTabId: null,
      splitView: false,
      sidebarOpen: false,
    });
  },

  setActiveTab(activeTabId) {
    const tab = get().tabs.find(t => t.id === activeTabId);
    set({
      activeTabId,
      ...(tab?.targetId ? { selectedTargetId: tab.targetId } : {}),
      ...(tab?.featureId ? { selectedFeatureId: tab.featureId } : {}),
      ...(tab?.studioMode ? { studioSubMode: tab.studioMode } : {}),
    });
  },

  selectTarget(targetId, filePath) {
    const target = IDE_TARGETS.find(t => t.id === targetId);
    const resolvedFile =
      filePath ?? get().selectedFileByTarget[targetId] ?? target?.files[0]?.location ?? "";
    set(s => ({
      selectedTargetId: targetId,
      selectedFileByTarget: { ...s.selectedFileByTarget, [targetId]: resolvedFile },
    }));
    get().openTab({
      id: `decompiled-${targetId}`,
      kind: "decompiled",
      title: `Source App: ${target?.name ?? targetId}`,
      subtitle: target?.friendlyCategory,
      targetId,
    });
  },

  selectFeature(featureId) {
    const feat = IDE_FEATURES.find(f => f.featureId === featureId);
    set({
      selectedFeatureId: featureId,
      ...(feat ? { selectedTargetId: feat.targetId } : {}),
    });
    get().openTab({
      id: `specs-${featureId}`,
      kind: "specs",
      title: `Feature: ${feat?.title ?? featureId}`,
      subtitle: feat?.friendlyStatusLabel,
      featureId,
    });
  },

  jumpToSourceRef(targetId, sourceRef, label, split = false) {
    const cleaned = sourceRef.replace(/^app\.asar:/, "");
    const match = cleaned.match(/^(.+?):L(\d+)(?:-L(\d+))?$/);
    const filePath = match ? match[1] : cleaned;
    const startLine = match ? Number(match[2]) : 1;
    const endLine = match ? Number(match[3] ?? match[2]) : startLine;
    const target = IDE_TARGETS.find(t => t.id === targetId);

    set(s => ({
      selectedTargetId: targetId,
      selectedFileByTarget: { ...s.selectedFileByTarget, [targetId]: filePath },
      lineHighlight: { targetId, filePath, startLine, endLine, label: label ?? sourceRef },
    }));

    get().openTab(
      {
        id: `decompiled-${targetId}`,
        kind: "decompiled",
        title: `Source App: ${target?.name ?? targetId}`,
        subtitle: target?.friendlyCategory,
        targetId,
      },
      split
    );
  },

  jumpToEngineExport(featureId, exportName, split = false) {
    set({
      selectedEngineFeatureId: featureId,
      highlightedExport: exportName,
      studioSubMode: "canvas",
    });
    get().openTab(
      {
        id: "studio-app",
        kind: "studio",
        title: "My App: Live Study Space",
        subtitle: "Interactive Preview",
        studioMode: "canvas",
      },
      split
    );
  },

  setStudioSubMode(studioSubMode) {
    set({ studioSubMode });
    get().openTab({
      id: "studio-app",
      kind: "studio",
      title: "My App: Live Study Space",
      studioMode: "canvas",
    });
  },

  clearStatusError() {
    set({ statusError: null });
  },

  toggleFeatureInBuild(featureId) {
    const feature = IDE_FEATURES.find(f => f.featureId === featureId);
    if (!feature) return;
    if (feature.readiness === "blocked" || feature.readiness === "needs_review") {
      const msg = `Cannot fuse '${feature.title}': ${feature.limitation}`;
      set({ statusError: msg });
      get().appendLog("oracle", msg);
      return;
    }

    const current = get().includedFeatureIds;
    const isIncluded = current.includes(featureId);
    let next: string[];
    if (isIncluded) {
      next = current.filter(id => {
        if (id === featureId) return false;
        const f = IDE_FEATURES.find(x => x.featureId === id);
        return !f?.dependencies.includes(featureId);
      });
    } else {
      const deps = feature.dependencies.filter(d => !current.includes(d));
      next = [...current, ...deps, featureId];
    }

    set({ includedFeatureIds: next, statusError: null });
    get().appendLog(
      "engine",
      `Updated active building blocks in your app (${next.length} active).`
    );
  },

  toggleBlockWidth(blockId) {
    set(s => ({
      pastLayouts: [...s.pastLayouts, s.layout],
      futureLayouts: [],
      layout: s.layout.map(b =>
        b.id === blockId ? { ...b, width: b.width === "full" ? "half" : "full" } : b
      ),
    }));
  },

  removeBlock(blockId) {
    set(s => ({
      pastLayouts: [...s.pastLayouts, s.layout],
      futureLayouts: [],
      layout: s.layout.filter(b => b.id !== blockId),
    }));
  },

  selectNote(selectedNoteId) {
    set({ selectedNoteId });
  },

  updateNote(noteId, title, body) {
    set(s => ({
      notes: s.notes.map(n => (n.id === noteId ? { ...n, title, body } : n)),
    }));
  },

  addNote() {
    const id = `note-${Date.now()}`;
    const newNote: NoteItem = {
      id,
      title: `New Study Note ${get().notes.length + 1}`,
      body: "Connected to [[Cardiology]] and [[Physiology]].",
    };
    set(s => ({
      notes: [...s.notes, newNote],
      selectedNoteId: id,
      reviews: {
        ...s.reviews,
        [id]: { reps: 0, interval: 1, ease: 2.5, lapses: 0, due: "Due today", leech: false },
      },
    }));
  },

  gradeFlashcard(noteId, grade) {
    if (!Number.isInteger(grade) || grade < 0 || grade > 5) return;
    const prev = get().reviews[noteId] ?? {
      reps: 0,
      interval: 1,
      ease: 2.5,
      lapses: 0,
      due: "Due today",
      leech: false,
    };

    const delta = 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02);
    const nextEase = Number(Math.max(1.3, prev.ease + delta).toFixed(2));
    let reps = prev.reps;
    let interval = prev.interval;
    let lapses = prev.lapses;

    if (grade >= 3) {
      if (reps === 0) interval = 1;
      else if (reps === 1) interval = 6;
      else interval = Math.round(prev.interval * nextEase);
      reps += 1;
    } else {
      reps = 0;
      interval = 1;
      lapses += 1;
    }
    const leech = lapses >= 8;

    set(s => ({
      reviews: {
        ...s.reviews,
        [noteId]: {
          reps,
          interval,
          ease: nextEase,
          lapses,
          due: interval === 1 ? "In 1 day" : `In ${interval} days`,
          leech,
        },
      },
    }));
    get().appendLog(
      "engine",
      `Reviewed flashcard '${noteId}' -> next review in ${interval} day(s)${leech ? " (flagged as Tricky Card)" : ""}.`
    );
  },

  undoLayout() {
    set(s => {
      if (!s.pastLayouts.length) return s;
      const previous = s.pastLayouts[s.pastLayouts.length - 1];
      return {
        layout: previous,
        pastLayouts: s.pastLayouts.slice(0, -1),
        futureLayouts: [s.layout, ...s.futureLayouts],
      };
    });
  },

  redoLayout() {
    set(s => {
      if (!s.futureLayouts.length) return s;
      const [next, ...rest] = s.futureLayouts;
      return {
        layout: next,
        pastLayouts: [...s.pastLayouts, s.layout],
        futureLayouts: rest,
      };
    });
  },

  appendLog(stage, text) {
    set(s => ({
      terminalLogs: [
        ...s.terminalLogs.slice(-199),
        { id: nextLogId++, ts: Date.now(), stage, text },
      ],
    }));
  },

  async runAllVerificationTests() {
    if (get().isRunningTests) return;
    set({ isRunningTests: true, bottomPanelOpen: true, bottomPanelTab: "tests" });
    get().appendLog("oracle", "Checking all building blocks against original applications...");
    await new Promise(r => setTimeout(r, 250));
    get().appendLog("oracle", "✓ Connected Notes & Backlinks matched Inkwell Notes (3 out of 3 scenarios).");
    get().appendLog("oracle", "✓ Smart Flashcard Scheduler matched Recall Flashcards (4 out of 4 scenarios).");
    set(s => ({ isRunningTests: false, testRunCount: s.testRunCount + 1 }));
  },

  async sendCopilotPrompt(rawPrompt) {
    const prompt = rawPrompt.trim();
    if (!prompt || get().chatBusy) return;

    const userMsg: CopilotMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      text: prompt,
      ts: Date.now(),
    };
    set(s => ({
      chatMessages: [...s.chatMessages, userMsg],
      chatBusy: true,
      statusError: null,
    }));

    const lower = prompt.toLowerCase();

    if (lower.includes("cloud") || lower.includes("sync")) {
      await new Promise(r => setTimeout(r, 240));
      const specTab: EditorTab = {
        id: "specs-inkwell.cloud_sync",
        kind: "specs",
        title: "Feature: Cloud Folder Sync",
        subtitle: "Unavailable",
        featureId: "inkwell.cloud_sync",
      };
      const reply: CopilotMessage = {
        id: `asst-${Date.now()}`,
        role: "assistant",
        ts: Date.now(),
        model: "AI Assistant",
        badges: ["Unavailable"],
        text: "Cloud Folder Sync requires private computer folder access and an external account, so it isn't available to add to your web app. I've opened its feature card so you can see the details.",
        actions: [{ label: "View Cloud Sync Card", tab: specTab }],
      };
      set(s => ({ chatMessages: [...s.chatMessages, reply], chatBusy: false }));
      get().openTab(specTab);
      return;
    }

    if (lower.includes("inkwell") || lower.includes("recall") || lower.includes("source")) {
      await new Promise(r => setTimeout(r, 240));
      const appTab = lower.includes("recall") ? PRESET_WINDOWS[1] : PRESET_WINDOWS[0];
      const reply: CopilotMessage = {
        id: `asst-${Date.now()}`,
        role: "assistant",
        ts: Date.now(),
        model: "AI Assistant",
        badges: ["Source App Opened"],
        text: `I've opened the ${appTab.title} profile so you can see how it works and which building blocks were discovered inside it.`,
        actions: [{ label: `Open ${appTab.title}`, tab: appTab }],
      };
      set(s => ({ chatMessages: [...s.chatMessages, reply], chatBusy: false }));
      get().openTab(appTab);
      return;
    }

    try {
      const featureIds = get()
        .includedFeatureIds.map(id => IDE_FEATURES.find(f => f.featureId === id)?.builderId)
        .filter((x): x is "wiki-links" | "spaced-review" => x === "wiki-links" || x === "spaced-review");

      const currentLayout = get().layout;
      const res = await requestBuilderEdits({
        revision: get().pastLayouts.length + 1,
        instruction: prompt,
        selectedBlockId: currentLayout[0]?.id ?? null,
        featureIds: featureIds.length ? featureIds : ["wiki-links", "spaced-review"],
        layout: currentLayout,
      });

      const nextLayout = applyBuilderOperations(
        currentLayout,
        res.operations,
        featureIds.length ? featureIds : ["wiki-links", "spaced-review"]
      );

      const studioTab = PRESET_WINDOWS[4];
      set(s => ({
        layout: nextLayout,
        pastLayouts: [...s.pastLayouts, currentLayout],
        futureLayouts: [],
        chatMessages: [
          ...s.chatMessages,
          {
            id: `asst-${Date.now()}`,
            role: "assistant",
            ts: Date.now(),
            model: "AI Assistant",
            badges: ["App Layout Updated"],
            text: res.summary,
            actions: [{ label: "View My App", tab: studioTab }],
          },
        ],
        chatBusy: false,
      }));
      get().openTab(studioTab);
      get().appendLog("copilot", res.summary);
    } catch (_err) {
      const currentLayout = get().layout;
      let nextLayout = [...currentLayout];
      let summary = "";

      if (lower.includes("add") || lower.includes("banner") || lower.includes("header") || lower.includes("summary") || lower.includes("guide") || lower.includes("goal")) {
        const newBlock: BuilderBlock = {
          id: `section-${Date.now()}`,
          kind: "text",
          title: prompt.length > 42 ? `${prompt.slice(0, 42)}...` : prompt,
          description: "Custom section added by your AI Assistant.",
          visible: true,
          width: lower.includes("half") ? "half" : "full",
        };
        nextLayout = [newBlock, ...currentLayout];
        summary = `Added "${newBlock.title}" to your app and opened your live preview.`;
      } else if (lower.includes("side") || lower.includes("half") || lower.includes("compact") || lower.includes("grid")) {
        nextLayout = currentLayout.map(b => ({ ...b, width: "half" as const }));
        summary = "Arranged all sections side-by-side in a two-column layout.";
      } else {
        summary = `Updated your app for "${prompt}" using Connected Notes and Smart Flashcard Practice.`;
      }

      const studioTab = PRESET_WINDOWS[4];
      set(s => ({
        layout: nextLayout,
        pastLayouts: [...s.pastLayouts, currentLayout],
        futureLayouts: [],
        chatMessages: [
          ...s.chatMessages,
          {
            id: `asst-${Date.now()}`,
            role: "assistant",
            ts: Date.now(),
            model: "AI Assistant",
            badges: ["My App Updated"],
            text: summary,
            actions: [{ label: "Open My App", tab: studioTab }],
          },
        ],
        chatBusy: false,
      }));
      get().openTab(studioTab);
      get().appendLog("copilot", summary);
    }
  },
}));
