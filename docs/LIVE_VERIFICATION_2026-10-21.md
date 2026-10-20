# Native subscription and Jev verification — 2026-10-21

## Outcome

The fork was exercised with a real TypeSafe/Jev judge and the existing native Claude Code secondary-account and Pi authentication. No production inference API key, paid gateway fallback, global agent setting change, or existing session restart was introduced. The key was entered once into a local password-masked form and saved outside Git; it was never printed or included in this report.

## Real results

- Native `jev-router ping`: TypeSafe returned `jev-1.13.0`, approximately 210 ms. Other observed judge calls were roughly 140–220 ms; this is a small sample, not a latency guarantee.
- Claude Code 2.1.304 secondary account: native auth status reported `claude.ai`, `firstParty`, `max`. A disposable whitespace-normalization module was fixed and all three Node tests passed; the test source was unchanged.
- Pi 1.3.0: `openai-codex` with its existing authentication fixed numeric sorting/deduplication in a second disposable module; all three Node tests passed and the test source was unchanged. Actual assistant records identify the native subscription provider.
- A separate trivial request started Pi on Sol/High and was actually served by `gpt-6-luna` at Medium after Jev selection.
- A separate native Claude request started with High and was routed to `claude-haiku-5-5` at Low. The request-shape trace confirmed the selected Low in the current runtime system message; the real first-party API returned OK. The top-level High and historical message objects were preserved.
- Successful tool continuations reused the chosen model/effort without another judge call. Real cache read/write usage reached the decision records. This does not establish net savings.
- First-party Claude responses reported subscription-window utilization and `fallback_credit: null`. Usage percentages are account-wide observations, not this test's incremental consumption. API-list-price metrics are not subscription invoices or deductions.

## Additional defects found and fixed during live verification

1. Current Claude Code appends runtime `role: system` messages after user input/tool results. The old normalizer examined the final raw message and treated a fresh task as a continuation. It now examines the last user/assistant message without modifying the wire input.
2. A native per-message `output_config.effort` can override top-level effort. The rewrite now applies the chosen setting to the existing current-turn control message, not older conversation turns. It introduces no beta header or new system message. With disabled thinking, changing this control enables adaptive thinking where required by the known model's compatibility rules.
3. The old example's Haiku 4.5 does not accept native mid-conversation system/effort messages. The tested account's native `haiku` alias resolved to Haiku 5.5. The user-specific trial policy therefore uses Haiku 5.5; this is a configuration update, not removal of system instructions or weakening of their role.

Official effort semantics: https://platform.claude.com/docs/en/build-with-claude/effort

## Final code gates

Runtime commit: `7070b4704d93cec887c50a29e9065070ce1070d4`.

- Windows Node 24.19/Bun 1.3.13: **438 passed, 1 skipped, 0 failed**; typecheck, lint, build, Node cancellation smoke passed.
- Linux Docker Node 22/Bun 1.3.13, network disabled: **438 passed, 1 skipped, 0 failed**; full check and Node cancellation smoke passed. The existing Bun cancellation skip is covered by the separate Node smoke on both platforms.
- Fresh independent review of the conversation-boundary repair: PASS, 27 focused tests.
- Fresh independent review of the effort repair found one disabled-thinking edge. Its regression failed before repair; after repair, the focused follow-up review was PASS with 29 tests. Reviewers did not claim live authentication coverage.

## Scope and remaining limits

The real trials used small synthetic inputs and isolated working directories, not customer files. Existing main/secondary Claude settings and Pi settings/append-system files retained their original hashes. Production source data, active Orca sessions and remote servers were not changed.

A conservative policy starts uncertain new work on a capable tier and permits lower tiers only on positive easy/routine classifications. A six-case trial agreed with five reference choices; the remaining cosmetic case stayed too expensive because confidence was low. This is not a benchmark or proof that security/business tasks will always be classified correctly. Explicit requirements and human/PM acceptance remain authoritative.

The current native account offers Haiku 5.5; do not silently route current Claude messages to legacy Haiku 4.5. Model catalog, context and subscription availability should be checked on each deployment. Example price fields remain routing weights, not verified current prices for every updated model.

Not completed: all-Orca rollout, both-account concurrent real routing, remote-machine deployment, long-session reliability, a matched quality/cost benchmark and exact subscription allowance reduction. The PM reporting command was blocked by the tool layer; a local report draft was retained rather than bypassing the block.
