import { useEffect, useState } from "react";
import { z } from "zod";
import { streamPost } from "../api/sse";

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
  const [rendererTask, setRendererTask] = useState("");
  const [rendererActivity, setRendererActivity] = useState<string[]>([]);
  const [resourceText, setResourceText] = useState("[]");
  const [entryResource, setEntryResource] = useState("");
  const [replayDiscovery, setReplayDiscovery] = useState("");
  const [recapture, setRecapture] = useState(false);

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
    {archive && <div className="mt-4 rounded border border-stone-700 p-3">
      <label className="block text-sm">Renderer behavior to discover<textarea aria-label="Renderer discovery task" value={rendererTask} onChange={event => setRendererTask(event.target.value)} placeholder="Describe the editing and rendering behavior to recover from the original app" className="mt-2 h-24 w-full rounded border border-stone-600 bg-[#141210] p-2 text-sm" /></label>
      <p className="mt-1 text-xs text-stone-400">The specification model operates the original app, then the host replays its recorded actions in a fresh workspace. Drafts and replay reports remain separate from implementation approval.</p>
      <label className="mt-2 block text-xs text-stone-400">Saved discovery ID to replay without model calls (optional)<input aria-label="Renderer replay discovery ID" value={replayDiscovery} onChange={event => setReplayDiscovery(event.target.value)} placeholder="renderer-…" className="mt-1 w-full rounded border border-stone-600 bg-[#141210] p-2" /></label>
      <label className="mt-2 flex gap-2 text-xs text-stone-400"><input type="checkbox" disabled={!replayDiscovery} checked={recapture} onChange={event => setRecapture(event.target.checked)} />Record a new original revision after host observation changes, then replay it. Earlier evidence and failures are preserved.</label>
      <details className="mt-2 text-xs text-stone-400"><summary>Companion archives for packaged applications</summary>
        <p className="mt-2">Upload each companion archive above, then map its archive ID to the filename used in the original resources folder. Example: [{'{"archive_id":"…","name":"app.asar"}'}].</p>
        <textarea aria-label="Renderer resource archive map" value={resourceText} onChange={event => setResourceText(event.target.value)} className="mt-2 h-20 w-full rounded border border-stone-600 bg-[#141210] p-2 font-mono" />
        <input aria-label="Renderer entry resource filename" value={entryResource} onChange={event => setEntryResource(event.target.value)} placeholder="Entry resource filename, e.g. app.asar" className="mt-2 w-full rounded border border-stone-600 bg-[#141210] p-2" />
      </details>
      <button disabled={busy || (!replayDiscovery && rendererTask.trim().length < 5)} className="mt-2 rounded border border-stone-600 px-3 py-2 text-sm disabled:opacity-50" onClick={() => {
        setBusy(true); setError(""); setRendererActivity([]);
        void (async () => { await streamPost(`/api/electron/archives/${archive}/renderer-discovery`, { task: rendererTask || "Replay saved original observations", confirm_cost: true,
          ...(replayDiscovery ? { replay_discovery_id: replayDiscovery } : {}),
          recapture: Boolean(replayDiscovery && recapture),
          resource_archives: JSON.parse(resourceText), ...(entryResource ? { entry_resource: entryResource } : {}) },
          event => setRendererActivity(previous => [...previous, JSON.stringify(event)].slice(-100)),
          { schema: z.object({ type: z.string() }).passthrough() }); })()
          .catch(cause => setError(String(cause))).finally(() => setBusy(false));
      }}>{replayDiscovery ? recapture ? "Recapture and replay frozen actions" : "Replay saved trace" : "Discover and replay renderer (uses model)"}</button>
      {rendererActivity.length > 0 && <pre aria-live="polite" className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap bg-[#141210] p-2 text-xs">{rendererActivity.join("\n")}</pre>}
    </div>}
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
