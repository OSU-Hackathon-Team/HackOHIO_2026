# 08 — Sandpack Studio, Runtime Errors & Export

> **Core Studio milestone:** setup, typed API/SSE, Zustand orchestration, development seeds, pantry/log/cards/evidence/fusion, and Sandpack preview/code are implemented. The vanilla store in `store/studioState.ts` is wrapped by `useStudio.ts`; live and development adapters share `Api`. Live integration still waits on upstream helpers. Refinement/auto-fix/export and isolation URLs remain later work. See [measured acceptance](../../docs/STEP3_MILESTONE.md). The examples below remain the design reference; implementation details are adapted to the existing contracts.

## 1. `components/studio/StudioPanel.tsx`

We use the composable Sandpack components, not the all-in-one `<Sandpack>`, so we can read its
error state (`useSandpack`) and control the layout.

```tsx
import { useMemo, useState } from "react";
import {
  SandpackProvider, SandpackLayout, SandpackPreview, SandpackCodeEditor, SandpackFileExplorer,
  type SandpackFiles,
} from "@codesandbox/sandpack-react";
import { Download } from "lucide-react";
import { useStudio } from "../../store/useStudio";
import { RuntimeErrorWatcher } from "./RuntimeErrorWatcher";
import { RefineChat } from "./RefineChat";
import { ReplayBadge, Badge } from "../ui/Badge";
import { exportZip } from "../../lib/exportZip";

export function StudioPanel() {
  const synth = useStudio((s) => s.synth);
  const bundle = synth.bundle;
  const [tab, setTab] = useState<"preview" | "code">("preview");

  const files: SandpackFiles | undefined = useMemo(() => {
    if (!bundle) return undefined;
    const out: SandpackFiles = {};
    for (const [path, code] of Object.entries(bundle.files)) {
      out[path] = {
        code,
        readOnly: bundle.engine_paths.includes(path) || !bundle.generated_paths.includes(path),
        hidden: path === "/public/index.html" || path === "/styles.css",
        active: path === "/App.tsx",
      };
    }
    return out;
  }, [bundle]);

  if (!bundle || !files) {
    return (
      <div className="flex min-h-[420px] flex-1 items-center justify-center rounded-2xl border border-dashed border-white/10 text-sm text-slate-500">
        {synth.status === "running" ? `${synth.stage} ${synth.outputChars ? `· ${synth.outputChars.toLocaleString()} chars` : ""}` : "Your fused app will run here."}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <h2 className="truncate font-semibold">{bundle.app_title}</h2>
          <p className="truncate text-xs text-slate-400">{bundle.app_description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {bundle.mode === "replay" && <ReplayBadge />}
          <Badge>rev {bundle.revision}</Badge>
          <div className="flex rounded-lg border border-white/10 p-0.5 text-xs">
            {(["preview", "code"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={t === tab ? "rounded-md bg-white/10 px-2 py-1" : "px-2 py-1 text-slate-400"}>{t === "preview" ? "Preview" : "Code"}</button>
            ))}
          </div>
          <button onClick={() => exportZip(bundle)} className="rounded-lg border border-white/10 p-1.5 text-slate-300 hover:bg-white/5" title="Download as a Vite project">
            <Download className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* key → remount on every new bundle/revision so Sandpack never mixes old and new files */}
      <SandpackProvider
        key={`${bundle.bundle_id}:${bundle.revision}`}
        template="react-ts"
        theme="dark"
        files={files}
        customSetup={{ dependencies: bundle.dependencies }}
        options={{ recompileMode: "delayed", recompileDelay: 500 }}
      >
        <RuntimeErrorWatcher bundleId={bundle.bundle_id} revision={bundle.revision} />
        <SandpackLayout className="!min-h-0 flex-1 !rounded-2xl !border-white/10">
          {tab === "code" && <SandpackFileExplorer style={{ height: "100%", minWidth: 180 }} />}
          {tab === "code" && <SandpackCodeEditor showTabs showLineNumbers style={{ height: "100%" }} />}
          <SandpackPreview
            style={{ height: "100%", display: tab === "preview" ? "flex" : "none" }}
            showOpenInCodeSandbox={false}
            showRefreshButton
          />
        </SandpackLayout>
      </SandpackProvider>

      <RefineChat />
    </div>
  );
}
```

Notes:
- **Engines are `readOnly`** in the editor and labelled in the file explorer. Judges can open
  `/engines/sm2Scheduler.ts` and see the verified code that never changes across refines.
- The preview stays mounted while the Code tab is open (`display: none`), so state survives
  tab switches.
- Give the right column a real height (`lg:h-[calc(100vh-88px)]`). Sandpack collapses to
  ~300 px if its parent has no height.
- ⚠️ Sandpack 2.20's `react-ts` template defaults to **React 19**. Our bundles must keep sending
  `react`/`react-dom` `18.3.1` in `customSetup.dependencies` (they do, via `ALLOWED_DEPENDENCIES`),
  because the validator type-checks against `@types/react` 18.
- Tailwind arrives through `/public/index.html` (server-owned, includes the Play CDN script).
  Verified: the `react-ts` template has `/public/index.html`, and our file replaces it.
  The first load needs internet for the CDN and Sandpack's bundler. That's another reason the
  backup video (09) exists.

## 2. `components/studio/RuntimeErrorWatcher.tsx`

```tsx
import { useEffect, useRef } from "react";
import { useSandpack } from "@codesandbox/sandpack-react";
import { useStudio } from "../../store/useStudio";

/** Implements the auto-fix policy in 04 §3. */
export function RuntimeErrorWatcher({ bundleId, revision }: { bundleId: string; revision: number }) {
  const { sandpack } = useSandpack();
  const refine = useStudio((s) => s.refine);
  const autoFixUsedFor = useStudio((s) => s.synth.autoFixUsedFor);
  const status = useStudio((s) => s.synth.status);
  const timer = useRef<number>();

  useEffect(() => {
    window.clearTimeout(timer.current);
    const err = sandpack.error;
    if (!err || status === "running") return;
    // Debounce: Sandpack can flash errors while bundling
    timer.current = window.setTimeout(() => {
      const text = [err.title, err.message, err.path ? `${err.path}:${err.line ?? "?"}` : ""].filter(Boolean).join("\n").slice(0, 2000);
      useStudio.setState((s) => ({ synth: { ...s.synth, error: text } }));
      if (autoFixUsedFor !== bundleId) void refine("fix", text);
    }, 1200);
    return () => window.clearTimeout(timer.current);
  }, [sandpack.error, bundleId, revision, autoFixUsedFor, status, refine]);

  return null;
}
```

> ✅ Verified against the installed `@codesandbox/sandpack-react@2.20.0`: `sandpack.error` is
> `SandpackError | null` with `message`, `title?`, `path?`, `line?` and `column?`. Files accept
> `{ code, readOnly, hidden, active }`. If compile errors ever don't surface in `sandpack.error`,
> also subscribe with `listen((msg) => …)` for `msg.type === "action" && msg.action === "show-error"`.

When an auto-fix is already used for this bundle and another error appears, the panel shows a
rose banner: *"Runtime error: … [Fix with AI]"*, and the button calls `refine("fix", text)`.

## 3. `components/studio/RefineChat.tsx`

- Message list from `synth.chat`: user bubbles on the right, assistant (the `summary`) on the left.
- Input + send, disabled while `synth.status === "running"`. Enter sends; Shift+Enter adds a
  newline.
- Three suggestion chips for the demo: "Add a 'Due today' filter", "Add a dark mode toggle",
  "Show a mini graph of note links". Clicking one fills and sends.
- A muted line under the input: "Engines are locked. Refinements only change the UI."

## 4. `lib/exportZip.ts` — "Download as a Vite project"

```ts
import JSZip from "jszip";
import type { SynthesisBundle } from "@splice/contracts";

export async function exportZip(bundle: SynthesisBundle) {
  const zip = new JSZip();
  const root = zip.folder(slug(bundle.app_title))!;
  root.file("package.json", JSON.stringify({
    name: slug(bundle.app_title), private: true, type: "module",
    scripts: { dev: "vite", build: "vite build" },
    dependencies: bundle.dependencies,
    devDependencies: { vite: "5.4.11", "@vitejs/plugin-react": "4.3.4", typescript: "5.6.3", "@types/react": "18.3.12", "@types/react-dom": "18.3.1" },
  }, null, 2));
  root.file("vite.config.ts", `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()] });\n`);
  root.file("index.html", bundle.files["/public/index.html"].replace("</body>", `  <script type="module" src="/src/index.tsx"></script>\n  </body>`));
  for (const [p, code] of Object.entries(bundle.files)) {
    if (p.startsWith("/public/")) continue;
    root.file("src" + p, code);
  }
  root.file("README.md", `# ${bundle.app_title}\n\n${bundle.app_description}\n\nGenerated by Splice. Engines in src/engines/ were implemented from specifications verified against the original apps.\n\n    npm install\n    npm run dev\n`);
  const blob = await zip.generateAsync({ type: "blob" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${slug(bundle.app_title)}.zip` });
  a.click();
  URL.revokeObjectURL(a.href);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "splice-app";
```

Verify once by hand that the unzipped project runs with `npm install && npm run dev`.

## 5. Golden-bundle escape hatch (`?bundle=golden`)

For the "synthesis is stuck on stage" case in the runbook (09 §5). In `useStudio.init()`:

```ts
const goldenBundles = import.meta.glob("@fixtures/bundles/*.json", { import: "default" }); // lazy

if (new URLSearchParams(location.search).get("bundle") === "golden") {
  const loader = Object.entries(goldenBundles).find(([p]) => !p.endsWith(".latest.json"))?.[1];
  if (loader) {
    const bundle = { ...(await loader()) as SynthesisBundle, mode: "replay" as const };
    set((s) => ({ synth: { ...s.synth, status: "ready", bundle } }));
  }
}
```

The bundle shows the REPLAY badge. Refine still works on it live, as long as the matching
blueprints are in the store (load them from `/api/blueprints` in the same branch).
