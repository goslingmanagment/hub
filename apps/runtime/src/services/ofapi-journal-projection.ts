// Bookkeeping shared by the projections of settled OFAPI webhook journal rows.
// The DM, subscription and presence projections record their outcome through
// `settleOfapiJournalProjection`; every journal projection (those three plus
// account health and async lifecycle) is retried by `sweepOfapiJournalProjection`.

import {
  listOfapiWebhookEventsForDmProjection,
  markOfapiWebhookEventProjection,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

export const OFAPI_JOURNAL_PROJECTION_MAX_ATTEMPTS = 5;
const OFAPI_JOURNAL_PROJECTION_SWEEP_LIMIT = 200;

export type OfapiJournalProjectionOutcome =
  | { status: "projected" }
  | { status: "skipped"; reason: string }
  /** PR4: an erasure holds the fence lock — the caller leaves the journal
   * row pending (no attempt burned); the sweep retries post-erasure. */
  | { status: "deferred" };

type OfapiJournalSweepRow = Awaited<ReturnType<typeof listOfapiWebhookEventsForDmProjection>>[number];

/**
 * Runs one projection of a settled journal row and records its outcome on the
 * row. Never throws — failures are recorded as 'failed' and retried by the sweep.
 */
export async function settleOfapiJournalProjection(
  app: AppContext,
  row: { id: number; eventType: string },
  spec: {
    project: () => Promise<OfapiJournalProjectionOutcome>;
    failureLog: string;
    deferredLog?: string;
    markFailureLog?: string;
  },
) {
  try {
    const outcome = await spec.project();
    if (outcome.status === "deferred") {
      // Erasure fence lock held: leave the row pending/failed unchanged —
      // the sweep retries after the erasure commits, no attempt burned.
      app.logger.info({ eventId: row.id, eventType: row.eventType }, spec.deferredLog);
      return;
    }
    await markOfapiWebhookEventProjection(app.db, {
      id: row.id,
      status: outcome.status,
      error: outcome.status === "skipped" ? outcome.reason : null,
    });
  } catch (error) {
    app.logger.warn(
      { err: error, eventId: row.id, eventType: row.eventType },
      spec.failureLog,
    );
    await markOfapiWebhookEventProjection(app.db, {
      id: row.id,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }).catch((markError) => {
      if (spec.markFailureLog) {
        app.logger.warn({ err: markError, eventId: row.id }, spec.markFailureLog);
      }
    });
  }
}

/**
 * Minutely sweep: projects settled rows of `eventTypes` whose immediate
 * post-settle projection was lost (worker crash, flag enabled later) and
 * retries failed rows under the attempt cap, one row at a time.
 */
export async function sweepOfapiJournalProjection(
  app: AppContext,
  eventTypes: readonly string[],
  run: (app: AppContext, row: OfapiJournalSweepRow) => Promise<void>,
) {
  const rows = await listOfapiWebhookEventsForDmProjection(app.db, {
    eventTypes,
    maxAttempts: OFAPI_JOURNAL_PROJECTION_MAX_ATTEMPTS,
    limit: OFAPI_JOURNAL_PROJECTION_SWEEP_LIMIT,
  });

  for (const row of rows) {
    await run(app, row);
  }

  return rows.length;
}
