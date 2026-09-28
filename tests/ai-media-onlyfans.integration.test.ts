import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  setPageOfapiAccountId,
  upsertAiMediaDescriptionCandidate,
  upsertOfapiMediaLocators,
  type AiMediaDescriptionRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { recordOnlyFansMediaCandidates } from "../apps/runtime/src/services/ai-media-describe/onlyfans-candidates.ts";
import { onlyfansAiMediaSource } from "../apps/runtime/src/services/ai-media-describe/onlyfans-source.ts";
import { ofapiMediaLocatorsFromWebhook } from "../apps/runtime/src/services/ofapi-media-locators.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  MEDIA_ACCOUNT,
  MEDIA_FAN_ID,
  expiresSignedUrl,
  fansapiCacheUrl,
  lockedMedia,
  photoMedia,
  policySignedUrl,
  syntheticMessagesReceived,
  videoMedia,
} from "./helpers/ofapi-media-fixtures.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// AI media describer — the OnlyFans source (H4): free sources only (webhook
// Expires URLs, OFAPI cache hand-outs), ZERO OFAPI calls, fan media and PPV
// teasers as candidates, never a PPV body.

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
const SINCE = new Date(Date.now() - 24 * 3600_000).toISOString();
const MESSAGE_AT = new Date(Date.now() - 3600_000).toISOString();
const FRESH = new Date(Date.now() + 20 * 3600_000);

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
  app = createTestAppContext(testDb);
  Object.assign(app.config, {
    aiMediaDescribeEnabled: true,
    aiMediaDescribePagePolicies: JSON.stringify({ "of-vision": { since: SINCE } }),
    aiMediaDescribeLiveChatOnly: false,
    aiMediaDescribeModelMedia: "teasers",
  });
  const model = await createModel(app.db, { slug: "ofv", name: "Ofv" });
  const page = await createOnlyFansPage(app.db, { modelId: model!.id, label: "of-vision" });
  pageId = page!.id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: MEDIA_ACCOUNT });
});

function row(overrides: Partial<AiMediaDescriptionRow>): AiMediaDescriptionRow {
  return {
    id: 1, pageId, platform: "onlyfans", mediaRef: "1", variant: "full", mediaKind: "photo", senderRole: "fan",
    fanPlatformUserId: String(MEDIA_FAN_ID), status: "pending", description: null, sourceObservationId: 1,
    contentSha256: null, attempts: 1, firstMessageAt: new Date(MESSAGE_AT), nextAttemptAt: new Date(), leaseToken: null, ...overrides,
  };
}

async function recordWebhook(media: unknown[], extra: Record<string, unknown> = {}, event = "messages.received") {
  const envelope = syntheticMessagesReceived({ media });
  const withTime = { ...envelope, event, payload: { ...envelope.payload, createdAt: MESSAGE_AT, ...extra } };
  await upsertOfapiMediaLocators(app.db, ofapiMediaLocatorsFromWebhook(withTime, { pageId, observedAt: new Date() }));
  return recordOnlyFansMediaCandidates(app, { envelope: withTime, pageId, observedAt: new Date(), eventId: 77 });
}

describe("OnlyFans source (free only, zero OFAPI calls)", () => {
  it("uses a fresh webhook Expires URL, preferring the mid-size preview", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in the source"));
    try {
      await recordWebhook([photoMedia(4000001, expiresSignedUrl, FRESH)]);
      const resolved = await onlyfansAiMediaSource.resolve(app, row({ mediaRef: "4000001" }), { now: new Date(), modelMedia: "teasers" });
      expect(resolved).toMatchObject({ kind: "url", source: "ofapi_expires" });
      expect(resolved.kind === "url" && resolved.url).toContain("480x640_syn4000001");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("ignores address-bound Policy URLs and waits (1, 5, 30 min) for a free one", async () => {
    await upsertOfapiMediaLocators(app.db, ofapiMediaLocatorsFromWebhook(
      { ...syntheticMessagesReceived({ media: [photoMedia(4000002, policySignedUrl, FRESH)] }) },
      { pageId, observedAt: new Date() },
    ));
    const now = new Date();
    const first = await onlyfansAiMediaSource.resolve(app, row({ mediaRef: "4000002", attempts: 1 }), { now, modelMedia: "teasers" });
    expect(first).toMatchObject({ kind: "awaiting_source", reason: "no_free_url" });
    expect(first.kind === "awaiting_source" && first.retryAt!.getTime() - now.getTime()).toBe(60_000);
    const third = await onlyfansAiMediaSource.resolve(app, row({ mediaRef: "4000002", attempts: 3 }), { now, modelMedia: "teasers" });
    expect(third.kind === "awaiting_source" && third.retryAt!.getTime() - now.getTime()).toBe(30 * 60_000);
  });

  it("takes an OFAPI cache hand-out persisted by the desktop resolve", async () => {
    await upsertOfapiMediaLocators(app.db, [{
      ofapiAccountId: MEDIA_ACCOUNT, mediaId: "4000003", variant: "full", source: "resolve", pageId,
      url: fansapiCacheUrl("a/aa/syn4000003/960x1280_syn4000003.jpg", new Date(), 3600), pathSha256: null,
      sigKind: "fansapi", expiresAt: new Date(Date.now() + 3600_000), mediaType: "photo", fileExt: "jpg",
      chatId: String(MEDIA_FAN_ID), messageId: "1", vaultMedia: false, canView: true, isReady: true, observedAt: new Date(),
    }]);
    await expect(onlyfansAiMediaSource.resolve(app, row({ mediaRef: "4000003" }), { now: new Date(), modelMedia: "teasers" }))
      .resolves.toMatchObject({ kind: "url", source: "ofapi_fansapi" });
  });

  it("uses a video's poster and never describes a locked body", async () => {
    await recordWebhook([videoMedia(4000004, expiresSignedUrl, FRESH), lockedMedia(4000005)]);
    const poster = await onlyfansAiMediaSource.resolve(app, row({ mediaRef: "4000004", variant: "poster", mediaKind: "video" }), { now: new Date(), modelMedia: "teasers" });
    expect(poster.kind === "url" && poster.url).toContain("480x848_syn4000004");
    await expect(onlyfansAiMediaSource.resolve(app, row({ mediaRef: "4000005", senderRole: "model" }), { now: new Date(), modelMedia: "teasers+free" }))
      .resolves.toMatchObject({ kind: "skip", reason: "locked" });
  });
});

describe("OnlyFans source arrival", () => {
  it("a file waiting for a source becomes due the moment a free URL is recorded", async () => {
    const waiting = await upsertAiMediaDescriptionCandidate(app.db, {
      pageId, platform: "onlyfans", mediaRef: "4000009", variant: "full", mediaKind: "photo", senderRole: "fan",
      fanPlatformUserId: String(MEDIA_FAN_ID), status: "awaiting_source", sourceObservationId: null,
      link: { messageRef: "m-9", conversationRef: String(MEDIA_FAN_ID), fanPlatformUserId: String(MEDIA_FAN_ID), senderRole: "fan", messageAt: new Date(MESSAGE_AT) },
      observedAt: new Date(),
    });
    expect(waiting.status).toBe("applied");
    const before = await testDb!.pool.query(`select status from ai_media_descriptions where media_ref = '4000009'`);
    expect(before.rows[0].status).toBe("awaiting_source");
    // An address-bound URL is not a source: still waiting.
    await upsertOfapiMediaLocators(app.db, ofapiMediaLocatorsFromWebhook(
      { ...syntheticMessagesReceived({ media: [photoMedia(4000009, policySignedUrl, FRESH)] }) },
      { pageId, observedAt: new Date() },
    ));
    expect((await testDb!.pool.query(`select status from ai_media_descriptions where media_ref = '4000009'`)).rows[0].status).toBe("awaiting_source");
    // A free Expires URL: due now.
    await upsertOfapiMediaLocators(app.db, ofapiMediaLocatorsFromWebhook(
      { ...syntheticMessagesReceived({ media: [photoMedia(4000009, expiresSignedUrl, FRESH)] }) },
      { pageId, observedAt: new Date(Date.now() + 1000) },
    ));
    const after = await testDb!.pool.query(`select status, attempts, next_attempt_at <= now() as due from ai_media_descriptions where media_ref = '4000009'`);
    expect(after.rows[0]).toEqual({ status: "pending", attempts: 0, due: true });
  });
});

describe("OnlyFans candidates from webhooks", () => {
  it("writes fan media after the boundary and nothing before it", async () => {
    await recordWebhook([photoMedia(4000010, expiresSignedUrl, FRESH), videoMedia(4000011, expiresSignedUrl, FRESH)]);
    const rows = await testDb!.pool.query(`select media_ref, variant, sender_role, status from ai_media_descriptions order by media_ref`);
    expect(rows.rows).toEqual([
      { media_ref: "4000010", variant: "full", sender_role: "fan", status: "pending" },
      { media_ref: "4000011", variant: "poster", sender_role: "fan", status: "pending" },
    ]);

    const old = syntheticMessagesReceived({ media: [photoMedia(4000012, expiresSignedUrl, FRESH)], messageId: 2000999 });
    await recordOnlyFansMediaCandidates(app, {
      envelope: { ...old, payload: { ...old.payload, createdAt: new Date(Date.parse(SINCE) - 60_000).toISOString() } },
      pageId, observedAt: new Date(), eventId: 78,
    });
    const after = await testDb!.pool.query(`select count(*)::int as n from ai_media_descriptions where media_ref = '4000012'`);
    expect(after.rows[0].n).toBe(0);
  });

  it("turns a sent PPV's previews into teaser candidates, never its body", async () => {
    const sent = syntheticMessagesReceived({ media: [photoMedia(4000020, expiresSignedUrl, FRESH), photoMedia(4000021, expiresSignedUrl, FRESH)] });
    const envelope = {
      ...sent,
      event: "messages.sent",
      payload: { ...sent.payload, createdAt: MESSAGE_AT, price: 15, previews: [4000020], toUser: { id: MEDIA_FAN_ID } },
    };
    await recordOnlyFansMediaCandidates(app, { envelope, pageId, observedAt: new Date(), eventId: 79 });
    const rows = await testDb!.pool.query(`select media_ref, variant, sender_role, fan_platform_user_id from ai_media_descriptions`);
    expect(rows.rows).toEqual([{ media_ref: "4000020", variant: "preview", sender_role: "model", fan_platform_user_id: null }]);
  });

  it("never takes a locked item or a priced message from a fan as fan media", async () => {
    await expect(recordWebhook([photoMedia(4000040, expiresSignedUrl, FRESH, { canView: false })])).resolves.toBe(0);
    await expect(recordWebhook([photoMedia(4000041, expiresSignedUrl, FRESH)], { price: 12, isFree: false })).resolves.toBe(0);
    const rows = await testDb!.pool.query(`select count(*)::int as n from ai_media_descriptions`);
    expect(rows.rows[0].n).toBe(0);
  });

  it("writes nothing while the page has no policy", async () => {
    app.config.aiMediaDescribePagePolicies = "{}";
    await expect(recordWebhook([photoMedia(4000030, expiresSignedUrl, FRESH)])).resolves.toBe(0);
  });
});
