import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardHook } from "../../src/cli/main";
import { runSetup } from "../../src/cli/setup";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("runSetup", () => {
  test("dry run writes nothing; a real run writes files and backs up on the second pass", async () => {
    const home = await mkdtemp(join(tmpdir(), "jev-home-"));
    const routerHome = await mkdtemp(join(tmpdir(), "jev-router-home-"));
    const previous = process.env.JEV_ROUTER_HOME;
    process.env.JEV_ROUTER_HOME = routerHome;
    try {
      const lines: string[] = [];
      const base = {
        agents: ["claude-code", "codex", "opencode"] as const,
        baseUrl: "http://127.0.0.1:4141",
        hookCommand: "/bin/jev-router",
        home,
        env: { JEV_ROUTER_HOME: routerHome },
        log: (l: string) => lines.push(l),
      };

      await runSetup({ ...base, dryRun: true });
      expect(await exists(join(home, ".claude", "settings.json"))).toBe(false);
      expect(lines.some((l) => l.includes("would write"))).toBe(true);

      await runSetup({ ...base, dryRun: false });
      const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8")) as { env: Record<string, string> };
      expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4141");
      expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toContain("[model_providers.jev-router]");
      expect(await exists(join(home, ".codex", "hooks.json"))).toBe(true);

      await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ env: { FOO: "bar" } }));
      await runSetup({ ...base, dryRun: false, token: "t0k" });
      expect(await exists(join(home, ".claude", "settings.json.bak"))).toBe(true);
      const merged = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8")) as { env: Record<string, string> };
      expect(merged.env.FOO).toBe("bar");
      expect(merged.env.ANTHROPIC_AUTH_TOKEN).toBe("t0k");
    } finally {
      if (previous === undefined) delete process.env.JEV_ROUTER_HOME;
      else process.env.JEV_ROUTER_HOME = previous;
    }
  });

  test("selected Claude config directory is backed up and merged without changing the default account", async () => {
    const home = await mkdtemp(join(tmpdir(), "jev-claude-config-"));
    try {
      const configDir = join(home, ".claude-sub");
      const defaultDir = join(home, ".claude");
      await mkdir(configDir);
      await mkdir(defaultDir);
      const defaultSettings = '{"env":{"KEEP":"default"}}\n';
      await writeFile(join(defaultDir, "settings.json"), defaultSettings);
      const existing = {
        env: { KEEP: "sub", ANTHROPIC_AUTH_TOKEN: "mock-existing-login" },
        hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "rtk hook" }] }] },
        modelPicker: { custom: true, options: [{ model: "claude-sonnet-5", label: "mine" }] },
        statusLine: { type: "command", command: "my-status" },
        permissions: { allow: ["Read"] },
      };
      const original = JSON.stringify(existing);
      const account = '{"oauthAccount":{"organizationType":"claude_max"}}\n';
      await writeFile(join(configDir, "settings.json"), original);
      await writeFile(join(configDir, ".claude.json"), account);
      const lines: string[] = [];
      const opts = {
        agents: ["claude-code"] as const,
        baseUrl: "http://127.0.0.1:5151",
        hookCommand: "jev-router",
        auth: { claudeCode: "subscription" as const },
        behavesAs: "claude-sonnet-5",
        home,
        env: { CLAUDE_CONFIG_DIR: configDir, JEV_ROUTER_HOME: join(home, "router") },
        log: (line: string) => lines.push(line),
      };
      await runSetup({ ...opts, dryRun: true });
      expect(lines.join("\n")).toContain(join(configDir, "settings.json"));
      expect(await readFile(join(configDir, "settings.json"), "utf8")).toBe(original);
      expect(await exists(join(configDir, "settings.json.bak"))).toBe(false);
      await runSetup({ ...opts, dryRun: false });
      const merged = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"));
      expect(merged.env).toMatchObject({ KEEP: "sub", ANTHROPIC_AUTH_TOKEN: "mock-existing-login", ANTHROPIC_BASE_URL: opts.baseUrl });
      expect(merged.hooks.PostToolUse).toContainEqual(existing.hooks.PostToolUse[0]);
      expect(merged.modelPicker).toMatchObject({ custom: true });
      expect(merged.modelPicker.options).toContainEqual(existing.modelPicker.options[0]);
      expect(merged.permissions).toEqual(existing.permissions);
      expect(merged.statusLine).toEqual(existing.statusLine);
      expect(await readFile(join(configDir, "settings.json.bak"), "utf8")).toBe(original);
      expect(await readFile(join(configDir, ".claude.json"), "utf8")).toBe(account);
      expect(await readFile(join(defaultDir, "settings.json"), "utf8")).toBe(defaultSettings);
      const first = await readFile(join(configDir, "settings.json"), "utf8");
      await runSetup({ ...opts, dryRun: false });
      expect(JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"))).toEqual(merged);
      // The existing subscription planner moves preserved auth keys on the second pass; values stay intact.
      const second = await readFile(join(configDir, "settings.json"), "utf8");
      await runSetup({ ...opts, dryRun: false });
      expect(await readFile(join(configDir, "settings.json"), "utf8")).toBe(second);
      expect(await readFile(join(configDir, "settings.json.bak"), "utf8")).toBe(first);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("Pi setup prints the scoped install command without installing anything", async () => {
    const home = await mkdtemp(join(tmpdir(), "jev-pi-setup-"));
    try {
      const lines: string[] = [];
      await runSetup({
        agents: ["pi"],
        baseUrl: "http://127.0.0.1:4141",
        hookCommand: "jev-router",
        home,
        env: { JEV_ROUTER_HOME: join(home, "router") },
        dryRun: false,
        log: (line) => lines.push(line),
      });
      expect(lines.join("\n")).toContain("pi install npm:@french-castle/jev-router");
      expect(lines.join("\n")).toContain("not installed automatically");
      expect(await readdir(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("runSetup for Cursor", () => {
  test("prints the tunnel, key, and model steps and writes nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "jev-home-"));
    const routerHome = await mkdtemp(join(tmpdir(), "jev-router-home-"));
    const previous = process.env.JEV_ROUTER_HOME;
    process.env.JEV_ROUTER_HOME = routerHome;
    try {
      const lines: string[] = [];
      await runSetup({
        agents: ["cursor"],
        baseUrl: "http://127.0.0.1:5000",
        hookCommand: "/bin/jev-router",
        home,
        dryRun: false,
        log: (l) => lines.push(l),
      });
      const text = lines.join("\n");
      expect(text).toContain("cursor:");
      expect(text).toContain("jev-router up --port 5001 --token");
      expect(text).toContain("jev-router expose --port 5001");
      expect(text).toContain("jev-router/auto");
      expect(await exists(join(home, ".cursor"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.JEV_ROUTER_HOME;
      else process.env.JEV_ROUTER_HOME = previous;
    }
  });
});

describe("forwardHook", () => {
  test("posts the payload with the token and always returns an empty hook result", async () => {
    let seen: { url: string; auth: string | null; body: string } | undefined;
    const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(url), auth: new Headers(init?.headers).get("authorization"), body: String(init?.body) };
      return new Response("{}", { status: 200 });
    };
    expect(await forwardHook("codex", '{"a":1}', { port: "9", token: "tok", fetch: fetchImpl })).toBe("{}");
    expect(seen).toEqual({ url: "http://127.0.0.1:9/hooks/codex", auth: "Bearer tok", body: '{"a":1}' });
    const warnings: string[] = [];
    const down = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await forwardHook("claude-code", "", { port: "9", fetch: down, warn: (m) => warnings.push(m) })).toBe("{}");
    expect(warnings).toHaveLength(1);
  });
});
