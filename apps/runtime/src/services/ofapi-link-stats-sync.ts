// OFAPI trial/tracking link statistics reconcile (2026-07-22 plan). Twice a
// day, for every OFAPI-mapped OnlyFans page, walk the two link-list endpoints
// and append run + per-link snapshot rows. Counters are cumulative vendor
// values stored as observed; regressions are NOT clamped (chargebacks and
// deletions legitimately lower them) — the reporting layer owns delta
// semantics. List endpoints only: cost stays O(pages).

import {
  findLatestFinishedLinkStatRun,
  findPageByLabel,
  insertLinkStatRunWithSnapshots,
  listOfapiMappedPages,
  type Database,
  type InsertLinkStatSnapshotInput,
  type LinkStatKind,
} from "@agency_hub_core/db";
import { dollarsToMills } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { asRecord, idToString } from "./ofapi-payloads.ts";
import { ofapiAuthStatusNeedsAction } from "./ofapi-account-health.ts";
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

// Stored-cache page size (the free endpoints accept up to 1000, so a real
// inventory is virtually always a single page => an atomic, absence-proving
// read).
const LINK_STATS_PAGE_LIMIT = 1000;
// Offset-walk backstop per (page, kind) per run. There is no cross-run
// cursor, so a page whose inventory exceeds this cap could NEVER complete a
// walk — size it far beyond any real link inventory (200 pages = 20k links),
// exactly the chargebacks first-walk reasoning.
const LINK_STATS_MAX_PAGES_PER_RUN = 200;
// Own quota (config: ofapiLinkStatsDailyCreditBudget) on the DEDICATED
// link_stats day counter — isolated from the chargebacks backfill lane in
// both directions (neither job can starve the other).
const DEFAULT_LINK_STATS_DAILY_CREDIT_BUDGET = 50;
// A mapping collapse (every fetched item failing normalization) is only
// meaningful with enough evidence: a single bad vendor item on a one-link
// page must not page the operator as a fleet outage.
const MAPPING_COLLAPSE_MIN_ITEMS = 3;

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
  const revenueIsLoading = revenue && typeof revenue.isLoading === "boolean"
    ? revenue.isLoading
    : null;
  // Unknown money is NULL, never a fake zero: a missing revenue block, a
  // still-computing vendor value (isLoading), or an unparseable total must be
  // distinguishable from a link that genuinely earned $0.
  const revenueKnown = revenue !== null && revenueIsLoading !== true;
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
      spendersCount: revenueKnown ? parseCounter(revenue.spendersCount) : null,
      revenueGrossMills: revenueKnown ? parseDollarMills(revenue.total) : null,
      revenueIsLoading,
      revenueCalculatedAt: parseDate(revenue?.calculatedAt),
    },
  };
}

export interface OfapiLinkStatsKindResult {
  linkKind: LinkStatKind;
  // 'partial' = walk finished but some items were dropped; 'failed' = the
  // endpoint threw, or every fetched item failed normalization (a mapping
  // collapse must be as loud as an outage, not a quiet 'written').
  status: "written" | "partial" | "truncated" | "failed";
  reason: string | null;
  apiPages: number;
  rawItems: number;
  writtenRows: number;
  skippedReasons: Record<string, number>;
}

export interface OfapiLinkStatsPageResult {
  pageLabel: string;
  // 'truncated' (walks ran but none finished) is distinct from 'skipped'
  // (nothing ran at all, e.g. no OFAPI client) — conflating them would hide
  // a page burning credits without ever landing a snapshot.
  status: "written" | "partial" | "truncated" | "skipped" | "failed";
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
        ? "/:accountId/stored/tracking-links"
        : "/:accountId/stored/trial-links",
      requestParams: { limit: LINK_STATS_PAGE_LIMIT, offset },
      // Record shape, not a bare array: the sync-pull canonicalizer starts
      // with isRecord(payload) — a top-level array would be unparseable by
      // the very "capture now, parse later" machinery this write feeds.
      responsePayload: { items: page.items, hasNextPage: page.hasNextPage },
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
    // Terminality comes from the vendor's pagination signal, not from the
    // page size: a short page with hasNextPage=true must keep walking, and a
    // full page with hasNextPage=false is complete. An empty page that still
    // claims continuation is a vendor contradiction — never mark it complete.
    if (page.items.length === 0 && page.hasNextPage) {
      blockedReason = "pagination_contradiction";
      break;
    }
    if (!page.hasNextPage) {
      walkComplete = true;
      break;
    }
    offset += page.items.length;
  }

  // Offset pagination over a live list can re-return a boundary item when a
  // link is created/deleted mid-walk; last write wins so the unique
  // (run_id, platform_link_id) can never abort the insert.
  const deduped = new Map<string, InsertLinkStatSnapshotInput>();
  for (const row of normalized) {
    deduped.set(row.platformLinkId, row);
  }
  const rows = [...deduped.values()];

  const skippedTotal = Object.values(skippedReasons).reduce((sum, count) => sum + count, 0);
  // A complete walk that suddenly sees ZERO items where the last complete run
  // had links is suspicious, not proof of mass deletion: the client
  // normalizes any malformed HTTP 200 (renamed list field, data:null) into an
  // empty page with hasNextPage=false, which is indistinguishable from a
  // genuinely emptied inventory. Withhold the absence proof ('partial'); a
  // real wipe re-proves itself on the next run against the new baseline.
  let inventoryVanished = false;
  let emptyUnverified = false;
  if (walkComplete && rawItems === 0) {
    const baseline = await findLatestFinishedLinkStatRun(input.db, {
      platformAccountId: input.pageId,
      linkKind: input.kind,
    });
    // Baseline emptiness is judged by rawItems (what the vendor SHOWED), not
    // writtenRows: a mapping-collapse run (items seen, all dropped) is a
    // NON-empty baseline — its links did not stop existing.
    // Converges: this run lands as 'partial' with rawItems=0, so the NEXT
    // empty walk sees an empty baseline and records a genuine 'complete'.
    inventoryVanished = baseline !== null && baseline.rawItems > 0;
    // Cold-cache guard: the stored endpoints are the vendor's Computed cache;
    // a page whose cache was never populated returns an empty 200 that is
    // indistinguishable from a genuinely link-less page. The FIRST empty walk
    // (no finished baseline at all) is therefore 'partial'; the second one
    // proves the emptiness.
    emptyUnverified = baseline === null;
  }
  // 'complete' (single atomic vendor read, zero drops) is the ONLY
  // absence-proving status. Demotions to 'partial': (a) normalization drops —
  // a skipped-yet-existing link must not read as deleted; (b) a MULTI-PAGE
  // offset walk — the vendor list can shift between pages and silently omit
  // a boundary item, so only a single-page walk is an atomic read (upgrade
  // path: stable cursor or vendor-total verification); (c) the vanished-
  // inventory guard above. A truncated walk records the attempt and writes NO
  // snapshots. Run row + snapshots commit atomically — a 'complete' run
  // without its rows is a lie.
  const runStatus = walkComplete
    ? (skippedTotal > 0 || apiPages > 1 || inventoryVanished || emptyUnverified
      ? "partial" as const
      : "complete" as const)
    : "truncated" as const;
  const { writtenRows } = await insertLinkStatRunWithSnapshots(
    input.db,
    {
      platformAccountId: input.pageId,
      linkKind: input.kind,
      status: runStatus,
      pulledAt: input.pulledAt,
      apiPages,
      rawItems,
      writtenRows: walkComplete ? rows.length : 0,
    },
    walkComplete ? rows : [],
  );

  // Every fetched item failing normalization is a mapping collapse (vendor
  // renamed a field, adapter rot) — report it as loudly as an outage, but
  // only with enough evidence (absolute threshold): one bad item on a
  // one-link page stays 'partial', not a fleet incident. The run row above
  // records the durable evidence either way.
  const status: OfapiLinkStatsKindResult["status"] = !walkComplete
    ? "truncated"
    : rawItems >= MAPPING_COLLAPSE_MIN_ITEMS && writtenRows === 0
      ? "failed"
      : skippedTotal > 0 || inventoryVanished || emptyUnverified
        ? "partial"
        : "written";
  return {
    linkKind: input.kind,
    status,
    reason: status === "failed"
      ? "all_items_skipped"
      : inventoryVanished
        ? "inventory_vanished"
        : emptyUnverified
          ? "empty_unverified"
          : walkComplete ? null : blockedReason ?? "walk_truncated",
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
  // The STORED variants: identical item shape, `_credits.used: 0`, limit
  // 1000, and the cache includes finished links the live list hides
  // (live-verified 2026-07-22). The credit guard stays as a safety belt —
  // reservations settle to the server-reported 0.
  // Freshness contract: stored is the vendor's Computed cache — counters are
  // as fresh as the vendor's own sync, revenue freshness is queryable per
  // row via revenue_calculated_at, and pulled_at stamps OUR read, not the
  // vendor's refresh. Two identical consecutive snapshots therefore mean
  // "no vendor refresh in between", which daily-delta reports must treat as
  // zero-change, not data loss. The cold-cache guard below keeps an
  // unpopulated cache from minting a false absence proof.
  const listTrackingLinks = app.ofapi?.listStoredTrackingLinks?.bind(app.ofapi);
  const listTrialLinks = app.ofapi?.listStoredTrialLinks?.bind(app.ofapi);
  if (!listTrackingLinks || !listTrialLinks) {
    return {
      pageLabel: input.pageLabel,
      status: "skipped",
      reason: "ofapi_client_not_configured",
      kinds: [],
    };
  }

  // Tombstone re-check: the fleet list is snapshotted once at run start, but
  // an admin can soft-delete or remap a page while earlier pages walk.
  // Re-verifying right before this page's walk narrows the race to one page;
  // rows written in the residual window are page-scoped facts that the
  // erasure hot targets purge (the tombstone->erasure path), so no fact
  // outlives the contract.
  const stored = await findPageByLabel(app.db, input.pageLabel);
  if (!stored) {
    return {
      pageLabel: input.pageLabel,
      status: "skipped",
      reason: "page_not_active",
      kinds: [],
    };
  }
  if (stored.page.ofapiAccountId !== input.ofapiAccountId) {
    return {
      pageLabel: input.pageLabel,
      status: "skipped",
      reason: "ofapi_mapping_changed",
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
    // Same lane as the guard's reservation scope: physical spend attribution
    // and the day-counter reservation must never split across lanes.
    creditBudgetScope: "link_stats",
  };

  const kinds: OfapiLinkStatsKindResult[] = [];
  // Kind isolation must hold in BOTH directions: a throwing tracking endpoint
  // must not prevent the trial walk (and vice versa). Each kind gets its own
  // catch; the page is reported failed afterwards so the incident still fires.
  for (const [kind, list] of [
    ["tracking", listTrackingLinks],
    ["trial", listTrialLinks],
  ] as const satisfies ReadonlyArray<readonly [LinkStatKind, LinkLister]>) {
    try {
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
    } catch (error) {
      // A failed request never settled its credit reservation — release the
      // in-memory token so the other kind (and other pages) can proceed.
      input.guard.abandonPendingReservation();
      kinds.push({
        linkKind: kind,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
        apiPages: 0,
        rawItems: 0,
        writtenRows: 0,
        skippedReasons: {},
      });
      app.logger.error({
        err: error,
        pageId: input.pageId,
        linkKind: kind,
      }, "OFAPI link-stats kind walk failed; continuing with the other kind");
    }
  }

  const written = kinds.filter((kind) => kind.status === "written").length;
  const failed = kinds.find((kind) => kind.status === "failed");
  const anyLanded = kinds.some(
    (kind) => kind.status === "written" || kind.status === "partial",
  );
  const status: OfapiLinkStatsPageResult["status"] = failed
    ? "failed"
    : written === kinds.length
      ? "written"
      : anyLanded
        ? "partial"
        : "truncated";
  const firstDegraded = failed ?? kinds.find((kind) => kind.status !== "written");
  return {
    pageLabel: input.pageLabel,
    status,
    reason: firstDegraded?.reason ?? null,
    kinds,
  };
}

export async function runOfapiLinkStatsReconcile(app: AppContext) {
  if (!isOfapiLinkStatsReconcileEnabled(app.config)) {
    return { pages: [] as OfapiLinkStatsPageResult[] };
  }

  // Stage-26 auth-dead pause: a page whose OFAPI session needs owner action
  // (authentication_failed / otp / face-otp) gets no scheduled spend — the
  // account-health incident already covers it.
  const mapped = (await listOfapiMappedPages(app.db))
    .filter((page) => page.platform === "onlyfans")
    .filter((page) => !ofapiAuthStatusNeedsAction(page.ofapiAuthStatus));
  const guard = createOfapiRestGuard(app, {
    maxRequestsPerRun: LINK_STATS_MAX_PAGES_PER_RUN * 2 * Math.max(1, mapped.length),
    // Dedicated link_stats day counter (migration 0113): the quota is
    // isolated from the chargebacks backfill lane in BOTH directions —
    // chargebacks spend cannot block link-stats, and link-stats cannot eat
    // the lane the chargebacks first-walk depends on. Requires the credit
    // ledger ON; with it off the guard falls back to the global counter
    // (see the config-registry note on the flag).
    dailyCreditBudget:
      app.config.ofapiLinkStatsDailyCreditBudget ?? DEFAULT_LINK_STATS_DAILY_CREDIT_BUDGET,
    budgetScope: "link_stats",
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
  // A fleet pass where EVERY page truncated (budget exhaustion, pagination
  // contradictions) writes zero snapshots while the job stays green — that
  // silence must be an incident, not a warn line.
  const allTruncated = pages.length > 0 && pages.every((page) => page.status === "truncated");
  if (failed.length > 0) {
    const shown = failed.slice(0, 5)
      .map((page) => `${page.pageLabel}: ${page.reason ?? "unknown error"}`)
      .join("; ");
    const remainder = failed.length > 5 ? `; +${failed.length - 5} more` : "";
    await notifyOfapiGlobalIncident(app, {
      kind: "ofapi_link_stats_reconcile_failed",
      errorSummary: `${failed.length} page(s) failed: ${shown}${remainder}`,
    });
  } else if (allTruncated) {
    await notifyOfapiGlobalIncident(app, {
      kind: "ofapi_link_stats_reconcile_failed",
      errorSummary:
        `fleet fully truncated (${pages.length} page(s)): no snapshots written — ` +
        `check the link_stats credit budget`,
    });
  } else if (
    pages.length > 0 &&
    pages.every((page) =>
      page.kinds.length > 0 &&
      page.kinds.every((kind) => kind.status === "written" || kind.status === "partial"))
  ) {
    // Recovery = every processed page finished BOTH walks (written/partial).
    // A skipped page (no client) or any truncated kind proves nothing and
    // must not close the latch; a page stuck at 'partial' (one permanently
    // unparseable vendor item) must not pin it open either.
    await resolveOfapiGlobalIncident(app, {
      kind: "ofapi_link_stats_reconcile_failed",
    });
  }

  const degraded = pages.filter((page) =>
    page.status === "partial" || page.status === "truncated" || page.status === "skipped",
  );
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
  // Twice daily at 04:45/16:45 UTC — two observations per day (one failed
  // window still leaves a daily point). The stored endpoints are free and the
  // credit lane is dedicated (0113), so the placement after chargebacks'
  // 03:10 window is just polite scheduling, not a budget dependency.
  await boss.schedule(OFAPI_LINK_STATS_RECONCILE_QUEUE, "45 4,16 * * *", null, { tz: "UTC" });
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
