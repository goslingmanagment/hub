// OFAPI trial/tracking link statistics reconcile (2026-07-22 plan). Four
// times a day, for every active OnlyFans page, walk the two link-list
// endpoints and append run + per-link snapshot rows. Counters are cumulative
// vendor values stored as observed; regressions are NOT clamped (chargebacks
// and deletions legitimately lower them) — the reporting layer owns delta
// semantics. List endpoints only: cost stays O(pages).
//
// Every attempt is a row (2026-10-08 plan, PR 2): a pass leaves exactly one
// page_link_stat_runs row per (page, link kind) it was responsible for —
// a finished walk, a truncated one, a `failed` request or write, or a
// `skipped` page (no OFAPI mapping, dead session, mapping changed under the
// pass, no client) — stamped with the scheduled window it belongs to and the
// OFAPI account the page was bound to. A hole in the series is then a fact a
// query reads, not something found by counting windows.
//
// A window is not lost to one failure (PR 3): a (page, kind) without a usable
// result is read again inside its window — 15 min, 45 min and 2 h later — and
// a page the binding reconciler moved to another OFAPI account is read 20 min
// after the move. Both are targeted passes on their own queue; they read only
// the pairs that still lack a result. The reads are free at the vendor, so
// the lane neither reserves credits nor stops at the credit floor.

import {
  findLatestFinishedLinkStatRun,
  findLatestNonEmptyFinishedLinkStatRun,
  findPageByLabel,
  hasNonEmptyLinkStatRunUnderAnotherAccount,
  insertLinkStatRun,
  insertLinkStatRunWithSnapshots,
  listLinkStatWindowPairStates,
  listOfapiBindingPages,
  type Database,
  type InsertLinkStatSnapshotInput,
  type LinkStatKind,
} from "@agency_hub_core/db";
import { dollarsToMills, sanitizeError } from "@agency_hub_core/shared";

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
import {
  nextOfapiLinkStatsWindowAt,
  OFAPI_LINK_STATS_CRON,
  OFAPI_LINK_STATS_REBIND_RUN_DELAY_MS,
  OFAPI_LINK_STATS_RETRY_DELAYS_MS,
  ofapiLinkStatsWindowAt,
} from "./ofapi-link-stats-windows.ts";

export const OFAPI_LINK_STATS_RECONCILE_QUEUE = "ofapi.link-stats.reconcile";
export const OFAPI_LINK_STATS_RETRY_QUEUE = "ofapi.link-stats.retry";

const LINK_STAT_KINDS = ["tracking", "trial"] as const satisfies readonly LinkStatKind[];
const SECOND_MS = 1_000;

// A failed fleet pass is durable and operator-visible through the global
// incident; retrying the pg-boss job would repeat every healthy page's walk.
const OFAPI_LINK_STATS_QUEUE_OPTIONS = {
  policy: "exclusive",
  retryLimit: 0,
} as const;

// The targeted passes — a window's retries, the run after a rebind — have a
// queue of their own. They cannot ride the scheduled one: `exclusive` there
// means at most one job queued OR active, so a second retry (or a rebind run)
// sent while the first waits would silently not be created, and a retry still
// waiting when the next window opens would keep the cron from creating that
// window's job. `short` keeps at most one QUEUED job per singleton key: the
// same retry is never queued twice, different ones wait side by side, and a
// running pass blocks nothing. pg-boss never retries a job here either — the
// retries are the passes themselves, each one a row of the series.
const OFAPI_LINK_STATS_RETRY_QUEUE_OPTIONS = {
  policy: "short",
  retryLimit: 0,
} as const;

/** Rows a (page, kind) can get in one window from the scheduled pass and its
 * retries. A pair that used them all waits for the next window. */
const MAX_ATTEMPTS_PER_WINDOW = 1 + OFAPI_LINK_STATS_RETRY_DELAYS_MS.length;

/** A pair whose last row of the window says the pass could make no request
 * for a standing reason is not retried: nothing changes in 15 minutes, and
 * the retries would only stack `skipped` rows. A page without a mapping is
 * read again by the run that follows its rebind. A dead session is NOT such
 * a reason: OFAPI restores a session on the same account (accounts.
 * reconnected) without any rebind and without a link run, so a retry reads
 * it again — reconcilePage checks the current auth status and skips the page
 * once more if it is still dead. */
const NOT_RETRIED_SKIP_REASONS = new Set([
  "page_unmapped",
  "ofapi_client_not_configured",
]);

/** The payload of a job on the retry queue. */
export type OfapiLinkStatsTargetedJob =
  | { trigger: "retry"; windowAt: string; retry: number }
  | { trigger: "rebind"; pageId: number };

/** What a targeted pass was asked to do, parsed. */
export type OfapiLinkStatsTarget =
  | { trigger: "retry"; windowAt: Date; retry: number }
  | { trigger: "rebind"; pageId: number };

/** The slice of pg-boss a pass needs to queue what follows it. */
export interface OfapiLinkStatsSender {
  send(
    name: string,
    data: OfapiLinkStatsTargetedJob,
    options: { startAfter: number; singletonKey: string; retryLimit: number },
  ): Promise<unknown>;
}

export function parseOfapiLinkStatsTargetedJob(data: unknown): OfapiLinkStatsTarget | null {
  const job = asRecord(data);
  if (job?.trigger === "retry") {
    const windowAt = parseDate(job.windowAt);
    const retry = job.retry;
    return windowAt !== null && typeof retry === "number" && Number.isInteger(retry) &&
      retry >= 1 && retry <= OFAPI_LINK_STATS_RETRY_DELAYS_MS.length
      ? { trigger: "retry", windowAt, retry }
      : null;
  }
  if (job?.trigger === "rebind") {
    const pageId = job.pageId;
    return typeof pageId === "number" && Number.isInteger(pageId) && pageId > 0
      ? { trigger: "rebind", pageId }
      : null;
  }
  return null;
}

// Stored-cache page size (the free endpoints accept up to 1000, so a real
// inventory is virtually always a single page => an atomic, absence-proving
// read).
const LINK_STATS_PAGE_LIMIT = 1000;
// Offset-walk backstop per (page, kind) per run. There is no cross-run
// cursor, so a page whose inventory exceeds this cap could NEVER complete a
// walk — size it far beyond any real link inventory (20 pages x 1000 = 20k
// links), exactly the chargebacks first-walk reasoning.
const LINK_STATS_MAX_PAGES_PER_RUN = 20;
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
  // The snapshot columns are PostgreSQL INTEGER: a larger vendor counter must
  // fail normalization (controlled skip), never abort the insert transaction.
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
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

/** What one fleet pass stamps on every row it writes. */
interface LinkStatsAttemptStamp {
  /** When the pass read (or would have read) the vendor cache. */
  pulledAt: Date;
  /** The scheduled window the pass belongs to. */
  windowAt: Date;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The error as a `failed` row keeps it. The series is read by people and by
 * agents, so the text goes through the shared projection: secrets redacted,
 * a driver error's SQL and bound values replaced by its type and code. */
function failedAttemptReason(error: unknown): string {
  return sanitizeError(error, {
    maxChars: 500,
    truncation: "ellipsis",
    trim: true,
    queryStyleMessage: ({ name, code }) => `database query failed (${code ?? name})`,
    fallbackMessage: "unknown error",
  }).message;
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
    stamp: LinkStatsAttemptStamp;
    guard: ReturnType<typeof createOfapiRestGuard>;
    /** How far the walk got, for the `failed` row when it throws. */
    progress: { apiPages: number; rawItems: number };
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
      // Logical stream name, not a URL template: this string keys
      // observations.kind / producer for the canonicalizer and health floors.
      // The HTTP path lives in requestParams.
      endpoint: input.kind === "tracking" ? "link_stats_tracking" : "link_stats_trial",
      requestParams: {
        limit: LINK_STATS_PAGE_LIMIT,
        offset,
        path: input.kind === "tracking"
          ? "/:accountId/stored/tracking-links"
          : "/:accountId/stored/trial-links",
      },
      // Record shape, not a bare array: the sync-pull canonicalizer starts
      // with isRecord(payload) — a top-level array would be unparseable by
      // the very "capture now, parse later" machinery this write feeds.
      responsePayload: { items: page.items, hasNextPage: page.hasNextPage },
      mapperVersion: "link-stats-v1",
      payloadKind: "mapping_critical",
      // Stage 1 retention stand-down: captured facts are stamped far-future
      // (the cleanup job is a deliberate no-op) — never a real deletion date.
      retainUntil: retentionDate(input.stamp.pulledAt),
    }, { action: "journal link-stats page", platform: "onlyfans" });
    apiPages += 1;
    rawItems += page.items.length;
    input.progress.apiPages = apiPages;
    input.progress.rawItems = rawItems;
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
  //
  // Both questions are asked of THIS OFAPI ACCOUNT, not of the page: the
  // stored lists are the vendor's cache of one connection, and a freshly
  // connected account starts cold. Judged per page, the second empty read
  // after an account change saw "an empty baseline" and minted 'complete' —
  // to a reader, every link deleted.
  let inventoryVanished = false;
  let emptyUnverified = false;
  let bindingChanged = false;
  if (walkComplete) {
    const seenUnderAccount = await findLatestNonEmptyFinishedLinkStatRun(input.db, {
      platformAccountId: input.pageId,
      linkKind: input.kind,
      ofapiAccountId: input.ofapiAccountId,
    });
    if (rawItems === 0) {
      // An account that has NEVER shown a non-empty inventory can never prove
      // absence: an empty stored read there is indistinguishable from an
      // unpopulated vendor cache (Computed endpoint) or a malformed-200
      // normalized to []. Such walks stay 'partial' (empty_unverified) until
      // a non-empty walk is observed under the account — absence proofs are
      // reserved for inventories we have actually seen.
      if (seenUnderAccount === null) {
        emptyUnverified = true;
      } else {
        const baseline = await findLatestFinishedLinkStatRun(input.db, {
          platformAccountId: input.pageId,
          linkKind: input.kind,
          ofapiAccountId: input.ofapiAccountId,
        });
        // Baseline emptiness is judged by rawItems (what the vendor SHOWED),
        // not writtenRows: a mapping-collapse run (items seen, all dropped) is
        // a NON-empty baseline — its links did not stop existing. Post-wipe
        // convergence is two-step by documented design: the first empty walk
        // is 'partial' (inventory_vanished), the second proves the emptiness.
        inventoryVanished = baseline !== null && baseline.rawItems > 0;
      }
    } else if (seenUnderAccount === null) {
      // The first non-empty walk under this account. If the pair showed links
      // under another account before, the page was rebound: the new cache may
      // be only partly warm, so the walk is not an absence proof, and a reader
      // comparing it with the previous point must know the account changed
      // (the vendor recalculates revenue after a reconnection). A page's very
      // first inventory is not a binding change.
      bindingChanged = await hasNonEmptyLinkStatRunUnderAnotherAccount(input.db, {
        platformAccountId: input.pageId,
        linkKind: input.kind,
        ofapiAccountId: input.ofapiAccountId,
      });
    }
  }
  // 'complete' (single atomic vendor read, zero drops) is the ONLY
  // absence-proving status. Demotions to 'partial', each named in `reason`:
  // (a) normalization drops — a skipped-yet-existing link must not read as
  // deleted; (b) a MULTI-PAGE offset walk — the vendor list can shift between
  // pages and silently omit a boundary item, so only a single-page walk is an
  // atomic read (upgrade path: stable cursor or vendor-total verification);
  // (c) the empty-inventory guards above; (d) the first non-empty walk after
  // a binding change. A truncated walk records the attempt and writes NO
  // snapshots. Run row + snapshots commit atomically — a 'complete' run
  // without its rows is a lie.
  const caveats = [
    bindingChanged ? "binding_changed" : null,
    inventoryVanished ? "inventory_vanished" : null,
    emptyUnverified ? "empty_unverified" : null,
    skippedTotal > 0 ? (rows.length === 0 ? "all_items_skipped" : "items_skipped") : null,
    apiPages > 1 ? "multi_page" : null,
  ].filter((caveat): caveat is string => caveat !== null);
  const runStatus = walkComplete
    ? (caveats.length > 0 ? "partial" as const : "complete" as const)
    : "truncated" as const;
  const { writtenRows } = await insertLinkStatRunWithSnapshots(
    input.db,
    {
      platformAccountId: input.pageId,
      linkKind: input.kind,
      status: runStatus,
      pulledAt: input.stamp.pulledAt,
      apiPages,
      rawItems,
      writtenRows: walkComplete ? rows.length : 0,
      reason: walkComplete
        ? (caveats.length > 0 ? caveats.join(",") : null)
        : blockedReason ?? "walk_truncated",
      windowAt: input.stamp.windowAt,
      ofapiAccountId: input.ofapiAccountId,
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
      : skippedTotal > 0 || inventoryVanished || emptyUnverified || bindingChanged
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
          : bindingChanged
            ? "binding_changed"
            : walkComplete ? null : blockedReason ?? "walk_truncated",
    apiPages,
    rawItems,
    writtenRows,
    skippedReasons,
  };
}

/** Records an attempt that ended without a walk row of its own — a request
 * or write that threw. Never throws: the caller is already reporting the
 * failure, and a series write that fails too (the database is the likeliest
 * cause of both) must not replace the original error with its own. */
async function recordFailedAttempt(
  app: AppContext,
  input: {
    pageId: number;
    kind: LinkStatKind;
    ofapiAccountId: string | null;
    stamp: LinkStatsAttemptStamp;
    /** What was thrown; the row keeps its sanitized text. */
    error: unknown;
    progress?: { apiPages: number; rawItems: number };
  },
) {
  const reason = failedAttemptReason(input.error);
  try {
    await insertLinkStatRun(app.db, {
      platformAccountId: input.pageId,
      linkKind: input.kind,
      status: "failed",
      pulledAt: input.stamp.pulledAt,
      apiPages: input.progress?.apiPages ?? 0,
      rawItems: input.progress?.rawItems ?? 0,
      writtenRows: 0,
      reason,
      windowAt: input.stamp.windowAt,
      ofapiAccountId: input.ofapiAccountId,
    });
  } catch (error) {
    app.logger.error({
      err: error,
      pageId: input.pageId,
      linkKind: input.kind,
      reason,
    }, "OFAPI link-stats failed attempt could not be recorded in the series");
  }
}

async function reconcilePage(
  app: AppContext,
  input: {
    pageId: number;
    pageLabel: string;
    /** The mapping the fleet snapshot saw; null = the page has none. */
    ofapiAccountId: string | null;
    stamp: LinkStatsAttemptStamp;
    guard: ReturnType<typeof createOfapiRestGuard>;
    /** The kinds this pass reads for the page: both on a scheduled pass, the
     * ones still without a usable result on a targeted one. */
    kinds: readonly LinkStatKind[];
    /** Kinds that already have their row of this pass; the caller writes a
     * `failed` row for the rest when this function throws. */
    recorded: Set<LinkStatKind>;
  },
): Promise<OfapiLinkStatsPageResult> {
  // Tombstone re-check: the fleet list is snapshotted once at run start, but
  // an admin can soft-delete or remap a page while earlier pages walk.
  // Re-verifying right before this page's turn narrows the race to one page;
  // rows written in the residual window are page-scoped facts that the
  // erasure hot targets purge (the tombstone->erasure path), so no fact
  // outlives the contract. A page that is no longer active has left the
  // series' population: it gets no row at all, not even a `skipped` one.
  const stored = await findPageByLabel(app.db, input.pageLabel);
  if (!stored) {
    return {
      pageLabel: input.pageLabel,
      status: "skipped",
      reason: "page_not_active",
      kinds: [],
    };
  }

  // No attempt is made, and the series says so: one `skipped` row per kind
  // with the reason. A failing write is NOT swallowed here — it escapes to
  // the pass, which reports the page failed.
  const skip = async (
    reason: string,
    ofapiAccountId: string | null,
  ): Promise<OfapiLinkStatsPageResult> => {
    for (const kind of input.kinds) {
      await insertLinkStatRun(app.db, {
        platformAccountId: input.pageId,
        linkKind: kind,
        status: "skipped",
        pulledAt: input.stamp.pulledAt,
        apiPages: 0,
        rawItems: 0,
        writtenRows: 0,
        reason,
        windowAt: input.stamp.windowAt,
        ofapiAccountId,
      });
      input.recorded.add(kind);
    }
    return { pageLabel: input.pageLabel, status: "skipped", reason, kinds: [] };
  };

  if (stored.page.ofapiAccountId !== input.ofapiAccountId) {
    return skip("ofapi_mapping_changed", stored.page.ofapiAccountId);
  }
  const ofapiAccountId = input.ofapiAccountId;
  if (ofapiAccountId === null) {
    return skip("page_unmapped", null);
  }
  // Stage-26 auth-dead pause: a page whose OFAPI session needs owner action
  // (authentication_failed / otp / face-otp) gets no scheduled request — the
  // account-health incident already covers it.
  if (ofapiAuthStatusNeedsAction(stored.page.ofapiAuthStatus)) {
    return skip("page_auth_dead", ofapiAccountId);
  }

  // The STORED variants: identical item shape, `_credits.used: 0`, limit
  // 1000, and the cache includes finished links the live list hides
  // (live-verified 2026-07-22). The guard reserves nothing for them; the
  // lane's quota counts only what the vendor actually charged.
  // Freshness contract: stored is the vendor's Computed cache — counters are
  // as fresh as the vendor's own sync, revenue freshness is queryable per
  // row via revenue_calculated_at, and pulled_at stamps OUR read, not the
  // vendor's refresh. Two identical consecutive snapshots therefore mean
  // "no vendor refresh in between", which daily-delta reports must treat as
  // zero-change, not data loss. The cold-cache guard in reconcileKind keeps
  // an unpopulated cache from minting a false absence proof.
  const listTrackingLinks = app.ofapi?.listStoredTrackingLinks?.bind(app.ofapi);
  const listTrialLinks = app.ofapi?.listStoredTrialLinks?.bind(app.ofapi);
  if (!listTrackingLinks || !listTrialLinks) {
    return skip("ofapi_client_not_configured", ofapiAccountId);
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
  for (const [kind, list] of ([
    ["tracking", listTrackingLinks],
    ["trial", listTrialLinks],
  ] as const satisfies ReadonlyArray<readonly [LinkStatKind, LinkLister]>)
    .filter(([kind]) => input.kinds.includes(kind))) {
    const progress = { apiPages: 0, rawItems: 0 };
    try {
      kinds.push(await reconcileKind({
        db: app.db,
        kind,
        list,
        requestContext,
        pageId: input.pageId,
        ofapiAccountId,
        stamp: input.stamp,
        guard: input.guard,
        progress,
      }));
      input.recorded.add(kind);
    } catch (error) {
      // Nothing is reserved for a free read, so there is no token to release;
      // the call stays for a guard that does reserve.
      input.guard.abandonPendingReservation();
      const reason = errorText(error);
      kinds.push({
        linkKind: kind,
        status: "failed",
        reason,
        apiPages: 0,
        rawItems: 0,
        writtenRows: 0,
        skippedReasons: {},
      });
      // The failure is a row of the series too: reconcileKind writes its run
      // row last, so a throw means the kind has none yet.
      await recordFailedAttempt(app, {
        pageId: input.pageId,
        kind,
        ofapiAccountId,
        stamp: input.stamp,
        error,
        progress,
      });
      input.recorded.add(kind);
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

/** What stopped a walk, in the words of the incident. The guard's own codes
 * cannot be quoted there: the incident sanitizer redacts anything shaped like
 * an OFAPI key, and `ofapi_…` is. */
function describeTruncation(reason: string): string {
  switch (reason) {
    case "ofapi_daily_credit_budget":
      return "the vendor charged the lane's whole daily quota for stored reads (they are meant to be free)";
    case "ofapi_request_budget":
      return "the pass reached its request cap";
    default:
      return reason;
  }
}

/** Skips the pass decided before making any request, for a reason another
 * signal owns: a dead session has its ofapi_auth incident, a page without a
 * mapping is the binding reconciler's to repair. Before every attempt became
 * a row these pages were not part of the pass at all, so they stay out of its
 * fleet verdict (the global incident's open/resolve rules below). */
const NOT_ATTEMPTED_REASONS = new Set(["page_unmapped", "page_auth_dead"]);

export interface OfapiLinkStatsReconcileOptions {
  /** The pass's clock: `pulled_at` of its rows and, through it, their window. */
  now?: Date;
  /** A targeted pass: a window's retry or the run after a rebind. It reads
   * only the pairs that have no usable result in the window. Without it the
   * pass is the scheduled one and reads every page. */
  target?: OfapiLinkStatsTarget;
  /** Where the pass queues the retry that follows it. Without a sender it
   * queues none (the CLI, tests that drive the retries themselves). */
  boss?: OfapiLinkStatsSender;
}

export interface OfapiLinkStatsReconcileResult {
  pages: OfapiLinkStatsPageResult[];
  /** The retry this pass queued for its window, if any. */
  queuedRetry: { windowAt: Date; retry: number; startAfterSeconds: number } | null;
}

type LinkStatsFleetPage = Awaited<ReturnType<typeof listOfapiBindingPages>>[number];

function pairKey(pageId: number, kind: LinkStatKind) {
  return `${pageId}:${kind}`;
}

/** Does every page the pass can read have a usable result for both kinds in
 * the window? */
async function windowHasEveryResult(
  app: AppContext,
  input: { walkable: readonly LinkStatsFleetPage[]; windowAt: Date },
): Promise<boolean> {
  const usable = new Set(
    (await listLinkStatWindowPairStates(app.db, { windowAt: input.windowAt }))
      .filter((state) => state.hasUsableResult)
      .map((state) => pairKey(state.platformAccountId, state.linkKind)),
  );
  return input.walkable.every((page) =>
    LINK_STAT_KINDS.every((kind) => usable.has(pairKey(page.id, kind))));
}

/** Queues the window's next retry. It is persisted BEFORE the pass reads
 * anything — a pass that dies halfway (a crashed worker, a database error
 * while listing the fleet) must not take the rest of the window's retries
 * with it, and neither queue retries a job. Which pairs the retry reads is
 * decided when it runs: those with NO USABLE RESULT in the window then (the
 * shared rule, linkStatRunUsableResultSql) — a failed, skipped or truncated
 * row, or a partial that gave the series nothing, does not cancel it by
 * existing. A retry that finds every pair with a result reads nothing; it
 * costs a few selects. */
async function queueNextRetry(
  app: AppContext,
  input: {
    boss: OfapiLinkStatsSender | undefined;
    windowAt: Date;
    /** 0 for the scheduled pass and a rebind run, n for retry n. */
    retriesDone: number;
    now: Date;
  },
): Promise<OfapiLinkStatsReconcileResult["queuedRetry"]> {
  const retry = input.retriesDone + 1;
  const delayMs = OFAPI_LINK_STATS_RETRY_DELAYS_MS[retry - 1];
  if (!input.boss || delayMs === undefined) {
    return null;
  }
  // A retry that would start after the window closed has nothing to fill:
  // the next window's own pass is the series' next point.
  if (input.now.getTime() + delayMs >= nextOfapiLinkStatsWindowAt(input.windowAt).getTime()) {
    return null;
  }
  // The delays are whole minutes, so the division is exact.
  const startAfterSeconds = delayMs / SECOND_MS;
  await input.boss.send(
    OFAPI_LINK_STATS_RETRY_QUEUE,
    { trigger: "retry", windowAt: input.windowAt.toISOString(), retry },
    {
      startAfter: startAfterSeconds,
      // One queued job per (window, retry): a pass that runs twice does not
      // start a second chain of retries.
      singletonKey: `retry:${input.windowAt.toISOString()}:${retry}`,
      retryLimit: 0,
    },
  );
  return { windowAt: input.windowAt, retry, startAfterSeconds };
}

export async function runOfapiLinkStatsReconcile(
  app: AppContext,
  options: OfapiLinkStatsReconcileOptions = {},
): Promise<OfapiLinkStatsReconcileResult> {
  if (!isOfapiLinkStatsReconcileEnabled(app.config)) {
    return { pages: [], queuedRetry: null };
  }

  const target = options.target ?? null;
  const pulledAt = options.now ?? new Date();
  const windowAt = ofapiLinkStatsWindowAt(pulledAt);
  if (target?.trigger === "retry" && target.windowAt.getTime() !== windowAt.getTime()) {
    // The retry reached the worker after its window closed (a stopped worker,
    // a long queue). The window's point cannot be read any more — the vendor
    // keeps only current totals — and the open window has its own pass.
    app.logger.warn({
      windowAt: target.windowAt.toISOString(),
      openWindowAt: windowAt.toISOString(),
      retry: target.retry,
    }, "OFAPI link-stats retry arrived after its window closed; nothing read");
    return { pages: [], queuedRetry: null };
  }
  const stamp: LinkStatsAttemptStamp = { pulledAt, windowAt };

  // The window's next retry is persisted before anything is read (see
  // queueNextRetry). If even that fails, it is tried once more after the walk.
  const retriesDone = target?.trigger === "retry" ? target.retry : 0;
  const queueRetry = async () => {
    try {
      return { queued: await queueNextRetry(app, { boss: options.boss, windowAt, retriesDone, now: pulledAt }), failed: false };
    } catch (error) {
      app.logger.error({
        err: error,
        windowAt: windowAt.toISOString(),
        retry: retriesDone + 1,
      }, "OFAPI link-stats retry could not be queued");
      return { queued: null, failed: true };
    }
  };
  let retryQueueing = await queueRetry();

  // The population is every active OnlyFans page, mapped or not: a page the
  // pass cannot read still owes the series a row saying so.
  const fleet = await listOfapiBindingPages(app.db);
  const walkable = fleet.filter((page) =>
    page.account_id !== null && !ofapiAuthStatusNeedsAction(page.auth_status));

  // What the pass reads. The scheduled pass: every page, both kinds. A
  // targeted pass: the pairs without a usable result in the window — for a
  // retry those that may still be retried, for a rebind run every such pair
  // of the rebound page (its `skipped` rows are exactly what it is there to
  // replace).
  let plan: Array<{ page: LinkStatsFleetPage; kinds: LinkStatKind[] }>;
  if (target === null) {
    plan = fleet.map((page) => ({ page, kinds: [...LINK_STAT_KINDS] }));
  } else {
    const states = new Map(
      (await listLinkStatWindowPairStates(app.db, { windowAt }))
        .map((state) => [pairKey(state.platformAccountId, state.linkKind), state] as const),
    );
    plan = fleet
      .filter((page) => target.trigger === "retry" || page.id === target.pageId)
      .map((page) => ({
        page,
        kinds: LINK_STAT_KINDS.filter((kind) => {
          const state = states.get(pairKey(page.id, kind));
          if (state === undefined) {
            return true;
          }
          if (state.hasUsableResult) {
            return false;
          }
          if (target.trigger === "rebind") {
            return true;
          }
          return state.attempts < MAX_ATTEMPTS_PER_WINDOW &&
            !(state.lastStatus === "skipped" && state.lastReason !== null &&
              NOT_RETRIED_SKIP_REASONS.has(state.lastReason));
        }),
      }))
      .filter((entry) => entry.kinds.length > 0);
    if (plan.length === 0) {
      app.logger.info({
        windowAt: windowAt.toISOString(),
        target,
      }, "OFAPI link-stats targeted pass found every pair with a usable result; nothing read");
      return { pages: [], queuedRetry: retryQueueing.queued };
    }
  }

  const guard = createOfapiRestGuard(app, {
    maxRequestsPerRun: LINK_STATS_MAX_PAGES_PER_RUN * 2 * Math.max(1, walkable.length),
    // Dedicated link_stats day counter (migration 0113), isolated from the
    // chargebacks backfill lane in BOTH directions. The stored reads are free
    // at the vendor, so the guard reserves nothing and checks no credit
    // floor: the quota is held against what the vendor actually charged
    // today — an insurance against the day stored reads stop being free, not
    // a toll on attempts.
    dailyCreditBudget:
      app.config.ofapiLinkStatsDailyCreditBudget ?? DEFAULT_LINK_STATS_DAILY_CREDIT_BUDGET,
    budgetScope: "link_stats",
    freeReads: true,
  });

  const allPages: OfapiLinkStatsPageResult[] = [];
  for (const { page, kinds } of plan) {
    const recorded = new Set<LinkStatKind>();
    try {
      allPages.push(await reconcilePage(app, {
        pageId: page.id,
        pageLabel: page.label,
        ofapiAccountId: page.account_id,
        stamp,
        guard,
        kinds,
        recorded,
      }));
    } catch (error) {
      guard.abandonPendingReservation();
      const reason = errorText(error);
      allPages.push({
        pageLabel: page.label,
        status: "failed",
        reason,
        kinds: [],
      });
      for (const kind of kinds) {
        if (!recorded.has(kind)) {
          await recordFailedAttempt(app, {
            pageId: page.id,
            kind,
            ofapiAccountId: page.account_id,
            stamp,
            error,
          });
        }
      }
      app.logger.error({
        err: error,
        pageId: page.id,
        pageLabel: page.label,
      }, "OFAPI link-stats reconcile failed for page; continuing with remaining pages");
    }
  }

  if (retryQueueing.failed) {
    retryQueueing = await queueRetry();
  }
  const queuedRetry = retryQueueing.queued;

  // The fleet verdict is drawn over the pages the pass was to read. On a
  // targeted pass that is the pairs it read: "every" below means every one of
  // them.
  const pages = allPages.filter((page) =>
    !(page.status === "skipped" && page.reason !== null && NOT_ATTEMPTED_REASONS.has(page.reason)));
  const failed = pages.filter((page) => page.status === "failed");
  // A fleet pass where EVERY page truncated writes zero snapshots while the
  // job stays green — that silence must be an incident, not a warn line. The
  // lane's own quota is no exception any more: nothing is reserved for a free
  // read, so `ofapi_daily_credit_budget` now means the vendor really charged
  // the whole quota for stored reads today — the end of the premise the lane
  // runs on, which no other incident reports.
  const allTruncated = pages.length > 0 && pages.every((page) => page.status === "truncated");
  // One link kind fully stopped across the fleet (every walk of the kind
  // truncated) is the same silence per kind — a healthy other kind must not
  // mask it.
  const walkedKinds = pages.flatMap((page) => page.kinds);
  const truncatedKinds = (["tracking", "trial"] as const).filter((kindName) => {
    const ofKind = walkedKinds.filter((kind) => kind.linkKind === kindName);
    return ofKind.length > 0 && ofKind.every((kind) => kind.status === "truncated");
  });
  // Fleet-wide mapping collapse below the per-kind threshold: small pages
  // (1-2 links) never trip the absolute per-kind alarm, but when every FULL
  // walk of one link kind across the fleet wrote nothing (with enough total
  // evidence), that kind's adapter is broken fleet-wide. Judged PER KIND — a
  // healthy trial adapter must not mask a collapsed tracking one — and only
  // over completed walks: a truncated walk has writtenRows=0 by construction
  // and says nothing about the adapter.
  const collapsedKinds = (["tracking", "trial"] as const).filter((kindName) => {
    const walked = pages.flatMap((page) => page.kinds).filter((kind) =>
      kind.linkKind === kindName && kind.status !== "truncated" && kind.rawItems > 0,
    );
    const totalRawItems = walked.reduce((sum, kind) => sum + kind.rawItems, 0);
    return walked.length > 0 &&
      totalRawItems >= MAPPING_COLLAPSE_MIN_ITEMS &&
      walked.every((kind) => kind.writtenRows === 0);
  });
  const fleetCollapse = collapsedKinds.length > 0;
  if (failed.length > 0) {
    const shown = failed.slice(0, 5)
      .map((page) => `${page.pageLabel}: ${page.reason ?? "unknown error"}`)
      .join("; ");
    const remainder = failed.length > 5 ? `; +${failed.length - 5} more` : "";
    await notifyOfapiGlobalIncident(app, {
      kind: "ofapi_link_stats_reconcile_failed",
      errorSummary: `${failed.length} page(s) failed: ${shown}${remainder}`,
    });
  } else if (allTruncated || truncatedKinds.length > 0) {
    const scope = allTruncated
      ? `fleet fully truncated (${pages.length} page(s))`
      : `link kind(s) fully truncated fleet-wide: ${truncatedKinds.join(", ")}`;
    const reasons = [...new Set(
      walkedKinds.filter((kind) => kind.status === "truncated").map((kind) => kind.reason)
        .filter((reason): reason is string => reason !== null)
        .map(describeTruncation),
    )];
    await notifyOfapiGlobalIncident(app, {
      kind: "ofapi_link_stats_reconcile_failed",
      errorSummary:
        `${scope}: no snapshots written` +
        (reasons.length > 0 ? ` — ${reasons.join("; ")}` : ""),
    });
  } else if (fleetCollapse) {
    await notifyOfapiGlobalIncident(app, {
      kind: "ofapi_link_stats_reconcile_failed",
      errorSummary:
        `fleet-wide mapping collapse (${collapsedKinds.join(", ")}): every ` +
        `fetched link of the kind failed normalization — vendor schema change?`,
    });
  } else if (
    pages.length > 0 &&
    pages.every((page) =>
      page.kinds.length > 0 &&
      page.kinds.every((kind) => kind.status === "written" || kind.status === "partial")) &&
    pages.some((page) => page.kinds.some(
      (kind) => kind.status === "written" || kind.writtenRows > 0,
    )) &&
    (target === null || await windowHasEveryResult(app, { walkable, windowAt }))
  ) {
    // Recovery = every processed page finished its walks (written/partial)
    // AND the fleet demonstrably landed real data somewhere: a pass made of
    // nothing but unverified-empty walks proves nothing and must not close
    // the latch. A skipped page or any truncated kind keeps it open too; a
    // page stuck at 'partial' (one permanently unparseable vendor item) must
    // not pin it open either.
    //
    // A targeted pass read only part of the fleet, so its own success is not
    // the fleet's: it closes the latch only when no readable page is left
    // without a usable result in the window (a pair that used up its retries
    // was not read by this pass and is still broken).
    await resolveOfapiGlobalIncident(app, {
      kind: "ofapi_link_stats_reconcile_failed",
    });
  }

  const degraded = allPages.filter((page) =>
    page.status === "partial" || page.status === "truncated" || page.status === "skipped",
  );
  if (degraded.length > 0) {
    app.logger.warn({
      degraded: degraded.map((page) => ({
        label: page.pageLabel,
        reason: page.reason,
        skippedReasons: page.kinds.map((kind) => kind.skippedReasons),
      })),
    }, "OFAPI link-stats reconcile incomplete for some pages");
  }
  app.logger.info({
    windowAt: stamp.windowAt.toISOString(),
    trigger: target?.trigger ?? "scheduled",
    ...(target?.trigger === "retry" ? { retry: target.retry } : {}),
    queuedRetry: queuedRetry?.retry ?? null,
    pages: allPages.map((page) => ({
      label: page.pageLabel,
      status: page.status,
      reason: page.reason,
      kinds: page.kinds.map((kind) => ({
        kind: kind.linkKind,
        status: kind.status,
        apiPages: kind.apiPages,
        rawItems: kind.rawItems,
        writtenRows: kind.writtenRows,
        skippedReasons: kind.skippedReasons,
      })),
    })),
  }, "OFAPI link-stats reconcile complete");

  return { pages: allPages, queuedRetry };
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

  // New with the queue itself, so its options are the ones it is created
  // with; the read-back still refuses a queue that exists under another
  // policy (pg-boss cannot change one in place).
  await ensureQueueCreated(
    boss,
    OFAPI_LINK_STATS_RETRY_QUEUE,
    OFAPI_LINK_STATS_RETRY_QUEUE_OPTIONS,
    createdQueues,
  );
  const retryQueue = await boss.getQueue(OFAPI_LINK_STATS_RETRY_QUEUE);
  if (
    !retryQueue ||
    retryQueue.policy !== OFAPI_LINK_STATS_RETRY_QUEUE_OPTIONS.policy ||
    retryQueue.retryLimit !== OFAPI_LINK_STATS_RETRY_QUEUE_OPTIONS.retryLimit
  ) {
    throw new Error(
      `Queue ${OFAPI_LINK_STATS_RETRY_QUEUE} configuration drift: expected ` +
      `policy=${OFAPI_LINK_STATS_RETRY_QUEUE_OPTIONS.policy}, ` +
      `retryLimit=${OFAPI_LINK_STATS_RETRY_QUEUE_OPTIONS.retryLimit}`,
    );
  }
}

export async function ensureOfapiLinkStatsSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  // Four times a day at 03:45/09:45/15:45/21:45 UTC (owner decision, plan
  // П1.1). The stored endpoints are free, so the frequency costs nothing; the
  // placement after chargebacks' 03:10 window is just polite scheduling. The
  // windows live in ofapi-link-stats-windows.ts: the cron and the `window_at`
  // stamped on every attempt row come from the same list. Registering the
  // schedule again replaces the previous cron of the queue.
  await boss.schedule(OFAPI_LINK_STATS_RECONCILE_QUEUE, OFAPI_LINK_STATS_CRON, null, { tz: "UTC" });
}

/** The binding reconciler moved pages to another OFAPI account: each of them
 * is read once, 20 minutes later, without waiting for the next window. The
 * run is a targeted pass of whatever window is open by then — it reads the
 * page's pairs that have no usable result there (a window whose scheduled
 * pass found the page unmapped or its session dead, or has not run yet) and
 * does nothing when the window already has them. Returns the pages queued. */
export async function queueOfapiLinkStatsRunsAfterRebind(
  app: Pick<AppContext, "config" | "logger">,
  boss: OfapiLinkStatsSender,
  actions: ReadonlyArray<{ action: string; applied: boolean; pageId: number; label?: string }>,
): Promise<number[]> {
  if (!isOfapiLinkStatsReconcileEnabled(app.config)) {
    return [];
  }
  const queued: number[] = [];
  for (const action of actions) {
    if (action.action !== "rebind" || !action.applied) {
      continue;
    }
    try {
      await boss.send(
        OFAPI_LINK_STATS_RETRY_QUEUE,
        { trigger: "rebind", pageId: action.pageId },
        {
          startAfter: OFAPI_LINK_STATS_REBIND_RUN_DELAY_MS / SECOND_MS,
          // One queued run per page: a second rebind inside the delay is
          // served by the run already waiting.
          singletonKey: `rebind:${action.pageId}`,
          retryLimit: 0,
        },
      );
      queued.push(action.pageId);
    } catch (error) {
      // The rebind itself is done and must not be reported as failed; the
      // next window reads the page in any case.
      app.logger.error({
        err: error,
        pageId: action.pageId,
      }, "OFAPI link-stats run after rebind could not be queued; the next window reads the page");
    }
  }
  if (queued.length > 0) {
    app.logger.info({ pageIds: queued }, "OFAPI link-stats run queued after rebind");
  }
  return queued;
}

/** The slice of pg-boss an operator command needs to queue the run after a
 * rebind from outside the worker. */
export type OfapiLinkStatsStandaloneBoss = Omit<SyncQueueLifecycleClient, "send"> & OfapiLinkStatsSender & {
  start(): Promise<unknown>;
  stop(options?: { graceful?: boolean }): Promise<unknown>;
};

/** The run after a rebind, for a rebind applied OUTSIDE the worker — the
 * operator's `ofapi:bindings:reconcile --execute`. Later reconciler passes do
 * not report that rebind again, and the window's retries skip a page whose
 * row says `page_auth_dead` / `page_unmapped`, so without this the page
 * would wait for the next window. Opens its own pg-boss connection only when
 * a rebind was applied and the series is on. Throws when the job cannot be
 * queued: the rebind itself is already applied, and the caller says so. */
export async function queueOfapiLinkStatsRunsAfterOperatorRebind(
  app: Pick<AppContext, "config" | "logger">,
  actions: ReadonlyArray<{ action: string; applied: boolean; pageId: number }>,
  createBoss: () => OfapiLinkStatsStandaloneBoss,
): Promise<number[]> {
  if (!isOfapiLinkStatsReconcileEnabled(app.config) ||
    !actions.some((action) => action.action === "rebind" && action.applied)) {
    return [];
  }
  const boss = createBoss();
  await boss.start();
  try {
    await ensureOfapiLinkStatsQueue(boss);
    const pending = actions.filter((action) => action.action === "rebind" && action.applied);
    const queued = await queueOfapiLinkStatsRunsAfterRebind(app, boss, pending);
    if (queued.length !== new Set(pending.map((action) => action.pageId)).size) {
      throw new Error(
        `link-series run after rebind queued for ${queued.length} of ${pending.length} rebound page(s)`,
      );
    }
    return queued;
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined);
  }
}

export async function startOfapiLinkStatsWorker(
  app: AppContext,
  boss: OfapiLinkStatsSender & {
    work: (
      queue: string,
      options: { batchSize: number },
      handler: (jobs: Array<{ data: unknown }>) => Promise<void>,
    ) => Promise<unknown>;
  },
) {
  const failOnFailedPages = (result: OfapiLinkStatsReconcileResult) => {
    const failed = result.pages.filter((page) => page.status === "failed");
    if (failed.length > 0) {
      throw new Error(`OFAPI link-stats reconcile failed for ${failed.length} page(s)`);
    }
  };
  await boss.work(OFAPI_LINK_STATS_RECONCILE_QUEUE, { batchSize: 1 }, async () => {
    failOnFailedPages(await runOfapiLinkStatsReconcile(app, { boss }));
  });
  await boss.work(OFAPI_LINK_STATS_RETRY_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const target = parseOfapiLinkStatsTargetedJob(job.data);
      if (target === null) {
        // A payload this build cannot read is not retried into a loop: it is
        // dropped loudly and the window's next pass covers what it meant.
        app.logger.error({ data: job.data }, "OFAPI link-stats targeted job has an unreadable payload; dropped");
        continue;
      }
      failOnFailedPages(await runOfapiLinkStatsReconcile(app, { boss, target }));
    }
  });
}
