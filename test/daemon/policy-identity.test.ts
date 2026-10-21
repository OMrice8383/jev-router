import { expect, test } from "bun:test";
import { loadPolicy } from "../../src/core/policy";
import { startDaemon } from "../../src/daemon";
import { minimalPolicy } from "../fixtures/policies";

test("health identifies the policy actually held in memory and counts active requests", async () => {
  const raw = minimalPolicy();
  raw.egress = { openrouter: { base_url: "http://upstream.invalid", no_auth: true } };
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const daemon = await startDaemon({
    policy: loadPolicy(raw),
    host: "127.0.0.1",
    port: 0,
    fetch: async () => {
      entered();
      await gate;
      return new Response(JSON.stringify({ model: "test", content: [], usage: { input_tokens: 1, output_tokens: 1 } }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  let request: Promise<Response> | undefined;
  try {
    const health = await (await fetch(daemon.url + "/healthz")).json();
    expect(health.routingRevision).toBe("task-aware-v2");
    expect(health.policyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(health.activeRequests).toBe(0);
    request = fetch(daemon.url + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", max_tokens: 10, messages: [{ role: "user", content: "hello" }] }),
    });
    await started;
    const active = await (await fetch(daemon.url + "/healthz")).json();
    expect(active.activeRequests).toBe(1);
    expect(active.policyHash).toBe(health.policyHash);
    release();
    await (await request).text();
    expect((await (await fetch(daemon.url + "/healthz")).json()).activeRequests).toBe(0);
  } finally {
    release();
    if (request) await (await request).text().catch(() => undefined);
    await daemon.close();
  }
});
