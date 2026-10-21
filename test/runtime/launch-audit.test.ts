import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionRecord } from "../../src/core/record";
import { upstreamHeaders } from "../../src/daemon/http-util";
import * as runtime from "../../src/runtime/index";

const launchId = "11111111-1111-4111-8111-111111111111";
const record: DecisionRecord = {
  id: "decision",
  ts: 1792584000000,
  session: "cc:test",
  harness: "claude-code",
  turn: 0,
  isNewUserTurn: true,
  estimatedInputTokens: 100,
  apply: { ok: true },
  judge: { questions: ["difficulty"], answers: { difficulty: { type: "score", score: 2, probabilities: {}, confidence: 1 } } },
  decision: {
    candidate: "mid",
    model: "claude-sonnet-5",
    effort: "medium",
    source: "judge",
    reasons: ["rule:1"],
    lease: "tool_chain",
    counterfactuals: {},
  },
};

test("first successful main decision records actual model once, not auto or failed/auxiliary choices", async () => {
  // Missing/duplicate selection recording or spreading raw metadata would break this test.
  expect("recordLaunchSelection" in runtime).toBe(true);
  const { recordLaunchSelection } = runtime;
  const home = await mkdtemp(join(tmpdir(), "jev-launch-audit-"));
  const dir = join(home, "orca-launch", "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `launch-${launchId}.json`),
    JSON.stringify({
      at: "2026-10-21T12:00:00.000Z",
      host: "test-host",
      cwd: "/work/project",
      terminal: "term_test",
      terminalName: "worker",
      kind: "claude",
      policyHash: "a".repeat(64),
      candidates: [{ id: "mid", model: "claude-sonnet-5" }],
      token: "MOCK_SECRET_DO_NOT_LOG",
    }),
  );
  const r = { ...record, launchId };
  await recordLaunchSelection({ ...r, apply: { ok: false } }, home);
  await recordLaunchSelection({ ...r, requestClass: "auxiliary" }, home);
  await Promise.all([recordLaunchSelection(r, home), recordLaunchSelection(r, home)]);
  await recordLaunchSelection({ ...r, decision: { ...r.decision, model: "later-model" } }, home);
  const files = await readdir(join(home, "orca-launch", "selections"));
  expect(files).toEqual([`${launchId}.jsonl`]);
  const text = await readFile(join(home, "orca-launch", "selections", files[0]!), "utf8");
  expect(text.trim().split("\n")).toHaveLength(1);
  expect(text).not.toContain("MOCK_SECRET");
  expect(JSON.parse(text)).toMatchObject({
    host: "test-host",
    cwd: "/work/project",
    terminalName: "worker",
    kind: "claude",
    model: "claude-sonnet-5",
    effort: "medium",
    weight: { difficulty: 2, stakes: null },
    policyHash: "a".repeat(64),
    reasons: ["rule:1"],
  });
  await recordLaunchSelection({ ...r, launchId: "../../escape" }, home);
  const query = spawnSync("node", ["scripts/recent-launch-selections.cjs"], {
    env: { ...process.env, JEV_ROUTER_HOME: home },
    encoding: "utf8",
  });
  expect(query.status).toBe(0);
  expect(JSON.parse(query.stdout).model).toBe("claude-sonnet-5");
});

test("launch snapshot contains only candidate identifiers and the exact policy hash", async () => {
  expect("prepareLaunchAudit" in runtime).toBe(true);
  const home = await mkdtemp(join(tmpdir(), "jev-launch-context-"));
  const policy = {
    routes: [{ harness: "pi", policy: "pi" }],
    policies: { pi: { order: ["fast"] } },
    candidates: { fast: { model: "gpt-6-luna", api_key: "MOCK_SECRET" }, other: { model: "unused" } },
  };
  await writeFile(join(home, "policy.json"), JSON.stringify(policy));
  const id = await runtime.prepareLaunchAudit("pi", { JEV_ROUTER_HOME: home, ORCA_TERMINAL_HANDLE: "term_test", API_KEY: "MOCK_SECRET" });
  const text = await readFile(join(home, "orca-launch", "sessions", `launch-${id}.json`), "utf8");
  expect(text).not.toContain("MOCK_SECRET");
  const context = JSON.parse(text);
  expect(context.candidates).toEqual([{ id: "fast", model: "gpt-6-luna" }]);
  expect(context.policyHash).toBe(createHash("sha256").update(JSON.stringify(policy)).digest("hex"));
  expect(context.terminal).toBe("term_test");
});

test("private launch correlation header never leaves the relay, native authentication remains untouched", () => {
  const headers = upstreamHeaders(
    { "x-jev-router-launch-id": launchId, authorization: "MOCK_AUTH", "x-claude-code-session-id": "test" },
    { forwardAuth: true, dialect: "anthropic" },
  );
  expect(headers["x-jev-router-launch-id"]).toBeUndefined();
  expect(headers.authorization).toBe("MOCK_AUTH");
});
