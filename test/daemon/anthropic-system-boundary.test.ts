import { describe, expect, test } from "bun:test";
import { anthropicDialect } from "../../src/daemon/dialects/anthropic";

const system = { role: "system", content: [{ type: "text", text: "runtime settings" }], output_config: { effort: "medium" } };

describe("Claude runtime system messages do not change conversation boundaries", () => {
  test("a user prompt followed by a runtime system message is still a new user turn", () => {
    const body = { model: "claude-code/auto", messages: [{ role: "user", content: "Reply OK" }, system] };
    const before = JSON.stringify(body);
    const normalized = anthropicDialect.normalize(body);
    expect(normalized.isNewUserTurn).toBe(true);
    expect(normalized.lastUserText).toBe("Reply OK");
    expect(normalized.toolOutcomes).toEqual([]);
    expect(JSON.stringify(body)).toBe(before);
  });

  test("a tool result followed by a runtime system message remains a continuation", () => {
    const body = {
      model: "claude-code/auto",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "file contents" }] },
        system,
      ],
    };
    const normalized = anthropicDialect.normalize(body);
    expect(normalized.isNewUserTurn).toBe(false);
    expect(normalized.toolOutcomes).toEqual([{ name: "Read", isError: false, excerpt: "file contents" }]);
  });

  test("assistant history followed by a system message is not a new user turn", () => {
    const normalized = anthropicDialect.normalize({
      model: "claude-code/auto",
      messages: [{ role: "user", content: "Earlier task" }, { role: "assistant", content: "Earlier answer" }, system],
    });
    expect(normalized.isNewUserTurn).toBe(false);
  });

  test("runtime-only input does not manufacture a user turn", () => {
    const normalized = anthropicDialect.normalize({ model: "claude-code/auto", messages: [system] });
    expect(normalized.isNewUserTurn).toBe(false);
    expect(normalized.toolOutcomes).toEqual([]);
  });
});
