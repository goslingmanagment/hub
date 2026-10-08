import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireFanslyWsOwnership,
  applyFanslyWsLiveReceipt,
  beginFanslyWsConnection,
  captureFanslyWsFrame,
  createOnlyFansPage,
  getPageConversationMessages,
  getPageConversationPreview,
  listAgentTranscript,
  listArchiveConversationMessages,
  upsertFans,
  upsertPageDmConversation,
  upsertPageDmMessages,
  type Database,
} from "@agency_hub_core/db";
import { FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { loadTranscriptContext } from "../apps/runtime/src/modules/ai/index.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { readFanslyPageGeneration, readProbeGeneration } from "../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { pageReadsLiveOverlay } from "../apps/runtime/src/services/live-overlay-read.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { resetIntegrationDatabase, seedFanslyPage, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { serviceFrame } from "./helpers/fansly-ws-fixtures.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Fansly Sync Engine step 1 «показ читателям» (plan §7.11, §15 step 1): the
// chatter routes and the AI kernel context of a page in
// `fanslyLiveOverlayReadPages` read "REST store ∪ unconfirmed overlay" through
// one union function; `none` restores the confirmed-only readers exactly;
// Agent Read and the archive routes never read the overlay.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const PAGE_REF = "999";
const FAN = "700000000000000001";
const EXCLUDED_FAN = "700000000000000002";
const GROUP = "800000000000000001";
const OTHER_GROUP = "800000000000000002";
const EXCLUDED_GROUP = "800000000000000003";
const UNKNOWN_GROUP = "800000000000000009";

let testDb: StartedTestDatabase;
const owners: NonNullable<Awaited<ReturnType<typeof acquireFanslyWsOwnership>>>[] = [];
const servers: Array<Awaited<ReturnType<typeof buildApiServer>>> = [];
beforeAll(async () => { testDb = await startTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(testDb.pool); });
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  for (const server of servers.splice(0)) await server.close();
});

const base = new Date(Date.now() - 60 * 60_000);
const at = (seconds: number) => new Date(base.getTime() + seconds * 1000);

async function fixture() {
  const app = createTestAppContext(testDb, { databaseUrl: testDb.connectionString });
  const { page: seeded } = await seedFanslyPage(app.db, app.config.encryptionKey, 1, "ari-1");
  if (!seeded) throw new Error("seed failed");
  const page = seeded;
  await testDb.pool.query("update pages set external_page_id=$2 where id=$1", [page.id, PAGE_REF]);
  const [fan, excludedFan] = await upsertFans(app.db, [
    { platform: "fansly", platformUserId: FAN },
    { platform: "fansly", platformUserId: EXCLUDED_FAN },
  ]);
  const thread = async (group: string, partner: string, fanId: number, metadata: Record<string, unknown> = {}) => {
    const row = await upsertPageDmConversation(app.db, {
      platformAccountId: page.id, fanId, platformConversationId: group,
      partnerPlatformUserId: partner, partnerUsername: null, partnerDisplayName: null,
      conversationFlags: 0, unreadCount: 0, subscriptionTierId: null,
      lastMessageId: null, lastUnreadMessageId: null, lastMessageAt: at(0),
      lastMessageSenderId: partner, lastMessageSenderRole: "fan", lastMessagePreview: null,
      messageCoverageStatus: "complete", newestStoredMessageId: null, oldestStoredMessageId: null,
      storedMessageCount: 0, lastMessageSyncAt: at(0), isVisible: true, lastSeenGeneration: 1, metadata,
    });
    if (!row) throw new Error("thread missing");
    return row;
  };
  const main = await thread(GROUP, FAN, fan!.id);
  const other = await thread(OTHER_GROUP, FAN, fan!.id);
  const excluded = await thread(EXCLUDED_GROUP, EXCLUDED_FAN, excludedFan!.id, {
    [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY]: "partner_missing_from_aggregation_accounts",
  });
  const hot = (conversationId: number, id: string, seconds: number, content: string, input: {
    sender?: string; tip?: number;
  } = {}) => ({
    conversationId, platformAccountId: page.id, platformMessageId: id,
    senderPlatformUserId: input.sender ?? FAN, senderRole: input.sender === PAGE_REF ? "model" as const : "fan" as const,
    createdAt: at(seconds), content, totalTipAmountCents: input.tip ?? 0,
    inReplyToMessageId: null, inReplyToRootMessageId: null,
  });
  /** An overlay row as the apply writes it (a create, or a deletion stub). */
  const live = async (id: string, input: {
    group?: string | null; sender?: string | null; sentByPage?: boolean | null; seconds?: number | null;
    content?: string | null; deleted?: boolean; outcome?: string | null; source?: string | null;
  }) => {
    const created = input.seconds === null ? null : at(input.seconds ?? 0);
    await testDb.pool.query(`
      insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
        is_sent_by_page, created_at, content, decoder_version, first_visible_at, confirm_due_at,
        confirmed_at, confirm_source, confirm_outcome, deleted_at)
      values ($1, $2, $3, $4, $5, $6, $7, 1, $6, $6, $8, $9, $10, $11)`, [
      page.id, id, input.group === undefined ? GROUP : input.group,
      input.sender === undefined ? FAN : input.sender,
      input.sentByPage === undefined ? (input.sender ?? FAN) === PAGE_REF : input.sentByPage,
      created, input.content === undefined ? `live ${id}` : input.content,
      input.outcome ? new Date() : null, input.source ?? null, input.outcome ?? null,
      input.deleted ? new Date() : null,
    ]);
  };
  const archive = async (id: string, seconds: number, text: string, input: {
    group?: string; mine?: boolean; deleted?: boolean; tipMills?: number;
  } = {}) => {
    await testDb.pool.query(`
      insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id,
        is_sent_by_me, occurred_at, text_plain, is_tip, tip_amount_mills, deleted_at)
      values ($1, 'fansly', $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [
      page.id, input.group ?? GROUP, id, input.mine ? null : FAN, input.mine === true, at(seconds), text,
      (input.tipMills ?? 0) > 0, input.tipMills ?? 0, input.deleted ? at(seconds + 1) : null,
    ]);
  };
  return { app, page, main, other, excluded, hot, live, archive };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The chatter fixture: REST rows, overlay rows of every kind. */
async function seedChat(f: Fixture) {
  await upsertPageDmMessages(f.app.db, [
    f.hot(f.main.id, "900000000000000101", 0, "first", { tip: 500 }),
    f.hot(f.main.id, "900000000000000102", 60, "second", { sender: PAGE_REF }),
    f.hot(f.main.id, "900000000000000103", 120, "third"),
    f.hot(f.other.id, "900000000000000201", 125, "other chat"),
  ]);
  // A REST-deleted copy: its socket create must never bring it back.
  await upsertPageDmMessages(f.app.db, [f.hot(f.main.id, "900000000000000104", 150, "gone")]);
  await testDb.pool.query("update page_dm_messages set deleted_at = now() where platform_message_id = $1",
    ["900000000000000104"]);

  await f.live("900000000000000110", { seconds: 180 }); // visible: no REST copy yet
  await f.live("900000000000000103", { seconds: 120, content: "third (socket)" }); // REST copy wins
  await f.live("900000000000000102", { sender: null, sentByPage: null, seconds: null, content: null, deleted: true });
  await f.live("900000000000000111", { seconds: 200, deleted: true }); // deleted on the socket
  await f.live("900000000000000112", { seconds: 210, outcome: "not_found" }); // REST never had it
  await f.live("900000000000000104", { seconds: 150 }); // REST tombstone dominates
  await f.live("900000000000000113", { seconds: 220, sender: PAGE_REF, content: "live reply" });
  await f.live("900000000000000114", { seconds: 215, group: OTHER_GROUP });
  // Confirmed through the archive only (the AI fast lane's copy): still not in
  // page_dm_messages, so the chatter routes keep showing it.
  await f.live("900000000000000115", { seconds: 230, outcome: "match", source: "message_archive" });
  await f.archive("900000000000000115", 230, "live 900000000000000115");
  await f.live("900000000000000116", { seconds: 240, content: null }); // a create without text
  await f.live("900000000000000117", { seconds: 245, group: UNKNOWN_GROUP });
}

const messageIds = (rows: Array<{ messageId: string }>) => rows.map((row) => row.messageId);

describe("live overlay readers: chatter routes (plan §7.11)", () => {
  it("serves page_dm_messages ∪ unconfirmed overlay with provenance; off is the confirmed-only read", async () => {
    const f = await fixture();
    await seedChat(f);
    const read = (liveOverlay?: boolean, limit?: number) => getPageConversationMessages(f.app.db, {
      platformAccountId: f.page.id, platformConversationId: GROUP,
      ...(limit === undefined ? {} : { limit }), ...(liveOverlay === undefined ? {} : { liveOverlay }),
    });

    const confirmedOnly = await read();
    expect(messageIds(confirmedOnly!.messages)).toEqual(["900000000000000103", "900000000000000102", "900000000000000101"]);
    expect(confirmedOnly!.messages.every((message) => !("provenance" in message))).toBe(true);
    expect(await read(false)).toEqual(confirmedOnly);

    const union = await read(true);
    expect(union!.conversation).toEqual(confirmedOnly!.conversation);
    expect(union!.messages).toEqual([
      { messageId: "900000000000000115", senderRole: "fan", content: "live 900000000000000115", createdAt: at(230),
        tipAmountCents: 0, provenance: { source: "live", apiUnavailable: false } },
      { messageId: "900000000000000113", senderRole: "model", content: "live reply", createdAt: at(220),
        tipAmountCents: 0, provenance: { source: "live", apiUnavailable: false } },
      { messageId: "900000000000000110", senderRole: "fan", content: "live 900000000000000110", createdAt: at(180),
        tipAmountCents: 0, provenance: { source: "live", apiUnavailable: false } },
      { messageId: "900000000000000103", senderRole: "fan", content: "third", createdAt: at(120),
        tipAmountCents: 0, provenance: { source: "rest" } },
      // 102 is gone: the socket deleted it, ahead of the legacy reconcile.
      { messageId: "900000000000000101", senderRole: "fan", content: "first", createdAt: at(0),
        tipAmountCents: 500, provenance: { source: "rest" } },
    ]);
    expect(messageIds((await read(true, 2))!.messages)).toEqual(["900000000000000115", "900000000000000113"]);

    const other = await getPageConversationMessages(f.app.db, {
      platformAccountId: f.page.id, platformConversationId: OTHER_GROUP, liveOverlay: true,
    });
    expect(messageIds(other!.messages)).toEqual(["900000000000000114", "900000000000000201"]);
  });

  it("previews the newest window of the union oldest first", async () => {
    const f = await fixture();
    await seedChat(f);
    const preview = await getPageConversationPreview(f.app.db, {
      platformAccountId: f.page.id, platformConversationId: GROUP, limit: 4, liveOverlay: true,
    });
    expect(preview!.messages).toEqual([
      { platformMessageId: "900000000000000103", senderPlatformUserId: FAN, senderRole: "fan", createdAt: at(120),
        content: "third", totalTipAmountCents: 0, provenance: { source: "rest" } },
      { platformMessageId: "900000000000000110", senderPlatformUserId: FAN, senderRole: "fan", createdAt: at(180),
        content: "live 900000000000000110", totalTipAmountCents: 0, provenance: { source: "live", apiUnavailable: false } },
      { platformMessageId: "900000000000000113", senderPlatformUserId: PAGE_REF, senderRole: "model",
        createdAt: at(220), content: "live reply", totalTipAmountCents: 0,
        provenance: { source: "live", apiUnavailable: false } },
      { platformMessageId: "900000000000000115", senderPlatformUserId: FAN, senderRole: "fan", createdAt: at(230),
        content: "live 900000000000000115", totalTipAmountCents: 0,
        provenance: { source: "live", apiUnavailable: false } },
    ]);
    const confirmedOnly = await getPageConversationPreview(f.app.db, {
      platformAccountId: f.page.id, platformConversationId: GROUP, limit: 4,
    });
    expect(confirmedOnly!.messages.map((message) => message.platformMessageId))
      .toEqual(["900000000000000101", "900000000000000102", "900000000000000103"]);
    expect(await getPageConversationPreview(f.app.db, {
      platformAccountId: f.page.id, platformConversationId: GROUP, limit: 4, liveOverlay: false,
    })).toEqual(confirmedOnly);
  });

  it("marks socket messages of a chat excluded from REST sync «API недоступен», even after the parity window", async () => {
    const f = await fixture();
    await upsertPageDmMessages(f.app.db, [
      f.hot(f.excluded.id, "900000000000000301", 0, "before the exclusion", { sender: EXCLUDED_FAN }),
    ]);
    await f.live("900000000000000302", { group: EXCLUDED_GROUP, sender: EXCLUDED_FAN, seconds: 60 });
    await f.live("900000000000000303", { group: EXCLUDED_GROUP, sender: EXCLUDED_FAN, seconds: 90, outcome: "excluded" });
    const chat = await getPageConversationMessages(f.app.db, {
      platformAccountId: f.page.id, platformConversationId: EXCLUDED_GROUP, liveOverlay: true,
    });
    expect(chat!.conversation.messageSyncEligibility).toBe("excluded");
    expect(chat!.messages.map((message) => [message.messageId, message.senderRole, message.provenance])).toEqual([
      ["900000000000000303", "fan", { source: "live", apiUnavailable: true }],
      ["900000000000000302", "fan", { source: "live", apiUnavailable: true }],
      ["900000000000000301", "fan", { source: "rest" }],
    ]);
  });

  it("keeps a chat Hub has no thread row for invisible (plan §7.6)", async () => {
    const f = await fixture();
    await f.live("900000000000000401", { group: UNKNOWN_GROUP, seconds: 10 });
    expect(await getPageConversationMessages(f.app.db, {
      platformAccountId: f.page.id, platformConversationId: UNKNOWN_GROUP, liveOverlay: true,
    })).toBeNull();
    expect(await getPageConversationPreview(f.app.db, {
      platformAccountId: f.page.id, platformConversationId: UNKNOWN_GROUP, liveOverlay: true,
    })).toBeNull();
    const transcript = await loadTranscriptContext(f.app, {
      pageId: f.page.id, conversationRef: UNKNOWN_GROUP, liveOverlay: "serve",
    });
    expect(transcript.messages).toEqual([]);
  });
});

describe("live overlay readers: AI kernel context (plan §7.11)", () => {
  // Short ids: the migrated transcript shaper keys messages by Number(id).
  it("reads the archive ∪ socket messages the archive lacks; socket deletions hide archive rows; no money from the socket", async () => {
    const f = await fixture();
    await f.archive("7501", 0, "hey babe");
    await f.archive("7502", 60, "hey you", { mine: true });
    await f.archive("7503", 90, "tipped", { tipMills: 5000 });
    await f.archive("7504", 100, "deleted later");
    await f.archive("7505", 110, "deleted in REST", { deleted: true });
    await f.live("7504", { sender: null, sentByPage: null, seconds: null, content: null, deleted: true });
    await f.live("7505", { seconds: 110 }); // REST tombstone dominates
    await f.live("7503", { seconds: 90, content: "tipped (socket)" }); // archive copy wins
    // In page_dm_messages but not projected into the archive yet: the AI lane still shows it.
    await upsertPageDmMessages(f.app.db, [f.hot(f.main.id, "7506", 120, "<b>hot</b> only")]);
    await f.live("7506", { seconds: 120, content: "<b>hot</b> only" });
    await f.live("7507", { seconds: 150, sender: PAGE_REF, content: "live reply" });

    const served = await loadTranscriptContext(f.app, { pageId: f.page.id, conversationRef: GROUP, liveOverlay: "serve" });
    expect(served.messages.map((message) => [String(message.id), message.sender, message.text, message.labels])).toEqual([
      ["7501", "Fan", "hey babe", []],
      ["7502", "Model", "hey you", []],
      ["7503", "Fan", "tipped", ["[Tip: $5.00]"]],
      ["7506", "Fan", "hot only", []],
      ["7507", "Model", "live reply", []],
    ]);
    expect(served.contextManifest).toMatchObject({
      source: "live_union", liveOverlay: "serve", liveCount: 2, liveError: false, archiveCount: 3,
    });

    const archiveOnly = await loadTranscriptContext(f.app, { pageId: f.page.id, conversationRef: GROUP });
    expect(archiveOnly.messages.map((message) => String(message.id)))
      .toEqual(["7501", "7502", "7503", "7504"]);
    expect(archiveOnly.contextManifest).toMatchObject({
      source: "archive", liveOverlay: "off", liveCount: null, liveError: false, archiveCount: 4,
    });
  });

  it("serves the plain archive and says so when the union read fails", async () => {
    const f = await fixture();
    await f.archive("7601", 0, "hey babe");
    await f.live("7602", { seconds: 10 });
    await testDb.pool.query("alter table dm_live_messages rename column content to content_moved");
    try {
      const served = await loadTranscriptContext(f.app, { pageId: f.page.id, conversationRef: GROUP, liveOverlay: "serve" });
      expect(served.messages.map((message) => String(message.id))).toEqual(["7601"]);
      expect(served.contextManifest).toMatchObject({ source: "archive", liveOverlay: "serve", liveCount: null, liveError: true });
    } finally {
      await testDb.pool.query("alter table dm_live_messages rename column content_moved to content");
    }
  });
});

describe("live overlay readers: the per-page switch through the API", () => {
  async function server(f: Fixture) {
    await createUserAccount(f.app, { username: "dima", role: "owner", password: "owner-secret" }, { source: "cli" });
    const api = await buildApiServer(f.app);
    servers.push(api);
    await api.ready();
    const login = await api.inject({ method: "POST", url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const get = async (path: string) => {
      const response = await api.inject({ method: "GET", url: `/api/v1/pages/ari-1/conversations/${GROUP}/${path}`,
        headers: { cookie } });
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as { messages: Array<Record<string, unknown>> };
    };
    const setPages = async (value: string) => {
      const response = await api.inject({ method: "PATCH", url: "/api/v1/admin/config", headers: { cookie },
        payload: { patches: [{ key: "fanslyLiveOverlayReadPages", value }], note: "test" } });
      expect(response.statusCode, response.body).toBe(200);
    };
    return { get, setPages };
  }

  it("shows live rows only on listed pages, live; none restores the confirmed-only responses exactly", async () => {
    const f = await fixture();
    await seedChat(f);
    const api = await server(f);
    const baseline = { messages: await api.get("messages"), preview: await api.get("preview?limit=25") };
    expect(baseline.messages.messages.map((message) => message.messageId))
      .toEqual(["900000000000000103", "900000000000000102", "900000000000000101"]);
    expect(baseline.messages.messages.every((message) => !("source" in message) && !("apiUnavailable" in message)))
      .toBe(true);

    await api.setPages("ari-1");
    const live = await api.get("messages");
    expect(live.messages.map((message) => [message.messageId, message.source, message.apiUnavailable ?? null])).toEqual([
      ["900000000000000115", "live", false],
      ["900000000000000113", "live", false],
      ["900000000000000110", "live", false],
      ["900000000000000103", "rest", null],
      ["900000000000000101", "rest", null],
    ]);
    expect(live.messages[3]).toEqual({ messageId: "900000000000000103", senderRole: "fan", content: "third",
      createdAt: at(120).toISOString(), tipAmountCents: 0, source: "rest" });
    const preview = await api.get("preview?limit=25");
    expect(preview.messages.map((message) => [message.platformMessageId, message.source])).toEqual([
      ["900000000000000101", "rest"], ["900000000000000103", "rest"], ["900000000000000110", "live"],
      ["900000000000000113", "live"], ["900000000000000115", "live"],
    ]);

    await api.setPages("lilly-1, lora-3");
    expect(await api.get("messages")).toEqual(baseline.messages);
    await api.setPages("all");
    expect((await api.get("messages")).messages).toHaveLength(5);
    await api.setPages("none");
    expect({ messages: await api.get("messages"), preview: await api.get("preview?limit=25") }).toEqual(baseline);
  });

  it("never reads the overlay for another platform, and leaves Agent Read and the archive routes confirmed-only", async () => {
    const f = await fixture();
    await seedChat(f);
    await f.archive("900000000000000101", 0, "first");
    f.app.config.fanslyLiveOverlayReadPages = "all";
    expect(await pageReadsLiveOverlay(f.app, f.page)).toBe(true);
    const onlyFans = await createOnlyFansPage(f.app.db, { modelId: f.page.modelId, label: "of-1" });
    expect(await pageReadsLiveOverlay(f.app, onlyFans!)).toBe(false);

    const transcript = await listAgentTranscript(f.app.db, {
      pageId: f.page.id, platform: "fansly", conversationRef: GROUP,
      from: new Date(base.getTime() - 60_000), to: new Date(), sortDir: "asc", limit: 50, filters: {},
    });
    expect(transcript.rows.map((row) => row.messageRef)).not.toContain("900000000000000110");
    expect(transcript.rows.map((row) => row.messageRef)).toContain("900000000000000102");
    const archive = await listArchiveConversationMessages(f.app.db, { conversationRef: GROUP });
    expect(archive.map((row) => row.messageRef).sort()).toEqual(["900000000000000101", "900000000000000115"]);
  });
});

/** An open (or ended) unavailability episode of a chat, as the actor and M2 write it. */
async function seedEpisode(threadId: number, input: {
  state: "refusing" | "established"; refusals: number; note?: string; ended?: boolean;
}) {
  await testDb.pool.query(`
    insert into page_dm_thread_unavailability (thread_id, state, opened_at, established_at, ended_at, end_reason,
      refusals, last_refusal_at, last_http_status, retry_not_before, first_attempt_id, last_attempt_id,
      first_observation_id, first_observation_received_at, last_observation_id, last_observation_received_at,
      owner_note, owner_note_at)
    values ($1, $2::text, $3::timestamptz, case when $2::text = 'established' then $4::timestamptz end,
      case when $7::boolean then $5::timestamptz end, case when $7::boolean then 'read_served' end,
      $6::int, $5::timestamptz, 500, case when $2::text = 'established' then now() + interval '1 day' end, 11, 15,
      901, $3::timestamptz, 905, $5::timestamptz, $8::text, case when $8::text is not null then $3::timestamptz end)`, [
    threadId, input.state, at(-3600), at(-1800), at(-600), input.refusals, input.ended === true, input.note ?? null,
  ]);
}

describe("chat access: a chat Fansly no longer serves to the page (arena vanished chat, plan §5)", () => {
  async function routes(f: Fixture) {
    await createUserAccount(f.app, { username: "dima", role: "owner", password: "owner-secret" }, { source: "cli" });
    const api = await buildApiServer(f.app);
    servers.push(api);
    await api.ready();
    const login = await api.inject({ method: "POST", url: "/api/v1/auth/login",
      payload: { username: "dima", password: "owner-secret" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    return async (group: string) => {
      const answers = await Promise.all(["messages", "preview?limit=25"].map(async (path) => {
        const response = await api.inject({ method: "GET", url: `/api/v1/pages/ari-1/conversations/${group}/${path}`,
          headers: { cookie } });
        expect(response.statusCode, response.body).toBe(200);
        return (response.json() as { conversation: Record<string, unknown> }).conversation;
      }));
      return answers as [Record<string, unknown>, Record<string, unknown>];
    };
  }

  it("both chatter routes carry the open episode as chatAccess, cause unchecked; other chats and ended episodes none", async () => {
    const f = await fixture();
    await seedChat(f);
    const read = await routes(f);
    const [baselineMessages, baselinePreview] = await read(GROUP);
    expect(baselineMessages).not.toHaveProperty("chatAccess");
    expect(baselinePreview).not.toHaveProperty("chatAccess");

    await seedEpisode(f.main.id, { state: "established", refusals: 8, note: "06.10: the profile does not open from ari-1" });
    const expected = {
      state: "established", openedAt: at(-3600).toISOString(), establishedAt: at(-1800).toISOString(),
      lastRefusalAt: at(-600).toISOString(), refusals: 8, ownerNote: "06.10: the profile does not open from ari-1",
      cause: "unchecked",
    };
    for (const conversation of await read(GROUP)) {
      expect(conversation.chatAccess).toEqual(expected);
    }
    // Everything else about the chat answers as before.
    const [withMessages, withPreview] = await read(GROUP);
    const { chatAccess: _messagesAccess, ...messagesRest } = withMessages;
    const { chatAccess: _previewAccess, ...previewRest } = withPreview;
    expect(messagesRest).toEqual(baselineMessages);
    expect(previewRest).toEqual(baselinePreview);
    for (const conversation of await read(OTHER_GROUP)) expect(conversation).not.toHaveProperty("chatAccess");

    // A refusing episode is sent too (the dashboard shows no banner for it).
    await testDb.pool.query("delete from page_dm_thread_unavailability");
    await seedEpisode(f.main.id, { state: "refusing", refusals: 2 });
    for (const conversation of await read(GROUP)) {
      expect(conversation.chatAccess).toEqual({ ...expected, state: "refusing", establishedAt: null, refusals: 2, ownerNote: null });
    }

    // An ended episode is history: the chat answers as if it never had one.
    await testDb.pool.query("delete from page_dm_thread_unavailability");
    await seedEpisode(f.main.id, { state: "established", refusals: 5, ended: true });
    const [endedMessages, endedPreview] = await read(GROUP);
    expect(endedMessages).toEqual(baselineMessages);
    expect(endedPreview).toEqual(baselinePreview);
  });

  it("the AI transcript labels the chat's socket messages and says the chat is unavailable, only while established", async () => {
    const f = await fixture();
    await f.archive("7801", 0, "hey babe");
    await f.archive("7802", 60, "hey you", { mine: true });
    await f.live("7803", { seconds: 120, content: "enjoy baby" });
    await f.live("7804", { seconds: 150, sender: PAGE_REF, content: "live reply" });
    const load = (readChatAccess?: boolean) => loadTranscriptContext(f.app, {
      pageId: f.page.id, conversationRef: GROUP, liveOverlay: "serve", ...(readChatAccess === undefined ? {} : { readChatAccess }),
    });

    const plain = await load(true);
    expect(plain.chatAccess).toBeNull();
    expect(plain.contextManifest).not.toHaveProperty("chatAccess");

    await seedEpisode(f.main.id, { state: "refusing", refusals: 3 });
    expect(await load(true)).toEqual(plain);

    await testDb.pool.query("delete from page_dm_thread_unavailability");
    await seedEpisode(f.main.id, { state: "established", refusals: 5 });
    const unavailable = await load(true);
    expect(unavailable.messages.map((message) => [String(message.id), message.sender, message.text, message.labels])).toEqual([
      ["7801", "Fan", "hey babe", []],
      ["7802", "Model", "hey you", []],
      ["7803", "Fan", "enjoy baby", ["[Unconfirmed]"]],
      ["7804", "Model", "live reply", ["[Unconfirmed]"]],
    ]);
    expect(unavailable.transcript.split("\n").slice(-2)).toEqual([
      expect.stringMatching(/^\[\d\d:\d\d\] Fan: \[Unconfirmed\] enjoy baby$/),
      expect.stringMatching(/^\[\d\d:\d\d\] Model: \[Unconfirmed\] live reply$/),
    ]);
    expect(unavailable.chatAccess).toEqual({
      state: "established",
      unconfirmed: 2,
      note: "\n\nChat status: Fansly no longer serves this chat's history to the page — the fan probably blocked the page "
        + "or deleted their account. Messages marked [Unconfirmed] arrived over the live socket and are not confirmed.",
    });
    expect(unavailable.contextManifest).toMatchObject({ chatAccess: { state: "established", unconfirmed: 2 } });
    expect(unavailable.contextManifest).not.toHaveProperty("chatAccessError");
    // The same rows, only labelled: the window and its refs do not move.
    expect(unavailable.served).toEqual(plain.served);

    // Without the overlay there is nothing to label, and the chat is still unavailable.
    const archiveOnly = await loadTranscriptContext(f.app, { pageId: f.page.id, conversationRef: GROUP, readChatAccess: true });
    expect(archiveOnly.messages.every((message) => message.labels.length === 0)).toBe(true);
    expect(archiveOnly.chatAccess).toMatchObject({ state: "established", unconfirmed: 0 });
    expect(archiveOnly.chatAccess!.note).not.toContain("[Unconfirmed]");

    // Not asked (another platform's caller): the episode is not read.
    expect(await load()).toEqual(plain);
    expect(await load(false)).toEqual(plain);
  });

  it("serves the transcript without its access and says so when the episode read fails", async () => {
    const f = await fixture();
    await f.archive("7901", 0, "hey babe");
    await f.live("7902", { seconds: 10 });
    await seedEpisode(f.main.id, { state: "established", refusals: 5 });
    await testDb.pool.query("alter table page_dm_thread_unavailability rename column state to state_moved");
    try {
      const served = await loadTranscriptContext(f.app, {
        pageId: f.page.id, conversationRef: GROUP, liveOverlay: "serve", readChatAccess: true,
      });
      expect(served.messages.map((message) => [String(message.id), message.labels])).toEqual([["7901", []], ["7902", []]]);
      expect(served.chatAccess).toBeNull();
      expect(served.contextManifest).toMatchObject({ source: "live_union", chatAccessError: true });
      expect(served.contextManifest).not.toHaveProperty("chatAccess");
    } finally {
      await testDb.pool.query("alter table page_dm_thread_unavailability rename column state_moved to state");
    }
  });
});

describe("live overlay readers: a real socket frame end to end", () => {
  it("a captured and applied frame is visible to the chatter route; a deletion frame hides the REST copy", async () => {
    const f = await fixture();
    await upsertPageDmMessages(f.app.db, [f.hot(f.main.id, "900000000000000701", 0, "rest first")]);
    await saveProxy(f.app, f.page.id, { url: "http://proxy.example.test:8080", username: "test", password: "test" });
    const generation = await readProbeGeneration(f.app.db, f.page.label);
    const owner = await acquireFanslyWsOwnership(testDb.connectionString, f.page.id, () => {});
    if (!owner) throw new Error("owner unavailable");
    owners.push(owner);
    const connectionId = randomUUID();
    await beginFanslyWsConnection(owner.db, { id: connectionId, pageId: f.page.id, generation });
    let ordinal = 0;
    const validate = async (tx: Database) => {
      if (await readFanslyPageGeneration(tx, f.page.label) !== generation) throw new Error("generation_fenced");
    };
    const deliver = async (frame: string) => {
      const observationId = await captureFanslyWsFrame(owner.db, {
        connectionId, pageId: f.page.id, generation, accountRef: PAGE_REF, ordinal: ++ordinal, frame,
        receivedAt: new Date(), validate,
      });
      expect(await applyFanslyWsLiveReceipt(f.app.db, { observationId })).toMatchObject({ status: "applied" });
    };
    const createdAtSeconds = Date.now() / 1000 - 2;
    await deliver(serviceFrame({ type: 1, message: {
      id: "900000000000000702", groupId: GROUP, senderId: FAN, createdAt: createdAtSeconds,
      content: "from the socket", attachments: [], type: 1, totalTipAmount: 500,
    } }));
    const read = () => getPageConversationMessages(f.app.db, {
      platformAccountId: f.page.id, platformConversationId: GROUP, liveOverlay: true,
    });
    expect((await read())!.messages).toEqual([
      { messageId: "900000000000000702", senderRole: "fan", content: "from the socket",
        createdAt: new Date(Math.round(createdAtSeconds * 1000)), tipAmountCents: 0,
        provenance: { source: "live", apiUnavailable: false } },
      { messageId: "900000000000000701", senderRole: "fan", content: "rest first", createdAt: at(0),
        tipAmountCents: 0, provenance: { source: "rest" } },
    ]);

    await deliver(serviceFrame({ type: 10, message: { id: "900000000000000701", groupId: GROUP, type: 1 } }));
    expect(messageIds((await read())!.messages)).toEqual(["900000000000000702"]);
    // The confirmed-only read is untouched until the legacy reconcile marks the copy.
    expect(messageIds((await getPageConversationMessages(f.app.db, {
      platformAccountId: f.page.id, platformConversationId: GROUP,
    }))!.messages)).toEqual(["900000000000000701"]);
  });
});
