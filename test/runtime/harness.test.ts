import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANDIDATE_ORDER,
  CLOCK_SKEW_MS,
  classifyHarnessFailure,
  GO_MODEL_ALLOWLIST,
  HARNESS_CANDIDATES,
  type HarnessCandidateId,
  type HarnessStatus,
  type HarnessStatusEntry,
  HEALTH_MAX_AGE_MS,
  implementationCall,
  launchWork,
  opencodeOverlay,
  parseHarnessStatus,
  QUALITY_MAX_AGE_MS,
  QUOTA_MAX_AGE_MS,
  readHarnessStatus,
  recordHarnessFailure,
  resolveHarnessLaunch,
  retryDecision,
  selectHarness,
  stripModelFlags,
  workerArgs,
  writeHarnessStatus,
} from "../../src/runtime/harness";

const now = Date.parse("2026-10-22T06:00:00.000Z");
const at = (msAgo = 60_000) => new Date(now - msAgo).toISOString();
const future = (msAhead = CLOCK_SKEW_MS + 60_000) => new Date(now + msAhead).toISOString();

const statusOf = (entries: Record<string, object>): HarnessStatus => parseHarnessStatus({ candidates: entries }, now);

const status = (free: object | undefined, go: object | undefined): HarnessStatus =>
  statusOf({ ...(free ? { "opencode-free": free } : {}), ...(go ? { "opencode-go": go } : {}) });

const healthy = (msAgo = 60_000) => ({ at: at(msAgo), ok: true, latencyMs: 3600 });
const failed = (failure: string): object => ({ at: at(), ok: false, failure });
const freeGlmReady = () => ({ ...healthy(), model: HARNESS_CANDIDATES["opencode-free-glm"].model });
const goGlmReady = (remaining = 40) => ({
  ...healthy(),
  model: HARNESS_CANDIDATES["opencode-go-glm"].model,
  quota: quota(remaining),
});
const quota = (remaining: number, msAgo = 60_000) => ({
  remaining,
  checkedAt: at(msAgo),
  source: "opencode console Usage screen",
});
const goReady = (remaining = 40) => ({ ...healthy(), model: "opencode-go/deepseek-v4.1-flash", quota: quota(remaining) });

const pick = (s: HarnessStatus, extra: { role?: string; fallback?: "pi" | "claude"; hard?: boolean; scope?: string } = {}) =>
  selectHarness({
    role: extra.role ?? "implementation",
    fallback: extra.fallback ?? "pi",
    status: s,
    now,
    ...(extra.hard !== undefined ? { hard: extra.hard } : {}),
    ...(extra.scope ? { scope: extra.scope } : {}),
  });

const freeShort = (failure: "quota" | "congestion" | "quality_insufficient" | "auth" | "network") =>
  status({ at: at(), ok: false, failure }, goReady());

test("only an explicitly declared implementation boundary picks a harness", () => {
  for (const role of ["pm", "review", "implementation "]) {
    const selection = pick(status(healthy(), goReady()), { role });
    expect(selection.kind).toBe("existing");
    if (selection.kind === "existing") expect(selection.reasons).toEqual(["role_not_implementation"]);
  }
  const undeclared = selectHarness({ role: undefined, fallback: "pi", status: status(healthy(), goReady()), now });
  expect(undeclared.kind).toBe("existing");
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
  expect(selection.rejected.map((r) => r.candidate)).toEqual(["opencode-free", "opencode-free-glm", "opencode-go", "opencode-go-glm"]);
});

test("a stale health record is unknown again, and a future one is never fresh", () => {
  const stale = pick(status(healthy(HEALTH_MAX_AGE_MS + 60_000), goReady()));
  expect(stale.kind).toBe("existing");
  if (stale.kind === "existing") expect(stale.reasons).toContain("free_health_stale");

  // Parsed from a file, a future timestamp is unreadable rather than freshly healthy.
  expect(parseHarnessStatus({ candidates: { "opencode-free": { at: future(), ok: true } } }, now).candidates).toEqual({});
  // A caller that hands over an in-memory status still cannot buy a future record.
  const inMemory: HarnessStatus = { candidates: { "opencode-free": { at: future(), ok: true }, "opencode-go": goReady() as never } };
  const selection = selectHarness({ role: "implementation", fallback: "pi", status: inMemory, now });
  expect(selection.kind).toBe("existing");
  if (selection.kind === "existing") expect(selection.reasons).toContain("free_health_future");

  // Same for a quota reading that claims to come from the future: unreadable, not a spend authorisation.
  const quotaAhead: HarnessStatus = {
    candidates: {
      "opencode-free": { at: at(), ok: false, failure: "quota" },
      "opencode-go": {
        at: at(),
        ok: true,
        model: GO_MODEL_ALLOWLIST[0] as string,
        quota: { remaining: 9, checkedAt: future(), source: "console" },
      },
    },
  };
  const quotaSelection = selectHarness({ role: "implementation", fallback: "pi", status: quotaAhead, now });
  expect(quotaSelection.kind).toBe("existing");
  if (quotaSelection.kind === "existing") expect(quotaSelection.reasons).toContain("go_quota_future");
});

test("a Go record never blocks the walk on a missing number; a flagged exhausted one does", () => {
  // The quota number is advisory. Missing, unreadable or old: Go still runs, Pi still catches it.
  for (const go of [{ ...healthy(), model: HARNESS_CANDIDATES["opencode-go"].model }, goReady()] as HarnessStatusEntry[]) {
    const selection = pick(status({ at: at(), ok: false, failure: "quota" }, go));
    expect(selection.kind).toBe("opencode");
    if (selection.kind === "opencode") expect(selection.model).toBe(HARNESS_CANDIDATES["opencode-go"].model);
    // The number stays visible to the operator without gating the launch.
    if (go.quota) expect(selection.kind === "opencode").toBe(true);
  }
  const exhausted = pick(status({ at: at(), ok: false, failure: "quota" }, { ...healthy(), model: HARNESS_CANDIDATES["opencode-go"].model, quota: quota(0) }));
  expect(exhausted.kind).toBe("existing");
  if (exhausted.kind === "existing") expect(exhausted.reasons).toContain("go_quota_exhausted");
  // A flagged number keeps its advisory meaning; only a real 429 falls back (next test).
  const empty = pick(status({ at: at(), ok: false, failure: "quota" }, { ...healthy(), model: HARNESS_CANDIDATES["opencode-go"].model, quota: { remaining: Number.NaN, checkedAt: at(), source: "x" } }));
  expect(empty.kind).toBe("opencode");
});

test("Free capacity shortfalls unlock the paid DeepSeek Go plan only when its model is verified", () => {
  for (const failure of ["quota", "congestion"] as const) {
    const selection = pick(freeShort(failure));
    expect(selection.kind).toBe("opencode");
    if (selection.kind !== "opencode") continue;
    expect(selection.candidate).toBe("opencode-go");
    expect(selection.model).toBe(GO_MODEL_ALLOWLIST[0] as string);
    expect(selection.reasons).toContain(`free_${failure}_failure`);
  }
  const quality = pick(status({ at: at(), ok: false, failure: "quality_insufficient" }, goReady()));
  if (quality.kind === "opencode") expect(quality.candidate).toBe("opencode-go");
});

test("a GLM id recorded under the DeepSeek candidate is not permission to run it", () => {
  const noModel = pick(status(failed("quota"), { ...healthy(), quota: quota(40) }));
  expect(noModel.kind).toBe("existing");
  if (noModel.kind === "existing") expect(noModel.reasons).toContain("go_model_unverified");

  const glm = pick(status(failed("quota"), { ...healthy(), model: "opencode-go/glm-5.3-flash", quota: quota(40) }));
  expect(glm.kind).toBe("existing");
  if (glm.kind === "existing") expect(glm.reasons).toContain("go_model_not_allowed");
});

test("a free candidate's failure never disables the other free candidate", () => {
  const otherFreeOnly = statusOf({ "opencode-free": failed("quota"), "opencode-free-glm": freeGlmReady() });
  const selection = pick(otherFreeOnly);
  expect(selection.kind).toBe("opencode");
  if (selection.kind === "opencode") {
    expect(selection.candidate).toBe("opencode-free-glm");
    expect(selection.model).toBe(HARNESS_CANDIDATES["opencode-free-glm"].model);
    // The paid plan is not touched while a free candidate can still run the work.
    expect(selection.reasons).toContain("free_verified");
    expect(selection.reasons).not.toContain("go_verified");
  }
});

test("a not-yet-verified GLM candidate is skipped, not guessed", () => {
  // A healthy record without the verified id is not selectable.
  const unrecorded = pick(statusOf({ "opencode-free-glm": healthy() }));
  expect(unrecorded.kind).toBe("existing");
  if (unrecorded.kind === "existing") expect(unrecorded.reasons).toContain("free_glm_model_unverified");

  // An id outside the candidate's own family is refused even when healthy.
  const foreign = pick(statusOf({ "opencode-free-glm": { ...healthy(), model: "opencode-go/glm-5.3-flash" } }));
  expect(foreign.kind).toBe("existing");
  if (foreign.kind === "existing") expect(foreign.reasons).toContain("free_glm_model_not_allowed");

  // The Go GLM candidate needs its own recorded id too.
  const goGlmBare = pick(statusOf({ "opencode-free": failed("quota"), "opencode-go-glm": { ...healthy(), quota: quota(40) } }));
  expect(goGlmBare.kind).toBe("existing");
  if (goGlmBare.kind === "existing") expect(goGlmBare.reasons).toContain("go_glm_model_unverified");
});

test("the free group is tried in order before any paid candidate, and Pi is last", () => {
  const bothFreeAvailable = statusOf({
    "opencode-free": failed("quota"),
    "opencode-free-glm": freeGlmReady(),
    "opencode-go": goReady(),
    "opencode-go-glm": goGlmReady(),
  });
  // Each step is the next attempt in the same launch, after the previous candidate failed.
  const steps: [HarnessCandidateId[], HarnessCandidateId][] = [
    [[], "opencode-free-glm"],
    [["opencode-free", "opencode-free-glm"], "opencode-go"],
    [["opencode-free", "opencode-free-glm", "opencode-go"], "opencode-go-glm"],
  ];
  for (const [exclude, expected] of steps) {
    const selection = selectHarness({ role: "implementation", fallback: "pi", status: bothFreeAvailable, now, exclude });
    expect(selection.kind).toBe("opencode");
    if (selection.kind === "opencode") expect(selection.candidate).toBe(expected);
  }
  const all = selectHarness({
    role: "implementation",
    fallback: "pi",
    status: bothFreeAvailable,
    now,
    exclude: CANDIDATE_ORDER,
  });
  expect(all.kind).toBe("existing");
  if (all.kind === "existing") expect(all.harness).toBe("pi");
});

test("a free allowance lost mid-run hands the same request to Pi while the paid plan is unverified", async () => {
  // The launcher records this from the exit text: the free model ran out while the work was in flight.
  const afterLimit = statusOf({
    "opencode-free": failed("quota"),
    "opencode-go": { ...healthy(), quota: quota(40) },
  });
  const selection = selectHarness({ role: "implementation", fallback: "pi", status: afterLimit, now });
  expect(selection.kind).toBe("existing");
  if (selection.kind !== "existing") return;
  expect(selection.harness).toBe("pi");
  expect(selection.reasons).toContain("free_quota_failure");
  expect(selection.reasons).toContain("go_model_unverified");

  // A retry that also passes over the candidate recorded as failed reaches the same answer.
  const retried = selectHarness({ role: "implementation", fallback: "pi", status: afterLimit, now, exclude: ["opencode-free"] });
  expect(retried.kind).toBe("existing");
  if (retried.kind === "existing") expect(retried.reasons).toContain("free_excluded_after_failure");

  // The request itself survives the switch: the non-interactive shape still carries the prompt,
  // which is what the launcher passes to Pi as an argument.
  const plan = await resolveHarnessLaunch({
    env: {},
    args: ["-p", "--no-session"],
    stdinPrompt: "fix the median case in calc.js",
    status: afterLimit,
    now,
    exclude: ["opencode-free"],
  });
  expect(plan.kind).toBe("existing");
  expect(implementationCall(["-p", "--no-session"], "fix the median case in calc.js").prompt).toBe("fix the median case in calc.js");
});

test("the next launch does not repeat the same Free failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "jev-harness-"));
  const env = { JEV_ROUTER_HOME: home };
  await writeHarnessStatus("opencode-free-glm", { at: at(), ok: true, model: HARNESS_CANDIDATES["opencode-free-glm"].model }, env, now);
  await writeHarnessStatus("opencode-free", { at: at(), ok: true }, env, now);
  expect(pick(await readHarnessStatus(env, now)).kind).toBe("opencode");
  expect((pick(await readHarnessStatus(env, now)) as { candidate: string }).candidate).toBe("opencode-free");

  // An observed free-limit failure is written back by the runtime, not by hand.
  expect(await recordHarnessFailure("opencode-free", "quota", { env, at: new Date(now).toISOString() })).toBe(true);
  const next = pick(await readHarnessStatus(env, now + 1000));
  expect(next.kind).toBe("opencode");
  if (next.kind === "opencode") {
    expect(next.candidate).toBe("opencode-free-glm");
    expect(next.reasons).toContain("free_quota_failure");
  }
});

test("a quality shortfall is scoped and expires instead of blocking unrelated work forever", () => {
  const scoped = (scope: string | undefined, msAgo = 60_000) =>
    status({ ...healthy(), quality: [{ at: at(msAgo), ...(scope ? { scope } : {}), evidence: "median case" }] }, goReady());

  // Same task, fresh: Free is blocked for that task and Go may run it.
  const same = pick(scoped("APP-G1-T02"), { scope: "APP-G1-T02" });
  expect(same.kind).toBe("opencode");
  if (same.kind === "opencode") expect(same.candidate).toBe("opencode-go");

  // A different task is not affected by the old judgement.
  const other = pick(scoped("APP-G1-T02"), { scope: "APP-G1-T03" });
  expect(other.kind).toBe("opencode");
  if (other.kind === "opencode") expect(other.candidate).toBe("opencode-free");

  // An unrelated launch without a declared scope is not blocked by a scoped record either.
  const undeclared = pick(scoped("APP-G1-T02"));
  if (undeclared.kind === "opencode") expect(undeclared.candidate).toBe("opencode-free");

  // Expired records stop applying.
  const expired = pick(scoped("APP-G1-T02", QUALITY_MAX_AGE_MS + 60_000), { scope: "APP-G1-T02" });
  if (expired.kind === "opencode") expect(expired.candidate).toBe("opencode-free");
});

test("work the existing judgement calls hard goes to Pi rather than DeepSeek", () => {
  for (const selection of [pick(status(healthy(), goReady()), { hard: true }), pick(freeShort("quota"), { hard: true })]) {
    expect(selection.kind).toBe("existing");
    if (selection.kind === "existing") {
      expect(selection.reasons).toContain("hard_work_pi");
      expect(selection.reasons).not.toContain("go_quota_verified");
    }
  }
});

test("auth and network failures fall back to the existing route instead of spending on Go", () => {
  for (const failure of ["auth", "network"] as const) {
    const selection = pick(freeShort(failure));
    expect(selection.kind).toBe("existing");
    if (selection.kind === "existing") {
      expect(selection.harness).toBe("pi");
      expect(selection.reasons).toContain(`free_${failure}_failure`);
      expect(selection.reasons).toContain("go_withheld_operational");
    }
  }
  const claude = pick(freeShort("auth"), { fallback: "claude" });
  if (claude.kind === "existing") expect(claude.harness).toBe("claude");
});

test("a candidate that already failed in this launch is not retried", () => {
  const selection = selectHarness({
    role: "implementation",
    fallback: "pi",
    status: status(healthy(), goReady()),
    now,
    exclude: ["opencode-free"],
  });
  expect(selection.kind).toBe("opencode");
  if (selection.kind === "opencode") expect(selection.candidate).toBe("opencode-go");
  const both = selectHarness({
    role: "implementation",
    fallback: "pi",
    status: status(healthy(), goReady()),
    now,
    exclude: ["opencode-free", "opencode-go"],
  });
  expect(both.kind).toBe("existing");
});

test("failure classes stay distinct and are not confused with a quality judgement", () => {
  expect(classifyHarnessFailure("provider.auth: 403 Forbidden")).toBe("auth");
  expect(classifyHarnessFailure("HTTP 401 Unauthorized")).toBe("auth");
  expect(classifyHarnessFailure("429 Too Many Requests")).toBe("quota");
  // Free allowance messages arrive as text, not only as HTTP 429.
  expect(classifyHarnessFailure("FreeUsageLimitError: free tier exhausted")).toBe("quota");
  expect(classifyHarnessFailure('{"error":{"type":"provider.free-limit"}}')).toBe("quota");
  expect(classifyHarnessFailure("Free usage limit reached. Try again tomorrow.")).toBe("quota");
  expect(classifyHarnessFailure("503 Service Unavailable: overloaded")).toBe("congestion");
  expect(classifyHarnessFailure("ECONNREFUSED 127.0.0.1:443")).toBe("network");
  expect(classifyHarnessFailure("tests failed: expected 2 received 3")).toBeNull();
});

test("the status file only admits declared candidates and fails closed on garbage", () => {
  const parsed = parseHarnessStatus(
    { candidates: { "opencode-free": { at: at(), ok: true }, "opencode-zen": { at: at(), ok: true }, "opencode-go": { ok: true } } },
    now,
  );
  expect(Object.keys(parsed.candidates)).toEqual(["opencode-free"]);
  expect(parseHarnessStatus("nope", now).candidates).toEqual({});
  expect(parseHarnessStatus({ candidates: { "opencode-free": { at: "not a date", ok: true } } }, now).candidates).toEqual({});
});

test("a written observation is read back, merged per candidate and kept private", async () => {
  const home = await mkdtemp(join(tmpdir(), "jev-harness-"));
  const env = { JEV_ROUTER_HOME: home };
  const path = await writeHarnessStatus(
    "opencode-go",
    { at: at(), ok: true, model: GO_MODEL_ALLOWLIST[0] as string, quota: quota(12) },
    env,
    now,
  );
  await writeHarnessStatus("opencode-free", { at: at(), ok: true }, env, now);
  const read = await readHarnessStatus(env, now);
  expect(path).toBe(join(home, "orca-launch", "harness-status.json"));
  expect(Object.keys(read.candidates).sort()).toEqual(["opencode-free", "opencode-go"]);
  expect(read.candidates["opencode-go"]?.quota?.remaining).toBe(12);
  expect(read.candidates["opencode-go"]?.model).toBe(GO_MODEL_ALLOWLIST[0] as string);
  expect((await readHarnessStatus({ JEV_ROUTER_HOME: join(home, "missing") }, now)).candidates).toEqual({});
});

test("an observed launch failure is written once and never overwrites fresher evidence", async () => {
  const home = await mkdtemp(join(tmpdir(), "jev-harness-"));
  const env = { JEV_ROUTER_HOME: home };
  expect(await recordHarnessFailure("opencode-free", "quota", { env, at: new Date(now).toISOString(), scope: "APP-G1-T02" })).toBe(true);
  const written = await readHarnessStatus(env, now);
  expect(written.candidates["opencode-free"]?.failure).toBe("quota");
  expect(written.candidates["opencode-free"]?.scope).toBe("APP-G1-T02");
  expect(await recordHarnessFailure("opencode-free", "auth", { env, at: new Date(now - 60_000).toISOString() })).toBe(false);
  expect((await readHarnessStatus(env, now)).candidates["opencode-free"]?.failure).toBe("quota");
});

test("the launch plan names the planned model and does not claim an applied one", async () => {
  const plan = await resolveHarnessLaunch({
    env: { OPENCODE_BIN: "/usr/bin/opencode", OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "dark" }) },
    args: ["--model", "opencode-go/glm-5.3-flash", "--thinking", "some/dir"],
    status: status(healthy(), goReady()),
    now,
  });
  expect(plan.kind).toBe("opencode");
  if (plan.kind !== "opencode") return;
  expect(plan.executable).toBe("/usr/bin/opencode");
  expect(plan.args).toEqual(["--agent", "build", "--auto", "some/dir"]);
  expect(JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT as string)).toEqual({
    theme: "dark",
    model: HARNESS_CANDIDATES["opencode-free"].model,
    small_model: HARNESS_CANDIDATES["opencode-free"].model,
  });
  expect(plan.env.JEV_ROUTER_HARNESS).toBe("opencode-free");
  expect(plan.record.plannedModel).toBe(HARNESS_CANDIDATES["opencode-free"].model);
  expect(plan.record.appliedModel).toBeNull();
  expect(plan.record.launchOk).toBeNull();
  expect(plan.record.workOk).toBeNull();
  expect(plan.record.effort).toBeNull();
  expect(plan.record.fallback).toBe(false);
  expect(plan.record.hard).toBe(false);
});

test("without a verified candidate the launch falls back to the unchanged Pi route", async () => {
  const plan = await resolveHarnessLaunch({ env: {}, args: [], status: status(undefined, undefined), now });
  expect(plan.kind).toBe("existing");
  if (plan.kind !== "existing") return;
  expect(plan.harness).toBe("pi");
  expect(plan.record.fallback).toBe(true);
  expect(plan.record.appliedModel).toBeNull();
  expect(plan.record.plannedModel).toBeNull();
});

test("the non-interactive PM shape becomes opencode run and names what it dropped", async () => {
  const call = implementationCall(["-p", "fix it", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--format", "json"]);
  expect(call.shape).toBe("run");
  expect(call.prompt).toBe("fix it");
  expect(call.args).toEqual(["run", "--format", "json", "--auto", "--agent", "build"]);
  expect(call.dropped).toEqual(["--no-session", "--no-extensions", "--no-mcp", "--no-skills"]);

  const fromStdin = implementationCall(["-p", "--no-session"], "prompt from stdin");
  expect(fromStdin.prompt).toBe("prompt from stdin");

  const plan = await resolveHarnessLaunch({
    env: { OPENCODE_BIN: "/usr/bin/opencode" },
    args: ["-p", "--no-session"],
    stdinPrompt: "fix the median case",
    status: status(healthy(), goReady()),
    now,
  });
  expect(plan.kind).toBe("opencode");
  if (plan.kind !== "opencode") return;
  expect(plan.args).toEqual(["run", "--auto", "--agent", "build", "fix the median case"]);
  expect(plan.call.shape).toBe("run");
});

test("an interactive launch keeps OpenCode's own arguments", () => {
  expect(implementationCall(["--agent", "plan", "src"])).toEqual({
    shape: "tui",
    args: ["--auto", "--agent", "plan", "src"],
    dropped: [],
  });
});

test("a worker launch never stalls on permissions and never re-pins a model", () => {
  expect(workerArgs(["--model=x/y", "-m", "a/b", "--thinking"])).toEqual(["--agent", "build", "--auto"]);
  expect(workerArgs(["--agent", "plan", "--auto", "dir"])).toEqual(["--agent", "plan", "--auto", "dir"]);
  expect(workerArgs(["--agent=build", "--auto=always"])).toEqual(["--agent=build", "--auto=always"]);
});

test("caller flags that would pin a model or effort never reach the child", () => {
  expect(stripModelFlags(["--model=x/y", "-m", "a/b", "--thinking", "--auto"])).toEqual(["--auto"]);
  expect(opencodeOverlay("a/b", "{ not json")).toBe(JSON.stringify({ model: "a/b", small_model: "a/b" }));
});

test("a capacity loss is retried once only in the non-interactive shape and only on a clean tree", () => {
  expect(retryDecision("quota", "run", false)).toBe("retry");
  expect(retryDecision("congestion", "run", false)).toBe("retry");
  expect(retryDecision("quota", "run", true)).toBe("handoff");
  expect(retryDecision("quota", "tui", false)).toBe("stop");
  expect(retryDecision("auth", "run", false)).toBe("stop");
  expect(retryDecision("network", "run", false)).toBe("stop");
  expect(retryDecision(null, "run", false)).toBe("stop");
  // A silent success is not a capacity signal, so it neither retries nor sidesteps the model.
  expect(retryDecision("no_output", "run", false)).toBe("stop");
});

test("the launch work hint reuses the existing context: design and labelled hard work are not cheap-model work", () => {
  expect(launchWork("Fix the rounding bug in calc.js")).toMatchObject({ hard: false, phase: "unknown" });
  expect(launchWork("Phase: design\nGoal: decide the auth boundary")).toMatchObject({ hard: true, phase: "design" });
  expect(launchWork("Task: APP-G1-T02\nGoal: implement the parser", JSON.stringify({ difficulty: 3.2 }))).toMatchObject({
    hard: true,
    scope: "APP-G1-T02",
  });
  expect(launchWork("Task: APP-G1-T02\nGoal: implement the parser", "{ not json")).toMatchObject({ hard: false, scope: "APP-G1-T02" });
});

test("clock skew is tolerated only within the documented window", () => {
  const slightlyAhead = new Date(now + CLOCK_SKEW_MS - 1000).toISOString();
  expect(
    parseHarnessStatus({ candidates: { "opencode-free": { at: slightlyAhead, ok: true } } }, now).candidates["opencode-free"],
  ).toBeDefined();
});
