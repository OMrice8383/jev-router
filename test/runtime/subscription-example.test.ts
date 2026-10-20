import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { plan } from "../../src/core/decide";
import { loadPolicy } from "../../src/core/policy";
import { emptySession } from "../../src/core/session";
import type { NormalizedRequest } from "../../src/core/types";

const policy = loadPolicy(JSON.parse(readFileSync(new URL("../../examples/subscription-only.json", import.meta.url), "utf8")));

describe("subscription-only deployment example", () => {
  test("has only first-party subscription inference egresses, no quota downgrades or response replay", () => {
    for (const egress of Object.values(policy.egress)) {
      expect(egress.billing).toBe("subscription");
      expect(egress.forward_auth).toBe(true);
      expect(egress.api_key_env).toBeUndefined();
    }
    for (const def of Object.values(policy.policies)) {
      expect(def.cascade.enabled).toBe(false);
      expect(def.switch.prefer_effort_over_model).toBe(false);
      expect(def.rules.some((rule) => rule.then.at_most !== undefined)).toBe(false);
    }
    expect(policy.candidates["pi-sol"]?.pi?.provider).toBe("openai-codex");
  });
  test("high-stakes work has a capable/high-effort route even with a nearly exhausted window", () => {
    for (const harness of ["claude-code", "pi"] as const) {
      const request: NormalizedRequest = {
        harness,
        sessionKey: "example",
        requestedModel: "auto",
        isNewUserTurn: true,
        hasImages: false,
        estimatedInputTokens: 10000,
        toolNames: ["edit"],
        toolOutcomes: [],
        planWindow: { fiveHour: 0.99 },
        lastUserText: "Review authorization correctness",
      };
      const result = plan({ request, session: emptySession(), policy, policyId: harness === "pi" ? "pi" : "claude" });
      if (result.kind !== "judge") throw new Error("expected judge request");
      const out = result.conclude({
        stakes: { type: "score", score: 2.8, confidence: 0.99, probabilities: {} },
        difficulty: { type: "score", score: 2.8, confidence: 0.99, probabilities: {} },
      });
      expect(out.decision.candidate).toBe(harness === "pi" ? "pi-sol" : "claude-opus");
      expect(out.decision.effort).toBe("high");
    }
  });
});
