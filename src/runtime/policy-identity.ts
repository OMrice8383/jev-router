import { createHash } from "node:crypto";
import type { Policy } from "../core/policy/types";

export const ROUTING_REVISION = "task-aware-v1";

/** Fingerprint the policy loaded in memory, not a possibly newer file on disk. */
export function policyFingerprint(policy: Policy): string {
  return createHash("sha256")
    .update(JSON.stringify(policy, (key, value) => (key === "expr" ? undefined : value)))
    .digest("hex");
}
