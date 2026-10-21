import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy } from "../../src/core/policy";
import { minimalPolicy } from "../fixtures/policies";

test("policy migration backs up originals, keeps native providers and unrelated settings, and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-task-policy-"));
  const agent = join(root, "agent");
  await mkdir(agent);
  const fixture = minimalPolicy();
  const raw = {
    ...fixture,
    candidates: {
      "claude-haiku": fixture.candidates.fast,
      "claude-sonnet": fixture.candidates.mid,
      "claude-opus": { ...fixture.candidates.frontier, model: "claude-opus-5-5" },
      "pi-luna": { ...fixture.candidates.fast, model: "gpt-6-luna", pi: { provider: "native-test", model: "gpt-6-luna" } },
      "pi-sol": { ...fixture.candidates.mid, model: "gpt-6.1-sol", pi: { provider: "native-test", model: "gpt-6.1-sol" } },
    },
    routes: [],
    policies: {
      claude: { default: "claude-opus", order: ["claude-haiku", "claude-sonnet", "claude-opus"], rules: [] },
      pi: { default: "pi-sol", order: ["pi-luna", "pi-sol"], rules: [] },
    },
  };
  const settings = {
    defaultProvider: "native-test",
    defaultModel: "gpt-6.1-sol",
    defaultThinkingLevel: "high",
    enabledModels: ["native-test/gpt-6-luna", "native-test/gpt-6.1-sol", "native-test/gpt-6-astra"],
    theme: "unchanged",
    packages: ["unchanged"],
  };
  const policyText = JSON.stringify(raw),
    settingsText = JSON.stringify(settings);
  await writeFile(join(root, "policy.json"), policyText);
  await writeFile(join(agent, "settings.json"), settingsText);
  const run = () =>
    spawnSync("node", ["scripts/apply-task-aware-policy.cjs"], {
      env: { ...process.env, JEV_ROUTER_HOME: root, PI_CODING_AGENT_DIR: agent },
      encoding: "utf8",
    });
  const first = run();
  expect(first.status).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({ policyChanged: true, settingsChanged: true });
  const changed = JSON.parse(await readFile(join(root, "policy.json"), "utf8"));
  expect(() => loadPolicy(changed)).not.toThrow();
  expect(changed.policies.claude.default).toBe("claude-sonnet");
  expect(changed.candidates["pi-sol"].pi.provider).toBe("native-test");
  expect(changed.judge).toEqual(raw.judge);
  const after = JSON.parse(await readFile(join(agent, "settings.json"), "utf8"));
  expect(after).toMatchObject({
    defaultProvider: "native-test",
    defaultThinkingLevel: "medium",
    theme: "unchanged",
    packages: ["unchanged"],
  });
  expect(after.enabledModels).not.toContain("native-test/gpt-6-astra");
  const backup = (await readdir(root)).find((f) => f.startsWith("policy.json.bak-task-aware-"));
  expect(await readFile(join(root, backup!), "utf8")).toBe(policyText);
  const second = run();
  expect(second.status).toBe(0);
  expect(JSON.parse(second.stdout)).toMatchObject({ policyChanged: false, settingsChanged: false });
});
