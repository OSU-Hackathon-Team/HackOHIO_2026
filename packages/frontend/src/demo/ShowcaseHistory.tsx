import { useRef, useState } from "react";
import { applyTableOp, evaluateGrid } from "./notesDocument";
import { renderMarkdown } from "./engines/obsidianRenderer";
import { CALC_FEATURE, OBSIDIAN_FEATURE } from "./fixtures";
import { demoSpec, playDemoRun } from "./script";

export function ShowcaseHistory({ card, button, soft }: { card: string; button: string; soft: string }) {
  const [logs, setLogs] = useState<string[]>([]);
  const [checks, setChecks] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const replay = async (feature: string) => {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller; setLogs([]); setRunning(true);
    try { await playDemoRun(demoSpec(feature), event => {
      if (event.type === "stage") setLogs(current => [...current, event.message]);
      else if (event.type === "done") setLogs(current => [...current, "Recorded timeline complete. These events are a replay of run 2."]);
    }, controller.signal, 12); }
    catch (error) { if (!controller.signal.aborted) setLogs(current => [...current, String(error)]); }
    finally { if (abort.current === controller) setRunning(false); }
  };
  const check = () => {
    const result: string[] = [];
    const rendered = renderMarkdown("# Splice\n\nA **working** note.").html;
    result.push(rendered.includes("<strong>working</strong>") ? "PASS · Obsidian renderer produced bold Markdown" : "FAIL · Markdown rendering");
    const values = evaluateGrid([["Item", "Qty", "Price", "Total"], ["Hotel", 3, 120, "=B2*C2"]]);
    result.push(values[1][3] === 360 ? "PASS · Calc engine evaluated 3 × 120 = 360" : "FAIL · Formula evaluation");
    const sorted = applyTableOp([["Item", "Qty"], ["Z", 3], ["A", 1]], { type: "sort", column: 0, ascending: true });
    result.push(sorted[1][0] === "A" ? "PASS · Calc engine sorted the table" : "FAIL · Table sorting");
    setChecks(result);
  };
  return <div className="min-h-0 flex-1 overflow-y-auto p-7"><h2 className="text-2xl font-semibold">Extraction history</h2><p className={`mt-2 max-w-3xl text-sm ${soft}`}>These capabilities were reconstructed before the showcase. The timeline below replays recorded run-2 stages. The local checks run the bundled engines on this machine now.</p><div className="mt-6 grid grid-cols-2 gap-4"><div className={`rounded-xl border p-5 ${card}`}><h3 className="font-semibold">Obsidian Markdown editor</h3><p className={`mt-2 text-sm ${soft}`}>Recorded UI observations and an independently implemented Markdown renderer. The original editor was observed through the UI because the main-process IPC channels did not render Markdown.</p><button className={`${button} mt-4`} onClick={() => void replay(OBSIDIAN_FEATURE)}>Replay recorded steps</button></div><div className={`rounded-xl border p-5 ${card}`}><h3 className="font-semibold">LibreOffice Calc tables</h3><p className={`mt-2 text-sm ${soft}`}>Recorded native evidence, reviewed behavioral claims, and original Calc outputs informed the table operation and formula engine used in this app.</p><button className={`${button} mt-4`} onClick={() => void replay(CALC_FEATURE)}>Replay recorded steps</button></div></div><div className={`mt-4 rounded-xl border p-5 ${card}`}><div className="flex items-center justify-between"><h3 className="font-semibold">Live local checks</h3><button className={button} onClick={check}>Run engine checks</button></div><div className={`mt-3 space-y-1 font-mono text-xs ${soft}`}>{checks.length ? checks.map((line,i) => <p key={i}>{line}</p>) : <p>Checks have not run in this session.</p>}</div></div><div className={`mt-4 rounded-xl border p-5 ${card}`}><div className="flex items-center justify-between"><h3 className="font-semibold">Recorded timeline</h3>{running && <button className={button} onClick={() => abort.current?.abort()}>Stop replay</button>}</div><div className={`mt-3 max-h-64 space-y-1 overflow-y-auto font-mono text-xs ${soft}`}>{logs.length ? logs.map((line,i) => <p key={i}>{line}</p>) : <p>Choose a capability above to replay its recorded run.</p>}</div></div></div>;
}
