import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  listWorkboardAllSpenders,
  listWorkboardActiveSpenders,
  listWorkboardPresence,
  listWorkboardSnoozed,
  listWorkboardSubscribers,
  recalculateFanPageSpend,
  snoozeWorkboardFan,
  unsnoozeWorkboardFan,
  upsertFanPageExternalPresences,
  upsertFanPage,
  upsertFans,
  upsertPageSubscription,
  upsertTransaction,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

async function createWorkboardPage(testDb: StartedTestDatabase, label: string) {
  const model = await createModel(testDb.db, {
    slug: `${label}-model`,
    name: `${label} model`,
  });

  return createFanslyPage(testDb.db, {
    modelId: model.id,
    label,
  });
}

async function seedWorkboardScenario(testDb: StartedTestDatabase, pageId: number) {
  const [
    visibleSubscriber,
    snoozedSubscriber,
    activeSpender,
    inactiveSpender,
    microSpender,
    deletedSubscriber,
    deletedActiveSpender,
    deletedInactiveSpender,
  ] = await upsertFans(testDb.db, [
    {
      platform: "fansly",
      platformUserId: "wb-subscriber-visible",
      username: "wb_subscriber_visible",
      displayName: "WB Subscriber Visible",
    },
    {
      platform: "fansly",
      platformUserId: "wb-subscriber-snoozed",
      username: "wb_subscriber_snoozed",
      displayName: "WB Subscriber Snoozed",
    },
    {
      platform: "fansly",
      platformUserId: "wb-active-spender",
      username: "wb_active_spender",
      displayName: "WB Active Spender",
    },
    {
      platform: "fansly",
      platformUserId: "wb-inactive-spender",
      username: "wb_inactive_spender",
      displayName: "WB Inactive Spender",
    },
    {
      platform: "fansly",
      platformUserId: "wb-micro-spender",
      username: "wb_micro_spender",
      displayName: "WB Micro Spender",
    },
    {
      platform: "fansly",
      platformUserId: "wb-subscriber-deleted",
    },
    {
      platform: "fansly",
      platformUserId: "wb-active-spender-deleted",
    },
    {
      platform: "fansly",
      platformUserId: "wb-inactive-spender-deleted",
    },
  ]);

  for (const [index, fan] of [visibleSubscriber, snoozedSubscriber].entries()) {
    await upsertFanPage(testDb.db, {
      fanId: fan.id,
      platformAccountId: pageId,
      isSubscriber: true,
      subscriberSince: new Date("2026-03-01T12:00:00.000Z"),
      subscriptionExpiresAt: new Date(`2026-03-31T1${index}:00:00.000Z`),
      autoRenew: index === 0,
      pageAlias: index === 0 ? "Subscriber Visible Alias" : "Subscriber Snoozed Alias",
    });
    await upsertPageSubscription(testDb.db, {
      platformSubscriptionId: `wb-sub-${index + 1}`,
      platformAccountId: pageId,
      fanId: fan.id,
      rawStatus: 3,
      canonicalStatus: "active",
      priceMills: 5000n,
      renewPriceMills: 5000n,
      autoRenew: index === 0,
      sourceCreatedAt: new Date("2026-03-01T12:00:00.000Z"),
      endsAt: new Date(`2026-03-31T1${index}:00:00.000Z`),
      subscriptionTierName: "VIP",
    });
  }

  await upsertFanPage(testDb.db, {
    fanId: deletedSubscriber.id,
    platformAccountId: pageId,
    isSubscriber: true,
    subscriberSince: new Date("2026-03-01T12:00:00.000Z"),
    subscriptionExpiresAt: new Date("2026-03-31T12:00:00.000Z"),
    autoRenew: false,
  });
  await upsertPageSubscription(testDb.db, {
    platformSubscriptionId: "wb-sub-deleted",
    platformAccountId: pageId,
    fanId: deletedSubscriber.id,
    rawStatus: 3,
    canonicalStatus: "active",
    priceMills: 5000n,
    renewPriceMills: 5000n,
    autoRenew: false,
    sourceCreatedAt: new Date("2026-03-01T12:00:00.000Z"),
    endsAt: new Date("2026-03-31T12:00:00.000Z"),
    subscriptionTierName: "VIP",
  });

  await upsertFanPage(testDb.db, {
    fanId: activeSpender.id,
    platformAccountId: pageId,
    pageAlias: "Active Spender Alias",
  });
  await upsertFanPage(testDb.db, {
    fanId: inactiveSpender.id,
    platformAccountId: pageId,
    pageAlias: "Inactive Spender Alias",
  });
  await upsertFanPage(testDb.db, {
    fanId: microSpender.id,
    platformAccountId: pageId,
    pageAlias: "Micro Spender Alias",
  });
  await upsertFanPage(testDb.db, {
    fanId: deletedActiveSpender.id,
    platformAccountId: pageId,
  });
  await upsertFanPage(testDb.db, {
    fanId: deletedInactiveSpender.id,
    platformAccountId: pageId,
  });

  await upsertTransaction(testDb.db, {
    platformAccountId: pageId,
    source: "onlymonster",
    fanId: activeSpender.id,
    transactionId: "wb-active-tip",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 125000n,
    sourceDestinationAmountMills: 125000n,
    creatorNetAmountMills: 125000n,
    occurredAt: new Date("2026-03-25T12:00:00.000Z"),
  });
  await upsertTransaction(testDb.db, {
    platformAccountId: pageId,
    source: "onlymonster",
    fanId: inactiveSpender.id,
    transactionId: "wb-inactive-tip",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 140000n,
    sourceDestinationAmountMills: 140000n,
    creatorNetAmountMills: 140000n,
    occurredAt: new Date("2026-02-10T12:00:00.000Z"),
  });
  await upsertTransaction(testDb.db, {
    platformAccountId: pageId,
    source: "onlymonster",
    fanId: deletedActiveSpender.id,
    transactionId: "wb-active-tip-deleted",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 135000n,
    sourceDestinationAmountMills: 135000n,
    creatorNetAmountMills: 135000n,
    occurredAt: new Date("2026-03-23T12:00:00.000Z"),
  });
  await upsertTransaction(testDb.db, {
    platformAccountId: pageId,
    source: "onlymonster",
    fanId: deletedInactiveSpender.id,
    transactionId: "wb-inactive-tip-deleted",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 145000n,
    sourceDestinationAmountMills: 145000n,
    creatorNetAmountMills: 145000n,
    occurredAt: new Date("2026-02-05T12:00:00.000Z"),
  });
  await upsertTransaction(testDb.db, {
    platformAccountId: pageId,
    source: "onlymonster",
    fanId: microSpender.id,
    transactionId: "wb-micro-tip",
    rawType: 20001,
    canonicalType: "tip",
    transactionState: "posted",
    rawStatus: 2,
    grossAmountMills: 100n,
    sourceDestinationAmountMills: 100n,
    creatorNetAmountMills: 100n,
    occurredAt: new Date("2026-03-24T12:00:00.000Z"),
  });

  await recalculateFanPageSpend(testDb.db, pageId);

  return {
    visibleSubscriber,
    snoozedSubscriber,
    activeSpender,
    inactiveSpender,
    microSpender,
    deletedSubscriber,
    deletedActiveSpender,
    deletedInactiveSpender,
  };
}

describe("workboard repository integration", () => {
  let testDb: StartedTestDatabase | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  });

  afterAll(async () => {
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    if (!testDb) {
      return;
    }

    await resetIntegrationDatabase(testDb.pool);
  });

  it("keeps actionable rows visible across all tabs when deleted or snoozed fans exist", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const now = new Date("2026-03-30T12:00:00.000Z");
    const page = await createWorkboardPage(testDb, "workboard-snooze-filter");
    const seeded = await seedWorkboardScenario(testDb, page.id);

    await snoozeWorkboardFan(testDb.db, {
      platformAccountId: page.id,
      fanId: seeded.snoozedSubscriber.id,
      days: 7,
      createdByUserId: null,
    });
    await snoozeWorkboardFan(testDb.db, {
      platformAccountId: page.id,
      fanId: seeded.deletedSubscriber.id,
      days: 30,
      createdByUserId: null,
    });

    const [subscribers, activeSpenders, allSpenders, snoozed] = await Promise.all([
      listWorkboardSubscribers(testDb.db, { platformAccountId: page.id, now }),
      listWorkboardActiveSpenders(testDb.db, { platformAccountId: page.id, now }),
      listWorkboardAllSpenders(testDb.db, { platformAccountId: page.id, now }),
      listWorkboardSnoozed(testDb.db, { platformAccountId: page.id }),
    ]);

    expect(subscribers.map((row) => row.fanId)).toEqual([seeded.visibleSubscriber.id]);
    expect(subscribers[0]?.subscriberSince?.toISOString()).toBe("2026-03-01T12:00:00.000Z");
    expect(subscribers[0]?.pageAlias).toBe("Subscriber Visible Alias");
    expect(activeSpenders.map((row) => row.fanId)).toEqual([
      seeded.deletedActiveSpender.id,
      seeded.activeSpender.id,
    ]);
    expect(activeSpenders[1]?.pageAlias).toBe("Active Spender Alias");
    expect(allSpenders.map((row) => row.fanId)).toEqual([
      seeded.deletedInactiveSpender.id,
      seeded.inactiveSpender.id,
      seeded.deletedActiveSpender.id,
      seeded.activeSpender.id,
      seeded.microSpender.id,
    ]);
    expect(allSpenders[1]?.pageAlias).toBe("Inactive Spender Alias");
    expect(allSpenders[3]?.pageAlias).toBe("Active Spender Alias");
    expect(allSpenders[4]?.pageAlias).toBe("Micro Spender Alias");
    expect(snoozed.map((row) => row.fanId)).toEqual([
      seeded.snoozedSubscriber.id,
      seeded.deletedSubscriber.id,
    ]);
    expect(snoozed[0]?.pageAlias).toBe("Subscriber Snoozed Alias");
  });

  it("restores the queue after unsnoozing a fan", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const now = new Date("2026-03-30T12:00:00.000Z");
    const page = await createWorkboardPage(testDb, "workboard-unsnooze-roundtrip");
    const seeded = await seedWorkboardScenario(testDb, page.id);

    await snoozeWorkboardFan(testDb.db, {
      platformAccountId: page.id,
      fanId: seeded.snoozedSubscriber.id,
      days: 14,
      createdByUserId: null,
    });
    await unsnoozeWorkboardFan(testDb.db, {
      platformAccountId: page.id,
      fanId: seeded.snoozedSubscriber.id,
    });

    const [subscribers, snoozed] = await Promise.all([
      listWorkboardSubscribers(testDb.db, { platformAccountId: page.id, now }),
      listWorkboardSnoozed(testDb.db, { platformAccountId: page.id }),
    ]);

    expect(subscribers.map((row) => row.fanId).sort((left, right) => left - right)).toEqual([
      seeded.visibleSubscriber.id,
      seeded.snoozedSubscriber.id,
      seeded.deletedSubscriber.id,
    ].sort((left, right) => left - right));
    expect(snoozed).toHaveLength(0);
  });

  it("does not snooze or list fans that are not members of the page", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createWorkboardPage(testDb, "workboard-snooze-scope");
    const otherPage = await createWorkboardPage(testDb, "workboard-snooze-other");
    const [otherFan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "wb-snooze-other-fan",
      username: "wb_snooze_other",
      displayName: "WB Snooze Other",
    }]);
    await upsertFanPage(testDb.db, {
      platformAccountId: otherPage.id,
      fanId: otherFan.id,
      isFollower: true,
      isSubscriber: false,
    });

    await expect(snoozeWorkboardFan(testDb.db, {
      platformAccountId: page.id,
      fanId: otherFan.id,
      days: 7,
      createdByUserId: null,
    })).resolves.toBeNull();

    await testDb.pool.query(`
      insert into workboard_snoozes (platform_account_id, fan_id, snoozed_until)
      values ($1, $2, now() + interval '7 days')
    `, [page.id, otherFan.id]);

    await expect(
      listWorkboardSnoozed(testDb.db, { platformAccountId: page.id }),
    ).resolves.toEqual([]);
  });

  it("lists active_now and recently_active buckets from explicit external presence fields", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const now = new Date("2026-03-30T12:00:00.000Z");
    const page = await createWorkboardPage(testDb, "workboard-presence");
    const [activeNowFan, recentlyActiveFan, staleFan] = await upsertFans(testDb.db, [
      {
        platform: "fansly",
        platformUserId: "presence-active-now",
        username: "presence_active_now",
        displayName: "Presence Active Now",
      },
      {
        platform: "fansly",
        platformUserId: "presence-recently-active",
        username: "presence_recently_active",
        displayName: "Presence Recently Active",
      },
      {
        platform: "fansly",
        platformUserId: "presence-stale",
        username: "presence_stale",
        displayName: "Presence Stale",
      },
    ]);

    await upsertFanPage(testDb.db, {
      fanId: activeNowFan.id,
      platformAccountId: page.id,
      isSubscriber: true,
      pageAlias: "Active Now Alias",
    });
    await upsertFanPage(testDb.db, {
      fanId: recentlyActiveFan.id,
      platformAccountId: page.id,
      pageAlias: "Recently Active Alias",
    });
    await upsertFanPage(testDb.db, {
      fanId: staleFan.id,
      platformAccountId: page.id,
      pageAlias: "Stale Alias",
    });

    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      fanId: activeNowFan.id,
      transactionId: "presence-active-now-tip",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 300000n,
      sourceDestinationAmountMills: 300000n,
      creatorNetAmountMills: 300000n,
      occurredAt: new Date("2026-03-30T11:30:00.000Z"),
    });
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "onlymonster",
      fanId: recentlyActiveFan.id,
      transactionId: "presence-recently-active-tip",
      rawType: 20001,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: 100000n,
      sourceDestinationAmountMills: 100000n,
      creatorNetAmountMills: 100000n,
      occurredAt: new Date("2026-03-30T10:00:00.000Z"),
    });
    await recalculateFanPageSpend(testDb.db, page.id);

    await upsertFanPageExternalPresences(testDb.db, [
      {
        fanId: activeNowFan.id,
        platformAccountId: page.id,
        externalPresenceAt: new Date("2026-03-30T11:50:00.000Z"),
        externalPresenceObservedAt: now,
        externalPresenceSource: "fansly_followers_last_seen",
      },
      {
        fanId: recentlyActiveFan.id,
        platformAccountId: page.id,
        externalPresenceAt: new Date("2026-03-30T10:45:00.000Z"),
        externalPresenceObservedAt: now,
        externalPresenceSource: "fansly_followers_last_seen",
      },
      {
        fanId: staleFan.id,
        platformAccountId: page.id,
        externalPresenceAt: new Date("2026-03-30T09:30:00.000Z"),
        externalPresenceObservedAt: now,
        externalPresenceSource: "fansly_followers_last_seen",
      },
    ]);

    const [activeNow, recentlyActive] = await Promise.all([
      listWorkboardPresence(testDb.db, {
        platformAccountId: page.id,
        bucket: "active_now",
        now,
        limit: 20,
      }),
      listWorkboardPresence(testDb.db, {
        platformAccountId: page.id,
        bucket: "recently_active",
        now,
        limit: 20,
      }),
    ]);

    expect(activeNow.total).toBe(1);
    expect(activeNow.items).toMatchObject([{
      fanId: activeNowFan.id,
      pageAlias: "Active Now Alias",
      isSubscriber: true,
      externalPresenceSource: "fansly_followers_last_seen",
    }]);
    expect(activeNow.items[0]?.externalPresenceAt.toISOString()).toBe("2026-03-30T11:50:00.000Z");

    expect(recentlyActive.total).toBe(1);
    expect(recentlyActive.items).toMatchObject([{
      fanId: recentlyActiveFan.id,
      pageAlias: "Recently Active Alias",
      isSubscriber: false,
      externalPresenceSource: "fansly_followers_last_seen",
    }]);
    expect(recentlyActive.items[0]?.externalPresenceAt.toISOString()).toBe("2026-03-30T10:45:00.000Z");
    expect(recentlyActive.items.map((row) => row.fanId)).not.toContain(staleFan.id);
  });
});
