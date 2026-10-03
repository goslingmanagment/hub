import { resolveTransactionTipContextLineage, type TransactionTipContextLineageInput } from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import {
  materializeFanslyDmTipContexts,
  type MaterializeFanslyDmTipContextsInput,
  parseFanslyDmTipSidecar,
} from "../../sync/fansly/lib/tip-contexts.ts";

// The legacy DM lanes' best-effort wrapper around the `/message` tips[]
// sidecar write. The parser and the write itself live with the Fansly Sync
// Engine, whose DM apply calls them inside its own transaction; the raw
// backfill calls the write directly.

/** The lineage as log fields: the raw id, or the observation id. */
function lineageLogFields(input: TransactionTipContextLineageInput) {
  const lineage = resolveTransactionTipContextLineage(input);
  return lineage.kind === "raw"
    ? { sourceRawPayloadId: lineage.sourceRawPayloadId }
    : { sourceObservationId: lineage.sourceObservationId };
}

function errorClass(error: unknown) {
  if (error instanceof Error && error.name.length > 0) {
    return error.name.slice(0, 80);
  }
  return typeof error;
}

/**
 * Hot-path policy: raw+observation capture is already durable before this is
 * called. Projection parse drift and write failures are bounded diagnostics,
 * never a reason to wedge the authoritative DM sync lane; the raw backfill is
 * the deterministic repair path.
 */
export async function materializeFanslyDmTipContextsBestEffort(
  app: Pick<AppContext, "db" | "logger">,
  input: MaterializeFanslyDmTipContextsInput,
) {
  try {
    const result = await materializeFanslyDmTipContexts(app.db, input);
    if (
      result.envelopeStatus === "invalid" ||
      result.rejectedItems.length > 0 ||
      result.droppedOptionalMemberCount > 0 ||
      result.conversationConflicts > 0 ||
      result.deferredWrites > 0 ||
      result.erasureFenced > 0
    ) {
      app.logger.warn({
        accountId: input.accountId,
        ...lineageLogFields(input),
        envelopeStatus: result.envelopeStatus,
        tipItemsSeen: result.tipItemsSeen,
        rejectedItemCount: result.rejectedItems.length,
        droppedOptionalMemberCount: result.droppedOptionalMemberCount,
        conversationConflictCount: result.conversationConflicts,
        deferredCount: result.deferredWrites,
        erasureFencedCount: result.erasureFenced,
      }, "Fansly DM tip sidecar materialized with bounded drift");
    }
    return {
      ...result,
      failed: result.deferredWrites > 0,
      deferred: result.deferredWrites > 0,
    };
  } catch (error) {
    const parsed = parseFanslyDmTipSidecar(input);
    app.logger.warn({
      accountId: input.accountId,
      ...lineageLogFields(input),
      tipItemsSeen: parsed.tipItemsSeen,
      acceptedItemCount: parsed.contexts.length,
      errorClass: errorClass(error),
    }, "Fansly DM tip context materialization failed after durable raw capture");
    return {
      ...parsed,
      upserted: 0,
      unchanged: 0,
      conversationConflicts: 0,
      deferredWrites: 0,
      deferred: false as const,
      erasureFenced: 0,
      failed: true as const,
    };
  }
}
