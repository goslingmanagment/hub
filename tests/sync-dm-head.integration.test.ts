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
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";
import { FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY, FANSLY_WS_LIVE_FIELD } from "@agency_hub_core/shared";

import { familyForObservation } from "../apps/runtime/src/services/canonicalize/index.ts";
import { canonicalizeObservationInTransaction } from "../apps/runtime/src/sync/engine/canonicalize.ts";
import type { SyncFaultPoint } from "../apps/runtime/src/sync/engine/commit.ts";
import { createEngineRegistry, pollsFor, type EngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { dmMessagesModule } from "../apps/runtime/src/sync/fansly/resources/dm-messages.ts";
import { getHistoryRequest, submitHistoryRequest } from "../apps/runtime/src/sync/requests/history.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  changedTables,
  makeTestActor,
  okResponse,
  RecordingAlerts,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  tableCounts,
  testConfig,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// The DM message reads of the Fansly Sync Engine (design §5.4, §10
// `sync-dm-head`) through the real actor and commits against a real
// database; a scripted transport plays Fansly's `/message` (newest first, 25
// a page, `before` strictly below). Pinned: one head read confirms a socket
// message into every store in one commit (hot table, chain, legacy summary,
// overlay, events, archive); a demand that arrives during the read is read
// again (I11); an id the vendor does not show yet is retried at 15 s and
// 60 s, then settled not found; more than 25 new messages are read down until
// the staged walk meets the chain, which moves only then; the archive is fed
// even when the minutely driver appended the events first; history is read
// to the empty page that proves its start; nothing fenced, excluded or
// refused by the contract is written; a chat erased or excluded between the
// capture and the apply still has its observation canonicalized under the
// fence and stamped (never left to the unfenced sweep).

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

const EPOCH_MS = 1561494359900;
const OWN = "300000000000000001";
const FAN = "510000000000000001";
const HOUR = 3_600_000;
/** Chat time: message k was created BASE + k seconds. */
const BASE_MS = Date.now() - 6 * HOUR;

const snowflake = (ms: number, seq = 0) => ((BigInt(ms - EPOCH_MS) << 22n) | BigInt(seq)).toString();
const msg = (k: number) => snowflake(BASE_MS + k * 1000);
const groupOf = (n: number) => `7100000000000${String(n).padStart(5, "0")}`;
const senderOf = (k: number) => (k % 2 === 0 ? OWN : FAN);

function wireMessage(groupId: string, k: number, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

/** Fansly's `/message` over a chat holding messages `ks`: newest first, 25 a
 *  page, ids strictly below `before`. */
function serve(groupId: string, ks: readonly number[], extra: Record<string, unknown> = {}) {
  const sorted = [...ks].sort((a, b) => b - a);
  return (req: FanslyWireRequest): FanslyWireOutcome => {
    const url = new URL(req.url);
    expect(url.pathname.endsWith("/message")).toBe(true);
    expect(url.searchParams.get("groupId")).toBe(groupId);
    expect(url.searchParams.get("limit")).toBe("25");
    const before = url.searchParams.get("before");
    const below = before === null ? sorted : sorted.filter((k) => BigInt(msg(k)) < BigInt(before));
    return okResponse({ messages: below.slice(0, 25).map((k) => wireMessage(groupId, k)), ...extra });
  };
}

function beforeOf(req: FanslyWireRequest): string | null {
  return new URL(req.url).searchParams.get("before");
}

async function seedPage(mode: "live" | "shadow" = "live") {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, {
    mode,
    guard: mode === "live" ? "fansly_sync_engine" : null,
  });
  await testDb!.pool.query("update pages set external_page_id = $2 where id = $1", [pageId, OWN]);
  await testDb!.pool.query(
    `update sync_pages set legacy_imported_at = case when mode = 'live' then clock_timestamp() - interval '1 day' end,
            mode_changed_at = clock_timestamp() - interval '1 day'
      where page_id = $1`,
    [pageId],
  );
  return pageId;
}

interface ThreadSeed {
  n: number;
  /** Messages legacy stored (k values). */
  stored?: readonly number[];
  /** The chain the journal rebuild proved over `stored` (contiguous, its head the newest). */
  chain?: boolean;
  bound?: boolean;
  excluded?: boolean;
}

/** A thread as legacy and the journal rebuild left it. */
async function seedThread(pageId: number, seed: ThreadSeed): Promise<number> {
  const groupId = groupOf(seed.n);
  const [fan] = await upsertFans(db(), [{ platform: "fansly" as const, platformUserId: FAN }]);
  const metadata = seed.excluded ? { [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY]: "partner_missing_from_aggregation_accounts" } : {};
  const stored = [...(seed.stored ?? [])].sort((a, b) => a - b);
  const inserted = await testDb!.pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id, partner_platform_user_id,
            partner_username, conversation_flags, unread_count, last_message_id, last_message_at, last_message_sender_id,
            last_message_sender_role, newest_stored_message_id, oldest_stored_message_id, stored_message_count,
            message_coverage_status, is_visible, metadata, history_state)
     values ($1, $2, $3, $4, 'fan', 0, 0, $5, now(), $4, 'fan', $5, $6, $7, 'partial_window', true, $8::jsonb,
             case when $7 > 0 then 'unverified' else 'none' end)
     returning id::text as id`,
    [
      pageId, groupId, seed.bound === false ? null : fan!.id, FAN,
      stored.length === 0 ? null : msg(stored.at(-1)!), stored.length === 0 ? null : msg(stored[0]!), stored.length,
      JSON.stringify(metadata),
    ],
  );
  const threadId = Number(inserted.rows[0]!.id);
  if (stored.length > 0) {
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
  }
  if (seed.chain === true && stored.length > 0) {
    const chain: ThreadChainState = {
      epoch: 0,
      state: "partial",
      headId: msg(stored.at(-1)!),
      headAt: new Date(Date.now() - HOUR),
      oldestId: msg(stored[0]!),
      oldestCreatedAtMs: BASE_MS + stored[0]! * 1000,
      count: stored.length,
      upwardCount: 0,
      proof: null,
      proofWitness: null,
      provenAt: null,
    };
    await db().transaction(async (tx) => {
      await writeThreadChain(tx as unknown as Database, threadId, { chain, source: "journal_rebuild" });
    });
  }
  return threadId;
}

/** Every Fansly entry, standing polls parked far ahead. */
async function registryFor(pageId: number, shadow = false): Promise<EngineRegistry> {
  const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
  const page = await getSyncPage(db(), pageId);
  await ensurePollRows(db(), {
    pageId,
    shadow,
    polls: pollsFor(registry, page!, shadow).map((poll) => ({ ...poll, phase: 0.999 })),
  });
  return registry;
}

async function demand(pageId: number, resource: string, n: number, messageIds: readonly string[], options: { shadow?: boolean } = {}) {
  const spec = fanslyResourceSpec(resource)!;
  return upsertDemand(db(), {
    pageId,
    shadow: options.shadow ?? false,
    resource,
    subject: groupOf(n),
    kind: spec.kind,
    class: spec.class,
    dueAt: new Date(Date.now() - 1_000),
    demand: { messageIds: [...messageIds], txIds: [], reasons: ["test"] },
  });
}

async function liveOverlay(pageId: number, n: number, k: number, content = `message ${k}`) {
  const created = new Date(Math.floor((BASE_MS + k * 1000) / 1000) * 1000);
  await testDb!.pool.query(
    `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
            is_sent_by_page, created_at, content, field_mask, decoder_version, first_visible_at, confirm_due_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 1, now(), now() + interval '1 hour')`,
    [pageId, msg(k), groupOf(n), senderOf(k), senderOf(k) === OWN, created, content, FANSLY_WS_LIVE_FIELD.content],
  );
}

type Responder = (req: FanslyWireRequest, index: number) => FanslyWireOutcome;

async function runLive(
  pageId: number,
  registry: EngineRegistry,
  respond: Responder,
  until: () => Promise<boolean>,
  options: {
    onHit?: (req: FanslyWireRequest, index: number) => Promise<void>;
    faults?: (point: SyncFaultPoint) => Promise<void>;
    metrics?: RecordingMetrics;
    alerts?: RecordingAlerts;
  } = {},
) {
  const transport = new ScriptedLiveTransport();
  const requests: FanslyWireRequest[] = [];
  transport.respond = (req, index) => respond(req, index);
  transport.onHit = async (req) => {
    requests.push(req);
    await options.onHit?.(req, requests.length - 1);
  };
  const { actor, stop, abort } = await makeTestActor({
    db: db(),
    pageId,
    mode: "live",
    registry,
    transport,
    alerts: options.alerts ?? new RecordingAlerts(),
    metrics: options.metrics ?? new RecordingMetrics(),
    ...(options.faults === undefined ? {} : { faults: options.faults }),
  });
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await until()) ? true : null), 30_000, "the work to settle");
  } finally {
    stop.abort();
    await run;
  }
  return { requests };
}

async function workRow(pageId: number, resource: string, n: number, shadow = false) {
  const result = await testDb!.pool.query<{
    id: string; state: string; close_reason: string | null; demand: { messageIds: string[] }; cursor: Record<string, unknown>;
    demand_revision: string; applied_revision: string; due_at: Date; updated_at: Date; attempts_count: number;
    last_error_class: string | null;
  }>(
    `select id::text, state, close_reason, demand, cursor, demand_revision::text, applied_revision::text, due_at, updated_at,
            attempts_count, last_error_class
       from sync_work where page_id = $1 and resource = $2 and subject = $3 and shadow = $4 order by id desc limit 1`,
    [pageId, resource, groupOf(n), shadow],
  );
  return result.rows[0] ?? null;
}

async function thread(threadId: number) {
  const result = await testDb!.pool.query<{
    head_confirmed_id: string | null; contiguous_oldest_id: string | null; contiguous_count: number; chain_upward_count: string;
    history_state: string; history_proof: string | null; history_proof_observation_id: string | null; chain_source: string | null;
    stored_message_count: number; newest_stored_message_id: string | null; oldest_stored_message_id: string | null;
    message_coverage_status: string; message_backfill_complete: boolean; last_message_sync_at: Date | null;
  }>(
    `select head_confirmed_id, contiguous_oldest_id, contiguous_count, chain_upward_count::text, history_state, history_proof,
            history_proof_observation_id::text, chain_source, stored_message_count, newest_stored_message_id,
            oldest_stored_message_id, message_coverage_status::text, message_backfill_complete, last_message_sync_at
       from page_dm_threads where id = $1`,
    [threadId],
  );
  return result.rows[0]!;
}

async function storedIds(threadId: number): Promise<string[]> {
  const result = await testDb!.pool.query<{ id: string }>(
    "select platform_message_id as id from page_dm_messages where conversation_id = $1 order by platform_message_id::numeric",
    [threadId],
  );
  return result.rows.map((row) => row.id);
}

async function scalar(text: string, values: unknown[]): Promise<number> {
  const result = await testDb!.pool.query<{ n: number }>(text, values);
  return Number(result.rows[0]?.n ?? 0);
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

describe("dm-messages.head", () => {
  it("confirms a socket message with one head read: hot table, chain, legacy summary, overlay, events and archive in one commit", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, { n: 1, stored: range(1, 20), chain: true });
    const registry = await registryFor(pageId);
    await liveOverlay(pageId, 1, 23);
    await demand(pageId, "dm-messages.head", 1, [msg(23)]);
    // A list-detected catch-up the head read will cover.
    await demand(pageId, "dm-messages.catchup", 1, [msg(22)]);
    await testDb.pool.query("update sync_work set due_at = now() + interval '1 hour' where resource = 'dm-messages.catchup'");
    const tip = {
      id: "880000000000000001", senderId: FAN, receiverId: OWN, createdAt: Math.floor((BASE_MS + 23_000) / 1000),
      amount: 5_000, message: "thanks",
    };
    const startedAt = new Date();
    const { requests } = await runLive(pageId, registry, serve(groupOf(1), range(1, 23), { tips: [tip] }),
      async () => (await workRow(pageId, "dm-messages.head", 1))?.state === "done");

    expect(requests.map(beforeOf)).toEqual([null]);
    expect(await storedIds(threadId)).toEqual(range(1, 23).map(msg));
    const after = await thread(threadId);
    expect(after).toMatchObject({
      head_confirmed_id: msg(23), contiguous_oldest_id: msg(1), contiguous_count: 23, chain_upward_count: "3",
      history_state: "partial", chain_source: "engine",
      // Incremental: the 3 inserted rows on top of what legacy counted.
      stored_message_count: 23, newest_stored_message_id: msg(23), oldest_stored_message_id: msg(1),
      message_coverage_status: "partial_window", message_backfill_complete: false,
    });
    expect(after.last_message_sync_at!.getTime()).toBeGreaterThanOrEqual(startedAt.getTime() - 1_000);
    const head = await workRow(pageId, "dm-messages.head", 1);
    expect(head).toMatchObject({ state: "done", close_reason: "confirmed", demand: expect.objectContaining({ messageIds: [] }) });
    expect(head!.applied_revision).toBe(head!.demand_revision);
    expect(await workRow(pageId, "dm-messages.catchup", 1)).toMatchObject({ state: "done", close_reason: "covered_by_head" });

    // The overlay row is confirmed against the row this read wrote.
    const overlay = await testDb.pool.query("select confirm_outcome, confirm_source, confirmed_at from dm_live_messages where platform_message_id = $1", [msg(23)]);
    expect(overlay.rows[0]).toMatchObject({ confirm_outcome: "match", confirm_source: "page_dm_messages" });
    // The journal: the verbatim page, its request as coverage evidence.
    const attempt = await testDb.pool.query<{ evidence: boolean; request: { params: unknown; query: Record<string, string> }; observation_id: string; apply_state: string }>(
      "select evidence, request, observation_id::text, apply_state from sync_attempts where page_id = $1 and resource = 'dm-messages.head'",
      [pageId],
    );
    expect(attempt.rows).toHaveLength(1);
    expect(attempt.rows[0]).toMatchObject({ evidence: true, apply_state: "applied", request: { params: { groupId: groupOf(1), before: null } } });
    expect(attempt.rows[0]!.request.query).toMatchObject({ groupId: groupOf(1), limit: "25" });
    const observation = await testDb.pool.query<{ kind: string; producer: string; parse_version: number; messages: number }>(
      "select kind, producer, parse_version, jsonb_array_length(payload->'messages') as messages from observations where id = $1",
      [attempt.rows[0]!.observation_id],
    );
    expect(observation.rows[0]).toEqual({
      kind: "dm_messages", producer: "fansly-sync:dm-messages.head",
      parse_version: familyForObservation({ source: "pull", kind: "dm_messages" })!.version, messages: 23,
    });
    // Events (first writer wins) and the archive, in the same commit.
    expect(await scalar(
      "select count(*)::int as n from domain_events where account_id = $1 and type in ('message.received', 'message.sent')", [pageId],
    )).toBe(23);
    expect(await scalar(
      "select count(*)::int as n from message_archive where account_id = $1 and platform = 'fansly' and message_ref = any($2::text[])",
      [pageId, [msg(21), msg(22), msg(23)]],
    )).toBe(3);
    // The tip sidecar keeps its observation lineage (0230).
    const tipRow = await testDb.pool.query("select source_observation_id::text as obs, source_raw_payload_id from transaction_tip_contexts where platform_tip_id = $1", [tip.id]);
    expect(tipRow.rows[0]).toEqual({ obs: attempt.rows[0]!.observation_id, source_raw_payload_id: null });
  });

  it("a demand that arrives while the read is in flight gets one more read (I11)", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, { n: 2, stored: range(1, 5), chain: true });
    const registry = await registryFor(pageId);
    await demand(pageId, "dm-messages.head", 2, [msg(6)]);
    const afterFirstApply: Array<{ applied: string; demanded: string; ids: string[] }> = [];
    let applies = 0;
    // The fan writes again while the read is on the wire: a message created
    // after the read was sent, which its answer cannot show.
    const lateAtMs = Date.now() + 10_000;
    const late = snowflake(lateAtMs);
    const { requests } = await runLive(
      pageId,
      registry,
      (req, index) => {
        const answer = serve(groupOf(2), range(1, 6))(req) as Extract<FanslyWireOutcome, { kind: "response" }>;
        if (index === 0) return answer;
        const body = JSON.parse(answer.bodyText) as { response: { messages: unknown[] } };
        return okResponse({
          messages: [{ ...wireMessage(groupOf(2), 0), id: late, createdAt: Math.floor(lateAtMs / 1000) }, ...body.response.messages],
        });
      },
      async () => (await workRow(pageId, "dm-messages.head", 2))?.state === "done",
      {
        onHit: async (_req, index) => {
          if (index === 0) await demand(pageId, "dm-messages.head", 2, [late]);
        },
        faults: async (point) => {
          if (point !== "after_apply" || applies++ > 0) return;
          const row = await workRow(pageId, "dm-messages.head", 2);
          afterFirstApply.push({ applied: row!.applied_revision, demanded: row!.demand_revision, ids: row!.demand.messageIds });
        },
      },
    );
    expect(requests.map(beforeOf)).toEqual([null, null]);
    // The older answer applied, resolved message 6 (its own revision), and
    // left the newer demand open for one more read.
    expect(afterFirstApply).toEqual([{ applied: "1", demanded: "2", ids: [late] }]);
    const head = await workRow(pageId, "dm-messages.head", 2);
    expect(head).toMatchObject({ state: "done", applied_revision: "2", demand_revision: "2" });
    expect((await thread(threadId)).head_confirmed_id).toBe(late);
  });

  it("retries an id the vendor's head does not show yet at 15 s and 60 s, then settles it not found", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await seedThread(pageId, { n: 3, stored: range(1, 5), chain: true });
    const registry = await registryFor(pageId);
    await liveOverlay(pageId, 3, 9);
    await demand(pageId, "dm-messages.head", 3, [msg(9)]);
    const respond = serve(groupOf(3), range(1, 5));
    const delays: number[] = [];
    for (const misses of [1, 2]) {
      await runLive(pageId, registry, respond, async () => {
        const row = await workRow(pageId, "dm-messages.head", 3);
        return row !== null && (row.cursor.misses as Record<string, number> | undefined)?.[msg(9)] === misses && row.state === "open";
      });
      const row = await workRow(pageId, "dm-messages.head", 3);
      delays.push(row!.due_at.getTime() - row!.updated_at.getTime());
      // Time passes: the retry is due.
      await testDb.pool.query("update sync_work set due_at = now() where id = $1", [row!.id]);
    }
    expect(delays[0]).toBeGreaterThan(14_000);
    expect(delays[0]).toBeLessThan(16_000);
    expect(delays[1]).toBeGreaterThan(59_000);
    expect(delays[1]).toBeLessThan(61_000);
    await runLive(pageId, registry, respond, async () => (await workRow(pageId, "dm-messages.head", 3))?.state === "done");
    expect(await workRow(pageId, "dm-messages.head", 3)).toMatchObject({ close_reason: "confirmed", demand: expect.objectContaining({ messageIds: [] }) });
    const overlay = await testDb.pool.query("select confirm_outcome, confirm_source, confirmed_at is not null as confirmed from dm_live_messages where platform_message_id = $1", [msg(9)]);
    expect(overlay.rows[0]).toEqual({ confirm_outcome: "not_found", confirm_source: null, confirmed: true });
    expect(await scalar("select count(*)::int as n from sync_attempts where page_id = $1 and resource = 'dm-messages.head'", [pageId])).toBe(3);
  });

  it("reads 60 new messages down until the staged walk meets the chain, which moves only then", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, { n: 4, stored: range(1, 10), chain: true });
    const registry = await registryFor(pageId);
    await demand(pageId, "dm-messages.head", 4, [msg(70)]);
    const headsDuringWalk: Array<string | null> = [];
    const { requests } = await runLive(pageId, registry, serve(groupOf(4), range(1, 70)),
      async () => (await workRow(pageId, "dm-messages.head", 4))?.state === "done",
      { onHit: async () => void headsDuringWalk.push((await thread(threadId)).head_confirmed_id) });
    expect(requests.map(beforeOf)).toEqual([null, msg(46), msg(21)]);
    // No chain update before the walk joined.
    expect(headsDuringWalk).toEqual([msg(10), msg(10), msg(10)]);
    expect(await thread(threadId)).toMatchObject({
      head_confirmed_id: msg(70), contiguous_count: 70, chain_upward_count: "60", contiguous_oldest_id: msg(1), stored_message_count: 70,
    });
    expect(await storedIds(threadId)).toHaveLength(70);
  });

  it("joins a walk that crosses a head the vendor no longer serves", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, { n: 5, stored: range(1, 10), chain: true });
    const registry = await registryFor(pageId);
    await demand(pageId, "dm-messages.head", 5, [msg(40)]);
    // Message 10 (the confirmed head) was deleted on Fansly.
    const { requests } = await runLive(pageId, registry, serve(groupOf(5), [...range(1, 9), ...range(11, 40)]),
      async () => (await workRow(pageId, "dm-messages.head", 5))?.state === "done");
    expect(requests.map(beforeOf)).toEqual([null, msg(16)]);
    expect(await thread(threadId)).toMatchObject({ head_confirmed_id: msg(40), contiguous_count: 40, chain_upward_count: "30" });
  });

  it("drops a staged walk whose base is no longer the chain's head and reads the head again", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, { n: 6, stored: range(1, 10), chain: true });
    const registry = await registryFor(pageId);
    const row = await demand(pageId, "dm-messages.head", 6, [msg(12)]);
    // Staged by an earlier read from head 5; another read has moved the head to 10 since.
    await testDb.pool.query("update sync_work set cursor = $2::jsonb where id = $1", [row.id, JSON.stringify({
      segment: { baseHeadId: msg(5), headId: msg(40), headAt: new Date().toISOString(), oldestId: msg(16), oldestCreatedAtMs: null, count: 25 },
    })]);
    const { requests } = await runLive(pageId, registry, serve(groupOf(6), range(1, 12)),
      async () => (await workRow(pageId, "dm-messages.head", 6))?.state === "done");
    expect(requests.map(beforeOf)).toEqual([null]);
    expect((await thread(threadId)).head_confirmed_id).toBe(msg(12));
  });

  it("feeds the archive by dedup keys when the minutely driver appended the events first", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await seedThread(pageId, { n: 7, stored: range(1, 3), chain: true });
    const registry = await registryFor(pageId);
    await demand(pageId, "dm-messages.head", 7, [msg(5)]);
    const family = familyForObservation({ source: "pull", kind: "dm_messages" })!;
    const { requests } = await runLive(pageId, registry, serve(groupOf(7), range(1, 5)),
      async () => (await workRow(pageId, "dm-messages.head", 7))?.state === "done",
      {
        // Between the capture (tx 2) and the apply (tx 3) the sweep gets to it.
        faults: async (point) => {
          if (point !== "after_capture") return;
          const obs = await testDb!.pool.query<{ id: string; received_at: Date; payload: unknown }>(
            "select id::text, received_at, payload from observations where account_id = $1 and kind = 'dm_messages' order by id desc limit 1",
            [pageId],
          );
          const row = obs.rows[0]!;
          await db().transaction(async (tx) => {
            await canonicalizeObservationInTransaction(tx as unknown as Database, family, {
              id: Number(row.id), source: "pull", producer: "sweep", platform: "fansly", accountId: pageId,
              kind: "dm_messages", payload: row.payload, observedAt: null, receivedAt: row.received_at,
            }, { nativeAccountRefByAccountId: new Map([[pageId, OWN]]) });
          });
        },
      });
    expect(requests).toHaveLength(1);
    expect(await scalar(
      "select count(*)::int as n from domain_events where account_id = $1 and type in ('message.received', 'message.sent')", [pageId],
    )).toBe(5);
    expect(await scalar(
      "select count(*)::int as n from message_archive where account_id = $1 and message_ref = any($2::text[])",
      [pageId, range(1, 5).map(msg)],
    )).toBe(5);
  });

  it("drops a fenced fan's rows from every write and keeps the page's own", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, { n: 8 });
    const registry = await registryFor(pageId);
    const user = await testDb.pool.query<{ id: string }>(
      "insert into users (username, password_hash, role) values ('owner-fence', 'x', 'owner') returning id::text as id",
    );
    await testDb.pool.query(
      "insert into erasure_log (scope_type, scope_ref, initiated_by, dry_run, plan) values ('fan', $1, $2, false, '{}'::jsonb)",
      [`fan:fansly:${FAN}`, Number(user.rows[0]!.id)],
    );
    await demand(pageId, "dm-messages.head", 8, [msg(4)]);
    const metrics = new RecordingMetrics();
    await runLive(pageId, registry, serve(groupOf(8), range(1, 4)),
      async () => (await workRow(pageId, "dm-messages.head", 8))?.state === "done", { metrics });
    // Even k are the page's own messages.
    expect(await storedIds(threadId)).toEqual([msg(2), msg(4)]);
    expect(await scalar("select count(*)::int as n from domain_events where account_id = $1 and type = 'message.received'", [pageId])).toBe(0);
    expect(await scalar("select count(*)::int as n from domain_events where account_id = $1 and type = 'message.sent'", [pageId])).toBe(2);
    expect(await scalar("select count(*)::int as n from message_archive where account_id = $1", [pageId])).toBe(2);
    // The read itself is a chain fact: the chat's head is confirmed.
    expect((await thread(threadId)).head_confirmed_id).toBe(msg(4));
  });

  it("settles the observation under the fence when an erasure deletes the chat between the capture and the apply", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, { n: 18, stored: range(1, 3), chain: true });
    const registry = await registryFor(pageId);
    const user = await testDb.pool.query<{ id: string }>(
      "insert into users (username, password_hash, role) values ('owner-erasure', 'x', 'owner') returning id::text as id",
    );
    await demand(pageId, "dm-messages.head", 18, [msg(5)]);
    await runLive(pageId, registry, serve(groupOf(18), range(1, 5)),
      async () => (await workRow(pageId, "dm-messages.head", 18))?.state === "done",
      {
        // The capture (tx 2) takes no fence: the erasure's tombstone and its
        // thread delete land after it, before the apply. (A real fan erasure
        // also deletes the chat's work and attempts, by subject; this is the
        // apply that still runs when the attempt outlives the thread.)
        faults: async (point) => {
          if (point !== "after_capture") return;
          await testDb!.pool.query(
            "insert into erasure_log (scope_type, scope_ref, initiated_by, dry_run, plan) values ('fan', $1, $2, false, $3::jsonb)",
            [`fan:fansly:${FAN}`, Number(user.rows[0]!.id), JSON.stringify({ resolvedFanGroupIds: [groupOf(18)] })],
          );
          await testDb!.pool.query("delete from page_dm_threads where id = $1", [threadId]);
        },
      });
    expect(await workRow(pageId, "dm-messages.head", 18)).toMatchObject({ state: "done", close_reason: "thread_missing" });
    const attempt = await testDb.pool.query<{ apply_state: string; observation_id: string }>(
      "select apply_state, observation_id::text from sync_attempts where page_id = $1 and resource = 'dm-messages.head'",
      [pageId],
    );
    expect(attempt.rows).toEqual([{ apply_state: "applied", observation_id: expect.any(String) }]);
    // Stamped by the apply, every message fenced: the sweep has nothing left
    // to append, and nothing of the erased chat reaches the ledger or the archive.
    expect(await scalar("select parse_version as n from observations where id = $1", [attempt.rows[0]!.observation_id]))
      .toBe(familyForObservation({ source: "pull", kind: "dm_messages" })!.version);
    expect(await scalar("select count(*)::int as n from domain_events where account_id = $1", [pageId])).toBe(0);
    expect(await scalar("select count(*)::int as n from message_archive where account_id = $1", [pageId])).toBe(0);
    expect(await scalar("select count(*)::int as n from page_dm_messages where platform_account_id = $1", [pageId])).toBe(0);
  });

  it("a chat excluded between the capture and the apply writes no rows, yet its events are appended and the observation stamped", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, { n: 19, stored: range(1, 3), chain: true });
    const registry = await registryFor(pageId);
    await demand(pageId, "dm-messages.head", 19, [msg(5)]);
    await runLive(pageId, registry, serve(groupOf(19), range(1, 5)),
      async () => (await workRow(pageId, "dm-messages.head", 19))?.state === "done",
      {
        faults: async (point) => {
          if (point !== "after_capture") return;
          await testDb!.pool.query("update page_dm_threads set metadata = $2::jsonb where id = $1", [
            threadId, JSON.stringify({ [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY]: "partner_missing_from_aggregation_accounts" }),
          ]);
        },
      });
    expect(await workRow(pageId, "dm-messages.head", 19)).toMatchObject({ state: "done", close_reason: "excluded" });
    expect(await storedIds(threadId)).toEqual(range(1, 3).map(msg));
    expect((await thread(threadId)).head_confirmed_id).toBe(msg(3));
    const observation = await testDb.pool.query<{ parse_version: number | null }>(
      "select o.parse_version from observations o join sync_attempts a on a.observation_id = o.id where a.page_id = $1",
      [pageId],
    );
    expect(observation.rows).toEqual([{ parse_version: familyForObservation({ source: "pull", kind: "dm_messages" })!.version }]);
    // The captured facts are the ledger's (nothing fences them): the same
    // events the sweep would have appended, archived in the same commit.
    expect(await scalar(
      "select count(*)::int as n from domain_events where account_id = $1 and type in ('message.received', 'message.sent')", [pageId],
    )).toBe(5);
    expect(await scalar("select count(*)::int as n from message_archive where account_id = $1", [pageId])).toBe(5);
  });

  it("asks for a purchase walk only for order sidecars the media plane has not recorded", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await seedThread(pageId, { n: 9, stored: range(1, 2), chain: true });
    const registry = await registryFor(pageId);
    const orderedAt = Math.floor((BASE_MS + 2_000) / 1000);
    await testDb.pool.query(
      `insert into media_orders (page_id, platform, media_offer_ref, buyer_platform_user_id, occurred_at, first_observed_at,
              last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
       values ($1, 'fansly', '600000000000000001', $2, to_timestamp($3), now(), now(), repeat('a', 64), 1, 1, 1)`,
      [pageId, FAN, orderedAt],
    );
    await demand(pageId, "dm-messages.head", 9, [msg(3)]);
    await runLive(pageId, registry, serve(groupOf(9), range(1, 3), {
      accountMediaOrders: [
        { accountMediaId: "600000000000000001", accountId: FAN, createdAt: orderedAt },
        { accountMediaId: "600000000000000002", accountMediaBundleId: "650000000000000001", accountId: FAN, createdAt: orderedAt },
      ],
    }), async () => (await workRow(pageId, "dm-messages.head", 9))?.state === "done");
    const targets = await testDb.pool.query<{ subject: string; params: unknown }>(
      "select subject, params from sync_work where page_id = $1 and resource = 'purchases.targets' and not shadow",
      [pageId],
    );
    expect(targets.rows).toEqual([{ subject: "bundle:650000000000000001", params: { target: { kind: "bundle", id: "650000000000000001" } } }]);
  });
});

describe("dm-messages without a request", () => {
  it("closes a catch-up the chain already reached, and never reads an excluded or unbound chat", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await seedThread(pageId, { n: 10, stored: range(1, 20), chain: true });
    await seedThread(pageId, { n: 11, stored: range(1, 3), excluded: true });
    await seedThread(pageId, { n: 12, bound: false });
    const registry = await registryFor(pageId);
    await demand(pageId, "dm-messages.catchup", 10, [msg(15)]);
    await demand(pageId, "dm-messages.head", 11, [msg(4)]);
    await demand(pageId, "dm-messages.head", 12, [msg(1)]);
    const { requests } = await runLive(pageId, registry, () => {
      throw new Error("no read expected");
    }, async () => {
      const rows = await Promise.all([
        workRow(pageId, "dm-messages.catchup", 10), workRow(pageId, "dm-messages.head", 11), workRow(pageId, "dm-messages.head", 12),
      ]);
      return rows.every((row) => row?.state === "done");
    });
    expect(requests).toHaveLength(0);
    expect((await workRow(pageId, "dm-messages.catchup", 10))?.close_reason).toBe("covered");
    expect((await workRow(pageId, "dm-messages.head", 11))?.close_reason).toBe("excluded");
    expect((await workRow(pageId, "dm-messages.head", 12))?.close_reason).toBe("unbound");
  });
});

describe("dm-messages.head for a chat without a thread row (D5, step 3 import I.3b)", () => {
  /** The list head without the chat, its group detail, its messages. */
  function respondFor(groupId: string, detailMembers: readonly string[], ks: readonly number[]): Responder {
    const messages = serve(groupId, ks);
    return (req) => {
      if (req.spec === "messaging.groups") return okResponse({ data: [], aggregationData: { accounts: [], groups: [] } });
      if (req.spec === "group.detail") {
        return okResponse({
          id: groupId,
          type: 1,
          groupFlags: 0,
          createdBy: detailMembers[0] ?? OWN,
          users: [OWN, ...detailMembers].map((userId) => ({ groupId, userId, type: 0, permissionFlags: 0 })),
          lastMessage: wireMessage(groupId, Math.max(...ks)),
        });
      }
      return messages(req);
    };
  }

  async function findRows(pageId: number, n: number) {
    const result = await testDb!.pool.query<{ state: string; close_reason: string | null; demand: { reasons: string[] } }>(
      "select state, close_reason, demand from sync_work where page_id = $1 and resource = 'dm-conversations.find' and subject = $2 order by id",
      [pageId, groupOf(n)],
    );
    return result.rows;
  }

  it("a carried fan message legacy never made a thread for: one find creates the thread, then the same head reads it", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    // The fan wrote before the engine took the page (a carried confirmation):
    // the find's own list follow-up would not read it (history by request).
    await testDb.pool.query("update sync_pages set legacy_imported_at = clock_timestamp() - interval '1 hour' where page_id = $1", [pageId]);
    const registry = await registryFor(pageId);
    await liveOverlay(pageId, 30, 3);
    await demand(pageId, "dm-messages.head", 30, [msg(3)]);
    const { requests } = await runLive(pageId, registry, respondFor(groupOf(30), [FAN], [1, 3]),
      async () => (await workRow(pageId, "dm-messages.head", 30))?.state === "done");

    expect(requests.map((req) => req.spec)).toEqual(["messaging.groups", "group.detail", "messages.page"]);
    expect(await findRows(pageId, 30)).toEqual([
      { state: "done", close_reason: "found_by_detail", demand: expect.objectContaining({ reasons: ["dependency:dm-messages.head"] }) },
    ]);
    const heads = await scalar("select count(*)::int as n from sync_work where page_id = $1 and resource = 'dm-messages.head'", [pageId]);
    expect(heads).toBe(1);
    expect(await workRow(pageId, "dm-messages.head", 30)).toMatchObject({ state: "done", close_reason: "confirmed" });
    const created = await testDb.pool.query<{ id: string; fan_id: string | null; partner: string }>(
      "select id::text, fan_id::text, partner_platform_user_id as partner from page_dm_threads where platform_conversation_id = $1",
      [groupOf(30)],
    );
    expect(created.rows[0]).toMatchObject({ partner: FAN, fan_id: expect.any(String) });
    expect(await storedIds(Number(created.rows[0]!.id))).toEqual([msg(1), msg(3)]);
    const overlay = await testDb.pool.query("select confirm_outcome from dm_live_messages where platform_message_id = $1", [msg(3)]);
    expect(overlay.rows[0]).toEqual({ confirm_outcome: "match" });
  });

  it("a find that creates no direct chat closes the head thread_missing; the chat is asked for once and never read", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const registry = await registryFor(pageId);
    await liveOverlay(pageId, 31, 3);
    await demand(pageId, "dm-messages.head", 31, [msg(3)]);
    const { requests } = await runLive(pageId, registry, respondFor(groupOf(31), [], [3]),
      async () => (await workRow(pageId, "dm-messages.head", 31))?.state === "done");

    expect(requests.map((req) => req.spec)).toEqual(["messaging.groups", "group.detail"]);
    expect(await findRows(pageId, 31)).toEqual([expect.objectContaining({ state: "done", close_reason: "not_a_chat" })]);
    expect(await workRow(pageId, "dm-messages.head", 31)).toMatchObject({ state: "done", close_reason: "thread_missing" });
    expect(await scalar("select count(*)::int as n from page_dm_threads where platform_account_id = $1", [pageId])).toBe(0);
  });

  it("without the socket's evidence of a chat (no overlay row, or the page's own mass-message container) closes at once", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const registry = await registryFor(pageId);
    await demand(pageId, "dm-messages.head", 32, [msg(3)]);
    await liveOverlay(pageId, 33, 4);
    await testDb.pool.query("update dm_live_messages set message_type = 3 where platform_message_id = $1", [msg(4)]);
    await demand(pageId, "dm-messages.head", 33, [msg(4)]);
    const { requests } = await runLive(pageId, registry, () => {
      throw new Error("no request expected");
    }, async () => {
      const rows = await Promise.all([workRow(pageId, "dm-messages.head", 32), workRow(pageId, "dm-messages.head", 33)]);
      return rows.every((row) => row?.state === "done");
    });
    expect(requests).toHaveLength(0);
    expect((await workRow(pageId, "dm-messages.head", 32))?.close_reason).toBe("thread_missing");
    expect((await workRow(pageId, "dm-messages.head", 33))?.close_reason).toBe("thread_missing");
    expect(await scalar("select count(*)::int as n from sync_work where page_id = $1 and resource = 'dm-conversations.find'", [pageId])).toBe(0);
  });

  it("never asks for an excluded or unbound chat, even on the socket's evidence of a chat", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await seedThread(pageId, { n: 34, stored: range(1, 3), excluded: true });
    await seedThread(pageId, { n: 35, bound: false });
    const registry = await registryFor(pageId);
    await liveOverlay(pageId, 34, 5);
    await liveOverlay(pageId, 35, 7);
    await demand(pageId, "dm-messages.head", 34, [msg(5)]);
    await demand(pageId, "dm-messages.head", 35, [msg(7)]);
    const { requests } = await runLive(pageId, registry, () => {
      throw new Error("no request expected");
    }, async () => {
      const rows = await Promise.all([workRow(pageId, "dm-messages.head", 34), workRow(pageId, "dm-messages.head", 35)]);
      return rows.every((row) => row?.state === "done");
    });
    expect(requests).toHaveLength(0);
    expect((await workRow(pageId, "dm-messages.head", 34))?.close_reason).toBe("excluded");
    expect((await workRow(pageId, "dm-messages.head", 35))?.close_reason).toBe("unbound");
    expect(await scalar("select count(*)::int as n from sync_work where page_id = $1 and resource = 'dm-conversations.find'", [pageId])).toBe(0);
  });
});

describe("dm-messages refusals", () => {
  it("quarantines a page that breaks the contract and writes nothing of it", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, { n: 13, stored: range(1, 3), chain: true });
    const registry = await registryFor(pageId);
    await demand(pageId, "dm-messages.head", 13, [msg(5)]);
    const alerts = new RecordingAlerts();
    await runLive(pageId, registry, () => okResponse({ messages: [4, 5].map((k) => wireMessage(groupOf(13), k)) }),
      async () => (await workRow(pageId, "dm-messages.head", 13))?.state === "quarantined", { alerts });
    expect(await storedIds(threadId)).toEqual(range(1, 3).map(msg));
    expect((await thread(threadId)).head_confirmed_id).toBe(msg(3));
    const attempt = await testDb.pool.query("select apply_state, observation_id is not null as journaled from sync_attempts where page_id = $1", [pageId]);
    expect(attempt.rows).toEqual([{ apply_state: "quarantined", journaled: true }]);
  });

  it("quarantines an empty head of a chat the hub holds messages of (review, never complete)", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, { n: 14, stored: range(1, 3) });
    const registry = await registryFor(pageId);
    await demand(pageId, "dm-messages.head", 14, [msg(4)]);
    await runLive(pageId, registry, () => okResponse({ messages: [] }),
      async () => (await workRow(pageId, "dm-messages.head", 14))?.state === "quarantined");
    expect(await workRow(pageId, "dm-messages.head", 14)).toMatchObject({ last_error_class: "apply:quarantine:chain_empty_head_with_stored" });
    expect(await thread(threadId)).toMatchObject({ history_state: "unverified", head_confirmed_id: null });
  });
});

describe("dm-messages.history", () => {
  it("a history request reads the head, then below the chain to the empty page that proves the start of the chat", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const threadId = await seedThread(pageId, { n: 15, stored: range(31, 40), chain: true });
    const registry = await registryFor(pageId);
    await testDb.pool.query("update sync_pages set requests_enabled_at = clock_timestamp() - interval '1 minute' where page_id = $1", [pageId]);
    const filed = await submitHistoryRequest({ db: db(), rawConfig: testConfig(testDb.connectionString) }, {
      pageId,
      requester: { kind: "owner_cli", userId: null },
      fans: [{ kind: "conversation", conversationRef: groupOf(15) }],
      depth: { kind: "all" },
      reason: "test",
      idempotencyKey: randomUUID(),
    });
    expect(filed.items[0]).toMatchObject({ state: "queued", anchorMessageRef: null });
    const { requests } = await runLive(pageId, registry, serve(groupOf(15), range(1, 40)),
      async () => (await workRow(pageId, "dm-messages.history", 15))?.state === "done");
    // The fan had no anchor: the head first (§7.1.4), then down from the chain.
    expect(requests.map(beforeOf)).toEqual([null, msg(31), msg(6), msg(1)]);
    const result = await getHistoryRequest({ db: db(), rawConfig: testConfig(testDb.connectionString) }, filed.request.ref);
    expect(result.request).toMatchObject({ state: "done", counts: { total: 1, ready: 1 }, reads: { done: 4 } });
    expect(result.items[0]).toMatchObject({ state: "ready", satisfiedBy: "empty_page", readsSpent: 4, anchorMessageRef: msg(40), loadedMessages: 40 });
    const proofAttempt = await testDb.pool.query<{ obs: string }>(
      "select observation_id::text as obs from sync_attempts where page_id = $1 and resource = 'dm-messages.history' order by id desc limit 1",
      [pageId],
    );
    expect(await thread(threadId)).toMatchObject({
      history_state: "complete", history_proof: "empty_page", history_proof_observation_id: proofAttempt.rows[0]!.obs,
      contiguous_count: 40, contiguous_oldest_id: msg(1), message_coverage_status: "complete", message_backfill_complete: true,
      stored_message_count: 40,
    });
    expect((await workRow(pageId, "dm-messages.history", 15))?.close_reason).toBe("history_complete");
    const attempts = await testDb.pool.query<{ class: string }>(
      "select class from sync_attempts where page_id = $1 and resource = 'dm-messages.history'", [pageId]);
    expect(attempts.rows.map((row) => row.class)).toEqual(["requests", "requests", "requests", "requests"]);
  });

  it("a short head page is never the start of a chat: only the empty page below it completes (owner decision №3, I10)", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    // A new chat of 3 messages the hub holds nothing of: its head page is short.
    const threadId = await seedThread(pageId, { n: 20 });
    const registry = await registryFor(pageId);
    await demand(pageId, "dm-messages.head", 20, [msg(3)]);
    const head = await runLive(pageId, registry, serve(groupOf(20), range(1, 3)),
      async () => (await workRow(pageId, "dm-messages.head", 20))?.state === "done");
    expect(head.requests.map(beforeOf)).toEqual([null]);
    expect(await thread(threadId)).toMatchObject({
      head_confirmed_id: msg(3), contiguous_oldest_id: msg(1), contiguous_count: 3, history_state: "partial",
      history_proof: null, history_proof_observation_id: null, stored_message_count: 3,
      message_coverage_status: "partial_window", message_backfill_complete: false,
    });
    expect(await workRow(pageId, "dm-messages.head", 20)).toMatchObject({ close_reason: "confirmed" });

    // A history request reads the head (its fan has no anchor) and then below
    // the short page; the empty answer proves the start.
    await testDb.pool.query("update sync_pages set requests_enabled_at = clock_timestamp() - interval '1 minute' where page_id = $1", [pageId]);
    await submitHistoryRequest({ db: db(), rawConfig: testConfig(testDb.connectionString) }, {
      pageId,
      requester: { kind: "owner_cli", userId: null },
      fans: [{ kind: "conversation", conversationRef: groupOf(20) }],
      depth: { kind: "all" },
      reason: "test",
      idempotencyKey: randomUUID(),
    });
    const history = await runLive(pageId, registry, serve(groupOf(20), range(1, 3)),
      async () => (await workRow(pageId, "dm-messages.history", 20))?.state === "done");
    expect(history.requests.map(beforeOf)).toEqual([null, msg(1)]);
    const proofAttempt = await testDb.pool.query<{ obs: string }>(
      "select observation_id::text as obs from sync_attempts where page_id = $1 and resource = 'dm-messages.history' order by id desc limit 1",
      [pageId],
    );
    expect(await thread(threadId)).toMatchObject({
      history_state: "complete", history_proof: "empty_page", history_proof_observation_id: proofAttempt.rows[0]!.obs,
      contiguous_count: 3, message_coverage_status: "complete", message_backfill_complete: true,
    });
  });
});

describe("dm-messages in shadow and replay", () => {
  it("estimates ⌈ids / 25⌉ reads and writes nothing but its own work and attempts", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("shadow");
    await seedThread(pageId, { n: 16, stored: range(1, 3), chain: true });
    const registry = await registryFor(pageId, true);
    await demand(pageId, "dm-messages.head", 16, range(4, 63).map(msg), { shadow: true });
    const before = await tableCounts(testDb.pool);
    const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, mode: "shadow", registry });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => ((await workRow(pageId, "dm-messages.head", 16, true))?.state === "done" ? true : null), 30_000, "shadow walk");
    } finally {
      stop.abort();
      await run;
    }
    expect(await scalar(
      "select count(*)::int as n from sync_attempts where page_id = $1 and shadow and resource = 'dm-messages.head' and outcome = 'shadow'", [pageId],
    )).toBe(3);
    expect(changedTables(before, await tableCounts(testDb.pool)).filter((name) => !["sync_work", "sync_attempts", "sync_pages"].includes(name)))
      .toEqual([]);
  });

  it("replays a legacy dm_messages page against what legacy stored", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("shadow");
    await seedThread(pageId, { n: 17, stored: range(1, 3) });
    const replay = dmMessagesModule("head").replay!;
    // Received after legacy stored the rows (a later re-read would be a match).
    const observation = (payload: unknown) => ({ id: 1, receivedAt: new Date(Date.now() + HOUR), kind: "dm_messages", pageId, payload });
    const page = { messages: [3, 2, 1].map((k) => wireMessage(groupOf(17), k)) };
    expect(await replay(observation(page), { db: db(), pageId })).toMatchObject({ kind: "match" });
    const edited = { messages: [3, 2, 1].map((k) => wireMessage(groupOf(17), k, k === 2 ? { content: "edited" } : {})) };
    expect(await replay(observation(edited), { db: db(), pageId })).toMatchObject({ kind: "mismatch", reason: "rows_differ" });
    const unknown = { messages: [wireMessage(groupOf(99), 1)] };
    expect(await replay(observation(unknown), { db: db(), pageId })).toMatchObject({ kind: "mismatch", reason: "thread_missing" });
    expect(await replay(observation({ contractAccepted: false, raw: { error: "x" } }), { db: db(), pageId }))
      .toMatchObject({ kind: "match", detail: { legacyRefused: true } });
  });
});
