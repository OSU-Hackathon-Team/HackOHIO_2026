// Opt-in integration probe for the candidate Docker namespace policy.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const image = process.argv[2] ?? "splice-recombination:current";
const profile = "splice-recombination-container-candidate";
const container = `splice-recombination-policy-${process.pid}`;
const state = fs.mkdtempSync(path.join(os.tmpdir(), "splice-container-policy-"));
const seccomp = path.join(root, "infra/recombination-container/seccomp.candidate.json");
const apparmor = path.join(root, "infra/recombination-container/apparmor.candidate");

function sudo(command, args, options = {}) {
  return execFileSync("sudo", ["-n", command, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

async function request(base, route, body) {
  const response = await fetch(`${base}${route}`, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.ok, true, `${route}: ${JSON.stringify(data)}`);
  return data;
}

async function waitFor(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}: ${String(last)}`);
}

function containerBase() {
  const portLine = sudo("docker", ["port", container, "3001/tcp"]);
  const port = Number(portLine.match(/:(\d+)$/)?.[1]);
  assert.ok(Number.isInteger(port) && port > 0, `Invalid Docker port: ${portLine}`);
  return `http://127.0.0.1:${port}`;
}

try {
  sudo("apparmor_parser", ["-r", "-W", apparmor]);
  sudo("chown", ["65532:65532", state]);
  sudo("docker", ["run", "-d", "--name", container,
    "--cap-drop=ALL", `--security-opt=seccomp=${seccomp}`,
    `--security-opt=apparmor=${profile}`, "--security-opt=no-new-privileges=true",
    "--security-opt=systempaths=unconfined", "--user=65532:65532", "--read-only",
    "--tmpfs=/tmp:rw,nosuid,nodev,size=2g", "--mount", `type=bind,source=${state},target=/state`,
    "-e", "SPLICE_STATE_DIR=/state", "-e", "REA_MODE=replay", "-e", "LLM_MODE=replay",
    "-p", "127.0.0.1::3001", image]);
  let base = containerBase();
  await waitFor(async () => (await request(base, "/api/health")).ok, "API health");

  const confinement = sudo("docker", ["exec", container, "sh", "-c",
    "id -u; grep -E 'Cap(Bnd|Eff)|NoNewPrivs|Seccomp:' /proc/self/status; cat /proc/self/attr/current"]);
  assert.match(confinement, /^65532\n/);
  assert.match(confinement, /CapBnd:\s+0{16}/);
  assert.match(confinement, /CapEff:\s+0{16}/);
  assert.match(confinement, /NoNewPrivs:\s+1/);
  assert.match(confinement, /Seccomp:\s+2/);
  assert.match(confinement, new RegExp(`${profile} \\(enforce\\)`));
  const worker = sudo("docker", ["exec", container, "/usr/bin/bwrap",
    "--unshare-user", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--", "/usr/bin/python3", "-c",
    "import os,socket; print('app_hidden',not os.path.exists('/app')); print('cap_eff',open('/proc/self/status').read().split('CapEff:')[1].split()[0]); s=socket.socket(); s.settimeout(1); print('network_isolated',s.connect_ex(('127.0.0.1',3001))!=0)",
  ]);
  assert.match(worker, /app_hidden True/);
  assert.match(worker, /cap_eff 0{16}/);
  assert.match(worker, /network_isolated True/);

  const seed = await request(base, "/api/recombination/seed", {});
  assert.equal(seed.packages.length, 4);
  const plan = await request(base, "/api/recombination/examples/notebook");
  const started = await request(base, "/api/apps", { plan });
  const job = await waitFor(async () => {
    const current = await request(base, `/api/jobs/${started.job_id}`);
    if (current.status === "failed") throw new Error(current.error);
    return current.status === "succeeded" ? current : null;
  }, "app build", 120_000);
  assert.match(job.result_ref, /^app:/);
  const appId = job.result_ref.split(":")[1];
  const invokes = plan.acceptance_scenarios[0].steps.filter((step) => step.kind === "invoke");
  const preview = (index, b2) => request(base, `/api/apps/${appId}/preview`, {
    workflow: "update_notebook", input: invokes[index].input,
    document_edits: [{ document: "workbook", path: "cells", value: { B2: b2, C2: 20 } }],
  });
  const first = await preview(0, 3);
  assert.equal(first.ok, true);
  assert.equal(first.documents.meeting.value, 60);

  sudo("docker", ["restart", container]);
  base = containerBase();
  await waitFor(async () => (await request(base, "/api/health")).ok, "restarted API health");
  const saved = await request(base, `/api/apps/${appId}/revisions/latest`);
  assert.equal(saved.status, "verified");
  const second = await preview(1, 4);
  assert.equal(second.ok, true);
  assert.equal(second.documents.meeting.value, 80);
  console.log(`Container policy probe passed: 4 packages, app build, 60 then 80 after restart (${image})`);
} finally {
  try { sudo("docker", ["rm", "-f", container]); } catch { /* container may not exist */ }
  sudo("chown", ["-R", `${process.getuid()}:${process.getgid()}`, state]);
  fs.rmSync(state, { recursive: true, force: true });
}
