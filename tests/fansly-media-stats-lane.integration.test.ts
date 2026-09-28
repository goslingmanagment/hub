// WP-F4 — media-stats queue, window, coverage and physical-attempt invariants.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  countMediaStatsRefreshProgress,
  getCheckpoint,
  listMediaStatsRefreshChunk,
  listSubjectRefreshState,
  markSubjectRefreshDirty,
  recordMediaStatsFailure,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";

import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import {
  countMediaStatBuckets,
  estimateMediaStatsCycle,
  fanslyMediaStatsChunk,
  mediaStatsWindowIsEmpty,
  parseFanslyMediaStatsCursorState,
  servedMediaOfferRef,
  servedWindowCoversRequest,
  steadyWindows,
} from "../apps/runtime/src/services/sync/fansly-media-stats.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  fanslyLaneAppStub,
  fanslyLaneInput,
  fanslyLaneTelemetryStub as telemetryStub,
  observeFanslyLaneAttempts,
  seedFanslyLanePage,
} from "./helpers/fansly-lane-harness.ts";

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

const NOW = new Date("2026-08-22T09:00:00.000Z");
const NEXT_DAY = new Date("2026-08-23T09:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function ref(n: number): string {
  return `0009${String(40000000000000 + n).padStart(14, "0")}`;
}

/**
 * One `/it/moie/statsnew` body, shaped exactly as the wire is: the subject at
 * `dataset.datasetMediaOfferId`, the served bounds at `dateAfter`/`dateBefore`,
 * and every `stats[]` row carrying the SEVEN served keys and no video fields.
 */
function statsBody(options: {
  mediaOfferRef: string;
  afterMs: number;
  beforeMs: number;
  periodMs: number;
  buckets?: number;
  /** Serve a DIFFERENT window than the one asked for — the production shape. */
  servedAfterMs?: number;
  servedBeforeMs?: number;
  tags?: Array<{ tagId: string; views: number }>;
}) {
  const buckets = options.buckets ?? 2;
  return {
    dataset: {
      period: options.periodMs,
      dateBefore: options.servedBeforeMs ?? options.beforeMs,
      dateAfter: options.servedAfterMs ?? options.afterMs,
      datapointLimit: 100,
      datapoints: Array.from({ length: buckets }, (_unused, index) => ({
        timestamp: (options.servedAfterMs ?? options.afterMs) + index * options.periodMs,
        stats: [{
          type: index % 2,
          views: 10 + index,
          previewViews: 0,
          interactionTime: 1000 * (index + 1),
          previewInteractionTime: 0,
          uniqueViewers: 5 + index,
          previewUniqueViewers: 0,
        }],
      })),
      topFypTags: options.tags ?? [],
      datasetMediaOfferId: options.mediaOfferRef,
    },
    aggregationData: { accountMedia: [], accountMediaBundles: [], tags: [] },
  };
}

/**
 * The window this route serves for ANY depth it has no data for: one datapoint,
 * one stats row, every counter zero. Journaled verbatim like anything else; it
 * is the FLOOR RULE that has to read it as empty, or the walk goes to 2006.
 */
function allZeroBody(options: {
  mediaOfferRef: string;
  afterMs: number;
  beforeMs: number;
  periodMs: number;
}) {
  return {
    dataset: {
      period: options.periodMs,
      dateBefore: options.beforeMs,
      dateAfter: options.afterMs,
      datapointLimit: 100,
      datapoints: [{
        timestamp: options.afterMs,
        stats: [{
          type: 0,
          views: 0,
          previewViews: 0,
          interactionTime: 0,
          previewInteractionTime: 0,
          uniqueViewers: 0,
          previewUniqueViewers: 0,
        }],
      }],
      topFypTags: [],
      datasetMediaOfferId: options.mediaOfferRef,
    },
    aggregationData: { accountMedia: [], accountMediaBundles: [], tags: [] },
  };
}

interface AdapterCall {
  mediaOfferId: string;
  beforeDate: Date;
  afterDate: Date;
  periodMs: number;
}

/**
 * An adapter stub that reports ATTEMPTS through the observer exactly as the real
 * one does: `attemptsPerCall` above 1 is what a retried request looks like to
 * everything downstream of `executeObservedRequest`, and the cap is counted in
 * that unit precisely so a retry storm cannot multiply real egress.
 */
function adapterStub(options: {
  attemptsPerCall?: number;
  body?: (params: AdapterCall, index: number) => unknown;
  fail?: (params: AdapterCall, index: number) => Error | null;
} = {}) {
  const attemptsPerCall = options.attemptsPerCall ?? 1;
  const calls: AdapterCall[] = [];
  return {
    calls,
    getMediaOfferStats: vi.fn(async (
      context: {
        requestObserver?: { onRequestEvent: (event: unknown) => Promise<void> } | null;
      },
      params: AdapterCall,
    ) => {
      const index = calls.length;
      calls.push(params);
      await observeFanslyLaneAttempts(context, {
        attempts: attemptsPerCall,
        requestId: `media_offer_stats:${index}`,
        operation: "media_offer_stats",
        endpointTemplate: "/it/moie/statsnew",
      });
      const failure = options.fail?.(params, index) ?? null;
      if (failure !== null) {
        throw failure;
      }
      const body = options.body?.(params, index) ?? statsBody({
        mediaOfferRef: params.mediaOfferId,
        afterMs: params.afterDate.getTime(),
        beforeMs: params.beforeDate.getTime(),
        periodMs: params.periodMs,
      });
      return { items: body, raw: body };
    }),
  };
}

const LOG_LINES: Array<{ message: string; fields: Record<string, unknown> }> = [];

function appStub(
  adapter: ReturnType<typeof adapterStub>,
  configOverrides: Record<string, unknown> = {},
) {
  return fanslyLaneAppStub({
    database: testDb!,
    adapter,
    logger: {
      info: (fields: Record<string, unknown>, message: string) => {
        LOG_LINES.push({ message, fields });
      },
      warn: () => {},
      error: () => {},
    },
    config: {
      fanslyMediaStatsSyncEnabled: true,
      fanslyMediaStatsPageAllowlist: "media-lane",
      fanslyMediaStatsDailyCallBudget: 300,
      fanslyMediaStatsLongTailCycleDays: 30,
      fanslyBackfillContinuationDelayMs: 20_000,
      ...configOverrides,
    },
  });
}

let syncRunId = 0;

async function seedPage() {
  const seeded = await seedFanslyLanePage(testDb!, {
    slug: "media",
    name: "Media",
    label: "media-lane",
    accountRef: "acct-media",
    stream: "media_stats",
  });
  syncRunId = seeded.syncRunId;
  return seeded.page;
}

/** A per-media backfill cursor already AT its floor. Most cases here are about
 *  the steady round-robin, and a first-sight backfill in front of every item
 *  would make every one of them a walk instead. */
const BACKFILL_DONE = {
  version: 1,
  nextBeforeMs: 0,
  emptyStreak: 2,
  done: true,
  floorAt: null,
  stopReason: "seeded_by_test",
  guard: { spanDays: 31, narrowed: false, lastAfterMs: null, lastBeforeMs: null, lastObservationId: null },
};

/**
 * Insert `creator_media` rows directly, so the age of each item is exact.
 *
 * `queueCursor` also inserts the queue row, which is what lets a case start from
 * a chosen backfill state — the handler's own seeding is `ON CONFLICT DO
 * NOTHING`, so it no-ops over these. The same-tx queue hook is exercised through
 * `upsertCreatorMedia` in the rebuild-isolation suite instead.
 */
async function seedMedia(
  pageId: number,
  rows: Array<{ ref: string; createdAtPlatform: Date | null; firstObservedAt?: Date }>,
  options: { queueCursor?: Record<string, unknown> } = {},
) {
  for (const [index, row] of rows.entries()) {
    await testDb!.pool.query(
      `insert into creator_media (
         page_id, platform, media_offer_ref, first_origin, created_at_platform,
         first_observed_at, last_observed_at, content_hash, source_event_id,
         source_observation_id, source_account_seq
       ) values ($1, 'fansly', $2, 'stats_agg', $3, $4, $4, $5, 1, 1, $6)`,
      [
        pageId,
        row.ref,
        row.createdAtPlatform,
        row.firstObservedAt ?? row.createdAtPlatform ?? NOW,
        "f".repeat(64),
        index + 1,
      ],
    );
    if (options.queueCursor !== undefined) {
      await testDb!.pool.query(
        `insert into subject_refresh_state (
           page_id, plane, subject_ref, refresh_class, next_due_at, backfill_cursor
         ) values ($1, 'media_stats', $2, 'fresh', $3, $4::jsonb)
         on conflict (page_id, plane, subject_ref) do nothing`,
        [pageId, row.ref, NOW, JSON.stringify(options.queueCursor)],
      );
    }
  }
}

function input(
  pageId: number,
  telemetry: ReturnType<typeof telemetryStub>,
  budget = new SyncChunkBudget(),
  now = NOW,
) {
  return fanslyLaneInput({
    pageId,
    label: "media-lane",
    accountRef: "acct-media",
    egressKey: "fansly:media",
    telemetry,
    syncRunId,
    now,
    budget,
  }) as never;
}

async function cursor(pageId: number) {
  const checkpoint = await getCheckpoint(testDb!.db, pageId, "media_stats");
  return parseFanslyMediaStatsCursorState(checkpoint?.state);
}

async function journaled(pageId: number) {
  const result = await testDb!.pool.query(
    `select endpoint, request_params from sync_raw_payloads
      where page_id = $1 order by id`,
    [pageId],
  );
  return result.rows as Array<{ endpoint: string; request_params: Record<string, unknown> }>;
}

async function coverageRows(pageId: number) {
  const result = await testDb!.pool.query(
    `select plane, scope_ref, status, proof, reason_code, expected_count,
            observed_unique_count, cursor
       from capture_coverage where page_id = $1 order by plane, scope_ref`,
    [pageId],
  );
  return result.rows as Array<Record<string, unknown>>;
}

/** Run chunks until the lane says the slot is satisfied, or the guard trips. */
async function drain(
  pageId: number,
  adapter: ReturnType<typeof adapterStub>,
  telemetry: ReturnType<typeof telemetryStub>,
  options: { now?: Date; maxChunks?: number; config?: Record<string, unknown> } = {},
) {
  const results: Array<Awaited<ReturnType<typeof fanslyMediaStatsChunk>>> = [];
  for (let chunk = 0; chunk < (options.maxChunks ?? 40); chunk += 1) {
    const result = await fanslyMediaStatsChunk(
      appStub(adapter, options.config ?? {}),
      input(pageId, telemetry, new SyncChunkBudget(), options.now ?? NOW),
    );
    results.push(result);
    if (result.satisfied) {
      break;
    }
  }
  return results;
}

/** A provider refusal as the adapter throws it after its own retries: HTTP 500
 *  and Fansly's error envelope. `error getting graph` is the 90-day window's
 *  answer since 2026-09-05; `error getting media offer` is an item that is gone. */
function providerRefusal(details: "error getting graph" | "error getting media offer") {
  return new FanslyApiError(
    "Fansly request failed (500)",
    500,
    500,
    JSON.stringify({ success: false, error: { code: 500, details } }),
  );
}

async function queueRow(pageId: number, subjectRef: string) {
  const queue = await listSubjectRefreshState(testDb!.db, { pageId, plane: "media_stats" });
  const row = queue.find((entry) => entry.subjectRef === subjectRef);
  if (row === undefined) throw new Error(`no media_stats row for ${subjectRef}`);
  return row;
}

describe("media_stats lane — the gate", () => {
  it("is INERT until both the flag and the fail-closed allowlist say otherwise", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedMedia(page.id, [{ ref: ref(1), createdAtPlatform: NOW }]);
    const adapter = adapterStub();
    const telemetry = telemetryStub();

    const flagOff = await fanslyMediaStatsChunk(
      appStub(adapter, { fanslyMediaStatsSyncEnabled: false }),
      input(page.id, telemetry),
    );
    expect(flagOff.gatedSkip).toBe("flag_off");

    // EMPTY = NO PAGES. The opposite of `fanslyNewStreamPageAllowlist`, and the
    // lane where the wrong semantic would have started a 300-call-a-day walk on
    // every Fansly page at once.
    const notListed = await fanslyMediaStatsChunk(
      appStub(adapter, { fanslyMediaStatsPageAllowlist: "" }),
      input(page.id, telemetry),
    );
    expect(notListed.gatedSkip).toBe("not_allowlisted");
    expect(adapter.calls).toHaveLength(0);
    // Nothing is journaled and nothing is queued by a gated skip.
    expect(await journaled(page.id)).toHaveLength(0);
    expect(await listSubjectRefreshState(testDb.db, { pageId: page.id })).toHaveLength(0);
  });
});

describe("media_stats lane — the queue", () => {
  it("seeds every Fansly media on first enable and classes it by age", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedMedia(page.id, [
      // FRESH: published 5 days ago.
      { ref: ref(101), createdAtPlatform: new Date(NOW.getTime() - 5 * DAY_MS) },
      // MID: 90 days.
      { ref: ref(102), createdAtPlatform: new Date(NOW.getTime() - 90 * DAY_MS) },
      // LONG TAIL: 400 days.
      { ref: ref(103), createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS) },
      // NO PLATFORM DATE at all — first seen 5 days ago. Classed FRESH for 30
      // days from FIRST SIGHT. Never an invented publication date.
      {
        ref: ref(104),
        createdAtPlatform: null,
        firstObservedAt: new Date(NOW.getTime() - 5 * DAY_MS),
      },
      // NO PLATFORM DATE, first seen 400 days ago — it has aged out of fresh on
      // the first-seen basis, which is the whole point of having a basis.
      {
        ref: ref(105),
        createdAtPlatform: null,
        firstObservedAt: new Date(NOW.getTime() - 400 * DAY_MS),
      },
    ]);

    const adapter = adapterStub();
    // A dispatch with NO REQUEST CAPACITY. Seeding costs zero platform calls, so
    // the queue lands whole and nothing is visited — which is what lets every
    // row's tier be read below: a visit now stamps `last_visited_at`, and a
    // visited item is not due again today.
    await fanslyMediaStatsChunk(
      appStub(adapter),
      input(page.id, telemetryStub(), new SyncChunkBudget(0)),
    );
    expect(adapter.calls).toHaveLength(0);

    const queue = await listSubjectRefreshState(testDb.db, { pageId: page.id, plane: "media_stats" });
    expect(queue.map((row) => row.subjectRef).sort()).toEqual([
      ref(101),
      ref(102),
      ref(103),
      ref(104),
      ref(105),
    ].sort());
    expect(await cursor(page.id)).toMatchObject({ seedComplete: true });

    const chunk = await listMediaStatsRefreshChunk(testDb.db, {
      pageId: page.id,
      limit: 10,
      now: NOW,
      longTailCycleDays: 30,
    });
    const tierByRef = new Map(chunk.map((row) => [row.subjectRef, row.tier]));
    expect(tierByRef.get(ref(101))).toBe("fresh");
    expect(tierByRef.get(ref(102))).toBe("mid");
    expect(tierByRef.get(ref(103))).toBe("long_tail");
    expect(tierByRef.get(ref(104))).toBe("fresh");
    expect(tierByRef.get(ref(105))).toBe("long_tail");
    const basisByRef = new Map(chunk.map((row) => [row.subjectRef, row.publicationBasis]));
    expect(basisByRef.get(ref(101))).toBe("platform");
    // The claim is DIFFERENT, not worse: this item's age is when we first saw
    // it, and the lane says so rather than inventing a publication date.
    expect(basisByRef.get(ref(104))).toBe("first_seen");
  });

  it("visits DIRTY rows first — WP-F2's purchase signals and the top-50", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    // Twenty-five never-visited items, all fresh, so the never-visited band is
    // full and only a real priority can jump it.
    await seedMedia(page.id, Array.from({ length: 25 }, (_unused, index) => ({
      ref: ref(200 + index),
      createdAtPlatform: new Date(NOW.getTime() - (index + 1) * DAY_MS),
    })));
    // A long-tail item that WP-F2 marked when a 2007 purchase notification
    // arrived. It fetches nothing itself; this lane is the consumer.
    await seedMedia(page.id, [{
      ref: ref(999),
      createdAtPlatform: new Date(NOW.getTime() - 500 * DAY_MS),
    }]);

    const adapter = adapterStub();
    // Seed the queue first (zero platform calls, and a budget that cannot spend
    // one), then mark, then read the order.
    await fanslyMediaStatsChunk(
      appStub(adapter),
      input(page.id, telemetryStub(), new SyncChunkBudget(0)),
    );
    await markSubjectRefreshDirty(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
      subjectRef: ref(999),
      dirtyReason: "purchase_notification",
      nextDueAt: NOW,
    });

    const chunk = await listMediaStatsRefreshChunk(testDb.db, {
      pageId: page.id,
      limit: 5,
      now: NOW,
      longTailCycleDays: 30,
    });
    // BAND 0, ahead of twenty-five never-visited items that are all NEWER — a
    // purchase is the strongest evidence this system gets that an item's
    // numbers moved, and it is worth a call today.
    expect(chunk[0]?.subjectRef).toBe(ref(999));
    expect(chunk[0]?.priorityBand).toBe(0);
    expect(chunk[0]?.dirtyReason).toBe("purchase_notification");
    expect(chunk[1]?.priorityBand).toBe(1);
    // Never-visited, NEWEST first.
    expect(chunk[1]?.subjectRef).toBe(ref(200));
  });

  it("marks the CURRENT top-50 dirty once a day, for zero platform calls", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedMedia(page.id, [
      { ref: ref(301), createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS) },
      { ref: ref(302), createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS) },
    ]);
    // Two top-N windows. Only the LATEST one names an item, and only that item
    // is promoted: "which content performs" is answered by the newest ranking.
    for (
      const row of [
        { ref: ref(301), end: "2026-08-01T00:00:00.000Z", rank: 0 },
        { ref: ref(302), end: "2026-08-21T00:00:00.000Z", rank: 0 },
      ]
    ) {
      await testDb.pool.query(
        `insert into stats_top_media (
           page_id, platform, plane, period_ms, requested_start, requested_end,
           media_offer_ref, rank, content_hash, observed_at, source_event_id,
           source_observation_id, source_account_seq
         ) values ($1, 'fansly', 'top_media', 86400000, $2::timestamptz - interval '30 days',
                   $2, $3, $4, $5, $2, 1, 1, 1)`,
        [page.id, row.end, row.ref, row.rank, "e".repeat(64)],
      );
    }

    const adapter = adapterStub();
    await fanslyMediaStatsChunk(
      appStub(adapter, { fanslyMediaStatsDailyCallBudget: 1 }),
      input(page.id, telemetryStub()),
    );

    const queue = await listSubjectRefreshState(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
    });
    const byRef = new Map(queue.map((row) => [row.subjectRef, row]));
    expect(byRef.get(ref(302))?.dirtyReason).toBe("top_media");
    // The item that was top in an OLDER window is not promoted: it is the
    // CURRENT top-50 that earns a call.
    expect(byRef.get(ref(301))?.dirtyReason).toBeNull();
    expect(await cursor(page.id)).toMatchObject({ topMarkedDay: "2026-08-22" });
  });

  it("holds a FAILED row out until its backoff — dirty band included — unless a new signal arrives", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    const failing = ref(310);
    const healthy = ref(311);
    await seedMedia(page.id, [
      { ref: failing, createdAtPlatform: new Date(NOW.getTime() - 2 * DAY_MS) },
      { ref: healthy, createdAtPlatform: new Date(NOW.getTime() - 3 * DAY_MS) },
    ], { queueCursor: BACKFILL_DONE });
    // The healthy row was visited long ago and never failed: ordinary due-ness.
    await testDb.pool.query(
      `update subject_refresh_state set last_visited_at = $3
        where page_id = $1 and plane = 'media_stats' and subject_ref = $2`,
      [page.id, healthy, new Date(NOW.getTime() - 10 * DAY_MS)],
    );
    const refsAt = async (now: Date) =>
      (await listMediaStatsRefreshChunk(testDb!.db, {
        pageId: page.id,
        limit: 10,
        now,
        longTailCycleDays: 30,
      })).map((row) => row.subjectRef);
    const backOff = () =>
      recordMediaStatsFailure(testDb!.db, {
        pageId: page.id,
        subjectRef: failing,
        nextDueAt: new Date(NOW.getTime() + DAY_MS),
      });

    // Never visited is band one, ahead of the healthy row — until it fails.
    expect(await refsAt(NOW)).toEqual([failing, healthy]);
    await backOff();
    expect(await refsAt(NOW)).toEqual([healthy]);
    expect(await refsAt(new Date(NOW.getTime() + DAY_MS))).toEqual([failing, healthy]);

    // A NEW purchase signal moves `next_due_at` earlier and re-admits it once…
    await markSubjectRefreshDirty(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
      subjectRef: failing,
      dirtyReason: "purchase_notification",
      nextDueAt: NOW,
    });
    expect(await refsAt(NOW)).toEqual([failing, healthy]);
    // …and a dirty row that fails again waits like any other: band zero is not
    // a licence to spend the day's cap on an item that fails every look.
    await backOff();
    expect(await refsAt(NOW)).toEqual([healthy]);
  });
});

describe("media_stats lane — the windows and their guards", () => {
  it("journals an invalid stats envelope without advancing coverage", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedMedia(page.id, [{
      ref: ref(400),
      createdAtPlatform: new Date(NOW.getTime() - 5 * DAY_MS),
    }], { queueCursor: BACKFILL_DONE });
    const adapter = adapterStub({ body: () => ({ aggregationData: {} }) });

    await fanslyMediaStatsChunk(appStub(adapter), input(page.id, telemetryStub()));

    expect(await journaled(page.id)).toHaveLength(1);
    expect(await coverageRows(page.id)).toEqual([]);
    const queue = await listSubjectRefreshState(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
    });
    expect(queue[0]?.lastVisitedAt).toBeNull();
  });

  it("asks the tier's window: 24 h hourly, 30 d daily, 90 d daily", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedMedia(page.id, [
      { ref: ref(401), createdAtPlatform: new Date(NOW.getTime() - 5 * DAY_MS) },
      { ref: ref(402), createdAtPlatform: new Date(NOW.getTime() - 90 * DAY_MS) },
      { ref: ref(403), createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS) },
    ], { queueCursor: BACKFILL_DONE });

    const adapter = adapterStub();
    await drain(page.id, adapter, telemetryStub());

    const byRef = new Map(adapter.calls.map((call) => [call.mediaOfferId, call]));
    const fresh = byRef.get(ref(401))!;
    expect(fresh.periodMs).toBe(3_600_000);
    expect(fresh.beforeDate.getTime() - fresh.afterDate.getTime()).toBe(24 * 60 * 60_000);
    const mid = byRef.get(ref(402))!;
    expect(mid.periodMs).toBe(86_400_000);
    expect(mid.beforeDate.getTime() - mid.afterDate.getTime()).toBe(30 * DAY_MS);
    const tail = byRef.get(ref(403))!;
    expect(tail.periodMs).toBe(86_400_000);
    expect(tail.beforeDate.getTime() - tail.afterDate.getTime()).toBe(90 * DAY_MS);

    // Every call is journaled FIRST, with the window and the tier in its
    // request params — which is what makes "what did we ask for, when" a query
    // over the journal rather than a third copy (A21).
    const rows = await journaled(page.id);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.endpoint).toBe("media_offer_stats");
      expect(row.request_params).toMatchObject({ mode: "steady" });
      expect(row.request_params.mediaOfferId).toBeTypeOf("string");
      expect(row.request_params.periodMs).toBeTypeOf("number");
    }
    expect(rows.map((row) => row.request_params.tier).sort()).toEqual([
      "fresh",
      "long_tail",
      "mid",
    ]);
  });

  it("splits the long tail into three 31-day windows when 90 d is refused", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedMedia(page.id, [{
      ref: ref(410),
      createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS),
    }], { queueCursor: BACKFILL_DONE });

    // The PRODUCTION SHAPE: the provider answers a span it does not like with
    // its own default trailing window, 200 and all.
    const adapter = adapterStub({
      body: (params) => {
        const spanDays = (params.beforeDate.getTime() - params.afterDate.getTime()) / DAY_MS;
        if (spanDays > 31) {
          return statsBody({
            mediaOfferRef: params.mediaOfferId,
            afterMs: params.afterDate.getTime(),
            beforeMs: params.beforeDate.getTime(),
            periodMs: params.periodMs,
            servedAfterMs: params.beforeDate.getTime() - 31 * DAY_MS,
            servedBeforeMs: params.beforeDate.getTime(),
          });
        }
        return statsBody({
          mediaOfferRef: params.mediaOfferId,
          afterMs: params.afterDate.getTime(),
          beforeMs: params.beforeDate.getTime(),
          periodMs: params.periodMs,
        });
      },
    });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    // One refused 90-day probe, then THREE 31-day windows covering the same 93
    // days. The refused response is journaled either way — it is simply not the
    // window we asked for.
    const spans = adapter.calls.map((call) =>
      (call.beforeDate.getTime() - call.afterDate.getTime()) / DAY_MS
    );
    expect(spans).toEqual([90, 31, 31, 31]);
    expect(await journaled(page.id)).toHaveLength(4);

    const discovery = telemetry.anomalies.filter((anomaly) =>
      anomaly.code === "fansly_media_stats_long_tail_window_split"
    );
    // ANNOUNCED ONCE, EVER, and durable: the answer is a property of the route,
    // not of one item, and it TRIPLES what a long-tail visit costs.
    expect(discovery).toHaveLength(1);
    expect(String(discovery[0]?.message)).toMatch(/TRIPLES/);
    expect(await cursor(page.id)).toMatchObject({
      longTailWindowMode: "split_31",
      longTailWindowAnnounced: true,
    });
  });

  it("halves an unhonoured backfill window ONCE, then stops that item", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedMedia(page.id, [{
      ref: ref(420),
      createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS),
    }]);

    // The provider NEVER honours the window: it always serves its own default
    // trailing 31 days ending today. This is the exact shape that spent a whole
    // day's cap on production in 25 byte-identical responses.
    const adapter = adapterStub({
      body: (params) =>
        statsBody({
          mediaOfferRef: params.mediaOfferId,
          afterMs: params.afterDate.getTime(),
          beforeMs: params.beforeDate.getTime(),
          periodMs: params.periodMs,
          servedAfterMs: NOW.getTime() - 31 * DAY_MS,
          servedBeforeMs: NOW.getTime(),
        }),
    });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    // The FIRST window happens to match the provider's own default trailing 31
    // days, so it is honoured and the walk steps back. The SECOND is where the
    // disagreement appears — and that is exactly how it appeared on production:
    // not on the first call, but on the one after it. Then ONE halve, ONE retry,
    // then STOP. Not "retry tomorrow", not "derive from what came back" — both
    // of those are the loop.
    const rows = await journaled(page.id);
    const backfillSpans = rows
      .filter((row) => row.request_params.mode === "backfill")
      .map((row) =>
        Math.round(
          (Date.parse(String(row.request_params.beforeDate))
            - Date.parse(String(row.request_params.afterDate))) / DAY_MS,
        )
      );
    expect(backfillSpans).toEqual([31, 31, 15]);
    const stops = telemetry.anomalies.filter((anomaly) =>
      anomaly.code === "fansly_media_stats_window_not_honoured"
    );
    expect(stops).toHaveLength(1);
    expect(stops[0]?.details).toMatchObject({ trigger: "served_window" });

    // Every response is still JOURNALED — the bytes are durable before anything
    // decides whether the walk has anywhere left to go.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // And the stop is DURABLE, so the next dispatch does not re-open the walk.
    const queue = await listSubjectRefreshState(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
    });
    expect(queue[0]?.backfillCursor).toMatchObject({
      done: true,
      stopReason: "window_not_honoured",
    });
    // AND THE ITEM COUNTS AS VISITED. It journaled three windows; leaving it in
    // the never-visited band would hand it the budget again tomorrow, ahead of
    // items nothing has ever looked at.
    expect(queue[0]?.lastVisitedAt).not.toBeNull();
    // COVERAGE SEES IT. A single item's stopped walk must not flip the whole
    // page's surface claim — this row is an aggregate over thousands of items —
    // so the stop is COUNTED rather than promoted, where an operator reads it
    // instead of writing a bespoke query.
    const coverage = await coverageRows(page.id);
    expect(coverage).toHaveLength(1);
    expect((coverage[0]?.cursor as Record<string, unknown>).backfillStopped).toBe(1);
  });

  it("refuses to re-issue an identical window ACROSS chunks", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    // A cursor that has ALREADY asked for exactly the window it is about to ask
    // for — corrupted state, or a derivation that came back where it started.
    // The durable half of the guard is the one that matters: the production loop
    // spanned five chunks, so a guard living only inside one chunk would have
    // watched it happen five times and said nothing.
    const beforeMs = NOW.getTime();
    await seedMedia(page.id, [{
      ref: ref(430),
      createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS),
    }], {
      queueCursor: {
        version: 1,
        nextBeforeMs: beforeMs,
        emptyStreak: 0,
        done: false,
        floorAt: null,
        stopReason: null,
        guard: {
          spanDays: 31,
          // Already narrowed, so there is no halve-and-retry left to spend.
          narrowed: true,
          lastBeforeMs: beforeMs,
          lastAfterMs: beforeMs - 31 * DAY_MS,
          lastObservationId: null,
        },
      },
    });

    const adapter = adapterStub();
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    // SPENT BEFORE ANY EGRESS. There is nothing to learn from issuing it.
    const rows = await journaled(page.id);
    expect(rows.filter((row) => row.request_params.mode === "backfill")).toHaveLength(0);
    expect(
      telemetry.anomalies.filter((anomaly) =>
        anomaly.code === "fansly_media_stats_window_not_honoured"
      )[0]?.details,
    ).toMatchObject({ trigger: "repeat_request" });
    // The item's STEADY refresh still runs in the same visit: the backfill is
    // over, and today's numbers are a different question from last year's.
    expect(rows.filter((row) => row.request_params.mode === "steady")).toHaveLength(1);
  });

  it("walks the first-sight backfill back to the empty floor in 31-day windows", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    // Published 400 days ago, traffic only in the last 100: the creation floor
    // is nowhere near, so what stops this walk is the EMPTY-WINDOW rule.
    await seedMedia(page.id, [{
      ref: ref(440),
      createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS),
    }]);

    // Traffic for 100 days, and ALL-ZERO rows before it — which is what this
    // route actually serves for any window back to 2006, and the reason a walk
    // counting ROWS never found a floor at all.
    const floorMs = NOW.getTime() - 100 * DAY_MS;
    const adapter = adapterStub({
      body: (params) => {
        const servedBefore = params.beforeDate.getTime();
        const servedAfter = params.afterDate.getTime();
        if (servedBefore <= floorMs) {
          return allZeroBody({
            mediaOfferRef: params.mediaOfferId,
            afterMs: servedAfter,
            beforeMs: servedBefore,
            periodMs: params.periodMs,
          });
        }
        return statsBody({
          mediaOfferRef: params.mediaOfferId,
          afterMs: servedAfter,
          beforeMs: servedBefore,
          periodMs: params.periodMs,
        });
      },
    });
    const telemetry = telemetryStub();
    // TWO VISITS, a long-tail cycle apart. A visit walks four windows and then
    // stamps the row, so the rest of this item's history arrives on its next
    // turn rather than by holding the whole lane on one item.
    await drain(page.id, adapter, telemetry);
    const afterFirstVisit = await listSubjectRefreshState(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
    });
    expect(afterFirstVisit[0]?.lastVisitedAt).not.toBeNull();
    expect(afterFirstVisit[0]?.backfillCursor).toMatchObject({ done: false });
    await drain(page.id, adapter, telemetry, { now: new Date(NOW.getTime() + 31 * DAY_MS) });

    const rows = await journaled(page.id);
    const backfill = rows.filter((row) => row.request_params.mode === "backfill");
    // 31-day windows, backwards, each derived from the RETURNED bounds with one
    // day of overlap: the provider snaps to its own bucket grid, and stepping
    // back from OUR bound would drift a bucket per window.
    expect(backfill.length).toBeGreaterThanOrEqual(5);
    const bounds = backfill.map((row) => ({
      afterMs: Date.parse(String(row.request_params.afterDate)),
      beforeMs: Date.parse(String(row.request_params.beforeDate)),
    }));
    for (const window of bounds) {
      expect(Math.round((window.beforeMs - window.afterMs) / DAY_MS)).toBe(31);
    }
    for (let index = 1; index < bounds.length; index += 1) {
      // Strictly backwards, and CONTIGUOUS: adjacent windows overlap by a day
      // while the provider is still serving bounds, and meet exactly once an
      // empty window serves none.
      expect(bounds[index]!.beforeMs).toBeLessThan(bounds[index - 1]!.beforeMs);
      expect(bounds[index]!.beforeMs).toBeGreaterThanOrEqual(bounds[index - 1]!.afterMs);
    }

    const queue = await listSubjectRefreshState(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
    });
    // The FLOOR, reached and NAMED — the empty windows are journaled, because
    // an empty window IS the floor evidence.
    expect(queue[0]?.backfillCursor).toMatchObject({
      done: true,
      stopReason: "empty_window_streak",
      floorBasis: "empty_window",
    });
    expect(telemetry.anomalies.filter((anomaly) =>
      anomaly.code === "fansly_media_stats_window_not_honoured"
    )).toHaveLength(0);
  });

  it("stops at the item's own CREATION, and repairs a cursor already past it", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    // THE EIGHT BURNED CURSORS. Production 2026-08-22: this route answers every
    // window it is given, back to 2006, with one zero-valued row — so eight
    // media items were each walked 240 windows into a decade that predates
    // Fansly, 1 198 calls in a day. The item was published in 2025.
    await seedMedia(page.id, [{
      ref: ref(450),
      createdAtPlatform: new Date("2025-06-01T00:00:00.000Z"),
    }], {
      queueCursor: {
        version: 1,
        nextBeforeMs: Date.UTC(2006, 3, 1),
        emptyStreak: 0,
        done: false,
        floorAt: null,
        stopReason: null,
        floorBasis: null,
        guard: {
          spanDays: 31,
          narrowed: false,
          lastAfterMs: null,
          lastBeforeMs: null,
          lastObservationId: null,
        },
      },
    });

    const adapter = adapterStub();
    await drain(page.id, adapter, telemetryStub());

    const rows = await journaled(page.id);
    // NOT ONE BACKFILL CALL. An item cannot have traffic before it existed, and
    // the check runs before the request rather than after the response.
    expect(rows.filter((row) => row.request_params.mode === "backfill")).toHaveLength(0);
    const queue = await listSubjectRefreshState(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
    });
    expect(queue[0]?.backfillCursor).toMatchObject({
      done: true,
      stopReason: "created_at_floor",
      // A floor with a NAME: this one is not "the provider had nothing", it is
      // "there was nothing to have".
      floorBasis: "created_at",
    });
    // The item is not stuck: its steady refresh ran in the same visit.
    expect(rows.filter((row) => row.request_params.mode === "steady")).toHaveLength(1);
    expect(queue[0]?.lastVisitedAt).not.toBeNull();
  });

  it("never asks past creation even when the item has always had traffic", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    // No `created_at_platform` at all — the age basis is FIRST SIGHT, the same
    // `coalesce` the tier is computed from. A separate basis for walking and
    // classing would let an item be called fresh and walked as ancient.
    await seedMedia(page.id, [{
      ref: ref(460),
      createdAtPlatform: null,
      firstObservedAt: new Date(NOW.getTime() - 40 * DAY_MS),
    }]);

    // A provider that ALWAYS has traffic, at every depth — the 2006 shape,
    // minus the zeros. Only the creation floor can stop this walk.
    const adapter = adapterStub();
    await drain(page.id, adapter, telemetryStub());
    await drain(page.id, adapter, telemetryStub(), { now: new Date(NOW.getTime() + 8 * DAY_MS) });

    const rows = await journaled(page.id);
    const backfill = rows.filter((row) => row.request_params.mode === "backfill");
    const oldest = Math.min(
      ...backfill.map((row) => Date.parse(String(row.request_params.beforeDate))),
    );
    // NOTHING older than first sight less one window span.
    expect(oldest).toBeGreaterThanOrEqual(NOW.getTime() - 71 * DAY_MS);
    const queue = await listSubjectRefreshState(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
    });
    expect(queue[0]?.backfillCursor).toMatchObject({ done: true, floorBasis: "created_at" });
  });

  it("counts an ALL-ZERO window as empty — the floor rule the 2006 walk needed", () => {
    // The exact production shape: one datapoint, one stats row, every counter
    // zero. A rule reading "datapoints.length > 0" calls this traffic.
    const zero = allZeroBody({
      mediaOfferRef: ref(470),
      afterMs: Date.UTC(2006, 2, 1),
      beforeMs: Date.UTC(2006, 3, 1),
      periodMs: 86_400_000,
    });
    expect(mediaStatsWindowIsEmpty(zero)).toBe(true);
    // ANY non-zero counter is traffic — including a preview-only one, which is
    // the case a `views`-only check would drop.
    const preview = JSON.parse(JSON.stringify(zero)) as typeof zero;
    (preview.dataset.datapoints[0]!.stats[0] as Record<string, unknown>).previewViews = 3;
    expect(mediaStatsWindowIsEmpty(preview)).toBe(false);
    // `type` is identity, not a counter.
    const typed = JSON.parse(JSON.stringify(zero)) as typeof zero;
    (typed.dataset.datapoints[0]!.stats[0] as Record<string, unknown>).type = 2;
    expect(mediaStatsWindowIsEmpty(typed)).toBe(true);
    // No datapoints at all is empty, as it always was.
    expect(mediaStatsWindowIsEmpty({ dataset: { datapoints: [] } })).toBe(true);
    // A window with real numbers is not.
    expect(mediaStatsWindowIsEmpty(statsBody({
      mediaOfferRef: ref(470),
      afterMs: NOW.getTime() - 31 * DAY_MS,
      beforeMs: NOW.getTime(),
      periodMs: 86_400_000,
    }))).toBe(false);
  });

  it("stamps last_visited_at on a BACKFILL visit, so the queue moves on", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    // Six never-visited items, each with more history than one visit can walk.
    // Under the old rule the newest of them took every call, every day, while
    // the other five stayed unvisited — production had 1 198 calls on 8 items
    // and 5 507 rows that had never been looked at.
    await seedMedia(page.id, Array.from({ length: 6 }, (_unused, index) => ({
      ref: ref(480 + index),
      createdAtPlatform: new Date(NOW.getTime() - (300 + index) * DAY_MS),
    })));

    const adapter = adapterStub();
    await drain(page.id, adapter, telemetryStub(), { maxChunks: 6 });

    const queue = await listSubjectRefreshState(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
    });
    const visited = queue.filter((row) => row.lastVisitedAt !== null);
    // MORE THAN ONE ITEM GOT A LOOK, and every one that did was stamped even
    // though none of their backfills finished.
    expect(visited.length).toBeGreaterThan(1);
    for (const row of visited) {
      expect(row.backfillCursor).toMatchObject({ done: false });
    }
    const progress = await countMediaStatsRefreshProgress(testDb.db, {
      pageId: page.id,
      now: NOW,
      longTailCycleDays: 30,
    });
    expect(progress.neverVisited).toBeLessThan(6);
  });
});

describe("media_stats lane — the cap", () => {
  it("counts ATTEMPTS, defers to the next UTC day, and journals what it fetched", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedMedia(page.id, Array.from({ length: 6 }, (_unused, index) => ({
      ref: ref(500 + index),
      createdAtPlatform: new Date(NOW.getTime() - (index + 1) * DAY_MS),
    })), { queueCursor: BACKFILL_DONE });

    // TWO ATTEMPTS PER LOGICAL CALL — a retried request. A cap counted in
    // logical calls would let a retry storm multiply real egress by up to the
    // adapter's retry limit, which on a 300-call lane is the difference between
    // 300 and 1 200 requests a day.
    const adapter = adapterStub({ attemptsPerCall: 2 });
    const telemetry = telemetryStub();
    const results = await drain(page.id, adapter, telemetry, {
      config: { fanslyMediaStatsDailyCallBudget: 4 },
    });

    // Four attempts = TWO logical calls, and the second one crossed the cap.
    expect(adapter.calls).toHaveLength(2);
    const state = await cursor(page.id);
    expect(state?.callsToday).toBe(4);
    // NEVER DROPPED: both responses are journaled, including the one whose
    // attempts crossed the cap.
    expect(await journaled(page.id)).toHaveLength(2);

    const deferredResult = results[results.length - 1]!;
    expect(deferredResult.satisfied).toBe(false);
    expect(deferredResult.stats).toMatchObject({ deferred: "daily_call_budget" });
    // Come back after the UTC ROLL, not sooner.
    expect(deferredResult.continuationRetryAt?.toISOString()).toBe("2026-08-23T00:05:00.000Z");
    const coverage = await coverageRows(page.id);
    expect(coverage[0]).toMatchObject({ plane: "media_stats", status: "budget_deferred" });

    // THE ROLL RESETS THE COUNTER AND NOTHING ELSE. A refresh queue is durable
    // state; a day's allowance is not.
    await fanslyMediaStatsChunk(
      appStub(adapter, { fanslyMediaStatsDailyCallBudget: 4 }),
      input(page.id, telemetry, new SyncChunkBudget(), NEXT_DAY),
    );
    const rolled = await cursor(page.id);
    expect(rolled?.utcDay).toBe("2026-08-23");
    expect(rolled?.callsToday).toBeLessThanOrEqual(4);
    expect(adapter.calls.length).toBeGreaterThan(2);
  });

  it("keeps a failed item from wedging the queue behind it", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedMedia(page.id, [
      { ref: ref(601), createdAtPlatform: new Date(NOW.getTime() - 1 * DAY_MS) },
      { ref: ref(602), createdAtPlatform: new Date(NOW.getTime() - 2 * DAY_MS) },
    ], { queueCursor: BACKFILL_DONE });

    const adapter = adapterStub({
      fail: (params) => params.mediaOfferId === ref(601) ? new Error("boom") : null,
    });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    // The queue CONTINUED: a single unreachable item must not wedge a catalogue
    // of thousands.
    expect(adapter.calls.map((call) => call.mediaOfferId)).toContain(ref(602));
    const queue = await listSubjectRefreshState(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
    });
    const failed = queue.find((row) => row.subjectRef === ref(601))!;
    // A FAILED LOOK IS NOT A LOOK: `last_visited_at` does not move, so the item
    // stays in the never-visited band rather than being retired on an error.
    expect(failed.lastVisitedAt).toBeNull();
    expect(failed.consecutiveFailures).toBe(1);
    const visited = queue.find((row) => row.subjectRef === ref(602))!;
    expect(visited.lastVisitedAt).not.toBeNull();
    expect(telemetry.anomalies.some((anomaly) =>
      anomaly.code === "fansly_media_stats_item_failed"
    )).toBe(true);
  });

  it("lets healthy items run while failed items wait out their backoff", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    // Five items that fail on every look, NEWEST, so without a backoff they
    // head every chunk and a sixth, healthy item behind them is never reached.
    const deadRefs = Array.from({ length: 5 }, (_unused, index) => ref(610 + index));
    const healthyRef = ref(620);
    await seedMedia(page.id, [
      ...deadRefs.map((deadRef, index) => ({
        ref: deadRef,
        createdAtPlatform: new Date(NOW.getTime() - (index + 1) * DAY_MS),
      })),
      { ref: healthyRef, createdAtPlatform: new Date(NOW.getTime() - 10 * DAY_MS) },
    ], { queueCursor: BACKFILL_DONE });

    const adapter = adapterStub({
      fail: (params) =>
        deadRefs.includes(params.mediaOfferId) ? providerRefusal("error getting media offer") : null,
    });
    const telemetry = telemetryStub();
    const chunkAt = async (now: Date) => {
      const before = adapter.calls.length;
      await fanslyMediaStatsChunk(
        appStub(adapter),
        input(page.id, telemetry, new SyncChunkBudget(5), now),
      );
      return adapter.calls.slice(before).map((call) => call.mediaOfferId);
    };

    expect(await chunkAt(NOW)).toEqual(deadRefs);
    // A minute later the continuation reaches the healthy item: every dead one
    // is waiting for the `next_due_at` its failure wrote.
    expect(await chunkAt(new Date(NOW.getTime() + 60_000))).toEqual([healthyRef]);
    // A day on, the backoff has run out and each dead item gets ONE more look.
    expect(await chunkAt(new Date(NOW.getTime() + DAY_MS + 60_000))).toEqual(deadRefs);

    for (const deadRef of deadRefs) {
      const row = await queueRow(page.id, deadRef);
      expect(row.consecutiveFailures).toBe(2);
      expect(row.lastVisitedAt).toBeNull();
    }
    // Waiting is not completeness: five items have still never been looked at.
    expect((await coverageRows(page.id))[0]).toMatchObject({ status: "in_progress" });
  });
});

describe("media_stats lane — the honesty block", () => {
  it("reports M, the class census, the due backlog and the LIVE cycle", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedMedia(page.id, [
      { ref: ref(701), createdAtPlatform: new Date(NOW.getTime() - 5 * DAY_MS) },
      { ref: ref(702), createdAtPlatform: new Date(NOW.getTime() - 90 * DAY_MS) },
      { ref: ref(703), createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS) },
    ], { queueCursor: BACKFILL_DONE });

    const adapter = adapterStub();
    const results = await drain(page.id, adapter, telemetryStub());
    const stats = results[results.length - 1]!.stats as Record<string, unknown>;

    expect(stats).toMatchObject({
      mediaKnown: 3,
      queueSize: 3,
      dailyCap: 300,
      longTailCycleDays: 30,
      seedComplete: true,
    });
    expect(stats.classes).toEqual({ fresh: 1, mid: 1, longTail: 1, dirty: 0 });
    expect(stats.estimatedCycleDays).toBeTypeOf("number");
    expect(stats.requestsPerDayWanted).toBeTypeOf("number");
    expect(stats.saturating).toBe(false);
    expect(stats.deferredToday).toBe(0);
    expect(stats.calledToday).toBe(3);

    // COVERAGE: ONE row for the whole page, never one per media (§3.4) — a
    // coverage row per item would be a second queue of the same cardinality.
    const coverage = await coverageRows(page.id);
    expect(coverage).toHaveLength(1);
    expect(coverage[0]).toMatchObject({
      plane: "media_stats",
      scope_ref: String(page.id),
      status: "window_captured",
      proof: "none",
    });
    expect(Number(coverage[0]?.expected_count)).toBe(3);
    expect(Number(coverage[0]?.observed_unique_count)).toBe(3);
  });

  it("says QUARTERLY out loud when the live cycle passes 90 days", async (ctx) => {
    if (!testDb) return ctx.skip();
    LOG_LINES.length = 0;
    const page = await seedPage();
    // A catalogue whose long tail cannot be funded monthly at the cap in force:
    // 100 long-tail items against a cap of 1 is a 100-day cycle, and 100 > 90.
    await seedMedia(page.id, Array.from({ length: 100 }, (_unused, index) => ({
      ref: ref(800 + index),
      createdAtPlatform: new Date(NOW.getTime() - (200 + index) * DAY_MS),
    })), { queueCursor: BACKFILL_DONE });

    const adapter = adapterStub();
    await drain(page.id, adapter, telemetryStub(), {
      // A cap that funds a third of a long-tail day.
      config: { fanslyMediaStatsDailyCallBudget: 1 },
      maxChunks: 2,
    });

    const line = LOG_LINES.find((entry) => entry.message.includes("QUARTERLY"));
    expect(line, "the cycle must be stated in words, not left as a number").toBeDefined();
    expect(Number(line?.fields.estimatedCycleDays)).toBeGreaterThan(90);
  });
});

describe("media_stats — the cycle arithmetic (A16)", () => {
  // A16's binding table, at the stated publication rate of 5 media a day:
  // fresh (<=30 d) = 150, mid (31-180 d) = 750, and the rest is long tail.
  //
  //   requestsPerDayWanted = H + Mid/7 + L/cycle
  //   estimatedCycleDays   = L / (cap - H - Mid/7)
  //
  // The weekly term is deliberately NOT rounded before it is applied: A16's own
  // numbers only reproduce on the unrounded one, and a lane that reported 98
  // days where the owner's table says 96 would be reporting a different design.
  const rows = [
    { m: 2_000, wanted: 294, cycle: 26 },
    { m: 5_000, wanted: 394, cycle: 96 },
    { m: 10_000, wanted: 560, cycle: 212 },
    { m: 20_000, wanted: 894, cycle: 446 },
  ];

  for (const row of rows) {
    it(`reproduces A16's row for M = ${row.m}`, () => {
      const estimate = estimateMediaStatsCycle({
        fresh: 150,
        mid: 750,
        longTail: row.m - 900,
        dailyCap: 300,
        longTailCycleDays: 30,
      });
      expect(estimate.requestsPerDayWanted).toBe(row.wanted);
      expect(estimate.estimatedCycleDays).toBe(row.cycle);
      // 294 against a cap of 300 is NOT saturating; everything above it is, and
      // this lane is exempt from the 70 %-of-its-own-cap rule by design.
      expect(estimate.saturating).toBe(row.m > 2_000);
      // 96 days is QUARTERLY. The plan must never call it monthly.
      expect(estimate.quarterlyOrWorse).toBe(row.cycle > 90);
    });
  }

  it("never claims a cycle it cannot fund when the daily tiers alone exceed the cap", () => {
    const estimate = estimateMediaStatsCycle({
      fresh: 400,
      mid: 700,
      longTail: 5_000,
      dailyCap: 300,
      longTailCycleDays: 30,
    });
    expect(estimate.saturating).toBe(true);
    // The denominator is clamped to 1, so the number means "at LEAST this many
    // days" — the long tail is not being funded at all, and the due backlog is
    // what says so.
    expect(estimate.estimatedCycleDays).toBe(5_000);
    expect(estimate.quarterlyOrWorse).toBe(true);
  });

  it("reads the class census from the item's AGE, not from refresh_class", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedMedia(page.id, [
      { ref: ref(901), createdAtPlatform: new Date(NOW.getTime() - 5 * DAY_MS) },
      { ref: ref(902), createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS) },
    ]);
    await fanslyMediaStatsChunk(
      appStub(adapterStub()),
      input(page.id, telemetryStub(), new SyncChunkBudget(0)),
    );
    // `refresh_class` is only ever the tier of the LAST visit, and it is
    // `dirty` for anything WP-F2 marked. Counting classes off it would report a
    // purchased long-tail item as neither long tail nor mid.
    await markSubjectRefreshDirty(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
      subjectRef: ref(902),
      dirtyReason: "purchase_notification",
      nextDueAt: NOW,
    });

    const progress = await countMediaStatsRefreshProgress(testDb.db, {
      pageId: page.id,
      now: NOW,
      longTailCycleDays: 30,
    });
    expect(progress).toMatchObject({
      queueSize: 2,
      mediaKnown: 2,
      fresh: 1,
      // Still counted as LONG TAIL by its age, and separately as dirty.
      longTail: 1,
      dirty: 1,
      neverVisited: 2,
      dueNow: 2,
    });
  });
});

describe("media_stats — the pure helpers", () => {
  it("reads the subject from the key the route actually serves", () => {
    expect(servedMediaOfferRef({ dataset: { datasetMediaOfferId: "abc" } })).toBe("abc");
    expect(servedMediaOfferRef({ dataset: {} })).toBeNull();
    expect(servedMediaOfferRef(null)).toBeNull();
  });

  it("counts every stats row across every bucket", () => {
    expect(countMediaStatBuckets({
      dataset: {
        datapoints: [
          { timestamp: 1, stats: [{ type: 0 }, { type: 1 }] },
          { timestamp: 2, stats: [{ type: 0 }] },
        ],
      },
    })).toBe(3);
    expect(countMediaStatBuckets({ dataset: { datapoints: [] } })).toBe(0);
    expect(countMediaStatBuckets({})).toBe(0);
  });

  it("sees a same-end, NARROWER answer that the loop guard cannot", () => {
    const beforeMs = NOW.getTime();
    const requested = { afterMs: beforeMs - 90 * DAY_MS, beforeMs };
    // The provider's default trailing 31 days: same end, nearer start. Nothing
    // reaches newer than we asked and nothing is disjoint, so the loop guard
    // correctly reports no contradiction — there is none. What there is, is 59
    // days we asked for and did not get, and only the coverage check sees it.
    expect(servedWindowCoversRequest(requested, {
      afterMs: beforeMs - 31 * DAY_MS,
      beforeMs,
    })).toBe(false);
    expect(servedWindowCoversRequest(requested, {
      afterMs: beforeMs - 90 * DAY_MS,
      beforeMs,
    })).toBe(true);
    // Served bounds we did not get are no evidence, and no evidence is no
    // contradiction — the empty-window rule owns that case.
    expect(servedWindowCoversRequest(requested, { afterMs: null, beforeMs: null })).toBe(true);
  });

  it("covers the whole 90 days when the long tail is split", () => {
    const split = steadyWindows("long_tail", NOW, "split_31");
    expect(split).toHaveLength(3);
    const covered = split[0]!.beforeMs - split[2]!.afterMs;
    // 3 x 31 = 93 >= 90: the split never covers LESS than the single window it
    // replaces.
    expect(covered / DAY_MS).toBe(93);
    for (const window of split) {
      expect((window.beforeMs - window.afterMs) / DAY_MS).toBe(31);
      expect(window.periodMs).toBe(86_400_000);
    }
  });
});
