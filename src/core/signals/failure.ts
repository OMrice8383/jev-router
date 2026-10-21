import type { ToolOutcome } from "../types";

// Operational failures need retry/credentials/service recovery, not a more capable model.
const INFRASTRUCTURE =
  /\b(?:429|502|503|504|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENOSPC|EACCES)\b|rate[ _-]?limit|too many requests|service unavailable|connection (?:refused|reset|timed out)|network (?:error|unreachable)|(?:oauth|auth|token|credential).{0,40}(?:expired|invalid|unavailable)|(?:401|403).{0,40}(?:auth|token|credential)|permission denied|disk (?:full|quota)|out of memory|依存.{0,12}(?:停止|接続不能)|認証.{0,8}(?:切れ|期限|失敗)|通信障害/i;

export function isInfrastructureFailure(outcome: ToolOutcome): boolean {
  return outcome.isError && (outcome.failureKind === "infrastructure" || INFRASTRUCTURE.test(outcome.errorText ?? outcome.excerpt ?? ""));
}

export function taskFailures(outcomes: readonly ToolOutcome[]): readonly ToolOutcome[] {
  return outcomes.filter((outcome) => !isInfrastructureFailure(outcome));
}
