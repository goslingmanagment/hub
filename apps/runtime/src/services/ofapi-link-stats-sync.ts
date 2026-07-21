// OFAPI trial/tracking link statistics reconcile (2026-07-22 plan). Twice a
// day, for every OFAPI-mapped OnlyFans page, walk the two link-list endpoints
// and append run + per-link snapshot rows. Counters are cumulative vendor
// values stored as observed; regressions are NOT clamped (chargebacks and
// deletions legitimately lower them) — the reporting layer owns delta
// semantics. List endpoints only: cost stays O(pages).

import {
  insertLinkStatRun,
  insertLinkStatSnapshots,
  listOfapiMappedPages,
  type Database,
  type InsertLinkStatSnapshotInput,
  type LinkStatKind,
} from "@agency_hub_core/db";
import { dollarsToMills } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { asRecord, idToString } from "./ofapi-payloads.ts";
import type { OfapiListPage, OfapiRequestContext } from "./ofapi.ts";
import { persistRawPayload, retentionDate } from "./sync/shared.ts";
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

export const OFAPI_LINK_STATS_RECONCILE_QUEUE = "ofapi.link-stats.reconcile";

// A failed fleet pass is durable and operator-visible through the global
// incident; retrying the pg-boss job would repeat every healthy page's walk.
const OFAPI_LINK_STATS_QUEUE_OPTIONS = {
  policy: "exclusive",
  retryLimit: 0,
} as const;

const LINK_STATS_PAGE_LIMIT = 100;
// Offset-walk backstop per (page, kind) per run: 20 pages = 2000 links.
const LINK_STATS_MAX_PAGES_PER_RUN = 20;
// Backfill-lane default; ofapiBackfillDailyCreditBudget governs real spend.
const DEFAULT_BACKFILL_DAILY_CREDIT_BUDGET = 200;

export function isOfapiLinkStatsReconcileEnabled(
  config?: Pick<AppContext["config"], "ofapiLinkStatsReconcileEnabled">,
) {
  return config?.ofapiLinkStatsReconcileEnabled === true;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseCounter(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return value;
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

function parseOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeLinkItem(
  kind: LinkStatKind,
  pageId: number,
  item: Record<string, unknown>,
):
  | { status: "ok"; row: InsertLinkStatSnapshotInput }
  | { status: "skipped"; reason: string }
{
  const platformLinkId = idToString(item.id);
  if (!platformLinkId) {
    return { status: "skipped", reason: "missing_link_id" };
  }
  const clicksCount = parseCounter(kind === "tracking" ? item.clicksCount : item.clicksCounts);
  if (clicksCount === null) {
    return { status: "skipped", reason: "invalid_clicks_count" };
  }
  const subscribersCount = parseCounter(
    kind === "tracking" ? item.subscribersCount : item.subscribeCounts,
  );
  if (subscribersCount === null) {
    return { status: "skipped", reason: "invalid_subscribers_count" };
  }
  let claimsCount: number | null = null;
  if (kind === "trial") {
    claimsCount = parseCounter(item.claimCounts);
    if (claimsCount === null) {
      return { status: "skipped", reason: "invalid_claims_count" };
    }
  }
  const revenue = asRecord(item.revenue);
  return {
    status: "ok",
    row: {
      platformAccountId: pageId,
      linkKind: kind,
      platformLinkId,
      name: parseOptionalString(kind === "tracking" ? item.campaignName : item.trialLinkName),
      url: parseOptionalString(kind === "tracking" ? item.campaignUrl : item.url),
      linkCreatedAt: parseDate(item.createdAt),
      linkEndsAt: parseDate(kind === "tracking" ? item.endDate : item.expiredAt),
      isFinished: kind === "trial" && typeof item.isFinished === "boolean"
        ? item.isFinished
        : null,
      clicksCount,
      claimsCount,
      subscribersCount,
      spendersCount: parseCounter(revenue?.spendersCount) ?? 0,
      revenueGrossMills: parseDollarMills(revenue?.total) ?? 0n,
      revenueCalculatedAt: parseDate(revenue?.calculatedAt),
    },
  };
}

export interface OfapiLinkStatsKindResult {
  linkKind: LinkStatKind;
  status: "written" | "truncated" | "skipped";
  reason: string | null;
  apiPages: number;
  rawItems: number;
  writtenRows: number;
  skippedReasons: Record<string, number>;
}

export interface OfapiLinkStatsPageResult {
  pageLabel: string;
  status: "written" | "partial" | "skipped" | "failed";
  reason: string | null;
  kinds: OfapiLinkStatsKindResult[];
}

type LinkLister = (
  context: OfapiRequestContext,
  accountId: string,
  params: { limit?: number; offset?: number },
) => Promise<OfapiListPage>;

async function reconcileKind(
  input: {
    db: Database;
    kind: LinkStatKind;
    list: LinkLister;
    requestContext: OfapiRequestContext;
    pageId: number;
    ofapiAccountId: string;
    pulledAt: Date;
    guard: ReturnType<typeof createOfapiRestGuard>;
  },
): Promise<OfapiLinkStatsKindResult> {
  const normalized: InsertLinkStatSnapshotInput[] = [];
  const skippedReasons: Record<string, number> = {};
  let apiPages = 0;
  let rawItems = 0;
  let blockedReason: string | null = null;
  let walkComplete = false;

  for (let offset = 0; apiPages < LINK_STATS_MAX_PAGES_PER_RUN;) {
    const block = await input.guard.resolveBlock();
    if (block !== null) {
      blockedReason = block;
      break;
    }
    const page = await input.list(input.requestContext, input.ofapiAccountId, {
      limit: LINK_STATS_PAGE_LIMIT,
      offset,
    });
    await input.guard.recordResponse(page);
    // Stage 7 producer discipline: every fetched page is journaled untrimmed
    // (raw payload + observation dual-write) before projection. Loud on
    // failure — a page we cannot journal fails the page's reconcile.
    await persistRawPayload(input.db, {
      platformAccountId: input.pageId,
      endpoint: input.kind === "tracking"
        ? "/:accountId/tracking-links"
        : "/:accountId/trial-links",
      requestParams: { limit: LINK_STATS_PAGE_LIMIT, offset },
      responsePayload: page.items,
      mapperVersion: "link-stats-v1",
      payloadKind: "mapping_critical",
      // Stage 1 retention stand-down: captured facts are stamped far-future
      // (the cleanup job is a deliberate no-op) — never a real deletion date.
      retainUntil: retentionDate(input.pulledAt),
    }, { action: "journal link-stats page", platform: "onlyfans" });
    apiPages += 1;
    rawItems += page.items.length;
    for (const item of page.items) {
      const result = normalizeLinkItem(input.kind, input.pageId, item);
      if (result.status === "ok") {
        normalized.push(result.row);
      } else {
        skippedReasons[result.reason] = (skippedReasons[result.reason] ?? 0) + 1;
      }
    }
    if (page.items.length < LINK_STATS_PAGE_LIMIT) {
      walkComplete = true;
      break;
    }
    offset += page.items.length;
  }

  // A truncated walk still records its run row (status 'truncated') so the
  // attempt is visible, but writes NO snapshots: link absence is only
  // meaningful against a complete walk, and a partial snapshot set would
  // read as deletions downstream.
  const status: OfapiLinkStatsKindResult["status"] = walkComplete ? "written" : "truncated";
  const run = await insertLinkStatRun(input.db, {
    platformAccountId: input.pageId,
    linkKind: input.kind,
    status: walkComplete ? "complete" : "truncated",
    pulledAt: input.pulledAt,
    apiPages,
    rawItems,
    writtenRows: walkComplete ? normalized.length : 0,
  });
  let writtenRows = 0;
  if (walkComplete) {
    writtenRows = await insertLinkStatSnapshots(input.db, run.id, normalized);
  }

  return {
    linkKind: input.kind,
    status,
    reason: walkComplete ? null : blockedReason ?? "walk_truncated",
    apiPages,
    rawItems,
    writtenRows,
    skippedReasons,
  };
}

async function reconcilePage(
  app: AppContext,
  input: {
    pageId: number;
    pageLabel: string;
    ofapiAccountId: string;
    pulledAt: Date;
    guard: ReturnType<typeof createOfapiRestGuard>;
  },
): Promise<OfapiLinkStatsPageResult> {
  const listTrackingLinks = app.ofapi?.listTrackingLinks?.bind(app.ofapi);
  const listTrialLinks = app.ofapi?.listTrialLinks?.bind(app.ofapi);
  if (!listTrackingLinks || !listTrialLinks) {
    return {
      pageLabel: input.pageLabel,
      status: "skipped",
      reason: "ofapi_client_not_configured",
      kinds: [],
    };
  }

  // No proxy/dispatcher resolution here on purpose: the OFAPI list transport
  // (`observedListRequest`) performs a plain fetch and never consumes
  // `context.dispatcher` — OFAPI fronts each connected account with its own
  // vendor-side egress. The governed egress seam (`resolveOfapiEgressContext`)
  // belongs to the capture-jobs/read-gateway paths, not to list reconciles.
  // If `OfapiRequestContext` requires more fields than these, mirror the
  // minimal shape the other list-sync callers pass — do not add proxy code.
  const requestContext: OfapiRequestContext = {
    pageId: input.pageId,
    dispatcher: null,
    egressKey: null,
    creditBudgetScope: "backfill",
  };

  const kinds: OfapiLinkStatsKindResult[] = [];
  // Tracking first, then trial — a mid-page budget block still yields a
  // complete tracking run; kind isolation keeps one endpoint's failure from
  // discarding the other's completed walk.
  for (const [kind, list] of [
    ["tracking", listTrackingLinks],
    ["trial", listTrialLinks],
  ] as const satisfies ReadonlyArray<readonly [LinkStatKind, LinkLister]>) {
    kinds.push(await reconcileKind({
      db: app.db,
      kind,
      list,
      requestContext,
      pageId: input.pageId,
      ofapiAccountId: input.ofapiAccountId,
      pulledAt: input.pulledAt,
      guard: input.guard,
    }));
  }

  const written = kinds.filter((kind) => kind.status === "written").length;
  const status: OfapiLinkStatsPageResult["status"] = written === kinds.length
    ? "written"
    : written > 0
      ? "partial"
      : "skipped";
  const firstBlocked = kinds.find((kind) => kind.status !== "written");
  return {
    pageLabel: input.pageLabel,
    status,
    reason: firstBlocked?.reason ?? null,
    kinds,
  };
}

export async function runOfapiLinkStatsReconcile(app: AppContext) {
  if (!isOfapiLinkStatsReconcileEnabled(app.config)) {
    return { pages: [] as OfapiLinkStatsPageResult[] };
  }

  const mapped = (await listOfapiMappedPages(app.db))
    .filter((page) => page.platform === "onlyfans");
  const guard = createOfapiRestGuard(app, {
    maxRequestsPerRun: LINK_STATS_MAX_PAGES_PER_RUN * 2 * Math.max(1, mapped.length),
    dailyCreditBudget:
      app.config.ofapiBackfillDailyCreditBudget ?? DEFAULT_BACKFILL_DAILY_CREDIT_BUDGET,
    budgetScope: "backfill",
  });
  const pulledAt = new Date();

  const pages: OfapiLinkStatsPageResult[] = [];
  for (const page of mapped) {
    try {
      pages.push(await reconcilePage(app, {
        pageId: page.id,
        pageLabel: page.label,
        ofapiAccountId: page.ofapiAccountId,
        pulledAt,
        guard,
      }));
    } catch (error) {
      guard.abandonPendingReservation();
      const reason = error instanceof Error ? error.message : String(error);
      pages.push({
        pageLabel: page.label,
        status: "failed",
        reason,
        kinds: [],
      });
      app.logger.error({
        err: error,
        pageId: page.id,
        pageLabel: page.label,
      }, "OFAPI link-stats reconcile failed for page; continuing with remaining pages");
    }
  }

  const failed = pages.filter((page) => page.status === "failed");
  if (failed.length > 0) {
    const shown = failed.slice(0, 5)
      .map((page) => `${page.pageLabel}: ${page.reason ?? "unknown error"}`)
      .join("; ");
    const remainder = failed.length > 5 ? `; +${failed.length - 5} more` : "";
    await notifyOfapiGlobalIncident(app, {
      kind: "ofapi_link_stats_reconcile_failed",
      errorSummary: `${failed.length} page(s) failed: ${shown}${remainder}`,
    });
  } else if (pages.length > 0 && pages.every((page) => page.status === "written")) {
    await resolveOfapiGlobalIncident(app, {
      kind: "ofapi_link_stats_reconcile_failed",
    });
  }

  const degraded = pages.filter((page) => page.status === "partial" || page.status === "skipped");
  if (degraded.length > 0) {
    app.logger.warn({
      degraded: degraded.map((page) => ({ label: page.pageLabel, reason: page.reason })),
    }, "OFAPI link-stats reconcile incomplete for some pages");
  }
  app.logger.info({
    pages: pages.map((page) => ({
      label: page.pageLabel,
      status: page.status,
      reason: page.reason,
      kinds: page.kinds.map((kind) => ({
        kind: kind.linkKind,
        status: kind.status,
        apiPages: kind.apiPages,
        rawItems: kind.rawItems,
        writtenRows: kind.writtenRows,
      })),
    })),
  }, "OFAPI link-stats reconcile complete");

  return { pages };
}

export async function ensureOfapiLinkStatsQueue(
  boss: SyncQueueLifecycleClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(
    boss,
    OFAPI_LINK_STATS_RECONCILE_QUEUE,
    OFAPI_LINK_STATS_QUEUE_OPTIONS,
    createdQueues,
  );

  await boss.updateQueue(OFAPI_LINK_STATS_RECONCILE_QUEUE, {
    retryLimit: OFAPI_LINK_STATS_QUEUE_OPTIONS.retryLimit,
  });

  const queue = await boss.getQueue(OFAPI_LINK_STATS_RECONCILE_QUEUE);
  if (
    !queue ||
    queue.policy !== OFAPI_LINK_STATS_QUEUE_OPTIONS.policy ||
    queue.retryLimit !== OFAPI_LINK_STATS_QUEUE_OPTIONS.retryLimit
  ) {
    throw new Error(
      `Queue ${OFAPI_LINK_STATS_RECONCILE_QUEUE} configuration drift: expected ` +
      `policy=${OFAPI_LINK_STATS_QUEUE_OPTIONS.policy}, ` +
      `retryLimit=${OFAPI_LINK_STATS_QUEUE_OPTIONS.retryLimit}`,
    );
  }
}

export async function ensureOfapiLinkStatsSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  // Twice daily at 00:15/12:15 UTC — two observations per day; one failed
  // window still leaves a daily point for delta reports.
  await boss.schedule(OFAPI_LINK_STATS_RECONCILE_QUEUE, "15 0,12 * * *", null, { tz: "UTC" });
}

export async function startOfapiLinkStatsWorker(
  app: AppContext,
  boss: {
    work: (
      queue: string,
      options: { batchSize: number },
      handler: () => Promise<void>,
    ) => Promise<unknown>;
  },
) {
  await boss.work(OFAPI_LINK_STATS_RECONCILE_QUEUE, { batchSize: 1 }, async () => {
    const result = await runOfapiLinkStatsReconcile(app);
    const failed = result.pages.filter((page) => page.status === "failed");
    if (failed.length > 0) {
      throw new Error(`OFAPI link-stats reconcile failed for ${failed.length} page(s)`);
    }
  });
}
