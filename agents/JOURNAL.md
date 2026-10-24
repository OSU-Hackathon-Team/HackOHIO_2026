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
