# 05 — Frontend Setup (H0–H1)

## 1. Scaffold

```bash
npm create vite@5 packages/frontend -- --template react-ts
cd packages/frontend
npm install zustand@4.5.5 lucide-react@0.344.0 clsx@2.1.1 jszip@3.10.1 @codesandbox/sandpack-react
npm install -D tailwindcss@3.4.17 postcss@8.4.49 autoprefixer@10.4.20
npx tailwindcss init -p
```

Then set `"name": "@splice/frontend"` and add `"@splice/contracts": "*"` to dependencies in
`package.json`, and run `npm install` from the repo root so the workspace link exists. Pin
`@codesandbox/sandpack-react` to whatever version installs (the lockfile keeps it).

> Use Tailwind **v3** (config-file based). The generated apps inside Sandpack also use the
> Tailwind v3 Play CDN, so the class vocabulary stays identical on both sides.

## 2. Config files

`vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@fixtures": path.resolve(__dirname, "../../fixtures") },
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:3001", changeOrigin: true } },
    fs: { allow: [path.resolve(__dirname, "../..")] }, // contracts + fixtures live outside the package
  },
});
```

> SSE through the Vite proxy works. Don't add compression anywhere in the chain.

`tailwind.config.js`:

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: { mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"] },
      colors: { ink: { 950: "#0b0f17", 900: "#111827", 800: "#1f2937" } },
    },
  },
  plugins: [],
};
```

`src/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root { height: 100%; }
body { @apply bg-ink-950 text-slate-100 antialiased; }
```

`.env.development`:

```
VITE_API_MODE=live      # live | mock  (mock = no backend at all, see 06 §5)
```

## 3. Folder layout

```
packages/frontend/src/
├── main.tsx
├── App.tsx                         # layout + ?test= isolation routes
├── api/
│   ├── sse.ts                      # streamPost(): POST + SSE parsing   (06)
│   ├── client.ts                   # typed calls: health, pantry, extract, implement, synthesize, refine (06)
│   └── mock.ts                     # offline mode backed by fixtures/   (06)
├── store/
│   └── useStudio.ts                # zustand store + pipeline orchestration (06)
├── components/
│   ├── TopBar.tsx                  # (07)
│   ├── PantryPanel.tsx             # (07)
│   ├── Terminal.tsx                # (07)
│   ├── FeatureCard.tsx             # (07)
│   ├── CardTray.tsx                # (07)
│   ├── EvidenceDrawer.tsx          # (07)
│   ├── FusionPanel.tsx             # (07)
│   ├── studio/StudioPanel.tsx      # (08)
│   ├── studio/RuntimeErrorWatcher.tsx # (08)
│   ├── studio/RefineChat.tsx       # (08)
│   ├── ui/Badge.tsx, Button.tsx, CodeBlock.tsx, Spinner.tsx
└── lib/
    ├── exportZip.ts                # (08)
    └── format.ts                   # ms → "2.1s", short evidence ids, etc.
```

## 4. Layout (desktop ≥ 1024 px; stacks vertically below)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ SPLICE  Reverse-engineer features. Rebuild them. Fuse them.   REA ● 41 tools  Bedrock ●│  TopBar
├───────────────────────────────────────┬──────────────────────────────────────────────┤
│ 1 PANTRY                              │ 4 FUSE                                       │
│  Inkwell Notes   [Wiki-link graph ✓]  │  [ prompt textarea ……………………………… ]          │
│                  [Fuzzy search   ]    │  [⚡ Fuse 2 engines into an app]             │
│  Recall Flash.   [SM-2 scheduler ✓]   ├──────────────────────────────────────────────┤
│                  [Review streaks ]    │ [Preview] [Code]            rev 2  REPLAY?   │
│  [▶ Harvest 2 features]               │ ┌──────────────────────────────────────────┐ │
├───────────────────────────────────────┤ │                                          │ │
│ 2 REA TERMINAL                        │ │          Sandpack live app               │ │
│  15:42:01 ▸ analyze_javascript_app…   │ │                                          │ │
│  15:42:03 ◂ ok 2.1s modules: 6 …      │ └──────────────────────────────────────────┘ │
│  15:42:09 ✓ REQ-4 REQ-5 lapse… (orig) │ 5 REFINE                                     │
├───────────────────────────────────────┤  assistant: Added a "Due today" filter…      │
│ 3 FEATURE CARDS                       │  [ Add a dark mode toggle …          ] [→]   │
│  ┌──────────────┐ ┌──────────────┐    │                                              │
│  │ Wiki graph   │ │ SM-2 sched.  │    │                                              │
│  │ Spec ✓ 7 req │ │ Engine 7/7 ✓ │    │                                              │
│  └──────────────┘ └──────────────┘    │                                              │
└───────────────────────────────────────┴──────────────────────────────────────────────┘
```

Grid: `lg:grid-cols-[minmax(380px,40%)_1fr]`. The left column scrolls by itself, and the right
column is `h-[calc(100vh-56px)] sticky top-14`. Below `lg`: a single column, with the studio
after the cards.

## 5. `src/App.tsx` (skeleton with isolation routes)

```tsx
import { useEffect } from "react";
import { TopBar } from "./components/TopBar";
import { PantryPanel } from "./components/PantryPanel";
import { Terminal } from "./components/Terminal";
import { CardTray } from "./components/CardTray";
import { FusionPanel } from "./components/FusionPanel";
import { StudioPanel } from "./components/studio/StudioPanel";
import { useStudio } from "./store/useStudio";
import { IsolationRoute } from "./dev/IsolationRoute";

export default function App() {
  const init = useStudio((s) => s.init);
  useEffect(() => { void init(); }, [init]);

  const test = new URLSearchParams(location.search).get("test");
  if (test) return <IsolationRoute name={test} />;   // ?test=card | terminal | sandpack | drawer

  return (
    <div className="min-h-full">
      <TopBar />
      <main className="grid gap-4 p-4 lg:grid-cols-[minmax(380px,40%)_1fr]">
        <section className="space-y-4 min-w-0">
          <PantryPanel />
          <Terminal />
          <CardTray />
        </section>
        <section className="space-y-4 min-w-0 lg:sticky lg:top-[72px] lg:h-[calc(100vh-88px)] lg:flex lg:flex-col">
          <FusionPanel />
          <StudioPanel />
        </section>
      </main>
    </div>
  );
}
```

`src/dev/IsolationRoute.tsx` renders one component with fixture data from `@fixtures/...`
(e.g. `?test=card` shows four FeatureCards in every phase). It's the fastest way to polish a
component without running the pipeline.
