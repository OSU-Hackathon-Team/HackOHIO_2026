# LibreOffice agent trial on EC2

This is a bounded binary inspection using our Python launcher, OpenCode, REA MCP,
and Ghidra MCP. It is not the complete formula recovery pipeline or a verified
behavior specification. No LibreOffice source or held-out cases enter the trial.

## Worker

The 2026-10-24 trial uses Ubuntu 24.04 x86_64 in `us-east-2`:

- Instance: `i-01fbcb94645a47036`, `m7i.2xlarge` (8 vCPUs, 32 GiB).
- Root disk: 200 GB encrypted gp3; retained when stopped.
- Security group: `sg-0122124f6ed57cab8`, no inbound rules. Use SSM.
- Instance role/profile: `splice-lo-trial-1792893524936`.
- Private, encrypted S3 bucket: `splice-lo-trial-1792893524936`.
- Input: `inputs/payload.tgz`; output: `results/results.tgz`.

The instance role permits SSM, reading that input object, writing the results
prefix, and invoking only the configured Qwen foundation model in this region.
IMDSv2 is required, with hop limit 2 for the Docker credential chain. No static
credentials, `.env` files, personal OpenCode auth files, or source checkout are
uploaded. The input archive contains only our engine, launcher/configuration,
the worker Dockerfile, and the two preflight/trial CLI scripts.

[`ec2_lo_trial_bootstrap.sh`](../scripts/ec2_lo_trial_bootstrap.sh) is the worker
bootstrap. User data exports `TRIAL_BUCKET` and `AWS_DEFAULT_REGION` before this
script. It installs Docker and the host AWS SDK, downloads the input, builds the
image, checks the installed target and Python dependencies, and invokes one
300-second agent trial. A 330-second outer timeout also bounds the container.
It uploads results and stops the instance; a scheduled stop after 60 minutes
protects against a hung bootstrap. Stopped EBS storage and retained S3 objects
still incur storage charges. Resources are retained for inspection, not deleted.

## Runtime fixes

- Pin Node 22.19.0: Ubuntu's Node 18 failed REA's JSON module imports.
- Explicitly register the configured Qwen model as active in OpenCode. Its
  catalog otherwise filtered the model before making a Bedrock request.
- Set the session title and small model explicitly to prevent an unrelated
  background model request.
- Install the exact matching `libreoffice-calc-nogui-dbgsym`, rather than the
  conflicting GUI Calc debug package or unrelated core debug symbols.
- Avoid the observed cached HTTP 503 at the official debug-package URL using
  a package-hash query, retries, and full-file SHA-256 verification against the
  signed APT index. A single connection measured about 400 KB/s; HTTPS redirects
  back to HTTP. A parallel byte-range experiment downloaded its first chunk but
  received 503/504 for the remaining chunks, so that experiment was removed.
- Isolate Frida CLI dependencies in `/opt/frida-venv`; their WebSocket pin
  conflicts with `openai-agents` in the main worker environment.
- Install pinned OpenCode 1.19.4 in the image; keep local state out of its context.

## Checks and interpretation

Local regression checks: `python3 -m unittest tests.test_native_engine
tests.test_model_runtime` passed 28 tests. The bootstrap passes `bash -n`.
A local Qwen/OpenCode calculator smoke returned `391` (242 input / 4 output
tokens). REA and Ghidra catalog startup succeeded locally with 207 and 212 tools.
These results establish routing and startup, not binary analysis correctness.

The trial CLI is [`lo_agent_trial.py`](../scripts/lo_agent_trial.py). Preparation
is the default; `--run-live` invokes the model and requires spending authorization.
The user approved this bounded trial. It selects one exported Calc factory as
a tool-chain probe, requires both servers, denies shell/write tools, and records
raw events, stderr, a model report, and a summary. Any observations remain
unreviewed. Successful exported-function inspection does not establish formula
interpreter equivalence or dossier readiness.

The first EC2 bootstrap built the image, but Ubuntu's package server returned
503 for the debug package. The preflight correctly rejected missing symbols,
uploaded its report, and stopped the instance without invoking the model. The
same instance was restarted with the cache workaround; no second worker was
created. Ubuntu continued returning 503/504, leaving the full debug-symbol gate
blocked. The exported-function probe proceeded only after `pip check` reported
no broken requirements and `nm -D --defined-only` confirmed
`Calc_ScSpreadsheetSettings_get_implementation` at `0x00ba1490`. This target is
dynamically named and does not require DWARF. `preflight-exception.json` records
the limited exception; `preflight.json` retains the missing-symbol failure.
Final execution results will be recorded after it completes. The live
formula pipeline, Frida runtime triage, independent review, real oracle coverage,
and a ready-for-spec dossier remain separate acceptance gates.
