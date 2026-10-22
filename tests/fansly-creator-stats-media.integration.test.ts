import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  pickCreatorStatsMediaDue,
  queueCreatorStatsMediaOffers,
  recordCreatorStatsMediaRead,
  recordCreatorStatsMediaVisit,
  seedCreatorStatsMediaQueue,
  upsertCreatorMedia,
  upsertCreatorStatsMediaAnswer,
} from "@agency_hub_core/db";

import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// The media plane of the creator statistics (0293): an answer's rows (a
// re-applied older answer never overwrites a fresher one, retention is kept as
// served) and the walk's queue (seeded from the post media, fed by the top
// lists, youngest tier first, `through` only forward).

let db: StartedTestDatabase;
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Docker Postgres required");
  db = started;
}, 120_000);
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await resetIntegrationDatabase(db.pool);
});

async function page(): Promise<number> {
  const model = await createModel(db.db, { slug: "creator-stats-media", name: "Creator stats media" });
  const created = model ? await createFanslyPage(db.db, { modelId: model.id, label: "creator-stats-media-page" }) : undefined;
  if (!created) throw new Error("page seed failed");
  return created.id;
}

const NOW = new Date("2026-10-22T12:00:00Z");
const DAY = 86_400_000;

function answer(views: number) {
  const counters = { views, impressions: views, videoViews: views, completedViews: 1, watchMs: 1_000, watchPctSum: "1234", replays: 0 };
  return {
    mediaOfferId: "offer-1",
    source: 0,
    afterDay: "2026-10-20",
    beforeDay: "2026-10-22",
    capturedDay: "2026-10-22",
    daily: [
      { mediaId: "media-1", mediaType: 2, source: 0, day: "2026-10-21", ...counters, uniqueViewers: views - 1, durationMs: 11_000 },
      { mediaId: "media-1", mediaType: 2, source: 0, day: "2026-10-22", ...counters, uniqueViewers: null, durationMs: 11_000 },
    ],
    hourly: [],
    totals: [{
      mediaId: "media-1", mediaType: 2, source: 0, ...counters, durationMs: 11_000,
      retention: [{ percent: 0, stillWatching: 1 }, { percent: 5, stillWatching: 0.800417972831766 }], retentionSampleSize: views,
    }],
    tags: [{ mediaId: "media-1", mediaType: 2, tagId: "7", kind: 1, tag: "brunette", views, videoViews: views, completedViews: 1, watchMs: 1_000, watchPctSum: "99" }],
    tagSeries: [{ tagId: "7", kind: 1, tag: "brunette", day: "2026-10-21", views }],
    likes: [{ source: 4, day: "2026-10-21", likes: 2, unlikes: 1 }],
  };
}

async function postMedia(pageId: number, ref: string, createdAtPlatform: Date, seq: number, deletedAtPlatform: Date | null = null): Promise<void> {
  await upsertCreatorMedia(db.db, {
    pageId, platform: "fansly", mediaOfferRef: ref, mediaRef: `${ref}-raw`, previewRef: null, bundleRefs: [], mediaType: 2,
    mimeType: "video/mp4", width: null, height: null, durationMs: null, priceMills: null, permissionEntries: [], permissionFlags: null,
    likeCount: null, salesCount: null, salesNetMills: null, salesPendingMills: null, createdAtPlatform, deletedAtPlatform,
    firstOrigin: "post", observedAt: NOW, contentHash: seq.toString(16).padStart(64, "0"), sourceEventId: seq,
    sourceObservationId: seq, sourceAccountSeq: seq,
  });
}

describe("creator statistics media writers", () => {
  it("writes an answer's rows with retention as served and lets only a newer answer replace them", async () => {
    const pageId = await page();
    const newer = { pageId, observationId: 20, capturedAt: new Date("2026-10-22T10:00:00Z") };
    const older = { pageId, observationId: 10, capturedAt: new Date("2026-10-22T09:00:00Z") };

    const written = await upsertCreatorStatsMediaAnswer(db.db, newer, answer(957));
    expect(written).toEqual({ daily: 2, hourly: 0, totals: 1, tags: 1, tag_series: 1, likes: 1 });
    await upsertCreatorStatsMediaAnswer(db.db, older, answer(5));

    const daily = await db.pool.query<{ day: string; views: string; unique_viewers: string | null; observation_id: string }>(
      `select day::text, views::text, unique_viewers::text, observation_id::text
         from fansly_creator_stats_media_daily where page_id = $1 order by day`,
      [pageId],
    );
    expect(daily.rows).toEqual([
      { day: "2026-10-21", views: "957", unique_viewers: "956", observation_id: "20" },
      { day: "2026-10-22", views: "957", unique_viewers: null, observation_id: "20" },
    ]);
    const totals = await db.pool.query<{ retention: unknown; retention_sample_size: string }>(
      `select retention, retention_sample_size::text from fansly_creator_stats_media_totals where page_id = $1`,
      [pageId],
    );
    expect(totals.rows).toEqual([{
      retention: [{ percent: 0, stillWatching: 1 }, { percent: 5, stillWatching: 0.800417972831766 }],
      retention_sample_size: "957",
    }]);
  });
});

describe("the creator statistics media queue", () => {
  it("seeds the post media, takes the top's new offers, serves the youngest first and moves `through` only forward", async () => {
    const pageId = await page();
    await postMedia(pageId, "old", new Date(NOW.getTime() - 200 * DAY), 1);
    await postMedia(pageId, "young", new Date(NOW.getTime() - DAY), 2);
    expect(await seedCreatorStatsMediaQueue(db.db, { pageId, now: NOW })).toBe(2);
    expect(await seedCreatorStatsMediaQueue(db.db, { pageId, now: NOW })).toBe(0);
    // Deleted after it was queued: the next seed marks it, once.
    await postMedia(pageId, "old", new Date(NOW.getTime() - 200 * DAY), 3, new Date(NOW.getTime() - 100 * DAY));
    expect(await seedCreatorStatsMediaQueue(db.db, { pageId, now: NOW })).toBe(1);
    expect(await seedCreatorStatsMediaQueue(db.db, { pageId, now: NOW })).toBe(0);

    const top = await queueCreatorStatsMediaOffers(db.db, {
      pageId, now: NOW, other: true,
      offers: [{ mediaOfferId: "old", postedAtMs: null }, { mediaOfferId: "top-only", postedAtMs: NOW.getTime() - 10 * DAY }],
    });
    expect(top).toEqual({ queued: 1, marked: 1 });

    const tiers = [2, 30, 93, null];
    const first = await pickCreatorStatsMediaDue(db.db, { pageId, now: NOW, tierMaxAgeDays: tiers });
    expect(first.candidate?.subjectRef).toBe("young");
    expect(first.candidate?.backfillCursor).toEqual({ postedAtMs: NOW.getTime() - DAY });

    await recordCreatorStatsMediaRead(db.db, { pageId, subjectRef: "young", source: 0, throughMs: Date.parse("2026-10-22") });
    await recordCreatorStatsMediaRead(db.db, { pageId, subjectRef: "young", source: 0, throughMs: Date.parse("2026-10-20") });
    await recordCreatorStatsMediaVisit(db.db, {
      pageId, subjectRef: "young", visitedAt: NOW, nextDueAt: new Date(NOW.getTime() + 6 * 3_600_000), refreshClass: "fresh",
    });
    const second = await pickCreatorStatsMediaDue(db.db, { pageId, now: NOW, tierMaxAgeDays: tiers });
    expect(second.candidate?.subjectRef).toBe("top-only");

    const rows = await db.pool.query<{ subject_ref: string; backfill_cursor: Record<string, unknown> }>(
      `select subject_ref, backfill_cursor from subject_refresh_state
        where page_id = $1 and plane = 'creator_stats_media' order by subject_ref`,
      [pageId],
    );
    expect(Object.fromEntries(rows.rows.map((row) => [row.subject_ref, row.backfill_cursor]))).toEqual({
      old: { postedAtMs: NOW.getTime() - 200 * DAY, deletedAtMs: NOW.getTime() - 100 * DAY, other: true },
      "top-only": { postedAtMs: NOW.getTime() - 10 * DAY, other: true },
      young: { postedAtMs: NOW.getTime() - DAY, through: { "0": Date.parse("2026-10-22") } },
    });
  });
});
