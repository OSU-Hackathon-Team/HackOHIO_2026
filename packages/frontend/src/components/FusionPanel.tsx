// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/07_components.md §7
import { useStudio } from "../store/useStudio";
import { developmentMode } from "../api/client";
export function FusionPanel() {
  const { cards, prompt, setPrompt, fuse, synth, harvesting, cancel } = useStudio(s => s);
  const included = Object.values(cards).filter(c => c.phase === "ready" && c.includeInFusion);
  const busy = harvesting || synth.status === "running";
  return <section className="panel" aria-labelledby="fusion-heading">
    <div className="section-heading"><span className="step green">03</span><h2 id="fusion-heading">Make it your app</h2></div>
    <p className="muted">The interface changes. The checked engines stay locked.</p>
    <div className="engine-chips">{included.map(c => <span className="badge" key={c.feature_id}>{c.title}</span>)}</div>
    {included.some(c => c.spec?.status === "unverified") && <p className="warning">Includes unverified specifications. Engine checks alone do not verify original behavior.</p>}
    <label htmlFor="app-prompt">Describe the app</label>
    <textarea id="app-prompt" maxLength={2000} rows={3} value={prompt} onChange={e => setPrompt(e.target.value)} disabled={busy} />
    {developmentMode && <p className="muted small">This demo loads a fixed study room using both seeds. Your prompt is retained but does not generate a different app.</p>}
    <div className="fusion-actions"><button className="primary" disabled={!included.length || prompt.trim().length < 3 || busy} onClick={() => void fuse()}>Fuse {included.length || ""} engines into an app</button>{busy && <button onClick={cancel}>Cancel work</button>}</div>
    {synth.message && <p role="status" className="small">{synth.message}</p>}
    {synth.error && <p role="alert" className="error">{synth.error}</p>}
    {!!synth.validationErrors.length && <details><summary>Validation problems ({synth.validationErrors.length})</summary><ul>{synth.validationErrors.map((e,i) => <li key={i}>{e}</li>)}</ul></details>}
  </section>;
}
