import { describe, expect, test } from "bun:test";
import type { Decision } from "../../src/core/types";
import { anthropicDialect } from "../../src/daemon/dialects/anthropic";

const decision: Decision = {
  candidate: "opus",
  model: "claude-opus-5-5",
  effort: "high",
  source: "judge",
  reasons: [],
  counterfactuals: {},
  lease: "tool_chain",
};
const setting = (effort: string) => ({
  role: "system",
  content: [{ type: "text", text: "runtime instruction" }],
  output_config: { effort },
});

describe("native per-turn effort selection", () => {
  test("selected effort reaches the current runtime setting and leaves history untouched", () => {
    const history = [{ role: "user", content: "earlier" }, setting("low"), { role: "assistant", content: "earlier answer" }];
    const body = {
      model: "claude-code/auto",
      output_config: { effort: "medium" },
      messages: [...history, { role: "user", content: "new task" }, setting("medium")],
    };
    const original = JSON.stringify(body);
    const rewritten = anthropicDialect.rewrite(body, decision);
    const messages = rewritten.messages as typeof body.messages;
    expect(messages[1]).toBe(history[1]);
    expect(messages[4]).toEqual(setting("high"));
    expect(rewritten.output_config).toBe(body.output_config);
    expect(anthropicDialect.normalize({ ...body, output_config: { effort: "low" } }).requestedEffort).toBe("medium");
    expect(JSON.stringify(body)).toBe(original);
    expect(anthropicDialect.normalize(body).requestedEffort).toBe("medium");
  });

  test("a healthy tool continuation uses the same current-turn effort", () => {
    const body = {
      model: "claude-code/auto",
      messages: [
        { role: "user", content: "task" },
        setting("medium"),
        { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Read" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] },
      ],
    };
    const out = anthropicDialect.rewrite(body, decision);
    expect((out.messages as { output_config?: { effort: string } }[])[1]?.output_config?.effort).toBe("high");
    expect(anthropicDialect.normalize(body).isNewUserTurn).toBe(false);
  });

  test("a previous turn's effort is not rewritten when this turn has no runtime setting", () => {
    const body = {
      model: "claude-code/auto",
      messages: [
        { role: "user", content: "earlier" },
        setting("low"),
        { role: "assistant", content: "done" },
        { role: "user", content: "new task" },
      ],
    };
    expect(anthropicDialect.rewrite(body, decision).messages).toBe(body.messages);
  });

  test("unknown model capabilities do not introduce per-message output settings", () => {
    const body = { model: "auto", messages: [{ role: "user", content: "task" }, setting("medium")] };
    expect(anthropicDialect.rewrite(body, { ...decision, model: "unknown-model" }).messages).toBe(body.messages);
  });
});

describe("Haiku 5.5 disabled thinking with per-turn effort", () => {
  test("changing the per-turn effort enables adaptive thinking instead of sending an invalid combination", () => {
    const body = {
      model: "claude-code/auto",
      thinking: { type: "disabled" },
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: "task" }, setting("medium")],
    };
    const out = anthropicDialect.rewrite(body, { ...decision, model: "claude-haiku-5-5", effort: "low" });
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toBe(body.output_config);
    expect(body.thinking).toEqual({ type: "disabled" });
  });
  test("unchanged effort does not enable disabled thinking unnecessarily", () => {
    const body = {
      model: "claude-code/auto",
      thinking: { type: "disabled" },
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: "task" }, setting("medium")],
    };
    expect(anthropicDialect.rewrite(body, { ...decision, model: "claude-haiku-5-5", effort: "medium" }).thinking).toBe(body.thinking);
  });
});
