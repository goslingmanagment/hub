import {
  finalizeAiGatewayUsageEvent,
  findPageByLabel,
  finishFanFactRebuildConversation,
  finishFanFactRun,
  insertAiGenerationContent,
  listConversationFacts,
  listFanFactRebuildSteps,
  listRemovedConversationFacts,
  listDueFanFactConversations,
  loadFanFactMessages,
  markFanFactRunInFlight,
  reserveAiGatewayUsageEvent,
  reserveFanFactRun,
  startFanFactRebuildConversation,
  stopFanFactRebuild,
  type Database,
  type FanFactMessage,
  type FanFactRebuildStep,
} from "@agency_hub_core/db";
import type { ProxyConfig } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import {
  classifyAnthropicAccountFailure,
  classifyAnthropicSdkFailure,
  createPageProxyAnthropicSingleShotClient,
  type AnthropicSingleShotClient,
} from "../ai-gateway-anthropic-provider.ts";
import { estimateAiGatewayUsageCost, resolveAnthropicGatewayModel } from "../ai-gateway-pricing.ts";
import type { AnthropicAccountPool } from "../ai-provider-account-pool.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { resolveStoredProxyConfig } from "../page-context.ts";
import { ensureQueueCreated, type QueueCreationClient } from "../sync-queue.ts";
import {
  FAN_FACTS_OUTPUT_SCHEMA,
  FAN_FACTS_PROMPT_VERSION,
  FAN_FACTS_SYSTEM_PROMPT,
  buildFanFactsUserText,
  parseFanFactsAnswer,
} from "./prompt.ts";

/**
 * Chat Memory week 2: the facts lane (docs/plans/2026-10-24-chat-memory/week-2.md
 * §3). Once a minute it takes the conversations of the listed pages
 * (`fanFactsPages`) that went quiet — no message for FAN_FACTS_QUIET_MINUTES,
 * after the «в разговоре» mark of the last sender dropped — where the fan wrote
 * since the last run, and runs one call each: the new messages (and a few older
 * ones for context) with the conversation's current facts in, the facts to add
 * and to close out.
 *
 * Once per conversation, not per message. A run's window is written before the
 * call (fan_fact_runs) and never sent again: a call that did not end clearly
 * stays `outcome_unknown`. The day's spend is capped
 * (`fanFactsDailyMicroUsdLimit`, the worst case reserved before the call),
 * and goes to the system ledger under `fan-facts`. Calls go through the page's
 * proxy, like every AI call of a page.
 *
 * After the live runs, the same tick advances the owner's rebuilds (0322,
 * `fan-facts:rebuild`): a few conversations at once, each read again from its
 * first message in windows, oldest first, with the memory carried forward,
 * within the rebuild's own budget. One job does both, so a live run and a
 * rebuild never touch a conversation at the same time.
 */

export const FAN_FACTS_QUEUE = "chat-memory.fan-facts";
export const FAN_FACTS_FEATURE = "fan-facts" as const;
export const FAN_FACTS_QUIET_MINUTES = 15;
const ACTIVE_HOURS = 48;
const RUNS_PER_TICK = 5;
const MAX_NEW_MESSAGES = 150;
const CONTEXT_MESSAGES = 15;
// Medium effort with adaptive thinking (owner, 2026-10-25): thinking counts
// against max_tokens, so the cap leaves it room over the ~2k-token answer.
const EFFORT = "medium";
const MAX_TOKENS = 16_000;
const TIMEOUT_MS = 180_000;
/** Rebuild conversations advanced side by side in one tick. */
const REBUILD_PARALLEL = 6;
/** A rebuild conversation starts no new window past this much of its tick. */
const REBUILD_TICK_MS = 40_000;
/** A rebuild with no window read yet starts before the first message. */
const HISTORY_START = new Date(0);

interface ProviderMessage {
  id?: string;
  stop_reason?: string | null;
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

export interface FanFactsClient {
  create(request: Record<string, unknown>): Promise<ProviderMessage>;
  servedAccountId(): number | null;
  release(): Promise<void>;
}
export type FanFactsClientFactory = (proxy: ProxyConfig) => FanFactsClient;

/** Each account of the pool in order until one accepts; only a credit or key refusal moves on (the describer's rule). */
export function createPoolFanFactsClientFactory(pool: AnthropicAccountPool): FanFactsClientFactory {
  return (proxy) => {
    const clients = new Map<number, AnthropicSingleShotClient>();
    let served: number | null = null;
    return {
      async create(request) {
        const accounts = await pool.candidates();
        if (accounts.length === 0) throw new Error("No Anthropic account is enabled");
        for (const [index, account] of accounts.entries()) {
          let client = clients.get(account.id);
          if (!client) {
            client = createPageProxyAnthropicSingleShotClient(account.apiKey, proxy, { timeoutMs: TIMEOUT_MS });
            clients.set(account.id, client);
          }
          try {
            const message = await client.create(request as never) as ProviderMessage;
            served = account.id;
            void pool.reportServed(account);
            return message;
          } catch (error) {
            const refusal = classifyAnthropicAccountFailure(error);
            if (refusal === null) throw error;
            await pool.reportRefusal(account, refusal, { providerHttpStatus: classifyAnthropicSdkFailure(error).httpStatus });
            if (index === accounts.length - 1) throw error;
          }
        }
        throw new Error("Anthropic account pool returned no outcome");
      },
      servedAccountId: () => served,
      async release() {
        await Promise.all([...clients.values()].map((client) => client.release()));
      },
    };
  };
}

/** The answer's JSON from its text block (thinking blocks come first); undefined when there is none or it does not parse. Pure. */
export function answerJson(message: ProviderMessage): unknown {
  const text = message.content?.find((block) => block.type === "text" && typeof block.text === "string")?.text;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The listed labels, as the setting spells them: comma-separated, exact. Pure. */
export function fanFactsPageLabels(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(",").map((label) => label.trim()).filter((label) => label.length > 0))];
}

export interface FanFactsSweepResult {
  skipped: "off" | "no_pages" | "no_client" | null;
  runs: number;
  added: number;
  closed: number;
  capReached: boolean;
}

export async function runFanFactsSweep(
  app: AppContext,
  deps: { clientFactory: FanFactsClientFactory | null; now?: () => Date },
): Promise<FanFactsSweepResult> {
  const now = deps.now ?? (() => new Date());
  const effective = await loadEffectiveConfig(app.db, app.config);
  const result: FanFactsSweepResult = { skipped: null, runs: 0, added: 0, closed: 0, capReached: false };
  if (effective.fanFactsEnabled !== true) return { ...result, skipped: "off" };
  if (deps.clientFactory === null) return { ...result, skipped: "no_client" };

  const pages = new Map<number, { label: string; proxy: ProxyConfig | null }>();
  for (const label of fanFactsPageLabels(effective.fanFactsPages)) {
    const stored = await findPageByLabel(app.db, label);
    if (stored) pages.set(stored.page.id, { label, proxy: resolveStoredProxyConfig(app, stored.proxy) });
  }
  if (pages.size === 0) return { ...result, skipped: "no_pages" };

  const model = effective.fanFactsModel ?? "anthropic:claude-sonnet-5-5";
  const cap = effective.fanFactsDailyMicroUsdLimit ?? 0;
  const due = await listDueFanFactConversations(app.db, {
    pageIds: [...pages.keys()], now: now(), quietMinutes: FAN_FACTS_QUIET_MINUTES, activeHours: ACTIVE_HOURS, limit: RUNS_PER_TICK,
  });

  for (const conversation of due) {
    const page = pages.get(conversation.pageId)!;
    const messages = await loadFanFactMessages(app.db, {
      pageId: conversation.pageId,
      conversationRef: conversation.conversationRef,
      watermark: conversation.watermark,
      maxNew: MAX_NEW_MESSAGES,
      contextBefore: CONTEXT_MESSAGES,
    });
    if (messages.length === 0) continue;
    const ran = await runWindow(app, deps.clientFactory, now, { ...conversation, proxy: page.proxy }, messages, { model, dailyCap: cap });
    if (ran === null) {
      result.capReached = true;
      break;
    }
    result.runs += 1;
    result.added += ran.added;
    result.closed += ran.closed;
  }
  if (result.runs > 0 || result.capReached) app.logger.info(result, "Fan facts sweep");
  await runFanFactsRebuildSteps(app, { clientFactory: deps.clientFactory, now, model });
  return result;
}

interface WindowTarget {
  pageId: number;
  platform: string;
  conversationRef: string;
  fanId: number;
  fanRef: string;
  proxy: ProxyConfig | null;
}

/** A provider's refusal that is worth asking again later (fan-fact-runs TRANSIENT_FAILURE). */
const RETRIED_HTTP = /^(408|409|429|5\d\d)$/;

/**
 * One run over one window of a conversation: reserved, sent once, recorded.
 * Null — no room under the cap (the live day's, or the rebuild's budget):
 * nothing was written or sent. `retry` — it never reached the model (no proxy,
 * or a refusal worth asking again): the window is read again later.
 */
async function runWindow(
  app: AppContext,
  clientFactory: FanFactsClientFactory,
  now: () => Date,
  conversation: WindowTarget,
  messages: FanFactMessage[],
  budget: { model: string; dailyCap: number; rebuild?: { id: number; first: boolean } },
): Promise<{ added: number; closed: number; retry: boolean } | null> {
  const { model } = budget;
  const fresh = budget.rebuild?.first === true;
  // A rebuild's first window starts the memory over: the AI's facts go with its reservation, a chatter's stay.
  const facts = (await listConversationFacts(app.db, { pageId: conversation.pageId, conversationRef: conversation.conversationRef }))
    .filter((fact) => !fresh || fact.source === "chatter");
  const removed = (await listRemovedConversationFacts(app.db, { pageId: conversation.pageId, conversationRef: conversation.conversationRef }))
    .filter((fact) => !fresh || fact.state !== "closed");
  const rebuildId = budget.rebuild?.id;
  const userText = buildFanFactsUserText(messages, facts, now());
  const reserve = estimateAiGatewayUsageCost(model, {
    inputTokens: Math.ceil((FAN_FACTS_SYSTEM_PROMPT.length + userText.length) / 3) + 500,
    outputTokens: MAX_TOKENS,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  }).costMicroUsd;
  const startedAt = now();
  const runId = await reserveFanFactRun(app.db, {
    pageId: conversation.pageId,
    conversationRef: conversation.conversationRef,
    fanId: conversation.fanId,
    model,
    promptVersion: FAN_FACTS_PROMPT_VERSION,
    throughMessageAt: messages.at(-1)!.at,
    messagesRead: messages.length,
    reserveMicroUsd: reserve,
    dailyCapMicroUsd: budget.dailyCap,
    now: startedAt,
    ...(budget.rebuild === undefined ? {} : { rebuild: { id: budget.rebuild.id, supersede: fresh } }),
  });
  if (runId === null) return null;
  const finish = (
    state: "done" | "failed", costMicroUsd: number, errorCode: string | null, answer: ReturnType<typeof parseFanFactsAnswer> | null,
    alsoWrite?: (tx: Database) => Promise<void>,
  ) =>
    finishFanFactRun(app.db, {
      runId, pageId: conversation.pageId, platform: conversation.platform, conversationRef: conversation.conversationRef,
      fanId: conversation.fanId, state, costMicroUsd, errorCode, result: answer, ...(alsoWrite ? { alsoWrite } : {}),
    });
  if (conversation.proxy === null) {
    await finish("failed", 0, "proxy_missing", null);
    return { added: 0, closed: 0, retry: true };
  }

  const clientEventId = `fan-facts:${runId}`;
  await reserveAiGatewayUsageEvent(app.db, {
    userId: null,
    event: {
      clientEventId, feature: FAN_FACTS_FEATURE, model, pageId: conversation.pageId, provider: "anthropic",
      conversationId: conversation.conversationRef, isRegeneration: false, reservedAt: startedAt,
    },
  });
  // From here the request may reach the provider: a crash leaves the run outcome_unknown, never sent again.
  await markFanFactRunInFlight(app.db, runId);
  const client = clientFactory(conversation.proxy);
  const callStarted = Date.now();
  const settle = (fields: { outcome: "completed" | "failed"; costMicroUsd: number; approximate: boolean; inputTokens?: number; outputTokens?: number; responseId?: string | null; errorCode?: string | null; httpStatus?: number | null }) =>
    finalizeAiGatewayUsageEvent(app.db, {
      userId: null,
      event: {
        clientEventId,
        providerAccountId: client.servedAccountId(),
        providerResponseId: fields.responseId ?? null,
        inputTokens: fields.inputTokens ?? 0,
        outputTokens: fields.outputTokens ?? 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        costMicroUsd: fields.costMicroUsd,
        costApproximate: fields.approximate,
        gatewayOutcome: fields.outcome,
        errorCode: fields.errorCode ?? null,
        failurePhase: fields.outcome === "failed" ? "provider_response" : null,
        providerHttpStatus: fields.httpStatus ?? null,
        durationMs: Date.now() - callStarted,
        isCacheHit: false,
        completedAt: now(),
      },
    });
  try {
    const message = await client.create({
      model: resolveAnthropicGatewayModel(model).providerModelId,
      max_tokens: MAX_TOKENS,
      system: FAN_FACTS_SYSTEM_PROMPT,
      output_config: { effort: EFFORT, format: { type: "json_schema", schema: FAN_FACTS_OUTPUT_SCHEMA } },
      messages: [{ role: "user", content: userText }],
    });
    const inputTokens = Math.max(0, Math.floor(message.usage?.input_tokens ?? 0));
    const outputTokens = Math.max(0, Math.floor(message.usage?.output_tokens ?? 0));
    const cost = estimateAiGatewayUsageCost(model, { inputTokens, outputTokens, cacheWriteTokens: 0, cacheReadTokens: 0 }).costMicroUsd;
    const json = answerJson(message);
    const answer = json === undefined ? null : parseFanFactsAnswer(json, { messages, facts, removed });
    const usageEventId = await settle({ outcome: "completed", costMicroUsd: cost, approximate: false, inputTokens, outputTokens, responseId: message.id ?? null });
    // The restricted record of the call goes in with the facts, under the run's lock: a fan erased during
    // the call took the run with him, and then neither is written. fan_ref and conversation_ref make a later
    // erasure reach it.
    const record = (written: { added: number; closed: number }) => async (tx: Database) => insertAiGenerationContent(tx, {
      usageEventId: typeof usageEventId === "number" ? usageEventId : null,
      generationRef: clientEventId,
      feature: FAN_FACTS_FEATURE,
      model,
      provider: "anthropic",
      userId: null,
      pageId: conversation.pageId,
      conversationRef: conversation.conversationRef,
      fanRef: conversation.fanRef,
      promptBlocks: [{ role: "system", blocks: [{ text: FAN_FACTS_SYSTEM_PROMPT }] }, { role: "user", blocks: [{ text: userText }] }],
      completion: JSON.stringify(json ?? null),
      params: {
        promptVersion: FAN_FACTS_PROMPT_VERSION, runId, added: written.added, closed: written.closed, dropped: answer?.dropped ?? null,
        stopReason: message.stop_reason ?? null, ...(rebuildId === undefined ? {} : { rebuildId }),
      },
    }).then(() => undefined);
    const counts = { added: answer?.add.length ?? 0, closed: answer?.close.length ?? 0 };
    const written = await finish(
      answer === null ? "failed" : "done", cost, answer === null ? `no_answer:${message.stop_reason ?? "none"}` : null, answer, record(counts),
    );
    return { added: written.added, closed: written.closed, retry: false };
  } catch (error) {
    const { httpStatus } = classifyAnthropicSdkFailure(error);
    if (httpStatus !== null) {
      // The provider answered with an error: nothing ran, nothing is billed.
      await finish("failed", 0, `http_${httpStatus}`, null);
      await settle({ outcome: "failed", costMicroUsd: 0, approximate: false, errorCode: `http_${httpStatus}`, httpStatus });
    } else {
      // No answer (a timeout, the connection): it may have run. The run stays outcome_unknown at its reservation.
      await settle({ outcome: "failed", costMicroUsd: reserve, approximate: true, errorCode: "no_answer" });
    }
    app.logger.warn({ runId, pageId: conversation.pageId, httpStatus, rebuildId }, "Fan facts run failed");
    return { added: 0, closed: 0, retry: httpStatus !== null && RETRIED_HTTP.test(String(httpStatus)) };
  } finally {
    await client.release();
  }
}

export interface FanFactsRebuildResult {
  conversations: number;
  runs: number;
  added: number;
  finished: number;
  /** Rebuilds stopped because their budget left no room for the next window. */
  stopped: number[];
}

/**
 * The owner's rebuilds, a few conversations side by side: a pending one is
 * started (its first window supersedes its old AI facts), then each reads its next windows
 * from where it stopped, oldest first, until its end or its share of the tick.
 * A conversation with nothing left is done; a rebuild with no room in its
 * budget is stopped, its open conversations given back to the live lane.
 */
export async function runFanFactsRebuildSteps(
  app: AppContext,
  deps: { clientFactory: FanFactsClientFactory; now: () => Date; model: string },
): Promise<FanFactsRebuildResult> {
  const result: FanFactsRebuildResult = { conversations: 0, runs: 0, added: 0, finished: 0, stopped: [] };
  const steps = await listFanFactRebuildSteps(app.db, { now: deps.now(), limit: REBUILD_PARALLEL });
  if (steps.length === 0) return result;
  const tickStarted = Date.now();
  const proxies = new Map<string, ProxyConfig | null>();
  const proxyOf = async (label: string) => {
    if (!proxies.has(label)) {
      const stored = await findPageByLabel(app.db, label);
      proxies.set(label, stored ? resolveStoredProxyConfig(app, stored.proxy) : null);
    }
    return proxies.get(label) ?? null;
  };
  const stopped = new Set<number>();

  const advance = async (step: FanFactRebuildStep) => {
    const key = { rebuildId: step.rebuildId, pageId: step.pageId, conversationRef: step.conversationRef };
    let through = step.throughMessageAt;
    let progress = step.progress;
    if (step.state === "pending") {
      through = await startFanFactRebuildConversation(app.db, { ...key, now: deps.now() });
      if (through === null) return;
    }
    result.conversations += 1;
    const proxy = await proxyOf(step.pageLabel);
    while (!stopped.has(step.rebuildId)) {
      const messages = await loadFanFactMessages(app.db, {
        pageId: step.pageId,
        conversationRef: step.conversationRef,
        watermark: progress ?? HISTORY_START,
        maxNew: MAX_NEW_MESSAGES,
        contextBefore: CONTEXT_MESSAGES,
        until: through!,
      });
      if (!messages.some((message) => !message.context)) {
        await finishFanFactRebuildConversation(app.db, { ...key, now: deps.now() });
        result.finished += 1;
        return;
      }
      const ran = await runWindow(app, deps.clientFactory, deps.now, { ...step, proxy }, messages, {
        model: deps.model, dailyCap: 0, rebuild: { id: step.rebuildId, first: progress === null },
      });
      if (ran === null) {
        stopped.add(step.rebuildId);
        return;
      }
      result.runs += 1;
      result.added += ran.added;
      // A window that never reached the model pauses the conversation (listFanFactRebuildSteps); a later tick reads it again.
      if (ran.retry || Date.now() - tickStarted > REBUILD_TICK_MS) return;
      progress = messages.at(-1)!.at;
    }
  };

  await Promise.all(steps.map((step) => advance(step).catch((error: unknown) => {
    app.logger.warn({ err: error, rebuildId: step.rebuildId, pageId: step.pageId }, "Fan facts rebuild step failed");
  })));
  for (const rebuildId of stopped) {
    await stopFanFactRebuild(app.db, { rebuildId, now: deps.now() });
    result.stopped.push(rebuildId);
  }
  app.logger.info(result, "Fan facts rebuild");
  return result;
}

export async function ensureFanFactsQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, FAN_FACTS_QUEUE, { policy: "exclusive" }, createdQueues);
}

/** Every minute: a quiet conversation waits at most a minute past its 15. */
export async function ensureFanFactsSchedule(boss: QueueCreationClient) {
  await boss.schedule?.(FAN_FACTS_QUEUE, "* * * * *", null, { tz: "UTC" });
}

export function resolveFanFactsClientFactory(app: Pick<AppContext, "anthropicAccountPool">): FanFactsClientFactory | null {
  return app.anthropicAccountPool ? createPoolFanFactsClientFactory(app.anthropicAccountPool) : null;
}
