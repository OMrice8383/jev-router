import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { plan } from "../../src/core/decide";
import { loadPolicy } from "../../src/core/policy";
import { emptySession } from "../../src/core/session";
import type { NormalizedRequest, SessionState } from "../../src/core/types";
import type { Answer } from "../../src/judge/types";

const patch = JSON.parse(readFileSync(new URL("../../examples/task-aware-policy-patch.json", import.meta.url), "utf8"));
const candidate = (model: string, price: number) => ({
  model,
  price: { in: price, out: price * 5 },
  effort: ["low", "medium", "high"],
  default_effort: "medium",
});
const policy = loadPolicy({
  version: 1,
  judge: { transport: "mock", on_error: "fail_open" },
  candidates: {
    "claude-haiku": candidate("haiku", 1),
    "claude-sonnet": candidate("sonnet", 2),
    "claude-opus": candidate("opus", 4),
    "pi-luna": candidate("luna", 0.1),
    "pi-sol": candidate("sol", 2),
  },
  routes: [],
  policies: {
    claude: {
      ...patch.claude,
      order: ["claude-haiku", "claude-sonnet", "claude-opus"],
      min_confidence: 0.8,
      switch: { cache_penalty: true },
    },
    pi: { ...patch.pi, order: ["pi-luna", "pi-sol"], min_confidence: 0.8 },
  },
});
const req = (over: Partial<NormalizedRequest> = {}): NormalizedRequest => ({
  harness: "claude-code",
  sessionKey: "task-test",
  requestedModel: "auto",
  isNewUserTurn: true,
  lastUserText:
    "Goal: Apply a confirmed local change\nPhase: implementation\nNext action: edit src/parser.ts\nDone: regression tests pass\nTargets: src/parser.ts",
  toolNames: ["Read", "Edit", "Bash"],
  hasImages: false,
  estimatedInputTokens: 1000,
  requestedEffort: "high",
  toolOutcomes: [],
  ...over,
});
const answers = (difficulty = 1.6, stakes = 2, reasoning = 0.5, kind = "code_edit", confidence = 0.95): Record<string, Answer> => ({
  difficulty: { type: "score", score: difficulty, probabilities: {}, confidence },
  stakes: { type: "score", score: stakes, probabilities: {}, confidence },
  needs_reasoning: { type: "noul", noul: reasoning },
  output_kind: { type: "choice", choice: kind, probabilities: {}, confidence },
});
function judge(request = req(), session = emptySession(), a: Record<string, Answer> | null = answers(), policyId = "claude") {
  const p = plan({ request, session, policy, policyId });
  return p.kind === "decision" ? p : p.conclude(a);
}
function difficultSession() {
  return judge(
    req({
      lastUserText:
        "Task: ROUTE-G1-T1\nGoal: Diagnose an unexplained parser hang\nPhase: investigation\nNext action: isolate the cause\nDone: a reproducer and verified fix\nTargets: src/parser.ts",
    }),
    emptySession(),
    answers(2.9, 2, 0.95, "plan"),
  ).session;
}

test("local implementation with impact two is middle/medium, not automatically frontier", () => {
  expect(judge().decision).toMatchObject({ candidate: "claude-sonnet", effort: "medium" });
  expect(judge(req({ harness: "pi" }), emptySession(), answers(), "pi").decision).toMatchObject({ candidate: "pi-sol", effort: "medium" });
});
test("capability and reasoning effort are independent, including upper/medium", () => {
  expect(judge(req(), emptySession(), answers(2.9, 2, 0.6, "plan")).decision).toMatchObject({ candidate: "claude-opus", effort: "medium" });
  expect(judge(req(), emptySession(), answers(2.9, 2, 0.95, "plan")).decision).toMatchObject({ candidate: "claude-opus", effort: "high" });
  expect(judge(req(), emptySession(), answers(0.7, 1.5, 0.2, "tool_plan")).decision).toMatchObject({
    candidate: "claude-haiku",
    effort: "low",
  });
});
test("uncertainty about output format does not veto a confidently diagnosed difficult task", () => {
  const a = answers(2.99, 0.96, 0.8, "tool_plan");
  a.output_kind = { type: "choice", choice: "tool_plan", probabilities: { tool_plan: 0.51, code_edit: 0.41 }, confidence: 0.41 };
  expect(judge(req(), emptySession(), a).decision).toMatchObject({ candidate: "claude-opus", effort: "high" });
});
test("a confident critical-design classification and reasoning are not vetoed by uncertain blast-radius grading", () => {
  const a = answers(2.63, 0.93, 0.83, "critical_design_review");
  a.difficulty = { type: "score", score: 2.63, probabilities: {}, confidence: 0.63 };
  a.stakes = { type: "score", score: 0.93, probabilities: {}, confidence: 0.05 };
  expect(judge(req({ lastUserText: "Goal: Review authentication boundaries\nPhase: review" }), emptySession(), a).decision).toMatchObject({
    candidate: "claude-opus",
    effort: "high",
  });
});
test("a new task does not inherit frontier/high when judge confidence is low or unavailable", () => {
  for (const a of [answers(1.6, 2, 0.4, "code_edit", 0.2), null]) {
    const next = judge(
      req({ lastUserText: "Task: ROUTE-G1-T2\nGoal: Apply the already-approved local patch\nPhase: implementation\nDone: tests pass" }),
      difficultSession(),
      a,
    );
    expect(next.decision).toMatchObject({ candidate: "claude-sonnet", effort: "medium" });
    expect(next.decision.reasons).toContain("task_boundary:new_task");
  }
});
test("continue preserves the current task and model on judge failure", () => {
  const next = judge(req({ lastUserText: "続けて" }), difficultSession(), null);
  expect(next.decision).toMatchObject({ candidate: "claude-opus", effort: "high" });
  const p = plan({ request: req({ lastUserText: "続けて" }), session: difficultSession(), policy, policyId: "claude" });
  expect(p.kind).toBe("judge");
  if (p.kind === "judge") {
    const work = p.judgeRequest.state.work;
    expect(work?.goal).toContain("unexplained parser hang");
    expect(work?.completion).toContain("verified fix");
    expect(work?.targets).toContain("src/parser.ts");
  }
});
test("resolved investigation and confirmed implementation trigger reevaluation despite an old hold", () => {
  const session: SessionState = { ...difficultSession(), holdUntilTurn: 100, consecutiveFailures: 3 };
  const p = plan({
    request: req({
      isNewUserTurn: false,
      lastUserText: "",
      assistantIntentTail: "Phase: implementation\nNext action: Apply the confirmed patch. 原因は判明し修正方針は確定。",
      toolOutcomes: [{ name: "Bash", isError: false, excerpt: "reproducer confirmed" }],
    }),
    session,
    policy,
    policyId: "claude",
  });
  expect(p.kind).toBe("judge");
  if (p.kind === "judge") {
    const result = p.conclude(answers());
    expect(result.decision.candidate).toBe("claude-sonnet");
    expect(result.decision.reasons.some((r) => r.startsWith("task_boundary:"))).toBe(true);
    expect(result.session.consecutiveFailures).toBe(0);
  }
});
test("an explicit phase-only instruction keeps the task purpose and completion criteria", () => {
  const p = plan({
    request: req({ lastUserText: "Phase: implementation\nNext action: Apply the already-confirmed fix" }),
    session: difficultSession(),
    policy,
    policyId: "claude",
  });
  expect(p.kind).toBe("judge");
  if (p.kind === "judge") {
    expect(p.judgeRequest.state.work?.goal).toContain("unexplained parser hang");
    expect(p.judgeRequest.state.work?.completion).toContain("verified fix");
    expect(p.judgeRequest.state.work?.phase).toBe("implementation");
  }
});
test("the latest user phase and next operation override old assistant preambles", () => {
  const p = plan({
    request: req({
      lastUserText: "Task: ROUTE-G1-T2\nGoal: Apply the confirmed local patch\nPhase: implementation\nNext action: Edit src/new-config.ts",
      assistantIntentTail: "Phase: investigation\nNext action: Keep searching the old bug",
    }),
    session: difficultSession(),
    policy,
    policyId: "claude",
  });
  expect(p.kind).toBe("judge");
  if (p.kind === "judge")
    expect(p.judgeRequest.state.work).toMatchObject({ phase: "implementation", nextAction: "Edit src/new-config.ts" });
});
test("healthy tools within the same phase keep the lease without another judge call", () => {
  const p = plan({
    request: req({ isNewUserTurn: false, lastUserText: "", toolOutcomes: [{ name: "Edit", isError: false }] }),
    session: difficultSession(),
    policy,
    policyId: "claude",
  });
  expect(p.kind).toBe("decision");
  if (p.kind === "decision") expect(p.decision).toMatchObject({ candidate: "claude-opus", source: "lease" });
});
test("infrastructure failures are not evidence of insufficient model capability", () => {
  for (const errorText of [
    "HTTP 429 rate limit exceeded",
    "ECONNREFUSED dependency service unavailable",
    "401 OAuth token expired",
    "EACCES permission denied",
    "ENOSPC disk full",
  ]) {
    let session = judge().session;
    for (let i = 0; i < 4; i++) {
      const result = judge(
        req({ isNewUserTurn: false, lastUserText: "", toolOutcomes: [{ name: "Bash", isError: true, errorText }] }),
        session,
        null,
      );
      expect(result.decision.candidate).toBe("claude-sonnet");
      expect(result.decision.reasons).toContain("infrastructure_failure");
      session = result.session;
    }
  }
});
test("one traceback followed by source reading is not proof that the middle model cannot solve the task", () => {
  const middle = judge().session;
  const session: SessionState = {
    ...middle,
    current: { candidate: "claude-sonnet", effort: "medium", lease: "one_call", sinceTurn: 0 },
    ledger: [
      [{ name: "Bash", isError: true, errorText: "Traceback (most recent call last): known fixture assertion" }],
      Array.from({ length: 5 }, () => ({ name: "Read", isError: false })),
    ],
  };
  const p = plan({
    request: req({ isNewUserTurn: false, lastUserText: "", toolOutcomes: [{ name: "Read", isError: false }] }),
    session,
    policy,
    policyId: "claude",
  });
  expect(p.kind).toBe("judge");
  if (p.kind === "judge")
    expect(
      p.conclude({ tools_failed: { type: "noul", noul: 0.2 }, spinning: { type: "noul", noul: 0 }, producing: { type: "noul", noul: 0 } })
        .decision.candidate,
    ).toBe("claude-sonnet");
});
test("compaction is not by itself a reason to raise capability", () => {
  const result = judge(
    req({ isNewUserTurn: false, lastUserText: "", contextCompacted: true, toolOutcomes: [{ name: "Read", isError: false }] }),
    judge().session,
    answers(),
  );
  expect(result.decision.candidate).toBe("claude-sonnet");
});
test("long preambles do not hide the latest requirements from the judge", () => {
  const p = plan({
    request: req({
      lastUserText:
        "old preface ".repeat(500) +
        "\nGoal: Rename the confirmed setting\nPhase: implementation\nNext action: edit src/config.ts\nDone: both regression tests pass\nTargets: src/config.ts",
    }),
    session: emptySession(),
    policy,
    policyId: "claude",
  });
  expect(p.kind).toBe("judge");
  if (p.kind === "judge") {
    expect(p.judgeRequest.state.task).toContain("both regression tests pass");
    expect(p.judgeRequest.state.work?.nextAction).toContain("src/config.ts");
    expect(JSON.stringify(p.judgeRequest.state).length).toBeLessThanOrEqual(12000);
  }
});
test("critical auth design/review retains capability even if the judge is unavailable", () => {
  const result = judge(
    req({
      lastUserText:
        "Goal: Review authentication and permission boundary design\nPhase: review\nNext action: decide whether the role isolation design is safe\nDone: unauthorized access cannot cross store boundaries",
    }),
    emptySession(),
    null,
  );
  expect(result.decision).toMatchObject({ candidate: "claude-opus", effort: "medium" });
});
test("routine auth-fixture review against an approved procedure is not treated as a new security design", () => {
  const result = judge(
    req({
      lastUserText:
        "Goal: Review the auth fixture against the already-approved mapping; only check the known expected values, no design decision\nPhase: review\nNext action: Check the three expected fixture values\nDone: the existing fixture matches",
    }),
    emptySession(),
    null,
  );
  expect(result.decision.candidate).toBe("claude-sonnet");
});
test("checking auth fixtures against an approved design does not become a new design decision", () => {
  const result = judge(
    req({
      lastUserText:
        "Goal: Review the auth fixture against the already-approved design and check the known expected values\nPhase: review\nNext action: Check the existing fixture\nDone: fixture values match",
    }),
    emptySession(),
    null,
  );
  expect(result.decision.candidate).toBe("claude-sonnet");
});
test("a cache-blocked boundary is measured and rechecked, not leased indefinitely", () => {
  const session = { ...difficultSession(), lastUsage: { inputTokens: 500000, outputTokens: 100, cacheReadTokens: 499000 } };
  const result = judge(
    req({ estimatedInputTokens: 500000, lastUserText: "Task: ROUTE-G1-T2\nGoal: Small confirmed local edit\nPhase: implementation" }),
    session,
    answers(),
  );
  expect(result.decision.reasons).toContain("cache_penalty_blocked");
  expect(result.decision.cache?.penaltyUsd).toBeGreaterThan(0);
  expect(result.decision.lease).toBe("one_call");
});
