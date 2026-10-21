import { expect, test } from "bun:test";
import { anthropicDialect } from "../../src/daemon/dialects/anthropic";

test("cold relay recovery keeps task purpose after a phase-only instruction and continue", () => {
  const body = {
    model: "auto",
    messages: [
      {
        role: "user",
        content:
          "Task: ROUTE-G1-T1\nGoal: Diagnose the parser hang\nPhase: investigation\nDone: causal regression passes\nTargets: src/parser.ts",
      },
      { role: "assistant", content: "Phase: investigation\nNext action: isolate the cause" },
      { role: "user", content: "Phase: implementation\nNext action: Apply the confirmed local fix" },
      { role: "assistant", content: "The cause is resolved and the patch is now confirmed." },
      { role: "user", content: "続けて" },
    ],
  };
  const r = anthropicDialect.normalize(body);
  expect(r.taskText).toContain("Diagnose the parser hang");
  expect(r.taskText).toContain("implementation");
  expect(r.taskText).toContain("causal regression passes");
});

test("continue recovers the latest real task from existing Claude history without rewriting the request", () => {
  const body = {
    model: "auto",
    messages: [
      {
        role: "user",
        content:
          "Goal: Implement the confirmed config rename\nPhase: implementation\nDone: the regression test passes\nTargets: src/config.ts",
      },
      { role: "assistant", content: "Phase: validation\nNext action: run the regression test" },
      { role: "user", content: "続けて" },
    ],
  };
  const original = JSON.stringify(body);
  const result = anthropicDialect.normalize(body);
  expect(result.taskText).toContain("confirmed config rename");
  expect(result.lastUserText).toBe("続けて");
  expect(result.assistantIntentTail).toContain("Phase: validation");
  expect(JSON.stringify(body)).toBe(original);
});
