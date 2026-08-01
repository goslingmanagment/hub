import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendDomainEvents,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertObservation,
  listEventsSince,
  rebuildFollowerRollups,
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
/** Both seeded follow ids decode to this UTC day. */
const FOLLOW_DAY = "2026-03-05";
const FOLLOW_DAY_OBSERVED_AT = new Date(`${FOLLOW_DAY}T12:00:00Z`);
const FIRST_FOLLOWED_AT = "2026-03-05T01:38:21.377Z";

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
  // A second identity snapshot observed on the day the follows landed. Its
  // event carries that UTC day, which is how the rollup finds a witness for a
  // historical `known_total_followers` — a column the live sync fills only for
  // the current day.
  await insertObservation(db, {
    ...common,
    producer: "sync:fansly:account_me",
    kind: "account_me",
    observedAt: FOLLOW_DAY_OBSERVED_AT,
    payload: {
      account: {
        id: PAGE_ACCOUNT_REF,
        email: "owner@example.com",
        username: "lanavellor",
        displayName: "Lana Vellor",
        followCount: 470,
        subscriberCount: 6,
        createdAt: 1745781549000,
      },
      checkToken: "live-session-secret",
    },
    payloadHash: sha256(`account_me-followday-${sequence}`),
    idempotencyKey: `${pageId}:account_me_followday:${sequence}`,
  });
}

/** One journaled row inside observations_2026_02, so detaching that partition
 *  actually hides something. An EMPTY detached partition hides nothing and is
 *  deliberately not an offender — the healthy prod schema has several. */
async function seedFebruaryObservation(pageId: number) {
  await insertObservation(testDb!.db, {
    source: "pull",
    producer: "sync:fansly:followers",
    platform: "fansly",
    accountId: pageId,
    kind: "followers",
    payload: { followers: [] },
    payloadHash: sha256("february"),
    idempotencyKey: `${pageId}:followers:february`,
    receivedAt: new Date("2026-02-14T09:00:00Z"),
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
    expect(await parseVersions()).toEqual([0, 0, 0, 0, 0]);
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
    expect(report.canonicalize?.scanned).toBe(5);
    // followers: 2 follows + 2 identities; subscribers: 1; dm: 1 + 1; me: 2.
    // Drafts, not rows: a dry run neither dedupes nor checkpoints.
    expect(report.canonicalize?.appended).toBe(9);
    expect(report.canonicalize?.stamped).toBe(0);
    expect(report.projection).toBeNull();

    expect(await countRows("domain_events")).toBe(0);
    expect(await countRows("fans")).toBe(0);
    expect(await countRows("page_follows")).toBe(0);
    expect(await countRows("daily_followers")).toBe(0);
    expect(await parseVersions()).toEqual([0, 0, 0, 0, 0]);
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
    // 9 drafts, 8 material rows: fan B's identity is witnessed by BOTH the
    // followers page and the conversations page with the same durable profile,
    // so the content-derived key collapses them — one fact, two witnesses.
    // Plus one stream.projection_checkpoint per observation that appended
    // material (5), covering the hidden seq range for SSE clients.
    expect(report.canonicalize).toMatchObject({ scanned: 5, appended: 13, deduped: 1, stamped: 5 });
    expect(await parseVersions()).toEqual([1, 1, 1, 1, 1]);

    const events = await listEventsSince(testDb.db, { accountId: pageId, afterSeq: 0 });
    expect(events.map((event) => event.type).sort()).toEqual([
      "conversation.observed",
      "fan.identity_observed",
      "fan.identity_observed",
      "follow.observed",
      "follow.observed",
      "page.identity_observed",
      "page.identity_observed",
      "stream.projection_checkpoint",
      "stream.projection_checkpoint",
      "stream.projection_checkpoint",
      "stream.projection_checkpoint",
      "stream.projection_checkpoint",
      "subscription.observed",
    ]);
    // Nothing but the checkpoints is deliverable: a reconnecting SSE client
    // must not be handed a year of backfill as news.
    const deliverable = await listEventsSince(testDb.db, {
      accountId: pageId,
      afterSeq: 0,
      excludeProjectionOnly: true,
    });
    expect(new Set(deliverable.map((event) => event.type)))
      .toEqual(new Set(["stream.projection_checkpoint"]));

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
    expect(follows.rows[0]!.followed_at.toISOString()).toBe(FIRST_FOLLOWED_AT);

    const daily = await testDb.pool.query<{ business_date: string; new_followers: number; known_total_followers: number | null }>(
      "select business_date::text as business_date, new_followers, known_total_followers from daily_followers order by business_date",
    );
    // Review round 1 (P2-a): the earlier pin here asserted a
    // `new_followers = 0` row for the account_me-only day — that WAS the bug.
    // `new_followers` is NOT NULL and reporting SUMS it, so "we do not know"
    // must be an absent row, never a zero. `known_total_followers` is filled
    // only where a row legitimately exists; the 2026-03-10 snapshot has no
    // follows that day and therefore mints nothing.
    expect(daily.rows).toEqual([
      { business_date: FOLLOW_DAY, new_followers: 2, known_total_followers: 470 },
    ]);

    // Review round 1 (P2-c): page_fans is the workboard's candidate set, so a
    // replay never CREATES a row there — thousands of year-old fans on the
    // owner's live board is not this slice's business. The audience floors
    // read page_follows, which is populated above.
    expect(await countRows("page_fans")).toBe(0);

    // The report shows the planes reaching back toward the journal.
    const before = report.floors.before[0]!;
    const after = report.floors.after[0]!;
    expect(before.fansEarliestFirstSeenAt).toBeNull();
    expect(before.pageFollowsEarliestFollowedAt).toBeNull();
    expect(after.journalEarliestReceivedAt).toBe(RECEIVED_AT.toISOString());
    expect(after.fansEarliestFirstSeenAt).toBe(OBSERVED_AT.toISOString());
    expect(after.pageFollowsEarliestFollowedAt).toBe(FIRST_FOLLOWED_AT);
    expect(after.dailyFollowersEarliestDate).toBe(FOLLOW_DAY);
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
      accountIds: [pageId],
      belowParseVersion: 99,
    });
    // 9 material drafts all dedupe; the checkpoints are not even attempted,
    // since nothing new was appended for any observation.
    expect(forced).toMatchObject({ scanned: 5, appended: 0, deduped: 9 });

    // And a re-observed journal page (fresh observation, identical content)
    // dedupes too — the keys are content-derived, not observation-derived.
    await seedJournal(pageId, 2);
    const third = await runFanslyReplay(appStub("on"));
    expect(third.canonicalize).toMatchObject({ scanned: 5, appended: 0, deduped: 9 });
    expect(await snapshot()).toEqual(before);
  });

  it("refuses outright when a journal partition covering the window is detached", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await seedPage();
    await seedJournal(pageId);
    await seedFebruaryObservation(pageId);

    await testDb.pool.query("alter table observations detach partition observations_2026_02");
    try {
      const report = await runFanslyReplay(appStub("on"));
      expect(report.refused).toBe(true);
      expect(report.preflight.ok).toBe(false);
      expect(report.preflight.detachedPartitions.map((partition) => partition.name))
        .toEqual(["observations_2026_02"]);
      expect(report.preflight.detachedPartitions[0]!.rowCount).toBe(1);
      // Refusal is total: no canonicalization, no projection, no writes.
      expect(report.canonicalize).toBeNull();
      expect(report.projection).toBeNull();
      expect(await countRows("domain_events")).toBe(0);
      // Five, not six: the February row is inside the detached partition and
      // is therefore invisible to a plain `select from observations` — which
      // is precisely the invisibility the preflight exists to catch.
      expect(await parseVersions()).toEqual([0, 0, 0, 0, 0]);

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
    await seedFebruaryObservation(pageId);

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
    expect(row.follower_since.toISOString()).toBe(FIRST_FOLLOWED_AT);
    // Still exactly one follow row for that relation — insert-only.
    expect(await countRows("page_follows", "platform_follow_id = '885754550978359296'")).toBe(1);
  });

  // ── review round 1 regressions ───────────────────────────────────────────

  it("P1-1: never stamps an OnlyFans observation of the shared dm_conversations kind", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const fanslyPageId = await seedPage();
    await seedJournal(fanslyPageId);

    const model = await createModel(testDb.db, { slug: "ofmodel", name: "OF Model" });
    const ofPage = await createOnlyFansPage(testDb.db, { modelId: model!.id, label: "of-1" });
    const ofPageId = ofPage!.id;
    // The OFAPI DM sync journals this kind under the same name with a totally
    // different shape (services/sync/ofapi-dm-sync.ts).
    await insertObservation(testDb.db, {
      source: "pull",
      producer: "sync:onlyfans:dm_conversations",
      platform: "onlyfans",
      accountId: ofPageId,
      kind: "dm_conversations",
      payload: { list: [{ id: "of-chat-1" }] },
      payloadHash: sha256("of-dm"),
      idempotencyKey: `${ofPageId}:dm_conversations:1`,
      receivedAt: RECEIVED_AT,
    });

    await runFanslyReplay(appStub("on"));

    // The Fansly parser returns [] for this row, but the driver stamps
    // parse_version even when a canonicalizer produced nothing — so an
    // unscoped run would mark it consumed by version 1 and a future OnlyFans
    // canonicalizer at that version would never see it again.
    const stamped = await testDb.pool.query<{ parse_version: number }>(
      "select parse_version from observations where platform = 'onlyfans'",
    );
    expect(stamped.rows).toEqual([{ parse_version: 0 }]);
    expect(await countRows("domain_events", `account_id = ${ofPageId}`)).toBe(0);
  });

  it("P1-2: historical known_total_followers survives the live hourly rebuild", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await seedPage();
    await seedJournal(pageId);
    await runFanslyReplay(appStub("on"));

    const knownTotal = async () => {
      const rows = await testDb!.pool.query<{ known_total_followers: number | null }>(
        "select known_total_followers from daily_followers where platform_account_id = $1 and business_date = $2",
        [pageId, FOLLOW_DAY],
      );
      return rows.rows[0]?.known_total_followers ?? null;
    };
    expect(await knownTotal()).toBe(470);

    // The live followers sync runs hourly: it DELETEs the page's rows and
    // rebuilds them from page_follows, leaving known_total_followers NULL for
    // every day but today.
    await rebuildFollowerRollups(testDb.db, pageId, null);
    expect(await knownTotal()).toBeNull();

    // A second replay finds no new events at all — the watermark is already at
    // the head. The refresh must still run, or the floors this slice
    // advertises quietly evaporate at the first live rebuild.
    const second = await runFanslyReplay(appStub("on"));
    expect(second.canonicalize).toMatchObject({ scanned: 0, appended: 0 });
    expect(second.projection).toMatchObject({ eventsSeen: 0 });
    expect(await knownTotal()).toBe(470);
  });

  it("P1-3: refuses on a detached domain_events partition, regardless of window", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await seedPage();
    await seedJournal(pageId);

    // Stage 28 tiers the two ledgers INDEPENDENTLY, so this state is reachable
    // with `observations` fully attached — and an observations-only census
    // sails straight through it.
    await appendDomainEvents(testDb.db, pageId, [{
      type: "follow.observed",
      occurredAt: new Date("2026-02-14T10:00:00Z"),
      data: { platformUserId: FAN_A, followId: "seed" },
      schemaVersion: 1,
      observationId: 1,
      dedupKey: "seed:february",
    }]);
    await testDb.pool.query("alter table domain_events detach partition domain_events_2026_02");
    try {
      const report = await runFanslyReplay(appStub("on"));
      expect(report.refused).toBe(true);
      expect(report.preflight.detachedPartitions.map((partition) => partition.name))
        .toEqual(["domain_events_2026_02"]);
      // Nothing was canonicalized, stamped or projected.
      expect(report.canonicalize).toBeNull();
      expect(report.projection).toBeNull();
      expect(await parseVersions()).toEqual([0, 0, 0, 0, 0]);

      // The projection walks each account from its watermark with NO window,
      // so unlike an observations partition this one is never excused by a
      // narrow request window.
      const narrowed = await runFanslyReplay(appStub("on"), {
        from: new Date("2026-03-01T00:00:00Z"),
        to: new Date("2026-04-01T00:00:00Z"),
      });
      expect(narrowed.refused).toBe(true);
    } finally {
      await testDb.pool.query("truncate table domain_events_2026_02");
      await testDb.pool.query(
        "alter table domain_events attach partition domain_events_2026_02 for values from ('2026-02-01') to ('2026-03-01')",
      );
    }
  });

  it("P1-3b: the empty partitions migration 0077 leaves detached are NOT offenders", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await seedPage();
    await seedJournal(pageId);

    // 0077 detaches every domain_events_202[45]_MM and re-covers the range
    // with yearly partitions. That is the healthy production schema; a census
    // that refused on it would refuse forever.
    const leftovers = await testDb.pool.query<{ n: string }>(`
      select count(*)::text as n
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname ~ '^domain_events_202[45]_[0-9]{2}$'
        and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)
    `);
    expect(Number(leftovers.rows[0]!.n)).toBeGreaterThan(0);

    const report = await runFanslyReplay(appStub("on"));
    expect(report.refused).toBe(false);
    expect(report.preflight.detachedPartitions).toEqual([]);
  });

  it("P1-4: refuses uninterpretable vendor timestamps instead of writing a 1970 floor", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await seedPage();
    const common = {
      source: "pull" as const,
      platform: "fansly" as const,
      accountId: pageId,
      observedAt: OBSERVED_AT,
      receivedAt: RECEIVED_AT,
    };
    // `createdAt: 0` is live payload content; a seconds-valued createdAt is
    // the other half of the mix Fansly actually sends.
    await insertObservation(testDb.db, {
      ...common,
      producer: "sync:fansly:subscribers",
      kind: "subscribers",
      payload: {
        subscriptions: [
          { id: "sub-zero", subscriberId: FAN_A, status: 3, price: 1, createdAt: 0 },
          { id: "sub-seconds", subscriberId: FAN_B, status: 3, price: 1, createdAt: 1_772_157_317 },
        ],
      },
      payloadHash: sha256("subs-ts"),
      idempotencyKey: `${pageId}:subscribers:ts`,
    });
    // Follow id "1" carries no timestamp at all: decoding it yields the raw
    // platform epoch, which is not a follow moment anyone observed.
    await insertObservation(testDb.db, {
      ...common,
      producer: "sync:fansly:followers",
      kind: "followers",
      payload: { followers: [{ id: "1", followerId: FAN_A }] },
      payloadHash: sha256("follows-ts"),
      idempotencyKey: `${pageId}:followers:ts`,
    });
    // A live page_fans row so the "since" backfill has somewhere to land.
    await testDb.pool.query(
      `insert into fans (platform, platform_user_id, first_seen_at, last_seen_at)
       values ('fansly', $1, now(), now()), ('fansly', $2, now(), now())`,
      [FAN_A, FAN_B],
    );
    await testDb.pool.query(
      `insert into page_fans (fan_id, platform_account_id) select id, $1 from fans`,
      [pageId],
    );

    await runFanslyReplay(appStub("on"));

    const membership = await testDb.pool.query<{
      platform_user_id: string;
      subscriber_since: Date | null;
      follower_since: Date | null;
    }>(
      `select f.platform_user_id, pf.subscriber_since, pf.follower_since
       from page_fans pf join fans f on f.id = pf.fan_id
       order by f.platform_user_id`,
      [],
    );
    const byUser = new Map(membership.rows.map((row) => [row.platform_user_id, row]));
    // Refused, not defaulted: unknown stays unknown. `least()` folds these
    // only earlier, so a 1970 written once could never be repaired.
    expect(byUser.get(FAN_A)!.subscriber_since).toBeNull();
    expect(byUser.get(FAN_A)!.follower_since).toBeNull();
    // The seconds-valued twin is read correctly rather than as 1970.
    expect(byUser.get(FAN_B)!.subscriber_since?.toISOString()).toBe("2026-02-27T01:55:17.000Z");

    // The undatable follow contributes no page_follows row and therefore no
    // daily_followers day — the audience floor is not moved by a guess.
    expect(await countRows("page_follows")).toBe(0);
    expect(await countRows("daily_followers")).toBe(0);
    const oldest = await testDb.pool.query<{ oldest: Date | null }>(
      "select min(subscriber_since) as oldest from page_fans",
    );
    expect(oldest.rows[0]!.oldest?.getUTCFullYear()).toBe(2026);
  });
});
