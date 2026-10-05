import type {
  ClientSpenderStatsMoneyWindow,
  ClientSpenderStatsQuery,
  ClientSpenderStatsRefusalReason,
  ClientSpenderStatsResponse,
} from "@agency_hub_core/contracts";
import {
  findPageSummaryByLabel,
  getPageSpenderStats,
  getSpenderProjectionAsOf,
  type PageSpenderStats,
} from "@agency_hub_core/db";
import {
  SPENDER_STATS_BASIS,
  SPENDER_STATS_MONEY_UNIT,
  millsToNumber,
  normalizeSpenderStatsTimeZone,
  resolveSpenderStatsWindows,
  type SpenderStatsMessageSource,
  type SpenderStatsMoneyWindow,
  type SpenderStatsWindows,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { requireClientFeature, type ClientFeatureRequest } from "./client-switches.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { BadRequestError, ClientFeatureDisabledError } from "./errors.ts";

/**
 * chat-extension H-8b: the Spenders statistics of one page
 * (`clientSpenderStats`). The definitions are
 * packages/shared/src/spender-stats.ts and the read is
 * packages/db/src/repositories/spender-stats.ts; this file is who may ask, which
 * messages silence reads, and how long an answer is kept.
 *
 * Database only: no platform request, no queued work.
 */

const STATS_FLAG = "stats";

/** How long one answer is served again, in this process. */
export const SPENDER_STATS_CACHE_TTL_MS = 60_000;
/** The most answers one process keeps. */
export const SPENDER_STATS_CACHE_MAX_ENTRIES = 500;

interface CacheEntry<T> {
  value: Promise<T>;
  /** When the load began: the instant the answer is of. */
  loadedAt: number;
  settled: boolean;
  failed: boolean;
}

/**
 * A small keyed cache of one process: an answer is served again for `ttlMs`,
 * and callers that ask for a key while it is being loaded wait for that one
 * load instead of starting their own. A failed load is not kept: everyone
 * waiting on it gets its error and the next caller loads again. At most
 * `maxEntries` keys are held; past that, expired answers go first, then the
 * oldest.
 *
 * It knows nothing of who is asking. The caller checks access BEFORE it asks
 * the cache, on every request.
 */
export class KeyedLoadCache<T> {
  private entries = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: { ttlMs: number; maxEntries: number }) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = Math.max(1, options.maxEntries);
  }

  /** The keys held: answers that can still be served and loads under way. */
  get size(): number {
    let held = 0;
    for (const entry of this.entries.values()) {
      if (!entry.failed) held += 1;
    }
    return held;
  }

  get(key: string, nowMs: number, load: () => Promise<T>): Promise<T> {
    const held = this.entries.get(key);
    if (held && !held.failed && (!held.settled || nowMs - held.loadedAt < this.ttlMs)) {
      return held.value;
    }

    // A miss rebuilds the map: without this key, the failed loads and the
    // expired answers, and with room for one more. A Map keeps insertion order,
    // so the entries cut from the front are the oldest. (Rebuilt rather than
    // edited in place: tests/retention-deleters.test.ts reads every Map-style
    // removal call under apps/runtime/src as an SQL deleter.)
    const kept = [...this.entries].filter(([heldKey, entry]) =>
      heldKey !== key && !entry.failed && !(entry.settled && nowMs - entry.loadedAt >= this.ttlMs));
    const entry: CacheEntry<T> = {
      // Started now; a load that throws before its first await is a failed load too.
      value: (async () => load())(),
      loadedAt: nowMs,
      settled: false,
      failed: false,
    };
    this.entries = new Map([...kept.slice(Math.max(0, kept.length - (this.maxEntries - 1))), [key, entry]]);
    entry.value.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.failed = true;
      },
    );
    return entry.value;
  }
}

// One cache per app context, so one per process: a restart empties it, and test
// servers stay isolated from each other.
const caches = new WeakMap<object, KeyedLoadCache<PageSpenderStats>>();

function cacheFor(app: AppContext): KeyedLoadCache<PageSpenderStats> {
  let cache = caches.get(app);
  if (!cache) {
    cache = new KeyedLoadCache({ ttlMs: SPENDER_STATS_CACHE_TTL_MS, maxEntries: SPENDER_STATS_CACHE_MAX_ENTRIES });
    caches.set(app, cache);
  }
  return cache;
}

/**
 * What an answer depends on besides the clock: the page, the window, the
 * messages silence reads and the spender projection's watermark.
 *
 * The window is keyed as the read receives it: its first local date and the
 * instants its dates start and end at. Not by the zone's name: one zone has
 * many spellings ("Europe/Kyiv", "EUROPE/KYIV", "Europe/Kiev"; "UTC",
 * "Etc/UTC", "GMT", "Etc/Zulu"), and under the name each of them would be
 * counted anew, the silence statement included. Whatever the runtime's Intl
 * makes of a name, the same dates at the same instants are the same numbers,
 * so zones that agree on every date of the window share the answer as well;
 * the name is only echoed (`getClientSpenderStats`). The first date is in the
 * key because zones a whole day apart (Pacific/Kiritimati, Pacific/Honolulu)
 * start their dates at the same instants and call them differently. When the
 * local date turns, the window moves and the key with it.
 *
 * Every writer of a transaction rebuilds the projection and moves the
 * watermark, so a purchase is in the next answer and never waits out the 60
 * seconds; a new message can.
 */
export function spenderStatsCacheKey(input: {
  pageId: number;
  windows: Pick<SpenderStatsWindows, "dates" | "dateStarts" | "end">;
  messageSource: SpenderStatsMessageSource;
  projectionAsOf: Date | null;
}): string {
  const { dates, dateStarts, end } = input.windows;
  return [
    input.pageId,
    dates[0],
    [...dateStarts, end].map((instant) => instant.getTime()).join(","),
    input.messageSource,
    input.projectionAsOf === null ? "never" : input.projectionAsOf.toISOString(),
  ].join("|");
}

function refuseSpenderStats(message: string, reason: ClientSpenderStatsRefusalReason): never {
  throw new BadRequestError(message, { reason });
}

/**
 * The messages silence reads: the ones a generation of the page reads. The
 * same switch, read the same way (the owner's live override over the
 * environment, once per request): `serve` puts the AI transcript on the union
 * of the archive and the webhook store, and silence follows it there, so the
 * stats and the Ping chip of one chat agree about a fan who has just written.
 * In `off` and `shadow` the archive serves both.
 *
 * No platform is asked for here: the `stats` feature exists on OnlyFans only
 * (`requireClientFeature` has refused any other page), which is also the one
 * platform the union reads.
 */
async function resolveSpenderStatsMessageSource(app: AppContext): Promise<SpenderStatsMessageSource> {
  const effective = await loadEffectiveConfig(app.db, app.config);
  return effective.aiTranscriptFreshUnionMode === "serve" ? "union" : "archive";
}

function toClientMoneyWindow(window: SpenderStatsMoneyWindow): ClientSpenderStatsMoneyWindow {
  return {
    grossMills: millsToNumber(window.grossMills),
    purchasesGrossMills: millsToNumber(window.purchasesGrossMills),
    adjustmentsMills: millsToNumber(window.adjustmentsMills),
    creatorNetMills: millsToNumber(window.creatorNetMills),
    purchaseCount: window.purchaseCount,
    payerCount: window.payerCount,
  };
}

/** The repository's answer as the wire carries it: mills as integers, instants as ISO text. */
export function toClientSpenderStats(pageLabel: string, stats: PageSpenderStats): ClientSpenderStatsResponse {
  const silenceBucket = (bucket: { fans: number; lifetimeGrossMills: bigint }) => ({
    fans: bucket.fans,
    lifetimeGrossMills: millsToNumber(bucket.lifetimeGrossMills),
  });
  return {
    pageLabel,
    metricVersion: stats.metricVersion,
    moneyUnit: SPENDER_STATS_MONEY_UNIT,
    basis: SPENDER_STATS_BASIS,
    timeZone: stats.timeZone,
    from: stats.from,
    to: stats.to,
    asOf: stats.asOf.toISOString(),
    projectionAsOf: stats.projectionAsOf === null ? null : stats.projectionAsOf.toISOString(),
    includedStates: [...stats.includedStates],
    coverage: { state: stats.coverage.state, reasons: [...stats.coverage.reasons] },
    days: stats.days.map((day) => ({
      date: day.date,
      grossMills: millsToNumber(day.grossMills),
      purchasesGrossMills: millsToNumber(day.purchasesGrossMills),
      adjustmentsMills: millsToNumber(day.adjustmentsMills),
      creatorNetMills: millsToNumber(day.creatorNetMills),
      purchaseCount: day.purchaseCount,
      byState: Object.fromEntries(
        Object.entries(day.byState).map(([state, gross]) => [state, millsToNumber(gross)]),
      ),
    })),
    totals: {
      today: toClientMoneyWindow(stats.totals.today),
      d7: toClientMoneyWindow(stats.totals.d7),
      prev7: toClientMoneyWindow(stats.totals.prev7),
      d30: toClientMoneyWindow(stats.totals.d30),
      d7DeltaPct: stats.totals.d7DeltaPct,
    },
    avgCheckMills: stats.avgCheckMills === null ? null : millsToNumber(stats.avgCheckMills),
    tiers: stats.tiers.map((tier) => ({
      key: tier.key,
      label: tier.label,
      minMills: tier.minMills === null ? null : millsToNumber(tier.minMills),
      maxMills: tier.maxMills === null ? null : millsToNumber(tier.maxMills),
      members: tier.members,
      windowPayers: tier.windowPayers,
      windowGrossMills: millsToNumber(tier.windowGrossMills),
    })),
    silence: {
      d8to21: silenceBucket(stats.silence.d8to21),
      over21: silenceBucket(stats.silence.over21),
      unknown: silenceBucket(stats.silence.unknown),
    },
    newPayers: { count: stats.newPayers.count, firstPurchaseKnown: stats.newPayers.firstPurchaseKnown },
    queueSummary: { total: stats.queueSummary.total, unknown: stats.queueSummary.unknown },
  };
}

/**
 * The stats of the page of the path, for the caller's zone.
 *
 * In this order:
 * 1. the hub's own check, on EVERY request and before the cache is asked: an
 *    API-key user (a cookie session → 403), a page granted to the caller, the
 *    owner's `stats` switch on for it, the extension not outdated (409
 *    `client_feature_disabled` with the reason; a missing page answers
 *    `not_granted`, as one that is not the caller's);
 * 2. the zone: an IANA name this runtime's Intl knows, or 400 `bad_request`
 *    with `unknown_time_zone`. Intl alone reads the zone; the SQL receives the
 *    instants each local date starts at and never the name, so a zone Postgres
 *    would not know ("Europe/Kiev") or would read differently ("CET") is
 *    neither an error nor a different answer;
 * 3. the answer, from this process's cache when it has one no older than 60
 *    seconds for the same page, window, message source and projection
 *    watermark (`spenderStatsCacheKey`: the window, however its zone is
 *    spelled). `asOf` is the instant the answer was counted at; `timeZone` is
 *    always this caller's own spelling.
 */
export async function getClientSpenderStats(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; query: ClientSpenderStatsQuery },
  now: Date = new Date(),
): Promise<ClientSpenderStatsResponse> {
  requireApiKeyUser(principal);
  const stored = await findPageSummaryByLabel(app.db, input.pageLabel);
  if (!stored) {
    // A missing page answers like one not granted: the refusal reveals nothing.
    throw new ClientFeatureDisabledError(STATS_FLAG, "not_granted");
  }
  const page = await requireClientFeature(app, request, principal, { id: stored.id }, STATS_FLAG);

  const timeZone = normalizeSpenderStatsTimeZone(input.query.timeZone);
  if (timeZone === null) {
    refuseSpenderStats("timeZone is not an IANA time zone this hub knows", "unknown_time_zone");
  }
  const { windowDays } = input.query;
  // The window this caller's zone gives right now: what the answer is kept under.
  const windows = resolveSpenderStatsWindows({ asOf: now, timeZone, windowDays });

  const [messageSource, projectionAsOf] = await Promise.all([
    resolveSpenderStatsMessageSource(app),
    getSpenderProjectionAsOf(app.db, { pageIds: [page.id] }),
  ]);
  const stats = await cacheFor(app).get(
    spenderStatsCacheKey({ pageId: page.id, windows, messageSource, projectionAsOf }),
    now.getTime(),
    () => getPageSpenderStats(app.db, { pageId: page.id, timeZone, asOf: now, windowDays, messageSource }),
  );
  // A kept answer carries the zone as whoever had it counted spelled it; the
  // numbers are this caller's too, the name is not.
  return toClientSpenderStats(page.label, { ...stats, timeZone });
}
