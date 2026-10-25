#!/usr/bin/env bash
# EC2 user-data sets TRIAL_BUCKET and AWS_DEFAULT_REGION before invoking this file.
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
mkdir -p /opt/splice /var/lib/splice-trial/results
exec > >(tee -a /var/lib/splice-trial/results/bootstrap.log) 2>&1
# Stop even if package installation, Docker, or the agent hangs.
shutdown -h +60
finish() {
  rc=$?
  trap - EXIT
  printf '{"bootstrap_exit":%s}\n' "$rc" > /var/lib/splice-trial/results/exit.json
  if /usr/bin/python3 -c 'import boto3' 2>/dev/null; then
    tar -czf /var/lib/splice-trial/results.tgz -C /var/lib/splice-trial results
    /usr/bin/python3 -c 'import boto3,os; boto3.client("s3").upload_file("/var/lib/splice-trial/results.tgz",os.environ["TRIAL_BUCKET"],"results/results.tgz")' || true
  fi
  shutdown -h now
}
trap finish EXIT
apt-get update
apt-get install -y --no-install-recommends docker.io python3-boto3
systemctl enable --now docker
/usr/bin/python3 - <<'PY'
import boto3, os
boto3.client('sts').get_caller_identity()  # Verify the instance role before analysis.
boto3.client('s3').download_file(os.environ['TRIAL_BUCKET'], 'inputs/payload.tgz', '/opt/payload.tgz')
PY
tar -xzf /opt/payload.tgz -C /opt/splice
cd /opt/splice
timeout 2400 docker build -f worker.Dockerfile -t splice-worker:lo-agent .
docker run --rm --memory=24g --cpus=6 -v /opt/splice:/workspace:ro -w /workspace \
  splice-worker:lo-agent python scripts/lo_paths.py --json \
  > /var/lib/splice-trial/results/preflight.json
docker run --rm --memory=24g --cpus=6 -v /opt/splice:/workspace:ro -w /workspace \
  splice-worker:lo-agent /opt/venv/bin/pip check
# A private, writable results directory is the only host write mount; no static keys.
# AWS_PROFILE triggers OpenCode's Bedrock provider; its node credential chain uses IMDS.
set +e
timeout --kill-after=15 330 docker run --rm --name splice-lo-trial \
  --memory=24g --cpus=6 -v /opt/splice:/workspace:ro \
  -v /var/lib/splice-trial/results:/results -w /workspace \
  -e AWS_REGION="$AWS_DEFAULT_REGION" -e AWS_DEFAULT_REGION -e AWS_PROFILE=default \
  -e GHIDRA_HEADLESS_MAXMEM=8G \
  -e REA_GHIDRA_DISABLED_ANALYZERS='Decompiler Parameter ID,Aggressive Instruction Finder,Embedded Media,Condense Filler Bytes,Variadic Function Signature Override' \
  -e JAVA_TOOL_OPTIONS='-Djava.awt.headless=true -Xmx8g' \
  splice-worker:lo-agent python scripts/lo_agent_trial.py \
  --opencode /usr/local/bin/opencode --env-file /nonexistent \
  --state /results/agent --timeout 300 --run-live \
  > /var/lib/splice-trial/results/agent-console.log 2>&1
trial_rc=$?
docker rm -f splice-lo-trial >/dev/null 2>&1
set -e
printf '{"trial_exit":%s}\n' "$trial_rc" > /var/lib/splice-trial/results/trial-exit.json
exit "$trial_rc"
