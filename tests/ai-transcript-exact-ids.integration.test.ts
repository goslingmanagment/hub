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
        "transcript": "[10:00] Fan: hey babe, missed you
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
        "transcript": "[10:00] Fan: hey babe, missed you
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
        "transcript": "[10:00] Fan: hey babe, missed you
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
        "onlyfans chat-review": "506f316a02df5dcf273fe83bebe7b5312b5ccc4a74a1987a3ed5dbe21af9f927",
        "onlyfans coach-chat preset": "6dfb2b2b49dae628cda7806fe46f505b0e52d15ef3371e5eee62fed2e565b5e6",
        "onlyfans coach-chat question": "2719c981d83713be214e7e42ee1ad5b9bbca139724f92c35381c5af029255fa2",
        "onlyfans fan-notes-fill": "1c5e81470cd319a7570820947cc3a834b0a4e644a890782d413f0fbb74dda306",
        "onlyfans fan-summary": "336a4ea99a2f46b25b0cb186986803ab64b928657df359fc1b78ab85132a482b",
        "onlyfans fan-summary short": "5ac45b123db389b66f15199d09d4c9566b397c35343ada052a9b88b360500e84",
        "onlyfans fast-reply flirty": "d3a48bb14bf2a9f819edb37a3d432e56391a99ba5d3d29e84d15a0f072fc665a",
        "onlyfans fast-reply split": "3ae67416b8a6fea060f6bb1c230e5882a9c9c5d2470e34aaa384e0ed4bb96103",
        "onlyfans help-me": "1a81377c227c966d025aa895c06298b5df3635ecd80eef48a5c68a3a4b887bf7",
        "onlyfans hi-greeting 1 variant": "96be3c0aaceccf216dc955f9ba6fdafb909b64def7c6a37ab4f9b499f89dcae4",
        "onlyfans hi-greeting 3 variants": "a2b5d30c57a1047abe898c344a6cc113c30b2c4e35027680841e2604bc0e835d",
        "onlyfans improve-draft": "adbf06a1fe9bccdcc7737ace705efde3619bd933877fdd4976fd8cef753ed023",
        "onlyfans improve-draft split": "ab9adc826fe100ab5113abb9d3244cf501f18e31cd1eea2ad9c2cfe7f0a31966",
        "onlyfans ping active": "00c96cf91f14e0f887b5041607bdec414a3e6e09e0eb83cfc5aae48f56196680",
        "onlyfans ping segment-a": "9f06b11c85ed3079c112f0d04261473df5f991c6dd63ca07cad8ca39a67b42a8",
        "onlyfans ping segment-b": "32f2504f8a2776e9d2685cf6437419161c5abf1b83d00f0a301f77bf3b97d335",
        "onlyfans voice-script": "1858800e625da5ea05f05d78d0d00a48ccf9276f2af08c1a66473923c4077d79",
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
        "transcript": "[10:00] Fan: hey babe, missed you
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
