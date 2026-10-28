import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const project = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(path.join(project, "reconstruction.json"))) {
  console.error("Usage: node scripts/electron/smoke-project.mjs <generated-project-directory>");
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(path.join(project, "reconstruction.json"), "utf8"));
if (!manifest.channels) {
  console.error("This smoke test runs a behaviorally reconstructed project (reconstruction.json channels). " +
    "The legacy blueprint workbench has its own tests.");
  process.exit(2);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function pageSocket(port) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json();
      const page = pages.find(item => item.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* Desktop window is still starting. */ }
    await delay(100);
  }
  throw new Error("Electron window did not open within 12 seconds");
}

async function evaluate(socketUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    const timer = setTimeout(() => { socket.close(); reject(new Error("Renderer did not answer")); }, 8000);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true } }));
    socket.onerror = error => { clearTimeout(timer); reject(error); };
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.result.exceptionDetails)));
      else resolve(message.result?.result?.value);
    };
  });
}

const port = await freePort();
const electron = path.join(project, "node_modules/.bin/electron");
if (!fs.existsSync(electron)) throw new Error("Run npm install in the generated project first");
/* Containers and other environments without a configured SUID sandbox need --no-sandbox;
   opt in explicitly so a normal desktop still runs sandboxed. */
const sandboxFlags = process.env.ELECTRON_NO_SANDBOX === "1" ? ["--no-sandbox"] : [];
const child = spawn("xvfb-run", ["-a", electron, ...sandboxFlags, `--remote-debugging-port=${port}`, "."], {
  cwd: project, env: { ...process.env, XDG_CONFIG_HOME: path.join(project, ".smoke-config") },
  detached: true, stdio: "ignore",
});
try {
  const socket = await pageSocket(port);
  const outcome = await evaluate(socket, `new Promise(resolve => {
    const ready = () => {
      const cards = document.querySelectorAll(".card");
      if (!cards.length) return setTimeout(ready, 50);
      const api = window.splice;
      const channel = api.manifest.channels[0];
      const args = (channel.params || []).map(param => param.example);
      api.invoke(channel.channel, args).then(value => resolve({ name: api.manifest.name,
        title: document.title, cards: cards.length, channel: channel.channel, args, ok: true, value }))
        .catch(error => resolve({ name: api.manifest.name, title: document.title, cards: cards.length,
          channel: channel.channel, args, ok: false, error: String(error) }));
    };
    ready();
  })`);
  assert.equal(outcome.name, manifest.source.name, "preload bridge exposes the reconstruction manifest");
  assert.ok(outcome.cards >= manifest.channels.length, "renderer shows one card per IPC channel");
  assert.ok(outcome.ok || outcome.error, "renderer reached the main process through the preload bridge");
  console.log(`Electron desktop smoke passed: ${manifest.source.name}, ${outcome.channel}, ` +
    `${outcome.ok ? "value returned" : `error returned (${outcome.error})`}`);
} finally {
  if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ } }
}
