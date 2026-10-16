import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  insertObservation,
  listConversationFeedPage,
  readConversationFeedSnapshot,
  upsertFans,
} from "@agency_hub_core/db";

import { loadTranscriptContext } from "../apps/runtime/src/modules/ai/index.ts";
import { resetCanonicalizeSweepRuntime, runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { loadFeedFanslyCaptions, toClientFeedItem } from "../apps/runtime/src/services/conversation-feed.ts";
import { runMediaPlaneProjection } from "../apps/runtime/src/services/projections/media-plane.ts";
import { runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import { resetIntegrationDatabase, seedFanslyPage, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  FANSLY_DM_PAGE_WITH_MEDIA as DM_PAGE,
  MEDIA_FAN as FAN,
  MEDIA_GROUP as GROUP,
  MEDIA_PAGE_BASE_SECONDS,
  MEDIA_PAGE_REF as PAGE_REF,
} from "./helpers/fansly-dm-page-media.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// chat-extension R20 HF-7a, parity row AI-147 «Медиа окна (Fansly)»: the
// transcript the hub loads itself for a Fansly chat (a request without
// clientContext) shows a message's media as the Fansly extension 2.10.1 shows
// them in the transcript it sends. The reference is the extension's own output
// for the same DM page; the hub's side goes through its real writers:
//
//   REST dm_messages observation → sync-pull (material head + media plane)
//   → archive and media-plane projections → loadTranscriptContext
//
// Predicate of the new behaviour: a Fansly page and the hub-loaded transcript.
// The clientContext lane (the 2.10.1 extension's request) never reads it, and
// OnlyFans keeps its bytes (tests/ai-feature-service.integration.test.ts,
// tests/ai-transcript-exact-ids.integration.test.ts).

/**
 * The Fansly extension 2.10.1 over DM_PAGE (a fabricated DM page with every
 * kind of attachment, helpers/fansly-dm-page-media.ts): `formatTranscriptForKernel(
 * normalizeTranscript([DM_PAGE], PAGE_REF, FAN))`, fansly-chat
 * src/shared/transcript.ts at ff30d00 (2.10.1), run over this very object
 * with TZ=UTC, the hub's clock. No order history was read, so its PPV state
 * is `unknown`.
 */
const OLD_EXTENSION_LINES = [
  "[10:00] Fan: [Photo] look at this",
  "[10:01] Model: [Media Bundle: 2 Photos, 1 Video - PPV $25.00, unknown] for you",
  "[10:02] Model: [Video - PPV $15.00, unknown] unlock me",
  "[10:03] Model: [Video - PPV $20.00, unknown] [Media Bundle: 2 Photos] two things",
  "[10:04] Fan: [Audio]",
  "[10:05] Fan: [Tip: $5.00] for you babe",
  "[10:06] Fan: [Media] can you see it?",
  "[10:07] Model: [Media Bundle] a set",
  "[10:08] Fan: replying to your story",
  "[10:09] Fan: [Photo]",
  "[10:10] Model: [Photo] [Photo] pics",
  "[10:11] Fan: just text",
];

let testDb: StartedTestDatabase;
beforeAll(async () => { testDb = await startTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => {
  await resetIntegrationDatabase(testDb.pool);
  resetCanonicalizeSweepRuntime();
});

async function fixture() {
  const app = createTestAppContext(testDb, { databaseUrl: testDb.connectionString });
  const { page } = await seedFanslyPage(app.db, app.config.encryptionKey);
  if (!page) throw new Error("seed failed");
  await testDb.pool.query("update pages set external_page_id = $2 where id = $1", [page.id, PAGE_REF]);
  await upsertFans(app.db, [{ platform: "fansly", platformUserId: FAN }]);
  await testDb.pool.query(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id)
     values ($1, $2, $3)`,
    [page.id, GROUP, FAN],
  );

  let observations = 0;
  /** One REST DM page through the real canonicalizer and the archive projection. */
  const restPage = async (payload: Record<string, unknown>) => {
    await insertObservation(app.db, {
      source: "pull", producer: "sync:fansly:dm_messages", platform: "fansly",
      accountId: page.id, kind: "dm_messages", payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
      idempotencyKey: `transcript-media-${++observations}`, receivedAt: new Date(),
    });
    await runCanonicalization(app, { kinds: ["dm_messages"], accountId: page.id });
    await runMessageArchiveProjection(app, { accountId: page.id });
  };
  const mediaPlane = () => runMediaPlaneProjection(app, { accountId: page.id });
  const transcript = async (liveOverlay: "off" | "serve" = "off") => {
    const loaded = await loadTranscriptContext(app, { pageId: page.id, conversationRef: GROUP, limit: 100, liveOverlay });
    // Every message of the page is of one UTC day: the hub's day line opens
    // the text (2.10.1 sends none), then the message lines.
    const [day, ...lines] = loaded.transcript.split("\n");
    expect(day).toBe("--- 2026-10-01 ---");
    return { loaded, lines };
  };
  /** A socket message the archive does not hold yet, as the live decoder stores it. */
  const socketMessage = async (id: string, input: {
    minute: number; mine?: boolean; content: string; attachments: Array<{ contentType: number; contentId: string }>;
  }) => {
    const at = new Date((MEDIA_PAGE_BASE_SECONDS + input.minute * 60) * 1000);
    await testDb.pool.query(
      `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
         is_sent_by_page, created_at, content, attachments, decoder_version, first_visible_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 1, $6)`,
      [page.id, id, GROUP, input.mine ? PAGE_REF : FAN, input.mine === true, at, input.content,
        JSON.stringify(input.attachments)],
    );
  };
  return { app, page, restPage, mediaPlane, transcript, socketMessage };
}

describe("[AI-147] Fansly media in the hub-loaded transcript (chat-extension R20 HF-7a)", () => {
  it("a REST page reads as the Fansly extension 2.10.1 read the same page", async () => {
    const f = await fixture();
    await f.restPage(DM_PAGE);
    await f.mediaPlane();

    const { loaded, lines } = await f.transcript();
    expect(lines).toEqual(OLD_EXTENSION_LINES);
    // Fansly media never become OnlyFans image-note items.
    expect(loaded.mediaByMessage.size).toBe(0);
    expect(loaded.contextManifest).not.toHaveProperty("fanslyMediaError");

    // The archive keeps what the material head wrote: the MIME type, `bundle`
    // and `other`, in id order (the bundle before the video it follows).
    const { rows } = await testDb.pool.query<{ media_metadata: Array<{ id: string; type: string }> }>(
      `select media_metadata from message_archive where account_id = $1 and message_ref = '800000000000000004'`,
      [f.page.id],
    );
    expect(rows[0]!.media_metadata.map((item) => [item.id, item.type])).toEqual([
      ["820000000000000002", "bundle"],
      ["830000000000000001", "video/mp4"],
    ]);
  });

  it("before the media plane is projected, the archive's own list labels the media it names; a tip is never media", async () => {
    const f = await fixture();
    await f.restPage(DM_PAGE);

    const { lines } = await f.transcript();
    expect(lines).toEqual(expect.arrayContaining([
      "[10:00] Fan: [Photo] look at this",
      // The members are the media plane's: until then, the bundle alone.
      "[10:01] Model: [Media Bundle - PPV $25.00, unknown] for you",
      "[10:02] Model: [Video - PPV $15.00, unknown] unlock me",
      "[10:04] Fan: [Audio]",
      "[10:05] Fan: [Tip: $5.00] for you babe",
      // A media the page never served is `other` in the archive: not shown
      // until the media plane says it was a media, not a tip.
      "[10:06] Fan: can you see it?",
      "[10:08] Fan: replying to your story",
      "[10:09] Fan: [Photo]",
      "[10:10] Model: [Photo] [Photo] pics",
    ]));
  });

  it("a failed media read never fails the transcript: the messages serve without media labels, and the manifest says so", async () => {
    const f = await fixture();
    await f.restPage(DM_PAGE);
    await f.mediaPlane();
    await testDb.pool.query("alter table message_media_offers rename column offer_type to offer_type_moved");
    try {
      const { loaded, lines } = await f.transcript();
      expect(loaded.contextManifest).toMatchObject({ fanslyMediaError: true });
      // What the transcript read before HF-7a.
      expect(lines.slice(0, 3)).toEqual([
        "[10:00] Fan: look at this",
        "[10:01] Model: [PPV $25.00, unknown] for you",
        "[10:02] Model: [PPV $15.00, unknown] unlock me",
      ]);
    } finally {
      await testDb.pool.query("alter table message_media_offers rename column offer_type_moved to offer_type");
    }
  });

  it("the archive feed captions a Fansly row's media as its transcript labels them, without price or purchase state", async () => {
    // R20 HF-10 made the feed reachable on Fansly; its captions read the
    // row's stored list the OnlyFans way until this change (a photo, and a
    // tip's attachment, were `[Media]`).
    const f = await fixture();
    await f.restPage(DM_PAGE);
    await f.mediaPlane();

    const snapshot = await readConversationFeedSnapshot(f.app.db, { pageId: f.page.id });
    const page = await listConversationFeedPage(f.app.db, {
      source: "archive", pageId: f.page.id, conversationRef: GROUP, snapshot, limit: 50,
    });
    const captions = await loadFeedFanslyCaptions(f.app.db, { pageId: f.page.id, platform: "fansly", rows: page.rows });
    const items = page.rows.map((row) => toClientFeedItem(row, captions));
    expect(Object.fromEntries(items.map((item) => [item.messageId.slice(-2), item.attachmentLabels]))).toEqual({
      "12": [],
      "11": ["[Photo]", "[Photo]"],
      "10": ["[Photo]"],
      // A story reply's and a tip's attachments are not media.
      "09": [],
      "08": ["[Media Bundle]"],
      "07": ["[Media]"],
      "06": [],
      "05": ["[Audio]"],
      // The message's order; the price is the item's own field.
      "04": ["[Video]", "[Media Bundle: 2 Photos]"],
      "03": ["[Video]"],
      "02": ["[Media Bundle: 2 Photos, 1 Video]"],
      "01": ["[Photo]"],
    });
    expect(items.find((item) => item.messageId.endsWith("04"))).toMatchObject({ priceMills: 20_000 });
    expect(items.find((item) => item.messageId.endsWith("06"))).toMatchObject({ tipMills: 5_000 });
    // The same words the transcript reads, the marks aside.
    const { lines } = await f.transcript();
    expect(lines[3]).toBe("[10:03] Model: [Video - PPV $20.00, unknown] [Media Bundle: 2 Photos] two things");

    // OnlyFans rows keep their own reading: no Fansly read at all.
    expect(await loadFeedFanslyCaptions(f.app.db, { pageId: f.page.id, platform: "onlyfans", rows: page.rows })).toBeNull();
    expect(toClientFeedItem(page.rows.find((row) => row.messageRef.endsWith("01"))!, null).attachmentLabels).toEqual(["[Media]"]);
  });

  it("the live overlay labels a socket message's attachments from the files the hub knows; its REST copy reads the same", async () => {
    const f = await fixture();
    await f.restPage(DM_PAGE);
    await f.mediaPlane();
    await f.socketMessage("800000000000000013", {
      minute: 12, content: "and this one", attachments: [{ contentType: 1, contentId: "810000000000000001" }],
    });
    await f.socketMessage("800000000000000014", {
      minute: 13, content: "new pic", attachments: [{ contentType: 1, contentId: "810000000000000097" }],
    });
    await f.socketMessage("800000000000000015", {
      minute: 14, mine: true, content: "the set again",
      attachments: [{ contentType: 2, contentId: "820000000000000001" }, { contentType: 7, contentId: "840000000000000002" }],
    });

    const served = await f.transcript("serve");
    expect(served.loaded.served.source).toBe("live_union");
    expect(served.lines).toEqual([
      ...OLD_EXTENSION_LINES,
      "[10:12] Fan: [Photo] and this one",
      // A file the hub has never seen: a media of no known kind.
      "[10:13] Fan: [Media] new pic",
      // No price on a socket message: money is REST-only.
      "[10:14] Model: [Media Bundle: 2 Photos, 1 Video] the set again",
    ]);

    // The REST copy of the first one lands: the same line, from the archive.
    const photo = DM_PAGE.accountMedia.find((media) => media.id === "810000000000000001")!;
    await f.restPage({
      messages: [{
        ...DM_PAGE.messages.find((message) => message.id === "800000000000000001")!,
        id: "800000000000000013", content: "and this one", createdAt: MEDIA_PAGE_BASE_SECONDS + 12 * 60,
      }],
      accountMedia: [photo],
    });
    await f.mediaPlane();
    const after = await f.transcript("serve");
    expect(after.loaded.contextManifest).toMatchObject({ liveCount: 2 });
    expect(after.lines).toEqual(served.lines);
  });
});
