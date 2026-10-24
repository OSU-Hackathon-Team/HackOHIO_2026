import {
  DisclosureGroup,
  Disclosure,
  DisclosurePanel,
  Heading,
  DialogTrigger,
  ModalOverlay,
  Modal,
  Dialog,
} from "react-aria-components";
import {
  ChevronRight,
  AppWindow,
  ArrowUpRight,
  Check,
  Plus,
  LockKeyhole,
} from "lucide-react";
import { IDE_TARGETS, IDE_FEATURES } from "./data/ideFixtures";
import { useIdeStore } from "./store/useIdeStore";
import { WorkspaceButton } from "./WorkspaceButton";
import { cn } from "../lib/cn";

export function AppLibrary() {
  const selectedId = useIdeStore((s) => s.selectedFeatureId);
  const included = useIdeStore((s) => s.includedFeatureIds);
  const busy = useIdeStore((s) => s.chatBusy);
  const toggle = useIdeStore((s) => s.toggleFeatureInBuild);
  const select = (id: string) =>
    useIdeStore.setState({ selectedFeatureId: id });
  const feature = IDE_FEATURES.find((f) => f.featureId === selectedId);
  const available =
    feature &&
    feature.readiness !== "blocked" &&
    feature.readiness !== "needs_review";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-stone-800 px-8 py-6">
        <h1 className="text-2xl font-semibold">App library</h1>
        <p className="mt-2 text-sm leading-6 text-stone-400">
          Open an application to explore the building blocks it contains.
        </p>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-5">
        <section
          aria-label="Source applications"
          className="col-span-2 overflow-y-auto border-r border-stone-800 p-6"
        >
          <div className="mb-5 flex items-center justify-between text-xs text-stone-400">
            <span>Source applications</span>
            <span className="tabular-nums">
              {IDE_TARGETS.length} applications
            </span>
          </div>
          <DisclosureGroup
            allowsMultipleExpanded
            className="divide-y divide-stone-800"
          >
            {IDE_TARGETS.map((app) => {
              const features = IDE_FEATURES.filter(
                (f) => f.targetId === app.id,
              );
              return (
                <Disclosure key={app.id} id={app.id} className="group py-2">
                  <Heading level={2}>
                    <WorkspaceButton
                      slot="trigger"
                      className="w-full justify-start px-2 py-4 text-left"
                    >
                      <ChevronRight
                        className="size-4 shrink-0 text-stone-500 group-data-[expanded]:rotate-90"
                        aria-hidden="true"
                      />
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-stone-700 bg-stone-800">
                        <AppWindow
                          className="size-5 text-stone-300"
                          aria-hidden="true"
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-stone-100">
                          {app.name}
                        </span>
                        <span className="mt-1 block text-xs font-normal text-stone-400">
                          {app.friendlyCategory}
                        </span>
                      </span>
                      <span className="tabular-nums text-xs text-stone-500">
                        {features.length}
                      </span>
                    </WorkspaceButton>
                  </Heading>
                  <DisclosurePanel>
                    <ul className="mb-4 ml-5 border-l border-stone-700 pl-5">
                      {features.map((f) => (
                        <li key={f.featureId}>
                          <WorkspaceButton
                            aria-pressed={selectedId === f.featureId}
                            className={cn(
                              "my-1 w-full justify-between px-3 py-3 text-left",
                              selectedId === f.featureId &&
                                "bg-stone-800 text-stone-100",
                            )}
                            onPress={() => select(f.featureId)}
                          >
                            <span>
                              <span className="block text-sm">{f.title}</span>
                              <span className="mt-1 block text-xs font-normal text-stone-400">
                                {f.readiness === "blocked"
                                  ? "Unavailable"
                                  : f.readiness === "needs_review"
                                    ? "Needs review"
                                    : included.includes(f.featureId)
                                      ? "Added to my app"
                                      : "Available"}
                              </span>
                            </span>
                            {included.includes(f.featureId) ? (
                              <Check
                                className="size-4 shrink-0 text-amber-400"
                                aria-label="Added"
                              />
                            ) : (
                              <ChevronRight
                                className="size-4 shrink-0 text-stone-500"
                                aria-hidden="true"
                              />
                            )}
                          </WorkspaceButton>
                        </li>
                      ))}
                    </ul>
                  </DisclosurePanel>
                </Disclosure>
              );
            })}
          </DisclosureGroup>
          <p className="mt-8 text-xs leading-5 text-stone-500">
            Bundled example applications. These are not results from an
            application you uploaded.
          </p>
        </section>
        <section
          aria-label="Feature details"
          className="col-span-3 overflow-y-auto px-8 py-7"
        >
          {feature ? (
            <div className="mx-auto max-w-2xl">
              <p className="text-xs text-stone-400">
                {feature.sourceApp}{" "}
                <span className="mx-2 text-stone-600">/</span> Building block
              </p>
              <div className="mt-5 flex items-start justify-between gap-5">
                <h2 className="text-2xl font-semibold leading-snug">
                  {feature.title}
                </h2>
                <span className="shrink-0 rounded border border-stone-700 px-2 py-1 text-xs text-stone-400">
                  {available
                    ? "Example feature"
                    : feature.readiness === "blocked"
                      ? "Unavailable"
                      : "Needs review"}
                </span>
              </div>
              <p className="mt-4 text-base leading-7 text-stone-300">
                {feature.summary}
              </p>
              <p className="mt-3 text-sm leading-6 text-stone-400">
                {feature.everydayBenefit}
              </p>
              <div className="my-7 flex flex-wrap items-center gap-3">
                {available ? (
                  <WorkspaceButton
                    primary
                    isDisabled={busy || included.includes(feature.featureId)}
                    onPress={() => {
                      if (!included.includes(feature.featureId))
                        toggle(feature.featureId);
                    }}
                  >
                    {included.includes(feature.featureId) ? (
                      <Check className="size-4" aria-hidden="true" />
                    ) : (
                      <Plus className="size-4" aria-hidden="true" />
                    )}
                    {included.includes(feature.featureId)
                      ? "Added to my app"
                      : "Add to my app"}
                  </WorkspaceButton>
                ) : (
                  <p className="flex items-center gap-2 text-sm text-stone-400">
                    <LockKeyhole className="size-4" aria-hidden="true" />
                    {feature.readiness === "blocked"
                      ? "This feature is unavailable for reuse."
                      : "Review is required before this feature can be added."}
                  </p>
                )}
                {included.includes(feature.featureId) && (
                  <WorkspaceButton
                    onPress={() =>
                      useIdeStore.getState().setWorkspacePage("app")
                    }
                  >
                    Open my app{" "}
                    <ArrowUpRight className="size-4" aria-hidden="true" />
                  </WorkspaceButton>
                )}
              </div>
              {available && included.includes(feature.featureId) && (
                <DialogTrigger>
                  <WorkspaceButton className="mb-6 border border-stone-700">
                    Remove from my app
                  </WorkspaceButton>
                  <ModalOverlay className="builder-modal fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6">
                    <Modal className="w-full max-w-md rounded-xl border border-stone-700 bg-stone-900 p-6">
                      <Dialog role="alertdialog" className="outline-none">
                        {({ close }) => (
                          <>
                            <Heading
                              slot="title"
                              className="text-lg font-semibold"
                            >
                              Remove this feature?
                            </Heading>
                            <p className="mt-3 text-sm leading-6 text-stone-400">
                              Its app sections and any features that depend on
                              it will be removed. Your notes and conversation
                              will be kept.
                            </p>
                            <div className="mt-6 flex justify-end gap-2">
                              <WorkspaceButton autoFocus onPress={close}>
                                Keep feature
                              </WorkspaceButton>
                              <WorkspaceButton
                                primary
                                onPress={() => {
                                  toggle(feature.featureId);
                                  close();
                                }}
                              >
                                Remove feature
                              </WorkspaceButton>
                            </div>
                          </>
                        )}
                      </Dialog>
                    </Modal>
                  </ModalOverlay>
                </DialogTrigger>
              )}
              {!!feature.dependencies.length && (
                <div className="mb-6 border-l-2 border-amber-400 pl-4">
                  <h3 className="text-sm font-medium">Included dependencies</h3>
                  <p className="mt-2 text-sm leading-6 text-stone-400">
                    {feature.dependencies
                      .map(
                        (id) =>
                          IDE_FEATURES.find((f) => f.featureId === id)?.title ??
                          id,
                      )
                      .join(", ")}{" "}
                    will be added automatically if needed.
                  </p>
                </div>
              )}
              <div className="border-t border-stone-800 pt-6">
                <h3 className="text-sm font-semibold">How it works</h3>
                <ol className="mt-5 space-y-6">
                  {feature.plainRules.map((rule, i) => (
                    <li key={rule.id} className="flex gap-4">
                      <span className="pt-0.5 font-mono text-xs tabular-nums text-stone-500">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <div className="min-w-0">
                        <h4 className="text-sm font-medium text-stone-200">
                          {rule.title}
                        </h4>
                        <p className="mt-2 text-sm leading-6 text-stone-400">
                          {rule.explanation}
                        </p>
                        <dl className="mt-3 grid gap-2 rounded-lg bg-stone-900 p-4 text-xs leading-5">
                          <div>
                            <dt className="text-stone-500">Example input</dt>
                            <dd className="mt-1 break-words text-stone-300">
                              {rule.exampleInput}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-stone-500">Result</dt>
                            <dd className="mt-1 break-words text-stone-300">
                              {rule.exampleOutput}
                            </dd>
                          </div>
                        </dl>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="mt-7 border-t border-stone-800 pt-5">
                <h3 className="text-sm font-semibold">Limitations</h3>
                <p className="mt-2 text-sm leading-6 text-stone-400">
                  {feature.limitation}
                </p>
              </div>
              <Disclosure className="group mt-5 border-t border-stone-800 py-2">
                <Heading level={2}>
                  <WorkspaceButton
                    slot="trigger"
                    className="w-full justify-between px-0"
                  >
                    Evidence and checks
                    <ChevronRight
                      className="size-4 group-data-[expanded]:rotate-90"
                      aria-hidden="true"
                    />
                  </WorkspaceButton>
                </Heading>
                <DisclosurePanel>
                  <p className="text-sm leading-6 text-stone-400">
                    This library uses bundled fixtures.{" "}
                    {feature.spec
                      ? `The fixture reports ${feature.spec.oracle.passed} of ${feature.spec.oracle.total} oracle checks passed.`
                      : "No executable specification is supplied for this feature."}{" "}
                    No live analysis was performed in this session.
                  </p>
                </DisclosurePanel>
              </Disclosure>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <AppWindow className="size-8 text-stone-600" aria-hidden="true" />
              <h2 className="mt-4 text-lg font-medium">
                Find a useful building block
              </h2>
              <p className="mt-2 max-w-sm text-sm leading-6 text-stone-400">
                Expand a source application, then select a feature to understand
                what it does.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
