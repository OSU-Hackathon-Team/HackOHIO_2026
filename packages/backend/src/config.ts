import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const flag = z.enum(["0", "1"]).default("0").transform((v) => v === "1");
// "mock" is the Docker/compose/CI default across the repo; it means "no live calls" = replay.
const mode = <T extends string>(values: readonly [T, ...T[]], dflt: T) =>
  z.enum([...values, "mock"] as [string, ...string[]]).default(dflt)
    .transform((v) => (v === "mock" ? "replay" : v) as T);

const Env = z.object({
  PORT: z.coerce.number().default(3001),
  AWS_REGION: z.string().default("us-east-2"),           // Bedrock region; creds come from the AWS chain
  LLM_DEBUG: flag,
  REA_MODE: mode(["live", "replay", "auto"] as const, "auto"),
  LLM_MODE: mode(["live", "replay"] as const, "live"),
  REA_VERSION: z.string().default("6.7.0"),
  REA_CALL_TIMEOUT_MS: z.coerce.number().default(60_000),
  REA_RUN_BUDGET_MS: z.coerce.number().default(45_000),
  REA_MAX_RESPONSE_BYTES: z.coerce.number().default(2_000_000),
  REA_DEBUG: flag,
});

const env = Env.parse(process.env);

export const config = {
  port: env.PORT,
  awsRegion: env.AWS_REGION,
  llmDebug: env.LLM_DEBUG,
  reaMode: env.REA_MODE,
  llmMode: env.LLM_MODE,
  reaVersion: env.REA_VERSION,
  reaCallTimeoutMs: env.REA_CALL_TIMEOUT_MS,
  reaRunBudgetMs: env.REA_RUN_BUDGET_MS,
  reaMaxResponseBytes: env.REA_MAX_RESPONSE_BYTES,
  reaDebug: env.REA_DEBUG,
} as const;

if (config.llmMode === "live" && !process.env.AWS_PROFILE && !process.env.AWS_ACCESS_KEY_ID) {
  console.warn("[config] LLM_MODE=live but no AWS_PROFILE / AWS_ACCESS_KEY_ID set — relying on the default AWS credential chain (SSO, ~/.aws)");
}
