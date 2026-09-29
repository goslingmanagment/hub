// WP-F4 — media-stats queue, window, coverage and physical-attempt invariants.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  countMediaStatsRefreshProgress,
  getCheckpoint,
  listMediaStatsRefreshChunk,
  listSubjectRefreshState,
  markSubjectRefreshDirty,
  recordMediaStatsFailure,
  upsertCheckpointProgress,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";

import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import {
  emptyFanslyMediaStatsCursorState,
  fanslyMediaStatsChunk,
  parseFanslyMediaStatsCursorState,
  parseMediaBackfillCursor,
} from "../apps/runtime/src/services/sync/fansly-media-stats.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  allZeroBody,
  BACKFILL_DONE,
  DAY_MS,
  NOW,
  ref,
  statsBody,
} from "./helpers/fansly-media-stats-fixtures.ts";
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

const NEXT_DAY = new Date("2026-08-23T09:00:00.000Z");

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

/** A provider refusal as the adapter throws it, on its first attempt: HTTP 500
 *  and Fansly's error envelope. `error getting graph` is the 90-day window's
 *  answer since 2026-09-05; `error getting media offer` is an item that is gone. */
function providerRefusal(details: "error getting graph" | "error getting media offer") {
  return new FanslyApiError(
    `Fansly request failed (500): ${details}`,
    500,
    500,
    JSON.stringify({ success: false, error: { code: 500, details } }),
  );
}

function spanDays(call: AdapterCall): number {
  return (call.beforeDate.getTime() - call.afterDate.getTime()) / DAY_MS;
}

/** Start the page from a lane state it already learned, e.g. a proven 90 days. */
async function seedLaneState(pageId: number, patch: Record<string, unknown>) {
  await upsertCheckpointProgress(testDb!.db, {
    platformAccountId: pageId,
    stream: "media_stats",
    cursorText: String(patch.longTailWindowMode ?? "unproven"),
    state: { ...emptyFanslyMediaStatsCursorState(NOW), ...patch },
  });
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

    // The progress block reports the same backlog the selector admits.
    const dueAt = async (now: Date) =>
      (await countMediaStatsRefreshProgress(testDb!.db, {
        pageId: page.id,
        now,
        longTailCycleDays: 30,
      })).dueNow;

    // Never visited is band one, ahead of the healthy row — until it fails.
    expect(await refsAt(NOW)).toEqual([failing, healthy]);
    expect(await dueAt(NOW)).toBe(2);
    await backOff();
    expect(await refsAt(NOW)).toEqual([healthy]);
    expect(await dueAt(NOW)).toBe(1);
    expect(await refsAt(new Date(NOW.getTime() + DAY_MS))).toEqual([failing, healthy]);
    expect(await dueAt(new Date(NOW.getTime() + DAY_MS))).toBe(2);

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

  it("orders by TIER after the dirty rows: an overdue fresh item before a never-visited long tail", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
    const freshOverdue = ref(401);
    const longNever = ref(402);
    const midNever = ref(403);
    const midOverdue = ref(404);
    const freshNever = ref(405);
    const freshAnswered = ref(406);
    const longOverdue = ref(407);
    const dirtyLong = ref(408);
    await seedMedia(page.id, [
      { ref: freshOverdue, createdAtPlatform: daysAgo(5) },
      { ref: longNever, createdAtPlatform: daysAgo(400) },
      { ref: midNever, createdAtPlatform: daysAgo(90) },
      { ref: midOverdue, createdAtPlatform: daysAgo(60) },
      { ref: freshNever, createdAtPlatform: daysAgo(10) },
      { ref: freshAnswered, createdAtPlatform: daysAgo(3) },
      { ref: longOverdue, createdAtPlatform: daysAgo(300) },
      { ref: dirtyLong, createdAtPlatform: daysAgo(500) },
    ], { queueCursor: BACKFILL_DONE });
    for (
      const [subjectRef, visitedAt] of [
        [freshOverdue, daysAgo(3)],
        [midOverdue, daysAgo(10)],
        [freshAnswered, new Date(NOW.getTime() - 60 * 60 * 1000)],
        [longOverdue, daysAgo(40)],
      ] as const
    ) {
      await testDb.pool.query(
        `update subject_refresh_state set last_visited_at = $3
          where page_id = $1 and plane = 'media_stats' and subject_ref = $2`,
        [page.id, subjectRef, visitedAt],
      );
    }
    await markSubjectRefreshDirty(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
      subjectRef: dirtyLong,
      dirtyReason: "purchase_notification",
      nextDueAt: NOW,
    });

    const chunk = await listMediaStatsRefreshChunk(testDb.db, {
      pageId: page.id,
      limit: 10,
      now: NOW,
      longTailCycleDays: 30,
    });
    // Dirty first, whatever its age. Then fresh → mid → long tail, and never
    // visited ahead of overdue only WITHIN a tier: a fresh item four days late
    // is a hole in this week's numbers; a first look at a year-old item is not.
    expect(chunk.map((row) => row.subjectRef)).toEqual([
      dirtyLong,
      freshNever,
      freshOverdue,
      midNever,
      midOverdue,
      longNever,
      longOverdue,
    ]);
    // The band stays on the candidate as a LABEL; it is no longer the sort's
    // first key outside the dirty rows.
    expect(chunk.map((row) => row.priorityBand)).toEqual([0, 1, 2, 1, 2, 1, 2]);
    // The item answered an hour ago is not due, and the backlog the progress
    // block reports is exactly what the selector admits.
    const progress = await countMediaStatsRefreshProgress(testDb.db, {
      pageId: page.id,
      now: NOW,
      longTailCycleDays: 30,
    });
    expect(progress.dueNow).toBe(chunk.length);
  });

  it("reaches an overdue fresh item even when a full chunk of never-visited long tail is waiting", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    const freshOverdue = ref(420);
    // Production 2026-09-29: 16 288 never-visited rows sat in front of 247
    // overdue fresh items, which waited a median 4.8 days for a daily read.
    await seedMedia(page.id, [
      ...Array.from({ length: 12 }, (_unused, index) => ({
        ref: ref(430 + index),
        createdAtPlatform: new Date(NOW.getTime() - (200 + index) * DAY_MS),
      })),
      { ref: freshOverdue, createdAtPlatform: new Date(NOW.getTime() - 7 * DAY_MS) },
    ], { queueCursor: BACKFILL_DONE });
    await testDb.pool.query(
      `update subject_refresh_state set last_visited_at = $3
        where page_id = $1 and plane = 'media_stats' and subject_ref = $2`,
      [page.id, freshOverdue, new Date(NOW.getTime() - 2 * DAY_MS)],
    );

    const chunk = await listMediaStatsRefreshChunk(testDb.db, {
      pageId: page.id,
      limit: 5,
      now: NOW,
      longTailCycleDays: 30,
    });
    expect(chunk[0]?.subjectRef).toBe(freshOverdue);
    expect(chunk[0]?.tier).toBe("fresh");
    // The rest of the chunk is the long tail's first looks, newest first.
    expect(chunk.slice(1).map((row) => row.subjectRef))
      .toEqual([ref(430), ref(431), ref(432), ref(433)]);
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

  it("fails a window whose body names ANOTHER item, and tolerates one naming none", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    // An open walk, so the body would otherwise count: all-zero, it is the
    // "empty window" half of a floor claim — about a different media item.
    await seedMedia(page.id, [{
      ref: ref(405),
      createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS),
    }]);
    await seedMedia(page.id, [{
      ref: ref(406),
      createdAtPlatform: new Date(NOW.getTime() - 5 * DAY_MS),
    }], { queueCursor: BACKFILL_DONE });
    const adapter = adapterStub({
      body: (params) => {
        const window = {
          afterMs: params.afterDate.getTime(),
          beforeMs: params.beforeDate.getTime(),
          periodMs: params.periodMs,
        };
        if (params.mediaOfferId === ref(405)) {
          return allZeroBody({ ...window, mediaOfferRef: ref(999) });
        }
        // The canonicalizer's documented tolerance: no subject in the body, to
        // be attributed from request_params later. Not a mismatch.
        const unnamed = statsBody({ ...window, mediaOfferRef: params.mediaOfferId });
        delete (unnamed.dataset as Record<string, unknown>).datasetMediaOfferId;
        return unnamed;
      },
    });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    // Journaled FIRST, both of them.
    expect(await journaled(page.id)).toHaveLength(2);
    const mismatches = telemetry.anomalies.filter((anomaly) =>
      anomaly.code === "fansly_media_stats_subject_mismatch"
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.details).toMatchObject({
      mediaOfferRef: ref(405),
      servedMediaOfferRef: ref(999),
    });
    // A failed look: backoff, no stamp, and the walk did NOT count the window.
    const mismatched = await queueRow(page.id, ref(405));
    expect(mismatched.lastVisitedAt).toBeNull();
    expect(mismatched.consecutiveFailures).toBe(1);
    expect(parseMediaBackfillCursor(mismatched.backfillCursor, NOW)).toMatchObject({
      emptyStreak: 0,
      done: false,
      guard: { lastBeforeMs: null },
    });
    // The unnamed body is processed as ever.
    const unnamed = await queueRow(page.id, ref(406));
    expect(unnamed.lastVisitedAt).not.toBeNull();
    expect(unnamed.consecutiveFailures).toBe(0);
  });

  it("asks the tier's window: 31 d daily, 30 d daily, 90 d daily", async (ctx) => {
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
    // FRESH reads DAILY buckets over its whole life, not the last day hourly:
    // the dashboard's daily series is what a fresh visit has to keep current.
    const fresh = byRef.get(ref(401))!;
    expect(fresh.periodMs).toBe(86_400_000);
    expect(fresh.beforeDate.getTime()).toBe(NOW.getTime());
    expect(fresh.beforeDate.getTime() - fresh.afterDate.getTime()).toBe(31 * DAY_MS);
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

  it("takes a fresh item's first backfill window as its refresh, then re-reads its life daily", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    const mediaRef = ref(404);
    const createdMs = NOW.getTime() - 10 * DAY_MS;
    // Never visited: the backfill opens with `[now − 31 d, now]` daily, which
    // is exactly the fresh steady window.
    await seedMedia(page.id, [{ ref: mediaRef, createdAtPlatform: new Date(createdMs) }], {
      queueCursor: {},
    });
    await markSubjectRefreshDirty(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
      subjectRef: mediaRef,
      dirtyReason: "purchase_notification",
      nextDueAt: NOW,
    });
    const adapter = adapterStub();
    const telemetry = telemetryStub();
    await fanslyMediaStatsChunk(appStub(adapter), input(page.id, telemetry));

    // Two backfill windows to the creation floor and NO third request: the
    // first of them already answered the steady window.
    expect(adapter.calls.map((call) => [call.periodMs, call.beforeDate.getTime(), spanDays(call)]))
      .toEqual([
        [86_400_000, NOW.getTime(), 31],
        [86_400_000, NOW.getTime() - 30 * DAY_MS, 31],
      ]);
    expect(telemetry.anomalies.filter((anomaly) =>
      anomaly.code === "fansly_media_stats_window_repeat"
    )).toHaveLength(0);
    const firstVisit = await queueRow(page.id, mediaRef);
    expect(firstVisit.lastVisitedAt).not.toBeNull();
    // Today's numbers were read, so the purchase mark is answered.
    expect(firstVisit.dirtyReason).toBeNull();

    // The next day: history done, ONE daily request, and it still reaches back
    // past the publication day, so the launch-day bucket is restated too.
    const nextVisit = new Date(NEXT_DAY.getTime() + 60_000);
    const before = adapter.calls.length;
    await fanslyMediaStatsChunk(
      appStub(adapter),
      input(page.id, telemetry, new SyncChunkBudget(), nextVisit),
    );
    const steady = adapter.calls.slice(before);
    expect(steady).toHaveLength(1);
    expect(steady[0]!.periodMs).toBe(86_400_000);
    expect(steady[0]!.beforeDate.getTime()).toBe(nextVisit.getTime());
    expect(steady[0]!.afterDate.getTime()).toBeLessThan(createdMs);
    // No hourly window was journaled for this item at all.
    const rows = await journaled(page.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.request_params.periodMs)).toEqual([
      86_400_000,
      86_400_000,
      86_400_000,
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

  /**
   * Traffic in the last 100 days and in the item's FIRST month, all-zero rows
   * everywhere else — which is what this route serves for any quiet window,
   * back to 2006, and the reason a walk counting ROWS never found a floor.
   */
  function recentAndFirstMonthBody(createdMs: number, firstMonth: boolean) {
    const recentFloorMs = NOW.getTime() - 100 * DAY_MS;
    return (params: AdapterCall) => {
      const afterMs = params.afterDate.getTime();
      const beforeMs = params.beforeDate.getTime();
      const traffic = beforeMs > recentFloorMs
        || (firstMonth && afterMs < createdMs + 31 * DAY_MS && beforeMs > createdMs);
      const window = {
        mediaOfferRef: params.mediaOfferId,
        afterMs,
        beforeMs,
        periodMs: params.periodMs,
      };
      return traffic ? statsBody(window) : allZeroBody(window);
    };
  }

  function backfillWindows(rows: Awaited<ReturnType<typeof journaled>>) {
    return rows
      .filter((row) => row.request_params.mode === "backfill")
      .map((row) => ({
        afterMs: Date.parse(String(row.request_params.afterDate)),
        beforeMs: Date.parse(String(row.request_params.beforeDate)),
      }));
  }

  it("walks back to the item's CREATION when a first-month probe finds traffic", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    // Published 400 days ago, traffic in its first month and in the last 100
    // days, silence between. Two empty windows used to END this walk 300 days
    // above creation and call it a floor — the premise "an item cannot have
    // traffic before it was published" only holds for a walk moving FORWARD
    // from publication, and this one walks back from today.
    const createdMs = NOW.getTime() - 400 * DAY_MS;
    await seedMedia(page.id, [{ ref: ref(440), createdAtPlatform: new Date(createdMs) }]);
    const adapter = adapterStub({ body: recentAndFirstMonthBody(createdMs, true) });
    const telemetry = telemetryStub();

    // FOUR VISITS, a long-tail cycle apart: a visit walks four windows and
    // stamps the row, so the history arrives over several turns.
    for (let visit = 0; visit < 4; visit += 1) {
      await drain(page.id, adapter, telemetry, {
        now: new Date(NOW.getTime() + visit * 31 * DAY_MS),
      });
    }

    const windows = backfillWindows(await journaled(page.id));
    for (const window of windows) {
      expect(Math.round((window.beforeMs - window.afterMs) / DAY_MS)).toBe(31);
    }
    // NO WINDOW TWICE — not the second empty one, not the probe's.
    expect(new Set(windows.map((window) => `${window.afterMs}:${window.beforeMs}`)).size)
      .toBe(windows.length);
    // ONE PROBE, straddling creation: a day before it, the item's first month.
    const probeBeforeMs = createdMs + 30 * DAY_MS;
    const probeAt = windows.findIndex((window) => window.beforeMs === probeBeforeMs);
    expect(probeAt).toBeGreaterThan(1);
    expect(windows[probeAt]!.afterMs).toBe(createdMs - DAY_MS);
    // It came after two empty windows, and the walk RESUMED right below the
    // second of them — the bookmark, not a re-read of it.
    const secondEmpty = windows[probeAt - 1]!;
    expect(windows[probeAt + 1]!.beforeMs).toBe(secondEmpty.afterMs);
    // THE GAP IS WALKED, backwards and contiguous, empty windows and all: no
    // streak ends it before it reaches the probe window.
    const gap = windows.slice(probeAt + 1);
    expect(gap.length).toBeGreaterThan(2);
    for (let index = 1; index < gap.length; index += 1) {
      expect(gap[index]!.beforeMs).toBeLessThan(gap[index - 1]!.beforeMs);
      expect(gap[index]!.beforeMs).toBeGreaterThanOrEqual(gap[index - 1]!.afterMs);
    }
    expect(gap.at(-1)!.afterMs).toBeLessThanOrEqual(probeBeforeMs);

    const queue = await listSubjectRefreshState(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
    });
    // The floor is CREATION, reached — not two quiet months.
    expect(queue[0]?.backfillCursor).toMatchObject({
      done: true,
      stopReason: "created_at_floor",
      floorBasis: "created_at",
      probeSpent: true,
      probeResumeBeforeMs: null,
      probeHitBeforeMs: null,
      floorAt: new Date(createdMs - DAY_MS).toISOString(),
    });
    expect(telemetry.anomalies.filter((anomaly) =>
      anomaly.code === "fansly_media_stats_window_not_honoured"
      || anomaly.code === "fansly_media_stats_window_repeat"
    )).toHaveLength(0);
  });

  it("ends at the empty floor after ONE first-month probe comes back empty too", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    const createdMs = NOW.getTime() - 400 * DAY_MS;
    await seedMedia(page.id, [{ ref: ref(441), createdAtPlatform: new Date(createdMs) }]);
    const adapter = adapterStub({ body: recentAndFirstMonthBody(createdMs, false) });
    const telemetry = telemetryStub();

    for (let visit = 0; visit < 3; visit += 1) {
      await drain(page.id, adapter, telemetry, {
        now: new Date(NOW.getTime() + visit * 31 * DAY_MS),
      });
    }

    const windows = backfillWindows(await journaled(page.id));
    // Four windows of traffic, two empty ones, then EXACTLY ONE probe — and
    // nothing after it, on this visit or the next.
    expect(windows).toHaveLength(7);
    expect(windows.at(-1)).toEqual({
      afterMs: createdMs - DAY_MS,
      beforeMs: createdMs + 30 * DAY_MS,
    });
    const queue = await listSubjectRefreshState(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
    });
    // NAMED for what it rests on: two idle windows and an idle first month.
    expect(queue[0]?.backfillCursor).toMatchObject({
      done: true,
      stopReason: "empty_window_probe",
      floorBasis: "empty_window_probe",
      probeSpent: true,
    });
    expect(telemetry.anomalies.filter((anomaly) =>
      anomaly.code === "fansly_media_stats_window_not_honoured"
    )).toHaveLength(0);
  });

  it("re-arms a walk that ended on two empty windows with the probe, directly", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    // THE LEGACY CURSORS (production: 277 of them, 108 more than a window above
    // creation). A walk that stopped on two empty windows keeps the SECOND of
    // them in its cursor and in its durable repeat guard. Re-entering the
    // empty-window branch would re-issue that window, trip the guard, and halve
    // or stop the item; the repair arms the probe instead.
    const createdMs = NOW.getTime() - 400 * DAY_MS;
    const secondEmptyBeforeMs = NOW.getTime() - 151 * DAY_MS;
    const legacy = (nextBeforeMs: number) => ({
      version: 1,
      nextBeforeMs,
      emptyStreak: 2,
      done: true,
      floorAt: new Date(NOW.getTime() - 121 * DAY_MS).toISOString(),
      stopReason: "empty_window_streak",
      floorBasis: "empty_window",
      guard: {
        spanDays: 31,
        narrowed: false,
        lastBeforeMs: nextBeforeMs,
        lastAfterMs: nextBeforeMs - 31 * DAY_MS,
        lastObservationId: null,
      },
    });
    await seedMedia(page.id, [{ ref: ref(442), createdAtPlatform: new Date(createdMs) }], {
      queueCursor: legacy(secondEmptyBeforeMs),
    });
    // …and one that stopped within a window of its creation: no room for a
    // probe, so it stays exactly as it is.
    await seedMedia(page.id, [{
      ref: ref(443),
      createdAtPlatform: new Date(NOW.getTime() - 80 * DAY_MS),
    }], { queueCursor: legacy(NOW.getTime() - 31 * DAY_MS) });

    const adapter = adapterStub({ body: recentAndFirstMonthBody(createdMs, false) });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    const backfill = adapter.calls.filter((call) =>
      call.periodMs === 86_400_000 && call.beforeDate.getTime() !== NOW.getTime()
    );
    // ONE request of history, and it is the probe — not the second empty window.
    expect(backfill).toHaveLength(1);
    expect(backfill[0]!.mediaOfferId).toBe(ref(442));
    expect(backfill[0]!.beforeDate.getTime()).toBe(createdMs + 30 * DAY_MS);
    expect(backfill[0]!.afterDate.getTime()).toBe(createdMs - DAY_MS);
    expect(telemetry.anomalies.filter((anomaly) =>
      anomaly.code === "fansly_media_stats_window_not_honoured"
      || anomaly.code === "fansly_media_stats_window_repeat"
    )).toHaveLength(0);

    const repaired = await queueRow(page.id, ref(442));
    expect(repaired.backfillCursor).toMatchObject({
      done: true,
      floorBasis: "empty_window_probe",
      probeSpent: true,
      // The window stays whole: nothing was halved.
      guard: { spanDays: 31, narrowed: false },
    });
    expect((await queueRow(page.id, ref(443))).backfillCursor).toMatchObject({
      done: true,
      floorBasis: "empty_window",
      stopReason: "empty_window_streak",
    });

    // ONCE: the next turn of either item asks for no history at all.
    const before = adapter.calls.length;
    await drain(page.id, adapter, telemetry, { now: new Date(NOW.getTime() + 31 * DAY_MS) });
    const later = adapter.calls.slice(before);
    expect(later.length).toBeGreaterThan(0);
    for (const call of later) {
      expect(call.beforeDate.getTime()).toBe(NOW.getTime() + 31 * DAY_MS);
    }
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
      fail: (params) =>
        params.mediaOfferId === ref(601) ? providerRefusal("error getting media offer") : null,
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

  for (
    const [label, failure] of [
      ["a dead proxy", () => new TypeError("fetch failed", {
        cause: new Error("Socks5 proxy rejected connection - NotAllowed"),
      })],
      ["a 429 with Retry-After", () => new FanslyApiError(
        "Fansly request failed (429)", 429, 429, undefined, new Date(NOW.getTime() + 600_000),
      )],
      ["a 503 with Retry-After", () => new FanslyApiError(
        "Fansly request failed (503)", 503, 503, undefined, new Date(NOW.getTime() + 600_000),
      )],
    ] as const
  ) {
    it(`leaves ${label} to the executor instead of charging it to the item`, async (ctx) => {
      if (!testDb) return ctx.skip();
      const page = await seedPage();
      await seedMedia(page.id, [
        { ref: ref(631), createdAtPlatform: new Date(NOW.getTime() - 1 * DAY_MS) },
        { ref: ref(632), createdAtPlatform: new Date(NOW.getTime() - 2 * DAY_MS) },
      ], { queueCursor: BACKFILL_DONE });
      const thrown = failure();
      const adapter = adapterStub({ fail: () => thrown });
      const telemetry = telemetryStub();

      // The SAME throwable reaches the executor: its status and `retryAfterAt`
      // are what `classifyTaskFailure` turns into the retry class and the wake-up.
      await expect(fanslyMediaStatsChunk(appStub(adapter), input(page.id, telemetry)))
        .rejects.toBe(thrown);
      // The walk stopped at the wall: it did not carry on into the next item.
      expect(adapter.calls.map((call) => call.mediaOfferId)).toEqual([ref(631)]);
      // And the item was not charged for the page's outage.
      for (const subjectRef of [ref(631), ref(632)]) {
        const row = await queueRow(page.id, subjectRef);
        expect(row.consecutiveFailures).toBe(0);
        expect(row.lastVisitedAt).toBeNull();
        expect(row.nextDueAt?.toISOString()).toBe(NOW.toISOString());
      }
      expect(telemetry.anomalies.map((anomaly) => anomaly.code))
        .not.toContain("fansly_media_stats_item_failed");
    });
  }

  it("keeps a 4xx that carries Retry-After scoped to its item", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedMedia(page.id, [
      { ref: ref(641), createdAtPlatform: new Date(NOW.getTime() - 1 * DAY_MS) },
      { ref: ref(642), createdAtPlatform: new Date(NOW.getTime() - 2 * DAY_MS) },
    ], { queueCursor: BACKFILL_DONE });
    // Re-raised, the executor would read no deadline for a 400 and park the
    // whole stream as provider_bad_data.
    const adapter = adapterStub({
      fail: (params) => params.mediaOfferId === ref(641)
        ? new FanslyApiError("bad request", 400, 400, undefined, new Date(NOW.getTime() + 600_000))
        : null,
    });
    await drain(page.id, adapter, telemetryStub());

    expect(adapter.calls.map((call) => call.mediaOfferId)).toContain(ref(642));
    expect((await queueRow(page.id, ref(641))).consecutiveFailures).toBe(1);
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

describe("media_stats lane — a failed visit keeps its backfill progress", () => {
  for (const failure of ["thrown", "unreadable"] as const) {
    it(`resumes at the window that failed (${failure}), not at the top of the walk`, async (ctx) => {
      if (!testDb) return ctx.skip();
      const page = await seedPage();
      const mediaRef = ref(1010);
      // Mid tier, never visited, with more history than one visit walks.
      await seedMedia(page.id, [{
        ref: mediaRef,
        createdAtPlatform: new Date(NOW.getTime() - 150 * DAY_MS),
      }]);
      // Day one: the first backfill window is answered, the SECOND fails — as
      // a thrown error, or as a body journaled and refused by the parser.
      const failingBeforeMs = NOW.getTime() - 30 * DAY_MS;
      let dayOne = true;
      const failsToday = (params: AdapterCall) =>
        dayOne && params.beforeDate.getTime() === failingBeforeMs;
      const adapter = adapterStub({
        fail: (params) =>
          failure === "thrown" && failsToday(params)
            ? providerRefusal("error getting media offer")
            : null,
        body: (params) =>
          failure === "unreadable" && failsToday(params) ? { aggregationData: {} } : undefined,
      });
      const telemetry = telemetryStub();
      await fanslyMediaStatsChunk(appStub(adapter), input(page.id, telemetry));

      const afterFailure = await queueRow(page.id, mediaRef);
      // The answered window is KEPT, and the guard remembers it — not the
      // window that failed, which was never answered.
      expect(afterFailure.backfillCursor).toMatchObject({
        nextBeforeMs: failingBeforeMs,
        done: false,
        guard: {
          spanDays: 31,
          lastBeforeMs: NOW.getTime(),
          lastAfterMs: NOW.getTime() - 31 * DAY_MS,
        },
      });
      // Still a failed look: not stamped, and the backoff stands.
      expect(afterFailure.lastVisitedAt).toBeNull();
      expect(afterFailure.consecutiveFailures).toBe(1);
      expect(afterFailure.nextDueAt?.toISOString()).toBe(NEXT_DAY.toISOString());

      dayOne = false;
      const before = adapter.calls.length;
      await fanslyMediaStatsChunk(
        appStub(adapter),
        input(page.id, telemetry, new SyncChunkBudget(), NEXT_DAY),
      );
      // The failed window, asked again at its FULL span: not the top of the
      // walk re-anchored at a new `now`, and not a "repeat" to halve or stop.
      const resumed = adapter.calls[before]!;
      expect(resumed.beforeDate.getTime()).toBe(failingBeforeMs);
      expect(spanDays(resumed)).toBe(31);
      expect(telemetry.anomalies.filter((anomaly) =>
        anomaly.code === "fansly_media_stats_window_not_honoured"
      )).toHaveLength(0);
      // The window journaled on day one was never read again.
      expect(adapter.calls.filter((call) => call.beforeDate.getTime() === NOW.getTime()))
        .toHaveLength(1);
      expect((await queueRow(page.id, mediaRef)).lastVisitedAt).not.toBeNull();
    });
  }

  it("keeps a backfill that FINISHED when the steady window then fails", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    const mediaRef = ref(1020);
    // Mid tier, forty days old: its creation floor closes the walk after three
    // windows. (A fresh item's steady window IS its backfill's first window, so
    // a first visit has no separate steady request to fail.)
    await seedMedia(page.id, [{
      ref: mediaRef,
      createdAtPlatform: new Date(NOW.getTime() - 40 * DAY_MS),
    }], { queueCursor: {} });
    await markSubjectRefreshDirty(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
      subjectRef: mediaRef,
      dirtyReason: "purchase_notification",
      nextDueAt: NOW,
    });
    let dayOne = true;
    const adapter = adapterStub({
      // The mid tier's steady window is the 30-day one; every backfill window
      // is 31 days.
      fail: (params) =>
        dayOne && spanDays(params) === 30 ? providerRefusal("error getting media offer") : null,
    });
    await fanslyMediaStatsChunk(appStub(adapter), input(page.id, telemetryStub()));
    expect(adapter.calls.map(spanDays)).toEqual([31, 31, 31, 30]);

    const afterFailure = await queueRow(page.id, mediaRef);
    expect(afterFailure.backfillCursor).toMatchObject({ done: true, floorBasis: "created_at" });
    expect(afterFailure.lastVisitedAt).toBeNull();
    expect(afterFailure.consecutiveFailures).toBe(1);
    // A purchase signal survives a failed fetch.
    expect(afterFailure.dirtyReason).toBe("purchase_notification");

    dayOne = false;
    const before = adapter.calls.length;
    await fanslyMediaStatsChunk(
      appStub(adapter),
      input(page.id, telemetryStub(), new SyncChunkBudget(), NEXT_DAY),
    );
    // The history is done, so the next visit is the steady window alone.
    expect(adapter.calls.slice(before).map(spanDays)).toEqual([30]);
    const visited = await queueRow(page.id, mediaRef);
    expect(visited.lastVisitedAt).not.toBeNull();
    expect(visited.dirtyReason).toBeNull();
    expect(visited.consecutiveFailures).toBe(0);
  });

  it("writes nothing when the FIRST window fails", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    const mediaRef = ref(1030);
    await seedMedia(page.id, [{
      ref: mediaRef,
      createdAtPlatform: new Date(NOW.getTime() - 150 * DAY_MS),
    }], { queueCursor: {} });
    const adapter = adapterStub({ fail: () => providerRefusal("error getting media offer") });
    await fanslyMediaStatsChunk(appStub(adapter), input(page.id, telemetryStub()));

    expect(adapter.calls).toHaveLength(1);
    const row = await queueRow(page.id, mediaRef);
    // Nothing was accepted, so there is nothing to keep: the cursor is not
    // re-anchored at this visit's `now`.
    expect(row.backfillCursor).toEqual({});
    expect(row.consecutiveFailures).toBe(1);
  });
});

describe("media_stats lane — a multi-window refresh is reserved whole", () => {
  /** How many requests repeated an earlier (item, after, before) exactly. */
  function repeatedWindows(calls: AdapterCall[]): number {
    const keys = calls.map((call) =>
      `${call.mediaOfferId}:${call.afterDate.getTime()}:${call.beforeDate.getTime()}`
    );
    return keys.length - new Set(keys).size;
  }

  it("never STARTS a split long tail it cannot finish in the chunk", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedLaneState(page.id, { longTailWindowMode: "split_31", longTailWindowAnnounced: true });
    await seedMedia(page.id, [0, 1, 2].map((index) => ({
      ref: ref(700 + index),
      createdAtPlatform: new Date(NOW.getTime() - (400 + index) * DAY_MS),
    })), { queueCursor: BACKFILL_DONE });

    const adapter = adapterStub();
    await drain(page.id, adapter, telemetryStub());

    // Three items, three windows each, and not one window read twice. With a
    // five-request chunk the second item used to start with two calls left,
    // be discarded unstamped, and be read again whole: 13 calls for 9.
    expect(adapter.calls).toHaveLength(9);
    expect(repeatedWindows(adapter.calls)).toBe(0);
    for (const index of [0, 1, 2]) {
      expect((await queueRow(page.id, ref(700 + index))).lastVisitedAt).not.toBeNull();
    }
  });

  it("reads each item ONCE across the split discovery, too", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedMedia(page.id, [0, 1].map((index) => ({
      ref: ref(710 + index),
      createdAtPlatform: new Date(NOW.getTime() - (400 + index) * DAY_MS),
    })), { queueCursor: BACKFILL_DONE });
    // The route answers anything wider than 31 days with its default trailing
    // 31: the discovery flips the page to split on the first item.
    const adapter = adapterStub({
      body: (params) => statsBody({
        mediaOfferRef: params.mediaOfferId,
        afterMs: params.afterDate.getTime(),
        beforeMs: params.beforeDate.getTime(),
        periodMs: params.periodMs,
        ...(spanDays(params) > 31
          ? { servedAfterMs: params.beforeDate.getTime() - 31 * DAY_MS }
          : {}),
      }),
    });
    await drain(page.id, adapter, telemetryStub());

    expect(adapter.calls.map(spanDays)).toEqual([90, 31, 31, 31, 31, 31, 31]);
    expect(repeatedWindows(adapter.calls)).toBe(0);
  });

  it("defers a split unit the DAY cannot finish, before any call", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    // Two attempts left today: tomorrow reads the unit whole, today spends
    // nothing on a half that would be read again.
    await seedLaneState(page.id, {
      longTailWindowMode: "split_31",
      longTailWindowAnnounced: true,
      callsToday: 3,
    });
    await seedMedia(page.id, [{
      ref: ref(715),
      createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS),
    }], { queueCursor: BACKFILL_DONE });

    const adapter = adapterStub();
    const result = await fanslyMediaStatsChunk(
      appStub(adapter, { fanslyMediaStatsDailyCallBudget: 5 }),
      input(page.id, telemetryStub()),
    );

    expect(adapter.calls).toHaveLength(0);
    expect(result.satisfied).toBe(false);
    expect(result.stats).toMatchObject({ deferred: "daily_call_budget" });
    expect(result.continuationRetryAt!.getTime())
      .toBeGreaterThanOrEqual(Date.parse("2026-08-23T00:00:00.000Z"));
    expect((await queueRow(page.id, ref(715))).lastVisitedAt).toBeNull();
  });

  it("still takes a partial split refresh on a visit that journaled history", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedLaneState(page.id, { longTailWindowMode: "split_31", longTailWindowAnnounced: true });
    // A walk already under way: four backfill windows, then one slot left.
    // The visit is recorded either way, so the one fresh window it can afford
    // is kept rather than skipped — the reservation is only for a refresh that
    // would otherwise be thrown away.
    await seedMedia(page.id, [{
      ref: ref(720),
      createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS),
    }], {
      queueCursor: {
        ...BACKFILL_DONE,
        nextBeforeMs: NOW.getTime() - 100 * DAY_MS,
        emptyStreak: 0,
        done: false,
        stopReason: null,
      },
    });

    const adapter = adapterStub();
    await fanslyMediaStatsChunk(appStub(adapter), input(page.id, telemetryStub()));

    expect(adapter.calls).toHaveLength(5);
    const last = adapter.calls.at(-1)!;
    expect(last.beforeDate.getTime()).toBe(NOW.getTime());
    expect(spanDays(last)).toBe(31);
    expect((await queueRow(page.id, ref(720))).lastVisitedAt).not.toBeNull();
  });
});

describe("media_stats lane — the 90-day window refused with an HTTP error", () => {
  /** Fansly since 2026-09-05: any per-media window over 31 days is refused with
   *  a 500, while the same item answers 31-day windows. */
  const refusesNinety = (params: AdapterCall) =>
    spanDays(params) > 31 ? providerRefusal("error getting graph") : null;
  const splitAnomalies = (telemetry: ReturnType<typeof telemetryStub>) =>
    telemetry.anomalies.filter((anomaly) =>
      anomaly.code === "fansly_media_stats_long_tail_window_split"
    );

  it("moves a page that had PROVEN 90 days to three 31-day windows", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedLaneState(page.id, { longTailWindowMode: "ninety", longTailWindowAnnounced: true });
    const purchased = ref(1110);
    const other = ref(1111);
    await seedMedia(page.id, [
      { ref: purchased, createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS) },
      { ref: other, createdAtPlatform: new Date(NOW.getTime() - 500 * DAY_MS) },
    ], { queueCursor: BACKFILL_DONE });
    await markSubjectRefreshDirty(testDb.db, {
      pageId: page.id,
      plane: "media_stats",
      subjectRef: purchased,
      dirtyReason: "purchase_notification",
      nextDueAt: NOW,
    });

    const adapter = adapterStub({ fail: refusesNinety });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    // ONE refused 90-day window, then the split plan for the same item — its
    // first 31-day window is the evidence.
    expect(adapter.calls.filter((call) => call.mediaOfferId === purchased).map(spanDays))
      .toEqual([90, 31, 31, 31]);
    // Every later long-tail item goes straight to the split plan.
    const otherSpans = adapter.calls.filter((call) => call.mediaOfferId === other).map(spanDays);
    expect(otherSpans.length).toBeGreaterThan(0);
    expect(otherSpans.every((span) => span === 31)).toBe(true);

    // A NEW fact about the route, announced although the mode was announced
    // before.
    const splits = splitAnomalies(telemetry);
    expect(splits).toHaveLength(1);
    expect(splits[0]?.details).toMatchObject({
      trigger: "http_error",
      httpStatus: 500,
      previousMode: "ninety",
      mediaOfferRef: purchased,
    });
    expect(await cursor(page.id)).toMatchObject({ longTailWindowMode: "split_31" });

    // The item was READ: stamped, its failure cleared, its purchase answered.
    const row = await queueRow(page.id, purchased);
    expect(row.lastVisitedAt).not.toBeNull();
    expect(row.consecutiveFailures).toBe(0);
    expect(row.dirtyReason).toBeNull();
  });

  it("never takes a probe's 31-day answer as proof of 90 days", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    // No lane state: the page is `unproven`.
    await seedMedia(page.id, [{
      ref: ref(1120),
      createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS),
    }], { queueCursor: BACKFILL_DONE });
    const adapter = adapterStub({ fail: refusesNinety });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    expect(adapter.calls.map(spanDays)).toEqual([90, 31, 31, 31]);
    // The probe's first window is an honoured, covered 31-day window. Read by
    // the 90-day discovery it would "prove" 90 days on a page that refuses them.
    expect(telemetry.anomalies.some((anomaly) =>
      anomaly.code === "fansly_media_stats_long_tail_window_proven"
    )).toBe(false);
    expect(splitAnomalies(telemetry)[0]?.details).toMatchObject({ previousMode: "unproven" });
    expect(await cursor(page.id)).toMatchObject({ longTailWindowMode: "split_31" });
  });

  it("changes nothing when the item fails on 31 days too, and probes once a day", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedLaneState(page.id, { longTailWindowMode: "ninety", longTailWindowAnnounced: true });
    const first = ref(1130);
    const second = ref(1131);
    await seedMedia(page.id, [
      { ref: first, createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS) },
      { ref: second, createdAtPlatform: new Date(NOW.getTime() - 500 * DAY_MS) },
    ], { queueCursor: BACKFILL_DONE });
    // Both items are gone: every window fails, whatever its span.
    const adapter = adapterStub({ fail: () => providerRefusal("error getting media offer") });
    const telemetry = telemetryStub();
    await drain(page.id, adapter, telemetry);

    // The first item's probe fails too, and spends the page's probe for the
    // day: the second item gets no probe of its own.
    expect(adapter.calls.map((call) => [call.mediaOfferId, spanDays(call)])).toEqual([
      [first, 90],
      [first, 31],
      [second, 90],
    ]);
    expect(await cursor(page.id)).toMatchObject({
      longTailWindowMode: "ninety",
      longTailProbeFailedDay: "2026-08-22",
    });
    expect(splitAnomalies(telemetry)).toHaveLength(0);
    // A failed probe is a second failed look, and it backs off with the item.
    expect((await queueRow(page.id, first)).consecutiveFailures).toBe(2);
    expect((await queueRow(page.id, second)).consecutiveFailures).toBe(1);
    expect((await queueRow(page.id, first)).nextDueAt?.toISOString()).toBe(NEXT_DAY.toISOString());
  });

  for (
    const [label, failure, pageLevel] of [
      ["a transport error", () => new Error("Socks5 proxy rejected connection"), true],
      ["a 429", () => new FanslyApiError("Fansly request failed (429)", 429, 429), true],
      ["a gateway 503", () => new FanslyApiError("Fansly request failed (503)", 503), false],
    ] as const
  ) {
    it(`does not probe after ${label} — that is the wire, not the route`, async (ctx) => {
      if (!testDb) return ctx.skip();
      const page = await seedPage();
      await seedLaneState(page.id, { longTailWindowMode: "ninety", longTailWindowAnnounced: true });
      await seedMedia(page.id, [{
        ref: ref(1140),
        createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS),
      }], { queueCursor: BACKFILL_DONE });
      const adapter = adapterStub({ fail: (params) => spanDays(params) > 31 ? failure() : null });
      const telemetry = telemetryStub();
      // The wire and the provider's pace are the page's: they leave the chunk
      // for the executor before any fallback could read them.
      const chunk = fanslyMediaStatsChunk(appStub(adapter), input(page.id, telemetry));
      if (pageLevel) {
        await expect(chunk).rejects.toThrow();
      } else {
        await chunk;
      }

      expect(adapter.calls.map(spanDays)).toEqual([90]);
      expect(await cursor(page.id)).toMatchObject({
        longTailWindowMode: "ninety",
        longTailProbeFailedDay: null,
      });
      expect(splitAnomalies(telemetry)).toHaveLength(0);
    });
  }

  it("does not probe without chunk capacity", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedLaneState(page.id, { longTailWindowMode: "ninety", longTailWindowAnnounced: true });
    await seedMedia(page.id, [{
      ref: ref(1150),
      createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS),
    }], { queueCursor: BACKFILL_DONE });
    const adapter = adapterStub({ fail: refusesNinety });
    await fanslyMediaStatsChunk(
      appStub(adapter),
      input(page.id, telemetryStub(), new SyncChunkBudget(1)),
    );

    expect(adapter.calls.map(spanDays)).toEqual([90]);
    // Nothing was learned and no probe was spent.
    expect(await cursor(page.id)).toMatchObject({
      longTailWindowMode: "ninety",
      longTailProbeFailedDay: null,
    });
  });

  it("takes a 31-day window its own backfill answered this visit as the evidence", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    await seedLaneState(page.id, { longTailWindowMode: "ninety", longTailWindowAnnounced: true });
    const mediaRef = ref(1160);
    // Never visited, history open: the backfill's first window is
    // `[now − 31 d, now]` daily — exactly the split plan's first window.
    await seedMedia(page.id, [{
      ref: mediaRef,
      createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS),
    }], { queueCursor: {} });
    const adapter = adapterStub({ fail: refusesNinety });
    const telemetry = telemetryStub();
    await fanslyMediaStatsChunk(appStub(adapter), input(page.id, telemetry));

    // Four backfill windows and the refused 90-day window spend the chunk's
    // five requests. None is left for a probe, and none is needed.
    expect(adapter.calls.map(spanDays)).toEqual([31, 31, 31, 31, 90]);
    expect(await cursor(page.id)).toMatchObject({ longTailWindowMode: "split_31" });
    expect(splitAnomalies(telemetry)[0]?.details).toMatchObject({ trigger: "http_error" });
    // The backfill visit counts as a visit, as it always did.
    const row = await queueRow(page.id, mediaRef);
    expect(row.lastVisitedAt).not.toBeNull();
    expect(row.consecutiveFailures).toBe(0);
  });

  it("still takes that evidence after the day's probe failed", async (ctx) => {
    if (!testDb) return ctx.skip();
    const page = await seedPage();
    // An earlier item spent the page's probe today; the limit is on new
    // requests, not on a window this visit already answered.
    await seedLaneState(page.id, {
      longTailWindowMode: "ninety",
      longTailWindowAnnounced: true,
      longTailProbeFailedDay: "2026-08-22",
    });
    const mediaRef = ref(1161);
    await seedMedia(page.id, [{
      ref: mediaRef,
      createdAtPlatform: new Date(NOW.getTime() - 400 * DAY_MS),
    }], { queueCursor: {} });
    const adapter = adapterStub({ fail: refusesNinety });
    const telemetry = telemetryStub();
    await fanslyMediaStatsChunk(appStub(adapter), input(page.id, telemetry));

    expect(adapter.calls.map(spanDays)).toEqual([31, 31, 31, 31, 90]);
    expect(await cursor(page.id)).toMatchObject({ longTailWindowMode: "split_31" });
    expect(splitAnomalies(telemetry)[0]?.details).toMatchObject({ trigger: "http_error" });
    const row = await queueRow(page.id, mediaRef);
    expect(row.lastVisitedAt).not.toBeNull();
    expect(row.consecutiveFailures).toBe(0);
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
