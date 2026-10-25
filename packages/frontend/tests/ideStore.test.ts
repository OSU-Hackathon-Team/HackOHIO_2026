import test from "node:test";
import assert from "node:assert/strict";
import { useIdeStore, PRESET_WINDOWS } from "../src/ide/store/useIdeStore";
import { IDE_FEATURES } from "../src/ide/data/ideFixtures";

test("IDE store starts calm with zero open tabs and closed side/bottom panels", () => {
  useIdeStore.getState().closeAllTabs();
  const s = useIdeStore.getState();
  assert.equal(s.tabs.length, 0);
  assert.equal(s.sidebarOpen, false);
  assert.equal(s.bottomPanelOpen, false);
  assert.deepEqual(s.includedFeatureIds, [
    "inkwell.wikilink_graph",
    "recall.sm2_scheduler",
  ]);
});

test("opening the first tab opens that window and docks Copilot into the left sidebar", () => {
  const store = useIdeStore.getState();
  store.closeAllTabs();

  store.openTab(PRESET_WINDOWS[0]);
  const s = useIdeStore.getState();
  assert.equal(s.tabs.length, 1);
  assert.equal(s.activeTabId, PRESET_WINDOWS[0].id);
  assert.equal(s.sidebarOpen, true);
  assert.equal(s.activeActivity, "chat");

  store.closeAllTabs();
  const afterClose = useIdeStore.getState();
  assert.equal(afterClose.tabs.length, 0);
  assert.equal(afterClose.sidebarOpen, false);
});

test("jumpToSourceRef opens the decompiled tab at the exact file and line range", () => {
  const store = useIdeStore.getState();
  store.closeAllTabs();
  store.jumpToSourceRef(
    "recall",
    "src/scheduler/sm2.js:L21-L24",
    "REQ-2: interval expansion",
    true
  );

  const next = useIdeStore.getState();
  assert.equal(next.selectedTargetId, "recall");
  assert.equal(next.selectedFileByTarget.recall, "src/scheduler/sm2.js");
  assert.deepEqual(next.lineHighlight, {
    targetId: "recall",
    filePath: "src/scheduler/sm2.js",
    startLine: 21,
    endLine: 24,
    label: "REQ-2: interval expansion",
  });
  assert.equal(next.splitView, true);
  assert.equal(next.secondaryTabId, "decompiled-recall");
});

test("toggleFeatureInBuild enforces Engineer 2 gating on blocked and needs_review findings", () => {
  const store = useIdeStore.getState();
  store.clearStatusError();

  store.toggleFeatureInBuild("inkwell.cloud_sync");
  let next = useIdeStore.getState();
  assert.equal(next.includedFeatureIds.includes("inkwell.cloud_sync"), false);
  assert.match(next.statusError ?? "", /Cannot (fuse|add) '(Cloud Folder Sync|Cloud Backup & Folder Sync)'/);

  store.toggleFeatureInBuild("inkwell.fuzzy_search");
  next = useIdeStore.getState();
  assert.equal(next.includedFeatureIds.includes("inkwell.fuzzy_search"), false);
  assert.match(next.statusError ?? "", /Cannot (fuse|add) '(Instant Title Search|Quick Note Finder)'/);
});

test("verification reports bundled oracle results honestly and labels native checks as local", async () => {
  const store = useIdeStore;
  store.setState({
    includedFeatureIds: ["mockpriority.priority_score"],
    nativeHandoff: null,
    terminalLogs: [],
    testRunCount: 0,
    isRunningTests: false,
  });

  await store.getState().runAllVerificationTests();
  const logs = store.getState().terminalLogs.map(entry => entry.text).join("\n");
  const feature = IDE_FEATURES.find(item => item.featureId === "mockpriority.priority_score")!;
  assert.match(logs, /local engine checks passed/);
  assert.match(logs, /original behavior was not exercised/);
  assert.doesNotMatch(logs, /matched .* original/);
  assert.equal(store.getState().testRunCount, 1);
  assert.equal(store.getState().isRunningTests, false);
  assert.ok(feature.blueprint);
});

test("gradeFlashcard executes clean-room SM-2 schedule with ease floor 1.30 and leech threshold 8", () => {
  const store = useIdeStore.getState();
  store.gradeFlashcard("pharmacology", 1);
  const afterLapse = useIdeStore.getState().reviews.pharmacology;
  assert.equal(afterLapse.reps, 0);
  assert.equal(afterLapse.interval, 1);
  assert.equal(afterLapse.lapses >= 8, true);
  assert.equal(afterLapse.ease >= 1.3, true);
  assert.equal(afterLapse.leech, true);
});
