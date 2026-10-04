import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  countMediaStatsRefreshProgress,
  legacyMediaStatsTiers,
  listMediaStatsRefreshChunk,
  upsertCheckpointProgress,
  type Database,
  type MediaStatsRefreshCandidate,
  type MediaStatsTiers,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";

import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { fanslyMediaStatsChunk } from "../apps/runtime/src/services/sync/fansly-media-stats.ts";
import {
  emptyFanslyMediaStatsCursorState,
  parseFanslyMediaStatsCursorState,
} from "../apps/runtime/src/sync/fansly/lib/media-stats-rules.ts";
import {
  mediaStatsOwnerTiers,
  mediaWindowOutcome,
  runMediaVisit,
  startMediaVisit,
  type MediaStatsPageState,
  type MediaVisit,
} from "../apps/runtime/src/sync/fansly/resources/media-stats.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { allZeroBody, DAY_MS, NOW, ref, statsBody } from "./helpers/fansly-media-stats-fixtures.ts";
import {
  fanslyLaneAppStub,
  fanslyLaneInput,
  fanslyLaneTelemetryStub,
  observeFanslyLaneAttempts,
  seedFanslyLanePage,
} from "./helpers/fansly-lane-harness.ts";

// The media-stats queue and visit of the Fansly Sync Engine against the
// legacy lane they reuse (design §4.3, §5.18), on a real database:
//
//  - LEGACY-CALL PARITY: `listMediaStatsRefreshChunk` called as the legacy lane
//    calls it (no `tiers`, no `after`) selects exactly what the statement
//    selected before the inputs existed (a frozen copy, on a fixture covering
//    every band, NULL ages, failures in and out of backoff and microsecond
//    ties); the keyset steps through the order exactly; the owner's tiers
//    (30/90/monthly) differ from the code's (30/180/cycle) where they should.
//  - VISIT PARITY: one item visited by the legacy lane (its budgets out of the
//    way) and by the engine's visit, replayed window by window, asks for the
//    same windows in the same order and leaves the same item state.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

const LABEL = "media-parity";

async function seedPage(): Promise<{ pageId: number; syncRunId: number }> {
  const seeded = await seedFanslyLanePage(testDb!, { slug: "media-parity", name: "Media", label: LABEL, accountRef: "acct-media", stream: "media_stats" });
  return { pageId: seeded.page.id, syncRunId: seeded.syncRunId };
}

async function seedItem(pageId: number, input: {
  ref: string;
  ageDays: number | null;
  firstSeenDaysAgo?: number;
  lastVisitedAt?: string | null;
  dirty?: string | null;
  failures?: number;
  nextDueAt?: Date;
  backfillCursor?: unknown;
  index: number;
}) {
  const created = input.ageDays === null ? null : new Date(NOW.getTime() - input.ageDays * DAY_MS);
  const firstSeen = new Date(NOW.getTime() - (input.firstSeenDaysAgo ?? input.ageDays ?? 1) * DAY_MS);
  await testDb!.pool.query(
    `insert into creator_media (page_id, platform, media_offer_ref, first_origin, created_at_platform, first_observed_at,
            last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', $2, 'stats_agg', $3, $4, $4, $5, 1, 1, $6)`,
    [pageId, input.ref, created, firstSeen, "f".repeat(64), input.index + 1],
  );
  await testDb!.pool.query(
    `insert into subject_refresh_state (page_id, plane, subject_ref, refresh_class, next_due_at, last_visited_at, dirty_reason,
            consecutive_failures, backfill_cursor)
     values ($1, 'media_stats', $2, 'fresh', $3, $4::timestamptz, $5, $6, $7::jsonb)`,
    [pageId, input.ref, input.nextDueAt ?? NOW, input.lastVisitedAt ?? null, input.dirty ?? null, input.failures ?? 0, JSON.stringify(input.backfillCursor ?? {})],
  );
}

/** The chunk statement exactly as it stood before `tiers`/`after` existed. */
async function legacyChunk(pageId: number, limit: number, longTailCycleDays: number) {
  const publicationAt = sql`coalesce(m.created_at_platform, m.first_observed_at)`;
  const tier = sql`case when ${publicationAt} is null then 'fresh'
    when ${publicationAt} >= ${new Date(NOW.getTime() - 30 * DAY_MS)} then 'fresh'
    when ${publicationAt} >= ${new Date(NOW.getTime() - 180 * DAY_MS)} then 'mid' else 'long_tail' end`;
  const dueCutoff = sql`case ${tier}
    when 'fresh' then ${new Date(NOW.getTime() - 1 * DAY_MS)}::timestamptz
    when 'mid' then ${new Date(NOW.getTime() - 7 * DAY_MS)}::timestamptz
    else ${new Date(NOW.getTime() - longTailCycleDays * DAY_MS)}::timestamptz end`;
  const band = sql`case when s.dirty_reason is not null then 0 when s.last_visited_at is null then 1 else 2 end`;
  const edge = sql`case ${tier}
    when 'fresh' then ${new Date(NOW.getTime() - 24 * DAY_MS)}::timestamptz
    when 'mid' then ${new Date(NOW.getTime() - 23 * DAY_MS)}::timestamptz
    else ${new Date(NOW.getTime() - 83 * DAY_MS)}::timestamptz end`;
  const result = await db().execute<Record<string, unknown>>(sql`
    select s.subject_ref, m.created_at_platform, m.first_observed_at, ${publicationAt} as publication_at, s.last_visited_at,
           s.dirty_reason, s.consecutive_failures, s.known_count, s.backfill_cursor, ${tier} as tier, ${band} as priority_band
      from subject_refresh_state s
      join creator_media m on m.page_id = s.page_id and m.platform = 'fansly' and m.media_offer_ref = s.subject_ref
     where s.page_id = ${pageId} and s.plane = 'media_stats'
       and (s.consecutive_failures = 0 or s.next_due_at <= ${NOW})
       and (s.dirty_reason is not null or s.last_visited_at is null or s.last_visited_at < ${dueCutoff})
     order by case when s.dirty_reason is not null then 0 else 1 end asc,
              case ${tier} when 'fresh' then 0 when 'mid' then 1 else 2 end asc,
              case when s.last_visited_at < ${edge} then 0 when s.last_visited_at is null then 1 else 2 end asc,
              s.last_visited_at asc nulls first,
              ${publicationAt} desc nulls last,
              s.subject_ref desc
     limit ${limit}
  `);
  return result.rows.map((row) => {
    const published = row.created_at_platform;
    return {
      subjectRef: row.subject_ref,
      createdAtPlatform: published === null ? null : new Date(published as string),
      firstSeenAt: row.first_observed_at === null ? null : new Date(row.first_observed_at as string),
      publicationBasis: published === null ? "first_seen" : "platform",
      tier: row.tier,
      lastVisitedAt: row.last_visited_at === null ? null : new Date(row.last_visited_at as string),
      dirtyReason: row.dirty_reason,
      consecutiveFailures: Number(row.consecutive_failures),
      knownCount: row.known_count === null ? null : Number(row.known_count),
      backfillCursor: row.backfill_cursor ?? {},
      priorityBand: Number(row.priority_band),
    };
  });
}

/** Every band and order key: dirty, never visited, at the window edge, due by
 *  age, not due, failed in and out of backoff, a NULL platform age, ties. */
async function seedQueueFixture(pageId: number) {
  const tie = "2026-07-20 10:00:00.123456+00";
  const items: Array<Parameters<typeof seedItem>[1]> = [
    { ref: ref(1), ageDays: 5, index: 0 },
    { ref: ref(2), ageDays: 12, index: 1 },
    { ref: ref(3), ageDays: null, firstSeenDaysAgo: 3, index: 2 },
    { ref: ref(4), ageDays: 60, lastVisitedAt: tie, index: 3 },
    { ref: ref(5), ageDays: 60, lastVisitedAt: tie, index: 4 },
    { ref: ref(6), ageDays: 50, lastVisitedAt: "2026-08-12 00:00:00.000001+00", index: 5 },
    { ref: ref(7), ageDays: 100, lastVisitedAt: "2026-08-10 00:00:00+00", index: 6 },
    { ref: ref(8), ageDays: 400, lastVisitedAt: "2026-07-01 00:00:00+00", index: 7 },
    { ref: ref(9), ageDays: 400, lastVisitedAt: "2026-05-01 00:00:00+00", index: 8 },
    { ref: ref(10), ageDays: 20, lastVisitedAt: "2026-08-21 20:00:00+00", index: 9 },
    { ref: ref(11), ageDays: 70, lastVisitedAt: "2026-08-20 00:00:00+00", dirty: "purchase_notification", index: 10 },
    { ref: ref(12), ageDays: 8, failures: 2, nextDueAt: new Date(NOW.getTime() + 3_600_000), index: 11 },
    { ref: ref(13), ageDays: 9, failures: 1, nextDueAt: new Date(NOW.getTime() - 60_000), index: 12 },
    { ref: ref(14), ageDays: 150, lastVisitedAt: "2026-08-16 00:00:00+00", index: 13 },
  ];
  for (const item of items) await seedItem(pageId, item);
}

function withoutKeyset<T extends { keyset: string }>(rows: readonly T[]): Array<Omit<T, "keyset">> {
  return rows.map(({ keyset: _keyset, ...rest }) => rest);
}

describe("the legacy call of the media-stats chunk is unchanged", () => {
  it("selects the same items, fields and order as the statement before `tiers`/`after`", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    await seedQueueFixture(pageId);
    for (const cycle of [30, 45]) {
      for (const limit of [1, 3, 50]) {
        const now = await listMediaStatsRefreshChunk(db(), { pageId, limit, now: NOW, longTailCycleDays: cycle });
        expect(withoutKeyset(now)).toEqual(await legacyChunk(pageId, limit, cycle));
      }
    }
    // Passing the legacy tiers explicitly is the same call.
    const explicit = await listMediaStatsRefreshChunk(db(), { pageId, limit: 50, now: NOW, longTailCycleDays: 1, tiers: legacyMediaStatsTiers(30) });
    expect(explicit).toEqual(await listMediaStatsRefreshChunk(db(), { pageId, limit: 50, now: NOW, longTailCycleDays: 30 }));
  });

  it("steps through the order one item at a time with the keyset, microsecond ties included, under either tiers", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    await seedQueueFixture(pageId);
    for (const tiers of [undefined, mediaStatsOwnerTiers({ registryOverrides: {} })]) {
      const options = { pageId, now: NOW, longTailCycleDays: 30, ...(tiers === undefined ? {} : { tiers }) };
      const all = await listMediaStatsRefreshChunk(db(), { ...options, limit: 100 });
      expect(all.length).toBeGreaterThan(8);
      const stepped: string[] = [];
      let after: string | null = null;
      for (;;) {
        const [next] = await listMediaStatsRefreshChunk(db(), { ...options, limit: 1, after });
        if (next === undefined) break;
        stepped.push(next.subjectRef);
        after = next.keyset;
      }
      expect(stepped).toEqual(all.map((row) => row.subjectRef));
    }
    await expect(listMediaStatsRefreshChunk(db(), { pageId, limit: 1, now: NOW, longTailCycleDays: 30, after: "[1,2]" })).rejects.toThrow(RangeError);
  });

  it("the owner's tiers class an item by 30/90 days and make the older ones monthly", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    await seedQueueFixture(pageId);
    const tierOf = (rows: MediaStatsRefreshCandidate[]) => new Map(rows.map((row) => [row.subjectRef, row.tier]));
    const legacy = tierOf(await listMediaStatsRefreshChunk(db(), { pageId, limit: 100, now: NOW, longTailCycleDays: 30 }));
    const owner = tierOf(await listMediaStatsRefreshChunk(db(), { pageId, limit: 100, now: NOW, longTailCycleDays: 30, tiers: mediaStatsOwnerTiers({ registryOverrides: {} }) }));
    // 100 days: mid by the code, the long tail by the owner's tiers; due
    // weekly by the code (visited 12 days ago), not due monthly.
    expect(legacy.get(ref(7))).toBe("mid");
    expect(owner.has(ref(7))).toBe(false);
    // 150 days visited 6 days ago: due under neither.
    expect(legacy.has(ref(14))).toBe(false);
    expect(owner.has(ref(14))).toBe(false);
    // 60 days: mid under both, due weekly.
    expect([legacy.get(ref(6)), owner.get(ref(6))]).toEqual(["mid", "mid"]);
    expect(owner.get(ref(9))).toBe("long_tail");
  });

  it("the queue's census counts under the tiers its walk reads: the legacy code's by default, the owner's when given (step 3b ruling 12)", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    await seedQueueFixture(pageId);
    const owner = mediaStatsOwnerTiers({ registryOverrides: {} });
    const legacy = await countMediaStatsRefreshProgress(db(), { pageId, now: NOW, longTailCycleDays: 30 });
    expect(await countMediaStatsRefreshProgress(db(), { pageId, now: NOW, longTailCycleDays: 30, tiers: legacyMediaStatsTiers(30) })).toEqual(legacy);
    const census = await countMediaStatsRefreshProgress(db(), { pageId, now: NOW, longTailCycleDays: 30, tiers: owner });
    // What is due is what the walk's chunk admits under the same tiers.
    const due = async (tiers?: MediaStatsTiers) =>
      (await listMediaStatsRefreshChunk(db(), { pageId, limit: 100, now: NOW, longTailCycleDays: 30, ...(tiers === undefined ? {} : { tiers }) })).length;
    expect(legacy.dueNow).toBe(await due());
    expect(census.dueNow).toBe(await due(owner));
    // The 100- and 150-day items are mid by the code, the long tail by the
    // owner's tiers; the 100-day one is due weekly, not monthly.
    expect(census.longTail - legacy.longTail).toBe(2);
    expect(legacy.mid - census.mid).toBe(2);
    expect(legacy.dueNow - census.dueNow).toBe(1);
  });
});

// ── the visit against the legacy lane ───────────────────────────────────────

type Answer = { body: unknown } | { failure: { httpStatus: number } };
type Respond = (window: { afterMs: number; beforeMs: number; periodMs: number }, index: number) => Answer;

/** One legacy chunk over the page, its budgets out of the way. */
async function legacyVisit(pageId: number, syncRunId: number, subjectRef: string, respond: Respond) {
  const calls: Array<{ afterMs: number; beforeMs: number; periodMs: number }> = [];
  const adapter = {
    getMediaOfferStats: vi.fn(async (
      context: { requestObserver?: { onRequestEvent: (event: unknown) => Promise<void> } | null },
      params: { mediaOfferId: string; beforeDate: Date; afterDate: Date; periodMs: number },
    ) => {
      const window = { afterMs: params.afterDate.getTime(), beforeMs: params.beforeDate.getTime(), periodMs: params.periodMs };
      const answer = respond(window, calls.length);
      calls.push(window);
      await observeFanslyLaneAttempts(context, { attempts: 1, requestId: `m:${calls.length}`, operation: "media_offer_stats", endpointTemplate: "/it/moie/statsnew" });
      if ("failure" in answer) {
        throw new FanslyApiError(`Fansly request failed (${answer.failure.httpStatus})`, answer.failure.httpStatus, answer.failure.httpStatus,
          JSON.stringify({ success: false, error: { code: answer.failure.httpStatus, details: "error getting graph" } }));
      }
      return { items: answer.body, raw: answer.body };
    }),
  };
  const app = fanslyLaneAppStub({
    database: testDb!,
    adapter,
    config: {
      fanslyMediaStatsSyncEnabled: true,
      fanslyMediaStatsPageAllowlist: LABEL,
      fanslyMediaStatsDailyCallBudget: 300,
      fanslyMediaStatsLongTailCycleDays: 30,
      fanslyBackfillContinuationDelayMs: 20_000,
    },
  });
  await fanslyMediaStatsChunk(app, fanslyLaneInput({
    pageId, label: LABEL, accountRef: "acct-media", egressKey: "fansly:media", telemetry: fanslyLaneTelemetryStub(), syncRunId, now: NOW,
    budget: new SyncChunkBudget(100, 600_000),
  }) as never);
  const row = await testDb!.pool.query<{ backfill_cursor: Record<string, unknown>; known_count: number | null; last_visited_at: Date | null; dirty_reason: string | null; consecutive_failures: number }>(
    `select backfill_cursor, known_count::int as known_count, last_visited_at, dirty_reason, consecutive_failures
       from subject_refresh_state where page_id = $1 and plane = 'media_stats' and subject_ref = $2`,
    [pageId, subjectRef],
  );
  const state = await testDb!.pool.query<{ state: unknown }>("select state from page_sync_cursors where page_id = $1 and stream = 'media_stats'", [pageId]);
  return { calls, item: row.rows[0]!, lane: parseFanslyMediaStatsCursorState(state.rows[0]?.state)! };
}

/** The engine's visit of the same item, replayed window by window. */
function engineVisit(candidate: MediaStatsRefreshCandidate, page: MediaStatsPageState, respond: Respond) {
  let visit: MediaVisit = startMediaVisit(candidate, page, NOW);
  const calls: Array<{ afterMs: number; beforeMs: number; periodMs: number }> = [];
  for (;;) {
    const run = runMediaVisit(visit);
    if (run.kind !== "need") return { calls, run };
    const window = { afterMs: run.window.afterMs, beforeMs: run.window.beforeMs, periodMs: run.window.periodMs };
    const answer = respond(window, calls.length);
    calls.push(window);
    const outcome = "failure" in answer
      ? { key: run.window.key, failed: { httpStatus: answer.failure.httpStatus, retryAfter: false } }
      : mediaWindowOutcome(run.window, { subjectRef: candidate.subjectRef, response: answer.body, observationId: calls.length }).outcome;
    visit = { ...visit, outcomes: [...visit.outcomes, outcome] };
  }
}

/** A backfill cursor without the observation ids (the journals differ). */
function comparable(cursor: Record<string, unknown> | undefined) {
  if (cursor === undefined) return undefined;
  const guard = { ...(cursor.guard as Record<string, unknown>) };
  delete guard.lastObservationId;
  return { ...cursor, guard };
}

async function parity(input: {
  item: Omit<Parameters<typeof seedItem>[1], "ref" | "index">;
  lane?: Partial<MediaStatsPageState>;
  respond: (subjectRef: string) => Respond;
}) {
  const { pageId, syncRunId } = await seedPage();
  const subjectRef = ref(1);
  await seedItem(pageId, { ...input.item, ref: subjectRef, index: 0 });
  const page: MediaStatsPageState = {
    longTailWindowMode: input.lane?.longTailWindowMode ?? "unproven",
    longTailWindowAnnounced: input.lane?.longTailWindowAnnounced ?? false,
    longTailProbeFailedDay: input.lane?.longTailProbeFailedDay ?? null,
  };
  await upsertCheckpointProgress(testDb!.db, {
    platformAccountId: pageId,
    stream: "media_stats",
    cursorText: page.longTailWindowMode,
    state: { ...emptyFanslyMediaStatsCursorState(NOW), seedComplete: true, ...page },
  });
  const [candidate] = await listMediaStatsRefreshChunk(db(), { pageId, limit: 1, now: NOW, longTailCycleDays: 30, tiers: mediaStatsOwnerTiers({ registryOverrides: {} }) });
  expect(candidate?.subjectRef).toBe(subjectRef);
  const engine = engineVisit(candidate!, page, input.respond(subjectRef));
  const legacy = await legacyVisit(pageId, syncRunId, subjectRef, input.respond(subjectRef));
  expect(engine.calls).toEqual(legacy.calls);
  expect(engine.run.page.longTailWindowMode).toBe(legacy.lane.longTailWindowMode);
  return { engine, legacy };
}

const body = (subjectRef: string, window: { afterMs: number; beforeMs: number; periodMs: number }, extra: Partial<Parameters<typeof statsBody>[0]> = {}) =>
  ({ body: statsBody({ mediaOfferRef: subjectRef, ...window, ...extra }) });
const zeros = (subjectRef: string, window: { afterMs: number; beforeMs: number; periodMs: number }) =>
  ({ body: allZeroBody({ mediaOfferRef: subjectRef, ...window }) });
const BACKFILL_DONE = {
  version: 1, nextBeforeMs: 0, emptyStreak: 2, done: true, floorAt: null, stopReason: "created_at_floor", floorBasis: "created_at",
  guard: { spanDays: 31, narrowed: false, lastAfterMs: null, lastBeforeMs: null, lastObservationId: null },
};

function expectVisitedAlike(result: Awaited<ReturnType<typeof parity>>) {
  const { engine, legacy } = result;
  expect(engine.run.kind).toBe("finished");
  if (engine.run.kind !== "finished") return;
  expect(engine.run.visited).not.toBeNull();
  expect(legacy.item.last_visited_at?.getTime()).toBe(NOW.getTime());
  expect(engine.run.visited!.knownCount).toBe(legacy.item.known_count);
  expect(comparable(engine.run.visited!.backfillCursor)).toEqual(comparable(legacy.item.backfill_cursor));
  expect(legacy.item.dirty_reason === null).toBe(engine.run.visited!.clearDirty);
}

describe("one item's visit: the engine asks what the legacy lane asks, and ends the same", () => {
  it("a first visit walks from today to the item's creation", async (context) => {
    if (!testDb) return context.skip();
    expectVisitedAlike(await parity({
      item: { ageDays: 10 },
      respond: (subjectRef) => (window, index) => (index === 0 ? body(subjectRef, window) : zeros(subjectRef, window)),
    }));
  });

  it("two empty windows buy the first-month probe; traffic there sends the walk back to the gap, whose windows hold the 90-day refresh", async (context) => {
    if (!testDb) return context.skip();
    const result = await parity({
      item: { ageDays: 200 },
      respond: (subjectRef) => (window, index) => (index === 2 ? body(subjectRef, window) : zeros(subjectRef, window)),
    });
    // Today's two windows, the probe at the item's first month, then the gap
    // below the two: together they cover the long tail's 90 days, so the
    // refresh is taken from them without a fifth request.
    expect(result.engine.calls.map((call) => [(NOW.getTime() - call.afterMs) / DAY_MS, (NOW.getTime() - call.beforeMs) / DAY_MS]))
      .toEqual([[31, 0], [62, 31], [201, 170], [93, 62]]);
    expectVisitedAlike(result);
  });

  it("a late mid item reads its refresh and the hole below it", async (context) => {
    if (!testDb) return context.skip();
    const late = new Date(NOW.getTime() - 50 * DAY_MS).toISOString();
    const result = await parity({
      item: { ageDays: 80, lastVisitedAt: late, backfillCursor: BACKFILL_DONE },
      respond: (subjectRef) => (window) => body(subjectRef, window),
    });
    expect(result.engine.calls).toHaveLength(2);
    expectVisitedAlike(result);
  });

  it("a dirty item whose walk resumes in the past reads its refresh first", async (context) => {
    if (!testDb) return context.skip();
    const recent = new Date(NOW.getTime() - 3 * DAY_MS).toISOString();
    const result = await parity({
      item: {
        ageDays: 80, lastVisitedAt: recent, dirty: "purchase_notification",
        backfillCursor: { version: 1, nextBeforeMs: NOW.getTime() - 20 * DAY_MS, emptyStreak: 0, done: false, guard: { spanDays: 31, narrowed: false } },
      },
      respond: (subjectRef) => (window) => body(subjectRef, window),
    });
    expect(result.engine.calls[0]!.beforeMs).toBe(NOW.getTime());
    expectVisitedAlike(result);
  });

  it("a long-tail 90-day window answered narrower splits the page and reads the rest", async (context) => {
    if (!testDb) return context.skip();
    const due = new Date(NOW.getTime() - 35 * DAY_MS).toISOString();
    const result = await parity({
      item: { ageDays: 400, lastVisitedAt: due, backfillCursor: BACKFILL_DONE },
      respond: (subjectRef) => (window, index) => (index === 0
        ? body(subjectRef, window, { servedAfterMs: NOW.getTime() - 31 * DAY_MS, servedBeforeMs: NOW.getTime() })
        : body(subjectRef, window)),
    });
    expect(result.engine.run.page.longTailWindowMode).toBe("split_31");
    expectVisitedAlike(result);
  });

  it("a 90-day window refused with an HTTP 500 falls back to a 31-day probe", async (context) => {
    if (!testDb) return context.skip();
    const due = new Date(NOW.getTime() - 35 * DAY_MS).toISOString();
    const result = await parity({
      item: { ageDays: 400, lastVisitedAt: due, backfillCursor: BACKFILL_DONE },
      lane: { longTailWindowMode: "ninety", longTailWindowAnnounced: true },
      respond: (subjectRef) => (window, index) => (index === 0 ? { failure: { httpStatus: 500 } } : body(subjectRef, window)),
    });
    expect(result.engine.calls).toHaveLength(4);
    expectVisitedAlike(result);
  });

  it("a failed backfill window ends the visit and keeps what the walk accepted", async (context) => {
    if (!testDb) return context.skip();
    const result = await parity({
      item: { ageDays: 60 },
      respond: (subjectRef) => (window, index) => (index === 1 ? { failure: { httpStatus: 404 } } : body(subjectRef, window)),
    });
    expect(result.engine.run.kind).toBe("failed");
    if (result.engine.run.kind !== "failed") return;
    expect(result.legacy.item.last_visited_at).toBeNull();
    expect(comparable(result.engine.run.progress ?? undefined)).toEqual(comparable(result.legacy.item.backfill_cursor));
  });
});
