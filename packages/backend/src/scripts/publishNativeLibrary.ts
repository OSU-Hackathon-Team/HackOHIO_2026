// Publish an already completed run; no model calls or EC2 startup.
import "../config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { DecompRun, NativeLibraryId } from "@splice/contracts";
import { REPO_ROOT } from "../config.js";
import { nativeLibraryStore, publishImportedAnalysis } from "../decomp/library.js";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

const id = NativeLibraryId.parse(process.argv[2]);
const sourceRoot = path.resolve(process.argv[3] ?? REPO_ROOT);
const state = path.resolve(process.env.DECOMP_STATE_DIR ?? path.join(REPO_ROOT, "decomp-state"));
const record = JSON.parse(await fs.readFile(path.join(state, "runs", `${id}.json`), "utf8"));
const run = DecompRun.parse(record.run);
if (!run.finished_at || !run.result?.handoff_path) throw new Error("run has no completed public handoff");
const store = nativeLibraryStore();
if (!store) throw new Error("Set DECOMP_LIBRARY_BUCKET (or DECOMP_EC2_BUCKET)");
const client = new S3Client({ region: process.env.AWS_REGION ?? "us-east-2" });
const progress = await client.send(new GetObjectCommand({ Bucket: process.env.DECOMP_EC2_BUCKET ?? store.bucket,
  Key: `results/${id}/progress.jsonl` }));
await publishImportedAnalysis(store, run, run.result, state, path.join(sourceRoot, run.result.handoff_path),
  await progress.Body!.transformToString());
console.log(`Published ${id} to the private S3 library.`);
