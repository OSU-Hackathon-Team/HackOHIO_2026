import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const project = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(path.join(project, "reconstruction.json"))) {
  console.error("Usage: node scripts/electron/smoke-project.mjs <generated-project-directory>");
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(path.join(project, "reconstruction.json"), "utf8"));
const require = createRequire(import.meta.url);
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
      const page = pages.find(item => item.type === "page" && item.title === "Feature Workbench");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* Desktop window is still starting. */ }
    await delay(100);
  }
  throw new Error("Electron workbench did not open within 12 seconds");
}

async function evaluate(socketUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    const timer = setTimeout(() => { socket.close(); reject(new Error("Renderer did not answer")); }, 5000);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
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
const child = spawn("xvfb-run", ["-a", electron, `--remote-debugging-port=${port}`, "."], {
  cwd: project, env: { ...process.env, XDG_CONFIG_HOME: path.join(project, ".smoke-config") },
  detached: true, stdio: "ignore",
});
try {
  const socket = await pageSocket(port);
  const expectedFeature = manifest.features[0];
  const expectedFunction = expectedFeature.functions[0];
  const outcome = await evaluate(socket, `new Promise(resolve => {
    const ready = () => {
      const feature = document.querySelector('#feature');
      if (!feature?.options.length) return setTimeout(ready, 50);
      const args = document.querySelector('#arguments');
      const result = document.querySelector('#result');
      const run = document.querySelector('#run');
      const sample = args.value;
      run.click();
      const start = Date.now();
      const checkSuccess = () => {
        if (result.textContent === ${JSON.stringify(expectedFunction.description)} && Date.now() - start < 3000) return setTimeout(checkSuccess, 50);
        const success = result.textContent;
        args.value = '{oops';
        run.click();
        const error = result.textContent;
        resolve({ title: document.querySelector('#title').textContent,
          feature: feature.value, functionName: document.querySelector('#function').value,
          sample, success, error });
      };
      checkSuccess();
    };
    ready();
  })`);
  assert.equal(outcome.feature, expectedFeature.id);
  assert.equal(outcome.functionName, expectedFunction.name);
  assert.deepEqual(JSON.parse(outcome.sample), expectedFunction.example_args);
  assert.doesNotMatch(outcome.success, /^Error:/);
  const engine = require(path.join(project, expectedFeature.module));
  const expected = engine[expectedFunction.name](...expectedFunction.example_args);
  assert.deepEqual(JSON.parse(outcome.success), expected);
  assert.match(outcome.error, /^Error:/);
  console.log(`Electron desktop smoke passed: ${manifest.source.package_name}, ${expectedFeature.id}, ${expectedFunction.name}, success and invalid JSON error visible`);
} finally {
  if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ } }
}
