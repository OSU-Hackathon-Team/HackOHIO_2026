# Team Journal — approaches tried & obstacles hit

Feeds the Curiosity and Challenge Navigation slides (see README.md §9). One row per attempt or wall, with numbers.

| Time | Who | Tried / Obstacle | Result (numbers!) | Decision |
|------|-----|------------------|-------------------|----------|
| H0 | E1 | Planned docs used `npx rea-agents --mcp` and tools like `function_inventory` | Real CLI is `rea-agents mcp`; those tools don't exist | Verified the catalog via `tools/list` before writing code |
| H0 | E1 | Native decompiling on Windows | REA marks Windows Ghidra experimental | Live path = Electron `.asar` (no decompiler needed); native = replay-only stretch |
| H0 | E2 | Server-side refusal fallbacks | Not available on Bedrock | Client-side retry on a fallback model; card records which model answered |
| H? | E2 | Spec WITHOUT oracle vs WITH oracle on 4 features | e.g. 5 invented requirements caught, 3 repaired, 2 unverified | Oracle stays |
| H? | E2 | Direct reconstruction vs spec-first engines | e.g. direct: 3/4 pass own tests but 2/4 fail the oracle tests | Spec-first |
| H? | E1 | Scripted vs agentic REA collection | e.g. scripted 9 s avg, 100% symbols found; agentic 41 s, 75% | Scripted for demo |
| H0 | team | Model routing: teammate routed spec_writer to Nova Pro; llm.ts design (structured outputs, effort) is Anthropic-Messages-only | Non-Claude IDs would fail at the first Bedrock call | All Splice roles → Claude (Opus 5.5, fallback Opus 4.8); Qwen3 Coder 480B, Nova, DeepSeek kept as options for OpenCode roles; bedrockModelId() guards it |
| H? | E3 | Engine purity scan: the spec's regex scan strips strings and comments with a regex that breaks on regex literals, so text inside strings could hide or trigger rules | AST walk (TypeScript parser): 24 forbidden constructs caught, 0 false positives from strings/comments/regex literals/property names in tests | AST purity check |
| H? | E3 | Spec'd synthesis/refine return a bundle with "Unresolved" warnings after 2 failed fixes; refine also restarts each fix from the original files | An invalid bundle would reach Sandpack as "ready", and a fix returning only one file would drop the earlier edit (reproduced in a unit test) | Exhausted fixes throw → `done ok=false`, Studio keeps the previous bundle; refine changes accumulate across attempts |
| H? | E3 | Step 3 depends on Eng 1/2 helpers that are still stubs | Built against injected ports with 51 unit tests (fake LLM/sandbox, real Express + SSE) | Wire the real helpers in `routes/step3/deps.ts` only; routes return 503 until then |
| H? | E3 | Shared `llm/llm.ts` (Eng 2's module) was still a stub, blocking every Claude call in Step 3 | Implemented from `02_llm_client.md` (Mantle client, JSON-schema output, explicit effort, cached system prompt, one refusal retry on `refusal_fallback`); 6 unit tests on a fake Mantle client; a compile-time check showed our port's loose message type didn't match the SDK, so ports now use `Anthropic.MessageParam`. Suite 57/57. `test:llm` reaches the SDK and stops at "No AWS region" (no `.env`/AWS credentials on this machine) | Eng 2 reuses this file instead of writing a second client. Live call pending credentials |
