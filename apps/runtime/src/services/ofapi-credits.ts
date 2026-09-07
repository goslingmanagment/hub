// OFAPI credit ledger ops (Phase 1 of docs/ofapi-parity-plan.md, D2-D6):
// the client's onCreditSpend sink lands every REST response in the append-only
// ofapi_credit_ledger (+ the ofapi_credit_state day counter, same transaction),
// a daily job accrues webhook costs from our own journal, an hourly bank-style
// reconciliation decomposes balance drift into external spend / refills, and a
// burn-rate monitor alerts on trailing-hour spend. Everything is gated by
// OFAPI_CREDIT_LEDGER_ENABLED (default off); with the flag off the sink is a
// no-op and the day counter keeps its pre-ledger behavior.

import {
  countOfapiWebhookEventsReceivedBetween,
  getOfapiCreditReconcileState,
  hasOfapiCreditSpendRequestAttempt,
  insertOfapiCreditLedgerEntry,
  listOfapiBalanceObservationsAfter,
  recordOfapiPhysicalCreditUsage,
  recordOfapiCreditSpend,
  setOfapiCreditReconcileCursor,
  sumOfapiCreditsSpentBetween,
  sumOfapiKnownCreditsBetween,
  upsertOfapiWebhookAccrual,
  type OfapiBalanceObservationRow,
} from "@agency_hub_core/db";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import {
  notifyOfapiGlobalIncident,
  resolveOfapiGlobalIncident,
} from "./notification-incidents.ts";
import type { OfapiCreditSpendSink } from "./ofapi.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

export const OFAPI_CREDIT_ACCRUAL_QUEUE = "ofapi.credits.accrual";
export const OFAPI_CREDIT_RECONCILE_QUEUE = "ofapi.credits.reconcile";
export const OFAPI_CREDIT_BALANCE_PING_QUEUE = "ofapi.credits.balance-ping";

export const DEFAULT_BURN_ALERT_CREDITS_PER_HOUR = 300;
// Webhook accrual backfills at most this many completed UTC days — matches the
// journal's default retention so a late first enable still captures everything
// that is still countable.
const ACCRUAL_BACKFILL_MAX_DAYS = 7;
// Observations closer together than this are skipped when pairing (concurrent
// requests can land out of order; plan recommendation 2).
const RECONCILE_MIN_OBSERVATION_GAP_MS = 60_000;
// |residual| below this is measurement noise, not external spend (recommendation 2).
const RECONCILE_TOLERANCE_CREDITS = 1;
const RECONCILE_OBSERVATION_BATCH = 500;

export function isOfapiCreditLedgerEnabled(
  config?: Pick<AppContext["config"], "ofapiCreditLedgerEnabled">,
) {
  return config?.ofapiCreditLedgerEnabled === true;
}

/**
 * Builds the onCreditSpend sink wired into createOfapiClient (D1/D2): with the
 * flag on, every reported response becomes a ledger row plus the day-counter
 * update in one transaction. If that write is unavailable, the sink falls back
 * to the physical day counter. Only failure of both paths rejects more egress.
 */
export function createOfapiCreditSpendSink(
  app: Pick<AppContext, "db" | "logger" | "config">,
): OfapiCreditSpendSink {
  return async (observation) => {
    if (!isOfapiCreditLedgerEnabled(app.config)) {
      return null;
    }

    try {
      await recordOfapiCreditSpend(app.db, {
        operation: observation.operation,
        pageId: observation.pageId,
        httpStatus: observation.httpStatus,
        credits: observation.credits,
        estimated: observation.estimated,
        balanceAfter: observation.balanceAfter,
        requestId: observation.requestId,
        actorUserId: observation.actorUserId,
        budgetScope: observation.budgetScope ?? null,
        details: {
          attemptNumber: observation.attemptNumber,
          ...(observation.isCached === null ? {} : { isCached: observation.isCached }),
        },
      });
      return true;
    } catch (error) {
      // A connection failure can make COMMIT acknowledgement ambiguous. Check
      // the physical request-attempt identity before telling the caller to
      // repair the fast counter, otherwise a committed ledger write could be
      // counted twice. requestId alone is logical and is reused by retries.
      let recorded = await hasOfapiCreditSpendRequestAttempt(app.db, {
        requestId: observation.requestId,
        attemptNumber: observation.attemptNumber,
      }).catch(() => false);
      if (!recorded) {
        recorded = await recordOfapiPhysicalCreditUsage(app.db, {
          creditsUsed: observation.credits,
          balance: observation.balanceAfter,
          budgetScope: observation.budgetScope ?? null,
        }).then(() => true, () => false);
      }
      app.logger.warn(
        { err: error, operation: observation.operation, recorded },
        recorded
          ? "OFAPI credit ledger write failed; physical counter preserved"
          : "OFAPI credit accounting failed; request path will stop",
      );
      return recorded;
    }
  };
}

/** 1 credit per 100 webhook events, charged per started batch of 100. */
export function webhookAccrualCredits(eventCount: number) {
  return Math.ceil(Math.max(0, eventCount) / 100);
}

function utcDayStart(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(dayStart: Date, days: number) {
  return new Date(dayStart.getTime() + days * 24 * 60 * 60 * 1000);
}

function isoDay(dayStart: Date) {
  return dayStart.toISOString().slice(0, 10);
}

/**
 * Daily webhook accrual (D4): one idempotent ledger row per completed UTC day,
 * ceil(events/100) credits from our own journal. Walks the full backfill window
 * every run, so the first enable catches days still inside journal retention
 * and a missed cron run self-heals the next day.
 */
export async function runOfapiWebhookAccrual(app: AppContext, now = new Date()) {
  if (!isOfapiCreditLedgerEnabled(app.config)) {
    return 0;
  }

  const today = utcDayStart(now);
  let posted = 0;
  for (let daysAgo = ACCRUAL_BACKFILL_MAX_DAYS; daysAgo >= 1; daysAgo -= 1) {
    const dayStart = addUtcDays(today, -daysAgo);
    const dayEnd = addUtcDays(dayStart, 1);
    const eventCount = await countOfapiWebhookEventsReceivedBetween(app.db, {
      from: dayStart,
      to: dayEnd,
    });
    if (eventCount <= 0) {
      continue;
    }

    // occurred_at sits INSIDE the accrued day so every occurred_at-bucketed
    // aggregate (daily bars, "spent today", the trailing-hour burn window)
    // attributes the credits to the day the events actually arrived.
    const inserted = await upsertOfapiWebhookAccrual(app.db, {
      accrualDay: isoDay(dayStart),
      occurredAt: dayStart,
      credits: webhookAccrualCredits(eventCount),
      eventCount,
    });
    if (inserted) {
      posted += 1;
    }
  }

  if (posted > 0) {
    app.logger.info({ posted }, "OFAPI webhook accrual posted ledger rows");
  }
  return posted;
}

export interface OfapiReconciliationAdjustment {
  source: "external" | "refill";
  // Positive = spend we did not record ourselves; negative = balance added.
  credits: number;
  occurredAt: Date;
  details: Record<string, unknown>;
}

export interface OfapiReconciliationPlan {
  adjustments: OfapiReconciliationAdjustment[];
  // Last observation that was paired (the new cursor), null when nothing advanced.
  cursorObservation: OfapiBalanceObservationRow | null;
  lastDriftCredits: number | null;
}

/**
 * D5 bank reconciliation, pure planning half: walk balance observations in
 * insertion order from the cursor; for each accepted consecutive pair,
 * residual = (previous balance - known spends in between) - observed balance.
 * Positive residual -> external spend; negative -> refill; |residual| below the
 * tolerance is noise. Observations closer than the minimum gap to the previous
 * accepted one are skipped (their spend still counts in the next window).
 *
 * Audit F8: webhook burn drains the balance continuously but our accrual rows
 * post once daily, after the fact — counting them as ledger-known spend let
 * an intra-day drop reconcile as a duplicate `external` row and the spanning
 * window then emit a compensating phantom `refill`, double-counting the
 * webhook component in every non-refill aggregate. Instead, the expected
 * webhook burn for each observation window is estimated from our own journal
 * (events/100, fractional — the daily accrual keeps the per-day ceil) and
 * treated as known spend; accrual rows are no longer ledger-known at all.
 */
export async function planOfapiCreditReconciliation(input: {
  cursor: OfapiBalanceObservationRow;
  observations: OfapiBalanceObservationRow[];
  sumKnownCredits: (fromIdExclusive: number, toIdInclusive: number) => Promise<number>;
  estimateWebhookCreditsBetween?: (from: Date, to: Date) => Promise<number>;
  minObservationGapMs?: number;
  toleranceCredits?: number;
}): Promise<OfapiReconciliationPlan> {
  const minGapMs = input.minObservationGapMs ?? RECONCILE_MIN_OBSERVATION_GAP_MS;
  const tolerance = input.toleranceCredits ?? RECONCILE_TOLERANCE_CREDITS;

  const adjustments: OfapiReconciliationAdjustment[] = [];
  let previous = input.cursor;
  let cursorObservation: OfapiBalanceObservationRow | null = null;
  let lastDriftCredits: number | null = null;

  for (const observation of input.observations) {
    if (observation.id <= previous.id) {
      continue;
    }
    if (observation.occurredAt.getTime() - previous.occurredAt.getTime() < minGapMs) {
      continue;
    }

    const ledgerKnownCredits = await input.sumKnownCredits(previous.id, observation.id);
    const webhookCredits = input.estimateWebhookCreditsBetween
      ? await input.estimateWebhookCreditsBetween(previous.occurredAt, observation.occurredAt)
      : 0;
    const knownCredits = ledgerKnownCredits + webhookCredits;
    const residual = previous.balanceAfter - knownCredits - observation.balanceAfter;
    if (Math.abs(residual) >= tolerance) {
      adjustments.push({
        source: residual > 0 ? "external" : "refill",
        credits: residual,
        occurredAt: observation.occurredAt,
        details: {
          fromLedgerId: previous.id,
          toLedgerId: observation.id,
          // P-33: the residual describes drift accumulated over the whole
          // window, so the burn monitor pro-rates it by window overlap with
          // the trailing hour instead of taking the lump at occurredAt.
          fromOccurredAt: previous.occurredAt.toISOString(),
          fromBalance: previous.balanceAfter,
          toBalance: observation.balanceAfter,
          knownCredits,
          webhookCreditsEstimated: webhookCredits,
        },
      });
    }

    lastDriftCredits = residual;
    previous = observation;
    cursorObservation = observation;
  }

  return { adjustments, cursorObservation, lastDriftCredits };
}

/**
 * Reconciliation runner (hourly): fetches observations past the cursor, plans,
 * and writes external/refill rows plus the advanced cursor in one transaction.
 * The very first observation only seeds the cursor — there is no earlier
 * baseline to decompose against.
 */
export async function runOfapiCreditReconciliation(app: AppContext, now = new Date()) {
  if (!isOfapiCreditLedgerEnabled(app.config)) {
    return null;
  }

  const state = await getOfapiCreditReconcileState(app.db);

  let cursor: OfapiBalanceObservationRow | null = null;
  if (state.reconciledThroughLedgerId !== null) {
    const [cursorRow] = await listOfapiBalanceObservationsAfter(app.db, {
      afterLedgerId: state.reconciledThroughLedgerId - 1,
      limit: 1,
    });
    if (cursorRow && cursorRow.id === state.reconciledThroughLedgerId) {
      cursor = cursorRow;
    }
  }
  if (cursor === null) {
    // First run (or the cursor row vanished): baseline on the earliest
    // observation we can see and start decomposing from there.
    const [first] = await listOfapiBalanceObservationsAfter(app.db, {
      afterLedgerId: state.reconciledThroughLedgerId ?? 0,
      limit: 1,
    });
    if (!first) {
      return null;
    }
    cursor = first;
    await setOfapiCreditReconcileCursor(app.db, {
      reconciledThroughLedgerId: first.id,
      lastReconcileAt: now,
      lastDriftCredits: state.lastDriftCredits,
    });
  }

  const observations = await listOfapiBalanceObservationsAfter(app.db, {
    afterLedgerId: cursor.id,
    limit: RECONCILE_OBSERVATION_BATCH,
  });

  const plan = await planOfapiCreditReconciliation({
    cursor,
    observations,
    sumKnownCredits: (fromIdExclusive, toIdInclusive) =>
      sumOfapiKnownCreditsBetween(app.db, { fromLedgerIdExclusive: fromIdExclusive, toLedgerIdInclusive: toIdInclusive }),
    // F8: webhook burn is known spend — we journal every delivery — it just
    // is not in the ledger until the daily accrual posts it. Estimating it
    // per window keeps it out of the external/refill residuals.
    estimateWebhookCreditsBetween: async (from, to) =>
      (await countOfapiWebhookEventsReceivedBetween(app.db, { from, to })) / 100,
  });

  await app.db.transaction(async (tx) => {
    for (const adjustment of plan.adjustments) {
      await insertOfapiCreditLedgerEntry(tx, {
        occurredAt: adjustment.occurredAt,
        source: adjustment.source,
        operation: null,
        credits: adjustment.credits,
        estimated: true,
        details: adjustment.details,
      });
    }
    await setOfapiCreditReconcileCursor(tx, {
      reconciledThroughLedgerId: plan.cursorObservation?.id ?? cursor.id,
      lastReconcileAt: now,
      // The webhook estimate makes residuals fractional; the cursor column is
      // an integer.
      lastDriftCredits: plan.lastDriftCredits !== null
        ? Math.round(plan.lastDriftCredits)
        : state.lastDriftCredits,
    });
  });

  if (plan.adjustments.length > 0) {
    app.logger.info(
      {
        adjustments: plan.adjustments.length,
        lastDriftCredits: plan.lastDriftCredits,
      },
      "OFAPI credit reconciliation wrote external/refill rows",
    );
  }
  return plan;
}

/**
 * Burn-rate alert (D6): trailing-60-minute spend across all sources except
 * refills against OFAPI_BURN_ALERT_CREDITS_PER_HOUR, debounced through the
 * notification-incident machinery. Runs from the minutely OFAPI sweep.
 */
export async function runOfapiCreditBurnMonitor(app: AppContext, now = new Date()) {
  if (!isOfapiCreditLedgerEnabled(app.config)) {
    return;
  }

  try {
    // Inside the try so an override DB-read failure follows the same log/continue
    // path as the rest of the monitor instead of escaping.
    const effective = await loadEffectiveConfig(app.db, app.config);
    const threshold = effective.ofapiBurnAlertCreditsPerHour ?? DEFAULT_BURN_ALERT_CREDITS_PER_HOUR;
    if (threshold <= 0) {
      // Disabled: resolve any already-open burn-rate incident before skipping, so zeroing the
      // threshold turns the alert off cleanly instead of leaving a stale incident open.
      await resolveOfapiGlobalIncident(app, {
        kind: "ofapi_burn_rate",
        recoveredAt: now,
      });
      return;
    }

    const spentLastHour = await sumOfapiCreditsSpentBetween(app.db, {
      from: new Date(now.getTime() - 60 * 60 * 1000),
      to: now,
    });
    if (spentLastHour > threshold) {
      await notifyOfapiGlobalIncident(app, {
        kind: "ofapi_burn_rate",
        errorSummary:
          `OFAPI spent ${spentLastHour} credits in the trailing hour (alert threshold ${threshold}/h)`,
        occurredAt: now,
      });
    } else {
      await resolveOfapiGlobalIncident(app, {
        kind: "ofapi_burn_rate",
        recoveredAt: now,
      });
    }
  } catch (error) {
    app.logger.warn({ err: error }, "OFAPI credit burn monitor failed; continuing");
  }
}

/** Optional daily free, account-independent balance observation. A zero balance
 * or lack of mapped pages never routes this diagnostic through paid chats. */
export async function runOfapiBalancePing(app: AppContext) {
  if (
    !isOfapiCreditLedgerEnabled(app.config) ||
    app.config.ofapiBalancePingEnabled !== true ||
    !app.ofapi
  ) {
    return;
  }

  try {
    await app.ofapi.pingBalance({});
  } catch (error) {
    app.logger.warn({ err: error }, "OFAPI balance ping failed; continuing");
  }
}

export async function ensureOfapiCreditQueues(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await Promise.all([
    ensureQueueCreated(boss, OFAPI_CREDIT_ACCRUAL_QUEUE, { policy: "exclusive" }, createdQueues),
    ensureQueueCreated(boss, OFAPI_CREDIT_RECONCILE_QUEUE, { policy: "exclusive" }, createdQueues),
    ensureQueueCreated(boss, OFAPI_CREDIT_BALANCE_PING_QUEUE, { policy: "exclusive" }, createdQueues),
  ]);
}

export async function ensureOfapiCreditSchedules(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }

  // Ping at 00:05 anchors reconciliation right after the UTC-day rollover;
  // accrual at 00:40 posts the completed previous day well before the 02:30
  // journal prune; reconciliation walks hourly at :05.
  await boss.schedule(OFAPI_CREDIT_BALANCE_PING_QUEUE, "5 0 * * *", null, { tz: "UTC" });
  await boss.schedule(OFAPI_CREDIT_ACCRUAL_QUEUE, "40 0 * * *", null, { tz: "UTC" });
  await boss.schedule(OFAPI_CREDIT_RECONCILE_QUEUE, "5 * * * *", null, { tz: "UTC" });
}

type OfapiCreditWorkerBoss = Pick<PgBoss, "work">;

export async function startOfapiCreditWorker(app: AppContext, boss: OfapiCreditWorkerBoss) {
  await boss.work(OFAPI_CREDIT_ACCRUAL_QUEUE, { batchSize: 1 }, async () => {
    await runOfapiWebhookAccrual(app);
  });
  await boss.work(OFAPI_CREDIT_RECONCILE_QUEUE, { batchSize: 1 }, async () => {
    await runOfapiCreditReconciliation(app);
  });
  await boss.work(OFAPI_CREDIT_BALANCE_PING_QUEUE, { batchSize: 1 }, async () => {
    await runOfapiBalancePing(app);
  });
}
