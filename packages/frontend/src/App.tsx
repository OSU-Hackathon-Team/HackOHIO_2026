import React, { useState } from "react";
import { Cpu, Layers, Sparkles } from "lucide-react";
import type { FeatureBlueprint } from "@splice/contracts";

export default function App() {
  const [activeTab, setActiveTab] = useState<"preview" | "code">("preview");
  const [selectedApps, setSelectedApps] = useState<string[]>(["Obsidian", "Anki"]);
  const [featureQuery, setFeatureQuery] = useState(
    "Extract Obsidian wikilink graph + Anki SM-2 scheduler"
  );

  const toggleApp = (app: string) => {
    setSelectedApps((prev) =>
      prev.includes(app) ? prev.filter((a) => a !== app) : [...prev, app]
    );
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded bg-indigo-600 flex items-center justify-center font-bold text-white text-sm shadow">
            S
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight text-white leading-none">SPLICE</h1>
            <p className="text-[11px] text-slate-400 mt-0.5">Autonomous Reverse-Engineering & Feature Blender</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-950 text-emerald-400 border border-emerald-800">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            REA Engine: Ready
          </span>
        </div>
      </header>

      {/* Main Split-Screen Workspace */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
        {/* Left Column: Harvester & Ingredients (45%) */}
        <section className="lg:col-span-5 border-r border-slate-800 p-6 flex flex-col gap-6 overflow-y-auto">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
              <Layers className="w-4 h-4 text-indigo-400" /> 1. App Pantry Ingredients
            </h2>
            <div className="grid grid-cols-3 gap-3">
              {["Obsidian", "Anki", "Calculator"].map((app) => {
                const isSelected = selectedApps.includes(app);
                return (
                  <button
                    key={app}
                    onClick={() => toggleApp(app)}
                    className={`px-3 py-2.5 rounded border text-left text-xs font-medium transition-colors ${
                      isSelected
                        ? "border-indigo-600 bg-indigo-950/40 text-indigo-200"
                        : "border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-700"
                    }`}
                  >
                    {app}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-amber-400" /> 2. Feature Extraction Query
            </h2>
            <div className="flex flex-col gap-2.5">
              <input
                type="text"
                value={featureQuery}
                onChange={(e) => setFeatureQuery(e.target.value)}
                placeholder="e.g. Extract Obsidian wikilink graph + Anki SM-2 scheduler"
                className="w-full px-3.5 py-2.5 rounded bg-slate-900 border border-slate-800 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500"
              />
              <button className="px-4 py-2.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs flex items-center justify-center gap-2 transition-colors shadow">
                <Sparkles className="w-3.5 h-3.5" /> Harvest Features (SSE Stream)
              </button>
            </div>
          </div>

          <div className="flex-1 flex flex-col min-h-[160px] rounded border border-slate-800 bg-slate-900/60 p-4">
            <div className="text-[11px] font-mono font-semibold uppercase tracking-wider text-slate-400 mb-2">
              Terminal Extraction Stream
            </div>
            <div className="flex-1 text-[11px] font-mono text-slate-500 space-y-1">
              <div>[Ready] Engine awaiting harvest trigger...</div>
            </div>
          </div>
        </section>

        {/* Right Column: Live Sandpack Studio & Preview (55%) */}
        <section className="lg:col-span-7 p-6 flex flex-col gap-4 overflow-y-auto bg-slate-900/20">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex gap-2">
              <button
                onClick={() => setActiveTab("preview")}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  activeTab === "preview" ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Live Preview
              </button>
              <button
                onClick={() => setActiveTab("code")}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  activeTab === "code" ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Generated Files
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-[420px] rounded border border-slate-800 bg-slate-900/50 p-6 flex flex-col items-center justify-center text-center">
            <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center mb-3 text-slate-400">
              <Sparkles className="w-5 h-5 text-indigo-400" />
            </div>
            <h3 className="text-sm font-semibold text-slate-200">Interactive Sandpack Studio</h3>
            <p className="text-xs text-slate-400 max-w-sm mt-1">
              Trigger feature harvesting on the left to extract algorithms and fuse them into a specialized live-running micro-app.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
