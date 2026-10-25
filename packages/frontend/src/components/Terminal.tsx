// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/07_components.md §4
import { useEffect, useRef } from "react";
import { useStudio } from "../store/useStudio";
export function Terminal() {
  const log = useStudio(s => s.log); const ref = useRef<HTMLDivElement>(null); const stick = useRef(true);
  useEffect(() => { if (ref.current && stick.current) ref.current.scrollTop = ref.current.scrollHeight; }, [log.length]);
  return <section className="terminal" aria-labelledby="terminal-heading">
    <div className="terminal-heading"><h2 id="terminal-heading">Pipeline activity</h2><span>{log.length} events</span></div>
    <div ref={ref} className="terminal-lines" tabIndex={0} aria-label="Pipeline log" onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32; }}>
      {!log.length && <p className="muted">Select features, then Harvest to follow their progress.</p>}
      {log.map(l => <p key={l.id}><time>{new Date(l.ts).toLocaleTimeString()}</time> <span className="log-feature">{l.feature.split(".")[0]}</span> {l.text}</p>)}
    </div>
  </section>;
}
