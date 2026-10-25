# Native decompilation S3 cache

The private bucket has three distinct namespaces. `results/<run-id>/` retains worker output,
`library/` serves selected Studio data, and `cache/v1/` holds reusable analyst-side state.
Never expose `cache/v1/` or `results/` through the public library routes.

## Identity and reuse

- Immutable artifacts live at `cache/v1/artifacts/<first-two-hex>/<sha256>`. Read bytes only
  after checking their SHA-256; write the same bytes locally before publishing a pointer.
- Cache pointers are versioned JSON under `cache/v1/`. Publish a pointer after every artifact
  it names is durable. Reject malformed, mismatched, missing, or corrupt entries. A miss may
  run the normal pipeline; a corrupt hit must be visible and must not be treated as evidence.
- Ghidra evidence keys include the binary hash and the exact analysis identity. Scoped
  preparation also depends on its seed and budget request, symbol inventory, and script hash.
  A function address alone is never a safe key across campaigns.
- Semantic drafts require the exact evidence, scope task, prompt/schema revision, selected
  model and runtime observations. Reviews additionally require the exact draft, review prompt,
  model and optional probe or guidance context. Revalidate cached answers before use.
- Original program observations are retained separately from model claims. Reusing a report
  does not establish a new observation for a changed binary, LibreOffice version, case set,
  adapter, or runtime. Held-out cases remain private.

## Worker lifecycle

The EC2 runner supplies the bucket and region to the analysis container. A new run reads
eligible cache entries before scoped index export, Ghidra function export and model work, then writes reusable
outputs as stages finish. Scoped Ghidra preparation, runtime triage and LibreOffice oracle
observations still execute for each run. A cache hit must match the exact scoped campaign;
changing seeds or analysis bounds creates a distinct context and does not reuse its function
or semantic records. This conservative boundary prevents stale inferred types and scope tasks
from crossing campaigns. Prior `results/` archives lack the exporter revision needed to seed
the new function cache safely; reusable entries begin with the first cache-enabled run.
The existing `results/<run-id>/` archive remains the complete recovery record and the
`library/` manifest remains the Studio discovery record. Cache failures must not silently
turn a completed campaign into a false success. The cache may reduce work; it cannot change
readiness gates, review verdicts, or cleanroom disclosure rules.

The engine reports cache hits and misses in progress events so a future campaign can
show what it reused. No paid model call or new AWS resource is needed to test the local cache
contract; use a fake S3 client for deterministic failure and recovery checks.

## Activation

The existing EC2 instance role currently permits `inputs/payload.tgz` reads and `results/*`
writes only. Add `infra/decomp-ec2/cache-policy.json` to that role, including the scoped
`ListBucket` grant needed for S3 to return `NoSuchKey` on a cache miss, then set
`DECOMP_CACHE_ENABLED=1` in the backend environment and restart the backend. The flag is off
by default, so runs remain functional before the IAM change. The worker container uses its
instance role through IMDS; no AWS keys are copied into the payload.
