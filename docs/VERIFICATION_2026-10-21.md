# Downstream verification — 2026-10-21

Upstream: `FrancoisChastel/jev-router` v0.3.0, `c8f267dd9e3c9548fd1df55cb2c607fa76cf20e2`.
Downstream code tested: `d7b758d2593febe1ec5502aa86031b9f19b381e9` (later documentation/package-file-list changes do not alter runtime code).
Version: `0.3.0-nagakura.1`. This is a tooling fork, not a deployment to existing agent sessions.

## Results

| Gate | Evidence |
|---|---|
| Windows / Node 24.19.0 / Bun 1.3.13 | Typecheck, lint and build exit 0; **428 tests pass, 1 skip, 0 fail**, 50 files / 1644 assertions. |
| Linux Docker / Node 22 / Bun 1.3.13 | `bun run check` exit 0; **428 tests pass, 1 skip, 0 fail**, 50 files. Network disabled during checks; 2 CPUs / 2 GiB test container. |
| Cancellation | Dedicated Node cancellation smoke passes on Windows and Linux. The upstream Bun cancellation test remains skipped because its HTTP transport cannot exercise that path. |
| Native Pi 1.3.0 | Actual installed CLI loads the built extension in a disposable home; RPC get_commands/get_state succeed and jev-router is registered. No model prompt or authenticated inference. |
| Native Claude Code 2.1.304 | Actual installed CLI -> built Node relay -> loopback mock upstream returns NATIVE_MOCK_OK. Observed selected Haiku 4.5, max_tokens 64000, no incompatible adaptive/effort fields, and only a fixture credential. No Anthropic inference or real OAuth used. |
| Independent review | Fresh-session review found a fallback-lease effort regression. Added two reproductions: 0 pass / 2 fail before correction; Pi regression suite 36 pass after. Separate focused follow-up review: PASS, 36/36 tests. |

Lint retains an upstream warning/informational notice; they are not hidden as zero warnings.

## Fixes covered

Claude model-specific output normalization; selected effort insertion; explicit account config-directory and plan-metadata selection; correct scoped Pi install instructions; local judge-env-file loading; actual initial model/effort retained on judge failures and subsequent healthy tool chains; completed-model usage attribution and cache input; sticky image capability; healthy tool-chain model stability; cache-aware deterministic downgrade; cross-platform path and timer checks.

The account-usage collision is addressed operationally by **separate relay processes/configuration homes/ports**, with a regression confirming separate stores cannot overwrite each other. Sharing one relay between Claude accounts remains unsupported, not magically fixed.

The subscription-only example has no inference API-key gateway fallback, no quota-based forced quality downgrade and no automatic response cascade. TypeSafe judgment remains separately billed. The example's model IDs/provider names must be verified against each host's authenticated catalog before deployment.

## Not established

- Live TypeSafe/Jev request success or selection accuracy: no judge key was configured.
- Real Anthropic/ChatGPT allowance deduction through this fork or support for every model/account/plan.
- Real multi-turn model inference through Pi, long-workload reliability, usage reduction or monetary savings.
- Production rollout, existing Orca/session changes, Windows automatic service installation, or shared-account relay support.

The tests above are not a claim that mock credentials prove subscription billing. Existing live Claude/Pi configuration files, OAuth files and active sessions were not modified. Use [DOWNSTREAM_SETUP.md](DOWNSTREAM_SETUP.md) for a scoped new-session trial after registering the judge key privately.
