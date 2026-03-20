import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendFanProfile,
  createFanslyPage,
  createModel,
  getFanProfileVersion,
  getLatestFanProfile,
  getLatestFanProfileForConversation,
  listFanProfileVersionSummaries,
  upsertFans,
  upsertPageDmConversation,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

async function createProfilePage(testDb: StartedTestDatabase, label: string) {
  const model = await createModel(testDb.db, {
    slug: `${label}-model`,
    name: `${label} model`,
  });

  return createFanslyPage(testDb.db, {
    modelId: model.id,
    label,
  });
}

describe("fan profile repository integration", () => {
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

  it("appends sequential versions and returns latest plus newest-first history", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createProfilePage(testDb, "fan-profile-seq");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-profile-001",
      username: "fan_profile_001",
      displayName: "Fan Profile 001",
    }]);

    const versionOne = await appendFanProfile(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      body: "## Profile v1\n\nFirst read.",
      source: "chatmuse",
    });
    const versionTwo = await appendFanProfile(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      body: "## Profile v2\n\nSecond read.",
      source: "chatmuse",
    });

    expect(versionOne.version).toBe(1);
    expect(versionTwo.version).toBe(2);

    const latest = await getLatestFanProfile(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
    });
    expect(latest?.version).toBe(2);
    expect(latest?.body).toContain("Second read.");

    const versions = await listFanProfileVersionSummaries(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
    });
    expect(versions.map((row) => row.version)).toEqual([2, 1]);

    const historical = await getFanProfileVersion(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      version: 1,
    });
    expect(historical?.body).toContain("First read.");
  });

  it("resolves the latest profile by visible conversation mapping", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createProfilePage(testDb, "fan-profile-conversation");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-profile-conv",
      username: "fan_profile_conv",
      displayName: "Fan Profile Conv",
    }]);

    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformConversationId: "conversation-visible",
      partnerPlatformUserId: fan.platformUserId,
      partnerUsername: fan.username,
      partnerDisplayName: fan.displayName,
      conversationFlags: 0,
      unreadCount: 0,
      subscriptionTierId: null,
      lastMessageId: "msg-visible",
      lastUnreadMessageId: null,
      lastMessageAt: new Date("2026-03-18T12:00:00.000Z"),
      lastMessageSenderId: fan.platformUserId,
      lastMessageSenderRole: "fan",
      lastMessagePreview: "hello",
      lastFanMessageAt: new Date("2026-03-18T12:00:00.000Z"),
      lastModelMessageAt: null,
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    });
    await upsertPageDmConversation(testDb.db, {
      platformAccountId: page.id,
      fanId: fan.id,
      platformConversationId: "conversation-hidden",
      partnerPlatformUserId: fan.platformUserId,
      partnerUsername: fan.username,
      partnerDisplayName: fan.displayName,
      conversationFlags: 0,
      unreadCount: 0,
      subscriptionTierId: null,
      lastMessageId: "msg-hidden",
      lastUnreadMessageId: null,
      lastMessageAt: new Date("2026-03-18T12:00:00.000Z"),
      lastMessageSenderId: fan.platformUserId,
      lastMessageSenderRole: "fan",
      lastMessagePreview: "hidden",
      lastFanMessageAt: new Date("2026-03-18T12:00:00.000Z"),
      lastModelMessageAt: null,
      isVisible: false,
      lastSeenGeneration: 1,
      metadata: {},
    });

    const beforeProfile = await getLatestFanProfileForConversation(testDb.db, {
      platformAccountId: page.id,
      platformConversationId: "conversation-visible",
    });
    expect(beforeProfile).not.toBeNull();
    expect(beforeProfile?.fan.platformUserId).toBe("fan-profile-conv");
    expect(beforeProfile?.profile).toBeNull();

    await appendFanProfile(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      body: "## Fan Conversation Profile\n\nResolved from conversation.",
      source: "chatmuse",
    });

    const afterProfile = await getLatestFanProfileForConversation(testDb.db, {
      platformAccountId: page.id,
      platformConversationId: "conversation-visible",
    });
    expect(afterProfile?.profile?.version).toBe(1);
    expect(afterProfile?.profile?.body).toContain("Resolved from conversation.");

    const hiddenConversation = await getLatestFanProfileForConversation(testDb.db, {
      platformAccountId: page.id,
      platformConversationId: "conversation-hidden",
    });
    expect(hiddenConversation).toBeNull();
  });
});
