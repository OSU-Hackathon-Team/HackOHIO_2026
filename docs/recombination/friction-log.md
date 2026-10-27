# Friction log

Record anything that cost more than ten minutes, and the pipeline fix that removes it. The goal is
that the next agent does not hit the same wall.

| Date | Workstream | Friction | Pipeline fix |
|---|---|---|---|
| 2026-10-27 | setup | Contract tests failed on Node 22.22 because `.ts` files were passed straight to `node --test`. | `@splice/contracts` now runs tests with `node --import tsx --test`, like the backend. |
| 2026-10-27 | setup | The root filesystem has ~350 MB free; `npm ci` filled it. | `node_modules` is a bind mount on the 100 GB scratch disk; use `npm ci --cache /mnt/nvme1n1/npm-cache`. |
