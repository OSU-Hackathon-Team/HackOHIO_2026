# 07 — Components

> **Core Studio milestone:** setup, typed API/SSE, Zustand orchestration, development seeds, pantry/log/cards/evidence/fusion, and Sandpack preview/code are implemented. The vanilla store in `store/studioState.ts` is wrapped by `useStudio.ts`; live and development adapters share `Api`. Live integration still waits on upstream helpers. Refinement/auto-fix/export and isolation URLs remain later work. See [measured acceptance](../../docs/STEP3_MILESTONE.md). The examples below remain the design reference; implementation details are adapted to the existing contracts.

Visual language: dark ink background (`bg-ink-950`), panels `bg-ink-900 border border-white/10
rounded-2xl`, monospace for anything REA or code related, one accent per step (Step 1 amber
`amber-400`, Step 2 sky `sky-400`, Step 3 emerald `emerald-400`). Use the same three colours
in the terminal, on the cards and in the drawer, so judges learn "amber = REA, sky = spec,
green = engine" without being told.

## 1. Shared primitives (`components/ui/`)

```tsx
// Badge.tsx
import clsx from "clsx";
const tones = {
  neutral: "bg-white/5 text-slate-300 border-white/10",
  amber: "bg-amber-400/10 text-amber-300 border-amber-400/30",
  sky: "bg-sky-400/10 text-sky-300 border-sky-400/30",
  green: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30",
  red: "bg-rose-400/10 text-rose-300 border-rose-400/30",
  replay: "bg-fuchsia-400/10 text-fuchsia-300 border-fuchsia-400/30",
} as const;
export function Badge({ tone = "neutral", children, title }: { tone?: keyof typeof tones; children: React.ReactNode; title?: string }) {
  return <span title={title} className={clsx("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium", tones[tone])}>{children}</span>;
}
export const ReplayBadge = () => <Badge tone="replay" title="Played back from a recording of an earlier live run">REPLAY</Badge>;
```

`CodeBlock.tsx`: `<pre>` with line numbers, an optional `highlight: Set<number>` (lines get
`bg-sky-400/10`), and `startLine`. No syntax highlighter dependency. Monospace with good
contrast is enough.

## 2. `TopBar.tsx`

Logo "SPLICE" + tagline. On the right: **REA status** (green dot + `tool_count` tools when
`health.rea.connected`, amber "replay" when `rea_mode === "replay"`), **Bedrock status**
(`health.model`), and an `LLM REPLAY` badge if `llm_mode === "replay"`. Poll `/api/health` every
10 s.

## 3. `PantryPanel.tsx`

- One row per app: lucide icon (`icons[app.icon]` from `lucide-react`), display name, artifact
  chip (`electron .asar`), and the description in small text.
- Feature chips under each app are toggle buttons (`aria-pressed`). Selected chips are amber.
- Footer: `[▶ Harvest N features]` (disabled while harvesting or when nothing is selected) plus
  a muted hint: "REA analyzes the packaged app. Nothing is executed."
- Apps with `live_supported: false` show a small `replay only` badge.

## 4. `Terminal.tsx`

```tsx
import { useEffect, useRef } from "react";
import clsx from "clsx";
import { useStudio } from "../store/useStudio";

const kindStyle = {
  stage: "text-slate-300",
  call: "text-amber-300",
  result: "text-amber-200/80",
  test: "text-sky-300",
  error: "text-rose-300",
  info: "text-slate-500",
} as const;

export function Terminal() {
  const log = useStudio((s) => s.log);
  const cards = useStudio((s) => s.cards);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  return (
    <div className="rounded-2xl border border-white/10 bg-black/60">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-xs text-slate-400">
        <span className="font-mono">rea-agents · splice pipeline</span>
        <span>{log.length} events</span>
      </div>
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="h-64 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-5"
        role="log"
        aria-live="polite"
      >
        {log.map((l) => (
          <div key={l.id} className={clsx("whitespace-pre-wrap break-words", kindStyle[l.kind], l.ok === false && "text-rose-300")}>
            <span className="text-slate-600">{new Date(l.ts).toLocaleTimeString([], { hour12: false })} </span>
            <span className="text-slate-500">[{cards[l.feature_id]?.title ?? l.feature_id}] </span>
            {l.text}
          </div>
        ))}
        {log.length === 0 && <div className="text-slate-600">Select features and press Harvest. REA tool calls stream here.</div>}
      </div>
    </div>
  );
}
```

## 5. `FeatureCard.tsx` — phases, front and back

**Phase → front-of-card status line**

| phase | Status chip | Body |
|---|---|---|
| queued / harvesting | amber spinner "Harvesting with REA…" | live `stageMessage` |
| specifying | sky spinner "Writing requirements…" | `stageMessage` (chars progress) |
| spec_ready | sky "Spec ✓ 8 requirements · 7/7 vs original" (amber "unverified" if `spec.status !== "verified"`) | consumer description |
| implementing | emerald spinner "Implementing engine (original code withheld)…" | – |
| ready | emerald "Engine 7/7 ✓" | I/O pills + "Include in app" toggle |
| failed | rose "Failed" | error text + retry button |

**Back ("X-Ray")** shows, top to bottom:
1. **REA trail**: each `tool_calls` entry as `analyze_javascript_application · 2.1s · ev_3f9a…`
   (amber). If the evidence was replayed, show `recorded <collected_at>` and the REPLAY badge.
2. **Original source**: the first snippet's lines cited by `REQ-1`, about 12 lines in
   `CodeBlock` with those lines highlighted.
3. **Stripped glue** chips: `spec.stripped_glue`.
4. **Original vs engine**: the number of tests passing on each side, e.g. `7/7 ✓ original ·
   7/7 ✓ engine`.
5. `[Open full evidence →]` opens the EvidenceDrawer.

```tsx
import { useState } from "react";
import clsx from "clsx";
import { Cpu, FlaskConical, Boxes, RotateCcw, Loader2 } from "lucide-react";
import type { Card } from "../store/useStudio";
import { Badge, ReplayBadge } from "./ui/Badge";
import { CodeBlock } from "./ui/CodeBlock";
import { useStudio } from "../store/useStudio";

export function FeatureCard({ card, onOpen }: { card: Card; onOpen: () => void }) {
  const [flipped, setFlipped] = useState(false);
  const toggleFusion = useStudio((s) => s.toggleFusion);
  const spec = card.spec;
  const bp = card.blueprint;
  const oracle = spec?.oracle;
  const eng = bp?.verification;
  const busy = ["queued", "harvesting", "specifying", "implementing"].includes(card.phase);

  return (
    <div className="relative h-80 [perspective:1200px]">
      <div className={clsx("relative h-full w-full transition-transform duration-500 [transform-style:preserve-3d]", flipped && "[transform:rotateY(180deg)]")}>
        {/* FRONT */}
        <div className="absolute inset-0 flex flex-col rounded-2xl border border-white/10 bg-ink-900 p-4 [backface-visibility:hidden]">
          <div className="flex items-center justify-between gap-2">
            <Badge tone="amber">{spec?.source_app ?? card.app_id}</Badge>
            <div className="flex gap-1">
              {card.replayed && <ReplayBadge />}
              <button onClick={() => setFlipped(true)} disabled={!spec} className="rounded-md border border-amber-400/30 px-2 py-0.5 text-[11px] text-amber-300 hover:bg-amber-400/10 disabled:opacity-40">
                <Cpu className="mr-1 inline h-3 w-3" />X-Ray
              </button>
            </div>
          </div>

          <h3 className="mt-3 text-base font-semibold text-slate-50">{spec?.consumer_title ?? card.title}</h3>
          <p className="mt-1 line-clamp-3 text-sm text-slate-400">{spec?.consumer_description ?? card.stageMessage}</p>

          <div className="mt-3 space-y-1.5 text-xs">
            <Step icon={<Cpu className="h-3.5 w-3.5" />} tone="amber" done={!!spec || card.phase === "specifying"} active={card.phase === "harvesting" || card.phase === "queued"}
              label={spec ? `REA: ${spec.provenance.tool_calls.length} calls · ${spec.provenance.snippets.length} modules located` : "REA: locating code…"} />
            <Step icon={<FlaskConical className="h-3.5 w-3.5" />} tone={spec?.status === "unverified" ? "red" : "sky"} done={!!spec} active={card.phase === "specifying"}
              label={spec ? `Spec: ${spec.requirements.length} requirements · ${oracle!.passed}/${oracle!.total} vs original${spec.status === "verified" ? " ✓" : " (unverified)"}` : "Spec: pending"} />
            <Step icon={<Boxes className="h-3.5 w-3.5" />} tone={eng?.status === "failed" ? "red" : "green"} done={!!bp} active={card.phase === "implementing"}
              label={bp ? `Engine: ${eng!.passed}/${eng!.total} tests ✓ · ${bp.implementation.module_name}.ts` : "Engine: pending"} />
          </div>

          <div className="mt-auto">
            {busy && <p className="mb-2 flex items-center gap-1.5 truncate text-[11px] text-slate-500"><Loader2 className="h-3 w-3 animate-spin" />{card.stageMessage}</p>}
            {card.phase === "failed" && <p className="mb-2 line-clamp-2 text-[11px] text-rose-300">{card.error}</p>}
            <button
              disabled={card.phase !== "ready"}
              onClick={() => toggleFusion(card.feature_id)}
              className={clsx("w-full rounded-lg py-1.5 text-sm font-medium transition-colors disabled:opacity-40",
                card.includeInFusion ? "bg-emerald-500 text-ink-950 hover:bg-emerald-400" : "bg-white/5 text-slate-300 hover:bg-white/10")}
            >
              {card.includeInFusion ? "✓ Included in app" : "Include in app"}
            </button>
          </div>
        </div>

        {/* BACK */}
        <div className="absolute inset-0 flex flex-col overflow-hidden rounded-2xl border border-amber-400/30 bg-black p-4 [backface-visibility:hidden] [transform:rotateY(180deg)]">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs font-bold text-amber-300">X-RAY · {card.feature_id}</span>
            <button onClick={() => setFlipped(false)} className="text-slate-400 hover:text-slate-100"><RotateCcw className="h-4 w-4" /></button>
          </div>
          {spec && <XRay card={card} />}
          <button onClick={onOpen} className="mt-auto text-left text-xs font-medium text-amber-300 underline underline-offset-2">Open full evidence →</button>
        </div>
      </div>
    </div>
  );
}

function Step({ icon, label, tone, done, active }: { icon: React.ReactNode; label: string; tone: "amber" | "sky" | "green" | "red"; done: boolean; active: boolean }) {
  const color = { amber: "text-amber-300", sky: "text-sky-300", green: "text-emerald-300", red: "text-rose-300" }[tone];
  return (
    <div className={clsx("flex items-center gap-2", done ? color : "text-slate-600")}>
      {active ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      <span className="truncate">{label}</span>
    </div>
  );
}

function XRay({ card }: { card: Card }) {
  const spec = card.spec!;
  const ref = spec.requirements[0]?.source_refs[0];
  const m = ref?.match(/^(.+):L(\d+)-L(\d+)$/);
  const snippet = spec.provenance.snippets.find((s) => m && s.location.endsWith(m[1])) ?? spec.provenance.snippets[0];
  const from = m ? Math.max(1, +m[2] - 3) : 1;
  const lines = snippet.code.split("\n").slice(from - 1, from + 11);
  const hl = new Set<number>(m ? Array.from({ length: +m[3] - +m[2] + 1 }, (_, i) => +m[2] + i) : []);
  return (
    <div className="mt-2 min-h-0 space-y-2 overflow-hidden text-[11px]">
      <ul className="space-y-0.5 font-mono text-amber-200/80">
        {spec.provenance.tool_calls.slice(0, 3).map((c) => (
          <li key={c.seq} className="truncate">{c.tool} · {(c.duration_ms / 1000).toFixed(1)}s · {c.evidence_id?.slice(0, 10) ?? "—"}…</li>
        ))}
        {spec.provenance.tool_calls.length === 0 && <li>evidence recorded {spec.provenance.collected_at.slice(0, 16)}</li>}
      </ul>
      <CodeBlock code={lines.join("\n")} startLine={from} highlight={hl} caption={snippet.location} />
      <div className="flex flex-wrap gap-1">{spec.stripped_glue.slice(0, 3).map((g) => <span key={g} className="rounded bg-white/5 px-1 text-slate-400 line-through decoration-rose-400/60">{g}</span>)}</div>
    </div>
  );
}
```

`CardTray.tsx`: a grid `sm:grid-cols-2` of `FeatureCard`s in selection order, plus an empty state
("Your harvested features appear here"). It owns the `openId` state for the drawer.

## 6. `EvidenceDrawer.tsx` — the "prove it" view

A right-side sheet (`fixed inset-y-0 right-0 w-full max-w-3xl`, Esc closes, focus trapped) with
4 tabs:

| Tab | Content |
|---|---|
| **Requirements** | Table: id · kind · statement · source refs (chips). Hovering a row highlights those lines in the Source tab's code (shared state). Coverage column: number of tests covering it |
| **Original source** | One `CodeBlock` per snippet (`location` as caption), lines cited by any requirement shaded sky. Header: target path, sha256 (short), REA version, the tool-call list with durations and evidence IDs. Footer: limitations and unknowns |
| **Tests: original vs engine** | **The killer table.** Rows = test names. Columns = "Original (via adapter)" ✓/✗ from `spec.oracle.tests` and "New engine" ✓/✗ from `blueprint.verification.tests`. The header states: *"Same tests. Left: run against the original app's code. Right: run against code written without seeing it."* |
| **Engine** | `blueprint.implementation.portable_code` in a `CodeBlock`, then `notes`, `allowed_deviations`, `verification.model` / `spec.provenance.model` (shows if a fallback model answered) |

## 7. `FusionPanel.tsx`

- Shows the engines that will be fused (chips for every card with `includeInFusion && blueprint`).
- A textarea pre-filled with the golden-path prompt (09) when exactly the demo's two features
  are selected. Otherwise a placeholder: "Describe the app you want built from these engines…"
- `[⚡ Fuse N engines into an app]` is disabled until ≥ 1 ready engine and a prompt exist.
- While running: a progress line with `synth.stage` + `outputChars` ("Generating React
  components… 12,480 chars"). Validation errors appear as a collapsible amber list (they're
  being auto-fixed server-side).
