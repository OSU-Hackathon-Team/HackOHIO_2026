// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/07_components.md §2
import { useStudio } from "../store/useStudio";
import { developmentMode, replayMode } from "../api/client";

export function TopBar() {
  const health = useStudio(s => s.health);
  const error = useStudio(s => s.healthError);
  const configuredModel = health?.models?.ui_synthesizer ?? health?.model;
  const isReplay = replayMode || (!developmentMode && health?.rea_mode === "replay");

  return (
    <header className="topbar">
      <a
        className="brand"
        href={developmentMode ? "?mode=development" : isReplay ? "?mode=replay" : "/"}
        aria-label="Splice home"
      >
        S<span>PLICE</span>
      </a>
      <p className="tagline">
        Find the behavior.
        <br />
        <strong>Build something new.</strong>
      </p>
      <div className="connection">
        <span
          className={
            developmentMode
              ? "badge amber"
              : isReplay
              ? "badge sky"
              : health?.rea.connected
              ? "badge green"
              : error
              ? "badge red"
              : "badge"
          }
        >
          {developmentMode
            ? "Development data"
            : isReplay
            ? "Replay mode (fixtures)"
            : health?.rea.connected
            ? `REA · ${health.rea.tool_count} tools`
            : health
            ? "REA disconnected"
            : "Live status unknown"}
        </span>
        <small title={error ?? configuredModel}>
          {developmentMode
            ? "No REA, oracle, or model calls"
            : error
            ? `Backend: ${error}`
            : configuredModel
            ? `Configured UI model: ${configuredModel}`
            : "Connecting to backend…"}
        </small>
        {developmentMode ? (
          <a href="/">Switch to live</a>
        ) : isReplay ? (
          <>
            <a href="/">Live mode</a>
            <span style={{ color: "#475569", margin: "0 4px" }}>·</span>
            <a href="?mode=development">Open development demo</a>
          </>
        ) : (
          <>
            <a href="?mode=replay">Replay mode</a>
            <span style={{ color: "#475569", margin: "0 4px" }}>·</span>
            <a href="?mode=development">Open development demo</a>
          </>
        )}
      </div>
    </header>
  );
}
