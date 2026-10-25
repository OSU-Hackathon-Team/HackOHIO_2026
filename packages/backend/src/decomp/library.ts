import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SavedAnalysis, SavedAnalysisSummary, SavedBlock, NativeLibraryId, NativeExtraction, NativeExtractionPayload, AddLibraryFeatureRequest,
  NativeDiscoveryReport, NativeDiscoveryReportPayload, type FeatureBlueprint, type DecompRun, type DecompRunResult } from "@splice/contracts";
import { publicSpecContainsSource, sourceLikeText } from "../spec/nativeSafety.js";

function discoveryContainsSource(report: { explanation: string; capabilities: { name: string; purpose: string }[]; unassigned: { reason: string }[] }) {
  return [report.explanation, ...report.capabilities.flatMap(c => [c.name, c.purpose]), ...report.unassigned.map(u => u.reason)]
    .some(value => sourceLikeText(value));
}

/** The bucket stays private. The API serves selected public evidence, never the result archive. */
export class NativeLibraryStore {
  constructor(readonly bucket: string, private readonly client: Pick<S3Client, "send">) {}

  private async read(key: string): Promise<unknown> {
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return JSON.parse(await object.Body!.transformToString());
  }

  private async put(key: string, value: unknown): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key,
      Body: JSON.stringify(value), ContentType: "application/json", ServerSideEncryption: "AES256" }));
  }

  async saveAnalysis(input: unknown): Promise<void> {
    const analysis = SavedAnalysis.parse(input);
    if (analysis.spec && publicSpecContainsSource(analysis.spec)) throw new Error("spec contains source-like text");
    await this.put(`library/analyses/${analysis.id}/evidence.json`, analysis);
    // Publish the discoverable summary last, after its evidence is durable.
    await this.put(`library/analyses/${analysis.id}/manifest.json`, SavedAnalysisSummary.parse(analysis));
  }

  async analysis(id: string): Promise<SavedAnalysis> {
    NativeLibraryId.parse(id);
    const analysis = SavedAnalysis.parse(await this.read(`library/analyses/${id}/evidence.json`));
    if (analysis.id !== id) throw new Error("saved analysis identity mismatch");
    return analysis;
  }

  async saveBlock(blueprint: FeatureBlueprint): Promise<void> {
    const checked = SavedBlock.shape.blueprint.parse(blueprint);
    if (checked.verification.status !== "passed" || checked.verification.total < 1 ||
        checked.verification.passed !== checked.verification.total ||
        checked.verification.tests.some(t => !t.passed)) throw new Error("Only passing engines can be saved as building blocks");
    const id = createHash("sha256").update(JSON.stringify(checked)).digest("hex");
    await this.put(`library/blocks/${id}.json`, SavedBlock.parse({ schema: 1, id, blueprint: checked }));
  }

  async saveExtraction(input: unknown, snapshot: SavedAnalysis): Promise<NativeExtraction> {
    const payload = NativeExtractionPayload.parse(input);
    const bytes = JSON.stringify(SavedAnalysis.parse(snapshot));
    if (payload.analysis_id !== snapshot.id || createHash("sha256").update(bytes).digest("hex") !== payload.analysis_sha256) {
      throw new Error("extraction does not match its saved analysis snapshot");
    }
    if (publicSpecContainsSource(payload.spec)) throw new Error("spec contains source-like text");
    const id = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const record = NativeExtraction.parse({ ...payload, id });
    await this.put(`library/analyses/${snapshot.id}/snapshots/${payload.analysis_sha256}.json`, JSON.parse(bytes));
    await this.put(`library/analyses/${snapshot.id}/extractions/${id}.json`, record);
    return record;
  }

  async saveDiscovery(input: unknown, snapshot: SavedAnalysis): Promise<NativeDiscoveryReport> {
    const payload = NativeDiscoveryReportPayload.parse(input);
    const bytes = JSON.stringify(SavedAnalysis.parse(snapshot));
    if (payload.analysis_id !== snapshot.id || createHash("sha256").update(bytes).digest("hex") !== payload.analysis_sha256) {
      throw new Error("discovery report does not match its saved analysis snapshot");
    }
    if (discoveryContainsSource(payload)) throw new Error("discovery report contains source-like text");
    const id = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const record = NativeDiscoveryReport.parse({ ...payload, id });
    await this.put(`library/analyses/${snapshot.id}/snapshots/${payload.analysis_sha256}.json`, JSON.parse(bytes));
    await this.put(`library/analyses/${snapshot.id}/discoveries/${id}.json`, record);
    return record;
  }

  async discoveries(analysisId: string): Promise<NativeDiscoveryReport[]> {
    NativeLibraryId.parse(analysisId);
    const prefix = `library/analyses/${analysisId}/discoveries/`;
    const records: NativeDiscoveryReport[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: cursor }));
      for (const item of page.Contents ?? []) {
        const name = (item.Key ?? "").slice(prefix.length);
        if (!(item.Key ?? "").startsWith(prefix) || !/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const record = NativeDiscoveryReport.parse(await this.read(item.Key!));
        const hash = createHash("sha256").update(JSON.stringify(NativeDiscoveryReportPayload.parse(record))).digest("hex");
        if (record.analysis_id !== analysisId || record.id !== hash || name !== `${hash}.json`) throw new Error("discovery report hash or identity mismatch");
        records.push(record);
      }
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (cursor);
    return records.sort((a, b) => b.created_at - a.created_at);
  }

  async extractions(analysisId: string): Promise<NativeExtraction[]> {
    NativeLibraryId.parse(analysisId);
    const prefix = `library/analyses/${analysisId}/extractions/`;
    const records: NativeExtraction[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: cursor }));
      for (const item of page.Contents ?? []) {
        const key = item.Key ?? "";
        if (!key.startsWith(prefix) || !/^[a-f0-9]{64}\.json$/.test(key.slice(prefix.length))) continue;
        records.push(await this.extraction(analysisId, key.slice(prefix.length, -5)));
      }
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (cursor);
    return records.sort((a, b) => b.created_at - a.created_at);
  }

  async extraction(analysisId: string, extractionId: string): Promise<NativeExtraction> {
    const request = AddLibraryFeatureRequest.parse({ analysis_id: analysisId, extraction_id: extractionId });
    const record = NativeExtraction.parse(await this.read(`library/analyses/${request.analysis_id}/extractions/${request.extraction_id}.json`));
    const hash = createHash("sha256").update(JSON.stringify(NativeExtractionPayload.parse(record))).digest("hex");
    if (record.analysis_id !== analysisId || record.id !== hash || extractionId !== hash) throw new Error("extraction hash or identity mismatch");
    if (publicSpecContainsSource(record.spec)) throw new Error("saved specification contains source-like text");
    return record;
  }

  async addFeature(input: unknown): Promise<NativeExtraction> {
    const pointer = AddLibraryFeatureRequest.parse(input);
    const record = await this.extraction(pointer.analysis_id, pointer.extraction_id);
    // Library membership is a pointer to the immutable extraction, not a readiness promotion.
    await this.put(`library/features/${record.id}.json`, pointer);
    return record;
  }

  async features(): Promise<NativeExtraction[]> {
    const records: NativeExtraction[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket,
        Prefix: "library/features/", ContinuationToken: cursor }));
      for (const item of page.Contents ?? []) {
        const key = item.Key ?? "";
        if (!/^library\/features\/[a-f0-9]{64}\.json$/.test(key)) continue;
        const pointer = AddLibraryFeatureRequest.parse(await this.read(key));
        if (key !== `library/features/${pointer.extraction_id}.json`) throw new Error("library feature identity mismatch");
        records.push(await this.extraction(pointer.analysis_id, pointer.extraction_id));
      }
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (cursor);
    return records.sort((a, b) => b.created_at - a.created_at);
  }

  async list() {
    const analyses: SavedAnalysisSummary[] = [], blocks: SavedBlock[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket,
        Prefix: "library/", ContinuationToken: cursor }));
      for (const item of page.Contents ?? []) {
        const key = item.Key ?? "";
        if (/^library\/analyses\/[a-z0-9-]{8,64}\/manifest\.json$/.test(key)) {
          analyses.push(SavedAnalysisSummary.parse(await this.read(key)));
        } else if (/^library\/blocks\/[a-f0-9]{64}\.json$/.test(key)) {
          const block = SavedBlock.parse(await this.read(key));
          const hash = createHash("sha256").update(JSON.stringify(block.blueprint)).digest("hex");
          if (hash !== block.id || !key.endsWith(`/${hash}.json`)) throw new Error("building block hash mismatch");
          if (block.blueprint.verification.status !== "passed") throw new Error("saved building block has not passed verification");
          blocks.push(block);
        }
      }
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (cursor);
    return { enabled: true, analyses: analyses.sort((a, b) => b.created_at - a.created_at), blocks };
  }
}

export function nativeLibraryStore(): NativeLibraryStore | null {
  const bucket = process.env.DECOMP_LIBRARY_BUCKET ?? process.env.DECOMP_EC2_BUCKET;
  return bucket ? new NativeLibraryStore(bucket, new S3Client({ region: process.env.AWS_REGION ?? "us-east-2", maxAttempts: 3 })) : null;
}

/** Publishes only the handoff's public cases and explicitly referenced function evidence. */
export async function publishImportedAnalysis(store: NativeLibraryStore, run: DecompRun, result: DecompRunResult,
  stateDir: string, handoffDir: string, progress: string): Promise<void> {
  const handoff = JSON.parse(await fs.readFile(path.join(handoffDir, "evidence.json"), "utf8"));
  if (handoff.functions?.length !== result.functions.included) throw new Error("handoff function count does not match the completed run");
  const decompiled = new Map<string, string>();
  for (const line of progress.split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.stage !== "function_exported" || !/^[a-f0-9]{64}$/.test(event.artifact)) continue;
    const bytes = await fs.readFile(path.join(stateDir, "artifacts", event.artifact.slice(0, 2), event.artifact));
    if (createHash("sha256").update(bytes).digest("hex") !== event.artifact) throw new Error("function evidence hash mismatch");
    const evidence = JSON.parse(bytes.toString("utf8"));
    const code = typeof evidence.decompilation === "string" ? evidence.decompilation : evidence.decompilation?.c;
    if (typeof code === "string") decompiled.set(event.address, code);
  }
  let spec = null;
  if (result.spec_artifact) {
    const digest = result.spec_artifact;
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid spec digest");
    const bytes = await fs.readFile(path.join(stateDir, "artifacts", digest.slice(0, 2), digest));
    if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("spec hash mismatch");
    spec = JSON.parse(bytes.toString("utf8"));
  }
  await store.saveAnalysis({ schema: 1, id: run.run_id, title: "LibreOffice Calc", target_id: run.target_id,
    created_at: run.started_at, binary_sha256: handoff.source.binary_sha256, result, spec,
    functions: handoff.functions.map((f: Record<string, unknown>) => ({ ...f, decompilation: decompiled.get(String(f.entry)) ?? null })),
    observed_cases: handoff.observed_cases });
}
