import { wrapped } from "./helpers/fansly-ws-fixtures.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendDomainEventsInTransaction,
  applyMessageEventsToArchive,
  DM_ARCHIVE_ERASURE_FENCE_LOCK_NS,
  getSyncPage,
  listDomainEventsByDedupKeys,
  setPageHold,
  upsertDemand,
  upsertPageDmMessages,
  type Database,
} from "@agency_hub_core/db";

import { applyFanslyWsLive } from "../apps/runtime/src/services/fansly-ws/live-apply.ts";
import { ApplyQuarantine } from "../apps/runtime/src/sync/engine/commit.ts";
import { createEngineRegistry, type EngineRegistry, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { DM_LIVE_DELETIONS_OVERFLOW_BATCH } from "../apps/runtime/src/sync/fansly/resources/dm-live.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { seedWsCapturePage, seedWsThread, wsCreated, wsDeleted, wsMessage, type WsCapturePage } from "./helpers/fansly-ws-capture.ts";
import { runActorUntil, until } from "./helpers/sync-engine.ts";
import { pageHoldKindOf } from "./helpers/sync-holds.ts";
import {
  makeTestActor,
  quietLogger,
  RecordingMetrics,
  ScriptedLiveTransport,
  setModeDirect,
  testSpec,
} from "./helpers/sync-engine-host.ts";

// `dm-live.deletions` on a live page (step-3 design §3.3 item 4, G5, E6, E7):
// a socket deletion acked by the step-1 apply (overlay mark + the post-ack
// hook's demand) reaches the hot table, the event ledger and the archive in
// one `local` step of the actor — no request, before the HTTP gate, so no page
// hold or pacer slot delays it (step 3b ruling 9) — under the erasure fence, and
// the stored window of the thread is recounted from the archive by the
// engine's own writer (step 4, S4-08; head and chain untouched). Sticky against a late create frame and a later
// REST copy; an erasure-fenced fan gets nothing written; on a page the engine
// does not own the hook routes nothing.

const OWN = "300000000000000071";
const FAN = "510000000000000071";
const GROUP = "620000000000000071";

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

const app = () => ({ db: db(), logger: quietLogger as never });

async function scalar(text: string, values: unknown[] = []): Promise<number> {
  const result = await testDb!.pool.query<{ n: number }>(text, values);
  return Number(result.rows[0]?.n ?? 0);
}

interface Stored {
  page: WsCapturePage;
  threadId: number;
  /** Fan message, then the page's reply, then a second fan message. */
  ids: [string, string, string];
  at: [Date, Date, Date];
}

/** A live page with one bound chat of three stored messages — in the hot
 *  table and in the archive, as the engine's DM apply writes them — and the
 *  window over them; the head is the newest. */
async function seedLivePage(mode: "live" | "off" | "shadow" = "live", label?: string): Promise<Stored> {
  const handles = { db: db(), pool: testDb!.pool };
  const page = await seedWsCapturePage(handles, { ownRef: OWN, ...(label === undefined ? {} : { label }) });
  if (mode !== "off") await setModeDirect(testDb!.pool, page.pageId, mode);
  const threadId = await seedWsThread(handles, { pageId: page.pageId, groupId: GROUP, fanRef: FAN });
  const base = Date.now() - 3_600_000;
  const ids: [string, string, string] = [String(910_000_000_000_100_001n), String(910_000_000_000_100_002n), String(910_000_000_000_100_003n)];
  const at: [Date, Date, Date] = [new Date(base), new Date(base + 60_000), new Date(base + 120_000)];
  const roles = ["fan", "model", "fan"] as const;
  await upsertPageDmMessages(db(), ids.map((id, index) => ({
    conversationId: threadId,
    platformAccountId: page.pageId,
    platformMessageId: id,
    senderPlatformUserId: roles[index] === "fan" ? FAN : OWN,
    senderRole: roles[index]!,
    createdAt: at[index]!,
    content: `message ${id}`,
    totalTipAmountCents: 0,
    inReplyToMessageId: null,
    inReplyToRootMessageId: null,
  })));
  for (const [index, id] of ids.entries()) {
    await testDb!.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id, sender_role,
         is_sent_by_me, occurred_at, text_plain)
       values ($1, 'fansly', $2, $3, $4, $5, $6, $7, $8)`,
      [page.pageId, GROUP, id, FAN, roles[index], roles[index] === "model", at[index], `message ${id}`],
    );
  }
  await testDb!.pool.query(
    `update page_dm_threads
        set stored_message_count = 3, newest_stored_message_id = $2, oldest_stored_message_id = $3,
            last_fan_message_at = $4, last_model_message_at = $5, last_message_id = $2, last_message_at = $4,
            message_coverage_status = 'partial_window', head_confirmed_id = null
      where id = $1`,
    [threadId, ids[2], ids[0], at[2], at[1]],
  );
  return { page, threadId, ids, at };
}

/** A deletion frame as the receiver captures it, applied and acked by the
 *  step-1 driver with the production post-ack hook. */
async function deleteFrame(page: WsCapturePage, messageId: string, groupId: string | null = GROUP): Promise<number> {
  const observationId = await page.capture(wsDeleted(messageId, groupId));
  const result = await applyFanslyWsLive(app(), observationId);
  expect(result?.status).toBe("applied");
  return observationId;
}

function deletionsRegistry(): EngineRegistry {
  return createEngineRegistry([fanslyResourceSpec("dm-live.deletions")!]);
}

async function work(pageId: number, subject = GROUP) {
  const result = await testDb!.pool.query<{
    id: string; state: string; close_reason: string | null; message_ids: string[];
    waiting_reason: string | null; last_error_class: string | null;
  }>(
    `select id::text, state, close_reason, demand->'messageIds' as message_ids, waiting_reason, last_error_class from sync_work
      where page_id = $1 and not shadow and resource = 'dm-live.deletions' and subject = $2 order by id desc limit 1`,
    [pageId, subject],
  );
  return result.rows[0] ?? null;
}

async function runDeletions(
  pageId: number,
  metrics = new RecordingMetrics(),
  subject = GROUP,
  options: { floorDelayMs?: number } = {},
): Promise<ScriptedLiveTransport> {
  const transport = new ScriptedLiveTransport();
  const made = await makeTestActor({
    db: db(), pageId, registry: deletionsRegistry(), transport, metrics, ownRef: OWN, ...options,
  });
  await runActorUntil(made, async () => (await work(pageId, subject))?.state === "done", 20_000, "the deletions carried");
  return transport;
}

async function hotRow(pageId: number, messageId: string) {
  const result = await testDb!.pool.query<{ deleted_at: Date | null }>(
    "select deleted_at from page_dm_messages where platform_account_id = $1 and platform_message_id = $2",
    [pageId, messageId],
  );
  return result.rows[0] ?? null;
}

async function overlayDeletedAt(pageId: number, messageId: string): Promise<Date | null> {
  const result = await testDb!.pool.query<{ deleted_at: Date | null }>(
    "select deleted_at from dm_live_messages where page_id = $1 and platform_message_id = $2", [pageId, messageId],
  );
  return result.rows[0]?.deleted_at ?? null;
}

async function archiveRow(pageId: number, messageId: string) {
  const result = await testDb!.pool.query<{ deleted_at: Date | null; content_pending: boolean; text_plain: string | null }>(
    "select deleted_at, content_pending, text_plain from message_archive where account_id = $1 and platform = 'fansly' and message_ref = $2",
    [pageId, messageId],
  );
  return result.rows[0] ?? null;
}

async function threadWindow(threadId: number) {
  const result = await testDb!.pool.query<{
    stored_message_count: number;
    newest_stored_message_id: string | null;
    oldest_stored_message_id: string | null;
    last_fan_message_at: Date | null;
    last_model_message_at: Date | null;
    last_message_id: string | null;
    message_coverage_status: string;
    head_confirmed_id: string | null;
    history_state: string;
  }>(
    `select stored_message_count, newest_stored_message_id, oldest_stored_message_id, last_fan_message_at,
            last_model_message_at, last_message_id, message_coverage_status::text, head_confirmed_id, history_state
       from page_dm_threads where id = $1`,
    [threadId],
  );
  return result.rows[0]!;
}

async function deletedEvents(pageId: number): Promise<Array<{ message_ref: string; dedup_key: string; observation_id: string }>> {
  const result = await testDb!.pool.query<{ message_ref: string; dedup_key: string; observation_id: string }>(
    `select message_ref, dedup_key, observation_id::text from domain_events
      where account_id = $1 and type = 'message.deleted' order by message_ref`,
    [pageId],
  );
  return result.rows;
}

describe("audit: deletion overflow must preserve known-group tombstones", () => {
  it("201 no-group deletes after one known create must tombstone all messages", async (context) => {
    if (!testDb) return context.skip();
    const { page, ids } = await seedLivePage();
    // The socket has already established the group; a no-group deletion must keep it.
    const created = await page.capture(wsCreated(wsMessage({ id: ids[0], groupId: GROUP, senderId: FAN })));
    expect((await applyFanslyWsLive(app(), created))?.status).toBe("applied");
    const deleteIds = [ids[0], ...Array.from({length: 200}, (_,i) => String(920000000000000000n + BigInt(i)))];
    const deleted = await page.capture(wrapped(10001, deleteIds.map(id => wsDeleted(id, null))));
    expect((await applyFanslyWsLive(app(), deleted))?.status).toBe("applied");
    const demand = await testDb.pool.query("select demand from sync_work where page_id=$1 and resource='dm-live.deletions' and subject=''", [page.pageId]);
    expect(demand.rows[0].demand.overflow).toBe(true);
    expect(demand.rows[0].demand.messageIds).toHaveLength(200);
    const transport = await runDeletions(page.pageId, new RecordingMetrics(), "");
    expect(transport.hits).toEqual([]);
    expect(await overlayDeletedAt(page.pageId, ids[0])).not.toBeNull();
    expect(await work(page.pageId, "")).toMatchObject({state:"done", close_reason:"ws_deletions_applied"});
    // Regression: actual remains null, because overflow query selects group IS NULL only.
    expect((await archiveRow(page.pageId, ids[0]))!.deleted_at).not.toBeNull();
    expect((await deletedEvents(page.pageId))).toHaveLength(201);
  }, 60000);
});
