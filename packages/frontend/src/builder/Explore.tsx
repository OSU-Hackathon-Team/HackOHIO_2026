import { ArrowRight, BookOpen, Clock3, Search, Cloud, Check, LockKeyhole, GitBranch, ScanLine, ShieldCheck, PackageCheck } from "lucide-react";
import { SAMPLE_FEATURES } from "@splice/contracts";
import { useBuilder } from "./useBuilder";
import { activeProject } from "./store";
import { Action } from "./ui";
import { cn } from "../lib/cn";
const icons = { "wiki-links": BookOpen, "spaced-review": Clock3, "fuzzy-search": Search, "cloud-sync": Cloud };
export function Explore() {
  const state = useBuilder(s => s), project = activeProject(state)!;
  if (!project.sampleAnalysis) return <div className="flex min-h-96 flex-col items-center justify-center p-8 text-center"><ScanLine className="size-10 text-slate-300" aria-hidden="true" /><h2 className="mt-5 text-balance text-2xl font-semibold">Your application has not been analyzed</h2><p className="mt-3 max-w-lg text-pretty text-sm leading-6 text-slate-500">The native engine connection is a future milestone. Attached files are only names and sizes; we won't present example findings as results from your files.</p><Action tone="primary" className="mt-6" onPress={state.useSample}>Explore sample analysis instead <ArrowRight size={16} aria-hidden="true" /></Action></div>;
  return <div className="p-5 md:p-8">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-medium text-blue-700">EXPLORE THE EXAMPLE</p><h2 className="mt-2 text-balance text-2xl font-semibold">Useful behaviors, brought into focus.</h2><p className="mt-2 max-w-xl text-pretty text-sm leading-6 text-slate-500">A map of what these sample applications can do. Pick a feature to inspect its evidence and decide what belongs in your app.</p></div><span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500">Sample results · not live analysis</span></div>
    {!!project.sources.length && <p className="mt-4 rounded-lg border border-slate-200 bg-white p-3 text-pretty text-xs text-slate-600">Your attached files remain unanalyzed. The map below describes Inkwell Notes and Recall Flashcards sample data.</p>}
    <ol aria-label="Analysis stages" className="my-7 grid gap-2 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-4">
      {[{ icon: ScanLine, title: "Read application", detail: "Sample metadata" },{ icon: GitBranch,title: "Find behaviors",detail: "4 sample findings" },{ icon: ShieldCheck,title: "Check evidence",detail: "Original tests not run" },{ icon: PackageCheck,title: "Prepare features",detail: "2 usable samples" }].map((stage,i) => <li key={stage.title} className="flex items-start gap-2 p-2"><stage.icon className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden="true" /><div><p className="text-xs font-medium text-slate-700"><span className="tabular-nums text-slate-400">{i+1}.</span> {stage.title}</p><p className="mt-1 text-xs text-slate-500">{stage.detail}</p></div></li>)}
    </ol>
    <div className="mb-4 flex items-center justify-between"><h3 className="text-sm font-semibold">Feature map</h3><p className="text-xs text-slate-500">Select a finding to learn more</p></div>
    <div className="grid gap-6 lg:grid-cols-2">
      {["Inkwell Notes","Recall Flashcards"].map(source => <section key={source} aria-label={source}>
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"><span className="flex size-9 items-center justify-center rounded-lg bg-slate-100">{source.startsWith("Inkwell") ? <BookOpen size={18} aria-hidden="true" /> : <Clock3 size={18} aria-hidden="true" />}</span><div><h3 className="text-sm font-semibold">{source}</h3><p className="text-xs text-slate-500">Sample source application</p></div></div>
        <ul className="ml-4 space-y-4 border-l border-slate-200 pl-4">{SAMPLE_FEATURES.filter(f => f.source === source).map(feature => {
          const Icon = icons[feature.id], added = project.featureIds.includes(feature.id);
          return <li key={feature.id} className={cn("rounded-xl border bg-white p-4",state.selectedFeature === feature.id ? "border-blue-500 ring-2 ring-blue-100" : "border-slate-200")}>
            <div className="flex items-center gap-2.5"><Icon size={18} className="text-slate-500" aria-hidden="true" /><h4 className="text-sm font-semibold">{feature.title}</h4></div>
            <p className="mt-3 text-pretty text-sm leading-6 text-slate-500">{feature.description}</p>
            <p className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">{feature.status === "sample" ? <><Check size={12} aria-hidden="true" />Available for sample build</> : <><LockKeyhole size={12} aria-hidden="true" />{feature.status === "blocked" ? "Blocked" : "Needs review"}</>}</p>
            {!!feature.dependencies.length && <p className="mt-2 text-xs text-slate-500">Uses linked notes as its card source</p>}
            <div className="mt-4 flex flex-wrap gap-2"><Action className="flex-1" onPress={() => state.selectFeature(feature.id)} aria-label={`Inspect ${feature.title}`}>Inspect feature</Action>{feature.status === "sample" && <Action className="flex-1" tone={added ? "neutral" : "primary"} isDisabled={added || state.busy} onPress={() => state.addFeature(feature.id)}>{added ? "Added to app" : "Add to app"}</Action>}</div>
          </li>;
        })}</ul>
      </section>)}
    </div>
    {!!project.featureIds.length && <div className="mt-7 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-100 bg-blue-50 p-4"><div><p className="text-sm font-semibold text-slate-800">{project.featureIds.length} sample features in your app</p><p className="mt-1 text-xs text-slate-500">Your selected behaviors are ready to arrange and try.</p></div><Action tone="primary" onPress={() => state.mode("build")}>Open app builder <ArrowRight size={16} aria-hidden="true" /></Action></div>}
  </div>;
}

