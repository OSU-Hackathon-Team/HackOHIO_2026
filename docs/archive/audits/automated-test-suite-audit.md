# Automated Test Suite Audit & Verification Report

## 1. Overview & Test Architecture

Splice employs an automated, multi-tiered testing strategy spanning the TypeScript clean-room pipeline, shared Zod contracts, frontend UI components, and the Python native decompilation engine.

### Established Test Frameworks
| Layer / Track | Framework | Runner Command | Test Directory |
|---|---|---|---|
| **Contracts** | Node.js Native Runner (`node --test`) | `npm run test -w @splice/contracts` | `packages/contracts/test/**/*.test.ts` |
| **Backend** | Node.js Native Runner (`node --test`) | `npm run test -w @splice/backend` | `packages/backend/test/**/*.test.ts` |
| **Frontend** | Node.js Native Runner via `tsx` | `npm run test -w @splice/frontend` | `packages/frontend/tests/*.test.ts` |
| **Native Engine** | Python `unittest` | `python3 -m unittest discover -s tests -p "test_*.py"` | `tests/test_native_*.py` |
| **Unified Workspace** | npm Workspace Orchestration | `npm test` & `npm run test:all` | Across all packages & tracks |

---

## 2. Test Discovery & Suite Inventory

### Discovered Test Counts Across Repositories
- **`@splice/contracts`:** 13 tests across 7 test suites.
- **`@splice/backend`:** 139 tests across 47 test suites.
- **`@splice/frontend`:** 17 tests across 3 integration files.
- **Python Native Track:** 30 tests (26 deterministic unit tests, 4 guarded integration tests).
- **Total Test Inventory:** **199 tests** (169 Node.js unit tests + 30 Python tests).

---

## 3. Offline & Deterministic Execution

Standard development and CI/CD runs execute **100% offline and deterministically** without requiring AWS credentials, active network access, or external model tokens.

1. **Hand-Authored Fixture Baseline ([fixtures/hand-authored/](file:///Users/kgozon/HackOHIO_2026/fixtures/hand-authored/)):**
   - Evidence: `recall.sm2_scheduler.json`, `inkwell.wikilink_graph.json`
   - Specs: Validated `FeatureSpec` models with numbered requirements and TypeScript interfaces.
   - Blueprints: Complete `FeatureBlueprint` records with portable code and verification status.
   - Transcripts: Sequential `PipelineEvent` streams with monotonic timestamps.
   - Bundles: Complete `SynthesisBundle` multi-engine fusion fixtures.
2. **In-Memory Test Doubles:**
   - `fakeClaude`: Replaces Bedrock Claude invocations with deterministic request capture and simulated structured JSON responses.
   - Virtual Sandbox (`runInSandbox`): Executes isolated JavaScript/TypeScript execution in child processes with memory and CPU timeouts.
   - Virtual TSC Host: Compiles TypeScript ASTs in memory via `typescript.createLanguageService` and `typescript.createSourceFile` without disk writes.

---

## 4. Negative & Boundary Testing Matrix

Every stage enforces strict negative boundary checks:

| Category | Component Under Test | Negative Condition Tested | Expected Failure Behavior |
|---|---|---|---|
| **Schema Violations** | `contracts.test.ts` | Invalid requirement ID (e.g. `INVALID_ID`) | `ZodError` raised on `FeatureSpec.parse` |
| **Schema Violations** | `contracts.test.ts` | Empty snippets array in `RawEvidence` | `ZodError` raised on `RawEvidence.parse` |
| **Schema Violations** | `contracts.test.ts` | Unknown pipeline event type discriminator | `ZodError` raised on `PipelineEvent.parse` |
| **Malformed Data** | `step2_llm.test.ts` | Invalid module name (e.g. `123_invalid_module`) | Throws validation error matching `/module_name/` |
| **Malformed Data** | `step2_llm.test.ts` | Malformed JSON string from LLM | Throws `LlmSchemaError` |
| **Missing Files** | `step1.test.ts` | Accessing nonexistent file inside ASAR | Throws `Error: not in archive: ...` |
| **Missing Files** | `step1.test.ts` | Opening nonexistent ASAR path | Rejects with `Archive not found` |
| **Missing Files** | `bundle_validation_audit.test.ts` | Missing entrypoint `/App.tsx` | Fails structure stage: `Missing /App.tsx` |
| **Missing Files** | `test_native_engine.py` | Nonexistent binary path in `launch.py` | Raises `FileNotFoundError: Binary file not found` |
| **Missing Files** | `test_native_engine.py` | Nonexistent Ghidra analyzeHeadless script | Raises `FileNotFoundError: Ghidra analyzeHeadless ...` |
| **Missing Files** | `test_native_engine.py` | Nonexistent OpenCode binary | Raises `FileNotFoundError: OpenCode executable ...` |
| **Virtual TSC Errors** | `step3_engine.test.ts` | Syntax error in candidate code | Diagnostic records compiler syntax failure |
| **Virtual TSC Errors** | `step3_engine.test.ts` | Missing required exported function | Diagnostic records missing interface export |
| **Virtual TSC Errors** | `step3_engine.test.ts` | Incompatible function signature | Diagnostic records type mismatch |
| **Virtual TSC Errors** | `bundle_validation_audit.test.ts` | Unclosed tag in TSX component | Diagnostic flags exact line and column |
| **Virtual TSC Errors** | `bundle_validation_audit.test.ts` | Incompatible argument types to engine | Flagged: `Argument of type 'string' is not assignable` |
| **Virtual TSC Errors** | `bundle_validation_audit.test.ts` | Missing required props on component | Flagged: `Property 'body' is missing in type '{}'` |
| **Impurity Flags** | `step3_engine.test.ts` | Disallowed import (`node:fs`, `child_process`) | Rejected by purity validator |
| **Impurity Flags** | `step3_engine.test.ts` | Access to globals (`process`, `window`) | Flagged by purity validator |
| **Impurity Flags** | `step3_engine.test.ts` | Nondeterministic calls (`Math.random`, `Date.now`) | Flagged by purity validator |
| **Impurity Flags** | `step3_engine.test.ts` | Console output, timers, eval | Flagged by purity validator |
| **Unwhitelisted Deps** | `bundle_validation_audit.test.ts` | Import of unpermitted npm package (`lodash`) | Fails imports stage: `Package "lodash" is not available` |
| **Unwhitelisted Deps** | `bundle_validation_audit.test.ts` | Unpinned package version (`react@19.0.0`) | Fails manifest stage: `does not match allowed version` |
| **Unwhitelisted Deps** | `bundle_validation_audit.test.ts` | Extra unwhitelisted package in manifest (`axios`) | Fails manifest stage: `is not an allowed Sandpack dependency` |
| **Container Violations** | `test_native_engine.py` | Running agent command on host outside container | Raises actionable `RuntimeError: must run inside container` |
| **Secret Leaks** | `test_native_engine.py` | Exception message containing AWS secret key | `sanitize_secrets` replaces key with `[..._REDACTED]` |

---

## 5. Guard Separation for Live Integration Suites

All tests that require live external credentials or heavyweight native binaries are strictly guarded:

- **Live Bedrock LLM Integration ([packages/backend/test/step2_llm.test.ts](file:///Users/kgozon/HackOHIO_2026/packages/backend/test/step2_llm.test.ts#L484-L497)):**
  - Guarded by `process.env.TEST_LIVE_BEDROCK === "1"`.
  - When unset, skips the live call safely and logs `Skipping live Bedrock test: TEST_LIVE_BEDROCK=1 not set`.
- **Native Containerized Integration ([tests/test_native_integration.py](file:///Users/kgozon/HackOHIO_2026/tests/test_native_integration.py#L18-L21)):**
  - Guarded by `@unittest.skipUnless(os.environ.get("RUN_NATIVE_INTEGRATION") == "1", ...)`.
  - When unset, all 4 integration tests cleanly skip with diagnostic messages without failing the test runner.

---

## 6. Verification Results & Metrics

- **TypeScript Compilation & Build:**
  - `npm run typecheck`: Passed across `@splice/contracts`, `@splice/backend`, `@splice/frontend` (Code 0).
  - `npm run build`: Successfully built all packages and Sandpack/Vite distribution bundles (Code 0).
- **Test Execution Metrics:**
  - **Contracts:** 13 passed, 0 failed, 0 skipped (Duration: ~93ms).
  - **Backend:** 139 passed, 0 failed, 0 skipped (Duration: ~6.07s).
  - **Frontend:** 17 passed, 0 failed, 0 skipped (Duration: ~3.41s).
  - **Python Suite:** 26 passed, 0 failed, 4 skipped (Duration: ~0.006s).
  - **Combined Total:** **195 passed, 0 failed, 4 skipped** across 199 discovered tests.
- **Strict Exit Codes:**
  - All test runners exit immediately with code `0` on success and non-zero on any failure.
