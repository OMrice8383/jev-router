# Downstream subscription-only setup

This is the OMrice8383 development fork, not a published upstream release. It retains the upstream MIT license. Do not run the upstream blanket setup on an active development environment. Mocked tests, authenticated inference and actual subscription-allowance/savings measurement are separate gates.

## What is deliberately unchanged

Claude still authenticates with its own first-party login; the relay forwards that authorization only to its configured Anthropic egress. Pi still uses its own authenticated provider. The judge receives the bounded dossier, not authorization headers. RTK, codemode, account logins and existing sessions are not replaced. No inference API key or billed gateway fallback is configured by the subscription-only example. The TypeSafe judge is a separately billed API and needs its own key.

## Account isolation

Use **one relay process and one JEV_ROUTER_HOME per Claude account**, on separate loopback ports. Plan-window state is scoped to a relay egress, not an account; sharing one relay between accounts is intentionally NOT supported by this setup. Do not switch accounts inside a conversation. No new account router or queue is introduced.

Example Windows process-scoped settings (not global environment variables):

```powershell
# Main account relay/profile
Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
$env:JEV_ROUTER_HOME = "$env:USERPROFILE\.jev-router-main"
# Copy examples/subscription-only.json to this home's policy.json.
# Register TYPESAFE_API_KEY in this home's env file privately, never in Git or command output.
node dist/cli/index.js setup --agent claude-code --no-service --no-prompt --dry-run --port 4141
# Inspect first; remove --dry-run only for the intended NEW-session setup.
node dist/cli/index.js up --port 4141
```

For the secondary account use `.claude-sub`, `.jev-router-sub`, and port `4142` in a separate process. `setup` now respects `CLAUDE_CONFIG_DIR`; changing only JEV_ROUTER_HOME does NOT select a Claude account. Validate the existing `claude-sub` launcher still selects that account. Windows has no bundled automatic service installation; use the existing terminal/process manager to run `up`, rather than adding another scheduler. Linux may use the existing service integration, separately configured per account; do not install both under the same service label.

The default `.claude.json` metadata lives in the user home; when CLAUDE_CONFIG_DIR is explicitly set, native Claude uses `.claude.json` inside that directory. Do not set `.claude` explicitly for an existing default login unless that selected config directory contains its metadata; otherwise use the normal main launcher with CLAUDE_CONFIG_DIR unset. Review the dry-run output before applying.

## Pi

Install the tested fork artifact or local checkout, not `npm:jev-router` (which names a different package). The upstream scoped package name is `@french-castle/jev-router`; this fork is not published there.

```text
pi install C:\Users\white\dev\jev-router
```

For a single trial without permanent installation use `pi -e <fork>/dist/adapters/pi/index.js`. Set that process's JEV_ROUTER_HOME to a dedicated Pi profile holding the example policy and judge env file. The extension loads this env file without overwriting environment variables. Confirm the candidate's `pi.provider` and `pi.model` against the local authenticated model registry: the desktop uses `openai-codex`; a server may use `openai`. Do not silently substitute a gateway provider.

## Policy and cache limits

The example uses only subscription egresses and leaves model-window quota caps and response cascades disabled. Low remaining quota is not permission to silently lower a security/financial correctness requirement. It starts normal work at a capable medium-effort setting and allows lighter models only for low-stakes easy tasks. Judge failure keeps the actual Pi selection. Keep the selected model and effort through healthy tool continuations; failures and new user tasks can trigger reconsideration.

Changing top-level Claude effort can invalidate message caches. Do not describe effort-first switching as free. The example disables effort-first escalation; no unverified per-message beta transport is introduced. Pi's real usage now feeds the existing cache-cost estimate. API-equivalent prices and counterfactual estimates are not the subscription's actual deduction or proven savings.

## Acceptance before rollout

Run typecheck, lint, tests, build, Node cancellation smoke and packaged imports on Windows and Linux. Then test one new Claude secondary session and Pi session with a real judge key, checking the actual served model/effort, provider, tool continuation and failure handling. Finally compare equivalent tasks for correctness, retries, total Claude+Pi usage and judge cost. Do not remove fixed model overrides in all Orca sessions before this is demonstrated.

Rollback the selected profile from its backup and restart only the affected trial session. Existing ongoing sessions are left alone. Never publish environment files, logs containing prompt/customer data, or account credentials.
