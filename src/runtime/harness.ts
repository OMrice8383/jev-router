import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NormalizedRequest } from "../core/types";
import { updateWorkContext, type WorkContext, type WorkPhase } from "../core/work";
import { configDir, type Env } from "./paths";

/**
 * Execution-harness selection at an explicitly declared implementation boundary.
 * It reuses the existing launcher, work-context and policy thresholds; it is not a second decision
 * engine and it never guesses a role from prompts or terminals.
 */

export type HarnessFailureKind = "auth" | "quota" | "congestion" | "network" | "quality_insufficient";

export interface QuotaObservation {
  /** Remaining allowance in whatever unit `source` reports. Never inferred from one successful call. */
  readonly remaining: number;
  /** When the source was read, not when this file was written. */
  readonly checkedAt: string;
  /** Where the number came from, for the operator. No credentials, no URLs with tokens. */
  readonly source: string;
  readonly limit?: number;
}

/** One quality shortfall, scoped so it cannot block unrelated work forever. */
export interface QualityObservation {
  readonly at: string;
  /** Task id or target the shortfall was seen on. Absent means "any scope", still time-boxed. */
  readonly scope?: string;
  readonly evidence?: string;
}

export interface HarnessStatusEntry {
  readonly at: string;
  readonly ok: boolean;
  /** Why it is not ok. `quality_insufficient` is a judgement call, the others are operational. */
  readonly failure?: HarnessFailureKind;
  readonly latencyMs?: number;
  readonly quota?: QuotaObservation;
  /** The provider/model the writer actually verified. Required before a paid candidate may run. */
  readonly model?: string;
  readonly scope?: string;
  readonly quality?: readonly QualityObservation[];
}

export interface HarnessStatus {
  readonly candidates: Readonly<Record<string, HarnessStatusEntry>>;
}

/**
 * Two free candidates (group 1) and two paid Go candidates (group 2). Every candidate keeps its own
 * health, failure, quota and model: one model losing its free allowance says nothing about another.
 */
export type HarnessCandidateId = "opencode-free" | "opencode-free-glm" | "opencode-go" | "opencode-go-glm";

export interface HarnessCandidate {
  readonly harness: "opencode";
  /** 1 = free allowance, 2 = OpenCode Go contract. A cheaper group is always tried first. */
  readonly group: 1 | 2;
  /**
   * The id this candidate is expected to run. For a candidate whose id is not verified yet this is a
   * placeholder: it is never executed, because those candidates also require the recorded `model`.
   */
  readonly model: string;
  /** Model ids this candidate is allowed to run. A record outside this list is refused. */
  readonly family: readonly string[];
  /** The incumbent free candidate keeps working with an old record that has no `model`. */
  readonly modelRequired: boolean;
}

export const HARNESS_CANDIDATES: Readonly<Record<HarnessCandidateId, HarnessCandidate>> = {
  "opencode-free": {
    harness: "opencode",
    group: 1,
    model: "opencode/deepseek-v4.1-flash-free",
    family: ["opencode/deepseek-v4.1-flash-free"],
    modelRequired: false,
  },
  // Activated only by a recorded id that matches this family. Until the access owner verifies the
  // GLM free id, pricing route and a real round trip, this candidate stays unselectable.
  "opencode-free-glm": {
    harness: "opencode",
    group: 1,
    model: "opencode/glm-5.3-flash-free",
    family: ["opencode/glm-5.3-flash-free"],
    modelRequired: true,
  },
  "opencode-go": {
    harness: "opencode",
    group: 2,
    model: "opencode-go/deepseek-v4.1-flash",
    family: ["opencode-go/deepseek-v4.1-flash"],
    modelRequired: true,
  },
  "opencode-go-glm": {
    harness: "opencode",
    group: 2,
    model: "opencode-go/glm-5.3-flash",
    family: ["opencode-go/glm-5.3-flash"],
    modelRequired: true,
  },
};

/** Selection order inside a group: the incumbent DeepSeek candidate first. */
export const CANDIDATE_ORDER: readonly HarnessCandidateId[] = ["opencode-free", "opencode-free-glm", "opencode-go", "opencode-go-glm"];

/**
 * Models a paid Go call may actually run. Kept as the union of the paid families so an old
 * DeepSeek-era observer keeps reading a meaningful list; per-candidate checks use `family`.
 */
export const GO_MODEL_ALLOWLIST: readonly string[] = CANDIDATE_ORDER.filter((id) => HARNESS_CANDIDATES[id].group === 2).flatMap(
  (id) => HARNESS_CANDIDATES[id].family,
);

/** Free capacity failures may be tried again after this existing observation window. */
export const HEALTH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Nagakura 2026-10-22: "残枠は気にしないで使って、使えなかったらPiに行くでいい".
 * The remaining number is advisory, so a stale reading no longer gates a launch. It is kept
 * so an operator can still see when the console was last read; a real 429 still falls back.
 */
export const QUOTA_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** A quality judgement is about one piece of work; it stops applying on its own. */
export const QUALITY_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** Tolerated clock skew before a timestamp counts as "from the future" rather than fresh. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** The existing policy's capability floor for hard work; see docs/TASK_ROUTING.md. */
export const HARD_DIFFICULTY = 2.6;

export type ExistingHarness = "pi" | "claude";

const FAILURE_KINDS: readonly HarnessFailureKind[] = ["auth", "quota", "congestion", "network", "quality_insufficient"];

const finiteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A timestamp in the future is not evidence: it is unreadable, so the candidate stays unknown. */
const pastTime = (v: unknown, now: number): number | undefined => {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t - now > CLOCK_SKEW_MS) return undefined;
  return t;
};

function parseQuality(raw: unknown, now: number): QualityObservation[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: QualityObservation[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const q = item as Record<string, unknown>;
    if (pastTime(q.at, now) === undefined) continue;
    out.push({
      at: q.at as string,
      ...(typeof q.scope === "string" && q.scope !== "" ? { scope: q.scope } : {}),
      ...(typeof q.evidence === "string" && q.evidence !== "" ? { evidence: q.evidence } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function parseEntry(raw: unknown, now: number): HarnessStatusEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const e = raw as Record<string, unknown>;
  if (pastTime(e.at, now) === undefined || typeof e.ok !== "boolean") return undefined;
  const failure =
    typeof e.failure === "string" && FAILURE_KINDS.includes(e.failure as HarnessFailureKind)
      ? (e.failure as HarnessFailureKind)
      : undefined;
  const quotaRaw = e.quota;
  let quota: QuotaObservation | undefined;
  if (typeof quotaRaw === "object" && quotaRaw !== null) {
    const q = quotaRaw as Record<string, unknown>;
    if (finiteNumber(q.remaining) && pastTime(q.checkedAt, now) !== undefined && typeof q.source === "string" && q.source !== "") {
      quota = {
        remaining: q.remaining,
        checkedAt: q.checkedAt as string,
        source: q.source,
        ...(finiteNumber(q.limit) ? { limit: q.limit } : {}),
      };
    }
  }
  const quality = parseQuality(e.quality, now);
  return {
    at: e.at as string,
    ok: e.ok,
    ...(failure ? { failure } : {}),
    ...(finiteNumber(e.latencyMs) ? { latencyMs: e.latencyMs } : {}),
    ...(quota ? { quota } : {}),
    ...(typeof e.model === "string" && e.model !== "" ? { model: e.model } : {}),
    ...(typeof e.scope === "string" && e.scope !== "" ? { scope: e.scope } : {}),
    ...(quality ? { quality } : {}),
  };
}

/**
 * Anything unreadable collapses to "nothing verified", so unknown candidates stay disabled.
 * Unknown candidate keys are dropped: only the declared candidates can ever be selected.
 */
export function parseHarnessStatus(raw: unknown, now: number = Date.now()): HarnessStatus {
  const candidates: Record<string, HarnessStatusEntry> = {};
  if (typeof raw !== "object" || raw === null) return { candidates };
  const list = (raw as Record<string, unknown>).candidates;
  if (typeof list !== "object" || list === null) return { candidates };
  for (const id of Object.keys(HARNESS_CANDIDATES) as HarnessCandidateId[]) {
    const entry = parseEntry((list as Record<string, unknown>)[id], now);
    if (entry) candidates[id] = entry;
  }
  return { candidates };
}

export function harnessStatusPath(env: Env = process.env): string {
  return env.JEV_ROUTER_HARNESS_STATUS ?? join(configDir(env), "orca-launch", "harness-status.json");
}

/** User-owned candidate-set switch, separate from automatic health observations. */
export type HarnessMode = "free-with-go" | "go-only" | "none";
export const HARNESS_MODES: readonly HarnessMode[] = ["free-with-go", "go-only", "none"];
const DEFAULT_MODE: HarnessMode = "free-with-go";

export function harnessModePath(env: Env = process.env): string {
  return env.JEV_ROUTER_HARNESS_MODE ?? join(configDir(env), "orca-launch", "harness-mode.json");
}

/** Anything unreadable or unknown stays on the default: the previous behaviour. */
export function parseHarnessMode(raw: unknown): HarnessMode {
  const mode = (raw as Record<string, unknown> | null)?.mode;
  return HARNESS_MODES.includes(mode as HarnessMode) ? (mode as HarnessMode) : DEFAULT_MODE;
}

export async function readHarnessMode(env: Env = process.env): Promise<HarnessMode> {
  try {
    return parseHarnessMode(JSON.parse(await readFile(harnessModePath(env), "utf8")));
  } catch {
    return DEFAULT_MODE;
  }
}

export async function readHarnessStatus(env: Env = process.env, now: number = Date.now()): Promise<HarnessStatus> {
  try {
    return parseHarnessStatus(JSON.parse(await readFile(harnessStatusPath(env), "utf8")), now);
  } catch {
    return { candidates: {} };
  }
}

/** Merge one candidate's latest observation. Used by the probe owner; selection only ever reads. */
export async function writeHarnessStatus(
  candidate: HarnessCandidateId,
  entry: HarnessStatusEntry,
  env: Env = process.env,
  now: number = Date.now(),
): Promise<string> {
  const path = harnessStatusPath(env);
  const current = await readHarnessStatus(env, now);
  const next: HarnessStatus = {
    candidates: { ...current.candidates, [candidate]: { ...entry, at: new Date(entry.at).toISOString() } },
  };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: 2, ...next }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return path;
}

/**
 * Record an observed launch failure so the next selection does not repeat it. A newer observation
 * written by the probe owner wins; this never overwrites fresher evidence.
 */
export async function recordHarnessFailure(
  candidate: HarnessCandidateId,
  kind: HarnessFailureKind,
  options: { env?: Env; at?: string; scope?: string; latencyMs?: number } = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  const at = options.at ?? new Date().toISOString();
  const now = Date.parse(at);
  const current = (await readHarnessStatus(env, now)).candidates[candidate];
  if (current && Date.parse(current.at) >= now) return false;
  await writeHarnessStatus(
    candidate,
    {
      ...current,
      at,
      ok: false,
      failure: kind,
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.latencyMs !== undefined ? { latencyMs: options.latencyMs } : {}),
    },
    env,
    now,
  );
  return true;
}

/**
 * Operational failures are separated from a quality judgement: only the latter is about the model's ability.
 * A free allowance running out is reported by OpenCode as text, not only as HTTP 429, so those messages
 * are classified as quota too; otherwise the launcher would not record the failure or move on.
 */
export function classifyHarnessFailure(text: string): HarnessFailureKind | null {
  if (/\b(?:401|403)\b|forbidden|unauthori[sz]ed|provider\.auth|invalid[_ -]?(?:api[_ -]?)?key/i.test(text)) return "auth";
  if (
    /\b429\b|rate[ _-]?limit|too many requests|quota|insufficient[_ -]?(?:balance|funds)|free[_ -]?(?:usage[ _-]?)?limit|freeusagelimiterror|provider\.free-limit|usage limit reached|無料枠|上限に達/i.test(
      text,
    )
  ) {
    return "quota";
  }
  if (/\b(?:503|529)\b|overloaded|capacity|server (?:busy|unavailable)|try again later|混雑/i.test(text)) return "congestion";
  if (
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network (?:error|unreachable)|connection (?:refused|reset|timed out)/i.test(text)
  ) {
    return "network";
  }
  return null;
}

/** The existing bounded WorkContext, built from a launch prompt or an explicit caller label. */
export interface LaunchWork {
  readonly hard: boolean;
  readonly phase: WorkPhase | "unknown";
  readonly criticalDesign: boolean;
  readonly scope?: string;
}

const TASK_ID = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-T\d+\b/;

function explicitWork(raw: string | undefined): Partial<WorkContext> & { difficulty?: number } {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const o = parsed as Record<string, unknown>;
    const phase = typeof o.phase === "string" ? (o.phase as WorkPhase) : undefined;
    return {
      ...(phase ? { phase } : {}),
      ...(typeof o.criticalDesign === "boolean" ? { criticalDesign: o.criticalDesign } : {}),
      ...(typeof o.difficulty === "number" && Number.isFinite(o.difficulty) ? { difficulty: o.difficulty } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Reuse the existing bounded work context and the policy's own hard-work threshold. A healthy
 * cheap model is not evidence that difficult work belongs on it.
 */
export function launchWork(text: string, workJson?: string): LaunchWork {
  const explicit = explicitWork(workJson);
  const request: NormalizedRequest = {
    harness: "pi",
    sessionKey: "launch",
    requestedModel: "",
    isNewUserTurn: true,
    lastUserText: text,
    toolNames: [],
    hasImages: false,
    estimatedInputTokens: 0,
    toolOutcomes: [],
  };
  const { work } = updateWorkContext(undefined, request);
  const phase = (explicit.phase ?? work.phase) as WorkPhase | "unknown";
  const criticalDesign = explicit.criticalDesign ?? work.criticalDesign;
  const scope = work.id ?? text.match(TASK_ID)?.[0];
  const hard =
    criticalDesign ||
    phase === "design" ||
    phase === "review" ||
    (explicit.difficulty !== undefined && explicit.difficulty >= HARD_DIFFICULTY);
  return { hard, phase, criticalDesign, ...(scope ? { scope } : {}) };
}

export interface SelectionInput {
  /** The declared boundary. Only the literal `implementation` may select a harness. */
  readonly role: string | undefined;
  readonly fallback: ExistingHarness;
  readonly status: HarnessStatus;
  readonly now?: number;
  /** Existing difficulty/impact judgement for this launch. */
  readonly hard?: boolean;
  /** Task id or target the quality records must match to apply. */
  readonly scope?: string;
  /** Candidates that already failed in this launch; never retried in the same run. */
  readonly exclude?: readonly HarnessCandidateId[];
  /** Nagakura's three-way switch. Default is the previous behaviour. */
  readonly mode?: HarnessMode;
}

export interface Rejection {
  readonly candidate: HarnessCandidateId;
  readonly reason: string;
}

export type HarnessSelection =
  | {
      readonly kind: "opencode";
      readonly candidate: HarnessCandidateId;
      readonly model: string;
      readonly reasons: readonly string[];
      readonly rejected: readonly Rejection[];
    }
  | {
      readonly kind: "existing";
      readonly harness: ExistingHarness;
      readonly reasons: readonly string[];
      readonly rejected: readonly Rejection[];
    };

interface Verdict {
  readonly eligible: boolean;
  readonly reason?: string;
}

function healthVerdict(entry: HarnessStatusEntry | undefined, now: number, retryCapacity = false): Verdict {
  if (!entry) return { eligible: false, reason: "unverified" };
  const at = Date.parse(entry.at);
  if (!Number.isFinite(at)) return { eligible: false, reason: "unverified" };
  if (at - now > CLOCK_SKEW_MS) return { eligible: false, reason: "health_future" };
  // Go recovers on the next boundary; Free recovers after the existing capacity window.
  // Launch-local exclusions prevent either from looping within the same request.
  if (!entry.ok && (retryCapacity || now - at > HEALTH_MAX_AGE_MS) && (entry.failure === "quota" || entry.failure === "congestion")) {
    return { eligible: true };
  }
  if (!entry.ok) {
    return {
      eligible: false,
      reason: entry.failure === "quality_insufficient" ? "quality_insufficient" : `${entry.failure ?? "unverified"}_failure`,
    };
  }
  // Verified access does not expire just because no separate probe collector refreshed it.
  return { eligible: true };
}

/**
 * A candidate only runs a model its own family allows. A paid or not-yet-verified candidate needs
 * the id the observer recorded; the incumbent free candidate still works with an older record.
 */
function modelVerdict(entry: HarnessStatusEntry | undefined, id: HarnessCandidateId): Verdict {
  const candidate = HARNESS_CANDIDATES[id];
  if (entry?.model) {
    const base = entry.model.split("#")[0] ?? entry.model;
    return candidate.family.includes(base) ? { eligible: true } : { eligible: false, reason: "model_not_allowed" };
  }
  return candidate.modelRequired ? { eligible: false, reason: "model_unverified" } : { eligible: true };
}

/**
 * The newest quality shortfall that still applies. It must be fresh and, when both sides name a
 * scope, refer to this same piece of work; an old or unrelated judgement never blocks a new task.
 */
function qualityVerdict(entry: HarnessStatusEntry | undefined, now: number, scope: string | undefined): Verdict {
  if (!entry) return { eligible: true };
  const records: QualityObservation[] = [...(entry.quality ?? [])];
  if (entry.failure === "quality_insufficient") records.push({ at: entry.at, ...(entry.scope ? { scope: entry.scope } : {}) });
  const applicable = records
    .map((r) => ({ r, t: Date.parse(r.at) }))
    .filter(({ t }) => Number.isFinite(t) && t - now <= CLOCK_SKEW_MS)
    .filter(({ t }) => now - t <= QUALITY_MAX_AGE_MS)
    .filter(({ r }) => r.scope === undefined || r.scope === scope)
    .sort((a, b) => b.t - a.t);
  const latest = applicable[0];
  if (!latest) return { eligible: true };
  return { eligible: false, reason: "quality_insufficient" };
}

/** How a candidate id appears in the recorded reasons; kept stable for existing readers. */
const REASON_TAG: Readonly<Record<HarnessCandidateId, string>> = {
  "opencode-free": "free",
  "opencode-free-glm": "free_glm",
  "opencode-go": "go",
  "opencode-go-glm": "go_glm",
};

/**
 * Group 1 (free) in order, then group 2 (Go) when a free candidate lost capacity, then the existing
 * Pi/Claude route. Each candidate is judged on its own record, so an exhausted free model does not
 * disable the other free model and an unverified Go model never authorises spending.
 *
 * Auth or network failures are not capacity, and work the existing judgement calls hard never
 * touches either group: it goes straight to Pi.
 */
export function selectHarness(input: SelectionInput): HarnessSelection {
  const now = input.now ?? Date.now();
  const existing = (reasons: string[], rejected: Rejection[] = []): HarnessSelection => ({
    kind: "existing",
    harness: input.fallback,
    reasons,
    rejected,
  });
  if (input.role !== "implementation") return existing(["role_not_implementation"]);

  const mode = input.mode ?? "free-with-go";
  if (mode === "none") return existing(["role_explicit_implementation", "mode_none"]);

  const excluded = new Set(input.exclude ?? []);
  const verdicts = new Map<HarnessCandidateId, string | undefined>();
  for (const id of CANDIDATE_ORDER) {
    const entry = input.status.candidates[id];
    const candidate = HARNESS_CANDIDATES[id];
    const health = healthVerdict(entry, now, candidate.group === 2);
    const model = modelVerdict(entry, id);
    const quality = qualityVerdict(entry, now, input.scope);
    const skipped = mode === "go-only" && candidate.group === 1 ? "mode_go_only" : undefined;
    verdicts.set(
      id,
      (excluded.has(id) ? "excluded_after_failure" : undefined) ??
        skipped ??
        (!health.eligible ? (health.reason as string) : undefined) ??
        (!model.eligible ? (model.reason as string) : undefined) ??
        (!quality.eligible ? (quality.reason as string) : undefined),
    );
  }

  const free = CANDIDATE_ORDER.filter((id) => HARNESS_CANDIDATES[id].group === 1);
  const paid = CANDIDATE_ORDER.filter((id) => HARNESS_CANDIDATES[id].group === 2);
  const reasonOf = (id: HarnessCandidateId) => verdicts.get(id);
  const rejections: Rejection[] = CANDIDATE_ORDER.filter((id) => reasonOf(id) !== undefined).map((id) => ({
    candidate: id,
    reason: reasonOf(id) as string,
  }));
  const freeTags = free.filter((id) => reasonOf(id) !== undefined).map((id) => `${REASON_TAG[id]}_${reasonOf(id)}`);
  const paidTags = paid.filter((id) => reasonOf(id) !== undefined).map((id) => `${REASON_TAG[id]}_${reasonOf(id)}`);
  const chosen = (id: HarnessCandidateId): HarnessSelection => ({
    kind: "opencode",
    candidate: id,
    model: input.status.candidates[id]?.model ?? HARNESS_CANDIDATES[id].model,
    reasons: [
      "role_explicit_implementation",
      HARNESS_CANDIDATES[id].group === 1 ? "free_verified" : "go_verified",
      // Why the candidates ahead of this one were passed over stays visible to the operator.
      ...CANDIDATE_ORDER.filter((other) => other !== id && reasonOf(other) !== undefined).map(
        (other) => `${REASON_TAG[other]}_${reasonOf(other)}`,
      ),
    ],
    rejected: rejections.filter((r) => r.candidate !== id),
  });

  if (input.hard) {
    return existing(
      ["role_explicit_implementation", ...freeTags, "hard_work_pi", ...(paidTags.length > 0 ? paidTags : ["go_skipped_hard_work"])],
      rejections,
    );
  }

  const freePick = free.find((id) => reasonOf(id) === undefined);
  if (freePick) return chosen(freePick);

  // Capacity is what unlocks the paid plan: a free model running out, throttling, congestion, a
  // recorded quality shortfall for this same work, or the operator's own go-only switch.
  const freeShortfall = free.some((id) => {
    const reason = reasonOf(id);
    return (
      reason === "quota_failure" ||
      reason === "congestion_failure" ||
      reason === "quality_insufficient" ||
      reason === "excluded_after_failure" ||
      reason === "mode_go_only"
    );
  });
  if (freeShortfall) {
    const paidPick = paid.find((id) => reasonOf(id) === undefined);
    if (paidPick) {
      return {
        ...chosen(paidPick),
        reasons: ["role_explicit_implementation", ...freeTags, "go_verified"],
      };
    }
  }
  return existing(
    [
      "role_explicit_implementation",
      ...freeTags,
      ...paidTags,
      // Paid capacity was available but the free shortfall was not a capacity one: nothing to spend.
      ...(freeShortfall ? ["go_none_verified"] : ["go_withheld_operational"]),
    ],
    rejections,
  );
}

/** Windows publishes opencode through npm; elsewhere it is on PATH. */
function opencodeExecutable(env: Env): string {
  if (env.OPENCODE_BIN) return env.OPENCODE_BIN;
  const npm = env.APPDATA ? join(env.APPDATA, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe") : undefined;
  return npm && existsSync(npm) ? npm : "opencode";
}

/** The launcher's caller must not pin a model or an effort by hand; only the selection may set one. */
const MODEL_VALUE_FLAGS = ["--model", "-m"];
const MODEL_BOOLEAN_FLAGS = ["--thinking"];

export function stripModelFlags(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (MODEL_BOOLEAN_FLAGS.includes(a)) continue;
    if (MODEL_VALUE_FLAGS.includes(a)) {
      i++;
      continue;
    }
    if (MODEL_VALUE_FLAGS.some((f) => a.startsWith(`${f}=`))) continue;
    out.push(a);
  }
  return out;
}

/**
 * A delegated worker must not stall on a permission prompt; Pi already starts with `--approve`.
 * `--agent build` keeps the role OpenCode uses by default, so a stale config cannot switch it.
 */
export function workerArgs(args: readonly string[]): string[] {
  const out = stripModelFlags(args);
  const has = (flag: string) => out.some((a) => a === flag || a.startsWith(`${flag}=`));
  if (!has("--auto")) out.unshift("--auto");
  if (!has("--agent")) out.unshift("--agent", "build");
  return out;
}

export interface ImplementationCall {
  /** `tui` keeps OpenCode's interactive arguments; `run` is the non-interactive PM shape. */
  readonly shape: "tui" | "run";
  readonly args: readonly string[];
  readonly prompt?: string;
  /** Caller flags OpenCode cannot accept. Reported, never silently discarded. */
  readonly dropped: readonly string[];
}

/** Flags OpenCode's `run` accepts (after `stripModelFlags`); anything else came from a Pi/Claude call. */
const RUN_VALUE_FLAGS = ["--format", "-s", "--session", "--title", "-f", "--file", "--server", "--agent"];
const RUN_BOOLEAN_FLAGS = ["--standalone", "--continue", "-c", "--fork", "--auto"];

/**
 * Translate the caller's shape into OpenCode's own. Only the documented Pi-compatible
 * non-interactive form (`-p`/`--print`, prompt inline or on stdin) is translated; everything
 * else keeps the interactive form and is passed through unchanged.
 */
export function implementationCall(args: readonly string[], stdinPrompt?: string): ImplementationCall {
  const print = args.findIndex((a) => a === "-p" || a === "--print" || a.startsWith("--print="));
  if (print < 0) return { shape: "tui", args: workerArgs(args), dropped: [] };
  const inline = args[print]?.startsWith("--print=")
    ? args[print]?.slice("--print=".length)
    : args[print + 1]?.startsWith("-")
      ? undefined
      : args[print + 1];
  const prompt = (inline && inline.length > 0 ? inline : stdinPrompt)?.trim();
  const kept: string[] = [];
  const dropped: string[] = [];
  const rest = args.filter((_, i) => i !== print && (inline === undefined || i !== print + 1) && !args[i]?.startsWith("--print="));
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (MODEL_BOOLEAN_FLAGS.includes(a)) {
      dropped.push(a);
      continue;
    }
    if (MODEL_VALUE_FLAGS.includes(a)) {
      dropped.push(a, rest[i + 1] ?? "");
      i++;
      continue;
    }
    if (a.startsWith("--print")) continue;
    if (RUN_BOOLEAN_FLAGS.includes(a)) {
      if (!(a === "--auto" && kept.includes("--auto"))) kept.push(a);
      continue;
    }
    if (RUN_VALUE_FLAGS.includes(a) && rest[i + 1] !== undefined && !rest[i + 1]?.startsWith("-")) {
      kept.push(a, rest[i + 1] as string);
      i++;
      continue;
    }
    if (RUN_VALUE_FLAGS.some((f) => a.startsWith(`${f}=`))) {
      kept.push(a);
      continue;
    }
    if (a.startsWith("-")) dropped.push(a);
  }
  if (!kept.includes("--auto")) kept.push("--auto");
  if (!kept.some((a) => a === "--agent" || a.startsWith("--agent="))) kept.push("--agent", "build");
  return { shape: "run", args: ["run", ...kept], ...(prompt ? { prompt } : {}), dropped };
}

/**
 * What to do after a non-zero OpenCode exit. Capacity losses may be retried once on the next
 * candidate, but only in the non-interactive shape and only when the workspace is clean: two
 * harnesses must never edit the same working tree. Anything else stops and hands over.
 *
 * Non-capacity failures (including silent output) go directly to Pi on a clean run, without
 * trying another OpenCode candidate or fabricating an observation in the status file.
 */
export function retryDecision(
  kind: HarnessFailureKind | "no_output" | null,
  shape: "tui" | "run",
  workspaceDirty: boolean,
): "retry" | "fallback" | "handoff" | "stop" {
  if (shape !== "run") return "stop";
  if (workspaceDirty) return "handoff";
  return kind === "quota" || kind === "congestion" ? "retry" : "fallback";
}

/** Keep every existing OpenCode setting and change only the model this boundary selected. */
export function opencodeOverlay(model: string, existing?: string): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (typeof parsed === "object" && parsed !== null) base = parsed as Record<string, unknown>;
    } catch {
      /* an unreadable overlay is replaced: the selected model must be the one that runs */
    }
  }
  return JSON.stringify({ ...base, model, small_model: model });
}

export interface LaunchRecord {
  readonly role: string;
  readonly selected: "opencode" | ExistingHarness;
  readonly candidate: string | null;
  /** The model this launch asked OpenCode to run. */
  readonly plannedModel: string | null;
  /** Only set once an observation exists; a plan is not an applied model. */
  readonly appliedModel: null;
  /** Effort is not applied through this path; null rather than a guess. */
  readonly effort: null;
  /** True only after the child was spawned successfully; the planner cannot know it. */
  readonly launchOk: null;
  /** True only when the caller's own test/verification passed; never guessed here. */
  readonly workOk: null;
  readonly reasons: readonly string[];
  readonly rejected: readonly Rejection[];
  readonly quota: QuotaObservation | null;
  readonly fallback: boolean;
  readonly scope: string | null;
  readonly hard: boolean;
}

export type HarnessLaunch =
  | {
      readonly kind: "opencode";
      readonly executable: string;
      readonly args: readonly string[];
      readonly call: ImplementationCall;
      readonly env: Record<string, string | undefined>;
      readonly record: LaunchRecord;
    }
  | {
      readonly kind: "existing";
      readonly harness: ExistingHarness;
      readonly record: LaunchRecord;
    };

export interface LaunchInput {
  readonly env: Env;
  readonly args: readonly string[];
  readonly status?: HarnessStatus;
  readonly now?: number;
  /** Work context the caller already knows; otherwise derived from the prompt. */
  readonly work?: LaunchWork;
  readonly stdinPrompt?: string;
  /** Snapshot for retries within one boundary; otherwise read the user file now. */
  readonly mode?: HarnessMode;
  readonly exclude?: readonly HarnessCandidateId[];
}

const existingHarness = (env: Env): ExistingHarness => {
  const wanted = env.JEV_HARNESS_FALLBACK;
  if (wanted === "claude" || wanted === "pi") return wanted;
  return "pi";
};

const promptText = (args: readonly string[], stdinPrompt?: string): string => {
  const print = args.findIndex((a) => a === "-p" || a === "--print");
  const inline = print >= 0 && !args[print + 1]?.startsWith("-") ? (args[print + 1] as string) : undefined;
  return inline ?? stdinPrompt ?? args.filter((a) => !a.startsWith("-")).join(" ");
};

/** Resolve one explicit implementation launch into either an OpenCode command or the unchanged Pi/Claude route. */
export async function resolveHarnessLaunch(input: LaunchInput): Promise<HarnessLaunch> {
  const env = input.env;
  const now = input.now ?? Date.now();
  const fallback = existingHarness(env);
  const work = input.work ?? launchWork(promptText(input.args, input.stdinPrompt), env.JEV_LAUNCH_WORK);
  const status = input.status ?? (await readHarnessStatus(env, now));
  const selection = selectHarness({
    role: "implementation",
    fallback,
    status,
    mode: input.mode ?? (await readHarnessMode(env)),
    now,
    hard: work.hard,
    ...(work.scope ? { scope: work.scope } : {}),
    ...(input.exclude ? { exclude: input.exclude } : {}),
  });
  const base = {
    role: "implementation",
    appliedModel: null,
    effort: null,
    launchOk: null,
    workOk: null,
    reasons: selection.reasons,
    rejected: selection.rejected,
    scope: work.scope ?? null,
    hard: work.hard,
  } as const;
  if (selection.kind === "existing") {
    return {
      kind: "existing",
      harness: selection.harness,
      record: { ...base, selected: selection.harness, candidate: null, plannedModel: null, quota: null, fallback: true },
    };
  }
  const candidate = selection.candidate;
  const call = implementationCall(input.args, input.stdinPrompt);
  const childEnv: Record<string, string | undefined> = {
    ...env,
    OPENCODE_CONFIG_CONTENT: opencodeOverlay(selection.model, env.OPENCODE_CONFIG_CONTENT),
    JEV_ROUTER_HARNESS: candidate,
  };
  delete childEnv.JEV_ROUTER_LAUNCH_ID;
  return {
    kind: "opencode",
    executable: opencodeExecutable(env),
    args: call.prompt ? [...call.args, call.prompt] : call.args,
    call,
    env: childEnv,
    record: {
      ...base,
      selected: "opencode",
      candidate,
      plannedModel: selection.model,
      quota: status.candidates[candidate]?.quota ?? null,
      fallback: false,
    },
  };
}
