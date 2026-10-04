import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireFanslyWsOwnership, applyFanslyWsLiveReceipt, beginFanslyWsConnection, captureFanslyWsFrame,
  confirmDmLiveMessages, DM_ARCHIVE_ERASURE_FENCE_LOCK_NS, DOMAIN_EVENTS_APPENDED_CHANNEL,
  finishFanslyWsConnection, FANSLY_WS_LIVE_OBSERVED_EVENT, isProjectionOnlyDomainEventType,
  listPendingFanslyWsLiveReceipts, readFanslyWsLiveGauges, upsertFanPages, upsertFans, type Database,
} from "@agency_hub_core/db";
import { readFanslyPageGeneration, readProbeGeneration } from "../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { applyFanslyWsLive, startFanslyWsLiveTimer } from "../apps/runtime/src/services/fansly-ws/live-apply.ts";
import { computeGoldenSignals } from "../apps/runtime/src/services/golden-signals.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { MESSAGE_EVENT_TYPES, runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import { resetIntegrationDatabase, seedFanslyPage, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { serviceFrame, wrapped } from "./helpers/fansly-ws-fixtures.ts";
import { waitForRowLockWait } from "./helpers/lock-waits.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Fansly Sync Engine step 1 "Оверлей" (plan §7, §15 step 1): one idempotent
// apply per captured frame writes the overlay, the deliverable
// `message.live_observed` event and the receipt ack in ONE transaction. The
// chaos cases kill (or fail) the apply between the frame commit and the overlay
// commit and prove the replay applies exactly once.

const PAGE_REF = "999";
const FAN = "700000000000000001";
const OTHER_FAN = "700000000000000002";
const GROUP = "800000000000000001";
const OTHER_GROUP = "800000000000000002";

let testDb: StartedTestDatabase;
let lakeDir: string;
const owners: NonNullable<Awaited<ReturnType<typeof acquireFanslyWsOwnership>>>[] = [];
beforeAll(async () => { testDb = await startTestDatabase(); lakeDir = await mkdtemp(join(tmpdir(), "live-overlay-")); }, 120_000);
afterAll(async () => { await testDb?.stop(); if (lakeDir) await rm(lakeDir, { recursive: true }); });
beforeEach(async () => { await resetIntegrationDatabase(testDb.pool); });
afterEach(async () => { vi.restoreAllMocks(); for (const owner of owners.splice(0)) await owner.close(); });

let nextMessageId = 900_000_000_000_000_100n;
function message(overrides: Record<string, unknown> = {}) {
  return {
    id: String(nextMessageId++), groupId: GROUP, senderId: FAN, createdAt: Date.now() / 1000 - 1,
    content: "hello", attachments: [], type: 1, correlationId: null, inReplyTo: null, ...overrides,
  } as Record<string, unknown> & { id: string; groupId: string; senderId: string; createdAt: number };
}
const created = (...messages: Record<string, unknown>[]) => messages.length === 1
  ? serviceFrame({ type: 1, message: messages[0] })
  : wrapped(10001, messages.map((item) => serviceFrame({ type: 1, message: item })));
const deleted = (id: string, groupId: string | null = GROUP) => serviceFrame({ type: 10, message: { id, groupId, type: 1 } });

const query = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
  (await testDb.pool.query(text, values)).rows as T[];
const count = async (table: string, where = "true") =>
  (await query<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`))[0]!.n;
const liveState = async (observationId: number) =>
  (await query<{ live_state: string }>("select live_state from fansly_ws_decode_receipts where observation_id=$1",
    [observationId]))[0]?.live_state;

async function fixture() {
  const app = createTestAppContext(testDb, { databaseUrl: testDb.connectionString });
  app.config.lakeDir = lakeDir;
  const { page } = await seedFanslyPage(app.db, app.config.encryptionKey);
  if (!page) throw new Error("seed failed");
  await saveProxy(app, page.id, { url: "http://proxy.example.test:8080", username: "test", password: "test" });
  await testDb.pool.query("update pages set external_page_id=$2 where id=$1", [page.id, PAGE_REF]);
  const generation = await readProbeGeneration(app.db, page.label);
  const owner = await acquireFanslyWsOwnership(testDb.connectionString, page.id, () => {});
  if (!owner) throw new Error("owner unavailable");
  owners.push(owner);
  let connectionId = randomUUID();
  let ordinal = 0;
  await beginFanslyWsConnection(owner.db, { id: connectionId, pageId: page.id, generation });
  const validate = async (tx: Database) => {
    if (await readFanslyPageGeneration(tx, page.label) !== generation) throw new Error("generation_fenced");
  };
  const capture = (frame: string, receivedAt = new Date()) => captureFanslyWsFrame(owner.db, {
    connectionId, pageId: page.id, generation, accountRef: PAGE_REF, ordinal: ++ordinal, frame, receivedAt, validate,
  });
  /** A new socket connection: the same frame gets a new observation. */
  const reconnect = async () => {
    await finishFanslyWsConnection(owner.db, connectionId, "closed");
    connectionId = randomUUID(); ordinal = 0;
    await beginFanslyWsConnection(owner.db, { id: connectionId, pageId: page.id, generation });
  };
  const apply = (observationId: number) => applyFanslyWsLiveReceipt(app.db, { observationId });
  return { app, page, generation, owner, capture, reconnect, apply };
}

describe("Fansly live overlay apply (plan §7.2)", () => {
  it("commits the overlay, one deliverable event per message (NOTIFY at commit) and the ack together", async () => {
    const f = await fixture();
    const fanMessage = message({ content: "hi there", inReplyTo: "900000000000000001",
      attachments: [{ contentType: 1, contentId: "600000000000000001", location: "https://cdn.example.test/a" }],
      totalTipAmount: 500 });
    const reply = message({ senderId: PAGE_REF, content: "hey" });
    const observationId = await f.capture(created(fanMessage, reply));
    expect(await query("select state,live_state from fansly_ws_decode_receipts"))
      .toEqual([{ state: "pending", live_state: "pending" }]);

    const listener = new Client({ connectionString: testDb.connectionString });
    await listener.connect();
    try {
      await listener.query(`listen ${DOMAIN_EVENTS_APPENDED_CHANNEL}`);
      const notified = new Promise<string | undefined>((resolve) => {
        listener.once("notification", (notice) => resolve(notice.payload));
      });
      expect(await f.apply(observationId))
        .toEqual({ status: "applied", created: 2, deleted: 0, fenced: 0, invalid: 0, events: 2 });
      expect(await notified).toBe(`${f.page.id}:2`);
    } finally { await listener.end(); }

    const rows = await query(`select platform_message_id, platform_conversation_id, sender_platform_user_id,
      is_sent_by_page, content, in_reply_to_message_id, attachments, field_mask, decoder_version,
      source_observation_id::int, first_visible_at is not null as visible, confirm_due_at > first_visible_at as due_later,
      deleted_at, created_at from dm_live_messages order by platform_message_id`);
    expect(rows).toEqual([
      expect.objectContaining({ platform_message_id: fanMessage.id, platform_conversation_id: GROUP,
        sender_platform_user_id: FAN, is_sent_by_page: false, content: "hi there",
        in_reply_to_message_id: "900000000000000001",
        attachments: [{ contentType: 1, contentId: "600000000000000001" }], decoder_version: 1,
        source_observation_id: observationId, visible: true, due_later: true, deleted_at: null }),
      expect.objectContaining({ platform_message_id: reply.id, sender_platform_user_id: PAGE_REF,
        is_sent_by_page: true, content: "hey" }),
    ]);
    expect((rows[0]!.created_at as Date).getTime()).toBe(Math.round(fanMessage.createdAt * 1000));
    // Money never comes from the socket.
    expect(JSON.stringify(rows)).not.toMatch(/cdn\.example|500/);

    const events = await query(`select type, fan_identity_ref, conversation_ref, message_ref, dedup_key,
      observation_id::int, data from domain_events order by account_seq`);
    expect(events).toEqual([
      { type: FANSLY_WS_LIVE_OBSERVED_EVENT, fan_identity_ref: FAN, conversation_ref: GROUP,
        message_ref: fanMessage.id, dedup_key: `ws-msg:v1:${fanMessage.id}`, observation_id: observationId,
        data: expect.objectContaining({ text: "hi there", senderRef: FAN, sentByPage: false, confirmed: false,
          attachments: [{ contentType: 1, contentRef: "600000000000000001" }] }) },
      expect.objectContaining({ fan_identity_ref: null, message_ref: reply.id,
        data: expect.objectContaining({ sentByPage: true }) }),
    ]);
    // Deliverable to SSE v2, and not a message_archive input.
    expect(isProjectionOnlyDomainEventType(FANSLY_WS_LIVE_OBSERVED_EVENT)).toBe(false);
    expect(MESSAGE_EVENT_TYPES.has(FANSLY_WS_LIVE_OBSERVED_EVENT)).toBe(false);
    await runMessageArchiveProjection(f.app);
    expect(await count("message_archive")).toBe(0);

    expect(await query("select state, live_state, live_decoder_version from fansly_ws_decode_receipts"))
      .toEqual([{ state: "retained", live_state: "applied", live_decoder_version: 1 }]);
    // Idempotent per receipt: an acked receipt is never taken again.
    expect(await f.apply(observationId)).toEqual({ status: "not_pending" });
    expect(await listPendingFanslyWsLiveReceipts(f.app.db, { limit: 10 })).toEqual([]);
    // Step 1 creates no work: no sync request, B1 subject or hint receipt.
    expect(await count("page_sync_states", "requested_at is not null")).toBe(0);
    expect(await count("subject_refresh_state")).toBe(0);
    expect(await count("fansly_ws_hint_receipts")).toBe(0);
  });

  it.each([
    ["the ack", "fansly_ws_decode_receipts", "before update", "new.live_state <> 'pending'"],
    ["the event", "domain_event_keys", "before insert", "true"],
  ])("chaos: a failure at %s rolls back overlay, event and ack; the timer replay applies exactly once",
    async (_label, table, timing, when) => {
      const f = await fixture();
      const item = message();
      const observationId = await f.capture(created(item));
      await testDb.pool.query(`create function live_chaos() returns trigger language plpgsql as $$
        begin raise exception 'injected'; end $$;
        create trigger live_chaos ${timing} on ${table} for each row when (${when}) execute function live_chaos()`);
      try {
        await expect(f.apply(observationId)).rejects.toThrow();
        // The worker paths swallow the failure (fixed class only) and leave it for replay.
        expect(await applyFanslyWsLive(f.app, observationId)).toBeNull();
        expect(await count("dm_live_messages")).toBe(0);
        expect(await count("domain_events")).toBe(0);
        expect(await count("domain_event_keys")).toBe(0);
        expect(await liveState(observationId)).toBe("pending");
      } finally {
        await testDb.pool.query(`drop trigger live_chaos on ${table}; drop function live_chaos()`);
      }
      const timer = startFanslyWsLiveTimer(f.app, {
        timing: { intervalMs: 50, replayMinAgeMs: 0, replayBatch: 10, parityBatch: 10 },
      });
      try {
        await vi.waitFor(async () => expect(await liveState(observationId)).toBe("applied"));
      } finally { await timer.stop(); }
      expect(await count("dm_live_messages")).toBe(1);
      expect(await count("domain_events", `type='${FANSLY_WS_LIVE_OBSERVED_EVENT}'`)).toBe(1);
      expect(await f.apply(observationId)).toEqual({ status: "not_pending" });
    });

  it("a duplicate frame on a new connection is a new receipt but no second row or event", async () => {
    const f = await fixture();
    const item = message();
    const first = await f.capture(created(item));
    await f.reconnect();
    const second = await f.capture(created(item));
    expect(second).not.toBe(first);
    expect(await f.apply(first)).toMatchObject({ status: "applied", created: 1, events: 1 });
    expect(await f.apply(second)).toMatchObject({ status: "applied", created: 0, events: 0 });
    expect(await query("select source_observation_id::int as id from dm_live_messages")).toEqual([{ id: first }]);
    expect(await count("domain_events")).toBe(1);
  });

  it("concurrent appliers on frames naming the same messages in opposite order neither deadlock nor duplicate", async () => {
    const f = await fixture();
    for (let round = 0; round < 5; round++) {
      const a = message();
      const b = message();
      const first = await f.capture(created(a, b));
      await f.reconnect();
      const second = await f.capture(created(b, a));
      const results = await Promise.all([f.apply(first), f.apply(second), f.apply(first)]);
      expect(results.filter((result) => result.status === "applied")).toHaveLength(2);
      expect(results.map((result) => "events" in result ? result.events : 0).reduce((sum, n) => sum + n, 0)).toBe(2);
    }
    expect(await count("dm_live_messages")).toBe(10);
    expect(await count("domain_events")).toBe(10);
  });

  it("deletion is sticky: a stub before the create, kept by a late create, a replay or a second deletion", async () => {
    const f = await fixture();
    const early = message();
    const deletion = await f.capture(deleted(early.id));
    expect(await f.apply(deletion)).toEqual({ status: "applied", created: 0, deleted: 1, fenced: 0, invalid: 0, events: 0 });
    const [stub] = await query<{ sender_platform_user_id: string | null; deleted_at: Date; first_visible_at: Date | null;
      confirm_due_at: Date | null }>(`select sender_platform_user_id, deleted_at, first_visible_at, confirm_due_at
      from dm_live_messages`);
    expect(stub).toMatchObject({ sender_platform_user_id: null, first_visible_at: null, confirm_due_at: null });
    const create = await f.capture(created(early));
    // The stub is filled (content arrives) under the mark; nothing is news.
    expect(await f.apply(create)).toEqual({ status: "applied", created: 0, deleted: 0, fenced: 0, invalid: 0, events: 0 });
    expect(await query("select sender_platform_user_id, content, deleted_at from dm_live_messages"))
      .toEqual([{ sender_platform_user_id: FAN, content: "hello", deleted_at: stub!.deleted_at }]);

    const late = message();
    expect(await f.apply(await f.capture(created(late)))).toMatchObject({ created: 1, events: 1 });
    const markedAt = new Date(Date.now() - 1_000);
    expect(await f.apply(await f.capture(deleted(late.id, null), markedAt))).toMatchObject({ deleted: 1 });
    expect(await f.apply(await f.capture(deleted(late.id)))).toMatchObject({ status: "applied", deleted: 0 });
    await f.reconnect();
    expect(await f.apply(await f.capture(created(late)))).toMatchObject({ created: 0, events: 0 });
    expect(await query("select deleted_at, platform_conversation_id from dm_live_messages where platform_message_id=$1",
      [late.id])).toEqual([{ deleted_at: markedAt, platform_conversation_id: GROUP }]);
    // Created and deleted in one frame: the content is kept under the mark and
    // nothing was ever visible, so there is no event.
    const both = message({ content: "gone" });
    expect(await f.apply(await f.capture(wrapped(10001, [created(both), deleted(both.id)]))))
      .toEqual({ status: "applied", created: 0, deleted: 1, fenced: 0, invalid: 0, events: 0 });
    expect(await query<{ content: string; deleted: boolean }>(`select content, deleted_at is not null as deleted
      from dm_live_messages where platform_message_id=$1`, [both.id])).toEqual([{ content: "gone", deleted: true }]);
    expect(await count("domain_events")).toBe(1);
  });

  it("an erasure in flight defers the apply; an executed erasure fences the erased fan's material", async () => {
    const f = await fixture();
    const observationId = await f.capture(created(message()));
    const holder = await testDb.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock($1, $2)", [DM_ARCHIVE_ERASURE_FENCE_LOCK_NS, f.page.id]);
      expect(await f.apply(observationId)).toEqual({ status: "erasure_busy" });
      expect(await liveState(observationId)).toBe("pending");
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    expect(await f.apply(observationId)).toMatchObject({ status: "applied", created: 1 });

    const fenced = message({ senderId: OTHER_FAN, groupId: OTHER_GROUP });
    const later = await f.capture(created(fenced, message()));
    const ownerId = (await query<{ id: string }>("insert into users(username,role) values ('live-owner','owner') returning id"))[0]!.id;
    await testDb.pool.query(`insert into erasure_log(scope_type, scope_ref, initiated_by, dry_run, plan, started_at)
      values ('fan', $1, $2, false, '{}'::jsonb, now())`, [`fan:fansly:${OTHER_FAN}`, ownerId]);
    expect(await f.apply(later)).toEqual({ status: "applied", created: 1, deleted: 0, fenced: 1, invalid: 0, events: 1 });
    expect(await count("dm_live_messages", `sender_platform_user_id='${OTHER_FAN}'`)).toBe(0);
    expect(await count("domain_events", `fan_identity_ref='${OTHER_FAN}'`)).toBe(0);
  });

  it("a frame without a required field is debt; a frame without messages is skipped", async () => {
    const f = await fixture();
    const { senderId: _drop, ...noSender } = message();
    const debt = await f.capture(wrapped(10001, [serviceFrame({ type: 1, message: noSender }), created(message())]));
    expect(await f.apply(debt)).toEqual({ status: "debt", created: 1, deleted: 0, fenced: 0, invalid: 1, events: 1 });
    const other = await f.capture(serviceFrame({ type: 8, id: OTHER_GROUP }, 4));
    expect(await f.apply(other)).toEqual({ status: "skipped", created: 0, deleted: 0, fenced: 0, invalid: 0, events: 0 });
    expect(await query("select live_state from fansly_ws_decode_receipts order by observation_id"))
      .toEqual([{ live_state: "debt" }, { live_state: "skipped" }]);
  });

  it("vendor text Postgres would refuse (a lone surrogate, a NUL) becomes visible with U+FFFD in its place", async () => {
    const f = await fixture();
    // A fan's broken emoji (high or low half alone), a stray NUL, a type past
    // the integer column: each once made every apply attempt fail the same way.
    const high = message({ content: "love you \ud83d" });
    const low = message({ content: "\udc00 low first" });
    const nul = message({ content: "nul\u0000byte" });
    const wide = message({ type: 2 ** 31 });
    const observationId = await f.capture(created(high, low, nul, wide));
    expect(await f.apply(observationId))
      .toEqual({ status: "applied", created: 4, deleted: 0, fenced: 0, invalid: 0, events: 4 });
    const rows = await query<{ id: string; content: string; message_type: number | null }>(`select
      platform_message_id as id, content, message_type from dm_live_messages order by platform_message_id`);
    expect(rows).toEqual([
      { id: high.id, content: "love you �", message_type: 1 },
      { id: low.id, content: "� low first", message_type: 1 },
      { id: nul.id, content: "nul�byte", message_type: 1 },
      { id: wide.id, content: "hello", message_type: null },
    ]);
    expect((await query<{ text: string }>(`select data->>'text' as text from domain_events
      order by message_ref`)).map((event) => event.text))
      .toEqual(["love you �", "� low first", "nul�byte", "hello"]);
    expect(await query("select state, live_state from fansly_ws_decode_receipts"))
      .toEqual([{ state: "retained", live_state: "applied" }]);
  });

  it("a frame the database refuses on every attempt is acked as debt, never left pending", async () => {
    const f = await fixture();
    const refused = message({ content: "refused" });
    const neighbour = message();
    const observationId = await f.capture(created(refused, neighbour));
    const later = await f.capture(created(message({ content: "refused" })));
    // Stands in for any value the decoder did not foresee and Postgres refuses
    // (class 22, the same on every retry). A transient failure (the chaos
    // cases above) keeps the receipt pending instead.
    await testDb.pool.query(`create function live_refuse() returns trigger language plpgsql as $$
      begin raise exception 'refused' using errcode = 'invalid_text_representation'; end $$;
      create trigger live_refuse before insert on dm_live_messages for each row
        when (new.content = 'refused') execute function live_refuse()`);
    try {
      // The frame's writes roll back to the savepoint (its neighbour too);
      // the ack and the legacy metadata settle commit.
      expect(await f.apply(observationId)).toEqual({ status: "debt", dataError: "22P02",
        created: 0, deleted: 0, fenced: 0, invalid: 2, events: 0 });
      const warn = vi.spyOn(f.app.logger, "warn");
      expect(await applyFanslyWsLive(f.app, later)).toMatchObject({ status: "debt", dataError: "22P02" });
      expect(warn).toHaveBeenCalledWith({ observationId: later, errorClass: "22P02" }, expect.stringContaining("acked as debt"));
    } finally {
      await testDb.pool.query("drop trigger live_refuse on dm_live_messages; drop function live_refuse()");
    }
    expect(await count("dm_live_messages")).toBe(0);
    expect(await count("domain_events")).toBe(0);
    expect(await query(`select state, live_state, live_applied_at is not null as acked
      from fansly_ws_decode_receipts order by observation_id`))
      .toEqual([{ state: "retained", live_state: "debt", acked: true }, { state: "retained", live_state: "debt", acked: true }]);
    expect(await listPendingFanslyWsLiveReceipts(f.app.db, { limit: 10 })).toEqual([]);
    expect(await f.apply(observationId)).toEqual({ status: "not_pending" });
    const gauges = await readFanslyWsLiveGauges(f.app.db, { windowMinutes: 10 });
    expect(gauges).toMatchObject({ pendingAgeMs: 0, decodeDebt24h: 2 });
  });

  it("the timer walks past receipts that keep failing, so they never starve the ones behind them", async () => {
    const f = await fixture();
    const stuck: number[] = [];
    for (let i = 0; i < 3; i++) stuck.push(await f.capture(created(message({ content: "stuck" }))));
    const behind = await f.capture(created(message()));
    // A transient failure on every attempt (not a data error): those receipts stay pending.
    await testDb.pool.query(`create function live_stuck() returns trigger language plpgsql as $$
      begin raise exception 'stuck'; end $$;
      create trigger live_stuck before insert on dm_live_messages for each row
        when (new.content = 'stuck') execute function live_stuck()`);
    const timer = startFanslyWsLiveTimer(f.app, {
      timing: { intervalMs: 50, replayMinAgeMs: 0, replayBatch: 2, parityBatch: 10 },
    });
    try {
      await vi.waitFor(async () => expect(await liveState(behind)).toBe("applied"));
    } finally {
      await timer.stop();
      await testDb.pool.query("drop trigger live_stuck on dm_live_messages; drop function live_stuck()");
    }
    expect(await listPendingFanslyWsLiveReceipts(f.app.db, { limit: 10 })).toEqual(stuck);
    expect(await listPendingFanslyWsLiveReceipts(f.app.db, { limit: 10, afterObservationId: stuck[1]! }))
      .toEqual([stuck[2]]);
  });

  it("fan and page erasure reach the overlay, including a chat only the socket has named", async () => {
    const f = await fixture();
    const fans = await upsertFans(f.app.db, [FAN, OTHER_FAN].map((platformUserId) => ({ platform: "fansly" as const, platformUserId })));
    await upsertFanPages(f.app.db, fans.map((fan) => ({ fanId: fan.id, platformAccountId: f.page.id })));
    await f.apply(await f.capture(created(message())));
    await f.apply(await f.capture(created(message({ senderId: PAGE_REF }))));
    await f.apply(await f.capture(created(message({ senderId: OTHER_FAN, groupId: OTHER_GROUP }))));
    const ownerId = Number((await query<{ id: string }>("insert into users(username,role) values ('live-owner','owner') returning id"))[0]!.id);
    const scope = { scopeType: "fan", platform: "fansly", fanRef: FAN } as const;
    const plan = await planErasure(f.app, scope);
    expect(plan.resolvedFanGroupIds).toContain(GROUP);
    expect(plan.targets.find((target) => target.target === "dm_live_messages")?.rows).toBe(2);
    await executeErasure(f.app, scope, { initiatedBy: ownerId });
    expect(await query("select sender_platform_user_id from dm_live_messages")).toEqual([{ sender_platform_user_id: OTHER_FAN }]);
    expect(await count("domain_events", `conversation_ref='${GROUP}'`)).toBe(0);
    await executeErasure(f.app, { scopeType: "page", pageLabel: f.page.label }, { initiatedBy: ownerId });
    expect(await count("dm_live_messages")).toBe(0);
  });
});

describe("passive parity and golden signals", () => {
  it("confirms against the legacy stores, field by field, and reports not_found and excluded chats apart", async () => {
    const f = await fixture();
    const fans = await upsertFans(f.app.db, [FAN, OTHER_FAN].map((platformUserId) => ({ platform: "fansly" as const, platformUserId })));
    const fanId = (ref: string) => fans.find((fan) => fan.platformUserId === ref)!.id;
    const thread = (await query<{ id: string }>(`insert into page_dm_threads(platform_account_id, fan_id, platform_conversation_id)
      values ($1, $2, $3) returning id`, [f.page.id, fanId(FAN), GROUP]))[0]!.id;
    await testDb.pool.query(`insert into page_dm_threads(platform_account_id, fan_id, platform_conversation_id, metadata)
      values ($1, $2, $3, '{"messageSyncExcludedReason":"partner_missing_from_aggregation_accounts"}')`,
    [f.page.id, fanId(OTHER_FAN), OTHER_GROUP]);
    const hot = message({ content: "same" });
    const archived = message({ content: "socket text" });
    const missing = message();
    const excluded = message({ senderId: OTHER_FAN, groupId: OTHER_GROUP });
    const young = message();
    await f.apply(await f.capture(created(hot, archived, missing, excluded, young)));
    await testDb.pool.query(`insert into page_dm_messages(conversation_id, platform_account_id, platform_message_id,
      sender_platform_user_id, sender_role, created_at, content) values ($1, $2, $3, $4, 'fan', to_timestamp($5), 'same')`,
    [thread, f.page.id, hot.id, FAN, Math.floor(hot.createdAt)]);
    await testDb.pool.query(`insert into message_archive(account_id, platform, conversation_ref, message_ref, is_sent_by_me,
      occurred_at, text_plain) values ($1, 'fansly', $2, $3, false, to_timestamp($4), 'rest text')`,
    [f.page.id, GROUP, archived.id, archived.createdAt]);
    await testDb.pool.query("update dm_live_messages set confirm_due_at = now() - interval '1 second'");
    await testDb.pool.query(`update dm_live_messages set first_visible_at = now() - interval '25 hours'
      where platform_message_id in ($1, $2)`, [missing.id, excluded.id]);

    expect(await confirmDmLiveMessages(f.app.db, { limit: 10 }))
      .toEqual({ checked: 5, match: 1, mismatch: 1, notFound: 1, excluded: 1, rescheduled: 1 });
    const verdicts = await query(`select platform_message_id as id, confirm_outcome, confirm_source, mismatch_fields,
      confirmed_at is not null as confirmed, confirm_due_at > now() as later from dm_live_messages`);
    const byId = new Map(verdicts.map((row) => [row.id, row]));
    expect(byId.get(hot.id)).toMatchObject({ confirm_outcome: "match", confirm_source: "page_dm_messages", confirmed: true });
    expect(byId.get(archived.id)).toMatchObject({ confirm_outcome: "mismatch", confirm_source: "message_archive",
      mismatch_fields: ["text"] });
    expect(byId.get(missing.id)).toMatchObject({ confirm_outcome: "not_found", confirm_source: null, confirmed: true });
    expect(byId.get(excluded.id)).toMatchObject({ confirm_outcome: "excluded", confirmed: true });
    expect(byId.get(young.id)).toMatchObject({ confirm_outcome: null, confirmed: false, later: true });
    expect((await confirmDmLiveMessages(f.app.db, { limit: 10 })).checked).toBe(0);

    // One debt receipt and one receipt nobody applied for a minute.
    const { senderId: _drop, ...noSender } = message();
    await f.apply(await f.capture(serviceFrame({ type: 1, message: noSender })));
    await f.capture(created(message()), new Date(Date.now() - 60_000));
    const gauges = await readFanslyWsLiveGauges(f.app.db, { windowMinutes: 10 });
    expect(gauges.parityBasisPoints).toBe(5_000);
    expect(gauges.decodeDebt24h).toBe(1);
    expect(gauges.pendingAgeMs).toBeGreaterThanOrEqual(59_000);
    expect(gauges.visibleLagP95Ms).toBeGreaterThan(500);
    expect(gauges.visibleLagP95Ms).toBeLessThan(60_000);

    const { samples, failedProbes } = await computeGoldenSignals({ db: testDb.db });
    // (sse_delivery has no smoke checkpoint in this database.)
    expect(failedProbes).not.toContain("ws_live_pending_age");
    const sample = (metric: string) => samples.find((item) => item.metric === metric && item.quantile === "p95")?.valueMs;
    expect(sample("dm_visible_lag")).toBeGreaterThan(500);
    expect(sample("ws_live_pending_age")).toBeGreaterThanOrEqual(59_000);
    expect(sample("dm_live_parity_bp")).toBe(5_000);
    expect(sample("ws_decode_debt")).toBe(1);
  });
});

describe("a process killed mid-apply", () => {
  it("a real process killed after its overlay insert, before commit, leaves the receipt pending; replay applies once", async () => {
    const f = await fixture();
    const item = message();
    const observationId = await f.capture(created(item));
    // Hold the page's event counter so the child parks after its overlay insert.
    await testDb.pool.query("insert into domain_event_seq(account_id) values ($1) on conflict do nothing", [f.page.id]);
    const holder = await testDb.pool.connect();
    const url = new URL(testDb.connectionString);
    url.searchParams.set("application_name", "fansly-live-child");
    const child = spawn(process.execPath, ["--import", "tsx/esm", "tests/helpers/fansly-ws-live-apply-child.ts"], {
      env: { ...process.env, DATABASE_URL: url.toString(), OBSERVATION_ID: String(observationId) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      await holder.query("begin");
      await holder.query("select next_seq from domain_event_seq where account_id = $1 for update", [f.page.id]);
      await waitForRowLockWait(testDb.pool, ["%domain_event_seq%"], { timeoutMs: 30_000 });
      // The overlay row is written but uncommitted: invisible outside the child.
      expect(await count("dm_live_messages")).toBe(0);
      child.kill("SIGKILL");
      await exited;
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    // The orphaned backend rolls back once it finds its client gone.
    await vi.waitFor(async () => expect((await query<{ n: number }>(`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and application_name = 'fansly-live-child'`))[0]!.n).toBe(0), { timeout: 20_000 });
    expect(await count("dm_live_messages")).toBe(0);
    expect(await count("domain_events")).toBe(0);
    expect(await liveState(observationId)).toBe("pending");
    expect(await f.apply(observationId)).toMatchObject({ status: "applied", created: 1, events: 1 });
    expect(await f.apply(observationId)).toEqual({ status: "not_pending" });
    expect(await count("dm_live_messages")).toBe(1);
    expect(await count("domain_events")).toBe(1);
  }, 60_000);
});
