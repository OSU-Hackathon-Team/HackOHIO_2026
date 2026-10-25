import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { recreateRecall } from "./recreate-recall.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function pageSocket(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json();
      const page = pages.find(item => item.type === "page" && item.title === "Recall");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* Electron is still starting. */ }
    await delay(100);
  }
  throw new Error("Electron did not expose a Recall window within 10 seconds");
}

async function evaluate(socketUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    const timer = setTimeout(() => { socket.close(); reject(new Error("Electron renderer did not answer")); }, 5000);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
      expression, returnByValue: true, awaitPromise: true,
    } }));
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

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "splice-recall-runtime-"));
  const output = path.join(temp, "app");
  let child;
  try {
    recreateRecall(path.join(repo, "targets/build/recall/app.asar"), output);
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: output, stdio: "inherit" });
    const port = await freePort();
    child = spawn("xvfb-run", ["-a", path.join(output, "node_modules/.bin/electron"),
      `--remote-debugging-port=${port}`, "."], {
      cwd: output, env: { ...process.env, XDG_CONFIG_HOME: path.join(temp, "config") },
      detached: true, stdio: "ignore",
    });
    const socket = await pageSocket(port);
    const initial = await evaluate(socket, `new Promise(resolve => {
      const check = () => document.body.innerText.includes("What makes a review due?") ? resolve(document.body.innerText) : setTimeout(check, 50);
      check();
    })`);
    assert.match(initial, /Current streak: 0/);
    const after = await evaluate(socket, `new Promise(resolve => {
      document.querySelector('[aria-label="Grade 5"]').click();
      const check = () => document.body.innerText.includes("Reviews: 1") ? resolve(document.body.innerText) : setTimeout(check, 50);
      check();
    })`);
    assert.match(after, /Interval: 1 day\(s\)/);
    assert.match(after, /Current streak: 1/);
    const deck = JSON.parse(await fs.readFile(path.join(temp, "config", "recall-recreated", "decks", "demo.json"), "utf8"));
    assert.equal(deck.cards[0].reps, 1);
    assert.equal(deck.history.length, 1);
    console.log("Electron 45 runtime: local window rendered, grade 5 updated the UI and persisted the deck");
  } finally {
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
    }
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
