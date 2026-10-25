import { Router } from "express";
import { NativeLibraryId, NativeExtractionRequest, AddLibraryFeatureRequest, NativeDiscoveryRequest, type NativeDiscoveryEvent } from "@splice/contracts";
import { nativeLibraryStore, type NativeLibraryStore } from "../decomp/library.js";
import { adaptSavedEvidence, assembleSavedExtraction, SavedEvidenceError } from "../spec/savedEvidence.js";
import { discoverCapabilities, prepareDiscovery, runDiscovery } from "../spec/discovery.js";
import { writeNativeDraft } from "../spec/nativeDraft.js";
import { openSse } from "../http/sse.js";
import { formatLlmError } from "../llm/llm.js";
import { config } from "../config.js";

export function nativeLibraryRouter(store: NativeLibraryStore | null = nativeLibraryStore(), writer = writeNativeDraft,
  options: { timeoutMs?: number; modelEnabled?: boolean; discover?: typeof discoverCapabilities; discoveryTimeoutMs?: number } = {}): Router {
  const router = Router();
  // One backend process owns the current Studio worker; extraction and discovery share this per-analysis lock.
  const active = new Set<string>();
  router.get("/api/library/features", async (_req, res) => {
    if (!store) return res.json({ features: [] });
    try { return res.json({ features: await store.features() }); }
    catch (error) { return res.status(503).json({ error: `Saved building blocks unavailable: ${(error as Error).message}` }); }
  });
  router.post("/api/library/features", async (req, res) => {
    const parsed = AddLibraryFeatureRequest.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Saved analysis and extraction IDs are required; feature content is loaded from S3" });
    if (!store) return res.status(503).json({ error: "S3 library is not configured" });
    try { return res.json({ feature: await store.addFeature(parsed.data) }); }
    catch (error) { return res.status((error as Error).name === "NoSuchKey" ? 404 : 503).json({ error: (error as Error).message }); }
  });
  router.get("/api/library", async (_req, res) => {
    if (!store) return res.json({ enabled: false, analyses: [], blocks: [] });
    try { return res.json(await store.list()); }
    catch (error) { return res.status(503).json({ error: `Saved library unavailable: ${(error as Error).message}` }); }
  });
  router.get("/api/library/analyses/:id", async (req, res) => {
    if (!NativeLibraryId.safeParse(req.params.id).success) return res.status(400).json({ error: "invalid analysis id" });
    if (!store) return res.status(503).json({ error: "S3 library is not configured" });
    try { return res.json(await store.analysis(req.params.id)); }
    catch (error) {
      return res.status((error as Error).name === "NoSuchKey" ? 404 : 503).json({ error: (error as Error).message });
    }
  });
  router.get("/api/library/analyses/:id/extractions", async (req, res) => {
    if (!NativeLibraryId.safeParse(req.params.id).success) return res.status(400).json({ error: "invalid analysis id" });
    if (!store) return res.status(503).json({ error: "S3 library is not configured" });
    try { return res.json({ extractions: await store.extractions(req.params.id) }); }
    catch (error) { return res.status(503).json({ error: (error as Error).message }); }
  });
  router.post("/api/library/analyses/:id/extract", async (req, res) => {
    const id = req.params.id;
    const parsed = NativeExtractionRequest.safeParse(req.body);
    if (!NativeLibraryId.safeParse(id).success || !parsed.success) return res.status(400).json({ error: "Valid analysis ID and explicit model-cost confirmation are required" });
    if (!store) return res.status(503).json({ error: "S3 library is not configured" });
    if (!(options.modelEnabled ?? config.llmMode === "live")) return res.status(503).json({ error: "Extraction model calls are disabled while LLM_MODE=replay" });
    if (active.has(id)) return res.status(409).json({ error: "An extraction for this analysis is already running" });
    active.add(id);
    try {
      let prepared;
      try { prepared = adaptSavedEvidence(await store.analysis(id), parsed.data); }
      catch (error) {
        return res.status(error instanceof SavedEvidenceError ? 422 : (error as Error).name === "NoSuchKey" ? 404 : 503)
          .json({ error: (error as Error).message });
      }
      if (res.destroyed) return;
      const sse = openSse(req, res);
      const controller = new AbortController();
      const cancel = () => controller.abort(sse.signal.reason);
      sse.signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("Extraction exceeded its three-minute limit")), options.timeoutMs ?? 180_000);
      let ok = false;
      try {
        sse.send({ type: "stage", message: `Extracting a draft from ${prepared.claim_sources.length} supported behavioral claims` });
        controller.signal.throwIfAborted();
        const answer = await writer(prepared.input, { signal: controller.signal,
          onProgress: output_chars => sse.send({ type: "progress", output_chars }) });
        controller.signal.throwIfAborted();
        sse.send({ type: "stage", message: "Validating requirements and saving the draft to S3" });
        const payload = assembleSavedExtraction(prepared, parsed.data, answer);
        const extraction = await store.saveExtraction(payload, prepared.analysis);
        sse.send({ type: "extraction", extraction });
        ok = true;
      } catch (error) {
        if (!sse.signal.aborted) sse.send({ type: "error", message: controller.signal.aborted
          ? String(controller.signal.reason?.message ?? "Extraction cancelled") : formatLlmError(error) });
      } finally {
        clearTimeout(timer);
        sse.signal.removeEventListener("abort", cancel);
        sse.send({ type: "done", ok }); sse.close();
      }
    } finally { active.delete(id); }
  });
  router.get("/api/library/analyses/:id/discoveries", async (req, res) => {
    if (!NativeLibraryId.safeParse(req.params.id).success) return res.status(400).json({ error: "invalid analysis id" });
    if (!store) return res.status(503).json({ error: "S3 library is not configured" });
    try { return res.json({ discoveries: await store.discoveries(req.params.id) }); }
    catch (error) { return res.status(503).json({ error: (error as Error).message }); }
  });
  router.post("/api/library/analyses/:id/discover", async (req, res) => {
    const id = req.params.id;
    const parsed = NativeDiscoveryRequest.safeParse(req.body);
    if (!NativeLibraryId.safeParse(id).success || !parsed.success) return res.status(400).json({ error: "Valid analysis ID and explicit model-cost confirmation are required" });
    if (!store) return res.status(503).json({ error: "S3 library is not configured" });
    if (!(options.modelEnabled ?? config.llmMode === "live")) return res.status(503).json({ error: "Discovery model calls are disabled while LLM_MODE=replay" });
    if (active.has(id)) return res.status(409).json({ error: "Discovery or extraction for this analysis is already running" });
    active.add(id);
    try {
      let prepared;
      try { prepared = prepareDiscovery(await store.analysis(id)); }
      catch (error) {
        return res.status(error instanceof SavedEvidenceError ? 422 : (error as Error).name === "NoSuchKey" ? 404 : 503)
          .json({ error: (error as Error).message });
      }
      if (res.destroyed) return;
      const sse = openSse(req, res);
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new Error("Discovery exceeded its ten-minute limit")), options.discoveryTimeoutMs ?? 600_000);
      const send = (event: NativeDiscoveryEvent) => { if (!sse.signal.aborted) sse.send(event); };
      let ok = false;
      try {
        const report = await runDiscovery(prepared, { discover: options.discover ?? discoverCapabilities, writer,
          saveExtraction: (payload, snapshot) => store.saveExtraction(payload, snapshot),
          signal: AbortSignal.any([sse.signal, deadline.signal]), cancelled: sse.signal,
          draftTimeoutMs: options.timeoutMs ?? 180_000, emit: send });
        // The report is saved even after cancellation so already-saved drafts stay accounted for.
        send({ type: "stage", message: "Saving the discovery report" });
        const saved = await store.saveDiscovery(report, prepared.analysis);
        send({ type: "report", report: saved });
        if (saved.error && saved.status !== "partial") send({ type: "error", message: saved.error });
        ok = ["complete", "partial", "empty"].includes(saved.status);
      } catch (error) {
        send({ type: "error", message: `Discovery report could not be saved: ${formatLlmError(error)}` });
      } finally {
        clearTimeout(timer);
        send({ type: "done", ok }); sse.close();
      }
    } finally { active.delete(id); }
  });
  return router;
}
