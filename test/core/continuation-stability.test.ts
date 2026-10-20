import { describe, expect, test } from "bun:test";
import { plan } from "../../src/core/decide";
import { loadPolicy } from "../../src/core/policy";
import { emptySession } from "../../src/core/session";
import type { NormalizedRequest, SessionState } from "../../src/core/types";
import { PlanWindowStore } from "../../src/daemon/plan-window";
import { minimalPolicy } from "../fixtures/policies";

const policy = loadPolicy(minimalPolicy());
function continuation(): NormalizedRequest {
  return {
    harness: "claude-code",
    sessionKey: "fixture",
    requestedModel: "auto",
    isNewUserTurn: false,
    toolNames: ["Read", "Edit"],
    toolOutcomes: [{ name: "Edit", isError: false }],
    hasImages: false,
    estimatedInputTokens: 150000,
  };
}
function activeSession(): SessionState {
  return { ...emptySession(), current: { candidate: "mid", effort: "medium", lease: "tool_chain", sinceTurn: 0 } };
}

describe("downstream cache-preserving continuations", () => {
  test("twenty healthy tool turns keep the selected model and effort without re-judging", () => {
    let session = activeSession();
    for (let i = 0; i < 20; i++) {
      const result = plan({ request: continuation(), session, policy, policyId: "default" });
      expect(result.kind).toBe("decision");
      if (result.kind !== "decision") throw new Error("unexpected judge call");
      expect(result.decision).toMatchObject({ candidate: "mid", effort: "medium", source: "lease" });
      session = result.session;
    }
  });
  test("a fresh user task can still be re-judged", () => {
    const request = { ...continuation(), isNewUserTurn: true, toolOutcomes: [], lastUserText: "A different task" };
    expect(plan({ request, session: activeSession(), policy, policyId: "default" }).kind).toBe("judge");
  });
  test("three genuine failing batches still break the hold and escalate", () => {
    const request = { ...continuation(), toolOutcomes: [{ name: "Edit", isError: true, errorText: "failed" }] };
    const session = { ...activeSession(), consecutiveFailures: 2 };
    const result = plan({ request, session, policy, policyId: "default" });
    expect(result.kind).toBe("decision");
    if (result.kind !== "decision") throw new Error("expected recovery");
    expect(result.decision.candidate).toBe("frontier");
    expect(result.decision.reasons).toContain("repeated_failures");
  });
  test("separate relay instances do not mix main and secondary subscription windows", () => {
    const main = new PlanWindowStore();
    const secondary = new PlanWindowStore();
    const header = "anthropic-ratelimit-unified-5h-utilization";
    main.update("anthropic-subscription", (name) => (name === header ? "0.96" : null), 1000);
    secondary.update("anthropic-subscription", (name) => (name === header ? "0.02" : null), 1000);
    expect(main.utilization("anthropic-subscription", 1001)?.fiveHour).toBe(0.96);
    expect(secondary.utilization("anthropic-subscription", 1001)?.fiveHour).toBe(0.02);
  });
});
