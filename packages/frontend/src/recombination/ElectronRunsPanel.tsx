import { useEffect, useState } from "react";

type Archive = { archive_id: string; bytes: number };
type Channel = { channel: string; arity: number };
type Run = { run_id: string; archive_id: string; scope_label: string; channels: string[];
  status: string; ready: boolean | null; error: string | null };

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `${url}: ${response.status}`);
  return body as T;
}

export function ElectronRunsPanel() {
  const [archives, setArchives] = useState<Archive[]>([]);
  const [archive, setArchive] = useState("");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [label, setLabel] = useState("Markdown editor subsystem");
  const [runs, setRuns] = useState<Run[]>([]);
  const [current, setCurrent] = useState<Run | null>(null);
  const [log, setLog] = useState("");
  const [report, setReport] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [catalog, history] = await Promise.all([
      json<{ archives: Archive[] }>("/api/electron/archives"),
      json<{ runs: Run[] }>("/api/electron/runs"),
    ]);
    setArchives(catalog.archives);
    setRuns(history.runs);
    if (!archive && catalog.archives.length) setArchive(catalog.archives[0].archive_id);
  }
  useEffect(() => { void refresh().catch(cause => setError(String(cause))); }, []);
  useEffect(() => {
    if (!archive) return;
    void json<{ channels: Channel[] }>(`/api/electron/archives/${archive}/inventory`)
      .then(value => { setChannels(value.channels); setSelected([]); })
      .catch(cause => setError(String(cause)));
  }, [archive]);
  useEffect(() => {
    if (!current) return;
    let live = true;
    const poll = async () => {
      try {
        const [status, output] = await Promise.all([
          json<{ run: Run }>(`/api/electron/runs/${current.run_id}`),
          json<{ text: string }>(`/api/electron/runs/${current.run_id}/log`),
        ]);
        if (!live) return;
        setCurrent(status.run); setLog(output.text);
        if (status.run.status !== "running") {
          setRuns(previous => [status.run, ...previous.filter(item => item.run_id !== status.run.run_id)]);
          const response = await fetch(`/api/electron/runs/${current.run_id}/report`);
          if (response.ok && live) setReport(await response.json());
        }
      } catch (cause) { if (live) setError(String(cause)); }
    };
    void poll();
    const timer = setInterval(() => { if (current.status === "running") void poll(); }, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [current?.run_id, current?.status]);

  async function upload(file: File) {
    setBusy(true); setError("");
    try {
      const result = await json<Archive>("/api/electron/archives", {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file,
      });
      await refresh(); setArchive(result.archive_id);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function start() {
    setBusy(true); setError(""); setReport(null); setLog("");
    try {
      const result = await json<{ run: Run }>("/api/electron/runs", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archive_id: archive, channels: selected, scope_label: label }),
      });
      setCurrent(result.run); setRuns(previous => [result.run, ...previous]);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }

  return <section className="rounded-xl border border-stone-700 bg-[#211e1b] p-5">
    <h2 className="text-lg font-medium">Electron source-app reconstruction</h2>
    <p className="mt-1 text-sm text-stone-400">Upload an application archive, inspect its IPC channels, and run a scoped specification and implementation job. A scoped ready result does not prove whole-app parity.</p>
    {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
    <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
      <input aria-label="Electron asar archive" type="file" accept=".asar" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
      <select aria-label="Uploaded Electron archive" value={archive} onChange={event => setArchive(event.target.value)} className="rounded border border-stone-600 bg-[#141210] p-2">
        <option value="">Select uploaded archive</option>
        {archives.map(item => <option key={item.archive_id} value={item.archive_id}>{item.archive_id.slice(0, 16)} · {Math.ceil(item.bytes / 1024 / 1024)} MiB</option>)}
      </select>
    </div>
    {channels.length > 0 && <div className="mt-3">
      <p className="text-sm">Select channels for this subsystem ({selected.length} of {channels.length})</p>
      <div className="mt-2 grid max-h-44 gap-1 overflow-auto rounded border border-stone-700 p-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {channels.map(item => <label key={item.channel} className="flex items-center gap-2"><input type="checkbox" checked={selected.includes(item.channel)} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.channel] : previous.filter(name => name !== item.channel))} />{item.channel}</label>)}
      </div>
      <div className="mt-3 flex gap-2"><input aria-label="Subsystem label" value={label} onChange={event => setLabel(event.target.value)} className="min-w-64 rounded border border-stone-600 bg-[#141210] px-3 py-2 text-sm" /><button disabled={busy || !archive || !selected.length || !label.trim()} onClick={() => void start()} className="rounded bg-amber-400 px-3 py-2 text-sm text-stone-950 disabled:opacity-50">Start reconstruction</button></div>
    </div>}
    {runs.length > 0 && <div className="mt-4 flex flex-wrap gap-2">{runs.map(run => <button key={run.run_id} onClick={() => { setCurrent(run); setReport(null); }} className="rounded border border-stone-600 px-2 py-1 text-xs">{run.scope_label} · {run.status}</button>)}</div>}
    {current && <div className="mt-4 text-sm"><p>Run {current.run_id}: {current.status} · {current.ready === null ? "readiness pending" : current.ready ? "scope ready" : "scope not ready"}</p>{current.error && <p className="text-amber-300">{current.error}</p>}{current.status === "running" && <button className="mt-2 text-amber-300" onClick={() => void json(`/api/electron/runs/${current.run_id}/cancel`, { method: "POST" }).then(() => refresh()).catch(cause => setError(String(cause)))}>Cancel run</button>}<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-stone-700 bg-[#141210] p-3 text-xs">{log}</pre>{report !== null && <pre className="mt-2 max-h-64 overflow-auto rounded border border-stone-700 bg-[#141210] p-3 text-xs">{JSON.stringify(report, null, 2)}</pre>}</div>}
  </section>;
}
