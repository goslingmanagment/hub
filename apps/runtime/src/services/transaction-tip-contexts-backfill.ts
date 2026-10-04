import {
  listTransactionTipContextRawPayloadsAfterId,
  readTransactionTipContextRawPayloadHighWater,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { materializeFanslyDmTipContexts } from "../sync/fansly/lib/tip-contexts.ts";

const DEFAULT_BATCH_SIZE = 500;

type BackfillFailureReason = "database_write_failed" | "writer_deferred";

/** CLI-safe failure: never retains the Drizzle error/cause, whose rendered
 * params can contain the fan note and provider refs. */
export class TransactionTipContextsBackfillError extends Error {
  readonly reason: BackfillFailureReason;
  readonly rawPayloadId: number;
  readonly batchIndex: number;
  readonly batchCount: number;

  constructor(input: {
    reason: BackfillFailureReason;
    rawPayloadId: number;
    batchIndex: number;
    batchCount: number;
  }) {
    super("Transaction tip context backfill failed");
    this.name = "TransactionTipContextsBackfillError";
    this.reason = input.reason;
    this.rawPayloadId = input.rawPayloadId;
    this.batchIndex = input.batchIndex;
    this.batchCount = input.batchCount;
  }
}

export async function runBackfillMaterializationSafely<T>(input: {
  rawPayloadId: number;
  batchIndex: number;
  batchCount: number;
  run: () => Promise<T>;
}): Promise<T> {
  try {
    return await input.run();
  } catch {
    // Deliberately omit `cause`: DrizzleQueryError renders SQL params, which
    // include the exact note/group/tip identifiers this CLI must not disclose.
    throw new TransactionTipContextsBackfillError({
      reason: "database_write_failed",
      rawPayloadId: input.rawPayloadId,
      batchIndex: input.batchIndex,
      batchCount: input.batchCount,
    });
  }
}

export interface TransactionTipContextsBackfillResult {
  startingAfterRawPayloadId: number;
  rawHighWaterId: number;
  lastRawPayloadId: number;
  batches: number;
  rawPayloadsScanned: number;
  absentSidecars: number;
  invalidSidecars: number;
  tipItemsSeen: number;
  contextsParsed: number;
  rejectedItems: number;
  droppedOptionalMembers: number;
  contextsUpserted: number;
  contextsUnchanged: number;
  conversationConflicts: number;
  contextsErasureFenced: number;
}

/**
 * Deterministic, idempotent recovery over retained `/message` raw payloads.
 * Parsing remains item-isolated; a DB error throws and leaves the CLI nonzero
 * so an operator never mistakes a partial materialization for completion.
 */
export async function runTransactionTipContextsBackfill(
  app: Pick<AppContext, "db" | "logger">,
  options: {
    afterRawPayloadId?: number;
    batchSize?: number;
    accountId?: number;
  } = {},
): Promise<TransactionTipContextsBackfillResult> {
  const afterRawPayloadId = options.afterRawPayloadId ?? 0;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(afterRawPayloadId) || afterRawPayloadId < 0) {
    throw new Error("afterRawPayloadId must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 5_000) {
    throw new Error("batchSize must be a positive safe integer no greater than 5000");
  }
  if (
    options.accountId !== undefined &&
    (!Number.isSafeInteger(options.accountId) || options.accountId <= 0)
  ) {
    throw new Error("accountId must be a positive safe integer");
  }

  const rawHighWaterId = await readTransactionTipContextRawPayloadHighWater(app.db, {
    ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
  });
  const result: TransactionTipContextsBackfillResult = {
    startingAfterRawPayloadId: afterRawPayloadId,
    rawHighWaterId,
    lastRawPayloadId: afterRawPayloadId,
    batches: 0,
    rawPayloadsScanned: 0,
    absentSidecars: 0,
    invalidSidecars: 0,
    tipItemsSeen: 0,
    contextsParsed: 0,
    rejectedItems: 0,
    droppedOptionalMembers: 0,
    contextsUpserted: 0,
    contextsUnchanged: 0,
    conversationConflicts: 0,
    contextsErasureFenced: 0,
  };

  for (;;) {
    const batch = await listTransactionTipContextRawPayloadsAfterId(app.db, {
      afterId: result.lastRawPayloadId,
      throughId: result.rawHighWaterId,
      limit: batchSize,
      ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
    });
    if (batch.length === 0) {
      break;
    }

    for (const [batchIndex, rawPayload] of batch.entries()) {
      const materialized = await runBackfillMaterializationSafely({
        rawPayloadId: rawPayload.id,
        batchIndex,
        batchCount: batch.length,
        run: () => materializeFanslyDmTipContexts(app.db, {
          accountId: rawPayload.accountId,
          requestParams: rawPayload.requestParams,
          responsePayload: rawPayload.responsePayload,
          sourceRawPayloadId: rawPayload.id,
          capturedAt: rawPayload.capturedAt,
        }),
      });
      if (materialized.deferredWrites > 0) {
        // Retryable: do not count this raw and, critically, do not advance the
        // keyset. A later run must see the same payload after erasure unlocks.
        throw new TransactionTipContextsBackfillError({
          reason: "writer_deferred",
          rawPayloadId: rawPayload.id,
          batchIndex,
          batchCount: batch.length,
        });
      }
      result.rawPayloadsScanned += 1;
      result.tipItemsSeen += materialized.tipItemsSeen;
      result.contextsParsed += materialized.contexts.length;
      result.rejectedItems += materialized.rejectedItems.length;
      result.droppedOptionalMembers += materialized.droppedOptionalMemberCount;
      result.contextsUpserted += materialized.upserted;
      result.contextsUnchanged += materialized.unchanged;
      result.conversationConflicts += materialized.conversationConflicts;
      result.contextsErasureFenced += materialized.erasureFenced;
      if (materialized.envelopeStatus === "absent") {
        result.absentSidecars += 1;
      } else if (materialized.envelopeStatus === "invalid") {
        result.invalidSidecars += 1;
      }
      result.lastRawPayloadId = rawPayload.id;
    }
    result.batches += 1;
    app.logger.info({
      accountId: options.accountId ?? null,
      batchSize: batch.length,
      lastRawPayloadId: result.lastRawPayloadId,
      rawPayloadsScanned: result.rawPayloadsScanned,
      contextsParsed: result.contextsParsed,
      contextsUpserted: result.contextsUpserted,
      rejectedItems: result.rejectedItems,
      conversationConflicts: result.conversationConflicts,
      contextsErasureFenced: result.contextsErasureFenced,
      rawHighWaterId: result.rawHighWaterId,
    }, "Transaction tip contexts raw backfill batch complete");
  }

  return result;
}
