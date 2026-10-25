// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/07_components.md §6
import { useEffect, useRef, useState } from "react";
import type { Card } from "../store/studioState";
import { developmentMode } from "../api/client";
export function EvidenceDrawer({ card, onClose }: { card: Card; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState("Requirements"), [highlight, setHighlight] = useState<string[]>([]);
  const spec = card.spec!, bp = card.blueprint;
  useEffect(() => {
    const el = dialog.current!, previous = document.activeElement as HTMLElement | null;
    el.showModal(); return () => { el.close(); previous?.focus(); };
  }, []);
  const names = Array.from(new Set([...spec.oracle.tests.map(t => t.name), ...(bp?.verification.tests ?? []).map(t => t.name)]));
  return <dialog ref={dialog} className="evidence-drawer" aria-labelledby="evidence-title" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="drawer-inner">
      <header className="drawer-header"><div><p className="eyebrow">Feature evidence</p><h2 id="evidence-title">{card.title}</h2></div><button autoFocus onClick={onClose} aria-label="Close evidence">Close</button></header>
      {developmentMode && <p className="notice">Development data. Local engine checks are real; original-code tests and REA extraction have not run.</p>}
      {spec.open_issues.map(issue => <p className="warning" key={issue}>{issue}</p>)}
      <nav className="tabs" aria-label="Evidence sections">{["Requirements", "Original source", "Tests", "Engine"].map(t => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>)}</nav>
      {tab === "Requirements" && <div>{spec.requirements.map(r => <article className="requirement" key={r.id}>
        <h3>{r.id} <small>{r.kind}</small></h3><p>{r.statement}</p>
        <button onClick={() => { setHighlight(r.source_refs); setTab("Original source"); }}>View cited lines</button>
        <p className="mono small">{r.source_refs.join(", ")}</p><p className="muted small">{spec.coverage.find(c => c.requirement_id === r.id)?.test_names.length ?? 0} traced test names · traceability does not prove completeness</p>
      </article>)}</div>}
      {tab === "Original source" && <div>
        <p className="mono small">{spec.provenance.target.path}</p><p className="mono small">Archive SHA-256: {spec.provenance.target.sha256}</p>
        <p>REA: {spec.provenance.rea_package_version} · {spec.provenance.tool_calls.length} recorded calls</p>
        {spec.provenance.tool_calls.map(c => <p className="mono small" key={c.seq}>{c.tool} · {c.duration_ms}ms · {c.evidence_id ?? "No evidence ID"}</p>)}
        {!spec.provenance.snippets.length && <p className="empty-state">No original source recorded. This seed cannot establish agreement with the original.</p>}
        {spec.provenance.snippets.map(snippet => <section key={snippet.location}><h3>{snippet.location}</h3><pre>{snippet.code.split("\n").map((line,i) => {
          const marked = highlight.some(ref => { const m = ref.match(/^(.+):L(\d+)-L(\d+)$/); return m && snippet.location.endsWith(m[1]) && i+1 >= +m[2] && i+1 <= +m[3]; });
          return <span className={marked ? "source-line highlighted" : "source-line"} key={i}><span className="line-number">{i+1}</span>{line}{"\n"}</span>;
        })}</pre></section>)}
        <h3>Limitations and unknowns</h3>{[...spec.provenance.limitations,...spec.provenance.unknowns].map((s,i) => <p key={i}>{s}</p>)}
      </div>}
      {tab === "Tests" && <div><p>Original and engine results are separate. Passing cases do not prove complete equivalence.</p>
        <div className="table-scroll"><table><caption>{developmentMode ? "Local seed checks; original oracle not run" : "Original versus engine"}</caption><thead><tr><th>Test</th><th>Original</th><th>Engine</th></tr></thead><tbody>
          {names.map(name => <tr key={name}><th>{name}</th><td>{result(spec.oracle.tests.find(t => t.name === name)?.passed)}</td><td>{result(bp?.verification.tests.find(t => t.name === name)?.passed)}</td></tr>)}
        </tbody></table></div></div>}
      {tab === "Engine" && <div>{bp ? <><p className="mono small">Engine model: {bp.verification.model} · Spec model: {spec.provenance.model}</p><pre>{bp.implementation.portable_code}</pre>{[...bp.implementation.notes,...spec.allowed_deviations].map((s,i) => <p key={i}>{s}</p>)}</> : <p>Engine is not available yet.</p>}</div>}
    </div>
  </dialog>;
}
function result(passed: boolean | undefined) { return passed === undefined ? "Not run" : passed ? "Passed" : "Failed"; }
