import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initPolicy } from "../../src/runtime/init";
import { detectSubscriptions } from "../../src/runtime/subscriptions";

describe("Claude subscription config directory", () => {
  test.each([undefined, "", ".claude-sub"])("selects plan metadata for CLAUDE_CONFIG_DIR=%s", async (override) => {
    const home = join(process.cwd(), "mock-home");
    const configDir = override ? join(home, override) : undefined;
    const accountPath = join(configDir ?? home, ".claude.json");
    const asked: string[] = [];
    const detected = await detectSubscriptions({
      home,
      env: configDir === undefined ? { CLAUDE_CONFIG_DIR: override } : { CLAUDE_CONFIG_DIR: configDir },
      readFile: async (path) => {
        asked.push(path);
        if (path === accountPath) return JSON.stringify({ oauthAccount: { organizationType: configDir ? "claude_max" : "claude_pro" } });
        throw new Error("ENOENT");
      },
    });
    expect(detected.anthropic).toEqual({ plan: configDir ? "max" : "pro" });
    expect(asked).toEqual([accountPath, join(home, ".codex", "auth.json"), join(home, ".gemini", "settings.json")]);
    expect(asked.some((path) => path.includes("credentials"))).toBe(false);
  });

  test("an absent selected account never falls back to another account's default metadata", async () => {
    const home = join(process.cwd(), "mock-home");
    const asked: string[] = [];
    const detected = await detectSubscriptions({
      home,
      env: { CLAUDE_CONFIG_DIR: join(home, ".claude-sub") },
      readFile: async (path) => {
        asked.push(path);
        if (path === join(home, ".claude.json")) return JSON.stringify({ oauthAccount: { organizationType: "claude_pro" } });
        throw new Error("ENOENT");
      },
    });
    expect(detected).toEqual({});
    expect(asked).not.toContain(join(home, ".claude.json"));
  });

  test("initPolicy forwards its injected config-directory selection to subscription detection", async () => {
    const home = await mkdtemp(join(tmpdir(), "jev-selected-plan-"));
    try {
      const configDir = join(home, ".claude-sub");
      const asked: string[] = [];
      const result = await initPolicy({
        path: join(home, "policy.json"),
        home,
        env: { CLAUDE_CONFIG_DIR: configDir },
        fetch: null,
        ollama: false,
        readFile: async (path) => {
          asked.push(path);
          if (path === join(configDir, ".claude.json")) return '{"oauthAccount":{"organizationType":"claude_max"}}';
          if (path === join(home, ".claude.json")) return '{"oauthAccount":{"organizationType":"claude_pro"}}';
          throw new Error("ENOENT");
        },
      });
      expect(result.subscriptions?.anthropic?.plan).toBe("max");
      expect(result.policy.candidates["claude-haiku"]?.effort).toEqual([]);
      expect(asked).not.toContain(join(home, ".claude.json"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
