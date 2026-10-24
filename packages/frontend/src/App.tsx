import { useEffect } from "react";
import { TopBar } from "./components/TopBar";
import { PantryPanel } from "./components/PantryPanel";
import { Terminal } from "./components/Terminal";
import { CardTray } from "./components/CardTray";
import { FusionPanel } from "./components/FusionPanel";
import { StudioPanel } from "./components/studio/StudioPanel";
import { studio } from "./store/useStudio";
import { developmentMode } from "./api/client";

export default function App() {
  useEffect(() => {
    void studio.getState().init();
    const timer = window.setInterval(() => void studio.getState().refreshHealth(), 10000);
    return () => { window.clearInterval(timer); studio.getState().cancel(); };
  }, []);
  return <div className="app-shell"><a className="skip-link" href="#workspace">Skip to workspace</a><TopBar />
    {developmentMode && <aside className="demo-notice"><strong>Development demo</strong><span>Authored seeds and stored local checks. No live extraction, original-code oracle, or AI generation.</span></aside>}
    <main id="workspace" className="workspace"><div className="collection-column"><PantryPanel /><Terminal /><CardTray /></div><div className="studio-column"><FusionPanel /><StudioPanel /></div></main>
    <footer className="app-footer">Splice · Reconstruct behavior from specifications. Verification describes checked cases, not complete equivalence.</footer>
  </div>;
}
