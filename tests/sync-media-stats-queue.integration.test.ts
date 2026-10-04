import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  countMediaStatsRefreshProgress,
  listMediaStatsRefreshChunk,
  type Database,
  type MediaStatsRefreshCandidate,
  type MediaStatsTiers,
} from "@agency_hub_core/db";

import { mediaStatsOwnerTiers } from "../apps/runtime/src/sync/fansly/resources/media-stats.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { DAY_MS, NOW, ref } from "./helpers/fansly-media-stats-fixtures.ts";
import { seedFanslyLanePage } from "./helpers/fansly-lane-harness.ts";

// The media-stats queue of the Fansly Sync Engine (design §4.3, §5.18), on a
// real database: `listMediaStatsRefreshChunk` selects exactly what a frozen copy
// of its statement selects (a fixture covering every band, NULL ages, failures
// in and out of backoff and microsecond ties); the keyset steps through the
// order exactly; the owner's tiers (30/90/monthly) differ from 30/180-day tiers
// where they should; and the queue's census counts under the tiers its walk
// reads.

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

async function seedPage(): Promise<{ pageId: number }> {
  const seeded = await seedFanslyLanePage(testDb!, { slug: "media-parity", name: "Media", label: LABEL, accountRef: "acct-media", stream: "media_stats" });
  return { pageId: seeded.page.id };
}

/** Tiers of 30 days daily, 180 days weekly and older every `cycleDays` (the
 *  frozen statement's). */
function weeklyTo180Tiers(cycleDays: number): MediaStatsTiers {
  return {
    freshDays: 30,
    midDays: 180,
    freshEveryMs: DAY_MS,
    midEveryMs: 7 * DAY_MS,
    oldEveryMs: cycleDays * DAY_MS,
  };
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

/** The chunk statement frozen at 30/180-day tiers (as it stood before `tiers`
 *  and `after` existed). */
async function frozenChunk(pageId: number, limit: number, longTailCycleDays: number) {
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

describe("the media-stats chunk", () => {
  it("selects the same items, fields and order as its frozen statement", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    await seedQueueFixture(pageId);
    for (const cycle of [30, 45]) {
      for (const limit of [1, 3, 50]) {
        const now = await listMediaStatsRefreshChunk(db(), { pageId, limit, now: NOW, tiers: weeklyTo180Tiers(cycle) });
        expect(withoutKeyset(now)).toEqual(await frozenChunk(pageId, limit, cycle));
      }
    }
  });

  it("steps through the order one item at a time with the keyset, microsecond ties included, under either tiers", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    await seedQueueFixture(pageId);
    for (const tiers of [weeklyTo180Tiers(30), mediaStatsOwnerTiers({ registryOverrides: {} })]) {
      const options = { pageId, now: NOW, tiers };
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
    await expect(listMediaStatsRefreshChunk(db(), { pageId, limit: 1, now: NOW, tiers: weeklyTo180Tiers(30), after: "[1,2]" }))
      .rejects.toThrow(RangeError);
  });

  it("the owner's tiers class an item by 30/90 days and make the older ones monthly", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    await seedQueueFixture(pageId);
    const tierOf = (rows: MediaStatsRefreshCandidate[]) => new Map(rows.map((row) => [row.subjectRef, row.tier]));
    const weekly = tierOf(await listMediaStatsRefreshChunk(db(), { pageId, limit: 100, now: NOW, tiers: weeklyTo180Tiers(30) }));
    const owner = tierOf(await listMediaStatsRefreshChunk(db(), { pageId, limit: 100, now: NOW, tiers: mediaStatsOwnerTiers({ registryOverrides: {} }) }));
    // 100 days: mid at 180-day tiers, the long tail by the owner's; due
    // weekly at 180 days (visited 12 days ago), not due monthly.
    expect(weekly.get(ref(7))).toBe("mid");
    expect(owner.has(ref(7))).toBe(false);
    // 150 days visited 6 days ago: due under neither.
    expect(weekly.has(ref(14))).toBe(false);
    expect(owner.has(ref(14))).toBe(false);
    // 60 days: mid under both, due weekly.
    expect([weekly.get(ref(6)), owner.get(ref(6))]).toEqual(["mid", "mid"]);
    expect(owner.get(ref(9))).toBe("long_tail");
  });

  it("the queue's census counts under the tiers its walk reads (step 3b ruling 12)", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    await seedQueueFixture(pageId);
    const owner = mediaStatsOwnerTiers({ registryOverrides: {} });
    const weekly = weeklyTo180Tiers(30);
    const weeklyCensus = await countMediaStatsRefreshProgress(db(), { pageId, now: NOW, tiers: weekly });
    const census = await countMediaStatsRefreshProgress(db(), { pageId, now: NOW, tiers: owner });
    // What is due is what the walk's chunk admits under the same tiers.
    const due = async (tiers: MediaStatsTiers) =>
      (await listMediaStatsRefreshChunk(db(), { pageId, limit: 100, now: NOW, tiers })).length;
    expect(weeklyCensus.dueNow).toBe(await due(weekly));
    expect(census.dueNow).toBe(await due(owner));
    // The 100- and 150-day items are mid at 180-day tiers, the long tail by the
    // owner's; the 100-day one is due weekly, not monthly.
    expect(census.longTail - weeklyCensus.longTail).toBe(2);
    expect(weeklyCensus.mid - census.mid).toBe(2);
    expect(weeklyCensus.dueNow - census.dueNow).toBe(1);
  });
});
