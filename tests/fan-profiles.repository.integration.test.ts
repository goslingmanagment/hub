import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendFanProfile,
  createFanslyPage,
  createModel,
  getFanProfileVersion,
  getLatestFanProfile,
  getLatestFanProfileForConversation,
  getLatestPromptEligibleFanProfile,
  insertAiGenerationContent,
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

  it("dedupes identical bodies and rejects stale sourced writes atomically (#136)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createProfilePage(testDb, "fan-profile-atomic");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-profile-002",
      username: "fan_profile_002",
      displayName: "Fan Profile 002",
    }]);
    if (!page || !fan) {
      throw new Error("test setup: page/fan creation failed");
    }
    const base = { fanId: fan.id, platformAccountId: page.id, source: "chatmuse" };

    const first = await appendFanProfile(testDb.db, {
      ...base,
      body: "## Sourced v1",
      sourceGeneratedAt: new Date("2026-07-01T00:00:00Z"),
    });
    expect(first?.version).toBe(1);

    // Identical body (lost-ack re-push) — no duplicate version, even with an
    // older source stamp.
    const duplicate = await appendFanProfile(testDb.db, {
      ...base,
      body: "## Sourced v1",
      sourceGeneratedAt: new Date("2026-06-01T00:00:00Z"),
    });
    expect(duplicate?.version).toBe(1);

    // A DIFFERENT body whose source time is not newer than the stored latest
    // never supersedes it (another device re-scanned meanwhile).
    const stale = await appendFanProfile(testDb.db, {
      ...base,
      body: "## Stale scan from an offline device",
      sourceGeneratedAt: new Date("2026-06-15T00:00:00Z"),
    });
    expect(stale?.version).toBe(1);
    expect(stale?.body).toBe("## Sourced v1");

    // A genuinely newer source appends.
    const newer = await appendFanProfile(testDb.db, {
      ...base,
      body: "## Sourced v2",
      sourceGeneratedAt: new Date("2026-07-02T00:00:00Z"),
    });
    expect(newer?.version).toBe(2);

    // Legacy writes without a source time keep the historical append
    // semantics (old clients must not lose their pushes).
    const legacy = await appendFanProfile(testDb.db, {
      ...base,
      body: "## Legacy write",
    });
    expect(legacy?.version).toBe(3);

    // Against a legacy latest, ordering falls back to its APPEND time — a
    // sourced write from before that moment is stale.
    const staleVsLegacy = await appendFanProfile(testDb.db, {
      ...base,
      body: "## Old scan racing a legacy row",
      sourceGeneratedAt: new Date("2026-07-01T00:00:00Z"),
    });
    expect(staleVsLegacy?.version).toBe(3);
    expect(staleVsLegacy?.body).toBe("## Legacy write");

    const latest = await getLatestFanProfile(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
    });
    expect(latest?.version).toBe(3);
  });

  it("admits only dossiers proven by a usable full fan-summary terminal record", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await createProfilePage(testDb, "fan-profile-proof");
    const [fan] = await upsertFans(testDb.db, [{
      platform: "fansly",
      platformUserId: "fan-profile-proof-001",
      username: "fan_profile_proof_001",
      displayName: "Fan Profile Proof 001",
    }]);
    if (!page || !fan) {
      throw new Error("test setup: page/fan creation failed");
    }
    const base = { fanId: fan.id, platformAccountId: page.id, source: "chatmuse" };
    const versionOne = await appendFanProfile(testDb.db, {
      ...base,
      body: "trusted older dossier",
    });
    const versionTwo = await appendFanProfile(testDb.db, {
      ...base,
      body: "untrusted newer dossier",
    });
    if (!versionOne || !versionTwo) {
      throw new Error("test setup: profile creation failed");
    }
    expect(versionOne.version).toBe(1);
    expect(versionTwo.version).toBe(2);

    const insertProof = async (input: {
      ref: string;
      body: string;
      mode?: "full" | "short";
      outcome?: string;
      stopReason?: string | null;
      fanRef?: string | null;
      conversationRef?: string | null;
      createdAt: Date;
    }) => {
      await insertAiGenerationContent(testDb!.db, {
        usageEventId: null,
        generationRef: input.ref,
        feature: "fan-summary",
        model: "test-model",
        provider: "anthropic",
        userId: null,
        pageId: page.id,
        conversationRef: input.conversationRef ?? "conversation-proof",
        fanRef: input.fanRef === undefined ? fan.platformUserId : input.fanRef,
        promptBlocks: [],
        completion: input.body,
        params: {
          summaryMode: input.mode ?? "full",
          outcome: input.outcome ?? "completed",
          stopReason: input.stopReason === undefined ? "end_turn" : input.stopReason,
        },
      });
      await testDb!.pool.query(
        "update ai_generation_content set created_at = $1 where generation_ref = $2",
        [input.createdAt.toISOString(), input.ref],
      );
    };

    const proofTime = new Date("2026-06-01T12:00:00.000Z");
    await insertProof({
      ref: "profile-proof-v1",
      body: versionOne.body,
      createdAt: proofTime,
    });
    await insertProof({
      ref: "profile-proof-v2-exhausted",
      body: versionTwo.body,
      stopReason: "max_tokens",
      createdAt: new Date("2026-06-02T12:00:00.000Z"),
    });

    const olderTrusted = await getLatestPromptEligibleFanProfile(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      platformUserId: fan.platformUserId,
    });
    expect(olderTrusted).toMatchObject({
      version: 1,
      body: versionOne.body,
      proofCreatedAt: proofTime,
    });

    // OnlyFans/desktop and legacy Fansly terminal rows identify the fan through
    // conversationRef when no separate fan_ref is present.
    await insertProof({
      ref: "profile-proof-v2-legacy-identity",
      body: versionTwo.body,
      fanRef: null,
      conversationRef: fan.platformUserId,
      createdAt: new Date("2026-06-03T12:00:00.000Z"),
    });
    const newestTrusted = await getLatestPromptEligibleFanProfile(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      platformUserId: fan.platformUserId,
    });
    expect(newestTrusted).toMatchObject({ version: 2, body: versionTwo.body });

    const whitespaceOnly = await appendFanProfile(testDb.db, {
      ...base,
      body: "\u00a0\u2003",
    });
    if (!whitespaceOnly) {
      throw new Error("test setup: Unicode-whitespace profile creation failed");
    }
    await insertProof({
      ref: "profile-proof-v3-unicode-whitespace",
      body: whitespaceOnly.body,
      createdAt: new Date("2026-06-04T12:00:00.000Z"),
    });
    const afterWhitespaceOnly = await getLatestPromptEligibleFanProfile(testDb.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      platformUserId: fan.platformUserId,
    });
    expect(afterWhitespaceOnly).toMatchObject({ version: 2, body: versionTwo.body });
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
