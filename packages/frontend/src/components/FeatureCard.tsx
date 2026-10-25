// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/07_components.md §5
import { useState } from "react";
import type { Card } from "../store/studioState";
import { useStudio } from "../store/useStudio";
import { developmentMode } from "../api/client";

export function FeatureCard({ card, onOpen }: { card: Card; onOpen: () => void }) {
  const [xray, setXray] = useState(false);
  const toggle = useStudio(s => s.toggleFusion);
  const harvest = useStudio(s => s.harvest);
  const busy = useStudio(s => s.harvesting || s.synth.status === "running");
  const spec = card.spec;
  const verification = card.blueprint?.verification;

  const oracleCount = card.oracleResults ? Object.keys(card.oracleResults).length : 0;
  const oraclePassed = card.oracleResults
    ? Object.values(card.oracleResults).filter(Boolean).length
    : 0;
  const engineCount = card.engineResults ? Object.keys(card.engineResults).length : 0;
  const enginePassed = card.engineResults
    ? Object.values(card.engineResults).filter(Boolean).length
    : 0;

  const originalDisplay = spec?.oracle.total
    ? `${spec.oracle.passed}/${spec.oracle.total}`
    : oracleCount > 0
    ? `${oraclePassed}/${oracleCount}`
    : "Not run";

  const engineDisplay = verification
    ? `${verification.passed}/${verification.total}`
    : engineCount > 0
    ? `${enginePassed}/${engineCount}`
    : "Pending";

  return (
    <article className="feature-card">
      <div className="card-heading">
        <span className="eyebrow">{spec?.source_app ?? card.app_id}</span>
        <span
          className={`badge ${
            card.phase === "ready" ? "green" : card.phase === "failed" ? "red" : "sky"
          }`}
        >
          {card.phase}
        </span>
      </div>
      <h3>{card.title}</h3>
      {card.replayed && (
        <span className="badge amber">
          {developmentMode ? "Development seed · replay mode" : "REPLAY"}
        </span>
      )}
      {spec?.status === "unverified" && (
        <p className="warning">
          Spec unverified · {developmentMode ? "original oracle not run" : spec.open_issues[0]}
        </p>
      )}
      {xray && spec ? (
        <div className="xray">
          <h4>Inside this feature</h4>
          <p>
            {spec.requirements.length} requirements · {spec.provenance.tool_calls.length} recorded
            REA calls
          </p>
          {spec.provenance.snippets[0] ? (
            <pre>{spec.provenance.snippets[0].code.split("\n").slice(0, 12).join("\n")}</pre>
          ) : (
            <p className="muted">No original source recorded for this feature.</p>
          )}
          <p>
            Original: {originalDisplay} · Engine: {engineDisplay}
          </p>
        </div>
      ) : (
        <p className="card-description">{spec?.consumer_description ?? card.message}</p>
      )}
      <p className="small" role="status">
        {verification
          ? `Engine ${verification.passed}/${verification.total} · ${verification.status}`
          : card.message}
      </p>
      {card.error && (
        <p role="alert" className="error">
          {card.error}
        </p>
      )}
      <div className="card-actions">
        <button
          type="button"
          disabled={!spec}
          aria-pressed={xray}
          onClick={() => setXray(!xray)}
        >
          {xray ? "Close X-Ray" : "X-Ray"}
        </button>
        <button type="button" disabled={!spec} onClick={onOpen}>
          Inspect evidence
        </button>
      </div>
      {card.phase === "failed" ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void harvest([card.feature_id])}
        >
          Retry feature
        </button>
      ) : (
        <button
          type="button"
          className="full"
          disabled={card.phase !== "ready" || busy}
          aria-pressed={card.includeInFusion}
          onClick={() => toggle(card.feature_id)}
        >
          {card.includeInFusion ? "Included in app" : "Include in app"}
        </button>
      )}
    </article>
  );
}
