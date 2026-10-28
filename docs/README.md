# Documentation index

Live documents describe behavior, commands and acceptance gates that still apply. Everything under
[`archive/`](archive/) is historical: dated audits, superseded plans and handoffs, and notes for
issues that were fixed. Use the archive for context, never as current policy.

The source-of-truth order is in [`.agents/README.md`](../.agents/README.md). The root
[`README.md`](../README.md), [`DecompPileline.md`](../DecompPileline.md) and
[`DECOMP_IMPLEMENTATION_PLAN.md`](../DECOMP_IMPLEMENTATION_PLAN.md) stay at the repository root
because every track references them.

## Splice app (Electron + Studio)

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | End-to-end component and data-flow map |
| [STEP3_MILESTONE.md](STEP3_MILESTONE.md) | What the Step 3 backend and Studio verify today, and what is open |
| [WORKSPACE_UI.md](WORKSPACE_UI.md) | Chat / App library / My app workspace layout |
| [DOCKER_FRONTEND.md](DOCKER_FRONTEND.md) | How the served frontend is built and mounted |
| [bundle_validation_specification.md](bundle_validation_specification.md) | Bundle validator and virtual typechecker contract |
| [step3_oracle_limitations.md](step3_oracle_limitations.md) | Conformance oracle behavior and its limits |
| [electron-generalization.md](electron-generalization.md) | Two-stage Electron reconstruction pipeline |
| [electron-acceptance.md](electron-acceptance.md) | Electron readiness ledger |
| [electron-export.md](electron-export.md) | Runnable Electron project export |

## Native decompilation engine

| Document | Contents |
|---|---|
| [native_decompilation_engine.md](native_decompilation_engine.md) | How the engine relates to the Splice app |
| [decomp-s3-cache.md](decomp-s3-cache.md) | Private `cache/v1/` identity, trust boundary and rollout |
| [decomp-runs.md](decomp-runs.md) | Starting and following native runs from Studio |
| [native-library.md](native-library.md) | Saved analyses and building-block discovery |
| [NATIVE_CLEANROOM_HANDOFF.md](NATIVE_CLEANROOM_HANDOFF.md) | Analyst/implementer separation and the public spec artifact |
| [LIBREOFFICE_EC2_TRIAL.md](LIBREOFFICE_EC2_TRIAL.md) | Bounded LibreOffice EC2 trial record |
| [libreoffice-spec/](libreoffice-spec/README.md) | LibreOffice behavioral specification set |

## Downstream recombination

| Document | Contents |
|---|---|
| [RECOMBINATION_PLAN.md](RECOMBINATION_PLAN.md) | Design for capability packages and the composition runtime |
| [RECOMBINATION_IMPLEMENTATION.md](RECOMBINATION_IMPLEMENTATION.md) | Workstream board, evidence and open gates |
| [RECOMBINATION_PERFORMANCE.md](RECOMBINATION_PERFORMANCE.md) | Authored development workload and budgets |
| [recombination/friction-log.md](recombination/friction-log.md) | Setup problems and the pipeline fixes that remove them |

## Handoffs

| Document | Contents |
|---|---|
| [handoffs/libreoffice-rea.md](handoffs/libreoffice-rea.md) | LibreOffice/REA pipeline state and run order |
| [handoffs/native-decomp-runs.md](handoffs/native-decomp-runs.md) | Producing native runs from Studio |
| [handoffs/decompilation-recommendations.md](handoffs/decompilation-recommendations.md) | Decompilation speed and quality recommendations |
| [handoffs/libreoffice-formula/](handoffs/libreoffice-formula/README.md) | Partial Calc formula dossier and raw agent outputs |

## Archive

| Folder | Contents |
|---|---|
| [archive/audits/](archive/audits/) | Dated cleanroom, robustness, test-suite and environment audits |
| [archive/plans/](archive/plans/) | Original hackathon plan, step-3 plan and progress report |
| [archive/handoffs/](archive/handoffs/) | Superseded handoffs |
| [archive/issues/](archive/issues/) | Notes for issues that were fixed |
| [archive/proposals/](archive/proposals/) | Brainstorms that are not current policy |
| [archive/implementation_frontend/](archive/implementation_frontend/accomplishments.md) | Step 3 frontend accomplishment log |
| [archive/rev-engine-review-2026-10-24.md](archive/rev-engine-review-2026-10-24.md) | Review of the upstream `rev` engine |
