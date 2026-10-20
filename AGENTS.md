# Downstream development

This is a development-tools fork of FrancoisChastel/jev-router, retaining its MIT license and attribution. Do not rewrite the routing engine or add unrelated infrastructure.

For DEEP OS work, cross-project requirements are owned by OMrice8383/deep-os; task, gate and evidence records are owned by Project Manager. Use the PM CLI from `C:\Users\white\dev\project-manager`, never its `data/` directory. The coordinating session reads inbox and project chat before work and posts verified evidence afterwards; delegated code-only workers must not read credentials or update PM independently.

Preserve working Claude/Claude-sub/Pi authentication, running sessions, RTK and existing instructions. Test with disposable settings, mock credentials and loopback upstreams. No production setup, credentials copying, automatic API billing fallback, or publishing an npm package.

Reference material lives under `C:\Users\white\dev\deep-os\_received\OneDrive_2026-10-08\current\売り上げデータ`; check sync status and timestamps before use and work only on copies. This fork needs no business data. Never commit customer data, real Excel/CSV, shared URLs, credentials or tokens.

Attendance/LINE/transport business logic belongs to OMrice8383/deep-os-attendance, not this tooling fork. Cross-repo contracts follow the parent documents. Parallel edits of this repo require separate git worktrees, and other workers' changes must be preserved.

On first inspection, verify that AGENTS.md and CLAUDE.md retain these common rules. Add only missing equivalents and report the files, changes and verification to the user; do not duplicate existing rules or silently override conflicts.

Use focused regression tests first, then typecheck/lint/build and required Windows/Linux checks. Distinguish mocked protocol tests, actual client loading, actual authenticated inference and savings measurements. Never report an unrun gate as passed.
