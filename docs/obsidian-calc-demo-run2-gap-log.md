# Obsidian + LibreOffice Calc Demo Run 2: Progress & Gap Log

## Goal
Prove that the combined large-scale demo (Obsidian Markdown renderer/editor + LibreOffice Calc tables formula eval & operations) was not a fluke by executing the end-to-end extraction, cleanroom reconstruction, intake, capability build, application composition, and verification pipeline from scratch.

Strict operational constraints adhered to:
- Cleared prior caches from S3 (`s3://splice-lo-trial-1792893524936`).
- All capability intake, building, composition, preview, and export was performed through client-facing website APIs.
- Dedicated Git feature branch (`feat/obsidian-calc-demo-run2`) with atomic conventional commits.
- Independent verification gates strictly enforced and passed.

---

## Run 2 Execution Milestones

### 1. Pre-Run Cleanup & S3 Cache Clearance
- Removed cached library feature:
  `s3://splice-lo-trial-1792893524936/library/features/8765c0e46688d8d00784921a7927644255c47d7de2f6751b3820320f6b622f9b.json`
- Removed cached library block:
  `s3://splice-lo-trial-1792893524936/library/blocks/91d56447bb54eb27ae54f619ff35f36760f5d95c6f2f2e211db60020297404e6.json`
- Initialized clean local state directory: `/tmp/splice-obsidian-calc-demo-run2` (zero packages, zero intakes, zero apps).
- Verified `GET /api/library` returned `features: 0`.

### 2. LibreOffice Calc Tables & Formula Evaluator (`splice.calc.tables`)
- Approved extraction in S3 library via client API:
  `POST /api/library/features` (`8765c0e46688d8d00784921a7927644255c47d7de2f6751b3820320f6b622f9b`).
- Intaked library feature via client API:
  `POST /api/library/features/:id/intake` -> `int_92266d01168d704f772f1c9465d57ea6`.
- Built capability package via client API:
  `POST /api/capabilities/build` -> `pkg_1bba6dac1161cf41444089d7e5c34df6`.
- Verification Report:
  - Upstream review: PASSED
  - Public test suites: PASSED (4 suites: binary comparisons, arithmetic formulas, table sort, row/col mutations)
  - Mutation verification: PASSED (8/8 mutants detected and killed)
  - Independent oracle checks: PASSED (6 independent original-behavior checks)
  - Content-addressed hashes:
    - Definition hash: `f9b60a8424cde01bf904f4ddd5b261de16fd297f8f11395ea0ae5a2f2f167719`
    - Build hash: `b6621d415586562316f07af956ceba28c5fd98c88248a32e5a51550cd8047e4d`

### 3. Obsidian Electron Archive Upload, Discovery & Renderer Engine (`splice.obsidian.editor`)
- Uploaded Obsidian archive `3a349274f789b62c5b35ad19de10311909a94e8783033569c2210a4bac491780.asar` (28.18 MB) via `POST /api/electron/archives`.
- Ran clean renderer discovery on the running original Obsidian Electron instance in isolated Xvfb display via `POST /api/electron/archives/:id/renderer-discovery` -> discovery ID `renderer-2c583fe0-cb65-48ec-909b-1617ce6f51d3`.
- Replayed 15 observations against the original renderer: PASSED with verified coverage across headings, formatting, code blocks, callouts, tables, nested lists, and wikilinks.
- Implemented cleanroom pure TypeScript renderer via client API `POST /api/electron/renderer-discoveries/:id/implement`.
- Feedback loop in action:
  - Identified requirement for explicit blockquote and nested `<ul>` closure invariants in renderer implementation test harness.
  - Enhanced candidate JSON extractions in `llm.ts` to cleanly handle nested code blocks.
  - Hardened code block index mutation test to require exactly 1 `<pre>` block.
- Intaked reconstructed renderer via `POST /api/electron/renderer-discoveries/:id/intake` -> `int_4822f500c69a4f14367acb9eb374d10f`.
- Built capability package via client API `POST /api/capabilities/build` -> `pkg_9391603c9ec5926a4612b46c854c83c4`.
- Verification Report:
  - Upstream review: PASSED
  - Public test suites: PASSED (5 suites: headings/formatting, code/callout, tables, lists/links, edit operations)
  - Mutation verification: PASSED (6/6 mutants detected and killed)
  - Independent original-behavior evaluations: PASSED (3 held-out conformance checks)
  - Content-addressed hashes:
    - Definition hash: `42df945dbf7683e56e2428af464ea2628310edadf8c68f7d5fc32e49ac005eb6`
    - Build hash: `1b60e101b947b1fbd3c590646d61d837990353e97f011412046a2ba26b26c8af`

### 4. Application Composition & Verification
- Generated composition plan referencing fresh package pins (`pkg_9391603c9ec5926a4612b46c854c83c4` and `pkg_1bba6dac1161cf41444089d7e5c34df6`).
- Validated composition plan via client API `POST /api/compositions/validate`:
  - Plan hash: `49717df1355da33c63eb451f2eb5658053ab489c9fe9eb843ee4c473a10306db`
  - Status: OK (`ok: true`)
- Built application via client API `POST /api/apps`:
  - Job: `job_c57d368882273b92e9b0b685f4028f2e`
  - Application ID: `app_e8adc32b453f1c0a6948a8474f6ee11d`
  - Revision: `0`
  - All acceptance scenarios passed:
    - `eval_and_render_scenario`: PASSED (evaluated formula `=B2*C2` = 100, rendered Markdown `Total is **100**`)
    - `sort_table_scenario`: PASSED (sorted table rows alphabetically by product)
    - `edit_markdown_scenario`: PASSED (appended note callout and rendered HTML)

### 5. Preview & Export Verification
- Tested preview via `POST /api/apps/app_e8adc32b453f1c0a6948a8474f6ee11d/preview`:
  - `render_and_eval`: Succeeded. Calculated formula value 60 (`3 * 20`) via LibreOffice Calc engine, rendered Markdown heading, bold, and callout via Obsidian renderer engine.
  - `apply_table_op`: Succeeded. Sorted 2D table grid alphabetically by Product column.
  - `edit_markdown`: Succeeded. Appended Markdown table (`| Item | Status |\n|---|---|\n| Calc | Ready |`) and rendered interactive table editor HTML.
- Exported complete source bundle via `GET /api/apps/app_e8adc32b453f1c0a6948a8474f6ee11d/export` (`obsidian-notes-with-libreoffice-calc-tables-0.splice-source.json`, manifest hash `5e35c706441d5c75134b6b08659d951080f9f0d38e7628ee78c395c7a0211b90`).
- Created packaged distribution zip: `/home/ubuntu/obsidian-calc-demo-run2.zip` (307 KB, 31 files).

## Conclusion
The rerun completely independently succeeded from cleared S3 caches, through fresh discovery, cleanroom implementation, independent verification, and composition build, fully verifying reproducibility of the Obsidian + LibreOffice Calc demo.
