import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import type { DecisionRecord } from "../core/record";
import { configDir, type Env, resolvePolicyPath } from "./paths";

const LAUNCH_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** Capture identifiers only, never credentials, prompts, settings or the policy itself (ASVS 16.2.5). */
export async function prepareLaunchAudit(kind: "pi" | "claude", env: Env = process.env): Promise<string> {
  const raw = await readFile(await resolvePolicyPath(env), "utf8");
  const policy = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const harness = kind === "pi" ? "pi" : "claude-code";
  const route = policy.routes.find((r: { harness: string }) => r.harness === harness);
  const ids: string[] = policy.policies[route.policy].order;
  const id = randomUUID();
  const dir = join(configDir(env), "orca-launch", "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `launch-${id}.json`),
    JSON.stringify({
      at: new Date().toISOString(),
      host: hostname(),
      cwd: process.cwd(),
      terminal: env.ORCA_TERMINAL_HANDLE ?? null,
      terminalName: env.ORCA_TERMINAL_TITLE ?? basename(process.cwd()),
      kind,
      policyHash: createHash("sha256").update(raw).digest("hex"),
      candidates: ids.map((candidate) => ({ id: candidate, model: policy.candidates[candidate].model })),
    }),
    { mode: 0o600, flag: "wx" },
  );
  return id;
}

/** One immutable JSONL row per launch, after the first main request actually succeeded. */
export async function recordLaunchSelection(record: DecisionRecord, home = configDir()): Promise<void> {
  const id = record.launchId;
  if (!id || !LAUNCH_ID.test(id) || record.apply?.ok !== true || (record.requestClass && record.requestClass !== "main")) return;
  const context = JSON.parse(await readFile(join(home, "orca-launch", "sessions", `launch-${id}.json`), "utf8"));
  const served = record.cascade?.served ?? record.shadow?.served ?? record.decision.candidate;
  const attempt = record.cascade ? [...record.cascade.attempts].reverse().find((a) => a.candidate === served) : undefined;
  const candidate = context.candidates.find((c: { id: string }) => c.id === served);
  const score = (key: string): number | null => {
    const answer = record.judge?.answers?.[key];
    return answer?.type === "score" && Number.isFinite(answer.score) ? answer.score : null;
  };
  const row = {
    launchId: id,
    at: context.at,
    selectedAt: new Date(record.ts).toISOString(),
    host: context.host,
    cwd: context.cwd,
    terminal: context.terminal,
    terminalName: context.terminalName,
    kind: context.kind,
    weight: { difficulty: score("difficulty"), stakes: score("stakes") },
    model: attempt?.model ?? (served === record.decision.candidate ? record.decision.model : (candidate?.model ?? null)),
    effort: attempt?.effort ?? (served === record.decision.candidate ? (record.decision.effort ?? null) : null),
    candidates: context.candidates.map((c: { id: string; model: string }) => ({ id: c.id, model: c.model })),
    policyHash: context.policyHash,
    ...(record.loadedPolicyHash ? { loadedPolicyHash: record.loadedPolicyHash, routingRevision: record.routingRevision } : {}),
    ...(record.task ? { task: record.task } : {}),
    source: record.decision.source,
    reasons: record.decision.reasons,
  };
  const dir = join(home, "orca-launch", "selections");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, `${id}.jsonl`), `${JSON.stringify(row)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
