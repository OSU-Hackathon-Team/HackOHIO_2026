import { discoverRenderer } from "../recombination/rendererDiscovery.js";

const [archive, directory, task, packaging] = process.argv.slice(2);
const controller = new AbortController();
const emit = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
process.on("SIGTERM", () => controller.abort(new Error("Renderer discovery cancelled")));
try {
  const draft = await discoverRenderer({ archive, directory, task, ...(packaging ? JSON.parse(packaging) : {}), signal: controller.signal, emit });
  emit({ type: "draft", draft });
} catch (error) {
  emit({ type: "error", message: (error as Error).message }); process.exitCode = 1;
}
