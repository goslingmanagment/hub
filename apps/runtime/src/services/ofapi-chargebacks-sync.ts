// Stage 14: chargebacks via OFAPI — one of the two OnlyMonster-exclusive
// feeds. A daily reconcile walks GET /{account}/chargebacks (vendored spec;
// response shape verified on the first live call per the stage's assumption 2)
// and writes canonical_type='chargeback' rows with source='ofapi:rest',
// gross negated — mirroring the OnlyMonster chargeback shape so rollups
// behave identically. The OFAPI *webhook* path keeps mapping reversals to
// refund; chargeback rows come only from this reconcile.

import { sql } from "drizzle-orm";

import {
  findPageByLabel,
  listOfapiMappedPages,
  rebuildRevenueRollups,
  rebuildSpenderProjections,
  transactions,
  upsertFanPages,
  upsertFans,
  withOfapiSpendTransactionPageLock,
  type Database,
} from "@agency_hub_core/db";
import {
  createProxyRequestDispatcher,
  dollarsToMills,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { asRecord, idToString } from "./ofapi-payloads.ts";
import { upsertTransactionWithNegationGuards } from "./money-negation-guards.ts";
import type { OfapiRequestContext } from "./ofapi.ts";
import {
  resolveStoredProxyConfig,
  resolveStoredProxyEgressKey,
} from "./page-context.ts";
import {
  notifyOfapiGlobalIncident,
  resolveOfapiGlobalIncident,
} from "./notification-incidents.ts";
import {
  ensureQueueCreated,
  type QueueCreationClient,
  type SyncQueueLifecycleClient,
} from "./sync-queue.ts";
import { createOfapiRestGuard } from "./sync/ofapi-dm-sync.ts";
import {
  assertPageTransactionsWriter,
  WrongTransactionsWriterError,
} from "./transactions-writer-gate.ts";

export const OFAPI_CHARGEBACKS_RECONCILE_QUEUE = "ofapi.chargebacks.reconcile";

// A failed fleet pass is already durable and operator-visible through the
// global incident. Retrying the pg-boss job would repeat every healthy page's
// vendor walk, so this queue deliberately gets one attempt only.
const OFAPI_CHARGEBACKS_QUEUE_OPTIONS = {
  policy: "exclusive",
  retryLimit: 0,
} as const;

const CHARGEBACKS_PAGE_LIMIT = 100;
// Trailing reconcile window once a page has chargeback rows: chargebacks
// surface within weeks of the payment, and the upserts make overlap free. A
// page with NO chargeback rows yet walks the full history (first enable);
// that first walk is all-or-nothing — see the truncation guard in
// reconcilePage.
const CHARGEBACKS_LOOKBACK_DAYS = 90;
// Per-page request cap per run — a safety backstop over the offset walk.
const CHARGEBACKS_MAX_PAGES_PER_RUN = 20;
// The FIRST walk is all-or-nothing (see the truncation guard), so its cap
// must sit far beyond any real history: 200 pages = 20k chargebacks. A page
// that truly exceeds this can never complete its first walk (no cross-run
// cursor) — that state logs at warn as full_history_walk_truncated.
const CHARGEBACKS_FIRST_WALK_MAX_PAGES = 200;
// Backfill-lane default; the ofapiBackfillDailyCreditBudget knob governs both
// the backfill CLI and this reconcile (one historical/reconcile spend lane).
const DEFAULT_BACKFILL_DAILY_CREDIT_BUDGET = 200;

export function isOfapiChargebacksReconcileEnabled(
  config?: Pick<AppContext["config"], "ofapiChargebacksReconcileEnabled">,
) {
  return config?.ofapiChargebacksReconcileEnabled === true;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const raw = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(" ", "T")}Z`
    : raw;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseDollarMills(value: unknown): bigint | null {
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  const normalized = typeof value === "string"
    ? value.trim().replace(/^\$/, "").replace(/,/g, "")
    : value;
  try {
    return dollarsToMills(normalized);
  } catch {
    return null;
  }
}

/** Refund direction: chargeback amounts are stored negated (like OnlyMonster). */
function negated(value: bigint | null): bigint | null {
  return value === null ? null : value > 0n ? -value : value;
}

function formatOfapiDate(date: Date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

type NormalizedChargeback = {
  transactionId: string;
  fanPlatformUserId: string;
  rawStatus: string;
  grossAmountMills: bigint;
  creatorNetAmountMills: bigint;
  platformFeeMills: bigint | null;
  vatAmountMills: bigint | null;
  taxAmountMills: bigint | null;
  occurredAt: Date;
};

function normalizeChargeback(item: Record<string, unknown>):
  | { status: "ok"; row: NormalizedChargeback }
  | { status: "skipped"; reason: string }
{
  const payment = asRecord(item.payment);
  if (!payment) {
    return { status: "skipped", reason: "missing_payment" };
  }
  const paymentId = idToString(payment.id);
  if (!paymentId) {
    return { status: "skipped", reason: "missing_payment_id" };
  }
  const fanPlatformUserId = idToString(asRecord(payment.user)?.id);
  if (!fanPlatformUserId) {
    return { status: "skipped", reason: "missing_fan_id" };
  }
  const occurredAt = parseDate(item.createdAt ?? payment.createdAt);
  if (!occurredAt) {
    return { status: "skipped", reason: "missing_occurred_at" };
  }
  const currency = typeof payment.currency === "string" ? payment.currency.toUpperCase() : null;
  if (currency !== null && currency !== "USD") {
    return { status: "skipped", reason: "unsupported_currency" };
  }
  const grossAmountMills = negated(parseDollarMills(payment.amount));
  if (grossAmountMills === null) {
    return { status: "skipped", reason: "missing_gross_amount" };
  }
  const creatorNetAmountMills = negated(parseDollarMills(payment.net)) ?? grossAmountMills;

  return {
    status: "ok",
    row: {
      // payment.id is the ORIGINAL transaction's id — writing under it would
      // overwrite the settled spend row on the (page, transaction_id) unique.
      // The suffix keeps the chargeback its own negative row (the OnlyMonster
      // shape rollups already understand) and converges on re-runs.
      transactionId: `${paymentId}:chargeback`,
      fanPlatformUserId,
      rawStatus: typeof payment.status === "string" && payment.status.trim().length > 0
        ? payment.status.trim()
        : "chargeback",
      grossAmountMills,
      creatorNetAmountMills,
      platformFeeMills: negated(parseDollarMills(payment.fee)),
      vatAmountMills: negated(parseDollarMills(payment.vatAmount)),
      taxAmountMills: negated(parseDollarMills(payment.taxAmount)),
      occurredAt,
    },
  };
}

async function pageHasChargebackRows(db: Database, pageId: number) {
  const result = await db.execute<{ found: number }>(sql`
    select 1 as found
    from ${transactions}
    where ${transactions.platformAccountId} = ${pageId}
      and ${transactions.canonicalType} = 'chargeback'
      and ${transactions.source} = 'ofapi:rest'
    limit 1
  `);
  return result.rows.length > 0;
}

export interface OfapiChargebacksPageResult {
  pageLabel: string;
  status: "written" | "blocked" | "skipped" | "failed";
  reason: string | null;
  apiPages: number;
  rawRows: number;
  writtenRows: number;
  skippedReasons: Record<string, number>;
}

async function reconcilePage(
  app: AppContext,
  input: {
    pageId: number;
    pageLabel: string;
    ofapiAccountId: string;
    guard: ReturnType<typeof createOfapiRestGuard>;
  },
): Promise<OfapiChargebacksPageResult> {
  if (!app.ofapi?.listChargebacks) {
    return {
      pageLabel: input.pageLabel,
      status: "skipped",
      reason: "ofapi_client_not_configured",
      apiPages: 0,
      rawRows: 0,
      writtenRows: 0,
      skippedReasons: {},
    };
  }

  // Stage 13 single-writer gate: a page whose writer is not 'ofapi' opens an
  // incident and is skipped; other pages still reconcile.
  try {
    await assertPageTransactionsWriter(app, {
      platformAccountId: input.pageId,
      attemptedWriter: "ofapi",
    });
  } catch (error) {
    if (error instanceof WrongTransactionsWriterError) {
      return {
        pageLabel: input.pageLabel,
        status: "blocked",
        reason: "wrong_transactions_writer",
        apiPages: 0,
        rawRows: 0,
        writtenRows: 0,
        skippedReasons: {},
      };
    }
    throw error;
  }

  const stored = await findPageByLabel(app.db, input.pageLabel);
  if (!stored) {
    return {
      pageLabel: input.pageLabel,
      status: "skipped",
      reason: "page_not_found",
      apiPages: 0,
      rawRows: 0,
      writtenRows: 0,
      skippedReasons: {},
    };
  }

  const now = new Date();
  const startDate = (await pageHasChargebackRows(app.db, input.pageId))
    ? formatOfapiDate(new Date(now.getTime() - CHARGEBACKS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000))
    : undefined;
  // The vendor now rejects a lower-bounded range without end_date. The first
  // full-history walk must still send neither boundary; trailing walks send
  // the pair from one captured clock instant.
  const endDate = startDate === undefined ? undefined : formatOfapiDate(now);

  const proxy = resolveStoredProxyConfig(app, stored.proxy);
  const dispatcher = proxy ? createProxyRequestDispatcher(proxy) : null;
  const requestContext: OfapiRequestContext = {
    pageId: input.pageId,
    dispatcher,
    egressKey: resolveStoredProxyEgressKey(stored.proxy),
    creditBudgetScope: "backfill",
  };

  const normalized: NormalizedChargeback[] = [];
  const skippedReasons: Record<string, number> = {};
  let apiPages = 0;
  let rawRows = 0;
  let blockedReason: string | null = null;
  let walkComplete = false;
  // First walk (no startDate) must be able to COMPLETE in one run or its
  // all-or-nothing guard discards it; trailing runs keep the tight backstop.
  const maxPages = startDate === undefined
    ? CHARGEBACKS_FIRST_WALK_MAX_PAGES
    : CHARGEBACKS_MAX_PAGES_PER_RUN;

  try {
    for (let offset = 0; apiPages < maxPages;) {
      const block = await input.guard.resolveBlock();
      if (block !== null) {
        blockedReason = block;
        break;
      }
      const page = await app.ofapi.listChargebacks(requestContext, input.ofapiAccountId, {
        limit: CHARGEBACKS_PAGE_LIMIT,
        offset,
        ...(startDate === undefined ? {} : { startDate, endDate }),
      });
      await input.guard.recordResponse(page);
      apiPages += 1;
      rawRows += page.items.length;
      for (const item of page.items) {
        const result = normalizeChargeback(item);
        if (result.status === "ok") {
          normalized.push(result.row);
        } else {
          skippedReasons[result.reason] = (skippedReasons[result.reason] ?? 0) + 1;
        }
      }
      if (page.items.length < CHARGEBACKS_PAGE_LIMIT) {
        walkComplete = true;
        break;
      }
      offset += page.items.length;
    }
  } finally {
    if (dispatcher) {
      await dispatcher.close().catch((error: unknown) => {
        app.logger.warn(
          { error, pageId: input.pageId },
          "Failed to close OFAPI chargebacks dispatcher",
        );
      });
    }
  }

  // A page's FIRST walk (no rows yet ⇒ no startDate) must cover the whole
  // history: any row we write flips pageHasChargebackRows and locks every
  // later run into the 90-day window. A truncated first walk (budget block
  // or page-cap) therefore writes NOTHING — tomorrow's run redoes the full
  // walk against a fresh day budget. Trailing-window partials stay written:
  // the next run re-covers the same 90 days and the upserts make it free.
  if (startDate === undefined && !walkComplete) {
    return {
      pageLabel: input.pageLabel,
      status: "blocked",
      reason: blockedReason ?? "full_history_walk_truncated",
      apiPages,
      rawRows,
      writtenRows: 0,
      skippedReasons,
    };
  }

  let written = 0;
  if (normalized.length > 0) {
    written = await withOfapiSpendTransactionPageLock(app.db, input.pageId, async (db) => {
      const fanIds = Array.from(new Set(normalized.map((row) => row.fanPlatformUserId)));
      const fanRows = await upsertFans(db, fanIds.map((platformUserId) => ({
        platform: "onlyfans",
        platformUserId,
      })));
      await upsertFanPages(db, fanRows.map((fan) => ({
        fanId: fan.id,
        platformAccountId: input.pageId,
      })));
      const fanIdByPlatformUserId = new Map(fanRows.map((fan) => [fan.platformUserId, fan.id]));

      let dirtyFrom: Date | null = null;
      let count = 0;
      for (const row of normalized) {
        // W7.3 Guard 1/2: an active :reversal twin or a missing settled
        // original writes this chargeback INACTIVE (never double-negate).
        await upsertTransactionWithNegationGuards(db, {
          platformAccountId: input.pageId,
          source: "ofapi:rest",
          fanId: fanIdByPlatformUserId.get(row.fanPlatformUserId) ?? null,
          transactionId: row.transactionId,
          accountId: input.ofapiAccountId,
          correlationAccountId: row.fanPlatformUserId,
          rawType: "ofapi:chargeback",
          canonicalType: "chargeback",
          transactionState: "posted",
          rawStatus: row.rawStatus,
          grossAmountMills: row.grossAmountMills,
          sourceDestinationAmountMills: row.grossAmountMills,
          creatorNetAmountMills: row.creatorNetAmountMills,
          platformFeeMills: row.platformFeeMills,
          vatAmountMills: row.vatAmountMills,
          taxAmountMills: row.taxAmountMills,
          senderId: row.fanPlatformUserId,
          occurredAt: row.occurredAt,
          sourceUpdatedAt: row.occurredAt,
        });
        dirtyFrom = dirtyFrom === null || row.occurredAt.getTime() < dirtyFrom.getTime()
          ? row.occurredAt
          : dirtyFrom;
        count += 1;
      }
      if (dirtyFrom) {
        await rebuildSpenderProjections(db, input.pageId, dirtyFrom);
        await rebuildRevenueRollups(db, input.pageId, dirtyFrom);
      }
      return count;
    });
  }

  return {
    pageLabel: input.pageLabel,
    status: blockedReason !== null && written === 0 && apiPages === 0 ? "blocked" : "written",
    reason: blockedReason,
    apiPages,
    rawRows,
    writtenRows: written,
    skippedReasons,
  };
}

export async function runOfapiChargebacksReconcile(app: AppContext) {
  if (!isOfapiChargebacksReconcileEnabled(app.config)) {
    return { pages: [] as OfapiChargebacksPageResult[] };
  }

  const mapped = (await listOfapiMappedPages(app.db))
    .filter((page) => page.platform === "onlyfans");
  const guard = createOfapiRestGuard(app, {
    // Backstop sized for first walks (the day-credit budget governs real
    // spend); trailing-mode pages barely touch it.
    maxRequestsPerRun: CHARGEBACKS_FIRST_WALK_MAX_PAGES * Math.max(1, mapped.length),
    dailyCreditBudget:
      app.config.ofapiBackfillDailyCreditBudget ?? DEFAULT_BACKFILL_DAILY_CREDIT_BUDGET,
    budgetScope: "backfill",
  });

  const pages: OfapiChargebacksPageResult[] = [];
  for (const page of mapped) {
    try {
      pages.push(await reconcilePage(app, {
        pageId: page.id,
        pageLabel: page.label,
        ofapiAccountId: page.ofapiAccountId,
        guard,
      }));
    } catch (error) {
      // A failed request has no response with which to settle the reservation.
      // Keep its DB estimate charged conservatively, but clear the in-memory
      // lifecycle token so this page cannot prevent the next mapped page from
      // using the shared guard.
      guard.abandonPendingReservation();
      const reason = error instanceof Error ? error.message : String(error);
      pages.push({
        pageLabel: page.label,
        status: "failed",
        reason,
        apiPages: 0,
        rawRows: 0,
        writtenRows: 0,
        skippedReasons: {},
      });
      app.logger.error({
        err: error,
        pageId: page.id,
        pageLabel: page.label,
      }, "OFAPI chargebacks reconcile failed for page; continuing with remaining pages");
    }
  }

  const failed = pages.filter((page) => page.status === "failed");
  if (failed.length > 0) {
    const shown = failed.slice(0, 5)
      .map((page) => `${page.pageLabel}: ${page.reason ?? "unknown error"}`)
      .join("; ");
    const remainder = failed.length > 5 ? `; +${failed.length - 5} more` : "";
    await notifyOfapiGlobalIncident(app, {
      kind: "ofapi_chargebacks_reconcile_failed",
      errorSummary: `${failed.length} page(s) failed: ${shown}${remainder}`,
    });
  } else if (pages.length > 0 && pages.every((page) => page.status === "written")) {
    // Do not resolve on a blocked/skipped pass: that is not positive evidence
    // that the failed page recovered. A fully written fleet pass is.
    await resolveOfapiGlobalIncident(app, {
      kind: "ofapi_chargebacks_reconcile_failed",
    });
  }

  const blocked = pages.filter((page) => page.status === "blocked");
  if (blocked.length > 0) {
    // Warn-level so a page stuck in perpetual first-walk retry (budget
    // starvation or the cap) is greppably distinct from healthy runs.
    app.logger.warn({
      blocked: blocked.map((page) => ({ label: page.pageLabel, reason: page.reason })),
    }, "OFAPI chargebacks reconcile blocked for some pages");
  }
  app.logger.info({
    pages: pages.map((page) => ({
      label: page.pageLabel,
      status: page.status,
      reason: page.reason,
      apiPages: page.apiPages,
      rawRows: page.rawRows,
      writtenRows: page.writtenRows,
    })),
  }, "OFAPI chargebacks reconcile complete");

  return { pages };
}

export async function ensureOfapiChargebacksQueue(
  boss: SyncQueueLifecycleClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(
    boss,
    OFAPI_CHARGEBACKS_RECONCILE_QUEUE,
    OFAPI_CHARGEBACKS_QUEUE_OPTIONS,
    createdQueues,
  );

  // createQueue uses ON CONFLICT DO NOTHING, so production queues retain old
  // mutable defaults unless they are explicitly reconciled after creation.
  await boss.updateQueue(OFAPI_CHARGEBACKS_RECONCILE_QUEUE, {
    retryLimit: OFAPI_CHARGEBACKS_QUEUE_OPTIONS.retryLimit,
  });

  const queue = await boss.getQueue(OFAPI_CHARGEBACKS_RECONCILE_QUEUE);
  if (
    !queue ||
    queue.policy !== OFAPI_CHARGEBACKS_QUEUE_OPTIONS.policy ||
    queue.retryLimit !== OFAPI_CHARGEBACKS_QUEUE_OPTIONS.retryLimit
  ) {
    throw new Error(
      `Queue ${OFAPI_CHARGEBACKS_RECONCILE_QUEUE} configuration drift: expected ` +
      `policy=${OFAPI_CHARGEBACKS_QUEUE_OPTIONS.policy}, ` +
      `retryLimit=${OFAPI_CHARGEBACKS_QUEUE_OPTIONS.retryLimit}`,
    );
  }
}

export async function ensureOfapiChargebacksSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  // Daily at 03:10 UTC — after the raw-payload prune window, before EU morning.
  await boss.schedule(OFAPI_CHARGEBACKS_RECONCILE_QUEUE, "10 3 * * *", null, { tz: "UTC" });
}

export async function startOfapiChargebacksWorker(
  app: AppContext,
  boss: {
    work: (
      queue: string,
      options: { batchSize: number },
      handler: () => Promise<void>,
    ) => Promise<unknown>;
  },
) {
  await boss.work(OFAPI_CHARGEBACKS_RECONCILE_QUEUE, { batchSize: 1 }, async () => {
    const result = await runOfapiChargebacksReconcile(app);
    const failed = result.pages.filter((page) => page.status === "failed");
    if (failed.length > 0) {
      // Page isolation lets the rest of the fleet converge first; throwing
      // afterwards preserves pg-boss's terminal failed state for operators.
      throw new Error(`OFAPI chargebacks reconcile failed for ${failed.length} page(s)`);
    }
  });
}
