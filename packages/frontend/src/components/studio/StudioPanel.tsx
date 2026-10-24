// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/08_sandpack_studio.md §1
import { useMemo, useState } from "react";
import { SandpackProvider, SandpackLayout, SandpackPreview, SandpackCodeEditor, SandpackFileExplorer, useSandpack, type SandpackFiles } from "@codesandbox/sandpack-react";
import { useStudio } from "../../store/useStudio";
import { developmentMode } from "../../api/client";
function RuntimeStatus() {
  const { sandpack } = useSandpack();
  return sandpack.error ? <p role="alert" className="error">Preview error: {sandpack.error.message}. Automatic repair is planned for the next milestone.</p> : null;
}
export function StudioPanel() {
  const bundle = useStudio(s => s.synth.bundle);
  const status = useStudio(s => s.synth.status);
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const files = useMemo(() => bundle ? Object.fromEntries(Object.entries(bundle.files).map(([path, code]) => [path, { code, readOnly: bundle.engine_paths.includes(path) || !bundle.generated_paths.includes(path), hidden: path === "/public/index.html" || path === "/styles.css", active: path === "/App.tsx" }])) as SandpackFiles : undefined, [bundle]);
  if (!bundle || !files) return <section className="studio-empty"><p className="eyebrow">Your next app</p><h2>Two ideas.<br />One working space.</h2><p>{status === "running" ? "Preparing your app…" : "Harvest features and Fuse them to open the live preview."}</p></section>;
  return <section className="studio" aria-label="App studio">
    <div className="studio-header"><div><h2>{bundle.app_title}</h2><p className="small muted">{developmentMode ? "Development data · locally checked seeds" : bundle.mode === "replay" ? "REPLAY" : "Live bundle"} · revision {bundle.revision}</p></div>
      <nav className="tabs" aria-label="Studio view"><button aria-pressed={tab === "preview"} onClick={() => setTab("preview")}>Preview</button><button aria-pressed={tab === "code"} onClick={() => setTab("code")}>Code</button></nav>
    </div>
    <p className="small muted">Files under /engines are locked. Refreshing a bundle resets its preview state.</p>
    {!!bundle.warnings.length && <details><summary>Bundle notes ({bundle.warnings.length})</summary>{bundle.warnings.map((w,i) => <p className="small warning" key={i}>{w}</p>)}</details>}
    <SandpackProvider key={`${bundle.bundle_id}:${bundle.revision}`} template="react-ts" theme="dark" files={files} customSetup={{ dependencies: bundle.dependencies }} options={{ recompileMode: "delayed", recompileDelay: 500 }}>
      <RuntimeStatus />
      <SandpackLayout className="sandpack-layout">
        {tab === "code" && <div className="code-pane"><SandpackFileExplorer /><SandpackCodeEditor showTabs showLineNumbers /></div>}
        <div className="preview-pane" style={{ display: tab === "preview" ? "flex" : "none" }}><SandpackPreview showOpenInCodeSandbox={false} showRefreshButton /></div>
      </SandpackLayout>
    </SandpackProvider>
  </section>;
}
