import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  insertObservation,
  listEventsSince,
} from "@agency_hub_core/db";

import {
  FANSLY_REPLAY_FAMILY,
} from "../apps/runtime/src/services/canonicalize/fansly-replay.ts";
import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { runFanslyReplay, type FanslyReplayMode } from "../apps/runtime/src/services/fansly-replay.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

let testDb: StartedTestDatabase | null = null;

const PAGE_ACCOUNT_REF = "772956494390898689";
const FAN_A = "586780754529234944";
const FAN_B = "622205078341689346";
const RECEIVED_AT = new Date("2026-03-10T09:00:00Z");
const OBSERVED_AT = new Date("2026-03-10T08:59:00Z");

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 240_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

function sha256(value: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

/** The runner reads the mode through loadEffectiveConfig, so the boot config
 *  IS the read path when no config_settings override exists. */
function appStub(mode: FanslyReplayMode) {
  return {
    db: testDb!.db,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    config: { fanslyReplayMode: mode },
  } as never;
}

async function seedPage() {
  const model = await createModel(testDb!.db, { slug: "lora", name: "Lora" });
  const page = await createFanslyPage(testDb!.db, { modelId: model!.id, label: "lora-1" });
  const pageId = page!.id;
  await testDb!.pool.query("update pages set external_page_id = $1 where id = $2", [
    PAGE_ACCOUNT_REF,
    pageId,
  ]);
  return pageId;
}

/** Four journaled observations in the shapes production actually stores:
 *  followers/dm_conversations already TRIMMED, subscribers/account_me raw. */
async function seedJournal(pageId: number, sequence = 1) {
  const db = testDb!.db;
  const common = {
    source: "pull" as const,
    platform: "fansly" as const,
    accountId: pageId,
    observedAt: OBSERVED_AT,
    receivedAt: RECEIVED_AT,
  };
  await insertObservation(db, {
    ...common,
    producer: "sync:fansly:followers",
    kind: "followers",
    payload: {
      followers: [
        { id: "885754550978359296", followerId: FAN_A, lastSeenAt: 1 },
        { id: "885754550978359297", followerId: FAN_B, lastSeenAt: 2 },
      ],
      aggregationData: {
        accounts: [
          { id: FAN_A, username: "fan_a", displayName: "Fan A", createdAt: 1745781549000, lastSeenAt: 1 },
          { id: FAN_B, username: "fan_b", displayName: "Fan B", createdAt: 1745781549001, lastSeenAt: 2 },
        ],
      },
    },
    payloadHash: sha256(`followers-${sequence}`),
    idempotencyKey: `${pageId}:followers:${sequence}`,
  });
  await insertObservation(db, {
    ...common,
    producer: "sync:fansly:subscribers",
    kind: "subscribers",
    payload: {
      stats: { totalActive: 1, totalExpired: 0, total: 1 },
      subscriptions: [{
        id: "883584485138907136",
        historyId: "883584485331841026",
        subscriberId: FAN_A,
        subscriptionTierId: "877260451656769536",
        subscriptionTierName: "Videos",
        planId: "877260451707117568",
        status: 3,
        price: 20000,
        renewPrice: 20000,
        autoRenew: 1,
        billingCycle: 30,
        duration: 30,
        renewDate: 1772157317000,
        createdAt: 1772157317000,
        updatedAt: 1772157317000,
        endsAt: 1774576517000,
      }],
    },
    payloadHash: sha256(`subscribers-${sequence}`),
    idempotencyKey: `${pageId}:subscribers:${sequence}`,
  });
  await insertObservation(db, {
    ...common,
    producer: "sync:fansly:dm_conversations",
    kind: "dm_conversations",
    payload: {
      data: [{
        account_id: PAGE_ACCOUNT_REF,
        groupId: "878739490577862656",
        partnerAccountId: FAN_B,
        partnerUsername: "fan_b",
        flags: 6,
        unreadCount: 0,
        subscriptionTierId: null,
        lastMessageId: "885512029928960000",
        lastUnreadMessageId: null,
      }],
      aggregationData: {
        total: 1,
        accounts: [{ id: FAN_B, username: "fan_b", displayName: "Fan B", createdAt: 1745781549001 }],
        groups: [{
          id: "878739490577862656",
          type: 1,
          groupFlags: 0,
          createdBy: PAGE_ACCOUNT_REF,
          users: [],
          lastMessage: null,
        }],
      },
    },
    payloadHash: sha256(`dm_conversations-${sequence}`),
    idempotencyKey: `${pageId}:dm_conversations:${sequence}`,
  });
  await insertObservation(db, {
    ...common,
    producer: "sync:fansly:account_me",
    kind: "account_me",
    payload: {
      account: {
        id: PAGE_ACCOUNT_REF,
        email: "owner@example.com",
        username: "lanavellor",
        displayName: "Lana Vellor",
        followCount: 474,
        subscriberCount: 6,
        createdAt: 1745781549000,
      },
      checkToken: "live-session-secret",
    },
    payloadHash: sha256(`account_me-${sequence}`),
    idempotencyKey: `${pageId}:account_me:${sequence}`,
  });
}

async function countRows(table: string, where = "true"): Promise<number> {
  const result = await testDb!.pool.query<{ n: string }>(
    `select count(*)::text as n from ${table} where ${where}`,
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function parseVersions(): Promise<number[]> {
  const result = await testDb!.pool.query<{ parse_version: number }>(
    "select parse_version from observations order by id",
  );
  return result.rows.map((row) => row.parse_version);
}

describe("Fansly replay runner (slice D)", () => {
  it("is inert when fanslyReplayMode is off", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await seedPage();
    await seedJournal(pageId);

    const report = await runFanslyReplay(appStub("off"));
    expect(report).toMatchObject({ mode: "off", refused: false, canonicalize: null, projection: null });
    expect(await countRows("domain_events")).toBe(0);
    expect(await parseVersions()).toEqual([0, 0, 0, 0]);
  });

  it("shadow canonicalizes and counts but writes NOTHING", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await seedPage();
    await seedJournal(pageId);

    const report = await runFanslyReplay(appStub("shadow"));
    expect(report.mode).toBe("shadow");
    expect(report.refused).toBe(false);
    expect(report.canonicalize?.scanned).toBe(4);
    // followers: 2 follows + 2 identities; subscribers: 1; dm: 1 + 1; me: 1.
    expect(report.canonicalize?.appended).toBe(8);
    expect(report.canonicalize?.stamped).toBe(0);
    expect(report.projection).toBeNull();

    expect(await countRows("domain_events")).toBe(0);
    expect(await countRows("fans")).toBe(0);
    expect(await countRows("page_follows")).toBe(0);
    expect(await countRows("daily_followers")).toBe(0);
    expect(await parseVersions()).toEqual([0, 0, 0, 0]);
    // A shadow run leaves the corpus exactly as an `on` run will find it.
    expect(report.floors.before).toEqual(report.floors.after);
  });

  it("on: appends events, moves the identity/audience planes, and reports the floors", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await seedPage();
    await seedJournal(pageId);

    const report = await runFanslyReplay(appStub("on"));
    expect(report.refused).toBe(false);
    // 8 drafts, 7 rows: fan B's identity is witnessed by BOTH the followers
    // page and the conversations page with the same durable profile, so the
    // content-derived key collapses them — one fact, one row, two witnesses.
    expect(report.canonicalize).toMatchObject({ scanned: 4, appended: 7, deduped: 1, stamped: 4 });
    expect(await parseVersions()).toEqual([1, 1, 1, 1]);

    const events = await listEventsSince(testDb.db, { accountId: pageId, afterSeq: 0 });
    expect(events.map((event) => event.type).sort()).toEqual([
      "conversation.observed",
      "fan.identity_observed",
      "fan.identity_observed",
      "follow.observed",
      "follow.observed",
      "page.identity_observed",
      "subscription.observed",
    ]);

    // Identity plane: both fans exist with their profiles.
    const fans = await testDb.pool.query<{ platform_user_id: string; username: string | null; first_seen_at: Date }>(
      "select platform_user_id, username, first_seen_at from fans order by platform_user_id",
    );
    expect(fans.rows.map((row) => row.platform_user_id).sort()).toEqual([FAN_A, FAN_B].sort());
    expect(fans.rows.every((row) => row.username !== null)).toBe(true);
    // first_seen_at is the OBSERVATION time, not now() — that is the floor.
    expect(fans.rows.every((row) => row.first_seen_at.getTime() === OBSERVED_AT.getTime())).toBe(true);

    // Audience plane: follows landed INACTIVE (a stale page proves nothing
    // about today) yet still feed the daily rollup.
    const follows = await testDb.pool.query<{ is_active: boolean; followed_at: Date }>(
      "select is_active, followed_at from page_follows order by platform_follow_id",
    );
    expect(follows.rows).toHaveLength(2);
    expect(follows.rows.every((row) => row.is_active === false)).toBe(true);
    expect(follows.rows[0]!.followed_at.toISOString()).toBe("2026-03-05T01:38:21.377Z");

    const daily = await testDb.pool.query<{ business_date: string; new_followers: number; known_total_followers: number | null }>(
      "select business_date::text as business_date, new_followers, known_total_followers from daily_followers order by business_date",
    );
    expect(daily.rows).toEqual([
      { business_date: "2026-03-05", new_followers: 2, known_total_followers: null },
      // account_me supplies the historical follower total for its own day —
      // a column that is NULL for every past day without this replay.
      { business_date: "2026-03-10", new_followers: 0, known_total_followers: 474 },
    ]);

    // Membership state: presence + "since" dates, current-state booleans untouched.
    const memberships = await testDb.pool.query<{
      is_follower: boolean;
      is_subscriber: boolean;
      follower_since: Date | null;
      subscriber_since: Date | null;
    }>(
      "select is_follower, is_subscriber, follower_since, subscriber_since from page_fans order by fan_id",
    );
    expect(memberships.rows).toHaveLength(2);
    expect(memberships.rows.every((row) => row.is_follower === false && row.is_subscriber === false))
      .toBe(true);
    expect(memberships.rows.every((row) => row.follower_since !== null)).toBe(true);
    expect(memberships.rows.filter((row) => row.subscriber_since !== null)).toHaveLength(1);

    // The report shows the planes reaching back toward the journal.
    const before = report.floors.before[0]!;
    const after = report.floors.after[0]!;
    expect(before.fansEarliestFirstSeenAt).toBeNull();
    expect(before.pageFollowsEarliestFollowedAt).toBeNull();
    expect(after.journalEarliestReceivedAt).toBe(RECEIVED_AT.toISOString());
    expect(after.fansEarliestFirstSeenAt).toBe(OBSERVED_AT.toISOString());
    expect(after.pageFollowsEarliestFollowedAt).toBe("2026-03-05T01:38:21.377Z");
    expect(after.dailyFollowersEarliestDate).toBe("2026-03-05");
  });

  it("is idempotent: a second run appends nothing and changes no row", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await seedPage();
    await seedJournal(pageId);
    await runFanslyReplay(appStub("on"));

    const snapshot = async () => {
      const rows = await testDb!.pool.query(`
        select
          (select count(*) from domain_events) as events,
          (select count(*) from fans) as fans,
          (select count(*) from page_fans) as page_fans,
          (select count(*) from page_follows) as page_follows,
          (select count(*) from daily_followers) as daily_followers,
          (select min(first_seen_at) from fans) as fans_floor,
          (select min(followed_at) from page_follows) as follows_floor
      `);
      return rows.rows[0];
    };
    const before = await snapshot();

    const second = await runFanslyReplay(appStub("on"));
    expect(second.canonicalize).toMatchObject({ scanned: 0, appended: 0, stamped: 0 });
    expect(second.projection).toMatchObject({ eventsSeen: 0, followsInserted: 0 });
    expect(await snapshot()).toEqual(before);

    // Even a FORCED re-scan below a higher version floor appends nothing:
    // the dedup keys are the real idempotency guarantee, not the stamp.
    const forced = await runCanonicalization(appStub("on"), {
      families: [FANSLY_REPLAY_FAMILY],
      belowParseVersion: 99,
    });
    expect(forced).toMatchObject({ scanned: 4, appended: 0, deduped: 8 });

    // And a re-observed journal page (fresh observation, identical content)
    // dedupes too — the keys are content-derived, not observation-derived.
    await seedJournal(pageId, 2);
    const third = await runFanslyReplay(appStub("on"));
    expect(third.canonicalize).toMatchObject({ scanned: 4, appended: 0, deduped: 8 });
    expect(await snapshot()).toEqual(before);
  });

  it("refuses outright when a journal partition covering the window is detached", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await seedPage();
    await seedJournal(pageId);

    await testDb.pool.query("alter table observations detach partition observations_2026_02");
    try {
      const report = await runFanslyReplay(appStub("on"));
      expect(report.refused).toBe(true);
      expect(report.preflight.ok).toBe(false);
      expect(report.preflight.detachedPartitions.map((partition) => partition.name))
        .toEqual(["observations_2026_02"]);
      // Refusal is total: no canonicalization, no projection, no writes.
      expect(report.canonicalize).toBeNull();
      expect(report.projection).toBeNull();
      expect(await countRows("domain_events")).toBe(0);
      expect(await parseVersions()).toEqual([0, 0, 0, 0]);

      // A window that ends before the detached month is not blocked by it.
      const narrowed = await runFanslyReplay(appStub("on"), {
        from: new Date("2026-01-01T00:00:00Z"),
        to: new Date("2026-02-01T00:00:00Z"),
      });
      expect(narrowed.refused).toBe(false);
    } finally {
      await testDb.pool.query(
        "alter table observations attach partition observations_2026_02 for values from ('2026-02-01') to ('2026-03-01')",
      );
    }
  });

  it("refuses when a partition is parked in tiered_pending_drop", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await seedPage();
    await seedJournal(pageId);

    await testDb.pool.query("create schema if not exists tiered_pending_drop");
    await testDb.pool.query("alter table observations detach partition observations_2026_02");
    await testDb.pool.query("alter table observations_2026_02 set schema tiered_pending_drop");
    try {
      const report = await runFanslyReplay(appStub("on"));
      expect(report.refused).toBe(true);
      expect(report.preflight.detachedPartitions[0]).toMatchObject({
        schema: "tiered_pending_drop",
        name: "observations_2026_02",
        table: "observations",
      });
      expect(await countRows("domain_events")).toBe(0);
    } finally {
      await testDb.pool.query("alter table tiered_pending_drop.observations_2026_02 set schema public");
      await testDb.pool.query(
        "alter table observations attach partition observations_2026_02 for values from ('2026-02-01') to ('2026-03-01')",
      );
    }
  });

  it("never lets a stale snapshot overwrite live identity or current-state flags", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await seedPage();
    await seedJournal(pageId);

    // The live sync got there first: today's username, an ACTIVE follow, and
    // is_follower true. The replay must add history without touching any of it.
    await testDb.pool.query(
      `insert into fans (platform, platform_user_id, username, display_name, first_seen_at, last_seen_at)
       values ('fansly', $1, 'todays_name', 'Todays Name', now(), now())`,
      [FAN_A],
    );
    await testDb.pool.query(
      `insert into page_fans (fan_id, platform_account_id, is_follower, is_subscriber, follower_since)
       select id, $1, true, true, now() from fans where platform_user_id = $2`,
      [pageId, FAN_A],
    );
    await testDb.pool.query(
      `insert into page_follows (platform_account_id, fan_id, platform_follow_id, followed_at, is_active)
       select $1, id, '885754550978359296', now(), true from fans where platform_user_id = $2`,
      [pageId, FAN_A],
    );

    await runFanslyReplay(appStub("on"));

    const live = await testDb.pool.query<{
      username: string;
      is_follower: boolean;
      is_subscriber: boolean;
      follower_since: Date;
      is_active: boolean;
      first_seen_at: Date;
    }>(
      `select f.username, pf.is_follower, pf.is_subscriber, pf.follower_since,
              pfo.is_active, f.first_seen_at
       from fans f
       join page_fans pf on pf.fan_id = f.id
       join page_follows pfo on pfo.fan_id = f.id
       where f.platform_user_id = $1`,
      [FAN_A],
    );
    const row = live.rows[0]!;
    expect(row.username).toBe("todays_name");
    expect(row.is_follower).toBe(true);
    expect(row.is_subscriber).toBe(true);
    expect(row.is_active).toBe(true);
    // The two things a replay MAY move: both strictly earlier.
    expect(row.first_seen_at.getTime()).toBe(OBSERVED_AT.getTime());
    expect(row.follower_since.toISOString()).toBe("2026-03-05T01:38:21.377Z");
    // Still exactly one follow row for that relation — insert-only.
    expect(await countRows("page_follows", "platform_follow_id = '885754550978359296'")).toBe(1);
  });
});
