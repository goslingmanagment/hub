import { createHash } from "node:crypto";

import {
  type ClosingCacheUpsert,
  type Database,
  countUnansweredTails,
  getLlmUsageDaily,
  incrementLlmUsageDaily,
  listClosingClassificationCandidates,
  listWorkboardRecomputePageIds,
  upsertClosingCache,
} from "@agency_hub_core/db";
import { UTC_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";

import { isClosingMessage } from "./closing.ts";
import type { ClosingClassifier } from "./closing-classifier.ts";

export const CLOSING_CLASSIFIER_FEATURE = "closing-classifier";
const DEFAULT_BATCH_SIZE = 15;

function contentHash(content: string): string {
  return createHash("sha1").update(content).digest("hex");
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
    return { platformAccountId: opts.platformAccountId, classified: 0, deferred: 0, calls: 0 };
  }

  // Adaptive daily cap on API CALLS, scaled to the page's unanswered-tail volume.
  const tailCount = await countUnansweredTails(db, opts.platformAccountId);
  const cap = Math.min(opts.capMax, Math.max(opts.capMin, Math.floor(0.5 * tailCount)));
  const usage = await getLlmUsageDaily(db, opts.platformAccountId, businessDate, CLOSING_CLASSIFIER_FEATURE);
  const remainingCalls = Math.max(0, cap - usage.calls);
  const messageBudget = remainingCalls * batchSize;

  const classifyList = toClassify.slice(0, messageBudget);
  const deferred = toClassify.length - classifyList.length;

  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const cacheRows: ClosingCacheUpsert[] = [];

  for (const group of chunk(classifyList, batchSize)) {
    try {
      const result = await classifier.classifyBatch(group.map((c) => ({ id: c.platform_message_id, content: c.content })));
      calls += 1;
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      const verdicts = new Map(result.verdicts.map((v) => [v.id, v.needsReply]));
      for (const c of group) {
        cacheRows.push({
          platformAccountId: opts.platformAccountId,
          platformMessageId: c.platform_message_id,
          contentHash: contentHash(c.content),
          needsReply: verdicts.get(c.platform_message_id) ?? true,
          layer: "l2",
          model: classifier.model,
        });
      }
    } catch {
      // API error → stop; leave the remainder uncached (retried next run), do not flip to a verdict.
      break;
    }
  }

  await upsertClosingCache(db, cacheRows);
  if (calls > 0) {
    await incrementLlmUsageDaily(db, {
      platformAccountId: opts.platformAccountId,
      businessDate,
      feature: CLOSING_CLASSIFIER_FEATURE,
      calls,
      inputTokens,
      outputTokens,
    });
  }

  return { platformAccountId: opts.platformAccountId, classified: cacheRows.length, deferred, calls };
}

export async function runClosingClassificationAllPages(
  db: Database,
  classifier: ClosingClassifier,
  opts: { now?: Date; capMin: number; capMax: number },
): Promise<{ pages: number; classified: number }> {
  const pageIds = await listWorkboardRecomputePageIds(db);
  let classified = 0;
  for (const platformAccountId of pageIds) {
    const result = await runClosingClassificationForPage(db, classifier, {
      platformAccountId,
      now: opts.now,
      capMin: opts.capMin,
      capMax: opts.capMax,
    });
    classified += result.classified;
  }
  return { pages: pageIds.length, classified };
}
