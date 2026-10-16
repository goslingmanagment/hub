import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  lookupAiLiveTextMessages,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  applyOnlyFansMediaNotes,
  buildPrompt,
  formatTranscript,
  listOnlyFansMediaNoteItems,
  loadAiContextFrameBody,
  loadTranscriptContext,
  mediaNoteLimitsFor,
  mergeLiveText,
  UNCONFIRMED_SOCKET_MESSAGE_LABEL,
  type AiTranscriptUnionMode,
} from "../apps/runtime/src/modules/ai/index.ts";
import { promptDigest, referencePrompts } from "./helpers/ai-prompt-references.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// chat-extension R20 HF-8a: a platform message id stays the exact string its
// store keeps, from the store to the prompt and the context frame.
//
// The OnlyFans golden below was pinned on hub main a3449f77, BEFORE the
// transcript stopped keying messages by `Number(ref)`: the same rows must give
// the same transcript, window, image notes, fresh-text merge, frame answers
// and prompt bytes after it. OnlyFans ids are 13-14 digits, far below 2^53,
// so their string order is the number order they had (prod, 2026-10-12: every
// OnlyFans ref of message_archive and dm_message_archive is a decimal without
// a leading zero, none above 2^53).

let testDb: StartedTestDatabase | null = null;
let app: AppContext;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (testDb) {
    app = createTestAppContext(testDb);
  }
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

const BASE = Date.parse("2026-10-01T10:00:00.000Z");
const at = (minutes: number) => new Date(BASE + minutes * 60_000);

// ── OnlyFans ──────────────────────────────────────────────────────────────

const OF_FAN = "4100001";
const OF_ACCOUNT = "acct_exact_ids";

async function seedOnlyFansPage() {
  const model = await createModel(testDb!.db, { slug: "exact-of", name: "exact-of" });
  const page = await createOnlyFansPage(testDb!.db, { modelId: model!.id, label: "exact-of" });
  await setPageOfapiAccountId(testDb!.db, { pageId: page!.id, ofapiAccountId: OF_ACCOUNT });
  return page!;
}

interface SeedRow {
  ref: string;
  mine?: boolean;
  minutes: number | null;
  text: string;
  priceMills?: number;
  isOpened?: boolean | null;
  tipMills?: number;
  media?: Array<Record<string, unknown>>;
  deleted?: boolean;
}

async function archiveRow(pageId: number, platform: "onlyfans" | "fansly", conversation: string, row: SeedRow) {
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id, sender_role,
       is_sent_by_me, occurred_at, text_plain, price_mills, is_opened, is_tip, tip_amount_mills, media_metadata,
       deleted_at, backfill_source)
     values ($1, $2, $3, $4, $3, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, 'seed')`,
    [pageId, platform, conversation, row.ref, row.mine ? "model" : "fan", row.mine === true,
      row.minutes === null ? null : at(row.minutes), row.text, row.priceMills ?? null, row.isOpened ?? null,
      (row.tipMills ?? 0) > 0, row.tipMills ?? 0, JSON.stringify(row.media ?? []),
      row.deleted ? at(60) : null],
  );
}

async function dmRow(pageId: number, row: SeedRow) {
  await testDb!.pool.query(
    `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_conversation_id,
       fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain,
       price_mills, is_opened, is_tip, tip_amount_mills, media_metadata, deleted_at, source, source_event_type,
       source_idempotency_key, source_journal_id, source_received_at, retain_until)
     values ('onlyfans', $1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, null, 'webhook', $14,
       $15, 1, now(), now() + interval '100 years')`,
    [pageId, OF_ACCOUNT, OF_FAN, row.ref, row.mine ? "model" : "fan", row.mine === true,
      row.minutes === null ? null : at(row.minutes), row.text, row.priceMills ?? null, row.isOpened ?? null,
      (row.tipMills ?? 0) > 0, row.tipMills ?? 0, JSON.stringify(row.media ?? []),
      row.mine ? "messages.sent" : "messages.received", `exact-ids-${row.ref}`],
  );
}

/** Every branch a transcript line takes on OnlyFans: media, bundles, PPV with
 *  and without a purchase state, tips, a media-only message, rows the readers
 *  never serve, and equal instants that only the id orders — including ids of
 *  different lengths, where the order of strings and of numbers differs. */
async function seedOnlyFansChat(pageId: number) {
  const archive: SeedRow[] = [
    { ref: "3998001000001", minutes: 0, text: "hey babe, missed you" },
    { ref: "3998001000002", mine: true, minutes: 5, text: "hey you 😘 where have you been",
      media: [{ id: 7001, type: "photo", canView: true }] },
    { ref: "999", minutes: 7, text: "the shorter id sorts first" },
    { ref: "1000", mine: true, minutes: 7, text: "the longer id sorts second" },
    { ref: "3998001000005", minutes: 10, text: "sent you a little something <3", tipMills: 5_000 },
    { ref: "3998001000006", mine: true, minutes: 12, text: "that was so worth it", priceMills: 15_000, isOpened: true,
      media: [{ id: 7002, type: "photo" }, { id: 7003, type: "video" }] },
    { ref: "4012345678901", minutes: 15, text: "same instant, larger id" },
    { ref: "4012345678900", minutes: 15, text: "same instant, smaller id" },
    { ref: "3998001000009", minutes: null, text: "no time: never served" },
    { ref: "3998001000010", minutes: 20, text: "deleted: never served", deleted: true },
    { ref: "3998001000011", minutes: 22, text: "", media: [{ id: 7004, type: "photo" }] },
  ];
  for (const row of archive) {
    await archiveRow(pageId, "onlyfans", OF_FAN, row);
  }
  const webhooks: SeedRow[] = [
    { ref: "3998001000005", minutes: 10, text: "sent you a little something <3", tipMills: 5_000 },
    { ref: "3998001000012", minutes: 25, text: "are you there?" },
    { ref: "3998001000013", mine: true, minutes: 26, text: "new set for you", priceMills: 2_000, isOpened: false,
      media: [{ id: 7005, type: "photo" }] },
  ];
  for (const row of webhooks) {
    await dmRow(pageId, row);
  }
}

/** What a loaded transcript is, with nothing that differs per run. */
function snapshotOf(context: Awaited<ReturnType<typeof loadTranscriptContext>>) {
  const { queryDurationMs: _queryDurationMs, ...manifest } = context.contextManifest;
  return {
    transcript: context.transcript,
    window: context.served.window.map((message) => [
      message.messageRef, message.occurredAt?.toISOString() ?? null, message.isFromFan,
    ]),
    archiveHead: context.served.archiveHead?.messageRef ?? null,
    media: [...context.mediaByMessage.values()].map((entry) => ({ ...entry, messageId: String(entry.messageId) })),
    manifest,
    unconfirmedSocketMessages: context.unconfirmedSocketMessages,
  };
}

async function loadOnlyFans(pageId: number, unionMode: AiTranscriptUnionMode) {
  return loadTranscriptContext(app, { pageId, conversationRef: OF_FAN, limit: 100, unionMode });
}

describe("OnlyFans transcripts keep their bytes (HF-8a golden)", () => {
  it("the archive reader", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedOnlyFansPage();
    await seedOnlyFansChat(page.id);

    expect(snapshotOf(await loadOnlyFans(page.id, "off"))).toMatchInlineSnapshot(`
      {
        "archiveHead": "3998001000011",
        "manifest": {
          "additions": null,
          "archiveCount": 10,
          "archiveHeadAt": "2026-10-01T10:22:00.000Z",
          "archiveHeadRef": "3998001000011",
          "gapMs": null,
          "headsEqual": null,
          "liveCount": null,
          "liveError": false,
          "liveOverlay": "off",
          "loaderVersion": "transcript-union-v1",
          "mode": "off",
          "source": "archive",
          "staleContext": false,
          "tombstones": null,
          "unionCount": null,
          "unionError": false,
          "unionHeadAt": null,
          "unionHeadRef": null,
        },
        "media": [],
        "transcript": "--- 2026-10-01 ---
      [10:00] Fan: hey babe, missed you
      [10:05] Model: hey you 😘 where have you been
      [10:07] Fan: the shorter id sorts first
      [10:07] Model: the longer id sorts second
      [10:10] Fan: [Tip: $5.00] sent you a little something <3
      [10:12] Model: [PPV $15.00, unknown] that was so worth it
      [10:15] Fan: same instant, smaller id
      [10:15] Fan: same instant, larger id
      [10:22] Fan: ",
        "unconfirmedSocketMessages": 0,
        "window": [
          [
            "3998001000001",
            "2026-10-01T10:00:00.000Z",
            true,
          ],
          [
            "3998001000002",
            "2026-10-01T10:05:00.000Z",
            false,
          ],
          [
            "999",
            "2026-10-01T10:07:00.000Z",
            true,
          ],
          [
            "1000",
            "2026-10-01T10:07:00.000Z",
            false,
          ],
          [
            "3998001000005",
            "2026-10-01T10:10:00.000Z",
            true,
          ],
          [
            "3998001000006",
            "2026-10-01T10:12:00.000Z",
            false,
          ],
          [
            "4012345678900",
            "2026-10-01T10:15:00.000Z",
            true,
          ],
          [
            "4012345678901",
            "2026-10-01T10:15:00.000Z",
            true,
          ],
          [
            "3998001000011",
            "2026-10-01T10:22:00.000Z",
            true,
          ],
        ],
      }
    `);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the union reader, its image notes and its prompts", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedOnlyFansPage();
    await seedOnlyFansChat(page.id);
    const loaded = await loadOnlyFans(page.id, "serve");

    expect(snapshotOf(loaded)).toMatchInlineSnapshot(`
      {
        "archiveHead": "3998001000011",
        "manifest": {
          "additions": 2,
          "archiveCount": 10,
          "archiveHeadAt": "2026-10-01T10:22:00.000Z",
          "archiveHeadRef": "3998001000011",
          "gapMs": 240000,
          "headsEqual": false,
          "liveCount": null,
          "liveError": false,
          "liveOverlay": "off",
          "loaderVersion": "transcript-union-v1",
          "mode": "serve",
          "source": "union",
          "staleContext": false,
          "tombstones": 0,
          "unionCount": 12,
          "unionError": false,
          "unionHeadAt": "2026-10-01T10:26:00.000Z",
          "unionHeadRef": "3998001000013",
        },
        "media": [
          {
            "media": [
              {
                "id": "7005",
                "type": "photo",
              },
            ],
            "messageId": "3998001000013",
            "paid": true,
            "sender": "model",
          },
          {
            "media": [
              {
                "id": "7004",
                "type": "photo",
              },
            ],
            "messageId": "3998001000011",
            "paid": false,
            "sender": "fan",
          },
          {
            "media": [
              {
                "id": "7002",
                "type": "photo",
              },
              {
                "id": "7003",
                "type": "video",
              },
            ],
            "messageId": "3998001000006",
            "paid": true,
            "sender": "model",
          },
          {
            "media": [
              {
                "id": "7001",
                "type": "photo",
              },
            ],
            "messageId": "3998001000002",
            "paid": false,
            "sender": "model",
          },
        ],
        "transcript": "--- 2026-10-01 ---
      [10:00] Fan: hey babe, missed you
      [10:05] Model: [Photo] hey you 😘 where have you been
      [10:07] Fan: the shorter id sorts first
      [10:07] Model: the longer id sorts second
      [10:10] Fan: [Tip: $5.00] sent you a little something <3
      [10:12] Model: [Media Bundle: 1 Photo, 1 Video - PPV $15.00, purchased] that was so worth it
      [10:15] Fan: same instant, smaller id
      [10:15] Fan: same instant, larger id
      [10:22] Fan: [Photo]
      [10:25] Fan: are you there?
      [10:26] Model: [Photo - PPV $2.00, not purchased] new set for you",
        "unconfirmedSocketMessages": 0,
        "window": [
          [
            "3998001000001",
            "2026-10-01T10:00:00.000Z",
            true,
          ],
          [
            "3998001000002",
            "2026-10-01T10:05:00.000Z",
            false,
          ],
          [
            "999",
            "2026-10-01T10:07:00.000Z",
            true,
          ],
          [
            "1000",
            "2026-10-01T10:07:00.000Z",
            false,
          ],
          [
            "3998001000005",
            "2026-10-01T10:10:00.000Z",
            true,
          ],
          [
            "3998001000006",
            "2026-10-01T10:12:00.000Z",
            false,
          ],
          [
            "4012345678900",
            "2026-10-01T10:15:00.000Z",
            true,
          ],
          [
            "4012345678901",
            "2026-10-01T10:15:00.000Z",
            true,
          ],
          [
            "3998001000011",
            "2026-10-01T10:22:00.000Z",
            true,
          ],
          [
            "3998001000012",
            "2026-10-01T10:25:00.000Z",
            true,
          ],
          [
            "3998001000013",
            "2026-10-01T10:26:00.000Z",
            false,
          ],
        ],
      }
    `);

    const items = listOnlyFansMediaNoteItems(loaded.messages, loaded.mediaByMessage);
    const noted = applyOnlyFansMediaNotes({
      messages: loaded.messages,
      items,
      descriptions: [{ mediaRef: "7004", variant: "full", status: "described", description: "A selfie in a red dress." }],
      limits: mediaNoteLimitsFor("fast-reply"),
    });
    expect({
      items: items.map((item) => [item.n, item.messageId, item.mediaId, item.placement, item.sender]),
      transcript: formatTranscript(noted.messages),
    }).toMatchInlineSnapshot(`
      {
        "items": [
          [
            1,
            "3998001000002",
            "7001",
            "inline",
            "model",
          ],
          [
            2,
            "3998001000011",
            "7004",
            "inline",
            "fan",
          ],
        ],
        "transcript": "--- 2026-10-01 ---
      [10:00] Fan: hey babe, missed you
      [10:05] Model: [Photo #1] hey you 😘 where have you been
      [10:07] Fan: the shorter id sorts first
      [10:07] Model: the longer id sorts second
      [10:10] Fan: [Tip: $5.00] sent you a little something <3
      [10:12] Model: [Media Bundle: 1 Photo, 1 Video - PPV $15.00, purchased] that was so worth it
      [10:15] Fan: same instant, smaller id
      [10:15] Fan: same instant, larger id
      [10:22] Fan: [Photo #2: A selfie in a red dress.]
      [10:25] Fan: are you there?
      [10:26] Model: [Photo - PPV $2.00, not purchased] new set for you",
      }
    `);

    // Every OnlyFans reference prompt, with the transcript these rows load to.
    const digests = Object.fromEntries(referencePrompts()
      .filter(({ name }) => name.startsWith("onlyfans "))
      .map(({ name, input }) => [name, promptDigest(buildPrompt({ ...input, transcript: loaded.transcript }))]));
    expect(digests).toMatchInlineSnapshot(`
      {
        "onlyfans chat-review": "eecb2bbf8bbbaf434bc22423a28331e7e8d073e0c8a6790c2301e3cdc059ff66",
        "onlyfans coach-chat preset": "1e2210d14392c7b5c78c15e23248612d27b0b7fa310c637855c5d5ef7ac4c5c2",
        "onlyfans coach-chat question": "e20b6d3b3370c56c21b1f96010169d8a75fb6fee8f6595fb65dbdc89b468e844",
        "onlyfans fan-notes-fill": "1d81d459d9f02ce0f1bbb8d175ca2f779ea7f576302ca46c8dfa355b70f595db",
        "onlyfans fan-notes-fill merge": "83108430f192fca6de96bd7208de2f2362baf4a38a850e6a77782a7ee7f1158a",
        "onlyfans fan-summary": "c8b8e1d1500518df542cc7427b2ffdc0bfbd981ed57a16dc18c287f12f130509",
        "onlyfans fan-summary short": "f3e354093e86e1d2ac14cca81a3e3bb6e9f4d4112a91c570cfbadf121cd1513f",
        "onlyfans fast-reply flirty": "1471e468e22f840c5e0e6e4efd97668280b0d24abf83bea908dac26b32aaa42b",
        "onlyfans fast-reply split": "d7de43cd0cab7780ed0b0eb6821ec28946eb1a77b01348b01cc0bd78ebe5d35a",
        "onlyfans help-me": "905a167ea314aeefa44f4f3a5be94c144ddafc649305d35a2958536899465c38",
        "onlyfans hi-greeting 1 variant": "0ee6e00d887b81f6bc73f9bdd5cbe40f6680bb49f67d0906f11accf8b7094e37",
        "onlyfans hi-greeting 3 variants": "940d6b2a2a89f2e51bd7619ce9d973547e8692ea7869a961a53bab9752c95e7a",
        "onlyfans improve-draft": "8dcabd19b0127742bf12ae16709828d88cf65f2cbe129c794328097d10f42dfb",
        "onlyfans improve-draft split": "f99cb3bba2ecddc5581042348ac571f5a5fa75bfe667c6c0b0454ae6a21d0fcc",
        "onlyfans ping active": "7c2d676d01d2a41ef1c4fd5b071f829cf57c7c91a26a9a31679dcb7d6738c2b1",
        "onlyfans ping segment-a": "01f6d57497b0935403f030121bcb749017fab344982dd2b3b35494d38303ca7d",
        "onlyfans ping segment-b": "ac71994004c643cb2c9a616665a038a94017ed9780330d432e7d1581e7f728c4",
        "onlyfans voice-script": "374161e2d584fb118b5cc7c6b8aea18263db513b841c1c32a934a3bcd229fb74",
      }
    `);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the fresh-text merge and the frame's answers", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedOnlyFansPage();
    await seedOnlyFansChat(page.id);
    const loaded = await loadOnlyFans(page.id, "serve");

    const items = [
      { platformMessageId: "3998001000012", direction: "fan" as const, occurredAt: at(25).toISOString(), text: "are you there?" },
      { platformMessageId: "3998001000015", direction: "model" as const, occurredAt: at(29).toISOString(), text: "here!" },
      { platformMessageId: "3998001000014", direction: "fan" as const, occurredAt: at(30).toISOString(), text: "hello??" },
      { platformMessageId: "3998001000016", direction: "fan" as const, occurredAt: at(30).toISOString(), text: "same instant" },
      { platformMessageId: "3998001000010", direction: "fan" as const, occurredAt: at(20).toISOString(), text: "back from the dead" },
    ];
    const held = new Set(loaded.served.window.map((message) => message.messageRef));
    const stores = await lookupAiLiveTextMessages(app.db, {
      pageId: page.id,
      platform: "onlyfans",
      conversationRef: OF_FAN,
      messageRefs: items.map((item) => item.platformMessageId).filter((id) => !held.has(id)),
      otherPageIds: null,
    });
    const merge = mergeLiveText({ messages: loaded.messages, window: loaded.served.window, items, stores, limit: 100 });
    expect({
      transcript: formatTranscript(merge.messages),
      window: merge.window.map((message) => message.messageRef),
      accepted: merge.accepted,
      rejected: merge.rejected,
      conflicts: merge.conflicts,
      matched: merge.matched,
      outsideWindow: merge.outsideWindow,
      headRef: merge.headRef,
      hubSawHead: merge.hubSawHead,
    }).toMatchInlineSnapshot(`
      {
        "accepted": [
          "3998001000015",
          "3998001000014",
          "3998001000016",
        ],
        "conflicts": [],
        "headRef": "3998001000016",
        "hubSawHead": false,
        "matched": 1,
        "outsideWindow": 0,
        "rejected": [
          {
            "id": "3998001000010",
            "reason": "deleted",
          },
        ],
        "transcript": "--- 2026-10-01 ---
      [10:00] Fan: hey babe, missed you
      [10:05] Model: [Photo] hey you 😘 where have you been
      [10:07] Fan: the shorter id sorts first
      [10:07] Model: the longer id sorts second
      [10:10] Fan: [Tip: $5.00] sent you a little something <3
      [10:12] Model: [Media Bundle: 1 Photo, 1 Video - PPV $15.00, purchased] that was so worth it
      [10:15] Fan: same instant, smaller id
      [10:15] Fan: same instant, larger id
      [10:22] Fan: [Photo]
      [10:25] Fan: are you there?
      [10:26] Model: [Photo - PPV $2.00, not purchased] new set for you
      [10:29] Model: here!
      [10:30] Fan: hello??
      [10:30] Fan: same instant",
        "window": [
          "3998001000001",
          "3998001000002",
          "999",
          "1000",
          "3998001000005",
          "3998001000006",
          "4012345678900",
          "4012345678901",
          "3998001000011",
          "3998001000012",
          "3998001000013",
          "3998001000015",
          "3998001000014",
          "3998001000016",
        ],
      }
    `);

    const frame = await loadAiContextFrameBody(app, {
      pageId: page.id,
      platform: "onlyfans",
      conversationRef: OF_FAN,
      served: loaded.served,
      messages: loaded.messages,
      requestedCount: 100,
      knownFanMessageIds: ["3998001000012", "3998001000010", "3998001000002", "999", "3998001000001", "5550001"],
    });
    expect(frame).toMatchInlineSnapshot(`
      {
        "archiveHead": {
          "isFromFan": true,
          "messageRef": "3998001000011",
          "occurredAt": "2026-10-01T10:22:00.000Z",
        },
        "coverage": "unknown",
        "fanLanguageEvidence": "latin",
        "knownFanMessages": [
          {
            "id": "3998001000012",
            "state": "included",
          },
          {
            "id": "3998001000010",
            "state": "deleted",
          },
          {
            "id": "3998001000002",
            "state": "unknown",
          },
          {
            "id": "999",
            "state": "included",
          },
          {
            "id": "3998001000001",
            "state": "included",
          },
          {
            "id": "5550001",
            "state": "absent",
          },
        ],
        "live": {
          "accepted": 0,
          "rejected": 0,
          "status": "not_sent",
        },
        "servedHead": {
          "isFromFan": false,
          "messageRef": "3998001000013",
          "occurredAt": "2026-10-01T10:26:00.000Z",
        },
        "source": "union",
        "window": {
          "requested": 100,
          "served": 11,
        },
      }
    `);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

// ── Fansly: ids past 2^53 ─────────────────────────────────────────────────
//
// Every message id below is ONE double: 9·10^17, whose step is 128
// (`Number("899999999999999936") === Number("900000000000000064")`, ties
// round to even). Keyed by `Number(ref)`, the whole chat was one message.

const FS_FAN = "700000000000000001";
const FS_GROUP = "800000000000000001";
const EVEN = ["899999999999999936", "900000000000000064"] as const;
const STEP = ["900000000000000001", "900000000000000002"] as const;
const SOCKET_ONLY = "900000000000000003";
const DELETED = "900000000000000005";
const NEVER_SEEN = "900000000000000007";

async function seedFanslyChat() {
  const model = await createModel(testDb!.db, { slug: "exact-fs", name: "exact-fs" });
  const page = (await createFanslyPage(testDb!.db, { modelId: model!.id, label: "exact-fs" }))!;
  const rows: SeedRow[] = [
    { ref: EVEN[0], minutes: 0, text: "first of the even pair" },
    { ref: EVEN[1], minutes: 1, text: "second of the even pair" },
    // One instant: only the id orders them.
    { ref: STEP[1], minutes: 2, text: "the larger id of the step pair" },
    { ref: STEP[0], mine: true, minutes: 2, text: "the smaller id of the step pair" },
    { ref: DELETED, minutes: 3, text: "deleted: never served", deleted: true },
    // Not a decimal id: the transcript cannot key it, so it never serves.
    { ref: "fs-not-an-id", minutes: 3, text: "never served" },
  ];
  for (const row of rows) {
    await archiveRow(page.id, "fansly", FS_GROUP, row);
  }
  await testDb!.pool.query(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id)
     values ($1, $2, $3)`,
    [page.id, FS_GROUP, FS_FAN],
  );
  // A socket message the archive does not hold yet (the live overlay).
  await testDb!.pool.query(
    `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
       is_sent_by_page, created_at, content, decoder_version, first_visible_at)
     values ($1, $2, $3, $4, false, $5, 'socket only, same double', 1, $5)`,
    [page.id, SOCKET_ONLY, FS_GROUP, FS_FAN, at(4)],
  );
  return page;
}

describe("Fansly ids past 2^53 stay apart up to the prompt and the coverage answer (HF-8a)", () => {
  const KNOWN = [STEP[1], EVEN[1], EVEN[0], DELETED, NEVER_SEEN, STEP[0], SOCKET_ONLY];

  it("the archive reader", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedFanslyChat();
    const loaded = await loadTranscriptContext(app, { pageId: page.id, conversationRef: FS_GROUP, limit: 100 });

    expect(loaded.transcript).toBe([
      "--- 2026-10-01 ---",
      "[10:00] Fan: first of the even pair",
      "[10:01] Fan: second of the even pair",
      "[10:02] Model: the smaller id of the step pair",
      "[10:02] Fan: the larger id of the step pair",
    ].join("\n"));
    expect(loaded.messages.map((message) => message.id)).toEqual([EVEN[0], EVEN[1], STEP[0], STEP[1]]);
    expect(loaded.served.window.map((message) => message.messageRef)).toEqual([EVEN[0], EVEN[1], STEP[0], STEP[1]]);

    const prompt = buildPrompt({ ...referencePrompts().find(({ name }) => name === "fansly fast-reply flirty")!.input,
      transcript: loaded.transcript });
    expect(prompt.userBlocks.map((block) => block.text).join("\n")).toContain(loaded.transcript);

    const frame = await loadAiContextFrameBody(app, {
      pageId: page.id,
      platform: "fansly",
      conversationRef: FS_GROUP,
      served: loaded.served,
      messages: loaded.messages,
      requestedCount: 100,
      knownFanMessageIds: KNOWN,
    });
    expect(frame).toMatchObject({
      source: "archive",
      servedHead: { messageRef: STEP[1], isFromFan: true },
      window: { requested: 100, served: 4 },
      knownFanMessages: [
        { id: STEP[1], state: "included" },
        { id: EVEN[1], state: "included" },
        { id: EVEN[0], state: "included" },
        { id: DELETED, state: "deleted" },
        { id: NEVER_SEEN, state: "absent" },
        // The model's own message.
        { id: STEP[0], state: "unknown" },
        // The overlay did not serve, so its message is not in the window.
        { id: SOCKET_ONLY, state: "absent" },
      ],
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the live overlay union, where only the socket message is unconfirmed", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedFanslyChat();
    const loaded = await loadTranscriptContext(app, {
      pageId: page.id,
      conversationRef: FS_GROUP,
      limit: 100,
      liveOverlay: "serve",
      chatUnavailable: true,
    });

    expect(loaded.served.source).toBe("live_union");
    expect(loaded.transcript).toBe([
      "--- 2026-10-01 ---",
      "[10:00] Fan: first of the even pair",
      "[10:01] Fan: second of the even pair",
      "[10:02] Model: the smaller id of the step pair",
      "[10:02] Fan: the larger id of the step pair",
      `[10:04] Fan: ${UNCONFIRMED_SOCKET_MESSAGE_LABEL} socket only, same double`,
    ].join("\n"));
    // One label: the archive's messages of the same double are not the socket's.
    expect(loaded.unconfirmedSocketMessages).toBe(1);
    expect(loaded.served.window.map((message) => message.messageRef))
      .toEqual([EVEN[0], EVEN[1], STEP[0], STEP[1], SOCKET_ONLY]);

    const frame = await loadAiContextFrameBody(app, {
      pageId: page.id,
      platform: "fansly",
      conversationRef: FS_GROUP,
      served: loaded.served,
      messages: loaded.messages,
      requestedCount: 100,
      knownFanMessageIds: KNOWN,
    });
    expect(frame.knownFanMessages).toEqual([
      { id: STEP[1], state: "included" },
      { id: EVEN[1], state: "included" },
      { id: EVEN[0], state: "included" },
      { id: DELETED, state: "deleted" },
      { id: NEVER_SEEN, state: "absent" },
      { id: STEP[0], state: "unknown" },
      { id: SOCKET_ONLY, state: "included" },
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
