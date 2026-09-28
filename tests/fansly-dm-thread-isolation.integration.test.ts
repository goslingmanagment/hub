import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensurePageSyncStates, finishSyncRequestAttempt, getCheckpoint, getPageDmConversationById, getPageSyncState,
  insertSyncRequestAttempt, openNotificationIncidentWithRecoveryGuard, requestPageSync, startSyncRun, upsertFans,
  upsertPageDmConversation,
} from "@agency_hub_core/db";
import { FanslyApiError, type FanslyRequestContext } from "@agency_hub_core/fansly";
import { executeObservedRequest } from "@agency_hub_core/shared";
import { resetIntegrationDatabase, seedFanslyPage, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { seedThreadInput } from "./helpers/fansly-dm-sweep.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { incidentKey } from "../apps/runtime/src/services/notification-incidents.ts";
import { executeNextSyncPageChunk } from "../apps/runtime/src/services/sync/executor.ts";

// A poison DM thread next to healthy ones, driven through the real executor:
// lease, handler, settlement and the durable wake-up. Only the Fansly calls
// are simulated, as the adapter makes them: physical attempts observed and
// journaled, in-process retries for 5xx clamped to `remainingAttempts`.

let db: StartedTestDatabase;
beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(db.pool); });

// lilly-2, conversation 132362707 (group 944674285392252928), 2026-09-28.
const poisonError = () => new FanslyApiError(
  "Fansly request failed (500): error getting group messages", 500, 500,
  "{\"success\":false,\"error\":{\"code\":500,\"details\":\"error getting group messages\"}}",
);
const DEFERRED = "fansly_dm_threads_deferred";

type ThreadSpec = {
  group: string;
  unread: number;
  /** A stored thread whose list head moved: an incremental head read is due. */
  headMismatch?: boolean;
  /** Breaker failures already recorded; the current window has lapsed. */
  failures?: number;
};

async function fixture(input: {
  threads: ThreadSpec[];
  fail: (group: string) => FanslyApiError | null;
  /** The stream's failure streak and open incident before this chunk. */
  streamFailures?: number;
}) {
  const app = createTestAppContext(db, { syncSharedRateLimitEnabled: true });
  const { page } = await seedFanslyPage(app.db, app.config.encryptionKey);
  if (!page) throw new Error("Expected a fixture page");
  await db.pool.query("update pages set external_page_id = '999' where id = $1", [page.id]);
  await saveProxy(app, page.id, { url: "http://proxy.example.test:8080", username: "test", password: "test" });
  const run = await startSyncRun(app.db, { platformAccountId: page.id, stream: "dm_messages", trigger: "scheduled" });
  if (!run) throw new Error("Expected a fixture sync run");

  const threads: Record<string, number> = {};
  for (const spec of input.threads) {
    const [fan] = await upsertFans(app.db, [{ platform: "fansly", platformUserId: `fan-${spec.group}` }]);
    if (!fan) throw new Error("Expected a fixture fan");
    const thread = await upsertPageDmConversation(app.db, {
      ...seedThreadInput(page.id, spec.group, 1), fanId: fan.id, unreadCount: spec.unread,
      ...(spec.headMismatch ? {
        lastMessageId: "960", lastMessageAt: new Date(Date.now() - 60 * 60_000),
        newestStoredMessageId: "958", oldestStoredMessageId: "900", storedMessageCount: 57,
        messageCoverageStatus: "complete" as const, lastMessageSyncAt: new Date(Date.now() - 2 * 60 * 60_000),
      } : {}),
    });
    if (!thread) throw new Error("Expected a fixture thread");
    threads[spec.group] = thread.id;
    if (spec.failures) {
      await db.pool.query(`insert into page_dm_message_sync_health (conversation_id, platform_account_id,
          failure_count, error_class, last_error, last_attempt_at, next_retry_at, quarantine_until)
        values ($1, $2, $3, 'fansly_500', 'error getting group messages',
          now() - interval '6 minutes', now() - interval '1 second',
          case when $3 >= 4 then now() - interval '1 second' end)`,
      [thread.id, page.id, spec.failures]);
    }
  }

  // Every other stream is settled; dm_messages holds one scheduled request.
  await ensurePageSyncStates(app.db, { pageId: page.id });
  await db.pool.query(`update page_sync_states set status = 'idle', applied_seq = request_seq, leased_seq = null,
    lease_token = null, lease_expires_at = null, retry_at = null, retry_kind = null,
    succeeded_at = '2026-09-27T04:58:32Z', progressed_at = '2026-09-28T20:00:00Z' where page_id = $1`, [page.id]);
  await requestPageSync(app.db, { pageId: page.id, streams: ["dm_messages"], source: "scheduled" });
  const key = incidentKey({ kind: "stream_failed_threshold", platformAccountId: page.id, stream: "dm_messages" });
  if (input.streamFailures) {
    // Waited out its 30-minute rung of the stream ladder, like prod at 21:01.
    await db.pool.query(`update page_sync_states set status = 'retrying', retry_kind = 'provider_5xx',
        retry_at = now() - interval '1 second', consecutive_failures = $2, last_error_code = 'http_500',
        last_error_summary = 'Fansly request failed (500): error getting group messages',
        failed_at = now() - interval '31 minutes'
      where page_id = $1 and stream = 'dm_messages'`, [page.id, input.streamFailures]);
    await openNotificationIncidentWithRecoveryGuard(app.db, {
      incidentKey: key, kind: "stream_failed_threshold", platformAccountId: page.id, stream: "dm_messages",
      occurredAt: new Date(Date.now() - 60 * 60_000),
    });
  }

  const attempts: Array<{ group: string; attempts: number }> = [];
  app.adapter.getMessagesPage = vi.fn(async (context: FanslyRequestContext, params) => {
    const failure = input.fail(params.groupId);
    const allowance = Math.max(0, context.remainingAttempts?.() ?? Number.MAX_SAFE_INTEGER);
    const entry = { group: params.groupId, attempts: 0 };
    attempts.push(entry);
    return executeObservedRequest({
      observer: context.requestObserver ?? null, requestId: `messages:${randomUUID()}`, operation: "messages",
      endpointTemplate: "/message", method: "GET", retries: Math.min(3, Math.max(0, allowance - 1)),
      requestMetadata: { groupId: params.groupId, limit: params.limit ?? 25, hasBefore: Boolean(params.before) },
      execute: async () => { entry.attempts += 1; },
      onTransportError: (error) => ({ kind: "failed", failureKind: "transport", error }),
      onResponse: (_response, { retriesRemaining }) => {
        if (failure) {
          const status = failure.status ?? 0;
          return retriesRemaining > 0 && status >= 500
            ? { kind: "retry", failureKind: "http", httpStatus: status, retryDelayMs: 0, errorMessage: failure.message }
            : { kind: "failed", failureKind: status >= 400 ? "http" : "provider", httpStatus: status,
              errorMessage: failure.message, error: failure };
        }
        const items = [{ id: `msg-${params.groupId}`, senderId: `fan-${params.groupId}`, content: "body",
          createdAt: Date.now() - 60_000 }];
        return { kind: "success", httpStatus: 200,
          value: { items, groupId: params.groupId, before: params.before ?? null, done: true, raw: { messages: items } } };
      },
    });
  }) as never;
  // The partner still resolves: the poison thread is not excluded.
  app.adapter.getAccountsByIdsPage = vi.fn(async (context: FanslyRequestContext, ids: string[]) =>
    executeObservedRequest({
      observer: context.requestObserver ?? null, requestId: `accounts:${randomUUID()}`, operation: "account",
      endpointTemplate: "/account", method: "GET", retries: 0,
      execute: async () => {},
      onTransportError: (error) => ({ kind: "failed", failureKind: "transport", error }),
      onResponse: () => {
        const parsed = ids.map((id) => ({ id, username: id }));
        return { kind: "success", httpStatus: 200, value: { parsed, raw: { accounts: parsed } } };
      },
    })) as never;

  const health = async (group: string) => (await db.pool.query(
    `select failure_count, next_retry_at, quarantine_until from page_dm_message_sync_health
      where conversation_id = $1`, [threads[group]],
  )).rows[0] as { failure_count: number; next_retry_at: Date; quarantine_until: Date | null } | undefined;
  const incidentStatus = async () => (await db.pool.query(
    "select status from notification_incidents where incident_key = $1", [key],
  )).rows[0]?.status as string | undefined;
  const stream = () => getPageSyncState(app.db, page.id, "dm_messages");
  const journalFailures = async (group: string, count: number) => {
    for (let index = 0; index < count; index++) {
      const at = new Date(Date.now() - (40 + index) * 60_000);
      const attempt = await insertSyncRequestAttempt(app.db, {
        syncRunId: run.id, platformAccountId: page.id, provider: "fansly", stream: "dm_messages",
        operation: "messages", logicalRequestId: `prior-${group}-${index}`, attemptNumber: 4,
        requestShape: { groupId: group }, startedAt: at,
      });
      if (!attempt) throw new Error("Expected a fixture attempt");
      await finishSyncRequestAttempt(app.db, attempt.id, {
        state: "failed", failureKind: "http", httpStatus: 500, finishedAt: at,
      });
    }
  };
  return {
    app, page, threads, attempts, health, incidentStatus, stream, journalFailures,
    execute: () => executeNextSyncPageChunk(app, page.id),
  };
}

const failOnly = (...groups: string[]) => (group: string) => groups.includes(group) ? poisonError() : null;
const near = (actual: Date | null | undefined, expectedMs: number) =>
  expect(Math.abs((actual?.getTime() ?? 0) - expectedMs)).toBeLessThan(10_000);

describe("Fansly DM thread isolation through the executor", () => {
  it("reads healthy threads in the chunk a poison thread fails, recovers the stream and wakes at the thread's window", async () => {
    // Prod lilly-2: 22 stream failures, incident open, the thread's first
    // 5-minute window lapsed while the stream slept on its 30-minute rung.
    const f = await fixture({
      threads: [
        { group: "poison", unread: 9, headMismatch: true, failures: 1 },
        { group: "healthy-a", unread: 2 },
        { group: "healthy-b", unread: 1 },
      ],
      fail: failOnly("poison"),
      streamFailures: 22,
    });
    await f.journalFailures("poison", 3);

    const result = await f.execute();

    // One physical attempt on the known-failing thread, then the rest.
    expect(f.attempts).toEqual([
      { group: "poison", attempts: 1 }, { group: "healthy-a", attempts: 1 }, { group: "healthy-b", attempts: 1 },
    ]);
    const poison = await f.health("poison");
    expect(poison).toMatchObject({ failure_count: 2, quarantine_until: null });
    near(poison?.next_retry_at, Date.now() + 10 * 60_000);
    for (const group of ["healthy-a", "healthy-b"]) {
      expect(await getPageDmConversationById(f.app.db, f.threads[group]!))
        .toMatchObject({ newestStoredMessageId: `msg-${group}`, messageCoverageStatus: "complete" });
    }
    // Accepted reads are progress: the streak and its incident clear, and the
    // stream sleeps until the thread's window instead of its own 30 minutes.
    expect(result).toMatchObject({ kind: "yielded", continuationRetryAt: poison?.next_retry_at });
    expect(await f.stream()).toMatchObject({
      status: "pending", consecutiveFailures: 0, lastErrorCode: null, retryAt: poison?.next_retry_at,
    });
    expect(await f.incidentStatus()).toBe("resolved");
    expect((await getCheckpoint(f.app.db, f.page.id, "dm_messages"))?.state)
      .toMatchObject({ currentConversationId: null });

    // Nothing runs before the window ends: no spin.
    expect(await f.execute()).toMatchObject({ kind: "idle" });
    expect(f.attempts).toHaveLength(3);
  });

  it.each([
    ["a backoff", 1, 2, 10 * 60_000, null],
    ["the fourth failure's quarantine", 3, 4, 6 * 60 * 60_000, 6 * 60 * 60_000],
  ] as const)("keeps the streak and incident of a deferral-only chunk and wakes at %s", async (
    _name, failures, failureCount, wakeInMs, quarantineInMs,
  ) => {
    const f = await fixture({
      threads: [{ group: "poison", unread: 0, headMismatch: true, failures }],
      fail: failOnly("poison"),
      streamFailures: 22,
    });
    const before = await f.stream();

    const result = await f.execute();

    expect(f.attempts).toEqual([{ group: "poison", attempts: 1 }]);
    const poison = await f.health("poison");
    expect(poison?.failure_count).toBe(failureCount);
    if (quarantineInMs === null) expect(poison?.quarantine_until).toBeNull();
    else near(poison?.quarantine_until, Date.now() + quarantineInMs);
    const wakeAt = poison?.quarantine_until ?? poison?.next_retry_at;
    near(wakeAt, Date.now() + wakeInMs);
    // Deferred, not failed and not recovered: only the wake-up moved.
    expect(result).toMatchObject({ kind: "yielded", continuationRetryAt: wakeAt });
    const after = await f.stream();
    expect(after).toMatchObject({
      status: "pending", retryAt: wakeAt, consecutiveFailures: 22, lastErrorCode: "http_500",
      lastErrorSummary: before?.lastErrorSummary, succeededAt: before?.succeededAt, progressedAt: before?.progressedAt,
    });
    expect(after?.appliedSeq).toBeLessThan(after?.requestSeq ?? 0);
    expect(await f.incidentStatus()).toBe("open");
    expect((await db.pool.query("select outcome, stats from sync_runs where id = $1", [result.runId])).rows[0])
      .toMatchObject({ outcome: "partial", stats: expect.objectContaining({ deferral: DEFERRED, deferredThreads: 1 }) });
  });

  it("retries at most one failing thread per chunk and runs the next due one in the following chunk", async () => {
    const f = await fixture({
      threads: [
        { group: "poison-a", unread: 5, failures: 1 },
        { group: "poison-b", unread: 4, failures: 1 },
        { group: "healthy", unread: 0 },
      ],
      fail: failOnly("poison-a", "poison-b"),
    });

    const first = await f.execute();

    // poison-b outranks the healthy thread, but the chunk spent its retry.
    expect(f.attempts).toEqual([{ group: "poison-a", attempts: 1 }, { group: "healthy", attempts: 1 }]);
    expect(await f.health("poison-b")).toMatchObject({ failure_count: 1 });
    expect(first).toMatchObject({ kind: "yielded", needsContinuation: true, continuationRetryAt: null });

    const second = await f.execute();

    expect(f.attempts.slice(2)).toEqual([{ group: "poison-b", attempts: 1 }]);
    expect(await f.health("poison-b")).toMatchObject({ failure_count: 2 });
    // Only windows remain now; nothing was read, so nothing recovered.
    const poisonA = await f.health("poison-a");
    expect(second).toMatchObject({ kind: "yielded", continuationRetryAt: poisonA?.next_retry_at });
    expect((await db.pool.query("select stats from sync_runs where id = $1", [second.runId])).rows[0].stats)
      .toMatchObject({ deferral: DEFERRED });
  });

  it("fails the stream when a third distinct group fails, across chunk boundaries", async () => {
    const f = await fixture({
      threads: [{ group: "a", unread: 3 }, { group: "b", unread: 2 }, { group: "c", unread: 1 }],
      fail: failOnly("a", "b", "c"),
    });

    // Two fresh failures spend the five-request chunk (four attempts each).
    const first = await f.execute();
    expect(f.attempts).toEqual([{ group: "a", attempts: 4 }, { group: "b", attempts: 4 }]);
    expect(first).toMatchObject({ kind: "yielded", needsContinuation: true, continuationRetryAt: null });
    expect(await f.health("a")).toMatchObject({ failure_count: 1 });
    expect(await f.health("b")).toMatchObject({ failure_count: 1 });
    expect(await f.stream()).toMatchObject({ status: "pending", consecutiveFailures: 0 });

    // The third group is an outage: no breaker, the stream fails and backs off.
    const second = await f.execute();
    expect(f.attempts.slice(2)).toEqual([{ group: "c", attempts: 4 }]);
    expect(second).toMatchObject({ kind: "failed" });
    expect(await f.health("c")).toBeUndefined();
    expect(await f.stream()).toMatchObject({ status: "retrying", consecutiveFailures: 1, retryKind: "provider_5xx" });
    expect((await getCheckpoint(f.app.db, f.page.id, "dm_messages"))?.state)
      .toMatchObject({ currentConversationId: f.threads.c });
  });

  it.each([
    ["a gateway 502", () => new FanslyApiError("Fansly request failed (502)", 502), 4],
    ["an envelope failure at HTTP 200", () => new FanslyApiError("Fansly response envelope was unsuccessful", 200), 1],
  ] as const)("keeps %s stream-level: no breaker, pin kept, the stream fails", async (_name, error, physical) => {
    const f = await fixture({
      threads: [{ group: "poison", unread: 5 }, { group: "healthy", unread: 0 }],
      fail: (group) => group === "poison" ? error() : null,
    });

    expect(await f.execute()).toMatchObject({ kind: "failed" });

    expect(f.attempts).toEqual([{ group: "poison", attempts: physical }]);
    expect(await f.health("poison")).toBeUndefined();
    expect((await getCheckpoint(f.app.db, f.page.id, "dm_messages"))?.state)
      .toMatchObject({ currentConversationId: f.threads.poison });
    expect(await f.stream()).toMatchObject({ status: "retrying", consecutiveFailures: 1 });
  });
});
