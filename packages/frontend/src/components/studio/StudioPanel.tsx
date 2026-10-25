// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/08_sandpack_studio.md §1
import { useMemo, useState } from "react";
import {
  SandpackProvider,
  SandpackLayout,
  SandpackPreview,
  SandpackCodeEditor,
  SandpackFileExplorer,
  useSandpack,
  type SandpackFiles,
} from "@codesandbox/sandpack-react";
import { Download } from "lucide-react";
import { useStudio } from "../../store/useStudio";
import { developmentMode } from "../../api/client";
import { RuntimeErrorWatcher } from "./RuntimeErrorWatcher";
import { RefineChat } from "./RefineChat";
import { exportBundleJson } from "../../lib/exportZip";
import { exportElectronProject } from "../../lib/electronProject";

function RuntimeBanner() {
  const { sandpack } = useSandpack();
  const synth = useStudio(s => s.synth);
  const refine = useStudio(s => s.refine);
  const isRunning = synth.status === "running";
  const err = sandpack.error;
  if (!err) return null;

  const errorText = [err.title, err.message, err.path ? `${err.path}:${err.line ?? "?"}` : ""]
    .filter(Boolean)
    .join("\n");

  return (
    <div
      role="alert"
      className="error"
      style={{
        margin: "10px 0",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "10px",
      }}
    >
      <div>
        <strong>Preview error: </strong>
        <span>{err.message}</span>
      </div>
      <button
        type="button"
        disabled={isRunning}
        onClick={() => void refine("fix", errorText)}
      >
        {isRunning ? "Repairing..." : "Fix with AI"}
      </button>
    </div>
  );
}

export function StudioPanel() {
  const bundle = useStudio(s => s.synth.bundle);
  const status = useStudio(s => s.synth.status);
  const [tab, setTab] = useState<"preview" | "code">("preview");

  const files = useMemo(() => {
    if (!bundle) return undefined;
    return Object.fromEntries(
      Object.entries(bundle.files).map(([path, code]) => [
        path,
        {
          code,
          readOnly:
            bundle.engine_paths.includes(path) || !bundle.generated_paths.includes(path),
          hidden: path === "/public/index.html" || path === "/styles.css",
          active: path === "/App.tsx",
        },
      ]),
    ) as SandpackFiles;
  }, [bundle]);

  if (!bundle || !files) {
    return (
      <section className="studio-empty">
        <p className="eyebrow">Your next app</p>
        <h2>
          Two ideas.
          <br />
          One working space.
        </h2>
        <p>
          {status === "running"
            ? "Preparing your app…"
            : "Harvest features and Fuse them to open the live preview."}
        </p>
      </section>
    );
  }

  return (
    <section className="studio" aria-label="App studio">
      <div className="studio-header">
        <div>
          <h2>{bundle.app_title}</h2>
          <p className="small muted">
            {developmentMode
              ? "Development data · locally checked seeds"
              : bundle.mode === "replay"
              ? "REPLAY"
              : "Live bundle"}{" "}
            · revision {bundle.revision}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <nav className="tabs" aria-label="Studio view">
            <button aria-pressed={tab === "preview"} onClick={() => setTab("preview")}>
              Preview
            </button>
            <button aria-pressed={tab === "code"} onClick={() => setTab("code")}>
              Code
            </button>
          </nav>
          <button
            type="button"
            className="icon-button"
            title="Download bundle JSON"
            onClick={() => exportBundleJson(bundle)}
            style={{ minHeight: "36px", padding: "6px 10px" }}
          >
            <Download size={14} style={{ marginRight: "4px", verticalAlign: "middle" }} />
            Export
          </button>
          <button type="button" className="icon-button" title="Download runnable Electron project"
            onClick={() => void exportElectronProject(bundle)}>
            Electron project
          </button>
        </div>
      </div>
      <p className="small muted">
        Files under /engines are locked. Refreshing a bundle resets its preview state.
      </p>
      {!!bundle.warnings.length && (
        <details>
          <summary>Bundle notes ({bundle.warnings.length})</summary>
          {bundle.warnings.map((w, i) => (
            <p className="small warning" key={i}>
              {w}
            </p>
          ))}
        </details>
      )}
      <SandpackProvider
        key={`${bundle.bundle_id}:${bundle.revision}`}
        template="react-ts"
        theme="dark"
        files={files}
        customSetup={{ dependencies: bundle.dependencies }}
        options={{ recompileMode: "delayed", recompileDelay: 500, externalResources: ["https://cdn.tailwindcss.com/3.4.17"] }}
      >
        <RuntimeErrorWatcher bundleId={bundle.bundle_id} revision={bundle.revision} />
        <RuntimeBanner />
        <SandpackLayout className="sandpack-layout">
          {tab === "code" && (
            <div className="code-pane">
              <SandpackFileExplorer />
              <SandpackCodeEditor showTabs showLineNumbers />
            </div>
          )}
          <div className="preview-pane" style={{ display: tab === "preview" ? "flex" : "none" }}>
            <SandpackPreview showOpenInCodeSandbox={false} showRefreshButton />
          </div>
        </SandpackLayout>
      </SandpackProvider>

      <RefineChat />
    </section>
  );
}
