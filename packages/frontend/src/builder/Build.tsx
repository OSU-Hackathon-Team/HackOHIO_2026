import { GridList, GridListItem, useDragAndDrop, type DropItem } from "react-aria-components";
import { GripVertical, Plus, LayoutTemplate, EyeOff, ArrowRight } from "lucide-react";
import { SAMPLE_FEATURES } from "@splice/contracts";
import { useBuilder } from "./useBuilder";
import { activeProject } from "./store";
import { Action } from "./ui";
import { SectionContent } from "./Preview";
import { cn } from "../lib/cn";

export function FeatureLibrary({ onAdd }: { onAdd?: () => void }) {
  const state = useBuilder(s => s), project = activeProject(state)!;
  const features = SAMPLE_FEATURES.filter(f => f.status === "sample");
  const { dragAndDropHooks } = useDragAndDrop({
    getItems: keys => [...keys].map(id => ({ "application/x-splice-feature": String(id), "text/plain": String(id) })),
    getAllowedDropOperations: () => ["copy"],
  });
  return <section><h3 className="text-sm font-semibold">Feature library</h3><p className="mt-2 text-pretty text-xs leading-5 text-slate-500">Drag a feature into the layout, or choose Add. Only checked sample implementations can be used.</p>
    <GridList aria-label="Feature library" items={features} dragAndDropHooks={dragAndDropHooks} className="mt-4 grid gap-3 outline-none">{feature => <GridListItem id={feature.id} textValue={feature.title} className="rounded-xl border border-slate-200 bg-white p-3 outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
      <div className="flex items-center gap-1"><Action slot="drag" tone="quiet" aria-label={`Drag ${feature.title}`} className="min-h-11 px-1"><GripVertical size={15} aria-hidden="true" /></Action><h4 className="text-sm font-medium">{feature.title}</h4></div>
      <p className="mt-1 text-pretty text-xs leading-5 text-slate-500">{feature.description}</p><p className="mt-2 text-xs text-slate-400">Sample · {feature.checks} local checks</p>
      <Action className="mt-3 w-full" isDisabled={!project.sampleAnalysis || project.featureIds.includes(feature.id) || state.busy} onPress={() => { state.addFeature(feature.id); onAdd?.(); }}>{project.featureIds.includes(feature.id) ? "Added to app" : `Add ${feature.title}`}</Action>
    </GridListItem>}</GridList>
    {!project.sampleAnalysis && <p className="mt-3 text-xs text-slate-500">Open sample analysis in Explore before adding these features.</p>}
    <Action className="mt-4 w-full" isDisabled={!project.sampleAnalysis || state.busy} onPress={() => { state.addText(); onAdd?.(); }}><Plus size={14} aria-hidden="true" />Add heading / text</Action>
  </section>;
}
export function Build() {
  const state = useBuilder(s => s), project = activeProject(state)!;
  async function insert(items: Iterable<DropItem>, index: number) {
    for (const item of items) if (item.kind === "text" && item.types.has("application/x-splice-feature")) state.addFeature(await item.getText("application/x-splice-feature"),index);
  }
  const { dragAndDropHooks } = useDragAndDrop({
    getItems: keys => [...keys].map(id => ({ "application/x-splice-section": String(id), "text/plain": String(id) })),
    isDisabled: state.busy,
    acceptedDragTypes: ["application/x-splice-feature", "application/x-splice-section"],
    onRootDrop: event => insert(event.items,project.layout.length),
    onInsert: event => insert(event.items,project.layout.findIndex(b => b.id === event.target.key) + (event.target.dropPosition === "after" ? 1 : 0)),
    onReorder: event => {
      const id = String([...event.keys][0]), from = project.layout.findIndex(b => b.id === id);
      let to = project.layout.findIndex(b => b.id === event.target.key) + (event.target.dropPosition === "after" ? 1 : 0);
      if (from < to) to--; state.moveBlock(id,to);
    },
  });
  return <div className="p-4 md:p-7">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-balance text-lg font-semibold">{state.trying ? "Try your app" : "Make it feel like yours"}</h2><p className="mt-1 text-xs text-slate-500">{state.trying ? "The sample engines power these interactions. Your data stays on this device." : "Drag sections to arrange them. Select one to edit it, or ask the assistant."}</p></div><span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-500">Sample build</span></div>
    {!project.layout.length ? <div className="flex min-h-96 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center"><LayoutTemplate size={32} className="text-slate-300" aria-hidden="true" /><h3 className="mt-5 text-balance text-xl font-semibold">Your ideas take shape here</h3><p className="mt-2 max-w-sm text-pretty text-sm leading-6 text-slate-500">Start with a useful behavior. Add linked notes and a review schedule, then arrange the app your way.</p><Action tone="primary" className="mt-5" onPress={() => state.addFeature("wiki-links")} isDisabled={!project.sampleAnalysis}>Add linked notes <ArrowRight size={16} aria-hidden="true" /></Action><GridList aria-label="Empty app layout drop zone" items={[]} dragAndDropHooks={dragAndDropHooks} renderEmptyState={() => <span>Or drop a feature here</span>} className="mt-4 min-h-16 w-full rounded-xl border border-dashed border-slate-200 p-4 text-xs text-slate-400 data-[drop-target]:bg-blue-50" /></div>
      : state.trying ? <div className="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:grid-cols-2">{project.layout.filter(b => b.visible).map(block => <article key={block.id} aria-label={block.title} className={cn("min-w-0 rounded-xl p-2",block.width === "full" && "sm:col-span-2")}><SectionContent block={block} interactive /></article>)}{!project.layout.some(b => b.visible) && <p className="p-5 text-sm text-slate-500">All sections are hidden. Return to Edit layout to show one.</p>}</div>
      : <GridList aria-label="App layout" items={project.layout} dragAndDropHooks={dragAndDropHooks} className="grid grid-cols-1 gap-4 outline-none sm:grid-cols-2">{block => <GridListItem id={block.id} textValue={block.title} onAction={() => state.selectBlock(block.id)} className={cn("relative min-w-0 rounded-xl border bg-white outline-none focus-visible:ring-2 focus-visible:ring-blue-600", block.width === "full" && "sm:col-span-2", state.selectedBlock === block.id ? "border-blue-500 ring-2 ring-blue-100" : "border-slate-200")}>
        <div className="relative z-20 flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-1"><Action slot="drag" tone="quiet" aria-label={`Drag section ${block.title}`} isDisabled={state.busy} className="px-1 text-xs"><GripVertical size={14} aria-hidden="true" />{block.kind}</Action><span className="inline-flex items-center gap-1 text-xs text-slate-400">{!block.visible && <EyeOff size={13} aria-hidden="true" />}{block.visible ? block.width === "full" ? "Full width" : "Half width" : "Hidden"}</span></div>
        <Action tone="quiet" aria-label={`Edit section ${block.title}`} className="absolute inset-x-0 bottom-0 top-12 z-10 rounded-b-xl hover:bg-transparent focus-visible:ring-inset" onPress={() => state.selectBlock(block.id)}><span className="sr-only">Edit {block.title}</span></Action>
        <div className={cn("p-5", !block.visible && "opacity-40")}><SectionContent block={block} interactive={false} /></div>
      </GridListItem>}</GridList>}
    <p className="mt-5 text-center text-xs leading-5 text-slate-400">Sample implementations are locked. Original application behavior has not been verified.</p>
  </div>;
}

