// #135 A2b: projection debt machinery. The 05..11.07 incident: the
// page_dm_threads summary recompute (finalize) violated the 0026 CHECK
// constraint inside the same transaction as the message upsert + checkpoint
// advance, wedging the page's whole dm_messages stream. This suite recreates
// that failure shape with a test-only CHECK constraint and proves:
//   1. the chunk records projection debt, clears the cursor pin, keeps the
//      already-journaled message facts, and does NOT throw;
//   2. the repair sweep re-runs the recompute and resolves the debt.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  getCheckpoint,
  listUnresolvedProjectionDebt,
  PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
  recordProjectionDebt,
  resolveProjectionDebt,
  startSyncRun,
  findPageById,
  upsertFans,
} from "@agency_hub_core/db";
import type { HttpRequestEvent } from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { fanslyDmMessagesChunk } from "../apps/runtime/src/services/sync/executor-handlers.ts";
import { runProjectionDebtSweep } from "../apps/runtime/src/services/projection-debt-sweep.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;

const PAGE_SELF_ACCOUNT_ID = "model-self-1";
const FAN_PLATFORM_USER_ID = "fan-77";
const CONVERSATION_GROUP_ID = "conv-group-77";

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
  appContext = createTestAppContext(testDb, { syncSharedRateLimitEnabled: true });
});

function fakeTelemetry() {
  return {
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    recordDmMessagesChunkSummary: vi.fn(async () => {}),
    addAnomaly: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    getRequestObserver: () => null,
  };
}

function fanslyMessagesAdapter(messages: Array<{ id: string; createdAt: number }>) {
  return {
    async getMessagesPage(
      requestContext: {
        requestObserver?: {
          onRequestEvent(event: HttpRequestEvent): Promise<void>;
        } | null;
      },
      params: { groupId: string; before?: string | null },
    ) {
      // Report the request the way the real transport does so the chunk
      // budget counts it (the loop-termination contract under test).
      await requestContext.requestObserver?.onRequestEvent({
        state: "started",
        requestId: `req-${Date.now()}-${Math.random()}`,
        operation: "messages",
        endpointTemplate: "/message",
        method: "GET",
        attemptNumber: 1,
        timestamp: new Date(),
      });
      return {
        items: messages.map((message) => ({
          id: message.id,
          senderId: FAN_PLATFORM_USER_ID,
          createdAt: message.createdAt,
          content: `message ${message.id}`,
        })),
        groupId: params.groupId,
        before: params.before ?? null,
        done: true,
        raw: { response: { messages: messages.map((message) => message.id) } },
      };
    },
  };
}

async function seedConversation() {
  if (!testDb) {
    throw new Error("test database missing");
  }
  const model = await createModel(appContext.db, { slug: "lora", name: "Lora" });
  if (!model) {
    throw new Error("model seed failed");
  }
  const page = await createFanslyPage(appContext.db, { modelId: model.id, label: "lora-dm-fix" });
  if (!page) {
    throw new Error("page seed failed");
  }
  // fanslyDmMessagesChunk resolves the page's own platform account id from
  // external_page_id to classify sender roles.
  await testDb.pool.query(
    "update pages set external_page_id = $1 where id = $2",
    [PAGE_SELF_ACCOUNT_ID, page.id],
  );
  const [fan] = await upsertFans(appContext.db, [{
    platform: "fansly",
    platformUserId: FAN_PLATFORM_USER_ID,
    username: "fan77",
    displayName: "Fan 77",
  }]);

  const conversation = await testDb.pool.query<{ id: number }>(`
    insert into page_dm_threads (
      platform_account_id,
      fan_id,
      platform_conversation_id,
      partner_platform_user_id,
      partner_username,
      partner_display_name,
      conversation_flags,
      unread_count,
      last_message_id,
      last_message_at,
      last_message_sender_id,
      last_message_sender_role,
      last_message_preview,
      stored_message_count,
      message_coverage_status,
      message_backfill_complete,
      is_visible,
      last_seen_generation,
      last_seen_at,
      metadata,
      updated_at
    ) values (
      $1, $2, $3, $4, $5, $6, 0, 1, $7, $8, $4, 'fan', 'hello', 0,
      'pending_backfill', false, true, 1, now(), '{}'::jsonb, now()
    )
    returning id
  `, [
    page.id,
    fan!.id,
    CONVERSATION_GROUP_ID,
    FAN_PLATFORM_USER_ID,
    "fan77",
    "Fan 77",
    "m3",
    new Date("2026-07-10T12:00:00.000Z"),
  ]);

  return { page, fan: fan!, conversationId: Number(conversation.rows[0]!.id) };
}

async function buildChunkInput(
  page: { id: number },
  telemetry: ReturnType<typeof fakeTelemetry>,
  budget: SyncChunkBudget,
) {
  const run = await startSyncRun(appContext.db, {
    platformAccountId: page.id,
    stream: "dm_messages",
    trigger: "manual",
  });
  if (!run) {
    throw new Error("sync run seed failed");
  }
  const stored = await findPageById(appContext.db, page.id);
  if (!stored) {
    throw new Error(`page ${page.id} missing`);
  }
  return {
    pageContext: {
      page: stored.page,
      platform: "fansly" as const,
      session: null,
      proxy: null,
      egressKey: "direct",
    } as never,
    streamState: { stream: "dm_messages" } as never,
    syncRunId: run.id,
    telemetry: telemetry as never,
    budget,
  };
}

describe("projection debt (#135 A2b)", () => {
  it("records debt, clears the cursor pin, and keeps the chunk alive when only the finalize step fails", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, conversationId } = await seedConversation();
    // Recreate the incident shape: a CHECK constraint the summary recount
    // violates while the message rows themselves commit fine.
    await testDb.pool.query(
      "alter table page_dm_threads drop constraint if exists test_summary_wedge",
    );
    await testDb.pool.query(`
      alter table page_dm_threads
        add constraint test_summary_wedge check (stored_message_count <= 2)
    `);

    appContext = {
      ...appContext,
      adapter: fanslyMessagesAdapter([
        { id: "m3", createdAt: Date.UTC(2026, 6, 10, 12, 0, 0) },
        { id: "m2", createdAt: Date.UTC(2026, 6, 10, 11, 0, 0) },
        { id: "m1", createdAt: Date.UTC(2026, 6, 10, 10, 0, 0) },
      ]) as never,
    };

    const telemetry = fakeTelemetry();
    // Two requests: first records the debt, second proves the loop moves on
    // (re-selects, hits the wedge again, bumps attempts) and then yields on
    // budget instead of spinning or throwing.
    const result = await fanslyDmMessagesChunk(
      appContext,
      await buildChunkInput(page, telemetry, new SyncChunkBudget(2, 60_000)),
    );

    expect(result.satisfied).toBe(false);
    expect(result.stats).toMatchObject({
      projectionDebtRecorded: 2,
      completedConversations: 0,
    });

    // One open debt row for the conversation, attempts bumped by the retry.
    const debts = await listUnresolvedProjectionDebt(appContext.db, 10);
    expect(debts).toHaveLength(1);
    expect(debts[0]).toMatchObject({
      kind: PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
      platformAccountId: page.id,
      conversationId,
      attempts: 2,
    });
    expect(debts[0]!.errorSummary).toContain("test_summary_wedge");

    // The cursor pin was cleared — the stream is NOT parked on the wedged
    // conversation.
    const checkpoint = await getCheckpoint(appContext.db, page.id, "dm_messages");
    expect(checkpoint?.state).toMatchObject({ currentConversationId: null });

    // Message facts survived the finalize failure (tx1 committed)...
    const messages = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from page_dm_messages where conversation_id = $1",
      [conversationId],
    );
    expect(messages.rows).toEqual([{ n: "3" }]);

    // ...while the thread summary is honestly stale (the debt is the signal).
    const thread = await testDb.pool.query<{ storedMessageCount: number }>(
      'select stored_message_count as "storedMessageCount" from page_dm_threads where id = $1',
      [conversationId],
    );
    expect(thread.rows[0]).toEqual({ storedMessageCount: 0 });
  }, 60_000);

  it("repair sweep re-runs the summary recompute and resolves the debt", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, conversationId } = await seedConversation();
    await testDb.pool.query(
      "alter table page_dm_threads drop constraint if exists test_summary_wedge",
    );
    await testDb.pool.query(`
      alter table page_dm_threads
        add constraint test_summary_wedge check (stored_message_count <= 2)
    `);
    appContext = {
      ...appContext,
      adapter: fanslyMessagesAdapter([
        { id: "m3", createdAt: Date.UTC(2026, 6, 10, 12, 0, 0) },
        { id: "m2", createdAt: Date.UTC(2026, 6, 10, 11, 0, 0) },
        { id: "m1", createdAt: Date.UTC(2026, 6, 10, 10, 0, 0) },
      ]) as never,
    };
    const telemetry = fakeTelemetry();
    await fanslyDmMessagesChunk(
      appContext,
      await buildChunkInput(page, telemetry, new SyncChunkBudget(1, 60_000)),
    );
    expect(await listUnresolvedProjectionDebt(appContext.db, 10)).toHaveLength(1);

    // While the wedge persists, the sweep fails honestly and bumps attempts.
    const wedgedSweep = await runProjectionDebtSweep(appContext);
    expect(wedgedSweep).toEqual({ scanned: 1, resolved: 0, failed: 1 });
    const stillOpen = await listUnresolvedProjectionDebt(appContext.db, 10);
    expect(stillOpen[0]).toMatchObject({ attempts: 2 });

    // The wedge is lifted (the real fix was migration 0084 dropping the upper
    // bound); the next sweep repairs the projection and resolves the debt.
    await testDb.pool.query("alter table page_dm_threads drop constraint if exists test_summary_wedge");
    const sweep = await runProjectionDebtSweep(appContext);
    expect(sweep).toEqual({ scanned: 1, resolved: 1, failed: 0 });

    expect(await listUnresolvedProjectionDebt(appContext.db, 10)).toHaveLength(0);
    const debtRow = await testDb.pool.query<{ attempts: number; resolvedAt: Date | null }>(
      'select attempts, resolved_at as "resolvedAt" from projection_debt where conversation_id = $1',
      [conversationId],
    );
    expect(debtRow.rows).toHaveLength(1);
    expect(debtRow.rows[0]!.resolvedAt).not.toBeNull();

    // The projection is repaired from the committed facts.
    const thread = await testDb.pool.query<{
      storedMessageCount: number;
      newestStoredMessageId: string | null;
      oldestStoredMessageId: string | null;
    }>(`
      select stored_message_count as "storedMessageCount",
             newest_stored_message_id as "newestStoredMessageId",
             oldest_stored_message_id as "oldestStoredMessageId"
      from page_dm_threads
      where id = $1
    `, [conversationId]);
    expect(thread.rows[0]).toEqual({
      storedMessageCount: 3,
      newestStoredMessageId: "m3",
      oldestStoredMessageId: "m1",
    });

    // An idle sweep after repair reports zero work (the quiet-log contract).
    expect(await runProjectionDebtSweep(appContext)).toEqual({ scanned: 0, resolved: 0, failed: 0 });
  }, 60_000);

  it("resolveProjectionDebt is idempotent and recordProjectionDebt reopens a new row after resolution", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, conversationId } = await seedConversation();

    await recordProjectionDebt(appContext.db, {
      kind: PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
      platformAccountId: page.id,
      conversationId,
      errorSummary: "first failure",
    });
    await recordProjectionDebt(appContext.db, {
      kind: PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
      platformAccountId: page.id,
      conversationId,
      errorSummary: "second failure",
    });

    const [openDebt] = await listUnresolvedProjectionDebt(appContext.db, 10);
    expect(openDebt).toMatchObject({ attempts: 2, errorSummary: "second failure" });

    expect(await resolveProjectionDebt(appContext.db, openDebt!.id)).toBe(true);
    expect(await resolveProjectionDebt(appContext.db, openDebt!.id)).toBe(false);

    // A post-resolution failure opens a FRESH row (attempts restart at 1);
    // the resolved row stays as the audit trail — nothing is deleted.
    await recordProjectionDebt(appContext.db, {
      kind: PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
      platformAccountId: page.id,
      conversationId,
      errorSummary: "third failure",
    });
    const reopened = await listUnresolvedProjectionDebt(appContext.db, 10);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject({ attempts: 1, errorSummary: "third failure" });

    const totalRows = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from projection_debt where conversation_id = $1",
      [conversationId],
    );
    expect(totalRows.rows).toEqual([{ n: "2" }]);
  }, 60_000);
});
