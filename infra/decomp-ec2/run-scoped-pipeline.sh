#!/bin/bash
# Runs one scoped LibreOffice decomp pipeline on the EC2 worker, started by the backend
# (packages/backend/src/decomp/ec2.ts) through SSM. Calls Bedrock (drafts, reviews, spec writer).
#   run-scoped-pipeline.sh <run_id> <max_functions> <max_depth>
# Environment: TRIAL_BUCKET, AWS_DEFAULT_REGION. Uses the instance role; no static credentials.
# Progress goes to s3://$TRIAL_BUCKET/results/<run_id>/ every 10 s; results.tgz at the end.
set -Eeuo pipefail
RUN_ID=$1 MAX_FUNCTIONS=${2:-20} MAX_DEPTH=${3:-2}
[[ $RUN_ID =~ ^[a-z0-9-]{8,64}$ ]] || { echo "invalid run id" >&2; exit 2; }
[[ $MAX_FUNCTIONS =~ ^[0-9]+$ && $MAX_DEPTH =~ ^[0-9]$ ]] || { echo "invalid limits" >&2; exit 2; }
: "${TRIAL_BUCKET:?}" "${AWS_DEFAULT_REGION:?}"
ROOT=/var/lib/splice-trial; RUN=$ROOT/runs/$RUN_ID; DBG=$ROOT/debug; SRC=/opt/splice
IMAGE=splice-worker:lo-agent
mkdir -p "$RUN/state"
exec > >(tee -a "$RUN/bootstrap.log") 2>&1
shutdown -h +60

s3put() { /usr/bin/python3 -c 'import boto3,os,sys; boto3.client("s3").upload_file(sys.argv[1],os.environ["TRIAL_BUCKET"],sys.argv[2])' "$1" "results/$RUN_ID/$2"; }
upload_progress() {
  [ -f "$RUN/state/progress.jsonl" ] && s3put "$RUN/state/progress.jsonl" progress.jsonl || true
  [ -f "$RUN/console.log" ] && s3put "$RUN/console.log" console.log || true
}
finish() {
  rc=$?
  trap - EXIT
  kill "${UPLOADER:-0}" 2>/dev/null || true
  printf '{"exit":%s}\n' "$rc" > "$RUN/exit.json"
  docker rm -f splice-pipeline >/dev/null 2>&1 || true
  upload_progress
  tar -czf "$ROOT/$RUN_ID.tgz" --exclude='*/scoped-projects/*' --exclude='*/ghidra-user/*' \
      --exclude='*/rea-install/*' --exclude='*/rea-java/*' -C "$RUN" state exit.json console.log 2>/dev/null || true
  s3put "$ROOT/$RUN_ID.tgz" results.tgz || true
  s3put "$RUN/exit.json" exit.json || true
  shutdown -h now
}
trap finish EXIT

/usr/bin/python3 -c 'import boto3,os; boto3.client("s3").download_file(os.environ["TRIAL_BUCKET"],"inputs/payload.tgz","/opt/payload.tgz")'
rm -rf "$SRC" && mkdir -p "$SRC" && tar -xzf /opt/payload.tgz -C "$SRC"
(while true; do sleep 10; upload_progress; done) & UPLOADER=$!

# Node dependencies for the LLM spec writer (engine/specification.py runs node_modules/.bin/tsx).
# A failure here is not fatal: the engine falls back to its deterministic writer and records that.
echo "[setup] installing spec writer dependencies" >> "$RUN/console.log"
timeout 600 docker run --rm -v "$SRC:/workspace" -w /workspace "$IMAGE" sh -c '
  NPM="node /usr/local/lib/node_modules/npm/bin/npm-cli.js"
  $NPM ci --no-audit --no-fund --workspace=@splice/contracts --workspace=@splice/backend \
    --include-workspace-root && $NPM run build:contracts' >> "$RUN/console.log" 2>&1 \
  || echo "[setup] spec writer dependencies failed; deterministic writer will be used" >> "$RUN/console.log"

mounts=()
cache_env=()
if [ "${DECOMP_CACHE_ENABLED:-0}" = "1" ]; then
  cache_env=(-e DECOMP_CACHE_BUCKET="$TRIAL_BUCKET")
fi
for f in $(cd "$DBG" 2>/dev/null && find .build-id -name '*.debug' 2>/dev/null); do
  mounts+=(-v "$DBG/$f:/usr/lib/debug/$f:ro")
done
timeout --kill-after=15 2700 docker run --rm --name splice-pipeline \
 --memory=24g --cpus=6 --cap-add=SYS_PTRACE --security-opt seccomp=unconfined \
 -v "$SRC:/workspace:ro" -v "$RUN:/run-out" "${mounts[@]}" -w /workspace \
 -e AWS_REGION="$AWS_DEFAULT_REGION" -e AWS_DEFAULT_REGION -e LLM_MODE=live -e PYTHONUNBUFFERED=1 \
 "${cache_env[@]}" \
 -e GHIDRA_HEADLESS_MAXMEM=8G -e JAVA_TOOL_OPTIONS='-Djava.awt.headless=true -Xmx8g' \
 "$IMAGE" sh -c '
   # Older images lack boto3 (engine/model_runtime.py direct Bedrock path); worker.Dockerfile now has it.
   python -c "import boto3" 2>/dev/null || python -m pip install -q --disable-pip-version-check boto3
   exec python scripts/lo_pipeline.py --analysis-profile scoped --seed-source runtime --library calc \
     --max-functions "$0" --max-depth "$1" --workers 2 --review-model-role decomp_worker \
     --state /run-out/state --opencode /usr/local/bin/opencode' "$MAX_FUNCTIONS" "$MAX_DEPTH" \
 >> "$RUN/console.log" 2>&1
