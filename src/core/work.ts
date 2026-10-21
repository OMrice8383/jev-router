import { isInfrastructureFailure } from "./signals/failure";
import type { NormalizedRequest } from "./types";

export type WorkPhase = "unknown" | "investigation" | "design" | "implementation" | "validation" | "review" | "complete";
export type WorkBoundary = "new_task" | "phase_change" | "problem_resolved";
export interface WorkContext {
  readonly id?: string;
  readonly goal: string;
  readonly phase: WorkPhase;
  readonly nextAction: string;
  readonly completion: string;
  readonly targets: string;
  readonly criticalDesign: boolean;
  readonly failure?: { readonly kind: "infrastructure" | "task"; readonly reason: string };
}

/** Preserve both the purpose and the latest requirement, rather than only an old preamble. */
export function headAndTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 5) / 2);
  return `${text.slice(0, half)}\n...\n${text.slice(-(limit - half - 5))}`;
}

export function isContinuation(text: string): boolean {
  return (
    text.trim().length < 160 &&
    /^(?:続けて(?:ください)?|続行(?:して)?|続きを|そのまま|再開|了解|はい|ok|yes|continue(?: (?:existing work|current task|the same task))?|resume(?:d)?|proceed|next(?: step)?|go on|hello|hi|こんにちは|ありがとう)[\s.!。！]*$|起動し直した.{0,12}続けて/i.test(
      text.trim(),
    )
  );
}

function field(text: string, labels: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const label = new RegExp(`^(?:${labels})(?:\\s*[:：]\\s*(.*)|\\s*)$`, "i");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim().replace(/^[#*■\-\s]+/, "") ?? "";
    const match = label.exec(line);
    if (match) return headAndTail(match[1]?.trim() || lines[i + 1]?.trim() || "", 400);
  }
  return undefined;
}

function phaseOf(text: string | undefined): WorkPhase | undefined {
  if (!text) return undefined;
  if (/^(?:complete|done|完了|終了)$/i.test(text.trim())) return "complete";
  if (/review|decision|decide|レビュー|判断|決定/i.test(text)) return "review";
  if (/validation|testing|verify|検証|テスト/i.test(text)) return "validation";
  if (/implementation|implement|実装|確定済み実装/i.test(text)) return "implementation";
  if (/design|設計/i.test(text)) return "design";
  if (/investigation|diagnos|debug|調査|原因究明/i.test(text)) return "investigation";
  return undefined;
}

/** Use the harness's existing messages/state, not an extra summarizer or the whole PM database. */
export function updateWorkContext(
  previous: WorkContext | undefined,
  request: NormalizedRequest,
): { work: WorkContext; boundary?: WorkBoundary } {
  const user = request.lastUserText?.trim() ?? "";
  const meaningful = request.isNewUserTurn && user.length > 0 && !isContinuation(user);
  const source = meaningful ? user : (request.taskText ?? "");
  const explicitGoal = field(source, "goal|purpose|目的|Taskの目的");
  const goal = explicitGoal || (source ? headAndTail(source, 600) : (previous?.goal ?? ""));
  const idText = field(source, "task|task id|担当Task|TaskID") ?? source.split("\n", 1)[0] ?? "";
  const foundId = idText.match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-T\d+\b/)?.[0];
  const explicitId = foundId && foundId.length <= 96 ? foundId : undefined;
  const sourcePhaseText = field(source, "phase|current phase|現在工程|現在の工程|工程");
  const phaseUpdate = previous && !explicitGoal && !explicitId && (!!sourcePhaseText || /設計.{0,12}完了|原因.{0,12}判明/.test(user));
  const newTask =
    meaningful && !phaseUpdate && (!previous || (explicitId && previous.id ? explicitId !== previous.id : goal !== previous.goal));
  const id = explicitId ?? (newTask ? undefined : previous?.id);
  const base = newTask ? undefined : previous;
  const intent = request.assistantIntentTail ?? "";
  const sourcePhase = phaseOf(sourcePhaseText) ?? (phaseUpdate ? phaseOf(user) : undefined);
  const phase =
    (meaningful ? sourcePhase : undefined) ??
    (!newTask ? phaseOf(field(intent, "phase|current phase|現在工程|現在の工程|工程")) : undefined) ??
    (!base ? sourcePhase : undefined) ??
    base?.phase ??
    phaseOf(goal.split("\n", 1)[0]) ??
    "unknown";
  const resolved =
    !newTask &&
    (base?.phase === "investigation" || base?.phase === "design") &&
    /原因.{0,12}(?:判明|解決)|方針.{0,8}確定|(?:root cause|problem).{0,25}(?:resolved|identified)|confirmed (?:fix|implementation)/i.test(
      intent,
    );
  const actualPhase = resolved && phase === base?.phase ? "implementation" : phase;
  const work: WorkContext = {
    ...(id ? { id } : {}),
    goal: newTask || !base ? goal : (explicitGoal ?? base.goal),
    phase: actualPhase,
    nextAction: meaningful
      ? (field(source, "next action|next|次の操作|次の一手|次にする操作") ?? headAndTail(user, 400))
      : (field(intent, "next action|next|次の操作|次の一手|次にする操作") ??
        field(source, "next action|next|次の操作|次の一手|次にする操作") ??
        (intent.slice(-400) || base?.nextAction || "")),
    completion: field(source, "done|completion|acceptance|完了条件|完成条件") ?? base?.completion ?? "",
    targets: field(source, "targets?|scope|変更対象|対象|触ってよい範囲") ?? base?.targets ?? "",
    criticalDesign: false,
  };
  const failed = request.toolOutcomes.filter((o) => o.isError).at(-1);
  const failure = failed
    ? {
        kind: isInfrastructureFailure(failed) ? ("infrastructure" as const) : ("task" as const),
        reason: (failed.errorText ?? failed.excerpt ?? "").slice(-200),
      }
    : request.toolOutcomes.length === 0
      ? base?.failure
      : undefined;
  const operation = `${work.goal} ${work.nextAction}`.replace(/\bno (?:new )?(?:design|security|migration)(?: (?:decision|change))?/gi, "");
  const routineCheck =
    /already[- ]approved|confirmed|settled|known expected|手順|確認済|確定済|既知/i.test(operation) &&
    /fixture|expected values|check the|照合|一致|テスト/i.test(operation) &&
    !/undecided|unexplained|uncertain|vulnerabilit|threat|decide whether|未確定|原因不明|判断する|脆弱/i.test(operation);
  const criticalDesign =
    !routineCheck &&
    (actualPhase === "design" ||
      (actualPhase === "review" &&
        /\b(?:design|decide|decision|boundar(?:y|ies)|isolation|rollback)\b|設計|境界|分離|重大|不可逆|判断/i.test(operation))) &&
    /\b(?:auth(?:entication|orization)?|permissions?|payments?|migrat(?:e|ion)s?)\b|認証|権限|決済|移行/i.test(
      work.goal + " " + work.targets,
    );
  const boundary = newTask ? "new_task" : resolved ? "problem_resolved" : base && actualPhase !== base.phase ? "phase_change" : undefined;
  return { work: { ...work, criticalDesign, ...(failure ? { failure } : {}) }, ...(boundary ? { boundary } : {}) };
}
