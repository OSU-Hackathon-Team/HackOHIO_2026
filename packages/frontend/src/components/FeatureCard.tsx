// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/07_components.md §5
import { useState } from "react";
import type { Card } from "../store/studioState";
import { useStudio } from "../store/useStudio";
import { developmentMode } from "../api/client";
export function FeatureCard({ card, onOpen }: { card: Card; onOpen: () => void }) {
  const [xray, setXray] = useState(false);
  const toggle = useStudio(s => s.toggleFusion), harvest = useStudio(s => s.harvest);
  const busy = useStudio(s => s.harvesting || s.synth.status === "running");
  const spec = card.spec, verification = card.blueprint?.verification;
  return <article className="feature-card">
    <div className="card-heading"><span className="eyebrow">{spec?.source_app ?? card.app_id}</span><span className={`badge ${card.phase === "ready" ? "green" : card.phase === "failed" ? "red" : "sky"}`}>{card.phase}</span></div>
    <h3>{card.title}</h3>
    {card.replayed && <span className="badge amber">{developmentMode ? "Development seed · replay mode" : "REPLAY"}</span>}
    {spec?.status === "unverified" && <p className="warning">Spec unverified · {developmentMode ? "original oracle not run" : spec.open_issues[0]}</p>}
    {xray && spec ? <div className="xray">
      <h4>Inside this feature</h4>
      <p>{spec.requirements.length} requirements · {spec.provenance.tool_calls.length} recorded REA calls</p>
      {spec.provenance.snippets[0] ? <pre>{spec.provenance.snippets[0].code.split("\n").slice(0,12).join("\n")}</pre> : <p className="muted">No original source recorded for this development seed.</p>}
      <p>Original: {spec.oracle.total ? `${spec.oracle.passed}/${spec.oracle.total}` : "Not run"} · Engine: {verification ? `${verification.passed}/${verification.total}` : "Pending"}</p>
    </div> : <p className="card-description">{spec?.consumer_description ?? card.message}</p>}
    <p className="small" role="status">{verification ? `Engine ${verification.passed}/${verification.total} · ${verification.status}` : card.message}</p>
    {card.error && <p role="alert" className="error">{card.error}</p>}
    <div className="card-actions">
      <button disabled={!spec} aria-pressed={xray} onClick={() => setXray(!xray)}>{xray ? "Close X-Ray" : "X-Ray"}</button>
      <button disabled={!spec} onClick={onOpen}>Inspect evidence</button>
    </div>
    {card.phase === "failed" ? <button disabled={busy} onClick={() => void harvest([card.feature_id])}>Retry feature</button> :
      <button className="full" disabled={card.phase !== "ready" || busy} aria-pressed={card.includeInFusion} onClick={() => toggle(card.feature_id)}>{card.includeInFusion ? "Included in app" : "Include in app"}</button>}
  </article>;
}
