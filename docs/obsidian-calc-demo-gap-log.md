# Obsidian + LibreOffice Calc demo: client capability gaps

The target is an Obsidian-style Markdown display/editor with LibreOffice Calc table evaluation and operations. A claim of source-app parity requires real upstream evidence, approved handoffs, built packages, a composition, and runtime checks. Authored development fixtures are only a baseline.

| Date | Client API observation | Required capability | State |
|---|---|---|---|
| 2026-10-28 | `GET /api/decomp/targets` lists `libreoffice-calc`, but `enabled:false`; `POST /api/decomp/runs` cannot start without EC2 configuration. | Start and follow Calc analysis through the client API in this environment, or configure the worker. | Open |
| 2026-10-28 | Electron reconstruction existed only as `scripts/electron/pipeline.mjs`; no upload/start/status client API existed. | Upload an Electron archive, discover runtime IPC channels, and start a scoped, observable reconstruction job from Studio. | Implemented; live Obsidian run reached the spec agent but failed on expired AWS credentials |
| 2026-10-28 | `GET /api/library` reports `enabled:false`; no reviewed upstream analysis or approved package is in the library. | Publish and approve real Obsidian and Calc handoffs, then build them through capability APIs. | Open |
| 2026-10-28 | `GET /api/capabilities` and `GET /api/apps` are empty in a fresh state directory. | Compose the actual recovered packages, build an app, and verify Markdown editing, table formulas and operations through preview and export. | Open |
| 2026-10-28 | AWS STS reports `ExpiredToken` for the current environment. | Refresh model credentials before a live Electron specification or implementation job can complete. | External prerequisite |
| 2026-10-28 | The uploaded Obsidian archive's runtime inventory exposes 47 main-process IPC channels, including vault persistence, but no Markdown renderer or editor operation. | Add renderer behavior discovery and a browser-facing editor capability path; main-process reconstruction alone cannot prove the requested editor. | Open |

Do not relabel the authored notebook's formula or Markdown subset as Obsidian or Calc behavior.
