import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyHarnessFailure,
  HARNESS_CANDIDATES,
  type HarnessStatus,
  HEALTH_MAX_AGE_MS,
  opencodeOverlay,
  parseHarnessStatus,
  QUOTA_MAX_AGE_MS,
  readHarnessStatus,
  resolveHarnessLaunch,
  selectHarness,
  stripModelFlags,
  writeHarnessStatus,
} from "../../src/runtime/harness";

const now = Date.parse("2026-10-22T06:00:00.000Z");
const at = (msAgo = 60_000) => new Date(now - msAgo).toISOString();

const status = (free: object | undefined, go: object | undefined): HarnessStatus =>
  parseHarnessStatus({ candidates: { ...(free ? { "opencode-free": free } : {}), ...(go ? { "opencode-go": go } : {}) } });

const healthy = (msAgo = 60_000) => ({ at: at(msAgo), ok: true, latencyMs: 3600 });
const quota = (remaining: number, msAgo = 60_000) => ({
  remaining,
  checkedAt: at(msAgo),
  source: "opencode-go/usage probe",
});
const goReady = (remaining = 40) => ({ ...healthy(), quota: quota(remaining) });

const pick = (s: HarnessStatus, role: string | undefined = "implementation", fallback: "pi" | "claude" = "pi") =>
  selectHarness({ role, fallback, status: s, now });

/** `undefined` must mean "no declared role", not "use the default argument". */
const pickUndeclared = (s: HarnessStatus) => selectHarness({ role: undefined, fallback: "pi", status: s, now });

test("only an explicitly declared implementation boundary picks a harness", () => {
  for (const role of ["pm", "review", "implementation "]) {
    const selection = pick(status(healthy(), goReady()), role);
    expect(selection.kind).toBe("existing");
    if (selection.kind === "existing") expect(selection.reasons).toEqual(["role_not_implementation"]);
  }
  expect(pickUndeclared(status(healthy(), goReady())).kind).toBe("existing");
  const implementation = pick(status(healthy(), goReady()));
  expect(implementation.kind).toBe("opencode");
  if (implementation.kind === "opencode") {
    expect(implementation.candidate).toBe("opencode-free");
    expect(implementation.model).toBe(HARNESS_CANDIDATES["opencode-free"].model);
  }
});

test("an unverified candidate is never selected, and the existing route keeps working", () => {
  const selection = pick(status(undefined, undefined));
  expect(selection.kind).toBe("existing");
  if (selection.kind !== "existing") return;
  expect(selection.harness).toBe("pi");
  expect(selection.reasons).toContain("free_unverified");
  expect(selection.reasons).toContain("go_unverified");
  expect(selection.rejected.map((r) => r.candidate)).toEqual(["opencode-free", "opencode-go"]);
});

test("a stale health record is unknown again", () => {
  const selection = pick(status(healthy(HEALTH_MAX_AGE_MS + 60_000), goReady()));
  expect(selection.kind).toBe("existing");
  if (selection.kind === "existing") expect(selection.reasons).toContain("free_health_stale");
});

test("Go quota must be numeric, recent and stated; one success is not a remainder", () => {
  const cases: [object, string][] = [
    [{ ...healthy() }, "go_quota_unknown"],
    [{ ...healthy(), quota: { ...quota(5), checkedAt: at(QUOTA_MAX_AGE_MS + 60_000) } }, "go_quota_stale"],
    [{ ...healthy(), quota: quota(0) }, "go_quota_exhausted"],
    [{ ...healthy(), quota: { remaining: Number.NaN, checkedAt: at(), source: "x" } }, "go_quota_unknown"],
  ];
  for (const [go, reason] of cases) {
    // Free is explicitly short on quality, so Go is the only upgrade path left.
    const selection = pick(status({ ...healthy(), ok: false, failure: "quality_insufficient" }, go));
    expect(selection.kind).toBe("existing");
    if (selection.kind === "existing") expect(selection.reasons).toContain(reason);
  }
});

test("quality shortfall unlocks Go only with verified headroom", () => {
  const selection = pick(status({ at: at(), ok: false, failure: "quality_insufficient" }, goReady(40)));
  expect(selection.kind).toBe("opencode");
  if (selection.kind !== "opencode") return;
  expect(selection.candidate).toBe("opencode-go");
  expect(selection.model).toBe(HARNESS_CANDIDATES["opencode-go"].model);
  expect(selection.reasons).toContain("go_quota_verified");
});

test("operational failures fall back to the existing route instead of spending on Go", () => {
  for (const failure of ["auth", "network", "quota"] as const) {
    const selection = pick(status({ at: at(), ok: false, failure }, goReady(40)));
    expect(selection.kind).toBe("existing");
    if (selection.kind === "existing") {
      expect(selection.harness).toBe("pi");
      expect(selection.reasons).toContain(`free_${failure}_failure`);
      // Go may be ready, yet an outage must not unlock paid capacity.
      expect(selection.reasons).toContain("go_withheld_operational");
      expect(selection.reasons).not.toContain("go_quota_verified");
    }
  }
  const claude = pick(status({ at: at(), ok: false, failure: "auth" }, undefined), "implementation", "claude");
  if (claude.kind === "existing") expect(claude.harness).toBe("claude");
});

test("failure classes stay distinct and are not confused with a quality judgement", () => {
  expect(classifyHarnessFailure("provider.auth: 403 Forbidden")).toBe("auth");
  expect(classifyHarnessFailure("HTTP 401 Unauthorized")).toBe("auth");
  expect(classifyHarnessFailure("429 Too Many Requests")).toBe("quota");
  expect(classifyHarnessFailure("ECONNREFUSED 127.0.0.1:443")).toBe("network");
  expect(classifyHarnessFailure("tests failed: expected 2 received 3")).toBeNull();
});

test("the status file only admits declared candidates and fails closed on garbage", () => {
  const parsed = parseHarnessStatus({
    candidates: { "opencode-free": { at: at(), ok: true }, "opencode-paid-zen": { at: at(), ok: true }, "opencode-go": { ok: true } },
  });
  expect(Object.keys(parsed.candidates)).toEqual(["opencode-free"]);
  expect(parseHarnessStatus("nope").candidates).toEqual({});
  expect(parseHarnessStatus({ candidates: { "opencode-free": { at: "not a date", ok: true } } }).candidates).toEqual({});
});

test("a written observation is read back, merged per candidate and kept private", async () => {
  const home = await mkdtemp(join(tmpdir(), "jev-harness-"));
  const env = { JEV_ROUTER_HOME: home };
  const path = await writeHarnessStatus("opencode-go", { at: at(), ok: true, quota: quota(12) }, env);
  await writeHarnessStatus("opencode-free", { at: at(), ok: true }, env);
  const read = await readHarnessStatus(env);
  expect(path).toBe(join(home, "orca-launch", "harness-status.json"));
  expect(Object.keys(read.candidates).sort()).toEqual(["opencode-free", "opencode-go"]);
  expect(read.candidates["opencode-go"]?.quota?.remaining).toBe(12);
  expect((await readHarnessStatus({ JEV_ROUTER_HOME: join(home, "missing") })).candidates).toEqual({});
});

test("the launch plan sets the selected model through OpenCode's own config and drops manual pins", async () => {
  const plan = await resolveHarnessLaunch({
    env: { OPENCODE_BIN: "/usr/bin/opencode", OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "dark" }) },
    args: ["--model", "opencode-go/glm-5.3-flash", "--thinking", "some/dir"],
    status: status(healthy(), goReady()),
    now,
  });
  expect(plan.kind).toBe("opencode");
  if (plan.kind !== "opencode") return;
  expect(plan.executable).toBe("/usr/bin/opencode");
  expect(plan.args).toEqual(["some/dir"]);
  expect(JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT as string)).toEqual({
    theme: "dark",
    model: HARNESS_CANDIDATES["opencode-free"].model,
    small_model: HARNESS_CANDIDATES["opencode-free"].model,
  });
  expect(plan.env.JEV_ROUTER_HARNESS).toBe("opencode-free");
  expect(plan.record.appliedModel).toBe(plan.record.requestedModel);
  expect(plan.record.effort).toBeNull();
  expect(plan.record.fallback).toBe(false);
});

test("without a verified candidate the launch falls back to the unchanged Pi route", async () => {
  const plan = await resolveHarnessLaunch({ env: {}, args: [], status: status(undefined, undefined), now });
  expect(plan.kind).toBe("existing");
  if (plan.kind !== "existing") return;
  expect(plan.harness).toBe("pi");
  expect(plan.record.fallback).toBe(true);
  expect(plan.record.appliedModel).toBeNull();
});

test("caller flags that would pin a model or effort never reach the child", () => {
  expect(stripModelFlags(["--model=x/y", "-m", "a/b", "--thinking", "--auto"])).toEqual(["--auto"]);
  expect(opencodeOverlay("a/b", "{ not json")).toBe(JSON.stringify({ model: "a/b", small_model: "a/b" }));
});
