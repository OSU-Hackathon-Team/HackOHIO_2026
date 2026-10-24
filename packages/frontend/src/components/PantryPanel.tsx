// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/07_components.md §3
import { BookOpen, Clock } from "lucide-react";
import { useStudio } from "../store/useStudio";
import { developmentMode } from "../api/client";
export function PantryPanel() {
  const { pantry, selected, toggleFeature, harvest, harvesting, synth, error, init } = useStudio(s => s);
  return <section className="panel" aria-labelledby="pantry-heading">
    <div className="section-heading"><span className="step amber">01</span><h2 id="pantry-heading">Choose your ingredients</h2></div>
    <p className="muted">Pick the behaviors your next app needs.</p>
    {error && <div role="alert" className="error">{error}<button onClick={() => void init()}>Retry connection</button></div>}
    {!pantry && !error && <p role="status">Loading pantry…</p>}
    {pantry?.apps.map(app => <div className="pantry-app" key={app.app_id}>
      <div className="app-heading">{app.app_id === "inkwell" ? <BookOpen size={20} /> : <Clock size={20} />}<h3>{app.display_name}</h3><span className="artifact">.asar</span></div>
      <p className="muted small">{app.description}</p>
      <div className="feature-options">{app.features.map(f => {
        const unavailable = developmentMode && !["inkwell.wikilink_graph","recall.sm2_scheduler"].includes(f.feature_id);
        return <button key={f.feature_id} aria-pressed={selected.includes(f.feature_id)} disabled={harvesting || synth.status === "running" || unavailable} title={unavailable ? "No development seed; available after live integration" : f.query} onClick={() => toggleFeature(f.feature_id)}>{f.title}{unavailable && <small>Live integration pending</small>}</button>;
      })}</div>
    </div>)}
    <button className="primary full" disabled={!selected.length || harvesting || synth.status === "running"} onClick={() => void harvest()}>Harvest {selected.length || ""} {selected.length === 1 ? "feature" : "features"}</button>
    <p className="muted small">{developmentMode ? "Loads authored seeds and stored local checks. No extraction is performed." : "REA analyzes packaged apps; the oracle runs selected original modules."}</p>
  </section>;
}
