// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/07_components.md §2
import { useStudio } from "../store/useStudio";
import { developmentMode } from "../api/client";
export function TopBar() {
  const health = useStudio(s => s.health);
  const error = useStudio(s => s.healthError);
  const configuredModel = health?.models.ui_synthesizer ?? health?.model;
  return <header className="topbar">
    <a className="brand" href={developmentMode ? "?mode=development" : "/"} aria-label="Splice home">S<span>PLICE</span></a>
    <p className="tagline">Find the behavior.<br /><strong>Build something new.</strong></p>
    <div className="connection">
      <span className={developmentMode ? "badge amber" : "badge"}>{developmentMode ? "Development data" : health?.rea.connected ? `REA · ${health.rea.tool_count} tools` : health ? health.rea_mode === "replay" ? "REA replay mode" : "REA disconnected" : "Live status unknown"}</span>
      <small title={error ?? configuredModel}>{developmentMode ? "No REA, oracle, or model calls" : error ?? (configuredModel ? `Configured UI model: ${configuredModel}` : "Checking backend…")}</small>
      <a href={developmentMode ? "/" : "?mode=development"}>{developmentMode ? "Switch to live" : "Open development demo"}</a>
    </div>
  </header>;
}
