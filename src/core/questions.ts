import type { Question } from "../judge/types";
import type { Candidate } from "./policy/types";

/** Asked on each new user turn against the task dossier. */
export function taskPhaseQuestions(): Readonly<Record<string, Question>> {
  return {
    difficulty: {
      type: "score",
      instructions:
        "Rate the reasoning, uncertainty and unclear causes in the CURRENT operation described by work.goal, phase and nextAction. File count, project importance and a PM role are not difficulty. Following a confirmed design can be routine even across many files.",
      criteria: [
        "Trivial: a bounded check, lookup or mechanical operation with a known answer",
        "Routine: ordinary implementation or investigation with a clear approach and checkable results",
        "Substantial: unresolved alternatives or a cause requiring nontrivial reasoning, but a bounded investigation",
        "Deep: difficult design trade-offs, unexplained failures, or task evidence that the middle tier could not solve it",
      ],
    },
    needs_reasoning: {
      type: "noul",
      instructions:
        "Does the CURRENT next operation require extended reasoning? Judge reasoning effort separately from model capability. A capable model need not use high effort. Confirmed implementation steps and routine checks normally do not need high effort.",
    },
    stakes: {
      type: "score",
      instructions:
        "Rate the actual blast radius, reversibility and verifiability of THIS operation, not the importance of the whole project. Local code/build/test changes are not equivalent to irreversible production data operations. Important security design or review belongs in critical_design_review; routine implementation of an approved design does not.",
      criteria: [
        "Cosmetic/read-only: easily inspected and undone, no consequential external effect",
        "Local reversible: isolated implementation or tests, with a clear check and rollback",
        "Bounded consequential change: a wider but reversible effect with validation and recovery available",
        "Critical operation: broad or irreversible production/auth/payment/data effects with weak verification or rollback",
      ],
    },
    output_kind: {
      type: "choice",
      instructions: "What kind of output does the user expect?",
      criteria: {
        short_answer: "A brief textual answer or confirmation",
        code_edit: "Changes to existing code",
        long_generation: "A large new artifact such as a module, document, or test suite",
        plan: "An ordinary analysis, design, or plan rather than code",
        critical_design_review:
          "Design, a consequential decision, or review of authentication, authorization, payments, migration or other critical boundaries; not routine approved implementation or a check against a settled procedure",
        tool_plan: "A sequence of tool actions such as running commands or inspecting files",
      },
    },
    long_context: { type: "noul", instructions: "Does the task require reading or holding a large amount of context to do well?" },
  };
}

/** Asked only when the deterministic tool-signal score is ambiguous, against the recent tool digest. */
export function executionPhaseQuestions(): Readonly<Record<string, Question>> {
  return {
    tools_failed: {
      type: "noul",
      instructions:
        "Did code/logic attempts fail? Do not count 429, connectivity, expired credentials, unavailable dependencies or service outages as reasoning failures.",
    },
    spinning: {
      type: "noul",
      instructions: "Is the agent stuck after repeated code/reasoning attempts, rather than waiting or retrying an infrastructure failure?",
    },
    producing: { type: "noul", instructions: "Is the agent now writing or editing files rather than exploring or planning?" },
  };
}

/** Option-pick mode: one choice over candidate ids with user-authored descriptions. */
export function optionPickQuestion(
  candidates: Readonly<Record<string, Candidate>>,
  order: readonly string[],
): Readonly<Record<string, Question>> {
  const criteria: Record<string, string> = {};
  for (const id of order) criteria[id] = candidates[id]?.description ?? candidates[id]?.model ?? id;
  return {
    pick: { type: "choice", instructions: "Which candidate is the least expensive one that can complete this request well?", criteria },
  };
}
