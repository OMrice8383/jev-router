# Task-aware routing

This fork keeps model selection in jev-router. Launch instructions do not select a model or reasoning effort. The supplied profile targets Pi and Claude, excludes Astra/Fable, and preserves each machine's configured providers and model IDs.

## Objective and rules

Optimize completion time and subscription consumption **including rework**, subject to acceptable quality. A higher cheap-model share is not a success criterion. Token counts and price estimates are not measurements of subscription utilization.

| Situation | Claude | Pi |
|---|---|---|
| Default ordinary implementation/investigation | Sonnet / medium | Sol / medium |
| Confidently bounded work: difficulty < 1, stakes < 2.5, reasoning < .5, supported output kind | Haiku / low | Luna / medium |
| Difficulty >= 2.6 or critical design/review | Opus | Sol, the highest configured Pi capability |
| Reasoning probability >= .8 | high effort, separately from capability | high effort, separately from capability |

Difficulty measures unresolved reasoning and uncertainty, not file count, a PM title, or the presence of builds/data. Stakes measure actual blast radius, reversibility and verification. Stakes alone no longer pin the highest model or effort.

Each matching rule checks confidence only in its own score/choice inputs. Ambiguity between `code_edit` and `tool_plan` must not veto a confident difficult-task rule. Low-confidence rules cannot justify a cheap-model switch.

An explicit consequential auth/permission/payment/migration design or design review has a capability floor, including when judging is unavailable. This does not force high reasoning effort. Approved routine implementation and fixture verification are not new design decisions.

## Existing execution context, not another manager

A bounded `WorkContext` carries goal, phase, next action, completion criteria, targets, optional Task ID and latest failure. It comes deterministically from existing user messages, assistant execution intent and tool outcomes. Missing information stays empty/unknown; the router does not query or duplicate the PM database or call a summarization model.

Optional labels make intent precise:

```text
Task: APP-G1-T02
Goal: Diagnose the parser hang
Phase: investigation
Next action: isolate the cause
Done: a causal reproducer and verified regression
Targets: src/parser.ts
```

Japanese equivalents are supported. Unstructured requests use bounded head-and-tail text rather than only the first 2,000 characters. Pi recovers context from the existing session branch. Claude rebuilds the bounded snapshot from existing history without changing the upstream request body, including after a cold relay restart.

Continuation and recognised short follow-ups retain purpose. Phase-only instructions preserve goal/completion/targets. A new Task, explicit phase change or confirmed problem resolution reassesses capability and effort and clears old holds/failure counts. If judging is unavailable or uncertain at that boundary, start from the configured default/medium rather than inheriting frontier/high. Same-Task uncertainty can retain the actual current selection. Tool chains otherwise remain stable.

429, connectivity, expired credentials, unavailable dependencies and resource/permission failures do not count as proof that a more capable model is needed. Compaction and an isolated traceback are not forced escalations. Repeated actual task failures still provide escalation evidence.

Cache-switch checks remain enabled. A cache-blocked downgrade is reconsidered on the next call rather than receiving an indefinite lease. A reported zero API price does not establish zero subscription cost.

## Apply and verify

Build and run the focused regressions while changing code; run the full check once at the final gate:

```sh
bun install --frozen-lockfile --ignore-scripts
npm run check
node scripts/apply-task-aware-policy.cjs
```

The apply script reads `JEV_ROUTER_HOME` and `PI_CODING_AGENT_DIR` where set. It changes only routing/default fields, creates timestamped `.bak-task-aware-*` files, and leaves credentials, egresses, provider identifiers and unrelated settings intact. A normal checkout/build does not apply it automatically.

Deploy runtime files without deleting old bundled chunks while existing Pi processes may still import them. Do not restart active agents. Replace shared relays individually only when no client requests are in flight; the new server drains active responses during shutdown.

A copied file is not proof of loaded configuration:

- Relay `/healthz` reports `routingRevision`, loaded `policyHash` and `activeRequests`.
- Pi status and decision logs include the loaded revision/hash.
- Current revision: `task-aware-v2`. Hashes may differ across machines with intentionally different providers.
- Already-running Pi processes keep their old loaded implementation until a safe reload/restart. A shared relay update does not reload Pi.

Decision logs retain Task ID/phase/failure classification, not Task text. Launch selection records carry the loaded identity. See [LAUNCH_AUDIT](LAUNCH_AUDIT.md) for inspection and recovery.

## Evaluation limits

Historical decision logs do not contain Task text or trustworthy Task completion times. Replaying their stored answers tests rule changes; it cannot re-grade the original work or prove a time/consumption improvement. Use a few actual Tasks to record selection/reasons, elapsed time, observed tool/test failures, input/output/cache tokens and any visible plan-window utilization. Report unavailable subscription measurements as unknown; do not infer them from price or token totals.
