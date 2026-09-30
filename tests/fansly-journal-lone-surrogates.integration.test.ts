// Production 2026-09-30 00:06:58 UTC (release f865e4f0): lilly-2 stats_snapshot
// run 883014 failed with "Error while inserting Fansly discovery_feed raw
// payload (22P02)" — Postgres: "invalid input syntax for type json. Unicode low
// surrogate must follow a high surrogate". A Fansly body carried an UNPAIRED
// UTF-16 surrogate (vendor text, e.g. a creator bio with an emoji cut in half);
// JSON.stringify escapes it as `\udXXX`, and json/jsonb refuse that escape, so
// the chunk failed before anything was journaled or parsed. A deterministic
// body (a DM page holding a fan's broken emoji) would fail every retry.
//
// End to end through the real capture seam (persistRawPayload), the real
// content-addressed catalog, and the DM lane's own journal-then-normalize step.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  refreshPageDmConversationWindow,
  runWithPageSyncExecutionContext,
  startSyncRun,
  updatePageMetadata,
  upsertFans,
  upsertPageDmConversation,
  upsertPageDmMessages,
  verifyCapturePayloadParity,
  type SyncStream,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  getCaptureCasDualWriteCounters,
  publishCaptureCasDualWritePages,
  resetCaptureCasDualWriteForTests,
} from "../apps/runtime/src/services/capture-cas-dual-write.ts";
import { buildFanslyMetadata } from "../apps/runtime/src/services/fansly.ts";
import { createFanslyLaneJournal } from "../apps/runtime/src/services/sync/fansly-lane.ts";
import { fetchAndJournalFanslyDmMessagePage } from "../apps/runtime/src/services/sync/fansly-dm-messages.ts";
import { retentionDate } from "../apps/runtime/src/services/sync/shared.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;
let pageId = 0;

// A truncated emoji: the high half of U+1F60A without its low half, and the
// low half of U+1F44B without its high half. Real, paired emoji ride along to
// prove they are never touched.
const LONE_HIGH = "\ud83d";
const LONE_LOW = "\udc4b";
const BIO = `night owl, dm me ${LONE_HIGH}`;
const CAPTION = `${LONE_LOW} hi there 😊`;
const FAN_TEXT = `you're so cute ${LONE_HIGH}`;
const REPLACEMENT = "�";

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  resetCaptureCasDualWriteForTests();
  await testDb?.stop();
});

beforeEach(async (context) => {
  resetCaptureCasDualWriteForTests();
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  const model = await createModel(testDb.db, { slug: "lone-surrogates", name: "Lone Surrogates" });
  const page = await createFanslyPage(testDb.db, { modelId: model!.id, label: "lone-surrogates" });
  pageId = page!.id;
  // The catalog copy must keep working on the sanitized body: with the canary
  // on, both envelopes should carry a reference.
  publishCaptureCasDualWritePages(String(pageId));
});

async function inRun<T>(stream: SyncStream, run: (syncRunId: number) => Promise<T>) {
  const syncRun = await startSyncRun(testDb!.db, { platformAccountId: pageId, stream, trigger: "scheduled" });
  return runWithPageSyncExecutionContext(
    { pageId, stream, requestSeq: 1, leaseToken: "lone-surrogates" },
    () => run(syncRun!.id),
  );
}

async function rows<T extends Record<string, unknown>>(sql: string) {
  return (await testDb!.pool.query<T>(sql)).rows;
}

async function notes() {
  return rows<{ severity: string; stream: string; details: Record<string, unknown> }>(
    "select severity::text as severity, stream::text as stream, details from sync_run_events where event_type = 'note' order by id",
  );
}

function discoveryFeed() {
  return {
    mediaOfferSuggestions: [{ id: "950000000000000001", accountId: "700000000000000002", price: 0 }],
    aggregationData: {
      accounts: [{ id: "700000000000000002", username: "someone", about: BIO }],
      accountMedia: [{
        id: "800000000000000001",
        caption: CAPTION,
        media: {
          id: "800000000000000002",
          locations: [{
            locationId: "1",
            location: "https://cdn3.fansly.com/700000000000000002/800000000000000002.jpeg"
              + "?ngsw-bypass=true&Expires=1790000000&Key-Pair-Id=KTESTPAIR01&Signature=abc~DEF_1",
          }],
        },
      }],
    },
  };
}

describe("a Fansly body with unpaired surrogates is journaled, not refused", () => {
  it("discovery_feed (a CDN-stripped kind): both copies and the catalog hold U+FFFD", async () => {
    const served = discoveryFeed();
    const snapshot = JSON.stringify(served);

    const captured = await inRun("stats_snapshot", async (syncRunId) => {
      const persist = createFanslyLaneJournal({
        db: testDb!.db,
        pageId,
        syncRunId,
        mapperVersion: "fansly-stats-v1",
        payloadKind: "mapping_critical",
        retainUntil: retentionDate(),
      });
      return persist("discovery_feed", { page: 0, limit: 25, offset: 0, sampling: "sampled" }, served);
    });

    // The lane keeps parsing its in-memory response: it is never rewritten.
    expect(JSON.stringify(served)).toBe(snapshot);
    expect(served.aggregationData.accounts[0]!.about).toBe(BIO);

    type Feed = ReturnType<typeof discoveryFeed>;
    const [raw] = await rows<{ mapper_version: string; body: Feed; object_id: string | null }>(
      "select mapper_version, response_payload as body, payload_object_id::text as object_id from sync_raw_payloads",
    );
    const [observation] = await rows<{ id: string; body: Feed; object_id: string | null }>(
      "select id::text as id, payload as body, payload_object_id::text as object_id from observations where kind = 'discovery_feed'",
    );
    const [stored] = await rows<{ body: Feed }>("select body from capture_json_hot_bodies");
    expect(raw!.mapper_version).toBe("fansly-stats-v1+cdn-tokens-stripped-v1+lone-surrogates-replaced-v1");
    for (const body of [raw!.body, observation!.body, stored!.body]) {
      expect(body.aggregationData.accounts[0]!.about).toBe(`night owl, dm me ${REPLACEMENT}`);
      expect(body.aggregationData.accountMedia[0]!.caption).toBe(`${REPLACEMENT} hi there 😊`);
      // The CDN strip still applied, on the same body.
      expect(JSON.stringify(body)).not.toMatch(/Signature|Key-Pair-Id|Expires/);
    }
    expect(Number(observation!.id)).toBe(captured.observationId);

    // The catalog copy succeeded on the sanitized body, so dedup and the
    // pointer-only path keep working, and the parity job sees two faithful
    // envelopes.
    expect(raw!.object_id).not.toBeNull();
    expect(observation!.object_id).toBe(raw!.object_id);
    expect(getCaptureCasDualWriteCounters()).toMatchObject({ stored: 1, failed: 0, codecRefused: 0 });
    expect(await verifyCapturePayloadParity(testDb!.db)).toMatchObject({ checked: 2, matched: 2, mismatched: 0 });

    // Recorded as an info note with the count — never a warning.
    expect(await notes()).toEqual([{
      severity: "info",
      stream: "stats_snapshot",
      details: {
        code: "journal_lone_surrogates_replaced",
        endpoint: "discovery_feed",
        rawPayloadId: captured.id,
        observationId: captured.observationId,
        rawPayloadReplacements: 2,
        observationReplacements: 2,
      },
    }]);
  });

  it("dm_messages: the page is journaled and its messages still project", async () => {
    const [fan] = await upsertFans(testDb!.db, [{
      platform: "fansly",
      platformUserId: "700000000000000003",
      username: "fan_one",
      displayName: "Fan One",
    }]);
    const conversation = (await upsertPageDmConversation(testDb!.db, {
      platformAccountId: pageId,
      fanId: fan!.id,
      platformConversationId: "920000000000000001",
      partnerPlatformUserId: "700000000000000003",
      partnerUsername: "fan_one",
      partnerDisplayName: "Fan One",
      conversationFlags: 0,
      unreadCount: 1,
      subscriptionTierId: null,
      lastMessageId: "910000000000000002",
      lastUnreadMessageId: "910000000000000002",
      lastMessageAt: new Date(),
      lastMessageSenderId: "700000000000000003",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "",
      isVisible: true,
      lastSeenGeneration: 1,
      metadata: {},
    }))!;
    const createdAt = Math.floor(Date.now() / 1000) - 60;
    const messages = [
      { id: "910000000000000002", groupId: "920000000000000001", senderId: "700000000000000003",
        content: FAN_TEXT, createdAt, attachments: [] },
      { id: "910000000000000001", groupId: "920000000000000001", senderId: "700000000000000001",
        content: CAPTION, createdAt: createdAt - 60, attachments: [] },
    ];
    const raw = { success: true, response: { messages, accountMedia: [], accountMediaBundles: [] } };
    const snapshot = JSON.stringify(raw);
    const app: AppContext = createTestAppContext(testDb!, {
      adapter: {
        getMessagesPage: async () => ({
          items: messages,
          groupId: "920000000000000001",
          before: null,
          done: true,
          contractAccepted: true,
          raw,
        }),
      } as unknown as AppContext["adapter"],
    });

    const outcome = await inRun("dm_messages", (syncRunId) => fetchAndJournalFanslyDmMessagePage(app, {
      requestContext: {} as never,
      telemetry: { addAnomaly: async () => {} } as never,
      syncRunId,
      platformAccountId: pageId,
      platform: "fansly",
      pageAccountId: "700000000000000001",
      conversation: {
        id: conversation.id,
        platformConversationId: "920000000000000001",
        partnerPlatformUserId: "700000000000000003",
      },
      before: null,
    }));
    expect(JSON.stringify(raw)).toBe(snapshot);
    // Normalized from the served object, exactly as before.
    expect(outcome.normalizedMessages.map((message) => message.content)).toEqual([FAN_TEXT, CAPTION]);

    type Page = typeof raw;
    const [stored] = await rows<{ mapper_version: string; body: Page; object_id: string | null }>(
      "select mapper_version, response_payload as body, payload_object_id::text as object_id from sync_raw_payloads",
    );
    const [observation] = await rows<{ body: Page }>("select payload as body from observations where kind = 'dm_messages'");
    // dm_messages is never CDN-stripped; only the surrogate marker is added.
    expect(stored!.mapper_version).toBe("fansly-phase1-v5+lone-surrogates-replaced-v1");
    expect(stored!.object_id).not.toBeNull();
    for (const body of [stored!.body, observation!.body]) {
      expect(body.response.messages.map((message) => message.content))
        .toEqual([`you're so cute ${REPLACEMENT}`, `${REPLACEMENT} hi there 😊`]);
    }
    expect(await notes()).toEqual([expect.objectContaining({
      severity: "info",
      stream: "dm_messages",
      details: expect.objectContaining({
        code: "journal_lone_surrogates_replaced",
        endpoint: "dm_messages",
        rawPayloadReplacements: 2,
        observationReplacements: 2,
      }),
    })]);

    // The hot table: `content` is text, which the driver sends as UTF-8, so an
    // unpaired surrogate arrives as U+FFFD and the upsert succeeds.
    await upsertPageDmMessages(testDb!.db, outcome.normalizedMessages);
    await refreshPageDmConversationWindow(testDb!.db, { conversationId: conversation.id });
    const projected = await rows<{ platform_message_id: string; content: string }>(
      "select platform_message_id, content from page_dm_messages order by platform_message_id desc",
    );
    expect(projected).toEqual([
      { platform_message_id: "910000000000000002", content: `you're so cute ${REPLACEMENT}` },
      { platform_message_id: "910000000000000001", content: `${REPLACEMENT} hi there 😊` },
    ]);
  });

  it("account_me walls and tiers reach pages.metadata (jsonb)", async () => {
    const account = {
      id: "700000000000000001",
      username: "lone_model",
      displayName: "Lone Model",
      createdAt: Date.UTC(2024, 0, 1),
      followCount: 10,
      subscriberCount: 2,
      walls: [{ id: "1", pos: 0, name: "Main", description: BIO }],
      subscriptionTiers: [{ id: "2", name: `VIP ${LONE_LOW}`, price: 999 }],
    };
    await updatePageMetadata(testDb!.db, pageId, {
      platformAccountIdValue: account.id,
      username: account.username,
      displayName: account.displayName,
      followerCount: account.followCount,
      subscriberCount: account.subscriberCount,
      earningsBalanceMills: 0n,
      metadata: buildFanslyMetadata(account, {}),
    });
    // The served account object is untouched.
    expect(account.walls[0]!.description).toBe(BIO);

    const [page] = await rows<{ metadata: { walls: Array<{ description: string }>; subscriptionTiers: Array<{ name: string }> } }>(
      `select metadata from pages where id = ${pageId}`,
    );
    expect(page!.metadata.walls[0]!.description).toBe(`night owl, dm me ${REPLACEMENT}`);
    expect(page!.metadata.subscriptionTiers[0]!.name).toBe(`VIP ${REPLACEMENT}`);
  });
});
