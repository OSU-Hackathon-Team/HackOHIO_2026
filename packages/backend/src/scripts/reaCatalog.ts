import fs from "node:fs/promises";
import path from "node:path";
import { rea } from "../rea/reaClient.js";
import { REPO_ROOT } from "../config.js";

async function main() {
  await rea.start();
  const tools = await rea.listTools();
  const session = await rea.callRaw("binary_session", {});

  const outDir = path.join(REPO_ROOT, "fixtures/rea");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "tools.json"), JSON.stringify(tools, null, 2));
  await fs.writeFile(path.join(outDir, "session.json"), JSON.stringify(session, null, 2));

  for (const t of tools) {
    const props = Object.keys((t.inputSchema as any)?.properties ?? {});
    const req = ((t.inputSchema as any)?.required ?? []) as string[];
    console.log(
      `${t.name.padEnd(36)} required=[${req.join(", ")}] optional=[${props.filter((p) => !req.includes(p)).join(", ")}]`,
    );
  }
  console.log(`\n${tools.length} tools. Wrote fixtures/rea/tools.json and session.json`);
  await rea.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
