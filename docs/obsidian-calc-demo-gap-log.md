# Obsidian + LibreOffice Calc demo: client capability gaps

The target is an Obsidian-style Markdown display/editor with LibreOffice Calc table evaluation and operations. A claim of source-app parity requires real upstream evidence, approved handoffs, built packages, a composition, and runtime checks. Authored development fixtures are only a baseline.

| Date | Client API observation | Required capability | State |
|---|---|---|---|
| 2026-10-28 | `GET /api/decomp/targets` initially listed `libreoffice-calc` with `enabled:false`. | Start and follow Calc analysis through the client API. | Worker configured; HTTP-started 40-function run `run-ec1231f8-6591-4947` is in progress |
| 2026-10-28 | Electron reconstruction existed only as `scripts/electron/pipeline.mjs`; no upload/start/status client API existed. | Upload an Electron archive, discover runtime IPC channels, and start a scoped, observable reconstruction job from Studio. | Implemented; live Obsidian run reached the spec agent but failed on expired AWS credentials |
| 2026-10-28 | `GET /api/library` reports `enabled:false`; no reviewed upstream analysis or approved package is in the library. | Publish and approve real Obsidian and Calc handoffs, then build them through capability APIs. | Open |
| 2026-10-28 | `GET /api/capabilities` and `GET /api/apps` are empty in a fresh state directory. | Compose the actual recovered packages, build an app, and verify Markdown editing, table formulas and operations through preview and export. | Open |
| 2026-10-28 | AWS STS initially reported `ExpiredToken`. | Refresh model credentials before a live job can complete. | Resolved with profile `myisb_IsbUsersPS-209340830054`; region passed explicitly to child jobs; HTTP-started Obsidian run `electron-4d9b33c2-b6eb-4b42-97f7-103ad60a4846` is in progress |
| 2026-10-28 | The uploaded Obsidian archive's runtime inventory exposes 47 main-process IPC channels, including vault persistence, but no Markdown renderer or editor operation. | Add renderer behavior discovery and a browser-facing editor capability path; main-process reconstruction alone cannot prove the requested editor. | Open |
| 2026-10-28 | Once S3 was configured, `GET /api/library` failed with `building block hash mismatch`. | Diagnose the saved block identity mismatch without admitting invalid evidence; restore library browsing. | Fixed in `a64ef14`; HTTP verified on port 3005: two Calc analyses and three authored mockpriority blocks load. The blocks' raw hashes match; schema-normalized serialization had changed their hash. |

## Current pipeline evidence

- `run-ec1231f8-6591-4947`: Calc advanced from analysis to claims, observed through `GET /api/decomp/runs/:id`.
- `electron-4d9b33c2-b6eb-4b42-97f7-103ad60a4846`: Obsidian's first spec round made 37 tool calls and produced 43 reproducible original-app cases without coverage gaps. The second specification round is running. This scope covers vault persistence, not the renderer.
- `POST /api/library/analyses/run-18faf745-b978-49a8/discover` completed and saved report `42817f95a716632acb24130e8e447ed20bfa46f8c101654483e31d5d321f4ba1`, proposing five capabilities and saving five draft extractions. The client API added matrix comparisons (`0b19ff67d2ad58c27dc96dc8ff1591964a76181f94a78195c11a50ae964bcc6c`, 12 requirements) and reference validation (`72d986dd7dcb90b1d6ed7919811261432f4d56ad180e013cc1fb34c26276e697`, 7 requirements) to App library. Both remain draft: the source claims lack original-case links and scope/dependency readiness has not been established.

Do not relabel the authored notebook's formula or Markdown subset as Obsidian or Calc behavior.
