import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  refreshFanPageFollowerState,
  refreshFanPageSubscriberState,
  upsertFanPages,
  upsertFans,
  upsertPageFollows,
} from "@agency_hub_core/db";

import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// docs/diag/2026-09-11-agency-hub-load: every sync pass rewrote every fan and
// page_fans row of a page with last_seen_at = now() (page_fans: ~10k updates a
// minute on ~350 rows). The writers now skip rows whose data did not change
// unless last_seen_at is older than a minute. A row version is only rewritten
// when Postgres assigns a new xmin, so xmin is the witness.

let harness: StartedTestDatabase;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) {
    throw new Error("Docker-backed Postgres is required for this integration test");
  }
  harness = started;
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

async function seedPage(label: string) {
  const model = await createModel(harness.db, { slug: label, name: label });
  if (!model) throw new Error("model seed failed");
  const page = await createOnlyFansPage(harness.db, { modelId: model.id, label });
  if (!page) throw new Error("page seed failed");
  return page;
}

async function fanVersion(platformUserId: string) {
  const { rows } = await harness.pool.query<{ xmin: string; last_seen_at: Date; username: string | null }>(
    "select xmin::text as xmin, last_seen_at, username from fans where platform = 'onlyfans' and platform_user_id = $1",
    [platformUserId],
  );
  return rows[0]!;
}

async function pageFanVersion(fanId: number, pageId: number) {
  const { rows } = await harness.pool.query<{
    xmin: string; last_seen_at: Date; is_follower: boolean; is_subscriber: boolean;
  }>(
    "select xmin::text as xmin, last_seen_at, is_follower, is_subscriber from page_fans where fan_id = $1 and platform_account_id = $2",
    [fanId, pageId],
  );
  return rows[0]!;
}

describe("fan writers do not rewrite unchanged rows (diag 2026-09-11)", () => {
  it("upsertFans skips an identical re-upsert, still returns every row, and writes real changes", async () => {
    const input = { platform: "onlyfans" as const, platformUserId: "churn-u1", username: "alice", displayName: "Alice" };
    const first = await upsertFans(harness.db, [input]);
    expect(first).toHaveLength(1);
    const v1 = await fanVersion("churn-u1");

    const again = await upsertFans(harness.db, [input]);
    expect(again).toHaveLength(1);
    expect(again[0]!.id).toBe(first[0]!.id);
    const v2 = await fanVersion("churn-u1");
    expect(v2.xmin).toBe(v1.xmin); // untouched: no new row version
    expect(v2.last_seen_at.getTime()).toBe(v1.last_seen_at.getTime());

    const renamed = await upsertFans(harness.db, [{ ...input, username: "alice2" }]);
    expect(renamed[0]!.username).toBe("alice2");
    const v3 = await fanVersion("churn-u1");
    expect(v3.xmin).not.toBe(v1.xmin);
    expect(v3.username).toBe("alice2");

    // A stale last_seen_at is refreshed even without a data change.
    await harness.pool.query(
      "update fans set last_seen_at = now() - interval '2 minutes' where platform_user_id = 'churn-u1'",
    );
    const stale = await fanVersion("churn-u1");
    await upsertFans(harness.db, [{ ...input, username: "alice2" }]);
    const refreshed = await fanVersion("churn-u1");
    expect(refreshed.last_seen_at.getTime()).toBeGreaterThan(stale.last_seen_at.getTime());
  });

  it("upsertFanPages and the follower/subscriber refreshers leave unchanged page_fans rows alone", async () => {
    const page = await seedPage("churn-page");
    const [fan] = await upsertFans(harness.db, [
      { platform: "onlyfans", platformUserId: "churn-u2", username: "bob" },
    ]);
    const membership = { fanId: fan!.id, platformAccountId: page.id, isFollower: true, isSubscriber: false };
    await upsertFanPages(harness.db, [membership]);
    const v1 = await pageFanVersion(fan!.id, page.id);
    expect(v1.is_follower).toBe(true);

    await upsertFanPages(harness.db, [membership]);
    const v2 = await pageFanVersion(fan!.id, page.id);
    expect(v2.xmin).toBe(v1.xmin);

    await upsertFanPages(harness.db, [{ ...membership, isSubscriber: true }]);
    const v3 = await pageFanVersion(fan!.id, page.id);
    expect(v3.xmin).not.toBe(v1.xmin);
    expect(v3.is_subscriber).toBe(true);

    // Follower refresh from an active follow row that matches the current state: no rewrite.
    await upsertPageFollows(harness.db, [{
      platformAccountId: page.id, fanId: fan!.id, platformFollowId: "f-1", followedAt: new Date(Date.now() - 3_600_000),
    }]);
    await refreshFanPageFollowerState(harness.db, page.id);
    const v4 = await pageFanVersion(fan!.id, page.id);
    expect(v4.is_follower).toBe(true);
    await refreshFanPageFollowerState(harness.db, page.id);
    const v5 = await pageFanVersion(fan!.id, page.id);
    expect(v5.xmin).toBe(v4.xmin);

    // Subscriber refresh with no current subscription rows: the row is reset once, then left alone.
    await refreshFanPageSubscriberState(harness.db, page.id);
    const v6 = await pageFanVersion(fan!.id, page.id);
    expect(v6.is_subscriber).toBe(false);
    await refreshFanPageSubscriberState(harness.db, page.id);
    const v7 = await pageFanVersion(fan!.id, page.id);
    expect(v7.xmin).toBe(v6.xmin);

    // Older than the refresh window: last_seen_at moves again.
    await harness.pool.query(
      "update page_fans set last_seen_at = now() - interval '2 minutes' where fan_id = $1 and platform_account_id = $2",
      [fan!.id, page.id],
    );
    await refreshFanPageFollowerState(harness.db, page.id);
    const v8 = await pageFanVersion(fan!.id, page.id);
    expect(v8.xmin).not.toBe(v7.xmin);
    expect(Date.now() - v8.last_seen_at.getTime()).toBeLessThan(60_000);
  });
});
