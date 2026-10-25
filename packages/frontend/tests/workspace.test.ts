import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useIdeStore, PRESET_WINDOWS } from "../src/ide/store/useIdeStore";
import { assertLayoutFeatures } from "@splice/contracts";

beforeEach(() => {
  useIdeStore.getState().cancelCopilotPrompt();
  useIdeStore.setState(useIdeStore.getInitialState(), true);
});
test("navigation links open the library or app while preserving chat", () => {
  const state = useIdeStore.getState(),
    chat = state.chatMessages;
  assert.equal(state.workspacePage, "chat");
  state.openTab(PRESET_WINDOWS[0]);
  assert.equal(useIdeStore.getState().workspacePage, "library");
  state.openTab(PRESET_WINDOWS[4]);
  assert.equal(useIdeStore.getState().workspacePage, "app");
  state.setWorkspacePage("chat");
  assert.equal(useIdeStore.getState().chatMessages, chat);
});
test("removing and re-adding a feature keeps section dependencies valid without losing notes", () => {
  const state = useIdeStore.getState(),
    notes = state.notes;
  state.toggleFeatureInBuild("inkwell.wikilink_graph");
  assert.deepEqual(useIdeStore.getState().includedFeatureIds, []);
  assert.equal(useIdeStore.getState().layout.length, 0);
  state.toggleFeatureInBuild("recall.sm2_scheduler");
  assertLayoutFeatures(useIdeStore.getState().layout, [
    "wiki-links",
    "spaced-review",
  ]);
  assert.deepEqual(
    useIdeStore.getState().layout.map((b) => b.kind),
    ["notes", "backlinks", "reviews"],
  );
  assert.equal(useIdeStore.getState().notes, notes);
});
test("backend failure is visible and never manufactures a successful app edit", async () => {
  const original = globalThis.fetch,
    layout = useIdeStore.getState().layout;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "503 model unavailable" }), {
      status: 503,
    });
  try {
    await useIdeStore.getState().sendCopilotPrompt("Add a banner");
    const state = useIdeStore.getState();
    assert.equal(state.layout, layout);
    assert.match(state.statusError!, /503 model unavailable/);
    assert.equal(state.chatBusy, false);
    assert.equal(state.chatMessages.length, 2);
    assert.equal(state.workspacePage, "chat");
  } finally {
    globalThis.fetch = original;
  }
});
test("late cancelled replies cannot change the app or clear a newer request", async () => {
  const original = globalThis.fetch;
  const replies: ((r: Response) => void)[] = [];
  globalThis.fetch = async () =>
    new Promise((resolve) => {
      replies.push(resolve);
    });
  const answer = () =>
    new Response(
      JSON.stringify({
        revision: 999,
        model: "test",
        summary: "Late",
        operations: [],
      }),
    );
  try {
    const first = useIdeStore.getState().sendCopilotPrompt("First edit");
    useIdeStore.getState().cancelCopilotPrompt();
    const second = useIdeStore.getState().sendCopilotPrompt("Second edit");
    replies[0](answer());
    await first;
    assert.equal(useIdeStore.getState().chatBusy, true);
    useIdeStore.getState().cancelCopilotPrompt();
    replies[1](answer());
    await second;
    assert.equal(useIdeStore.getState().chatMessages.length, 3);
    assert.equal(useIdeStore.getState().pastLayouts.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
test("local library guidance stays in chat and is labeled as a project guide", async () => {
  await useIdeStore
    .getState()
    .sendCopilotPrompt("Why is cloud sync unavailable?");
  const state = useIdeStore.getState();
  assert.equal(state.workspacePage, "chat");
  assert.equal(state.chatMessages.at(-1)?.model, "Project guide");
  assert.ok(state.chatMessages.at(-1)?.actions?.length);
});
