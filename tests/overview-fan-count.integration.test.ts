import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  countDistinctFansForPages,
  createFanslyPage,
  createModel,
  upsertFanPages,
  upsertFans,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

let testDb: StartedTestDatabase | null = null;

// The pre-anti-join query, kept verbatim as the oracle: the rewrite in
// `countDistinctFansForPages` exists to drop the `fans` seq scan, NOT to change
// which fans are counted (decision #193 — deleted fans stay excluded).
const LEGACY_QUERY = `
  select count(distinct pf.fan_id)::int as count
  from page_fans pf
  inner join fans f on f.id = pf.fan_id
  where pf.platform_account_id = any($1::bigint[])
    and f.deleted_detected_at is null
`;

async function legacyCount(pageIds: number[]) {
  const result = await testDb!.pool.query<{ count: number }>(LEGACY_QUERY, [pageIds]);
  return result.rows[0]?.count ?? 0;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
});

describe("countDistinctFansForPages", () => {
  it("matches the legacy join across deleted, live and multi-page fans", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = (await createModel(testDb.db, { slug: "lana", name: "Lana" }))!;
    const pageA = (await createFanslyPage(testDb.db, { modelId: model.id, label: "lana-a" }))!;
    const pageB = (await createFanslyPage(testDb.db, { modelId: model.id, label: "lana-b" }))!;
    const pageC = (await createFanslyPage(testDb.db, { modelId: model.id, label: "lana-c" }))!;

    const [liveA, liveShared, deletedA, deletedShared, liveC] = await upsertFans(testDb.db, [
      { platform: "fansly", platformUserId: "live-a", username: "live-a" },
      { platform: "fansly", platformUserId: "live-shared", username: "live-shared" },
      { platform: "fansly", platformUserId: "deleted-a", username: "deleted-a" },
      { platform: "fansly", platformUserId: "deleted-shared", username: "deleted-shared" },
      { platform: "fansly", platformUserId: "live-c", username: "live-c" },
    ]);

    await upsertFanPages(testDb.db, [
      { platformAccountId: pageA.id, fanId: liveA!.id, isFollower: true },
      { platformAccountId: pageA.id, fanId: liveShared!.id, isFollower: true },
      { platformAccountId: pageB.id, fanId: liveShared!.id, isFollower: true },
      { platformAccountId: pageA.id, fanId: deletedA!.id, isFollower: true },
      { platformAccountId: pageA.id, fanId: deletedShared!.id, isFollower: true },
      { platformAccountId: pageB.id, fanId: deletedShared!.id, isFollower: true },
      // Out of scope for the (A, B) window: proves the page filter still bites.
      { platformAccountId: pageC.id, fanId: liveC!.id, isFollower: true },
    ]);

    // upsertFans clears `deleted_detected_at` whenever a present identity is
    // upserted, so the tombstone is set directly.
    await testDb.pool.query(
      "update fans set deleted_detected_at = now() where id = any($1::bigint[])",
      [[deletedA!.id, deletedShared!.id]],
    );

    const scope = [pageA.id, pageB.id];
    expect(await legacyCount(scope)).toBe(2);
    expect(await countDistinctFansForPages(testDb.db, scope)).toBe(await legacyCount(scope));

    // Single page, and a page whose only fan is deleted.
    expect(await countDistinctFansForPages(testDb.db, [pageA.id]))
      .toBe(await legacyCount([pageA.id]));
    expect(await countDistinctFansForPages(testDb.db, [pageC.id]))
      .toBe(await legacyCount([pageC.id]));

    // Every fan deleted → zero, from both queries.
    await testDb.pool.query("update fans set deleted_detected_at = now()");
    expect(await countDistinctFansForPages(testDb.db, scope)).toBe(0);
    expect(await legacyCount(scope)).toBe(0);
  });

  it("returns zero without touching the database for an empty page list", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    expect(await countDistinctFansForPages(testDb.db, [])).toBe(0);
  });
});
