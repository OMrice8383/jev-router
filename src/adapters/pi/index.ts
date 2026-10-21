import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Policy } from "../../core/policy/types";
import { isContinuation } from "../../core/work";
import { applyEnv, envFilePath, loadEnvFile } from "../../runtime/envfile";
import { createJudge } from "../../runtime/judge-factory";
import { JsonlLogger } from "../../runtime/log";
import { decisionsLogPath, resolvePolicyPath } from "../../runtime/paths";
import { readPolicyFile } from "../../runtime/policy-file";
import { policyFingerprint, ROUTING_REVISION } from "../../runtime/policy-identity";
import { PiRouter } from "./router";

type PiModel = Model<Api>;

function pickPolicyId(policy: Policy): string {
  const route = policy.routes.find((r) => r.harness === "pi") ?? policy.routes.find((r) => r.harness === "any");
  return route?.policy ?? Object.keys(policy.policies)[0] ?? "default";
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

/**
 * Pi extension entry point. Loads ~/.jev-router/policy.json (or $JEV_ROUTER_POLICY), routes every user turn
 * and every ambiguous tool continuation through the core, and applies decisions with pi.setModel and
 * pi.setThinkingLevel. Without a policy file it stays idle and says so once.
 */
export default function jevRouterExtension(pi: ExtensionAPI): void {
  let router: PiRouter<PiModel> | undefined;
  let logger: JsonlLogger | undefined;
  let loadedPolicyHash = "";

  async function boot(ctx: ExtensionContext, reason: string): Promise<void> {
    try {
      await router?.onSessionShutdown();
      await logger?.flush();
      // ASVS 13.3.2: keep setup secrets local to this judge; existing process values take precedence.
      const env = { ...process.env };
      applyEnv(env, await loadEnvFile(envFilePath(env)));
      const policyPath = await resolvePolicyPath(env);
      const policy = await readPolicyFile(policyPath);
      loadedPolicyHash = policyFingerprint(policy);
      const judge = createJudge(policy.judge, env);
      logger = new JsonlLogger(decisionsLogPath(env));
      const log = logger;
      router = new PiRouter<PiModel>({
        policy,
        policyId: pickPolicyId(policy),
        judge,
        findModel: (provider, id) => ctx.modelRegistry.find(provider, id),
        setModel: (model) => pi.setModel(model),
        setThinkingLevel: (level) => pi.setThinkingLevel(level),
        currentModel: () => ctx.model,
        currentThinkingLevel: () => pi.getThinkingLevel(),
        getActiveTools: () => pi.getActiveTools(),
        getContextTokens: () => ctx.getContextUsage()?.tokens ?? null,
        notify: (message, level) => ctx.ui.notify(message, level),
        status: (text) => ctx.ui.setStatus("jev-router", text ? `${text} · ta1:${loadedPolicyHash.slice(0, 8)}` : undefined),
        log: (record) =>
          log.write({
            ...record,
            loadedPolicyHash,
            routingRevision: ROUTING_REVISION,
            ...(env.JEV_ROUTER_LAUNCH_ID ? { launchId: env.JEV_ROUTER_LAUNCH_ID } : {}),
          }),
        now: () => Date.now(),
        randomId: () => crypto.randomUUID(),
      });
      const branch = ctx.sessionManager?.getBranch?.() ?? [];
      const userText = branch
        .filter((entry) => entry.type === "message" && entry.message.role === "user")
        .map((entry) => {
          if (entry.type !== "message" || entry.message.role !== "user") return "";
          return typeof entry.message.content === "string" ? entry.message.content : textOf(entry.message.content);
        })
        .filter((text) => text && !isContinuation(text))
        .at(-1);
      const lastAssistant = branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1);
      const intent =
        lastAssistant?.type === "message" && lastAssistant.message.role === "assistant" ? textOf(lastAssistant.message.content) : undefined;
      router.onSessionStart(reason, userText, intent);
    } catch (e) {
      router = undefined;
      ctx.ui.notify(`jev-router disabled: ${e instanceof Error ? e.message : String(e)}`, "warning");
      ctx.ui.setStatus("jev-router", "off");
    }
  }

  pi.on("session_start", async (event, ctx) => {
    await boot(ctx, event.reason);
  });

  pi.on("before_agent_start", async (event) => {
    await router?.onBeforeAgentStart({ prompt: event.prompt, ...(event.images ? { images: event.images } : {}) });
  });

  pi.on("turn_end", async (event) => {
    const message = event.message.role === "assistant" ? event.message : undefined;
    const assistantText = message ? textOf(message.content) : undefined;
    await router?.onTurnEnd({
      ...(assistantText ? { assistantText } : {}),
      ...(message
        ? {
            model: { provider: message.provider, id: message.model },
            usage: {
              inputTokens: message.usage.input,
              outputTokens: message.usage.output,
              cacheReadTokens: message.usage.cacheRead,
              cacheWriteTokens: message.usage.cacheWrite,
            },
          }
        : {}),
      hasImages: event.toolResults.some((r) => r.content.some((c) => c.type === "image")),
      toolResults: event.toolResults.map((r) => ({ toolName: r.toolName, isError: r.isError, text: textOf(r.content) })),
    });
  });

  pi.on("session_shutdown", async () => {
    await router?.onSessionShutdown();
    await logger?.flush();
  });

  pi.on("session_compact", () => {
    router?.onSessionCompact();
  });

  pi.on("model_select", (event) => {
    router?.onModelSelect({ model: event.model, source: event.source });
  });

  pi.registerCommand("jev-router", {
    description: "jev-router: status | on | off",
    handler: async (args, ctx) => {
      const verb = args.trim().toLowerCase();
      if (!router) {
        ctx.ui.notify("jev-router is disabled; add ~/.jev-router/policy.json and /reload", "warning");
        return;
      }
      if (verb === "on") router.setEnabled(true);
      else if (verb === "off") router.setEnabled(false);
      ctx.ui.notify(`${router.statusText()}\nloaded_policy=${loadedPolicyHash}\nrouting_revision=${ROUTING_REVISION}`, "info");
    },
  });
}
