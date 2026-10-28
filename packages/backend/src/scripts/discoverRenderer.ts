import { discoverRenderer } from "../recombination/rendererDiscovery.js";
import { RendererReplaySource } from "../recombination/rendererReplay.js";

const [archive, directory, task, packaging] = process.argv.slice(2);
const controller = new AbortController();
const emit = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
process.on("SIGTERM", () => controller.abort(new Error("Renderer discovery cancelled")));
try {
  const draft = await discoverRenderer({ archive, directory, task, ...(packaging ? JSON.parse(packaging) : {}), signal: controller.signal, emit });
  emit({ type: "draft", draft });
  const source = RendererReplaySource.parse(draft);
  const report = await discoverRenderer({ archive, directory: `${directory}/replay`, task,
    ...(packaging ? JSON.parse(packaging) : {}), replay: source, signal: controller.signal, emit });
  emit({ type: "report", report });
  if (report.status !== "passed") process.exitCode = 1;
} catch (error) {
  emit({ type: "error", message: (error as Error).message }); process.exitCode = 1;
}
