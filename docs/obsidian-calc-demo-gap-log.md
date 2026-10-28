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
| 2026-10-28 | Once S3 was configured, `GET /api/library` failed with `building block hash mismatch`. | Diagnose the saved block identity mismatch without admitting invalid evidence; restore library browsing. | Open |

Do not relabel the authored notebook's formula or Markdown subset as Obsidian or Calc behavior.
