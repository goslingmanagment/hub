import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ensurePollRows,
  getSyncPage,
  upsertDemand,
  upsertFans,
  upsertPageDmMessages,
  writeThreadChain,
  type Database,
  type ThreadChainState,
} from "@agency_hub_core/db";
import type { FanslyMessagingGroupsPage, FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";
import { FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY, FANSLY_WS_LIVE_FIELD } from "@agency_hub_core/shared";

import { BLOCKED_PROBE_EVERY_MS } from "../apps/runtime/src/sync/engine/errors.ts";
import { createEngineRegistry, pollsFor, type EngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { applyListPage } from "../apps/runtime/src/sync/fansly/resources/dm-conversations.ts";
import { getHistoryRequest, submitHistoryRequest } from "../apps/runtime/src/sync/requests/history.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  makeTestActor,
  okResponse,
  RecordingAlerts,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  statusResponse,
  testConfig,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// The chat Fansly stopped serving to the page (arena "vanished chat", plan
// §2, R2): the chat-unavailability episode, through the real actor and
// commits against a real database (a scripted transport plays Fansly's
// `/message`). Pinned: five refusals of the head with Fansly's own error
// envelope establish the episode — the refused work and the chat's other open
// rows close `chat_unavailable` with their demand unserved, the socket
// message is deferred (still shown), the history fans that need the head are
// refused, nothing reads the head again; a proxy's HTML 502 or an empty 5xx
// neither opens nor counts (four of them and one refusal block the work, not
// the chat); an applied head read ends the episode and confirms the message,
// a deeper page's does not; after establishment a new socket message gives
// exactly one read, not before the retry boundary, and a list head the
// episode answered gives none; a refusal of the catch-up read counts as the
// head's; a thread erased under a refusal keeps the capture and gets no
// episode; the passive parity pass defers by the episode; a chat excluded
// since ends its episode; the migration builds the episodes the journal
// proves.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function rows<T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await testDb!.pool.query<T>(text, values)).rows;
}

async function scalar(text: string, values: unknown[] = []): Promise<number> {
  return Number((await rows<{ n: number }>(text, values))[0]?.n ?? 0);
}

const EPOCH_MS = 1561494359900;
const OWN = "300000000000000001";
const FAN = "510000000000000001";
const HOUR = 3_600_000;
/** Chat time: message k was created BASE + k seconds. */
const BASE_MS = Date.now() - 6 * HOUR;
const HEAD_KEY = "dm-messages.head";
const CATCHUP_KEY = "dm-messages.catchup";
const HISTORY_KEY = "dm-messages.history";

const snowflake = (ms: number, seq = 0) => ((BigInt(ms - EPOCH_MS) << 22n) | BigInt(seq)).toString();
const msg = (k: number) => snowflake(BASE_MS + k * 1000);
const groupOf = (n: number) => `7100000000000${String(n).padStart(5, "0")}`;
const senderOf = (k: number) => (k % 2 === 0 ? OWN : FAN);

/** What lora-1's refused chat answers, every time (04.10 → 08.10). */
const GROUP_MESSAGES_500 = { success: false, error: { code: 500, details: "error getting group messages" } };
const refused = (): FanslyWireOutcome => statusResponse(500, GROUP_MESSAGES_500);

/** A proxy's or a gateway's own page: no Fansly envelope. */
function proxyPage(status: number): FanslyWireOutcome {
  const bodyText = `<html><head><title>${status} Bad Gateway</title></head><body><center>nginx</center></body></html>`;
  return { kind: "response", status, headers: { "content-type": "text/html" }, bodyText, bodyBytes: bodyText.length, sendMark: "request_start" };
}

function emptyStatus(status: number): FanslyWireOutcome {
  return { kind: "response", status, headers: {}, bodyText: "", bodyBytes: 0, sendMark: "request_start" };
}

function wireMessage(groupId: string, k: number) {
  return {
    id: msg(k),
    type: 1,
    dataVersion: 1,
    content: `message ${k}`,
    groupId,
    senderId: senderOf(k),
    correlationId: null,
    inReplyTo: null,
    inReplyToRoot: null,
    createdAt: Math.floor((BASE_MS + k * 1000) / 1000),
    attachments: [],
    embeds: [],
    interactions: [],
    likes: [],
    totalTipAmount: 0,
  };
}

/** Fansly's `/message` over a chat holding messages `ks`: newest first, 25 a
 *  page, ids strictly below `before`. */
function serve(groupId: string, ks: readonly number[]) {
  const sorted = [...ks].sort((a, b) => b - a);
  return (req: FanslyWireRequest): FanslyWireOutcome => {
    const before = beforeOf(req);
    const below = before === null ? sorted : sorted.filter((k) => BigInt(msg(k)) < BigInt(before));
    return okResponse({ messages: below.slice(0, 25).map((k) => wireMessage(groupId, k)) });
  };
}

function beforeOf(req: FanslyWireRequest): string | null {
  const url = new URL(req.url);
  expect(url.pathname.endsWith("/message")).toBe(true);
  return url.searchParams.get("before");
}

async function seedPage(label?: string) {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, {
    mode: "live",
    guard: "fansly_sync_engine",
    ...(label === undefined ? {} : { label }),
  });
  await testDb!.pool.query("update pages set external_page_id = $2 where id = $1", [pageId, OWN]);
  await testDb!.pool.query(
    `update sync_pages set legacy_imported_at = clock_timestamp() - interval '1 day',
            mode_changed_at = clock_timestamp() - interval '1 day',
            requests_enabled_at = clock_timestamp() - interval '1 minute'
      where page_id = $1`,
    [pageId],
  );
  return pageId;
}

/** A thread as legacy and the journal rebuild left it: messages 1..5 stored
 *  (page_dm_messages and the archive) and proven a partial chain, its head
 *  read received `headAt` (default an hour ago). */
async function seedThread(
  pageId: number,
  options: { n?: number; groupId?: string; excluded?: boolean; bound?: boolean; headAt?: Date } = {},
): Promise<number> {
  const groupId = options.groupId ?? groupOf(options.n ?? 1);
  const stored = [1, 2, 3, 4, 5];
  const [fan] = await upsertFans(db(), [{ platform: "fansly" as const, platformUserId: FAN }]);
  const metadata = options.excluded ? { [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY]: "partner_missing_from_aggregation_accounts" } : {};
  const inserted = await rows<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id, partner_platform_user_id,
            partner_username, conversation_flags, unread_count, last_message_id, last_message_at, last_message_sender_id,
            last_message_sender_role, newest_stored_message_id, oldest_stored_message_id, stored_message_count,
            message_coverage_status, is_visible, metadata, history_state)
     values ($1, $2, $3, $4, 'fan', 0, 0, $5, now(), $4, 'fan', $5, $6, 5, 'partial_window', true, $7::jsonb, 'unverified')
     returning id::text as id`,
    [pageId, groupId, options.bound === false ? null : fan!.id, FAN, msg(5), msg(1), JSON.stringify(metadata)],
  );
  const threadId = Number(inserted[0]!.id);
  await upsertPageDmMessages(db(), stored.map((k) => ({
    conversationId: threadId,
    platformAccountId: pageId,
    platformMessageId: msg(k),
    senderPlatformUserId: senderOf(k),
    senderRole: senderOf(k) === OWN ? "model" as const : "fan" as const,
    createdAt: new Date(Math.floor((BASE_MS + k * 1000) / 1000) * 1000),
    content: `message ${k}`,
    totalTipAmountCents: 0,
    inReplyToMessageId: null,
    inReplyToRootMessageId: null,
  })));
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id, sender_role,
            is_sent_by_me, occurred_at, text_plain)
     select $1, 'fansly', $2, m.ref, $3, case when m.mine then 'model' else 'fan' end, m.mine, m.at, m.text
       from unnest($4::text[], $5::boolean[], $6::timestamptz[], $7::text[]) as m(ref, mine, at, text)
     on conflict (account_id, platform, message_ref) do nothing`,
    [
      pageId, groupId, FAN, stored.map(msg), stored.map((k) => senderOf(k) === OWN),
      stored.map((k) => new Date(Math.floor((BASE_MS + k * 1000) / 1000) * 1000)), stored.map((k) => `message ${k}`),
    ],
  );
  const chain: ThreadChainState = {
    epoch: 0,
    state: "partial",
    headId: msg(5),
    headAt: options.headAt ?? new Date(Date.now() - HOUR),
    oldestId: msg(1),
    oldestCreatedAtMs: BASE_MS + 1000,
    count: 5,
    upwardCount: 0,
    proof: null,
    proofWitness: null,
    provenAt: null,
  };
  await db().transaction(async (tx) => {
    await writeThreadChain(tx as unknown as Database, threadId, { chain, source: "journal_rebuild" });
  });
  return threadId;
}

/** Every Fansly entry, standing polls parked far ahead. */
async function registryFor(pageId: number): Promise<EngineRegistry> {
  const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
  const page = await getSyncPage(db(), pageId);
  await ensurePollRows(db(), {
    pageId,
    polls: pollsFor(registry, page!).map((poll) => ({ ...poll, phase: 0.999 })),
  });
  return registry;
}

/** A demand as its producer raises it: the socket router a head's
 *  (`ws:message_created`), the list a catch-up's (`list_head:…`). */
async function demand(
  pageId: number,
  resource: string,
  messageIds: readonly string[],
  options: { n?: number; dueAt?: Date; reason?: string } = {},
) {
  const spec = fanslyResourceSpec(resource)!;
  const reason = options.reason ?? (resource === CATCHUP_KEY ? "list_head:dm-conversations.head" : "ws:message_created");
  return upsertDemand(db(), {
    pageId,
    resource,
    subject: groupOf(options.n ?? 1),
    kind: spec.kind,
    class: spec.class,
    dueAt: options.dueAt ?? new Date(Date.now() - 1_000),
    demand: { messageIds: [...messageIds], txIds: [], reasons: [reason] },
  });
}

/** The fan's message k as the socket showed it (the overlay row). */
async function liveOverlay(pageId: number, k: number, options: { n?: number; dueInMs?: number } = {}) {
  const created = new Date(Math.floor((BASE_MS + k * 1000) / 1000) * 1000);
  await testDb!.pool.query(
    `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
            is_sent_by_page, created_at, content, field_mask, decoder_version, first_visible_at, confirm_due_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 1, now(), now() + ($9::bigint * interval '1 millisecond'))`,
    [pageId, msg(k), groupOf(options.n ?? 1), senderOf(k), senderOf(k) === OWN, created, `message ${k}`,
      FANSLY_WS_LIVE_FIELD.content, options.dueInMs ?? HOUR],
  );
}

interface EpisodeSeed {
  state: "refusing" | "established";
  refusals: number;
  retryInMs?: number;
  handledListHeadId?: string | null;
}

/** An open episode as the actor would have left it (its attempts precede
 *  every attempt of the test: the actor counts an attempt only after the
 *  episode's latest). */
async function seedEpisode(threadId: number, seed: EpisodeSeed): Promise<number> {
  const inserted = await rows<{ id: string }>(
    `insert into page_dm_thread_unavailability (thread_id, state, opened_at, established_at, refusals, last_refusal_at,
            last_http_status, retry_not_before, first_attempt_id, last_attempt_id, first_observation_id,
            first_observation_received_at, last_observation_id, last_observation_received_at, handled_list_head_id)
     values ($1, $2::text, now() - interval '7 hours', case when $2::text = 'established' then now() - interval '1 hour' end,
             $3::int, now() - interval '1 hour', 500,
             case when $2::text = 'established' then now() + ($4::bigint * interval '1 millisecond') end,
             0, 0, 0, now() - interval '7 hours', 0, now() - interval '1 hour', $5)
     returning id::text as id`,
    [threadId, seed.state, seed.refusals, seed.retryInMs ?? HOUR, seed.handledListHeadId ?? null],
  );
  return Number(inserted[0]!.id);
}

interface EpisodeRow extends Record<string, unknown> {
  id: string;
  state: string;
  refusals: number;
  opened_at: Date;
  established_at: Date | null;
  ended_at: Date | null;
  end_reason: string | null;
  retry_not_before: Date | null;
  last_http_status: number | null;
  first_attempt_id: string;
  last_attempt_id: string;
  first_observation_id: string;
  last_observation_id: string;
  handled_list_head_id: string | null;
  owner_note: string | null;
}

async function episodes(threadId: number): Promise<EpisodeRow[]> {
  return rows<EpisodeRow>(
    `select id::text, state, refusals, opened_at, established_at, ended_at, end_reason, retry_not_before, last_http_status,
            first_attempt_id::text, last_attempt_id::text, first_observation_id::text, last_observation_id::text,
            handled_list_head_id, owner_note
       from page_dm_thread_unavailability where thread_id = $1 order by id`,
    [threadId],
  );
}

async function workRow(pageId: number, resource: string, n = 1) {
  const found = await rows<{
    id: string; state: string; close_reason: string | null; demand: { messageIds: string[] }; result: Record<string, unknown> | null;
    demand_revision: string; applied_revision: string; due_at: Date; waiting_reason: string | null; failure_count: number;
    breaker_until: Date | null; blocked_by_vendor_at: Date | null;
  }>(
    `select id::text, state, close_reason, demand, result, demand_revision::text, applied_revision::text, due_at, waiting_reason,
            failure_count, breaker_until, blocked_by_vendor_at
       from sync_work where page_id = $1 and resource = $2 and subject = $3 order by id desc limit 1`,
    [pageId, resource, groupOf(n)],
  );
  return found[0] ?? null;
}

async function liveRow(pageId: number, k: number) {
  const found = await rows<{
    confirmed_at: Date | null; confirm_outcome: string | null; confirm_wait_reason: string | null; confirm_due_at: Date | null;
  }>(
    "select confirmed_at, confirm_outcome, confirm_wait_reason, confirm_due_at from dm_live_messages where page_id = $1 and platform_message_id = $2",
    [pageId, msg(k)],
  );
  return found[0]!;
}

async function capturedAttempts(pageId: number): Promise<Array<{ id: string; resource: string; http_status: number | null; error_class: string | null; observation_id: string | null }>> {
  return rows(
    `select id::text, resource, http_status, error_class, observation_id::text
       from sync_attempts where page_id = $1 and completed_at is not null order by id`,
    [pageId],
  );
}

type Responder = (req: FanslyWireRequest, index: number) => FanslyWireOutcome;

/** Run the page's actor until `until` holds (nothing running). */
async function runLive(
  pageId: number,
  registry: EngineRegistry,
  respond: Responder,
  until: () => Promise<boolean>,
  options: {
    onHit?: (req: FanslyWireRequest) => Promise<void>;
    /** Runs when the actor prepares a request: after the pick, before the admission. */
    onPrepare?: () => Promise<void>;
    metrics?: RecordingMetrics;
  } = {},
) {
  const transport = new ScriptedLiveTransport();
  const requests: FanslyWireRequest[] = [];
  if (options.onPrepare !== undefined) {
    const onPrepare = options.onPrepare;
    const prepare = transport.prepare.bind(transport);
    transport.prepare = async (...args: Parameters<ScriptedLiveTransport["prepare"]>) => {
      await onPrepare();
      return prepare(...args);
    };
  }
  transport.respond = (req, index) => respond(req, index);
  transport.onHit = async (req) => {
    requests.push(req);
    await options.onHit?.(req);
  };
  const { actor, stop, abort } = await makeTestActor({
    db: db(),
    pageId,
    registry,
    transport,
    alerts: new RecordingAlerts(),
    metrics: options.metrics ?? new RecordingMetrics(),
    ownRef: OWN,
  });
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => {
      if (await scalar("select count(*)::int as n from sync_work where page_id = $1 and state = 'running'", [pageId]) > 0) return null;
      return (await until()) ? true : null;
    }, 30_000, "the work to settle");
  } finally {
    stop.abort();
    await run;
  }
  return { requests };
}

/** Run the actor for `ms` (a step that must NOT send has its chance). */
async function runFor(pageId: number, registry: EngineRegistry, respond: Responder, ms: number) {
  const end = Date.now() + ms;
  return runLive(pageId, registry, respond, async () => Date.now() >= end);
}

/** Time passes for the chat's open head row (only: the chat's other rows
 *  keep their own due times): its due time and its breaker are now. */
async function rewind(pageId: number, n = 1) {
  await testDb!.pool.query(
    `update sync_work set due_at = now() - interval '1 second',
            breaker_until = case when breaker_until is null then null else now() - interval '1 second' end
      where page_id = $1 and resource = $2 and subject = $3 and state = 'open'`,
    [pageId, HEAD_KEY, groupOf(n)],
  );
}

async function refuseOnce(pageId: number, registry: EngineRegistry, respond: Responder = refused) {
  const before = (await capturedAttempts(pageId)).length;
  const run = await runLive(pageId, registry, respond, async () => (await capturedAttempts(pageId)).length > before);
  expect(run.requests).toHaveLength(1);
  expect(beforeOf(run.requests[0]!)).toBeNull();
  await rewind(pageId);
}

describe("five refusals of the chat's head establish the episode", () => {
  it("closes the refused work and the chat's other rows chat_unavailable, defers the socket message, refuses the history fans that need the head, and reads no more", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const threadId = await seedThread(pageId);
    const registry = await registryFor(pageId);
    // The fan wrote; the socket showed it, the head is asked for it.
    await liveOverlay(pageId, 7);
    await demand(pageId, HEAD_KEY, [msg(7)]);
    // A catch-up the list asked for, not due yet; a history request on the
    // chat (its class paused, so only the head reads).
    await demand(pageId, CATCHUP_KEY, [msg(7)], { dueAt: new Date(Date.now() + HOUR) });
    await testDb.pool.query("update sync_pages set paused_requests = true where page_id = $1", [pageId]);
    const request = await submitHistoryRequest({ db: db(), rawConfig: testConfig(testDb.connectionString) }, {
      pageId,
      fans: [{ kind: "conversation", conversationRef: groupOf(1) }],
      depth: { kind: "all" },
      reason: "test",
      idempotencyKey: randomUUID(),
      requester: { kind: "owner_cli", userId: null },
    });
    expect(request.items[0]).toMatchObject({ state: "queued" });

    for (let refusal = 1; refusal <= 4; refusal += 1) {
      await refuseOnce(pageId, registry);
      const [episode] = await episodes(threadId);
      expect(episode).toMatchObject({ state: "refusing", refusals: refusal, established_at: null, retry_not_before: null, ended_at: null });
    }
    // Four refusals: the work is open on its breaker, the message awaited.
    expect(await workRow(pageId, HEAD_KEY)).toMatchObject({ state: "open", failure_count: 4 });
    expect((await liveRow(pageId, 7)).confirm_wait_reason).toBeNull();

    await refuseOnce(pageId, registry);
    const attempts = await capturedAttempts(pageId);
    expect(attempts).toHaveLength(5);
    expect(attempts.every((attempt) => attempt.resource === HEAD_KEY && attempt.http_status === 500 && attempt.error_class === "subject_failure")).toBe(true);
    const [episode] = await episodes(threadId);
    expect(episode).toMatchObject({
      state: "established",
      refusals: 5,
      ended_at: null,
      last_http_status: 500,
      first_attempt_id: attempts[0]!.id,
      last_attempt_id: attempts[4]!.id,
      first_observation_id: attempts[0]!.observation_id,
      last_observation_id: attempts[4]!.observation_id,
      handled_list_head_id: msg(7),
    });
    // The retry boundary: the daily step (the head's own 5th failure).
    expect(episode!.retry_not_before!.getTime()).toBeGreaterThan(Date.now() + BLOCKED_PROBE_EVERY_MS - 60_000);

    // The refused work: closed, its demand unserved, its breaker carried.
    const head = await workRow(pageId, HEAD_KEY);
    expect(head).toMatchObject({ state: "done", close_reason: "chat_unavailable", failure_count: 5 });
    expect(Number(head!.applied_revision)).toBeLessThan(Number(head!.demand_revision));
    expect(head!.blocked_by_vendor_at).not.toBeNull();
    expect(head!.result).toMatchObject({
      chatUnavailable: { episodeId: Number(episode!.id), refusals: 5 },
      unservedMessageIds: [msg(7)],
    });
    // The refused read settled only its own work: the catch-up decides by its
    // own plan. The history walk closed when the hook refused its last fan.
    expect(await workRow(pageId, CATCHUP_KEY)).toMatchObject({ state: "open" });
    const history = await workRow(pageId, HISTORY_KEY);
    expect(history).toMatchObject({ state: "done", close_reason: "chat_unavailable" });
    expect(Number(history!.applied_revision)).toBeLessThan(Number(history!.demand_revision));
    // The socket message: deferred, still unconfirmed (still shown).
    expect(await liveRow(pageId, 7)).toEqual({
      confirmed_at: null, confirm_outcome: null, confirm_wait_reason: "chat_unavailable", confirm_due_at: null,
    });
    // The history fan that needed the head: refused, its request done.
    const after = await getHistoryRequest({ db: db(), rawConfig: testConfig(testDb.connectionString) }, request.request.ref);
    expect(after.items[0]).toMatchObject({ state: "refused", refusal: "excluded", excludedReason: "chat_unavailable" });
    expect(after.request.state).toBe("done");

    // The catch-up's time comes: its demand (7) is the one the episode
    // answered, so it closes itself without a request.
    await testDb.pool.query(
      "update sync_work set due_at = now() - interval '1 second' where page_id = $1 and resource = $2",
      [pageId, CATCHUP_KEY],
    );
    const own = await runLive(pageId, registry, refused, async () => (await workRow(pageId, CATCHUP_KEY))?.state === "done");
    expect(own.requests).toHaveLength(0);
    const catchup = await workRow(pageId, CATCHUP_KEY);
    expect(catchup).toMatchObject({ close_reason: "chat_unavailable", result: { unservedMessageIds: [msg(7)] } });
    expect(Number(catchup!.applied_revision)).toBeLessThan(Number(catchup!.demand_revision));

    // No background read (owner decision Р5): nothing is asked of the chat.
    const quiet = await runFor(pageId, registry, refused, 1_500);
    expect(quiet.requests).toHaveLength(0);
  });

  it("a proxy's HTML 502 and an empty 504 are not the chat's answer: four of them and one refusal block the work, never the chat", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const threadId = await seedThread(pageId);
    const registry = await registryFor(pageId);
    await liveOverlay(pageId, 7);
    await demand(pageId, HEAD_KEY, [msg(7)]);

    await refuseOnce(pageId, registry, () => proxyPage(502));
    await refuseOnce(pageId, registry, () => emptyStatus(504));
    expect(await episodes(threadId)).toEqual([]);
    await refuseOnce(pageId, registry, () => proxyPage(502));
    await refuseOnce(pageId, registry, () => proxyPage(502));
    await refuseOnce(pageId, registry);
    // The work's breaker counted all five (blocked by the vendor) …
    const head = await workRow(pageId, HEAD_KEY);
    expect(head).toMatchObject({ state: "open", failure_count: 5, waiting_reason: "blocked_by_vendor" });
    expect(head!.blocked_by_vendor_at).not.toBeNull();
    // … the episode only the one Fansly answered: not established, nothing closed or deferred.
    const [episode] = await episodes(threadId);
    expect(episode).toMatchObject({ state: "refusing", refusals: 1, established_at: null });
    expect((await liveRow(pageId, 7)).confirm_wait_reason).toBeNull();
  });
});

describe("the end of an episode", () => {
  it("an applied head read ends it read_served and confirms the deferred socket message", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const threadId = await seedThread(pageId);
    const registry = await registryFor(pageId);
    // The episode answered the head up to 6; the fan's message 7 (deferred)
    // came after: its read, once the boundary passed, is served.
    await seedEpisode(threadId, { state: "established", refusals: 6, retryInMs: -1_000, handledListHeadId: msg(6) });
    await liveOverlay(pageId, 7);
    await testDb.pool.query(
      "update dm_live_messages set confirm_wait_reason = 'chat_unavailable', confirm_due_at = null where page_id = $1",
      [pageId],
    );
    await demand(pageId, HEAD_KEY, [msg(7)]);
    const { requests } = await runLive(pageId, registry, serve(groupOf(1), [1, 2, 3, 4, 5, 6, 7]),
      async () => (await workRow(pageId, HEAD_KEY))?.state === "done");
    expect(requests).toHaveLength(1);
    expect(beforeOf(requests[0]!)).toBeNull();
    const [episode] = await episodes(threadId);
    expect(episode).toMatchObject({ state: "established", end_reason: "read_served" });
    expect(episode!.ended_at).not.toBeNull();
    expect(await workRow(pageId, HEAD_KEY)).toMatchObject({ state: "done", close_reason: "confirmed" });
    expect(await liveRow(pageId, 7)).toMatchObject({ confirm_outcome: "match", confirm_wait_reason: null });
    expect((await liveRow(pageId, 7)).confirmed_at).not.toBeNull();
  });
});

/** The list's page of chat 1 with its head at message k (the fan in the
 *  aggregation accounts: not excluded). */
function listPage(k: number): FanslyMessagingGroupsPage {
  return {
    data: [{
      groupId: groupOf(1),
      partnerAccountId: FAN,
      partnerUsername: "fan",
      flags: 0,
      unreadCount: 0,
      subscriptionTierId: null,
      lastMessageId: msg(k),
      lastUnreadMessageId: null,
    }],
    aggregationData: {
      accounts: [{ id: FAN, username: "fan", displayName: null }],
      groups: [{
        id: groupOf(1),
        type: 1,
        groupFlags: 0,
        users: [
          { groupId: groupOf(1), userId: OWN, type: 0, permissionFlags: 0 },
          { groupId: groupOf(1), userId: FAN, type: 0, permissionFlags: 0 },
        ],
        lastMessage: { ...wireMessage(groupOf(1), k), senderId: FAN },
      }],
    },
  } as unknown as FanslyMessagingGroupsPage;
}

async function listPass(pageId: number, k: number) {
  return db().transaction(async (tx) => applyListPage(tx as unknown as Database, {
    pageId,
    now: new Date(),
    key: "dm-conversations.head",
    page: listPage(k),
    generation: null,
    classOf: () => "planned",
  }));
}

describe("after establishment (owner decision Р5: no background reads)", () => {
  it("a new socket message gives exactly one read, not before the retry boundary; a list head the episode answered gives none", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    // The chain's head read was received while message 5 was the newest:
    // 7 and 9 came after it (a head read the chain joined after them, 75 s
    // on, would account for a list head it did not show).
    const threadId = await seedThread(pageId, { headAt: new Date(BASE_MS + 5_500) });
    const registry = await registryFor(pageId);
    const episodeId = await seedEpisode(threadId, { state: "established", refusals: 5, retryInMs: HOUR, handledListHeadId: msg(7) });
    const boundary = (await episodes(threadId))[0]!.retry_not_before!;

    // The list shows the head the episode answered: no read.
    const same = await listPass(pageId, 7);
    expect(same.followups.filter((followup) => followup.subject === groupOf(1))).toEqual([]);
    expect(same.counters).toMatchObject({ followup_skipped_chat_unavailable: 1 });
    // A newer list head asks for one read (its plan waits for the boundary,
    // as the socket's below does).
    const newer = await listPass(pageId, 9);
    expect(newer.followups.filter((followup) => followup.subject === groupOf(1)))
      .toEqual([expect.objectContaining({ resource: CATCHUP_KEY, demand: expect.objectContaining({ messageIds: [msg(9)] }) })]);
    expect(newer.counters.followup_skipped_chat_unavailable).toBeUndefined();

    // The fan writes again: the router asks for the head.
    await liveOverlay(pageId, 9);
    await demand(pageId, HEAD_KEY, [msg(9)]);
    const waiting = await runFor(pageId, registry, refused, 1_500);
    expect(waiting.requests).toHaveLength(0);
    const parked = await workRow(pageId, HEAD_KEY);
    expect(parked).toMatchObject({ state: "open", waiting_reason: "not_due" });
    expect(parked!.due_at.getTime()).toBe(boundary.getTime());

    // The boundary passes: one read, refused again.
    await testDb.pool.query(
      "update page_dm_thread_unavailability set retry_not_before = now() - interval '1 second' where id = $1",
      [episodeId],
    );
    await rewind(pageId);
    const { requests } = await runLive(pageId, registry, refused, async () => (await workRow(pageId, HEAD_KEY))?.state === "done");
    expect(requests).toHaveLength(1);
    expect(beforeOf(requests[0]!)).toBeNull();
    const [episode] = await episodes(threadId);
    expect(episode).toMatchObject({ state: "established", refusals: 6, handled_list_head_id: msg(9), ended_at: null });
    expect(episode!.retry_not_before!.getTime()).toBeGreaterThan(Date.now() + BLOCKED_PROBE_EVERY_MS - 60_000);
    expect(await workRow(pageId, HEAD_KEY)).toMatchObject({ state: "done", close_reason: "chat_unavailable" });
    expect(await liveRow(pageId, 9)).toMatchObject({ confirm_wait_reason: "chat_unavailable", confirm_due_at: null, confirmed_at: null });
    // The list head of that message is answered now.
    expect((await listPass(pageId, 9)).followups.filter((followup) => followup.subject === groupOf(1))).toEqual([]);

    const quiet = await runFor(pageId, registry, refused, 1_500);
    expect(quiet.requests).toHaveLength(0);
  });
});

describe("a refusal under an erasure", () => {
  it("a thread erased while its refusal is captured: the capture is kept, no episode is written", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const threadId = await seedThread(pageId);
    const registry = await registryFor(pageId);
    await demand(pageId, HEAD_KEY, [msg(7)]);
    const metrics = new RecordingMetrics();
    const eraser = await testDb.pool.connect();
    let committed: Promise<void> | null = null;
    try {
      const { requests } = await runLive(pageId, registry, refused, async () => (await capturedAttempts(pageId)).length === 1, {
        metrics,
        // The erasure deletes the chat while the request is out, and commits
        // only after the capture began to wait for the chat's row.
        onHit: async () => {
          await eraser.query("begin");
          await eraser.query("delete from page_dm_threads where id = $1", [threadId]);
          committed = new Promise((resolve) => setTimeout(resolve, 500)).then(async () => {
            await eraser.query("commit");
          });
        },
      });
      expect(requests).toHaveLength(1);
    } finally {
      await committed;
      eraser.release();
    }
    const [attempt] = await capturedAttempts(pageId);
    expect(attempt).toMatchObject({ http_status: 500, error_class: "subject_failure" });
    expect(attempt!.observation_id).not.toBeNull();
    expect(await scalar("select count(*)::int as n from observations where id = $1", [Number(attempt!.observation_id)])).toBe(1);
    expect(await scalar("select count(*)::int as n from page_dm_thread_unavailability")).toBe(0);
    expect(await scalar("select count(*)::int as n from page_dm_threads where id = $1", [threadId])).toBe(0);
    expect(metrics.get("sync_capture_hook_failed")).toBe(1);
    // The work took the outcome as any refusal: on its breaker.
    expect(await workRow(pageId, HEAD_KEY)).toMatchObject({ state: "open", failure_count: 1 });
  });
});
