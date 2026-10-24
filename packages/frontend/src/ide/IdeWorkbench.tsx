import { useState } from "react";
import {
  DialogTrigger,
  ModalOverlay,
  Modal,
  Dialog,
  Heading,
  TextField,
  Label,
  Input,
} from "react-aria-components";
import {
  Layers,
  MessageSquare,
  AppWindow,
  PanelsTopLeft,
  Pencil,
  Undo2,
  Redo2,
} from "lucide-react";
import { useIdeStore } from "./store/useIdeStore";
import { WorkspaceButton } from "./WorkspaceButton";
import { ChatPage } from "./ChatPage";
import { AppLibrary } from "./AppLibrary";
import { StudioView } from "./views/StudioView";
import { cn } from "../lib/cn";

const destinations = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "library", label: "App library", icon: AppWindow },
  { id: "app", label: "My app", icon: PanelsTopLeft },
] as const;
export function IdeWorkbench() {
  const state = useIdeStore();
  return (
    <div className="flex h-dvh min-w-[960px] overflow-hidden bg-[#181614] font-sans text-stone-100">
      <a
        href="#workspace"
        className="sr-only z-50 rounded bg-amber-400 p-3 text-stone-950 focus:not-sr-only focus:absolute"
      >
        Skip to workspace
      </a>
      <aside className="flex w-56 shrink-0 flex-col border-r border-stone-800 bg-[#141210] px-4 py-6">
        <div className="mb-9 flex items-center gap-2 px-3 text-lg font-semibold">
          <Layers className="size-5 text-amber-400" aria-hidden="true" />
          Splice
        </div>
        <DialogTrigger>
          <WorkspaceButton
            aria-label="Rename project"
            className="mb-6 justify-between border border-stone-800 text-left"
          >
            <span className="truncate">{state.projectTitle}</span>
            <Pencil
              className="size-3.5 shrink-0 text-stone-500"
              aria-hidden="true"
            />
          </WorkspaceButton>
          <ModalOverlay
            isDismissable
            className="builder-modal fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
          >
            <Modal className="w-full max-w-md rounded-xl border border-stone-700 bg-stone-900 p-6">
              <Dialog className="outline-none">
                {({ close }) => <RenameProject close={close} />}
              </Dialog>
            </Modal>
          </ModalOverlay>
        </DialogTrigger>
        <nav aria-label="Workspace navigation" className="grid gap-2">
          {destinations.map((item) => (
            <WorkspaceButton
              key={item.id}
              aria-current={
                state.workspacePage === item.id ? "page" : undefined
              }
              onPress={() => state.setWorkspacePage(item.id)}
              className={cn(
                "justify-start px-3",
                state.workspacePage === item.id &&
                  "bg-stone-800 text-stone-100",
              )}
            >
              <item.icon
                className={cn(
                  "size-4",
                  state.workspacePage === item.id
                    ? "text-amber-400"
                    : "text-stone-500",
                )}
                aria-hidden="true"
              />
              {item.label}
            </WorkspaceButton>
          ))}
        </nav>
        <div className="mt-auto border-t border-stone-800 px-3 pt-5">
          <p className="text-xs font-medium text-stone-400">
            Example workspace
          </p>
          <p className="mt-2 text-xs leading-5 text-stone-500">
            Explore bundled source apps and build with their features.
          </p>
        </div>
      </aside>
      <main id="workspace" className="min-w-0 flex-1 overflow-clip">
        <div hidden={state.workspacePage !== "chat"} className="h-full">
          <ChatPage />
        </div>
        <div hidden={state.workspacePage !== "library"} className="h-full">
          <AppLibrary />
        </div>
        <div hidden={state.workspacePage !== "app"} className="h-full">
          <div className="flex h-full flex-col">
            <header className="flex min-h-16 shrink-0 items-center justify-between border-b border-stone-800 px-8">
              <h1 className="text-sm font-medium">My app</h1>
              <div className="flex gap-1">
                <WorkspaceButton
                  aria-label="Undo layout change"
                  isDisabled={!state.pastLayouts.length || state.chatBusy}
                  onPress={state.undoLayout}
                >
                  <Undo2 className="size-4" aria-hidden="true" />
                </WorkspaceButton>
                <WorkspaceButton
                  aria-label="Redo layout change"
                  isDisabled={!state.futureLayouts.length || state.chatBusy}
                  onPress={state.redoLayout}
                >
                  <Redo2 className="size-4" aria-hidden="true" />
                </WorkspaceButton>
                <WorkspaceButton onPress={() => state.setWorkspacePage("chat")}>
                  Edit with assistant
                </WorkspaceButton>
              </div>
            </header>
            {state.statusError && (
              <p
                role="alert"
                className="border-b border-red-900 bg-red-950/20 px-8 py-3 text-sm text-red-200"
              >
                {state.statusError}
              </p>
            )}
            <div className="min-h-0 flex-1">
              <StudioView />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
function RenameProject({ close }: { close: () => void }) {
  const state = useIdeStore(),
    [title, setTitle] = useState(state.projectTitle);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        state.setProjectTitle(title.trim());
        close();
      }}
    >
      <Heading slot="title" className="mb-5 text-lg font-semibold">
        Name your project
      </Heading>
      <TextField value={title} onChange={setTitle} className="grid gap-2">
        <Label className="text-sm text-stone-400">Project name</Label>
        <Input
          autoFocus
          maxLength={100}
          className="min-h-11 rounded-lg border border-stone-700 bg-stone-950 px-3 text-sm outline-none focus:ring-2 focus:ring-amber-400"
        />
      </TextField>
      <div className="mt-5 flex justify-end gap-2">
        <WorkspaceButton onPress={close}>Cancel</WorkspaceButton>
        <WorkspaceButton primary type="submit" isDisabled={!title.trim()}>
          Save name
        </WorkspaceButton>
      </div>
    </form>
  );
}
