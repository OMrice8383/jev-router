import { describe, expect, test } from "bun:test";
import { PiRouter, type PiRouterDeps } from "../../src/adapters/pi/router";
import type { Dossier } from "../../src/core/dossier";
import { loadPolicy } from "../../src/core/policy";
import type { Effort, LastUsage } from "../../src/core/types";
import { MockJudge } from "../../src/judge/mock";
import type { Answer, Judge } from "../../src/judge/types";
import { minimalPolicy } from "../fixtures/policies";

interface Ref {
  provider: string;
  id: string;
}

interface Calls {
  setModel: Ref[];
  setThinking: Effort[];
  notify: string[];
  status: (string | undefined)[];
  log: Record<string, unknown>[];
}

function harness(judge: Judge | undefined, over: Partial<PiRouterDeps<Ref>> = {}) {
  const calls: Calls = { setModel: [], setThinking: [], notify: [], status: [], log: [] };
  let current: Ref | undefined = { provider: "openrouter", id: "openai/gpt-5.4-mini" };
  const deps: PiRouterDeps<Ref> = {
    policy: loadPolicy(minimalPolicy()),
    policyId: "default",
    judge,
    findModel: (provider, id) => ({ provider, id }),
    setModel: async (m) => {
      calls.setModel.push(m);
      current = m;
      return true;
    },
    setThinkingLevel: (l) => {
      calls.setThinking.push(l);
    },
    currentModel: () => current,
    getActiveTools: () => ["read", "edit", "bash"],
    getContextTokens: () => 5000,
    notify: (m) => {
      calls.notify.push(m);
    },
    status: (t) => {
      calls.status.push(t);
    },
    log: (r) => {
      calls.log.push(r as unknown as Record<string, unknown>);
    },
    now: () => 1_000,
    randomId: () => "id-1",
    ...over,
  };
  const router = new PiRouter(deps);
  router.onSessionStart("startup");
  return { router, calls };
}

const midAnswers: Record<string, Answer> = {
  difficulty: { type: "score", score: 2.7, probabilities: {}, confidence: 0.9 },
  needs_reasoning: { type: "noul", noul: 0.4 },
  stakes: { type: "score", score: 1, probabilities: {}, confidence: 0.9 },
  output_kind: { type: "choice", choice: "code_edit", probabilities: { code_edit: 0.9 }, confidence: 0.9 },
  long_context: { type: "noul", noul: 0.1 },
};

const frontier = { provider: "openrouter", id: "openai/gpt-6-astra" };
const usage: LastUsage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 900, cacheWriteTokens: 100 };
const fastAnswers: Record<string, Answer> = {
  ...midAnswers,
  difficulty: { type: "score", score: 0, probabilities: {}, confidence: 0.9 },
  needs_reasoning: { type: "noul", noul: 0 },
  producing: { type: "noul", noul: 1 },
  tools_failed: { type: "noul", noul: 0 },
};

describe("pi adapter regressions", () => {
  const failedJudge: Judge = {
    evaluate: async () => {
      throw new Error("invalid_response");
    },
  };

  for (const [name, judge] of [
    ["unavailable", undefined],
    ["invalid", failedJudge],
    ["empty", new MockJudge({})],
  ] as const) {
    test(`${name} judge preserves initial frontier model and unsupported current thinking`, async () => {
      const { router, calls } = harness(judge, { currentModel: () => frontier, currentThinkingLevel: () => "max" });
      await router.onBeforeAgentStart({ prompt: "hello" });
      await router.onTurnEnd({ model: frontier, usage, toolResults: [] });
      expect(calls.setModel).toEqual([]);
      expect(calls.setThinking).toEqual([]);
      expect(calls.log[0]).toMatchObject({
        requestedEffort: "max",
        decision: { candidate: "frontier", effort: "max", source: "fallback" },
        apply: { ok: true },
        usage,
      });
      expect((calls.log[0]!.decision as { reasons: string[] }).reasons).not.toContain("effort_clamped");
    });
  }

  test("unknown current model is left unchanged on failure without claiming the default served it", async () => {
    const unknown = { provider: "subscription", id: "custom-model" };
    const { router, calls } = harness(failedJudge, { currentModel: () => unknown, currentThinkingLevel: () => "off" });
    await router.onBeforeAgentStart({ prompt: "hello" });
    await router.onTurnEnd({ model: unknown, usage, toolResults: [] });
    expect(calls.setModel).toEqual([]);
    expect(calls.setThinking).toEqual([]);
    expect(calls.log[0]!.apply).toMatchObject({ ok: false });
    expect(String((calls.log[0]!.apply as { error: string }).error)).toContain("unchanged");
    expect(calls.log[0]!.usage).toBeUndefined();
  });

  test("resume re-seeds the manually selected provider, model and thinking", async () => {
    let current: Ref = { provider: "openrouter", id: "openai/gpt-5.4-mini" };
    const { router, calls } = harness(failedJudge, { currentModel: () => current, currentThinkingLevel: () => "xhigh" });
    current = frontier;
    router.onModelSelect({ model: current, source: "cycle" });
    await router.onBeforeAgentStart({ prompt: "paused" });
    expect(calls.log).toEqual([]);
    router.setEnabled(true);
    await router.onBeforeAgentStart({ prompt: "resumed" });
    await router.onTurnEnd({ model: current, usage, toolResults: [] });
    expect(calls.setModel).toEqual([]);
    expect(calls.setThinking).toEqual([]);
    expect(calls.log[0]!.decision).toMatchObject({ candidate: "frontier", effort: "xhigh" });
  });

  test("Pi provider/model overrides identify the actual current candidate and its usage", async () => {
    const p = minimalPolicy();
    p.candidates.frontier.pi = { provider: "subscription", model: "native-frontier" };
    const native = { provider: "subscription", id: "native-frontier" };
    const { router, calls } = harness(failedJudge, { policy: loadPolicy(p), currentModel: () => native });
    await router.onBeforeAgentStart({ prompt: "hello" });
    await router.onTurnEnd({ model: native, usage, toolResults: [] });
    expect(calls.setModel).toEqual([]);
    expect(calls.log[0]).toMatchObject({ decision: { candidate: "frontier" }, apply: { ok: true }, usage });
  });

  test("off thinking survives a failed judge even with a policy default effort", async () => {
    const p = minimalPolicy();
    p.candidates.frontier.default_effort = "high";
    const { router, calls } = harness(failedJudge, {
      policy: loadPolicy(p),
      currentModel: () => frontier,
      currentThinkingLevel: () => "off",
    });
    await router.onBeforeAgentStart({ prompt: "hello" });
    await router.onTurnEnd({ toolResults: [] });
    expect(calls.setModel).toEqual([]);
    expect(calls.setThinking).toEqual([]);
    expect((calls.log[0]!.decision as { effort?: string }).effort).toBeUndefined();
  });

  for (const level of ["off", "xhigh"] as const) {
    test(`judge fallback preserves actual ${level} thinking across healthy tool continuations`, async () => {
      const p = minimalPolicy();
      p.candidates.frontier.effort = ["medium", "high"];
      p.candidates.frontier.default_effort = "medium";
      let actual: Effort | "off" = level;
      const { router, calls } = harness(failedJudge, {
        policy: loadPolicy(p),
        currentModel: () => frontier,
        currentThinkingLevel: () => actual,
        setThinkingLevel: (next) => {
          actual = next;
        },
      });
      await router.onBeforeAgentStart({ prompt: "continue existing work" });
      for (let i = 0; i < 3; i++) {
        await router.onTurnEnd({ model: frontier, usage, toolResults: [{ toolName: "read", isError: false }] });
        expect(actual).toBe(level);
      }
      await router.onTurnEnd({ model: frontier, usage, toolResults: [] });
      expect(calls.setModel).toEqual([]);
      expect(calls.log.slice(1).every((record) => (record.decision as { source: string }).source === "lease")).toBe(true);
      for (const record of calls.log) {
        expect((record.decision as { effort?: string }).effort).toBe(level === "off" ? undefined : level);
      }
    });
  }

  test("usage belongs to the completed decision, including the final no-tools turn", async () => {
    const { router, calls } = harness(new MockJudge(midAnswers));
    await router.onBeforeAgentStart({ prompt: "refactor" });
    expect(calls.log).toEqual([]);
    await router.onTurnEnd({ model: { provider: "openrouter", id: "anthropic/claude-sonnet-5" }, usage, toolResults: [] });
    expect(calls.log).toHaveLength(1);
    expect(calls.log[0]).toMatchObject({ decision: { candidate: "mid" }, usage });
    await router.onBeforeAgentStart({ prompt: "next" });
    await router.onTurnEnd({ toolResults: [] });
    expect(calls.log).toHaveLength(2);
    expect(calls.log[1]!.usage).toBeUndefined();
  });

  for (const continuation of [false, true]) {
    test(`completed usage feeds cache accounting before the next ${continuation ? "tool continuation" : "user turn"}`, async () => {
      const p = minimalPolicy();
      p.candidates.fast.price = { in: 2.9, out: 14.9 };
      p.policies.default.confidence_threshold = 1;
      let requests = 0;
      const judge = new MockJudge(() => (++requests === 1 ? midAnswers : fastAnswers));
      const { router, calls } = harness(judge, {
        policy: loadPolicy(p),
        currentModel: () => ({ provider: "openrouter", id: "anthropic/claude-sonnet-5" }),
        getContextTokens: () => 100_000,
      });
      await router.onBeforeAgentStart({ prompt: "start" });
      const cached = { ...usage, cacheReadTokens: 100_000 };
      // An error breaks the lease and forces a fresh decision on the continuation.
      const tools = [{ toolName: "read", isError: true, text: "missing" }];
      if (continuation) await router.onTurnEnd({ usage: cached, toolResults: tools });
      else {
        await router.onTurnEnd({ usage: cached, toolResults: [] });
        await router.onBeforeAgentStart({ prompt: "next" });
      }
      await router.onTurnEnd({ toolResults: [] });
      expect(calls.log[0]!.usage).toEqual(cached);
      expect((calls.log[1]!.decision as { cache?: unknown }).cache).toBeDefined();
      expect((calls.log[1]!.decision as { reasons: string[] }).reasons).toContain("cache_penalty_blocked");
    });
  }

  test("usage from another provider is never charged to the proposed decision or its next cache", async () => {
    let requests = 0;
    const judge = new MockJudge(() => (++requests === 1 ? midAnswers : fastAnswers));
    const { router, calls } = harness(judge);
    await router.onBeforeAgentStart({ prompt: "refactor" });
    await router.onTurnEnd({ model: { provider: "other", id: "anthropic/claude-sonnet-5" }, usage, toolResults: [] });
    expect(calls.log[0]!.usage).toBeUndefined();
    await router.onBeforeAgentStart({ prompt: "next" });
    await router.onTurnEnd({ toolResults: [] });
    expect((calls.log[1]!.decision as { cache?: unknown }).cache).toBeUndefined();
    expect(calls.log[1]!.decision).toMatchObject({ candidate: "fast" });
  });

  test("usage stays on the served model when the continuation switches to another candidate", async () => {
    let callsToJudge = 0;
    const { router, calls } = harness(
      new MockJudge(() =>
        ++callsToJudge === 1
          ? midAnswers
          : {
              ...midAnswers,
              difficulty: { type: "score", score: 3.5, probabilities: {}, confidence: 0.95 },
              stakes: { type: "score", score: 2.5, probabilities: {}, confidence: 0.95 },
            },
      ),
    );
    await router.onBeforeAgentStart({ prompt: "refactor" });
    router.onSessionCompact();
    await router.onTurnEnd({ usage, toolResults: [{ toolName: "read", isError: false }] });
    expect(calls.log).toHaveLength(1);
    expect(calls.log[0]).toMatchObject({ decision: { candidate: "mid" }, usage });
    expect(calls.setModel.at(-1)).toEqual(frontier);
    const finalUsage = { inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await router.onTurnEnd({ model: frontier, usage: finalUsage, toolResults: [] });
    expect(calls.log[1]).toMatchObject({ decision: { candidate: "frontier" }, usage: finalUsage });
  });

  test("shutdown flushes an uncompleted decision exactly once without claiming usage", async () => {
    const { router, calls } = harness(new MockJudge(midAnswers));
    await router.onBeforeAgentStart({ prompt: "refactor" });
    await router.onSessionShutdown();
    await router.onSessionShutdown();
    expect(calls.log).toHaveLength(1);
    expect(calls.log[0]!.usage).toBeUndefined();
  });

  test("non-finite usage is omitted instead of entering cache accounting", async () => {
    let requests = 0;
    const { router, calls } = harness(new MockJudge(() => (++requests === 1 ? midAnswers : fastAnswers)));
    await router.onBeforeAgentStart({ prompt: "refactor" });
    await router.onTurnEnd({ usage: { ...usage, cacheReadTokens: Number.NaN }, toolResults: [] });
    await router.onBeforeAgentStart({ prompt: "next" });
    await router.onTurnEnd({ toolResults: [] });
    expect(calls.log[0]!.usage).toBeUndefined();
    expect((calls.log[1]!.decision as { cache?: unknown }).cache).toBeUndefined();
    expect(calls.log[1]!.decision).toMatchObject({ candidate: "fast" });
  });

  test("a manual selection during judging is not overwritten by the in-flight decision", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const judge = new MockJudge(midAnswers);
    const { router, calls } = harness({
      evaluate: async (request) => {
        await gate;
        return judge.evaluate(request);
      },
    });
    const routing = router.onBeforeAgentStart({ prompt: "refactor" });
    await Promise.resolve();
    router.onModelSelect({ model: frontier, source: "set" });
    release();
    await routing;
    await router.onTurnEnd({ model: frontier, usage, toolResults: [] });
    expect(calls.setModel).toEqual([]);
    expect(calls.log[0]!.apply).toMatchObject({ ok: false });
    expect(calls.log[0]!.usage).toBeUndefined();
    expect(router.statusText()).toContain("paused");
  });

  test("a rejected proposal does not acquire the actual model's usage", async () => {
    const { router, calls } = harness(new MockJudge(midAnswers), { setModel: async () => false });
    await router.onBeforeAgentStart({ prompt: "refactor" });
    await router.onTurnEnd({ model: { provider: "openrouter", id: "openai/gpt-5.4-mini" }, usage, toolResults: [] });
    expect(calls.log[0]!.apply).toMatchObject({ ok: false });
    expect(calls.log[0]!.usage).toBeUndefined();
  });

  test("images remain capability constraints through continuations, new text turns and compaction", async () => {
    const p = minimalPolicy();
    p.candidates.fast.capabilities = { vision: false };
    const { router, calls } = harness(undefined, { policy: loadPolicy(p) });
    await router.onBeforeAgentStart({ prompt: "inspect", images: [{}] });
    await router.onTurnEnd({ toolResults: [{ toolName: "read", isError: false }] });
    await router.onTurnEnd({ toolResults: [] });
    await router.onBeforeAgentStart({ prompt: "what else?" });
    await router.onTurnEnd({ toolResults: [] });
    router.onSessionCompact();
    await router.onBeforeAgentStart({ prompt: "continue" });
    await router.onTurnEnd({ toolResults: [] });
    expect(calls.log).toHaveLength(4);
    expect(calls.log.every((r) => r.hasImages === true)).toBe(true);
    expect(calls.log.every((r) => (r.decision as { candidate: string }).candidate !== "fast")).toBe(true);
    router.onSessionStart("new");
    await router.onBeforeAgentStart({ prompt: "fresh text" });
    await router.onTurnEnd({ toolResults: [] });
    expect(calls.log.at(-1)!.hasImages).toBeUndefined();
  });

  test("images returned by tools constrain the next continuation", async () => {
    const p = minimalPolicy();
    p.candidates.fast.capabilities = { vision: false };
    const { router, calls } = harness(new MockJudge(fastAnswers), { policy: loadPolicy(p) });
    await router.onBeforeAgentStart({ prompt: "read the screenshot" });
    await router.onTurnEnd({ hasImages: true, toolResults: [{ toolName: "read", isError: false }] });
    await router.onTurnEnd({ toolResults: [] });
    expect(calls.log[0]!.hasImages).toBeUndefined();
    expect(calls.log[1]!.hasImages).toBe(true);
    expect((calls.log[1]!.decision as { candidate: string }).candidate).not.toBe("fast");
  });
});

describe("pi router", () => {
  test("new user turn asks the judge and switches the model", async () => {
    const judge = new MockJudge(midAnswers);
    const { router, calls } = harness(judge);
    await router.onBeforeAgentStart({ prompt: "refactor the payment module", images: [] });
    await router.onTurnEnd({ toolResults: [] });
    expect(judge.requests).toHaveLength(1);
    expect(Object.keys(judge.requests[0]!.questions)).toContain("difficulty");
    expect(calls.setModel).toEqual([{ provider: "openrouter", id: "anthropic/claude-sonnet-5" }]);
    expect(calls.status.at(-1)).toContain("mid");
    expect(calls.log).toHaveLength(1);
    expect(calls.log[0]!.decision).toMatchObject({ candidate: "mid", source: "judge" });
  });

  test("a clean tool continuation reuses the lease without judge or switch", async () => {
    const judge = new MockJudge(midAnswers);
    const { router, calls } = harness(judge);
    await router.onBeforeAgentStart({ prompt: "refactor the payment module", images: [] });
    await router.onTurnEnd({ assistantText: "I will edit the file", toolResults: [{ toolName: "edit", isError: false, text: "ok" }] });
    await router.onTurnEnd({ toolResults: [] });
    expect(judge.requests).toHaveLength(1);
    expect(calls.setModel).toHaveLength(1);
    expect(calls.log.at(-1)!.decision).toMatchObject({ source: "lease" });
  });

  test("judge failure falls open and never throws", async () => {
    const failing: Judge = {
      evaluate: async () => {
        throw new Error("boom");
      },
    };
    const { router, calls } = harness(failing);
    await router.onBeforeAgentStart({ prompt: "hello", images: [] });
    await router.onTurnEnd({ toolResults: [] });
    expect(calls.setModel).toHaveLength(0);
    expect(calls.log[0]!.decision).toMatchObject({ candidate: "fast", source: "fallback" });
    expect(calls.log[0]!.judge).toMatchObject({ error: "boom" });
  });

  test("without a judge the router still applies deterministic decisions", async () => {
    const { router, calls } = harness(undefined);
    await router.onBeforeAgentStart({ prompt: "hello", images: [] });
    await router.onTurnEnd({ toolResults: [] });
    expect(calls.log[0]!.decision).toMatchObject({ candidate: "fast", source: "fallback" });
  });

  test("manual model selection pauses routing until resumed", async () => {
    const judge = new MockJudge(midAnswers);
    const { router, calls } = harness(judge);
    router.onModelSelect({ model: { provider: "openrouter", id: "openai/gpt-6-astra" }, source: "set" });
    await router.onBeforeAgentStart({ prompt: "refactor", images: [] });
    expect(judge.requests).toHaveLength(0);
    expect(calls.setModel).toHaveLength(0);
    expect(router.statusText()).toContain("paused");
    router.setEnabled(true);
    await router.onBeforeAgentStart({ prompt: "refactor", images: [] });
    expect(judge.requests).toHaveLength(1);
  });

  test("its own switches do not count as manual overrides", async () => {
    const judge = new MockJudge(midAnswers);
    let router!: PiRouter<Ref>;
    const h = harness(judge, {
      setModel: async (m) => {
        router.onModelSelect({ model: m, source: "set" });
        return true;
      },
    });
    router = h.router;
    await router.onBeforeAgentStart({ prompt: "refactor", images: [] });
    expect(router.statusText()).not.toContain("paused");
  });

  test("applies effort through the thinking level", async () => {
    const judge = new MockJudge({
      ...midAnswers,
      stakes: { type: "score", score: 2.5, probabilities: {}, confidence: 0.9 },
      difficulty: { type: "score", score: 3.5, probabilities: {}, confidence: 0.9 },
    });
    const { router, calls } = harness(judge);
    await router.onBeforeAgentStart({ prompt: "migrate the auth schema", images: [] });
    expect(calls.setModel.at(-1)).toEqual({ provider: "openrouter", id: "openai/gpt-6-astra" });
    expect(calls.setThinking).toEqual(["high"]);
  });

  test("compaction rejudges the current task without automatically escalating", async () => {
    const judge = new MockJudge(midAnswers);
    const { router, calls } = harness(judge);
    await router.onBeforeAgentStart({ prompt: "start", images: [] });
    router.onSessionCompact();
    await router.onTurnEnd({ assistantText: "continuing", toolResults: [{ toolName: "read", isError: false, text: "..." }] });
    await router.onTurnEnd({ toolResults: [] });
    expect(calls.log.at(-1)!.decision).toMatchObject({ source: "judge", candidate: "mid" });
    expect(judge.requests).toHaveLength(2);
  });

  test("a rejected model switch is logged, reported, and leaves session state uncommitted", async () => {
    const judge = new MockJudge(midAnswers);
    const { router, calls } = harness(judge, {
      setModel: async () => {
        throw new Error("provider exploded");
      },
    });
    await router.onBeforeAgentStart({ prompt: "refactor", images: [] });
    await router.onBeforeAgentStart({ prompt: "refactor again", images: [] });
    await router.onTurnEnd({ toolResults: [] });
    expect(calls.log).toHaveLength(2);
    expect(calls.log[0]!.apply).toMatchObject({ ok: false });
    expect(String((calls.log[0]!.apply as { error?: string }).error)).toContain("provider exploded");
    expect(calls.log.map((r) => r.turn)).toEqual([0, 0]);
    expect(calls.notify.some((m) => m.includes("provider exploded"))).toBe(true);
  });

  test("a compaction reported in flight is still consumed by the next reevaluation", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: Judge = {
      evaluate: async () => {
        await gate;
        return { model: "m", answers: midAnswers, usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0 };
      },
    };
    const { router, calls } = harness(slow);
    const first = router.onBeforeAgentStart({ prompt: "start", images: [] });
    router.onSessionCompact();
    release?.();
    await first;
    await router.onTurnEnd({ toolResults: [{ toolName: "read", isError: false, text: "..." }] });
    await router.onTurnEnd({ toolResults: [] });
    expect(calls.log.at(-1)!.decision).toMatchObject({ source: "judge", candidate: "mid" });
  });

  test("resume uses existing task purpose and latest phase even for a continue-only prompt", async () => {
    const judge = new MockJudge(midAnswers);
    const { router } = harness(judge);
    router.onSessionStart(
      "resume",
      "Goal: Diagnose the existing parser failure\nPhase: investigation\nDone: regression passes",
      "Phase: implementation\nNext action: Apply the confirmed fix",
    );
    await router.onBeforeAgentStart({ prompt: "続けて" });
    expect((judge.requests[0]?.state as Dossier | undefined)?.work).toMatchObject({
      goal: "Diagnose the existing parser failure",
      phase: "implementation",
    });
  });

  test("a new task may apply the configured baseline on judge failure instead of retaining old frontier/high", async () => {
    let current: Ref = frontier;
    let effort: Effort = "high";
    const raw = minimalPolicy();
    raw.candidates.fast.effort = ["low", "medium", "high"];
    raw.candidates.fast.default_effort = "medium";
    const { router } = harness(new MockJudge({}), {
      policy: loadPolicy(raw),
      currentModel: () => current,
      currentThinkingLevel: () => effort,
      setModel: async (m) => {
        current = m;
        return true;
      },
      setThinkingLevel: (level) => {
        effort = level;
      },
    });
    await router.onBeforeAgentStart({ prompt: "Task: ROUTE-G1-T2\nGoal: Apply a confirmed local change\nPhase: implementation" });
    expect(current.id).toBe("openai/gpt-5.4-mini");
    expect(String(effort)).toBe("medium");
  });

  test("zero context tokens fall back to a character estimate", async () => {
    const { router, calls } = harness(undefined, { getContextTokens: () => 0 });
    await router.onBeforeAgentStart({ prompt: "x".repeat(400), images: [] });
    await router.onTurnEnd({ toolResults: [] });
    expect(calls.log[0]!.estimatedInputTokens).toBeGreaterThanOrEqual(100);
  });

  test("an unresolvable model is reported once and does not switch", async () => {
    const judge = new MockJudge(midAnswers);
    const { router, calls } = harness(judge, { findModel: () => undefined });
    await router.onBeforeAgentStart({ prompt: "refactor", images: [] });
    await router.onBeforeAgentStart({ prompt: "refactor again", images: [] });
    await router.onTurnEnd({ toolResults: [] });
    expect(calls.setModel).toHaveLength(0);
    expect(calls.notify.filter((m) => m.includes("not found"))).toHaveLength(1);
    expect(calls.log).toHaveLength(2);
  });
});
