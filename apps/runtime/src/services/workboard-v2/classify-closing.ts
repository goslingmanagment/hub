import { createHash } from "node:crypto";

import {
  type ClosingCacheUpsert,
  type ClosingCandidateRow,
  type Database,
  addLlmUsageDailyTokens,
  countUnansweredTails,
  insertClassifierRun,
  listClosingClassificationCandidates,
  listClosingSettings,
  listWorkboardRecomputePageIds,
  reserveLlmUsageDailyCall,
  upsertClosingCache,
} from "@agency_hub_core/db";
import { UTC_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";

import { type ClosingConfigLike, resolveClosingSettings } from "./ai-settings.ts";
import { isClosingMessage } from "./closing.ts";
import { type ClosingClassifier, type ClosingContextMessage, createAnthropicClosingClassifier } from "./closing-classifier.ts";

export const CLOSING_CLASSIFIER_FEATURE = "closing-classifier";
const DEFAULT_BATCH_SIZE = 15;
const MAX_CONTEXT_MESSAGES = 10;

function contentHash(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

/**
 * Build the conversation window the classifier sees: roles mapped to fan/creator,
 * system/unknown lines dropped, trimmed to the last few messages. Always ends with
 * the fan's tail (falls back to the cached preview if the window missed it).
 */
function toContext(row: ClosingCandidateRow): ClosingContextMessage[] {
  const raw = Array.isArray(row.context) ? row.context : [];
  const mapped: ClosingContextMessage[] = [];
  for (const m of raw) {
    const role = m.role === "fan" ? "fan" : m.role === "model" ? "creator" : null;
    const text = (m.text ?? "").trim();
    if (role && text) {
      mapped.push({ role, text });
    }
  }
  const trimmed = mapped.slice(-MAX_CONTEXT_MESSAGES);
  if (trimmed.length === 0 || trimmed[trimmed.length - 1]?.role !== "fan") {
    const tail = (row.content ?? "").trim();
    if (tail) {
      trimmed.push({ role: "fan", text: tail });
    }
  }
  return trimmed;
}

/** Stable cache key: the verdict depends on the context, not just the tail text. */
function contextHash(context: ClosingContextMessage[]): string {
  return contentHash(JSON.stringify(context));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export interface ClassifyPageResult {
  platformAccountId: number;
  classified: number;
  deferred: number; // left uncached (over budget / error) → engine marks "unverified", retried next run
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export async function runClosingClassificationForPage(
  db: Database,
  classifier: ClosingClassifier,
  opts: { platformAccountId: number; now?: Date; capMin: number; capMax: number; batchSize?: number },
): Promise<ClassifyPageResult> {
  const now = opts.now ?? new Date();
  const businessDate = toBusinessDate(now, UTC_TIME_ZONE);
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

  const candidates = await listClosingClassificationCandidates(db, opts.platformAccountId);
  // L1 closings are resolved by the engine for free — only spend L2 on L1-undecided tails.
  const toClassify = candidates.filter((c) => !isClosingMessage(c.content));
  if (toClassify.length === 0) {
    return { platformAccountId: opts.platformAccountId, classified: 0, deferred: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
  }

  // Adaptive daily cap on API CALLS, scaled to the page's unanswered-tail volume.
  const tailCount = await countUnansweredTails(db, opts.platformAccountId);
  const cap = Math.min(opts.capMax, Math.max(opts.capMin, Math.floor(0.5 * tailCount)));
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const cacheRows: ClosingCacheUpsert[] = [];

  for (const group of chunk(toClassify, batchSize)) {
    const reserved = await reserveLlmUsageDailyCall(db, {
      platformAccountId: opts.platformAccountId,
      businessDate,
      feature: CLOSING_CLASSIFIER_FEATURE,
      cap,
    });
    if (!reserved) {
      break;
    }
    calls += 1;
    const contexts = new Map(group.map((c) => [c.platform_message_id, toContext(c)]));
    try {
      const result = await classifier.classifyBatch(
        group.map((c) => ({ id: c.platform_message_id, context: contexts.get(c.platform_message_id)! })),
      );
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      await addLlmUsageDailyTokens(db, {
        platformAccountId: opts.platformAccountId,
        businessDate,
        feature: CLOSING_CLASSIFIER_FEATURE,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
      const verdicts = new Map(result.verdicts.map((v) => [v.id, v]));
      for (const c of group) {
        const verdict = verdicts.get(c.platform_message_id);
        cacheRows.push({
          platformAccountId: opts.platformAccountId,
          platformMessageId: c.platform_message_id,
          contentHash: contextHash(contexts.get(c.platform_message_id)!),
          needsReply: verdict?.needsReply ?? true,
          layer: "l2",
          model: classifier.model,
          state: verdict?.state ?? null,
          reason: verdict?.reason ?? null,
        });
      }
    } catch {
      // API error → stop; leave the remainder uncached (retried next run), do not flip to a verdict.
      break;
    }
  }

  await upsertClosingCache(db, cacheRows);

  return {
    platformAccountId: opts.platformAccountId,
    classified: cacheRows.length,
    deferred: toClassify.length - cacheRows.length,
    calls,
    inputTokens,
    outputTokens,
  };
}

/**
 * Classify every eligible page, resolving each page's effective settings (per-page
 * override over env). Pages where the feature is disabled are skipped; the rest use
 * their own cap + model. Classifiers are cached per distinct model. A missing API
 * key disables the whole run (no key = nothing to call).
 */
export async function runClosingClassificationAllPages(
  db: Database,
  opts: {
    config: ClosingConfigLike;
    now?: Date;
    /** Injectable for tests; defaults to the real Anthropic classifier. */
    createClassifier?: (model: string) => ClosingClassifier;
  },
): Promise<{ pages: number; enabledPages: number; classified: number }> {
  if (!opts.config.anthropicApiKey) {
    return { pages: 0, enabledPages: 0, classified: 0 };
  }
  const factory =
    opts.createClassifier
    ?? ((model: string) => createAnthropicClosingClassifier({ apiKey: opts.config.anthropicApiKey!, model }));

  const pageIds = await listWorkboardRecomputePageIds(db);
  const overrides = new Map((await listClosingSettings(db)).map((s) => [s.platform_account_id, s]));
  const classifierCache = new Map<string, ClosingClassifier>();

  let classified = 0;
  let enabledPages = 0;
  for (const platformAccountId of pageIds) {
    const o = overrides.get(platformAccountId);
    const eff = resolveClosingSettings(
      opts.config,
      o ? { enabled: o.enabled, dailyCapMax: o.daily_cap_max, model: o.model } : null,
    );
    if (!eff.enabled) {
      continue;
    }
    enabledPages += 1;
    let classifier = classifierCache.get(eff.model);
    if (!classifier) {
      classifier = factory(eff.model);
      classifierCache.set(eff.model, classifier);
    }
    const result = await runClosingClassificationForPage(db, classifier, {
      platformAccountId,
      now: opts.now,
      capMin: eff.capMin,
      capMax: eff.capMax,
    });
    classified += result.classified;
    // Only log a run that actually called the API (skip the nightly no-ops).
    if (result.calls > 0) {
      await insertClassifierRun(db, {
        platformAccountId,
        trigger: "cron",
        model: eff.model,
        classified: result.classified,
        calls: result.calls,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        deferred: result.deferred,
        cleared: 0,
      });
    }
  }
  return { pages: pageIds.length, enabledPages, classified };
}
