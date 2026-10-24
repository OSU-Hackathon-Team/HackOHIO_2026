// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/05_frontend_setup.md §5
import type { ReactNode } from "react";
import { Terminal } from "../components/Terminal";
import { StudioPanel } from "../components/studio/StudioPanel";
import { CardTray } from "../components/CardTray";
import { PantryPanel } from "../components/PantryPanel";

export function IsolationRoute({ name }: { name: string }): ReactNode {
  return (
    <div className="isolation-route" style={{ padding: 24, maxWidth: 1200, margin: "auto" }}>
      <h2>Isolation Test View: {name}</h2>
      <p className="muted small" style={{ marginBottom: 16 }}>
        Testing component in isolation mode (?test={name})
      </p>
      {name === "terminal" && <Terminal />}
      {name === "sandpack" && <StudioPanel />}
      {name === "cards" && <CardTray />}
      {name === "pantry" && <PantryPanel />}
    </div>
  );
}
