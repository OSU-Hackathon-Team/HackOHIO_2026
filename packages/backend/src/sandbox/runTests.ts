// Owner: Eng 2 (Requirements) — spec: agents/2_requirements_extraction/04_sandbox_runner.md §3
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { transform } from "esbuild";
import { z } from "zod";
import { TestCaseResult } from "@splice/contracts";

export const SandboxModuleSchema = z.object({
  path: z.string().min(1),
  code: z.string(),
});
export type SandboxModule = z.infer<typeof SandboxModuleSchema>;

export const RunTestsInputSchema = z.object({
  kind: z.enum(["oracle", "acceptance"]),
  subject: z.object({
    code: z.string(),
    lang: z.enum(["js", "ts"]),
  }),
  tests: z.string(),
  originals: z.array(SandboxModuleSchema).optional().default([]),
  requireOriginalCalls: z.boolean().optional(),
  perTestTimeoutMs: z.number().int().positive().optional().default(500),
  totalTimeoutMs: z.number().int().positive().optional().default(8000),
});
export type RunTestsInput = z.infer<typeof RunTestsInputSchema>;

export const RunTestsResultSchema = z.object({
  fatal: z.string().nullable(),
  tests: z.array(TestCaseResult),
  passed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  duration_ms: z.number().nonnegative(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
});
export type RunTestsResult = z.infer<typeof RunTestsResultSchema>;

async function toCjs(code: string, lang: "js" | "ts", sourcefile: string): Promise<string> {
  const r = await transform(code, {
    loader: lang,
    format: "cjs",
    target: "es2022",
    sourcefile,
  });
  return r.code;
}

export function resolveWorkerUrl(): URL {
  // 1. In dist/sandbox or alongside runTests
  const localUrl = new URL("./worker.cjs", import.meta.url);
  try {
    if (fs.existsSync(fileURLToPath(localUrl))) return localUrl;
  } catch {
    // ignore
  }

  // 2. In src/sandbox when running compiled from dist
  const srcUrl = new URL("../../src/sandbox/worker.cjs", import.meta.url);
  try {
    if (fs.existsSync(fileURLToPath(srcUrl))) return srcUrl;
  } catch {
    // ignore
  }

  return localUrl;
}

const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KB stdout/stderr cap

export async function runTests(rawInput: unknown): Promise<RunTestsResult> {
  const t0 = performance.now();
  const done = (
    fatal: string | null,
    tests: TestCaseResult[] = [],
    stdout = "",
    stderr = "",
    exitCode: number | null = 0,
  ): RunTestsResult => ({
    fatal,
    tests,
    passed: tests.filter((t) => t.passed).length,
    total: tests.length,
    duration_ms: Math.round(performance.now() - t0),
    stdout,
    stderr,
    exitCode,
  });

  // Boundary validation of input
  const parsed = RunTestsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    return done(`Invalid input: ${issues}`, [], "", "", null);
  }
  const input = parsed.data;

  let subjectJs: string;
  let testsJs: string;
  try {
    subjectJs = await toCjs(input.subject.code, input.subject.lang, input.kind === "oracle" ? "adapter.js" : "engine.ts");
    testsJs = await toCjs(input.tests, "ts", "tests.ts");
  } catch (e) {
    return done(`Compile error: ${(e as Error).message}`);
  }

  const totalTimeout = input.totalTimeoutMs;
  const workerUrl = resolveWorkerUrl();

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    let worker: Worker;
    try {
      worker = new Worker(workerUrl, {
        workerData: {
          kind: input.kind,
          subjectJs,
          testsJs,
          originals: input.originals,
          perTestTimeoutMs: input.perTestTimeoutMs,
          requireOriginalCalls: input.requireOriginalCalls ?? input.kind === "oracle",
        },
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
        stdout: true,
        stderr: true,
      });
    } catch (err) {
      resolve(done(`Failed to spawn sandbox worker: ${(err as Error).message}`, [], "", "", null));
      return;
    }

    const timer = setTimeout(() => {
      finish(done(`Timed out after ${totalTimeout}ms (infinite loop or very slow code?)`, [], stdout, stderr, null));
    }, totalTimeout);

    const finish = (result: RunTestsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => {});
      resolve(result);
    };

    worker.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.toString("utf8");
      }
    });

    worker.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk.toString("utf8");
      }
    });

    worker.once("message", (m: { fatal: string | null; tests: TestCaseResult[] }) => {
      finish(done(m.fatal, m.tests, stdout, stderr, 0));
    });

    worker.once("error", (e: Error) => {
      finish(done(`Sandbox crashed: ${e.message}`, [], stdout, stderr, null));
    });

    worker.once("exit", (exitCode: number) => {
      if (!settled) {
        finish(done(`Sandbox worker exited prematurely with code ${exitCode}`, [], stdout, stderr, exitCode));
      }
    });
  });
}
