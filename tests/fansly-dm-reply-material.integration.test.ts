import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendMixedDomainEvents,
  applyMessageEventsToArchive,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertObservation,
  listAgentTranscript,
  liftLegacySeedRowsToShadow,
  markObservationParsed,
} from "@agency_hub_core/db";
import { runCanonicalization, resetCanonicalizeSweepRuntime } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { canonicalizeSyncPullObservation } from "../apps/runtime/src/services/canonicalize/sync-pull.ts";
import { runMessageArchiveProjection, rebuildMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import { appendOfapiMessageMaterialPage } from "../apps/runtime/src/services/ofapi-message-material.ts";
import { resetIntegrationDatabase, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let testDb: StartedTestDatabase;
const receivedAt = new Date("2026-09-07T12:00:00Z");
const messageAt = new Date("2026-09-07T11:00:00Z");

beforeAll(async () => { testDb = await startTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => {
  await resetIntegrationDatabase(testDb.pool);
  resetCanonicalizeSweepRuntime();
});

function app() {
  return { db: testDb.db, logger: { info() {}, warn() {}, error() {} } } as never;
}

async function seedPage(onlyFans = false) {
  const model = await createModel(testDb.db, { slug: "reply", name: "Reply" });
  if (!model) throw new Error("test model missing");
  const createPage = onlyFans ? createOnlyFansPage : createFanslyPage;
  const page = await createPage(testDb.db, { modelId: model.id, label: "reply" });
  if (!page) throw new Error("test page missing");
  await testDb.pool.query("update pages set external_page_id = 'creator-1' where id = $1", [page.id]);
  return page.id;
}

function message(fields: Record<string, unknown> = {}) {
  return {
    id: "9001", groupId: "group-1", senderId: "fan-1", content: "<p>reply</p>",
    createdAt: messageAt.getTime() / 1000, totalTipAmount: 0, attachments: [],
    inReplyTo: "8999", inReplyToRoot: "8000", ...fields,
  };
}

async function capture(pageId: number, payload: unknown, key: string, at = receivedAt) {
  return insertObservation(testDb.db, {
    source: "pull", producer: "sync:fansly:dm_messages", platform: "fansly",
    accountId: pageId, kind: "dm_messages", payload,
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    idempotencyKey: key, receivedAt: at,
  });
}

async function transcript(pageId: number) {
  return (await listAgentTranscript(testDb.db, {
    pageId, platform: "fansly", conversationRef: "group-1",
    from: new Date("2026-09-07T00:00:00Z"), to: new Date("2026-09-08T00:00:00Z"),
    sortDir: "asc", limit: 100, filters: {},
  })).rows;
}

describe("Fansly reply material repair", () => {
  it("lifts a legacy seed's reply metadata and field clocks verbatim to the rebuild shadow", async () => {
    const pageId = await seedPage();
    await testDb.pool.query(`
      insert into message_archive (account_id, platform, conversation_ref, message_ref,
        sender_role, is_sent_by_me, text_plain, backfill_source, in_reply_to_ref,
        reply_metadata, material_observed_at, reply_parent_observed_at, reply_root_observed_at)
      values ($1, 'fansly', 'group-1', '9001', 'fan', false, 'legacy', 'hot_table', '8999',
        '{"messageId":"8999","rootMessageId":"8000"}', $2, $2, $3)
    `, [pageId, receivedAt, messageAt]);
    expect(await liftLegacySeedRowsToShadow(testDb.db, { accountId: pageId })).toBe(1);
    const copied = await testDb.pool.query(`
      select in_reply_to_ref, reply_metadata, material_observed_at,
        reply_parent_observed_at, reply_root_observed_at from message_archive_shadow where account_id = $1
    `, [pageId]);
    expect(copied.rows[0]).toEqual({ in_reply_to_ref: "8999", reply_metadata: { messageId: "8999", rootMessageId: "8000" },
      material_observed_at: receivedAt, reply_parent_observed_at: receivedAt, reply_root_observed_at: messageAt });
  });

  it("repairs a reply beneath newer sparse v5 material without rolling back its text; explicit clears survive replay and rebuild", async () => {
    const pageId = await seedPage();
    const t2 = new Date(receivedAt.getTime() + 1000);
    const first = await capture(pageId, { messages: [message({ attachments: [{ contentId: "media-1" }] })] }, "old-reply");
    const sparse = { ...message({ content: "new body", attachments: [{ contentId: "media-1" }] }) } as Record<string, unknown>;
    delete sparse.inReplyTo;
    delete sparse.inReplyToRoot;
    const second = await capture(pageId, { messages: [sparse] }, "new-sparse", t2);
    await appendMixedDomainEvents(testDb.db, pageId, [{
      type: "message.material_observed", occurredAt: messageAt, conversationRef: "group-1",
      fanIdentityRef: "fan-1", messageRef: "9001", transactionRef: null, observationId: second.observationId,
      schemaVersion: 1, dedupKey: "v5-new-sparse", data: { head: {
        nativeMessageId: "9001", textHtml: "new body", isSentByMe: false,
        messageCreatedAt: messageAt.toISOString(), materialObservedAt: t2.toISOString(),
        vendorChangedAt: null, originClass: "fansly_dm_sidecar", reply: null,
        media: [{ id: "media-1", type: "other" }], fieldPresence: { reply: true, media: true, tipText: false },
      } },
    }], { observationId: second.observationId, occurredAt: t2, dedupKey: "v5-new-sparse-checkpoint" });
    for (const captured of [first, second]) await markObservationParsed(testDb.db, { ...captured, parseVersion: 5 });
    await runMessageArchiveProjection(app());
    expect((await transcript(pageId))[0]).toMatchObject({ textPlain: "new body", inReplyToRef: null });
    await runCanonicalization(app(), { kinds: ["dm_messages"], accountId: pageId });
    await runMessageArchiveProjection(app());
    const repaired = { textPlain: "new body", inReplyToRef: "8999", replyMetadata: { rootMessageId: "8000" } };
    expect((await transcript(pageId))[0]).toMatchObject(repaired);
    await rebuildMessageArchiveProjection(app(), { accountId: pageId });
    expect((await transcript(pageId))[0]).toMatchObject(repaired);

    await capture(pageId, { messages: [message({ content: "clear body", inReplyTo: null, inReplyToRoot: null })] },
      "text-clear", new Date(receivedAt.getTime() + 2000));
    await runCanonicalization(app(), { kinds: ["dm_messages"], accountId: pageId });
    await runMessageArchiveProjection(app());
    const cleared = { textPlain: "clear body", inReplyToRef: null, replyMetadata: null };
    expect((await transcript(pageId))[0]).toMatchObject(cleared);
    // An old body newly appended after the clear must not resurrect the link.
    await capture(pageId, { messages: [message({ content: "old body again" })] }, "late-old-reply", receivedAt);
    await runCanonicalization(app(), { kinds: ["dm_messages"], accountId: pageId });
    await runMessageArchiveProjection(app());
    expect((await transcript(pageId))[0]).toMatchObject(cleared);
    await rebuildMessageArchiveProjection(app(), { accountId: pageId });
    expect((await transcript(pageId))[0]).toMatchObject(cleared);
  });

  it("replays v5 retained text/attachment replies into the serving transcript without duplicate messages", async () => {
    const pageId = await seedPage();
    const payload = { messages: [message(), message({
      id: "9002", senderId: "creator-1", attachments: [{ contentId: "media-1", contentType: 1, pos: 0 }],
    })] };
    const captured = await capture(pageId, payload, "v5-replies");
    // v5 ledger fixtures: text had no material; attached material explicitly
    // claimed there was no reply. Neither ordinary message key may change.
    const base = { occurredAt: messageAt, conversationRef: "group-1", transactionRef: null,
      observationId: captured.observationId, schemaVersion: 1 };
    await appendMixedDomainEvents(testDb.db, pageId, [
      { ...base, type: "message.received", messageRef: "9001", fanIdentityRef: "fan-1",
        data: { text: "<p>reply</p>", tipAmountMills: 0 }, dedupKey: "msg:received:9001" },
      { ...base, type: "message.sent", messageRef: "9002", fanIdentityRef: null,
        data: { text: "<p>reply</p>", tipAmountMills: 0 }, dedupKey: "msg:sent:9002" },
      { ...base, type: "message.material_observed", messageRef: "9002", fanIdentityRef: null,
        data: { head: { nativeMessageId: "9002", textHtml: "<p>reply</p>", isSentByMe: true,
          messageCreatedAt: messageAt.toISOString(), materialObservedAt: receivedAt.toISOString(),
          vendorChangedAt: null, originClass: "fansly_dm_sidecar", reply: null, media: [{ id: "media-1", type: "other" }],
          fieldPresence: { reply: true, media: true, tipText: false } } }, dedupKey: "v5-material-9002" },
    ], { observationId: captured.observationId, occurredAt: receivedAt, dedupKey: "v5-checkpoint" });
    await markObservationParsed(testDb.db, { ...captured, parseVersion: 5 });
    await runMessageArchiveProjection(app());
    expect((await transcript(pageId)).map((row) => row.inReplyToRef)).toEqual([null, null]);

    const replay = await runCanonicalization(app(), { kinds: ["dm_messages"], accountId: pageId });
    expect(replay).toMatchObject({ scanned: 1, stamped: 1, errored: 0, partitionBlocked: 0, deduped: 2 });
    await runMessageArchiveProjection(app());
    const repaired = await transcript(pageId);
    expect(repaired).toHaveLength(2);
    for (const row of repaired) {
      expect(row).toMatchObject({ inReplyToRef: "8999", replyMetadata: { messageId: "8999", rootMessageId: "8000" } });
    }
    const count = await testDb.pool.query("select count(*)::int as count from domain_events where type in ('message.received', 'message.sent') and account_id = $1", [pageId]);
    expect(count.rows[0].count).toBe(2);
    expect(await runCanonicalization(app(), { kinds: ["dm_messages"], accountId: pageId })).toMatchObject({ scanned: 0, appended: 0 });

    // Simulate a retry before the parse stamp commits: content-hash claims,
    // including the projection checkpoint, remain idempotent.
    await testDb.pool.query("update observations set parse_version = 5 where id = $1", [captured.observationId]);
    expect(await runCanonicalization(app(), { kinds: ["dm_messages"], accountId: pageId })).toMatchObject({ appended: 0, errored: 0 });
    await rebuildMessageArchiveProjection(app(), { accountId: pageId });
    expect((await transcript(pageId)).map((row) => row.replyMetadata)).toEqual(repaired.map((row) => row.replyMetadata));
  });

  it("preserves known parent/root across sparse material, clears only observed fields, and rejects stale replay", async () => {
    const pageId = await seedPage();
    let seq = 0;
    const apply = async (fields: Record<string, unknown>, offset: number) => {
      const item = message({ attachments: [{ contentId: "media-1" }], ...fields });
      // undefined is not a provider field: physically remove it from JSON.
      const payload = JSON.parse(JSON.stringify({ messages: [item] })) as unknown;
      const events = canonicalizeSyncPullObservation({ id: ++seq, source: "pull", producer: "sync:fansly:dm_messages",
        platform: "fansly", accountId: pageId, kind: "dm_messages", payload, observedAt: null,
        receivedAt: new Date(receivedAt.getTime() + offset * 1000),
      }, { nativeAccountRefByAccountId: new Map([[pageId, "creator-1"]]) });
      await applyMessageEventsToArchive(testDb.db, { accountId: pageId, platform: "fansly",
        events: events.filter((event) => event.type === "message.material_observed").map((event) => ({
          ...event, id: seq, accountSeq: seq, conversationRef: event.conversationRef ?? null,
          fanIdentityRef: event.fanIdentityRef ?? null, messageRef: event.messageRef ?? null,
        })),
      });
      return (await transcript(pageId))[0]!;
    };
    expect(await apply({}, 0)).toMatchObject({ inReplyToRef: "8999", replyMetadata: { rootMessageId: "8000" } });
    expect(await apply({ inReplyTo: undefined, inReplyToRoot: undefined }, 1))
      .toMatchObject({ inReplyToRef: "8999", replyMetadata: { rootMessageId: "8000" } });
    expect(await apply({ inReplyTo: "8999", inReplyToRoot: undefined }, 2))
      .toMatchObject({ inReplyToRef: "8999", replyMetadata: { rootMessageId: "8000" } });
    expect(await apply({ inReplyTo: undefined, inReplyToRoot: "8001" }, 3))
      .toMatchObject({ inReplyToRef: "8999", replyMetadata: { rootMessageId: "8001" } });
    expect(await apply({ inReplyTo: undefined, inReplyToRoot: null }, 4))
      .toMatchObject({ inReplyToRef: "8999", replyMetadata: { rootMessageId: null } });
    const changed = await apply({ inReplyTo: "8998", inReplyToRoot: undefined }, 5);
    expect(changed).toMatchObject({ inReplyToRef: "8998", replyMetadata: { messageId: "8998" } });
    expect(changed.replyMetadata?.rootMessageId).toBeNull();
    expect(await apply({}, 0)).toMatchObject({ inReplyToRef: "8998" });
    expect(await apply({ inReplyTo: null, inReplyToRoot: null }, 6)).toMatchObject({ inReplyToRef: null, replyMetadata: null });
    expect(await apply({ inReplyTo: undefined, inReplyToRoot: "8002" }, 7))
      .toMatchObject({ inReplyToRef: null, replyMetadata: { rootMessageId: "8002" } });
    expect(await apply({ inReplyTo: "8997", inReplyToRoot: undefined }, 8))
      .toMatchObject({ inReplyToRef: "8997", replyMetadata: { rootMessageId: "8002" } });
  });

  it("keeps OFAPI explicit-clear semantics in the shared archive writer", async () => {
    const pageId = await seedPage(true);
    for (const [index, replyToMessage] of [{ id: "8999", text: "parent" }, undefined, null].entries()) {
      await appendOfapiMessageMaterialPage(testDb.db, {
        accountId: pageId, observationId: index + 1, observationReceivedAt: new Date(receivedAt.getTime() + index * 1000),
        chatId: "group-1", originClass: "capture_background",
        items: [{ id: "9001", isSentByMe: false, text: "reply", fromUser: { id: "fan-1" },
          createdAt: messageAt.toISOString(), ...(replyToMessage === undefined ? { materialPresence: { reply: false } } : { replyToMessage }) }],
      });
      await runMessageArchiveProjection(app());
      const rows = await testDb.pool.query("select in_reply_to_ref, reply_metadata from message_archive where account_id = $1 and message_ref = '9001'", [pageId]);
      expect(rows.rows[0].in_reply_to_ref).toBe(index === 2 ? null : "8999");
      if (index === 2) expect(rows.rows[0].reply_metadata).toBeNull();
    }
  });
});
