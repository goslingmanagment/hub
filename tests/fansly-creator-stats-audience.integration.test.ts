import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, upsertCreatorStatsGeo, upsertCreatorStatsTags } from "@agency_hub_core/db";

import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// The audience writers (0294): rows land under the window they were served
// for, a re-applied older answer never overwrites a fresher one, and one tags
// answer writes its window totals, its days and its tag names.

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
  const model = await createModel(db.db, { slug: "creator-stats-audience", name: "Creator stats audience" });
  const created = model ? await createFanslyPage(db.db, { modelId: model.id, label: "creator-stats-audience-page" }) : undefined;
  if (!created) throw new Error("page seed failed");
  return created.id;
}

describe("creator statistics audience writers", () => {
  it("keeps a geo window's rows per country and lets only a newer answer replace them", async () => {
    const pageId = await page();
    const window = { source: 0, afterDay: "2026-10-21", beforeDay: "2026-10-21" };
    const row = (views: number) => ({
      country: "US", views, imageViews: 0, videoViews: views, watchMs: 4_000 * views, watchPctSum: "241939285",
      avgWatchPercent: "42.78400767475994", avgWatchMs: "4369.950626889954", profileVisits: 12,
    });
    await upsertCreatorStatsGeo(db.db, { pageId, observationId: 20, capturedAt: new Date("2026-10-22T10:00:00Z") }, window, [
      row(500),
      { ...row(0), country: "", views: null, imageViews: null, videoViews: null, watchMs: null, watchPctSum: null, avgWatchPercent: null, avgWatchMs: null, profileVisits: 3 },
    ]);
    await upsertCreatorStatsGeo(db.db, { pageId, observationId: 10, capturedAt: new Date("2026-10-22T04:00:00Z") }, window, [row(100)]);

    const stored = await db.pool.query<{ country: string; views: string | null; avg_watch_percent: string | null; profile_visits: string }>(
      `select country, views::text, avg_watch_percent::text, profile_visits::text
         from fansly_creator_stats_geo where page_id = $1 order by country`,
      [pageId],
    );
    expect(stored.rows).toEqual([
      { country: "", views: null, avg_watch_percent: null, profile_visits: "3" },
      { country: "US", views: "500", avg_watch_percent: "42.78400767475994", profile_visits: "12" },
    ]);
  });

  it("writes a tags answer's window totals, its days and its tag names", async () => {
    const pageId = await page();
    const written = await upsertCreatorStatsTags(db.db, { pageId, observationId: 1, capturedAt: new Date("2026-10-22T03:11:18Z") },
      { source: 0, afterDay: "2026-09-22", beforeDay: "2026-10-21" }, {
        kind: 1,
        liftAvailable: true,
        rows: [{
          tagId: "436274790202880007", views: 13985, imageViews: 0, videoViews: 13985, watchMs: 76636922, imageWatchMs: 0,
          completedViews: 3747, watchPctSum: "72859488", liftPoints: "-46.08012536041119", liftVideoViews: 13985,
        }],
        series: [
          { tagId: "436274790202880007", day: "2026-09-22", views: 47, imageViews: 0 },
          { tagId: "436274790202880007", day: "2026-09-23", views: 52, imageViews: 0 },
        ],
        names: [{ tagId: "436274790202880007", tag: "ass" }],
      });
    expect(written).toEqual({ tags: 1, tag_series: 2, tag_names: 1 });
    const tags = await db.pool.query<{ lift_points: string; lift_available: boolean; tag: string }>(
      `select t.lift_points::text, t.lift_available, n.tag
         from fansly_creator_stats_tags t
         join fansly_creator_stats_tag_names n on n.page_id = t.page_id and n.tag_id = t.tag_id
        where t.page_id = $1`,
      [pageId],
    );
    expect(tags.rows).toEqual([{ lift_points: "-46.08012536041119", lift_available: true, tag: "ass" }]);
  });
});
