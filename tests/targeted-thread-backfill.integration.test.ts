// Slice C′ — targeted thread backfill (owner CLI → pg-boss → worker).
//
// What these tests pin:
//   1. the run walks EXACTLY the named thread (a decoy thread on the same page
//      that the regular picker would prefer is never touched) and journals
//      every vendor page verbatim;
//   2. the retention-depth override is a per-run parameter — a run without it
//      refuses, and the global config is never written;
//   3. an open circuit-breaker window refuses BEFORE any vendor traffic, and
//      a successful read clears a lapsed one;
//   4. the run holds the page's real dm_messages sync lease: a regular
//      executor cannot lease the stream while the targeted run walks, and a
//      lease the regular path keeps holding refuses the targeted run (after
//      the bounded wait below) instead of double-running it. A pending
//      scheduled request survives the run.
//   5. contention with the page's own chunks is waited out (bounded, no
//      vendor request) instead of refused on first sight, and the run's
//      result lands in pgboss.job.output where the CLI's --wait reads it.
//   6. `completed` is a proof: an EMPTY page reached from the stored oldest
//      message; a short page is read past, stored ground stops it `partial`.
//   7. the 500 breaker of the point path: a thread-attributable failure is
//      recorded on the thread's breaker and ends the run `vendor_error`; any
//      other failure throws with the run's spend.

import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acquirePageSyncLease,
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  getConversationSyncHealth,
  listUnresolvedProjectionDebt,
  PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
  storeFanslySession,
  upsertCheckpointProgress,
  upsertFans,
  upsertPageDmMessages,
} from "@agency_hub_core/db";
import { FanslyApiError } from "@agency_hub_core/fansly";
import {
  encryptJson,
  type FanslySessionBundle,
  type HttpRequestEvent,
} from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { loadEffectiveConfig } from "../apps/runtime/src/services/effective-config.ts";
import { emptyDmMessagesCursorState } from "../apps/runtime/src/services/sync/cursor-state.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import {
  ensureTargetedThreadBackfillQueue,
  readTargetedThreadBackfillJobStatus,
  runTargetedThreadBackfill,
  sendTargetedThreadBackfillJob,
  TARGETED_THREAD_BACKFILL_QUEUE,
  TargetedThreadBackfillRunError,
  waitForTargetedThreadBackfillJob,
} from "../apps/runtime/src/services/sync/targeted-thread-backfill.ts";
import { handleTargetedThreadBackfillJobs } from "../apps/runtime/src/worker-services.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;

const PAGE_SELF_ACCOUNT_ID = "model-self-1";
const TARGET_GROUP_ID = "group-target";
const DECOY_GROUP_ID = "group-decoy";

interface AdapterCall {
  groupId: string;
  before: string | null;
  limit: number;
}

interface ScriptedPage {
  ids: string[];
  done: boolean;
}

type ScriptedThread = ScriptedPage[] | ((callIndex: number) => ScriptedPage);

interface AdapterHooks {
  /** Fires inside the vendor call, before it returns. Throw to fail the fetch. */
  beforeReturn?: (input: { groupId: string; callIndex: number }) => Promise<void>;
  /** Attempts the HTTP layer retried before this call's successful one. */
  retriesBefore?: (callIndex: number) => number;
  /** The physical attempts the caller allows this call (null: no clamp). */
  onAttemptAllowance?: (input: { callIndex: number; allowance: number | null }) => void;
}

/** Endless history: every call returns 25 fresh older ids and `done:false`. */
function endlessPages(prefix: string): (callIndex: number) => ScriptedPage {
  return (callIndex) => ({
    ids: Array.from({ length: 25 }, (_, position) => `${prefix}-${callIndex}-${position}`),
    done: false,
  });
}

function messagesAdapter(
  script: Record<string, ScriptedThread>,
  calls: AdapterCall[],
  hooks?: AdapterHooks,
) {
  const cursors = new Map<string, number>();
  return {
    async getMessagesPage(
      requestContext: {
        requestObserver?: { onRequestEvent(event: HttpRequestEvent): Promise<void> } | null;
        remainingAttempts?: (() => number) | null;
      },
      params: { groupId: string; limit: number; before?: string | null },
    ) {
      calls.push({
        groupId: params.groupId,
        before: params.before ?? null,
        limit: params.limit,
      });
      const callIndex = cursors.get(params.groupId) ?? 0;
      cursors.set(params.groupId, callIndex + 1);
      hooks?.onAttemptAllowance?.({
        callIndex,
        allowance: requestContext.remainingAttempts?.() ?? null,
      });
      // One logical request, every attempt announced the way executeObservedRequest
      // announces it: each retried attempt is started and closed as a retry.
      const requestId = `req-${calls.length}`;
      const retries = hooks?.retriesBefore?.(callIndex) ?? 0;
      for (let attemptNumber = 1; attemptNumber <= retries + 1; attemptNumber += 1) {
        const attempt = {
          requestId,
          operation: "messages",
          endpointTemplate: "/message",
          method: "GET",
          attemptNumber,
          timestamp: new Date(),
        };
        await requestContext.requestObserver?.onRequestEvent({ ...attempt, state: "started" });
        if (attemptNumber <= retries) {
          await requestContext.requestObserver?.onRequestEvent({
            ...attempt,
            state: "retry",
            httpStatus: 503,
            failureKind: "http",
            retryDelayMs: 0,
            durationMs: 1,
          });
        }
      }
      const scripted = script[params.groupId];
      const page = typeof scripted === "function"
        ? scripted(callIndex)
        : scripted?.[callIndex] ?? { ids: [], done: true };
      await hooks?.beforeReturn?.({ groupId: params.groupId, callIndex });
      return {
        items: page.ids.map((id, position) => ({
          id,
          senderId: `fan-${params.groupId}`,
          createdAt: Date.UTC(2026, 0, 15, 12, 0, 0) - (position * 60_000),
          content: `message ${id}`,
        })),
        groupId: params.groupId,
        before: params.before ?? null,
        done: page.done,
        raw: { response: { messages: page.ids } },
      };
    },
  };
}

async function seedThread(input: {
  pageId: number;
  fanId: number;
  groupId: string;
  partnerPlatformUserId: string;
  storedMessageCount?: number;
  oldestStoredMessageId?: string | null;
}) {
  if (!testDb) {
    throw new Error("test database missing");
  }
  const result = await testDb.pool.query<{ id: number }>(`
    insert into page_dm_threads (
      platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id,
      partner_username, partner_display_name, conversation_flags, unread_count,
      last_message_id, last_message_at, last_message_sender_id, last_message_sender_role,
      last_message_preview, stored_message_count, newest_stored_message_id,
      oldest_stored_message_id, message_coverage_status, message_backfill_complete,
      is_visible, last_seen_generation, last_seen_at, metadata, updated_at
    ) values (
      $1, $2, $3, $4, $5, $5, 0, 0, $6, now(), $4, 'fan', 'hi', $7, $6, $8,
      'partial_window', false, true, 1, now(), '{}'::jsonb, now()
    )
    returning id
  `, [
    input.pageId,
    input.fanId,
    input.groupId,
    input.partnerPlatformUserId,
    `partner-${input.groupId}`,
    "head-1",
    input.storedMessageCount ?? 5,
    input.oldestStoredMessageId ?? null,
  ]);
  return Number(result.rows[0]!.id);
}

async function seedPageWithThreads() {
  if (!testDb) {
    throw new Error("test database missing");
  }
  const model = await createModel(appContext.db, { slug: "lora", name: "Lora" });
  const page = await createFanslyPage(appContext.db, { modelId: model!.id, label: "lora-2" });
  if (!page) {
    throw new Error("page seed failed");
  }
  const session: FanslySessionBundle = { authorization: "token" };
  await storeFanslySession(
    appContext.db,
    page.id,
    JSON.stringify(encryptJson(session, Buffer.alloc(32, 7), 1)),
    1,
  );
  // Fansly egress fails closed without a proxy (decision #124).
  await saveProxy(appContext, page.id, { url: "socks5://127.0.0.1:1080" });
  await testDb.pool.query(
    "update pages set external_page_id = $1 where id = $2",
    [PAGE_SELF_ACCOUNT_ID, page.id],
  );

  const fans = await upsertFans(appContext.db, [
    {
      platform: "fansly",
      platformUserId: `fan-${TARGET_GROUP_ID}`,
      username: "target-fan",
      displayName: "Target Fan",
    },
    {
      platform: "fansly",
      platformUserId: `fan-${DECOY_GROUP_ID}`,
      username: "decoy-fan",
      displayName: "Decoy Fan",
    },
  ]);

  const targetThreadId = await seedThread({
    pageId: page.id,
    fanId: fans[0]!.id,
    groupId: TARGET_GROUP_ID,
    partnerPlatformUserId: `fan-${TARGET_GROUP_ID}`,
    oldestStoredMessageId: "a10",
  });
  const decoyThreadId = await seedThread({
    pageId: page.id,
    fanId: fans[1]!.id,
    groupId: DECOY_GROUP_ID,
    partnerPlatformUserId: `fan-${DECOY_GROUP_ID}`,
    oldestStoredMessageId: "b10",
  });

  // Only dm_messages stays runnable, so a regular-executor lease attempt in
  // these tests can only ever mean "the dm_messages stream".
  await ensurePageSyncStates(appContext.db, { pageId: page.id });
  await testDb.pool.query(
    "update page_sync_states set status = 'paused' where page_id = $1 and stream <> 'dm_messages'",
    [page.id],
  );

  return { page, targetThreadId, decoyThreadId };
}

async function readSyncState(pageId: number) {
  if (!testDb) {
    throw new Error("test database missing");
  }
  const result = await testDb.pool.query<{
    status: string;
    requestSeq: number;
    appliedSeq: number;
    leasedSeq: number | null;
    leaseToken: string | null;
  }>(`
    select status,
           request_seq as "requestSeq",
           applied_seq as "appliedSeq",
           leased_seq as "leasedSeq",
           lease_token as "leaseToken"
    from page_sync_states
    where page_id = $1 and stream = 'dm_messages'
  `, [pageId]);
  return result.rows[0]!;
}

async function countMessages(conversationId: number) {
  const result = await testDb!.pool.query<{ n: string }>(
    "select count(*)::text as n from page_dm_messages where conversation_id = $1",
    [conversationId],
  );
  return Number(result.rows[0]!.n);
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 180_000);

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

describe("targeted thread backfill (slice C′)", () => {
  it("walks exactly the named thread, journals every page, and completes only on an EMPTY page", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, targetThreadId, decoyThreadId } = await seedPageWithThreads();
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({
        [TARGET_GROUP_ID]: [
          { ids: ["a09", "a08"], done: false },
          { ids: ["a07"], done: true },
        ],
        [DECOY_GROUP_ID]: [{ ids: ["b09"], done: true }],
      }, calls) as never,
    };

    const result = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId });

    expect(result.outcome).toBe("completed");
    expect(result).toMatchObject({
      threadId: targetThreadId,
      platformAccountId: page.id,
      requests: 3,
      insertedMessages: 3,
      providerHistoryExhausted: true,
      emptyPageReached: true,
    });

    // EXACTLY the named thread, walked backwards from its oldest stored id.
    // The short page (a07, `done`) is NOT the end (decision №3): the walk
    // reads on before it, and only that empty answer proves the history.
    expect(calls).toEqual([
      { groupId: TARGET_GROUP_ID, before: "a10", limit: 25 },
      { groupId: TARGET_GROUP_ID, before: "a08", limit: 25 },
      { groupId: TARGET_GROUP_ID, before: "a07", limit: 25 },
    ]);
    expect(await countMessages(targetThreadId)).toBe(3);
    expect(await countMessages(decoyThreadId)).toBe(0);

    // Capture first (DP 7): every vendor page is journaled raw AND as an
    // observation before anything else is derived from it.
    const raw = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from sync_raw_payloads where page_id = $1 and endpoint = 'dm_messages'",
      [page.id],
    );
    expect(Number(raw.rows[0]!.n)).toBe(3);
    const observations = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observations where account_id = $1 and kind = 'dm_messages'",
      [page.id],
    );
    expect(Number(observations.rows[0]!.n)).toBe(3);

    // The lease is released and the thread's coverage verdict is recorded.
    const state = await readSyncState(page.id);
    expect(state).toMatchObject({ leasedSeq: null, leaseToken: null });
    // Released, not completed: the stream keeps whatever the scheduler had
    // queued for it (a fresh page carries an onboarding request => pending).
    expect(state.status).not.toBe("running");
    const thread = await testDb.pool.query<{ status: string; stored: number; syncAt: Date | null }>(
      `select message_coverage_status as "status", stored_message_count as "stored",
              last_message_sync_at as "syncAt" from page_dm_threads where id = $1`,
      [targetThreadId],
    );
    // A walk from the oldest stored message never read the head, so it cannot
    // certify one: last_message_sync_at stays unset.
    expect(thread.rows[0]).toMatchObject({ status: "complete", stored: 3, syncAt: null });
  }, 120_000);

  it("reports every HTTP attempt it started as its spend, retries included", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { targetThreadId } = await seedPageWithThreads();
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({
        [TARGET_GROUP_ID]: [
          { ids: ["a09", "a08"], done: false },
          { ids: ["a07"], done: true },
        ],
      }, calls, {
        // The first page answered on its third attempt.
        retriesBefore: (callIndex) => (callIndex === 0 ? 2 : 0),
      }) as never,
    };

    const result = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId });

    expect(result.outcome).toBe("completed");
    // Three pages accepted (the last one empty), five requests sent: the
    // hydration budget is charged the five (#202 settles by actual calls).
    expect(result.requests).toBe(3);
    expect(result.requestAttempts).toBe(5);
    // ... which is exactly what the run journaled, attempt by attempt.
    const journaled = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from sync_http_attempts where sync_run_id = $1",
      [result.syncRunId],
    );
    expect(Number(journaled.rows[0]!.n)).toBe(5);
  }, 120_000);

  it("keeps a walk that left a message without createdAt unstored out of complete", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, targetThreadId } = await seedPageWithThreads();
    const scripted = messagesAdapter({ [TARGET_GROUP_ID]: [{ ids: ["a09", "a08"], done: true }] }, []);
    appContext = {
      ...appContext,
      adapter: {
        async getMessagesPage(...args: Parameters<typeof scripted.getMessagesPage>) {
          const vendorPage = await scripted.getMessagesPage(...args);
          return {
            ...vendorPage,
            items: vendorPage.items.map((item) => item.id === "a08" ? { ...item, createdAt: null } : item),
          };
        },
      } as never,
    };

    const result = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId });

    // Exhausted, yet not certified: the skipped message is a hole.
    expect(result).toMatchObject({
      outcome: "completed", providerHistoryExhausted: true, insertedMessages: 1,
      messageCoverageStatus: "partial_window",
    });
    expect(await countMessages(targetThreadId)).toBe(1);
    const thread = await testDb.pool.query<{ status: string }>(
      'select message_coverage_status as "status" from page_dm_threads where id = $1',
      [targetThreadId],
    );
    expect(thread.rows[0]).toEqual({ status: "partial_window" });
    const anomalies = await testDb.pool.query<{ details: Record<string, unknown> }>(
      "select details from sync_run_events where page_id = $1 and event_type = 'anomaly'",
      [page.id],
    );
    expect(anomalies.rows).toEqual([{ details: expect.objectContaining({
      code: "dm_message_timestamp_unparseable", count: 1, messageIds: ["a08"], valueTypes: ["null"],
    }) }]);
  }, 120_000);

  it("refuses the depth cap by default and applies the override to that run only", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { targetThreadId, decoyThreadId } = await seedPageWithThreads();
    // Both threads sit above the 200-message non-spender retention limit.
    await testDb.pool.query(
      "update page_dm_threads set stored_message_count = 250 where id = any($1::int[])",
      [[targetThreadId, decoyThreadId]],
    );
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({
        [TARGET_GROUP_ID]: [{ ids: ["a09"], done: true }],
        [DECOY_GROUP_ID]: [{ ids: ["b09"], done: true }],
      }, calls) as never,
    };

    const refused = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId });
    expect(refused.outcome).toBe("retention_limit_reached");
    expect(refused.retentionLimit).toBe(200);
    expect(calls).toHaveLength(0);

    const overridden = await runTargetedThreadBackfill(appContext, {
      threadId: targetThreadId,
      ignoreRetentionLimit: true,
    });
    expect(overridden.outcome).toBe("completed");
    expect(calls.map((call) => call.groupId)).toEqual([TARGET_GROUP_ID, TARGET_GROUP_ID]);

    // The override was a parameter of THAT run: the global config was never
    // written, and the very next run of another deep thread still refuses.
    const effective = await loadEffectiveConfig(appContext.db, appContext.config);
    expect(effective.fanslyDeepBackfillIgnoreRetentionLimit).not.toBe(true);
    const settings = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from config_settings where key = 'fanslyDeepBackfillIgnoreRetentionLimit'",
    );
    expect(Number(settings.rows[0]!.n)).toBe(0);

    const stillRefused = await runTargetedThreadBackfill(appContext, { threadId: decoyThreadId });
    expect(stillRefused.outcome).toBe("retention_limit_reached");
    expect(calls.map((call) => call.groupId)).toEqual([TARGET_GROUP_ID, TARGET_GROUP_ID]);
  }, 120_000);

  it("refuses a thread inside an open breaker window before any vendor traffic", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, targetThreadId } = await seedPageWithThreads();
    await testDb.pool.query(`
      insert into page_dm_message_sync_health (
        conversation_id, platform_account_id, failure_count, error_class,
        last_error, last_attempt_at, next_retry_at, quarantine_until
      ) values ($1, $2, 4, 'server_error', 'boom', now(), now() + interval '10 minutes',
                now() + interval '6 hours')
    `, [targetThreadId, page.id]);
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: [{ ids: ["a09"], done: true }] }, calls) as never,
    };

    const result = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId });

    expect(result.outcome).toBe("breaker_open");
    expect(calls).toHaveLength(0);
    expect(result.requestAttempts).toBe(0);
    expect(await countMessages(targetThreadId)).toBe(0);
    // No lease was taken and no sync run was opened for a refused thread.
    expect(await readSyncState(page.id)).toMatchObject({ leaseToken: null });
    expect(result.syncRunId).toBeNull();
  }, 120_000);

  it("clears a lapsed breaker row once the thread answers", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, targetThreadId } = await seedPageWithThreads();
    await testDb.pool.query(`
      insert into page_dm_message_sync_health (
        conversation_id, platform_account_id, failure_count, error_class,
        last_error, last_attempt_at, next_retry_at, quarantine_until
      ) values ($1, $2, 1, 'fansly_500', 'boom', now() - interval '10 minutes',
                now() - interval '5 minutes', null)
    `, [targetThreadId, page.id]);
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: [{ ids: ["a09"], done: true }] }, calls) as never,
    };

    const result = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId });

    expect(result.outcome).toBe("completed");
    expect(calls).toHaveLength(2);
    // Before, the row outlived the read: a thread whose history is complete
    // is not offered to the regular crawl again, and the page stayed
    // coverage_degraded on /health/sync.
    expect(await getConversationSyncHealth(testDb.db, targetThreadId)).toBeNull();
  }, 120_000);

  it("refuses after a bounded wait when the regular sync path keeps the page's dm_messages lease", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, targetThreadId } = await seedPageWithThreads();
    await testDb.pool.query(
      "update page_sync_states set request_seq = request_seq + 1, status = 'pending' where page_id = $1 and stream = 'dm_messages'",
      [page.id],
    );
    const executorLease = await acquirePageSyncLease(appContext.db, {
      pageId: page.id,
      workerId: "regular-executor",
      leaseToken: "regular-lease-token",
      leaseTtlMs: 120_000,
    });
    expect(executorLease?.stream).toBe("dm_messages");

    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: [{ ids: ["a09"], done: true }] }, calls) as never,
    };

    const result = await runTargetedThreadBackfill(
      appContext,
      { threadId: targetThreadId },
      { contentionWaitMs: 300, contentionPollMs: 100 },
    );

    expect(result.outcome).toBe("lease_unavailable");
    expect(calls).toHaveLength(0);
    expect(await countMessages(targetThreadId)).toBe(0);
    // The regular executor still owns its lease, untouched.
    expect(await readSyncState(page.id)).toMatchObject({
      status: "running",
      leaseToken: "regular-lease-token",
    });
  }, 120_000);

  it("holds the dm_messages lease while it walks and leaves a pending request unconsumed", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, targetThreadId } = await seedPageWithThreads();
    // A scheduled dm_messages request is already waiting for the executor.
    await testDb.pool.query(
      "update page_sync_states set request_seq = request_seq + 1, status = 'pending' where page_id = $1 and stream = 'dm_messages'",
      [page.id],
    );
    const before = await readSyncState(page.id);

    const calls: AdapterCall[] = [];
    const leaseProbes: Array<{ status: string; leaseToken: string | null; concurrent: string | null }> = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter(
        { [TARGET_GROUP_ID]: [{ ids: ["a09"], done: true }] },
        calls,
        {
          beforeReturn: async () => {
            const state = await readSyncState(page.id);
            // A regular executor waking up mid-run cannot take the stream.
            const concurrent = await acquirePageSyncLease(appContext.db, {
              pageId: page.id,
              workerId: "regular-executor",
              leaseToken: "regular-lease-token",
              leaseTtlMs: 120_000,
            });
            leaseProbes.push({
              status: state.status,
              leaseToken: state.leaseToken,
              concurrent: concurrent?.stream ?? null,
            });
          },
        },
      ) as never,
    };

    const result = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId });
    expect(result.outcome).toBe("completed");

    // Two vendor calls: the page, then the empty answer that proves the end.
    expect(leaseProbes).toHaveLength(2);
    expect(leaseProbes[0]!.status).toBe("running");
    expect(leaseProbes[0]!.leaseToken).not.toBeNull();
    expect(leaseProbes[0]!.leaseToken).not.toBe("regular-lease-token");
    expect(leaseProbes[0]!.concurrent).toBeNull();

    // The scheduled request survived: the targeted run never advanced
    // applied_seq, so the stream goes back to pending for the executor.
    const after = await readSyncState(page.id);
    expect(after).toMatchObject({
      status: "pending",
      requestSeq: before.requestSeq,
      appliedSeq: before.appliedSeq,
      leasedSeq: null,
      leaseToken: null,
    });
  }, 120_000);
  it("lease lost mid-walk leaves projection debt instead of a false-complete thread", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, targetThreadId } = await seedPageWithThreads();
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter(
        { [TARGET_GROUP_ID]: endlessPages("a") },
        calls,
        {
          // The first page commits; the lease is stolen inside the SECOND
          // vendor call, so the walk aborts with rows already written.
          beforeReturn: async ({ callIndex }) => {
            if (callIndex === 1) {
              await testDb!.pool.query(
                "update page_sync_states set lease_token = 'stolen-by-executor' where page_id = $1 and stream = 'dm_messages'",
                [page.id],
              );
            }
          },
        },
      ) as never,
    };

    const result = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId });

    expect(result.outcome).toBe("lease_lost");
    expect(result.projectionDebtRecorded).toBe(true);
    expect(result.requests).toBe(1);
    // The second call reached Fansly; only its page was never accepted. The
    // spend is the attempts, not the accepted pages.
    expect(result.requestAttempts).toBe(2);

    // The summary is stale (only finalize writes it) — so the debt row MUST
    // exist, otherwise the next deep backfill would ask before=<stale oldest>,
    // meet known ids and mark a half-backfilled thread `complete`.
    const debts = await listUnresolvedProjectionDebt(appContext.db, 10);
    expect(debts).toHaveLength(1);
    expect(debts[0]).toMatchObject({
      kind: PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
      platformAccountId: page.id,
      conversationId: targetThreadId,
    });

    const thread = await testDb.pool.query<{ status: string }>(
      'select message_coverage_status as "status" from page_dm_threads where id = $1',
      [targetThreadId],
    );
    expect(thread.rows[0]!.status).not.toBe("complete");
    // Facts survived the abort.
    expect(await countMessages(targetThreadId)).toBe(25);
  }, 120_000);

  it("vendor failure mid-walk leaves projection debt and no false-complete", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, targetThreadId } = await seedPageWithThreads();
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter(
        { [TARGET_GROUP_ID]: endlessPages("a") },
        calls,
        {
          beforeReturn: async ({ callIndex }) => {
            if (callIndex === 1) {
              throw new Error("fansly exploded mid-walk");
            }
          },
        },
      ) as never,
    };

    await expect(runTargetedThreadBackfill(appContext, { threadId: targetThreadId }))
      .rejects.toThrow("fansly exploded mid-walk");

    const debts = await listUnresolvedProjectionDebt(appContext.db, 10);
    expect(debts).toHaveLength(1);
    expect(debts[0]).toMatchObject({
      kind: PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
      conversationId: targetThreadId,
    });
    const thread = await testDb.pool.query<{ status: string }>(
      'select message_coverage_status as "status" from page_dm_threads where id = $1',
      [targetThreadId],
    );
    expect(thread.rows[0]!.status).not.toBe("complete");
    expect(await countMessages(targetThreadId)).toBe(25);
    // The lease was released: a failed run must not park the page.
    expect(await readSyncState(page.id)).toMatchObject({ leaseToken: null, leasedSeq: null });
  }, 120_000);

  it("stops at the request bound and reports an honest partial", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { targetThreadId } = await seedPageWithThreads();
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: endlessPages("a") }, calls) as never,
    };

    const result = await runTargetedThreadBackfill(appContext, {
      threadId: targetThreadId,
      // The depth cap would fire first otherwise; this run tests the REQUEST bound.
      ignoreRetentionLimit: true,
    });

    expect(result.outcome).toBe("partial");
    expect(calls).toHaveLength(40);
    expect(result.requests).toBe(40);
    // Not exhausted => the thread stays offered to the regular crawl.
    expect(result.messageCoverageStatus).toBe("partial_window");
  }, 180_000);

  it("re-checks the depth cap after every page in a default run", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { targetThreadId } = await seedPageWithThreads();
    // One page under the 200-message non-spender cap: the pre-walk check passes,
    // and the recheck must stop the walk after the first page.
    await testDb.pool.query(
      "update page_dm_threads set stored_message_count = 190 where id = $1",
      [targetThreadId],
    );
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: endlessPages("a") }, calls) as never,
    };

    const result = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId });

    expect(result.outcome).toBe("retention_limit_reached");
    expect(calls).toHaveLength(1);
    expect(result.insertedMessages).toBe(25);
    expect(result.messageCoverageStatus).toBe("partial_window");
  }, 120_000);

  it("refuses when a regular chunk is parked on the same thread", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, targetThreadId } = await seedPageWithThreads();
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "dm_messages",
      state: {
        ...emptyDmMessagesCursorState(),
        currentConversationId: targetThreadId,
        currentPlatformConversationId: TARGET_GROUP_ID,
        currentBeforeMessageId: "a05",
        currentMode: "deep_backfill",
      },
    });
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: [{ ids: ["a09"], done: true }] }, calls) as never,
    };

    const result = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId });

    expect(result.outcome).toBe("thread_checkpoint_in_progress");
    expect(calls).toHaveLength(0);
    // The lease taken for the check was handed back.
    expect(await readSyncState(page.id)).toMatchObject({ leaseToken: null, leasedSeq: null });
  }, 120_000);

  it("refuses after a bounded wait while another stream of the same page stays mid-chunk", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, targetThreadId } = await seedPageWithThreads();
    // Stage 25: one sync chunk per page. Simulate a live dm_conversations chunk.
    await testDb.pool.query(`
      update page_sync_states
      set status = 'running', leased_seq = request_seq, lease_owner = 'regular-executor',
          lease_token = 'conversations-lease', lease_heartbeat_at = now(),
          lease_expires_at = now() + interval '2 minutes'
      where page_id = $1 and stream = 'dm_conversations'
    `, [page.id]);
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: [{ ids: ["a09"], done: true }] }, calls) as never,
    };

    const result = await runTargetedThreadBackfill(
      appContext,
      { threadId: targetThreadId },
      { contentionWaitMs: 300, contentionPollMs: 100 },
    );

    expect(result.outcome).toBe("page_busy");
    expect(calls).toHaveLength(0);
    expect(await readSyncState(page.id)).toMatchObject({ leaseToken: null });
  }, 120_000);

  it("waits out another stream's chunk and runs instead of refusing page_busy", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, targetThreadId } = await seedPageWithThreads();
    // Prod, 28.09 20:30:12: thread 8793 was refused page_busy in 20 ms while
    // a followers_reconcile chunk held lora-1; that chunk ended 12 s later.
    await testDb.pool.query(`
      update page_sync_states
      set status = 'running', leased_seq = request_seq, lease_owner = 'regular-executor',
          lease_token = 'conversations-lease', lease_heartbeat_at = now(),
          lease_expires_at = now() + interval '2 minutes', started_at = now()
      where page_id = $1 and stream = 'dm_conversations'
    `, [page.id]);
    const chunkEnds = setTimeout(() => {
      void testDb!.pool.query(`
        update page_sync_states
        set status = 'idle', leased_seq = null, lease_owner = null, lease_token = null,
            lease_heartbeat_at = null, lease_expires_at = null, finished_at = now()
        where page_id = $1 and stream = 'dm_conversations'
      `, [page.id]);
    }, 400);
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: [{ ids: ["a09"], done: true }] }, calls) as never,
    };

    try {
      const result = await runTargetedThreadBackfill(
        appContext,
        { threadId: targetThreadId },
        { contentionWaitMs: 10_000, contentionPollMs: 100 },
      );

      expect(result).toMatchObject({ outcome: "completed", requests: 2, insertedMessages: 1 });
      // The wait itself made no request: both calls are the walk's (its page,
      // and the empty page that proves the end).
      expect(calls).toHaveLength(2);
      expect(await readSyncState(page.id)).toMatchObject({ leaseToken: null, leasedSeq: null });
    } finally {
      clearTimeout(chunkEnds);
    }
  }, 120_000);

  it("waits out the regular executor's dm_messages lease and runs instead of refusing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, targetThreadId } = await seedPageWithThreads();
    await testDb.pool.query(
      "update page_sync_states set request_seq = request_seq + 1, status = 'pending' where page_id = $1 and stream = 'dm_messages'",
      [page.id],
    );
    const executorLease = await acquirePageSyncLease(appContext.db, {
      pageId: page.id,
      workerId: "regular-executor",
      leaseToken: "regular-lease-token",
      leaseTtlMs: 120_000,
    });
    expect(executorLease?.stream).toBe("dm_messages");
    const chunkEnds = setTimeout(() => {
      void testDb!.pool.query(`
        update page_sync_states
        set status = 'pending', leased_seq = null, lease_owner = null, lease_token = null,
            lease_heartbeat_at = null, lease_expires_at = null
        where page_id = $1 and stream = 'dm_messages'
      `, [page.id]);
    }, 400);
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: [{ ids: ["a09"], done: true }] }, calls) as never,
    };

    try {
      const result = await runTargetedThreadBackfill(
        appContext,
        { threadId: targetThreadId },
        { contentionWaitMs: 10_000, contentionPollMs: 100 },
      );

      expect(result).toMatchObject({ outcome: "completed", requests: 2 });
      expect(calls).toHaveLength(2);
    } finally {
      clearTimeout(chunkEnds);
    }
  }, 120_000);

  it("refuses a paused dm_messages stream at once instead of waiting", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, targetThreadId } = await seedPageWithThreads();
    // Paused (or blocked) does not clear within minutes; waiting would only
    // hold the worker.
    await testDb.pool.query(
      "update page_sync_states set status = 'paused' where page_id = $1 and stream = 'dm_messages'",
      [page.id],
    );
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: [{ ids: ["a09"], done: true }] }, calls) as never,
    };

    const startedAt = Date.now();
    const result = await runTargetedThreadBackfill(
      appContext,
      { threadId: targetThreadId },
      { contentionWaitMs: 60_000, contentionPollMs: 100 },
    );

    expect(result.outcome).toBe("lease_unavailable");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(calls).toHaveLength(0);
  }, 120_000);

  it("refuses at once when the dm_messages retry backoff outlasts the wait", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, targetThreadId } = await seedPageWithThreads();
    // Prod, 28.09 11:01-20:31: lilly-2's dm_messages failed 22 times in a row
    // and its backoff reached the 30-minute cap. The lease cannot be taken
    // before retry_at, so waiting the budget out only holds the worker.
    await testDb.pool.query(
      `update page_sync_states
       set status = 'retrying', retry_kind = 'provider_5xx', retry_at = $2, consecutive_failures = 22
       where page_id = $1 and stream = 'dm_messages'`,
      [page.id, new Date(Date.now() + 60 * 60 * 1000)],
    );
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: [{ ids: ["a09"], done: true }] }, calls) as never,
    };

    const startedAt = Date.now();
    const result = await runTargetedThreadBackfill(
      appContext,
      { threadId: targetThreadId },
      { contentionWaitMs: 60_000, contentionPollMs: 100 },
    );

    expect(result.outcome).toBe("lease_unavailable");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(calls).toHaveLength(0);
  }, 120_000);

  it("waits out a retry backoff that ends inside the wait and runs", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, targetThreadId } = await seedPageWithThreads();
    await testDb.pool.query(
      `update page_sync_states
       set status = 'retrying', retry_kind = 'provider_5xx', retry_at = $2, consecutive_failures = 1
       where page_id = $1 and stream = 'dm_messages'`,
      [page.id, new Date(Date.now() + 400)],
    );
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: [{ ids: ["a09"], done: true }] }, calls) as never,
    };

    const result = await runTargetedThreadBackfill(
      appContext,
      { threadId: targetThreadId },
      { contentionWaitMs: 10_000, contentionPollMs: 100 },
    );

    expect(result).toMatchObject({ outcome: "completed", requests: 2 });
    expect(calls).toHaveLength(2);
  }, 120_000);

  it("keeps the worker's result as the pg-boss job output the CLI waits on", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, targetThreadId } = await seedPageWithThreads();
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: [{ ids: ["a09"], done: true }] }, []) as never,
    };
    const boss = new PgBoss({ connectionString: testDb.connectionString, schedule: false });
    await boss.start();
    try {
      await ensureTargetedThreadBackfillQueue(boss);
      // The worker's real handler, on a real pg-boss: before this fix it
      // logged the outcome and returned nothing, so pgboss.job.output stayed
      // empty for every sync.thread.backfill job in prod.
      await boss.work(
        TARGETED_THREAD_BACKFILL_QUEUE,
        { batchSize: 1, pollingIntervalSeconds: 0.5 },
        (jobs) => handleTargetedThreadBackfillJobs(appContext, jobs),
      );
      const jobId = await sendTargetedThreadBackfillJob(boss, {
        threadId: targetThreadId,
        platformAccountId: page.id,
      });
      expect(jobId).not.toBeNull();

      const states: string[] = [];
      const waited = await waitForTargetedThreadBackfillJob({
        read: () => readTargetedThreadBackfillJobStatus(appContext.db, jobId!),
        timeoutMs: 60_000,
        pollMs: 100,
        onState: (status) => states.push(status.state),
      });

      expect(waited.timedOut).toBe(false);
      expect(waited.status).toMatchObject({
        state: "completed",
        output: {
          outcome: "completed",
          threadId: targetThreadId,
          platformAccountId: page.id,
          requests: 2,
          insertedMessages: 1,
          emptyPageReached: true,
          messageCoverageStatus: "complete",
        },
      });
      expect(states.at(-1)).toBe("completed");
    } finally {
      await boss.stop({ graceful: false });
    }
  }, 120_000);
  it("skips finalization and leaves debt when another stream chunks the page mid-run", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, targetThreadId } = await seedPageWithThreads();
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter(
        { [TARGET_GROUP_ID]: [{ ids: ["a09"], done: true }] },
        calls,
        {
          // A dm_conversations chunk starts AFTER the page-busy pre-check. It
          // snapshots the thread summary and writes it back at its own end, so
          // finalizing here would be silently regressed.
          beforeReturn: async () => {
            await testDb!.pool.query(`
              update page_sync_states
              set status = 'running', leased_seq = request_seq, lease_owner = 'regular-executor',
                  lease_token = 'conversations-lease', lease_heartbeat_at = now(),
                  lease_expires_at = now() + interval '2 minutes', started_at = now()
              where page_id = $1 and stream = 'dm_conversations'
            `, [page.id]);
          },
        },
      ) as never,
    };

    const result = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId });

    expect(result.outcome).toBe("concurrent_page_chunk");
    expect(result.projectionDebtRecorded).toBe(true);
    expect(result.requests).toBe(2);

    const debts = await listUnresolvedProjectionDebt(appContext.db, 10);
    expect(debts).toHaveLength(1);
    expect(debts[0]).toMatchObject({
      kind: PROJECTION_DEBT_KIND_PAGE_DM_THREAD_SUMMARY,
      conversationId: targetThreadId,
    });

    // No verdict was written: the thread keeps its seeded summary (which the
    // sweeper recomputes), and is NOT marked complete.
    const thread = await testDb.pool.query<{ status: string; stored: number }>(
      'select message_coverage_status as "status", stored_message_count as "stored" from page_dm_threads where id = $1',
      [targetThreadId],
    );
    expect(thread.rows[0]).toMatchObject({ status: "partial_window", stored: 5 });
    // The captured facts still landed.
    expect(await countMessages(targetThreadId)).toBe(1);
    expect(await readSyncState(page.id)).toMatchObject({ leaseToken: null, leasedSeq: null });
  }, 120_000);
  it.each(["subscribers", "catalog", "media_stats"])(
    "finalizes the verdict when a %s chunk runs mid-walk: it cannot touch thread rows",
    async (stream) => {
      const { page, targetThreadId } = await seedPageWithThreads();
      appContext = {
        ...appContext,
        adapter: messagesAdapter({ [TARGET_GROUP_ID]: [{ ids: ["a09"], done: true }] }, [], {
          beforeReturn: async () => {
            await testDb!.pool.query(`
              update page_sync_states
              set status = 'running', leased_seq = request_seq, lease_owner = 'regular-executor',
                  lease_token = 'other-lease', lease_heartbeat_at = now(),
                  lease_expires_at = now() + interval '2 minutes', started_at = now()
              where page_id = $1 and stream = $2
            `, [page.id, stream]);
          },
        }) as never,
      };

      const result = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId });

      // Before, 7 of 8 prod refusals came from streams like these.
      expect(result).toMatchObject({
        outcome: "completed", providerHistoryExhausted: true, projectionDebtRecorded: false,
        messageCoverageStatus: "complete",
      });
      expect(await listUnresolvedProjectionDebt(appContext.db, 10)).toHaveLength(0);
    },
    120_000,
  );

  /** Stores a10..a14 for the target thread, so a boundary can sit inside the
   *  stored window. The seeded summary already names a10 as the oldest. */
  async function storeTargetWindow(threadId: number, pageId: number, status?: string) {
    await upsertPageDmMessages(appContext.db, ["a14", "a13", "a12", "a11", "a10"].map((id, index) => ({
      conversationId: threadId, platformAccountId: pageId, platformMessageId: id,
      senderPlatformUserId: `fan-${TARGET_GROUP_ID}`, senderRole: "fan" as const,
      createdAt: new Date(Date.UTC(2026, 0, 16, 12, 0, 0) - index * 60_000), content: id,
      totalTipAmountCents: 0, inReplyToMessageId: null, inReplyToRootMessageId: null,
    })));
    if (status) {
      await testDb!.pool.query(
        "update page_dm_threads set message_coverage_status = $2 where id = $1", [threadId, status],
      );
    }
  }

  async function coverage(threadId: number) {
    return (await testDb!.pool.query<{ status: string }>(
      'select message_coverage_status as "status" from page_dm_threads where id = $1', [threadId],
    )).rows[0]?.status;
  }

  it("certifies a thread complete when an approved boundary at the stored oldest message exhausts", async () => {
    const { page, targetThreadId } = await seedPageWithThreads();
    await storeTargetWindow(targetThreadId, page.id);
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: [{ ids: ["a09"], done: true }] }, calls) as never,
    };

    const result = await runTargetedThreadBackfill(appContext, {
      threadId: targetThreadId, startBeforeMessageRef: "a10",
    });

    expect(calls).toEqual([
      { groupId: TARGET_GROUP_ID, before: "a10", limit: 25 },
      { groupId: TARGET_GROUP_ID, before: "a09", limit: 25 },
    ]);
    expect(result).toMatchObject({
      outcome: "completed", emptyPageReached: true, messageCoverageStatus: "complete",
    });
    expect(await coverage(targetThreadId)).toBe("complete");
  }, 120_000);

  it.each(["partial_window", "complete"])(
    "keeps a %s thread's coverage when a boundary inside the stored window overlaps at once",
    async (status) => {
      const { page, targetThreadId } = await seedPageWithThreads();
      await storeTargetWindow(targetThreadId, page.id, status);
      const calls: AdapterCall[] = [];
      appContext = {
        ...appContext,
        adapter: messagesAdapter({ [TARGET_GROUP_ID]: [{ ids: ["a11", "a10"], done: false }] }, calls) as never,
      };

      const result = await runTargetedThreadBackfill(appContext, {
        threadId: targetThreadId, startBeforeMessageRef: "a12",
      });

      // Nothing below the stored oldest message was read: overlap on an
      // interior boundary is no evidence of full coverage (nor of less).
      expect(calls).toEqual([{ groupId: TARGET_GROUP_ID, before: "a12", limit: 25 }]);
      // ... and no proof for the request either: stored ground ends the walk
      // `partial`, never `completed` (the false-complete of request 76dc13d6).
      expect(result).toMatchObject({
        outcome: "partial", overlapFound: true, providerHistoryExhausted: false, emptyPageReached: false,
      });
      expect(await coverage(targetThreadId)).toBe(status);
    },
    120_000,
  );

  it("does not certify the gap above an unstored boundary that exhausts", async () => {
    const { page, targetThreadId } = await seedPageWithThreads();
    await storeTargetWindow(targetThreadId, page.id);
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: [{ ids: ["a02", "a01"], done: true }] }, []) as never,
    };

    // a09..a03 were never read: the walk starts below them.
    const result = await runTargetedThreadBackfill(appContext, {
      threadId: targetThreadId, startBeforeMessageRef: "a03",
    });

    // The end below a03 is real, but the walk did not start at the stored
    // oldest message: nothing proves the window above it, so the RUN is not
    // `completed` either — only the thread's verdict refused it before.
    expect(result).toMatchObject({
      outcome: "partial", providerHistoryExhausted: true, emptyPageReached: true,
    });
    expect(await coverage(targetThreadId)).toBe("partial_window");
  }, 120_000);
  it("reads past a SHORT page and stores the history behind it (16.09)", async () => {
    const { targetThreadId } = await seedPageWithThreads();
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({
        [TARGET_GROUP_ID]: [
          // 24 of 25 with `done`: lilly-2's heads on 16.09 had 117 and 21
          // older messages behind such a page.
          { ids: Array.from({ length: 24 }, (_, index) => `a09-${index}`), done: true },
          { ids: Array.from({ length: 25 }, (_, index) => `a08-${index}`), done: false },
        ],
      }, calls) as never,
    };

    const result = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId });

    expect(calls.map((call) => call.before)).toEqual(["a10", "a09-23", "a08-24"]);
    expect(result).toMatchObject({
      outcome: "completed", requests: 3, insertedMessages: 49, emptyPageReached: true,
      messageCoverageStatus: "complete",
    });
    expect(await countMessages(targetThreadId)).toBe(49);
  }, 120_000);

  it("records a terminal 500 on the thread's breaker and ends vendor_error instead of throwing", async () => {
    const { page, targetThreadId } = await seedPageWithThreads();
    const calls: AdapterCall[] = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: endlessPages("a") }, calls, {
        beforeReturn: async ({ callIndex }) => {
          if (callIndex === 1) {
            throw new FanslyApiError("Fansly answered 500", 500);
          }
        },
      }) as never,
    };

    const result = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId });

    // A result, not a throw: the request it answers settles with its spend.
    expect(result).toMatchObject({
      outcome: "vendor_error", requests: 1, requestAttempts: 2, projectionDebtRecorded: true,
    });
    const health = await getConversationSyncHealth(testDb!.db, targetThreadId);
    expect(health).toMatchObject({ failureCount: 1, errorClass: "fansly_500" });
    expect(health!.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
    // The breaker holds the thread now: the next run refuses before any request.
    const again = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId });
    expect(again.outcome).toBe("breaker_open");
    expect(calls).toHaveLength(2);

    expect(await readSyncState(page.id)).toMatchObject({ leaseToken: null, leasedSeq: null });
    const run = await testDb!.pool.query<{ outcome: string }>(
      "select outcome::text as outcome from sync_runs where id = $1",
      [result.syncRunId],
    );
    expect(run.rows[0]!.outcome).toBe("failed");
  }, 120_000);

  it("retries a thread with failures on record on ONE physical attempt, then walks normally", async () => {
    const { page, targetThreadId } = await seedPageWithThreads();
    await testDb!.pool.query(`
      insert into page_dm_message_sync_health (
        conversation_id, platform_account_id, failure_count, error_class,
        last_error, last_attempt_at, next_retry_at, quarantine_until
      ) values ($1, $2, 2, 'fansly_500', 'boom', now() - interval '20 minutes',
                now() - interval '1 minute', null)
    `, [targetThreadId, page.id]);
    const allowances: Array<number | null> = [];
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: [{ ids: ["a09"], done: true }] }, [], {
        onAttemptAllowance: ({ allowance }) => allowances.push(allowance),
      }) as never,
    };

    const result = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId });

    expect(result.outcome).toBe("completed");
    // A poison thread costs the run one request, not four; once it answered,
    // its breaker row is gone and the walk is ordinary work again.
    expect(allowances).toEqual([1, null]);
    expect(await getConversationSyncHealth(testDb!.db, targetThreadId)).toBeNull();
  }, 120_000);

  it("throws any other failure with the run's spend, and leaves the thread's breaker alone", async () => {
    const { page, targetThreadId } = await seedPageWithThreads();
    appContext = {
      ...appContext,
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: endlessPages("a") }, [], {
        beforeReturn: async ({ callIndex }) => {
          if (callIndex === 1) {
            // A gateway answer describes the path to Fansly, not the thread.
            throw new FanslyApiError("Bad gateway", 502);
          }
        },
      }) as never,
    };

    const failure = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId })
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(TargetedThreadBackfillRunError);
    const runError = failure as TargetedThreadBackfillRunError;
    expect(runError.message).toBe("Bad gateway");
    expect(runError.cause).toBeInstanceOf(FanslyApiError);
    expect(runError.failureClass).toBe("fansly_502");
    expect(runError.result).toMatchObject({ requests: 1, requestAttempts: 2, insertedMessages: 25 });
    expect(await getConversationSyncHealth(testDb!.db, targetThreadId)).toBeNull();
    expect(await readSyncState(page.id)).toMatchObject({ leaseToken: null, leasedSeq: null });
  }, 120_000);

  it("throws a failure before the lease with a known zero spend", async () => {
    const { targetThreadId } = await seedPageWithThreads();
    const calls: AdapterCall[] = [];
    appContext = {
      ...createTestAppContext(testDb!, { syncSharedRateLimitEnabled: false }),
      adapter: messagesAdapter({ [TARGET_GROUP_ID]: endlessPages("a") }, calls) as never,
    };

    const failure = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId })
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(TargetedThreadBackfillRunError);
    expect((failure as TargetedThreadBackfillRunError).result.requestAttempts).toBe(0);
    expect((failure as TargetedThreadBackfillRunError).failureClass).toBe("internal");
    expect(calls).toHaveLength(0);
  }, 120_000);

});
