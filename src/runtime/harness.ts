import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir, type Env } from "./paths";

/**
 * Execution-harness selection at an explicitly declared implementation boundary.
 * It reuses the existing launcher, policy and logs; it is not a second decision engine and it never
 * guesses a role from prompts or terminals.
 */

export type HarnessFailureKind = "auth" | "quota" | "network" | "quality_insufficient";

export interface QuotaObservation {
  /** Remaining allowance in whatever unit `source` reports. Never inferred from one successful call. */
  readonly remaining: number;
  /** When the source was read, not when this file was written. */
  readonly checkedAt: string;
  /** Where the number came from, for the operator. No credentials, no URLs with tokens. */
  readonly source: string;
  readonly limit?: number;
}

export interface HarnessStatusEntry {
  readonly at: string;
  readonly ok: boolean;
  /** Why it is not ok. `quality_insufficient` is a judgement call, the others are operational. */
  readonly failure?: HarnessFailureKind;
  readonly latencyMs?: number;
  readonly quota?: QuotaObservation;
}

export interface HarnessStatus {
  readonly candidates: Readonly<Record<string, HarnessStatusEntry>>;
}

export type HarnessCandidateId = "opencode-free" | "opencode-go";

export const HARNESS_CANDIDATES = {
  "opencode-free": { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
  "opencode-go": { harness: "opencode", model: "opencode-go/glm-5.3-flash" },
} as const satisfies Record<HarnessCandidateId, { harness: "opencode"; model: string }>;

/** A healthy probe older than this is treated as unknown, not as still healthy. */
export const HEALTH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Remaining allowance changes within a working day, so it expires sooner than a plain health check. */
export const QUOTA_MAX_AGE_MS = 60 * 60 * 1000;

export type ExistingHarness = "pi" | "claude";

const FAILURE_KINDS: readonly HarnessFailureKind[] = ["auth", "quota", "network", "quality_insufficient"];

const finiteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const isoTime = (v: unknown): number | undefined => {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
};

function parseEntry(raw: unknown): HarnessStatusEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const e = raw as Record<string, unknown>;
  const at = isoTime(e.at);
  if (at === undefined || typeof e.ok !== "boolean") return undefined;
  const failure =
    typeof e.failure === "string" && FAILURE_KINDS.includes(e.failure as HarnessFailureKind)
      ? (e.failure as HarnessFailureKind)
      : undefined;
  const quotaRaw = e.quota;
  let quota: QuotaObservation | undefined;
  if (typeof quotaRaw === "object" && quotaRaw !== null) {
    const q = quotaRaw as Record<string, unknown>;
    if (finiteNumber(q.remaining) && isoTime(q.checkedAt) !== undefined && typeof q.source === "string" && q.source !== "") {
      quota = {
        remaining: q.remaining,
        checkedAt: q.checkedAt as string,
        source: q.source,
        ...(finiteNumber(q.limit) ? { limit: q.limit } : {}),
      };
    }
  }
  return {
    at: e.at as string,
    ok: e.ok,
    ...(failure ? { failure } : {}),
    ...(finiteNumber(e.latencyMs) ? { latencyMs: e.latencyMs } : {}),
    ...(quota ? { quota } : {}),
  };
}

/**
 * Anything unreadable collapses to "nothing verified", so unknown candidates stay disabled.
 * Unknown candidate keys are dropped: only the declared candidates can ever be selected.
 */
export function parseHarnessStatus(raw: unknown): HarnessStatus {
  const candidates: Record<string, HarnessStatusEntry> = {};
  if (typeof raw !== "object" || raw === null) return { candidates };
  const list = (raw as Record<string, unknown>).candidates;
  if (typeof list !== "object" || list === null) return { candidates };
  for (const id of Object.keys(HARNESS_CANDIDATES) as HarnessCandidateId[]) {
    const entry = parseEntry((list as Record<string, unknown>)[id]);
    if (entry) candidates[id] = entry;
  }
  return { candidates };
}

export function harnessStatusPath(env: Env = process.env): string {
  return env.JEV_ROUTER_HARNESS_STATUS ?? join(configDir(env), "orca-launch", "harness-status.json");
}

export async function readHarnessStatus(env: Env = process.env): Promise<HarnessStatus> {
  try {
    return parseHarnessStatus(JSON.parse(await readFile(harnessStatusPath(env), "utf8")));
  } catch {
    return { candidates: {} };
  }
}

/** Merge one candidate's latest observation. Used by the probe owner; selection only ever reads. */
export async function writeHarnessStatus(
  candidate: HarnessCandidateId,
  entry: HarnessStatusEntry,
  env: Env = process.env,
): Promise<string> {
  const path = harnessStatusPath(env);
  const current = await readHarnessStatus(env);
  const next: HarnessStatus = {
    candidates: { ...current.candidates, [candidate]: { ...entry, at: new Date(entry.at).toISOString() } },
  };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return path;
}

/** Operational failures are separated from a quality judgement: only the latter justifies a paid upgrade. */
export function classifyHarnessFailure(text: string): HarnessFailureKind | null {
  if (/\b(?:401|403)\b|forbidden|unauthori[sz]ed|provider\.auth|invalid[_ -]?(?:api[_ -]?)?key/i.test(text)) return "auth";
  if (/\b429\b|rate[ _-]?limit|too many requests|quota|insufficient[_ -]?(?:balance|funds)/i.test(text)) return "quota";
  if (
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network (?:error|unreachable)|connection (?:refused|reset|timed out)/i.test(text)
  ) {
    return "network";
  }
  return null;
}

export interface SelectionInput {
  /** The declared boundary. Only the literal `implementation` may select a harness. */
  readonly role: string | undefined;
  readonly fallback: ExistingHarness;
  readonly status: HarnessStatus;
  readonly now?: number;
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

function healthVerdict(entry: HarnessStatusEntry | undefined, now: number): Verdict {
  if (!entry) return { eligible: false, reason: "unverified" };
  if (!entry.ok) {
    return {
      eligible: false,
      reason: entry.failure === "quality_insufficient" ? "quality_insufficient" : `${entry.failure ?? "unverified"}_failure`,
    };
  }
  const at = Date.parse(entry.at);
  if (!Number.isFinite(at) || now - at > HEALTH_MAX_AGE_MS) return { eligible: false, reason: "health_stale" };
  return { eligible: true };
}

/** Go needs a numeric remainder read recently from a stated source; a success or token count is not one. */
function quotaVerdict(entry: HarnessStatusEntry | undefined, now: number): Verdict {
  const quota = entry?.quota;
  if (!quota) return { eligible: false, reason: "quota_unknown" };
  const checkedAt = Date.parse(quota.checkedAt);
  if (!Number.isFinite(checkedAt) || now - checkedAt > QUOTA_MAX_AGE_MS) return { eligible: false, reason: "quota_stale" };
  if (!(quota.remaining > 0)) return { eligible: false, reason: "quota_exhausted" };
  return { eligible: true };
}

/**
 * Free first. Go only after an explicit quality/velocity shortfall, and only with a fresh verified
 * remainder. Operational failures fall back to the existing Pi/Claude route instead of spending more.
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

  const free = input.status.candidates["opencode-free"];
  const go = input.status.candidates["opencode-go"];
  const freeVerdict = healthVerdict(free, now);
  const goHealth = healthVerdict(go, now);
  const goQuota = quotaVerdict(go, now);
  const goVerdict: Verdict =
    goHealth.eligible && goQuota.eligible
      ? { eligible: true }
      : !goHealth.eligible
        ? { eligible: false, reason: goHealth.reason ?? "ineligible" }
        : { eligible: false, reason: goQuota.reason ?? "ineligible" };
  const rejections: Rejection[] = [];
  if (!freeVerdict.eligible) rejections.push({ candidate: "opencode-free", reason: freeVerdict.reason as string });
  if (!goVerdict.eligible) rejections.push({ candidate: "opencode-go", reason: goVerdict.reason as string });

  if (freeVerdict.eligible) {
    return {
      kind: "opencode",
      candidate: "opencode-free",
      model: HARNESS_CANDIDATES["opencode-free"].model,
      reasons: ["role_explicit_implementation", "free_verified"],
      rejected: rejections,
    };
  }
  // A paid candidate is only unlocked by a recorded shortfall in Free's output, never by an outage.
  if (freeVerdict.reason === "quality_insufficient" && goVerdict.eligible) {
    return {
      kind: "opencode",
      candidate: "opencode-go",
      model: HARNESS_CANDIDATES["opencode-go"].model,
      reasons: ["role_explicit_implementation", "free_quality_insufficient", "go_quota_verified"],
      rejected: rejections,
    };
  }
  // Go being ready is not a reason to spend: an outage or a bad credential is not a quality shortfall.
  return existing(
    [
      "role_explicit_implementation",
      `free_${freeVerdict.reason}`,
      goVerdict.eligible ? "go_withheld_operational" : `go_${goVerdict.reason ?? "ineligible"}`,
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
  readonly requestedModel: string | null;
  readonly appliedModel: string | null;
  /** Effort is not applied through this path; null rather than a guess. */
  readonly effort: null;
  readonly reasons: readonly string[];
  readonly rejected: readonly Rejection[];
  readonly quota: QuotaObservation | null;
  readonly fallback: boolean;
}

export type HarnessLaunch =
  | {
      readonly kind: "opencode";
      readonly executable: string;
      readonly args: readonly string[];
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
}

const existingHarness = (env: Env): ExistingHarness => {
  const wanted = env.JEV_HARNESS_FALLBACK;
  if (wanted === "claude" || wanted === "pi") return wanted;
  return "pi";
};

/** Resolve one explicit implementation launch into either an OpenCode command or the unchanged Pi/Claude route. */
export async function resolveHarnessLaunch(input: LaunchInput): Promise<HarnessLaunch> {
  const env = input.env;
  const fallback = existingHarness(env);
  const status = input.status ?? (await readHarnessStatus(env));
  const selection = selectHarness({ role: "implementation", fallback, status, ...(input.now ? { now: input.now } : {}) });
  if (selection.kind === "existing") {
    return {
      kind: "existing",
      harness: selection.harness,
      record: {
        role: "implementation",
        selected: selection.harness,
        candidate: null,
        requestedModel: null,
        appliedModel: null,
        effort: null,
        reasons: selection.reasons,
        rejected: selection.rejected,
        quota: null,
        fallback: true,
      },
    };
  }
  const candidate = selection.candidate;
  const childEnv: Record<string, string | undefined> = {
    ...env,
    OPENCODE_CONFIG_CONTENT: opencodeOverlay(selection.model, env.OPENCODE_CONFIG_CONTENT),
    JEV_ROUTER_HARNESS: candidate,
  };
  delete childEnv.JEV_ROUTER_LAUNCH_ID;
  return {
    kind: "opencode",
    executable: opencodeExecutable(env),
    args: stripModelFlags(input.args),
    env: childEnv,
    record: {
      role: "implementation",
      selected: "opencode",
      candidate,
      requestedModel: HARNESS_CANDIDATES[candidate].model,
      appliedModel: HARNESS_CANDIDATES[candidate].model,
      effort: null,
      reasons: selection.reasons,
      rejected: selection.rejected,
      quota: status.candidates[candidate]?.quota ?? null,
      fallback: false,
    },
  };
}
