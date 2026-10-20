import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { minimalPolicy } from "../fixtures/policies";

// Run the real extension in an isolated process: only fake configuration and a mocked fetch are visible.
for (const mode of ["file", "process", "empty", "invalid"] as const) {
  test(`Pi boot loads the configured home env with process precedence (${mode})`, async () => {
    const home = await mkdtemp(join(tmpdir(), "jev-pi-boot-"));
    try {
      const p = minimalPolicy();
      p.judge = { transport: "typesafe", api_key_env: "PI_BOOT_FAKE_KEY", on_error: "fail_open" };
      await writeFile(join(home, "policy.json"), JSON.stringify(p));
      await writeFile(join(home, "env"), "PI_BOOT_FAKE_KEY=fake-file-key\nPI_BOOT_LOCAL_ONLY=fake-local-value\n");
      const entry = pathToFileURL(join(import.meta.dir, "../../src/adapters/pi/index.ts")).href;
      const script = `
        import assert from "node:assert/strict";
        import { readFile } from "node:fs/promises";
        import { join } from "node:path";
        import extension from ${JSON.stringify(entry)};
        const before = JSON.stringify(process.env);
        const handlers = new Map();
        const warnings = [];
        const statuses = [];
        const switches = [];
        const thinking = [];
        let current = { provider: "openrouter", id: "openai/gpt-6-astra" };
        let fetches = 0;
        globalThis.fetch = async (_input, init) => {
          fetches++;
          assert.equal(new Headers(init.headers).get("authorization"), ${JSON.stringify(mode === "process" ? "Bearer fake-process-key" : "Bearer fake-file-key")});
          const questions = JSON.parse(init.body).questions;
          const answers = Object.fromEntries(Object.entries(questions).map(([key, q]) => [key,
            q.type === "noul" ? { type: "noul", noul: 0 } :
            q.type === "choice" ? { type: "choice", choice: "code_edit", probabilities: {}, confidence: 0.9 } :
            { type: "score", score: key === "difficulty" ? 2.7 : 1, probabilities: {}, confidence: 0.9 }
          ]));
          return Response.json({ answers: ${mode === "invalid" ? "{ difficulty: null }" : "answers"} });
        };
        extension({
          on: (name, handler) => { handlers.set(name, handler); return () => {}; },
          registerCommand: () => {},
          getActiveTools: () => ["read"],
          getThinkingLevel: () => "high",
          setThinkingLevel: level => thinking.push(level),
          setModel: async model => { current = model; switches.push(model); return true; },
        });
        const ctx = {
          get model() { return current; },
          modelRegistry: { find: (provider, id) => ({ provider, id }) },
          getContextUsage: () => ({ tokens: 5000 }),
          ui: { notify: message => warnings.push(message), setStatus: (_key, text) => statuses.push(text) },
        };
        await handlers.get("session_start")({ reason: "startup" }, ctx);
        assert(!statuses.includes("off"), warnings.join("; "));
        await handlers.get("before_agent_start")({ prompt: "refactor", images: [] }, ctx);
        assert.equal(fetches, 1);
        await handlers.get("turn_end")({ message: {
          role: "assistant", provider: current.provider, model: current.id,
          content: [{ type: "text", text: "done" }],
          usage: { input: 1000, output: 200, cacheRead: 900, cacheWrite: 100 },
        }, toolResults: [] }, ctx);
        await handlers.get("session_shutdown")({}, ctx);
        assert.equal(JSON.stringify(process.env), before, "boot must not mutate process.env");
        const text = await readFile(join(process.env.JEV_ROUTER_HOME, "decisions.jsonl"), "utf8");
        const records = text.trim().split("\\n").map(line => JSON.parse(line));
        assert.equal(records.length, 1);
        assert.equal(records[0].requestedEffort, "high");
        assert.deepEqual(records[0].usage, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 900, cacheWriteTokens: 100 });
        assert(!text.includes("fake-file-key") && !text.includes("fake-process-key") && !warnings.join().includes("fake-file-key"));
        if (${mode === "invalid"}) {
          assert.equal(switches.length, 0);
          assert.equal(thinking.length, 0);
          assert.equal(records[0].decision.candidate, "frontier");
          assert.equal(records[0].decision.source, "fallback");
        } else assert.equal(records[0].decision.candidate, "mid");
      `;
      const child = Bun.spawn([process.execPath, "--eval", script], {
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          TEMP: tmpdir(),
          TMP: tmpdir(),
          JEV_ROUTER_HOME: home,
          ...(mode === "process" ? { PI_BOOT_FAKE_KEY: "fake-process-key" } : mode === "empty" ? { PI_BOOT_FAKE_KEY: "" } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(stderr).toBe("");
      expect(exit).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}
