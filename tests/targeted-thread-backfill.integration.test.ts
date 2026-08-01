// Slice C′ — targeted thread backfill (owner CLI → pg-boss → worker).
//
// What these tests pin:
//   1. the run walks EXACTLY the named thread (a decoy thread on the same page
//      that the regular picker would prefer is never touched) and journals
//      every vendor page verbatim;
//   2. the retention-depth override is a per-run parameter — a run without it
//      refuses, and the global config is never written;
//   3. an open circuit-breaker window refuses BEFORE any vendor traffic;
//   4. the run holds the page's real dm_messages sync lease: a regular
//      executor cannot lease the stream while the targeted run walks, and a
//      lease already held by the regular path aborts the targeted run instead
//      of double-running it. A pending scheduled request survives the run.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acquirePageSyncLease,
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  storeFanslySession,
  upsertFans,
} from "@agency_hub_core/db";
import {
  encryptJson,
  type FanslySessionBundle,
  type HttpRequestEvent,
} from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { loadEffectiveConfig } from "../apps/runtime/src/services/effective-config.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { runTargetedThreadBackfill } from "../apps/runtime/src/services/sync/targeted-thread-backfill.ts";
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

function messagesAdapter(
  script: Record<string, ScriptedPage[]>,
  calls: AdapterCall[],
  hooks?: { beforeReturn?: () => Promise<void> },
) {
  const cursors = new Map<string, number>();
  return {
    async getMessagesPage(
      requestContext: {
        requestObserver?: { onRequestEvent(event: HttpRequestEvent): Promise<void> } | null;
      },
      params: { groupId: string; limit: number; before?: string | null },
    ) {
      calls.push({
        groupId: params.groupId,
        before: params.before ?? null,
        limit: params.limit,
      });
      await requestContext.requestObserver?.onRequestEvent({
        state: "started",
        requestId: `req-${calls.length}`,
        operation: "messages",
        endpointTemplate: "/message",
        method: "GET",
        attemptNumber: 1,
        timestamp: new Date(),
      });
      const index = cursors.get(params.groupId) ?? 0;
      cursors.set(params.groupId, index + 1);
      const page = script[params.groupId]?.[index] ?? { ids: [], done: true };
      await hooks?.beforeReturn?.();
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
  it("walks exactly the named thread, journals every page, and completes on exhaustion", async (context) => {
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
      requests: 2,
      insertedMessages: 3,
      providerHistoryExhausted: true,
    });

    // EXACTLY the named thread, walked backwards from its oldest stored id.
    expect(calls).toEqual([
      { groupId: TARGET_GROUP_ID, before: "a10", limit: 25 },
      { groupId: TARGET_GROUP_ID, before: "a08", limit: 25 },
    ]);
    expect(await countMessages(targetThreadId)).toBe(3);
    expect(await countMessages(decoyThreadId)).toBe(0);

    // Capture first (DP 7): both vendor pages are journaled raw AND as
    // observations before anything else is derived from them.
    const raw = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from sync_raw_payloads where page_id = $1 and endpoint = 'dm_messages'",
      [page.id],
    );
    expect(Number(raw.rows[0]!.n)).toBe(2);
    const observations = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from observations where account_id = $1 and kind = 'dm_messages'",
      [page.id],
    );
    expect(Number(observations.rows[0]!.n)).toBe(2);

    // The lease is released and the thread's coverage verdict is recorded.
    const state = await readSyncState(page.id);
    expect(state).toMatchObject({ leasedSeq: null, leaseToken: null });
    // Released, not completed: the stream keeps whatever the scheduler had
    // queued for it (a fresh page carries an onboarding request => pending).
    expect(state.status).not.toBe("running");
    const thread = await testDb.pool.query<{ status: string; stored: number }>(
      'select message_coverage_status as "status", stored_message_count as "stored" from page_dm_threads where id = $1',
      [targetThreadId],
    );
    expect(thread.rows[0]).toMatchObject({ status: "complete", stored: 3 });
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
    expect(calls.map((call) => call.groupId)).toEqual([TARGET_GROUP_ID]);

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
    expect(calls.map((call) => call.groupId)).toEqual([TARGET_GROUP_ID]);
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
    expect(await countMessages(targetThreadId)).toBe(0);
    // No lease was taken and no sync run was opened for a refused thread.
    expect(await readSyncState(page.id)).toMatchObject({ leaseToken: null });
    expect(result.syncRunId).toBeNull();
  }, 120_000);

  it("aborts when the regular sync path already holds the page's dm_messages lease", async (context) => {
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

    const result = await runTargetedThreadBackfill(appContext, { threadId: targetThreadId });

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

    expect(leaseProbes).toHaveLength(1);
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
});
