// WP-F1 — durable per-lane physical-attempt budgets and stats history guards.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import {
  getCheckpoint,
  setConfigOverride,
  upsertCaptureCoverage,
  upsertCheckpointProgress,
} from "@agency_hub_core/db";

import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import {
  backfillContinuationAt,
  emptyFanslyStatsCursorState,
  fanslyStatsSnapshotChunk,
  parseFanslyStatsCursorState,
  rollUtcDay,
  utcDayKey,
  windowsAreContiguous,
} from "../apps/runtime/src/services/sync/fansly-stats.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  fanslyLaneAppStub,
  fanslyLaneInput,
  fanslyLaneTelemetryStub as telemetryStub,
  observeFanslyLaneAttempts,
  seedFanslyLanePage,
} from "./helpers/fansly-lane-harness.ts";

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

const NOW = new Date("2026-08-19T09:00:00.000Z");

function emptyStatsBody() {
  return {
    dataset: {
      period: 86_400_000,
      dateBefore: NOW.getTime(),
      dateAfter: NOW.getTime() - 30 * 86_400_000,
      datapointLimit: 100,
      datapoints: [],
      profileDatapoints: [],
    },
    aggregationData: {},
  };
}

/**
 * An adapter stub that reports ATTEMPTS through the observer, exactly as the
 * real one does: `attemptsPerCall` above 1 is what a retried request looks like
 * to everything downstream of `executeObservedRequest`.
 */
function adapterStub(options: {
  attemptsPerCall?: number;
  broadcastFor?: (params: { before: string | null; deleted: boolean }) => unknown;
} = {}) {
  const attemptsPerCall = options.attemptsPerCall ?? 1;
  const calls: string[] = [];
  const broadcastRequests: Array<{ before: string | null; deleted: boolean }> = [];
  const answer = async (
    name: string,
    context: { requestObserver?: { onRequestEvent: (event: unknown) => Promise<void> } | null },
    body: unknown,
  ) => {
    calls.push(name);
    await observeFanslyLaneAttempts(context, {
      attempts: attemptsPerCall,
      requestId: `${name}:${calls.length}`,
      operation: name,
      endpointTemplate: `/${name}`,
    });
    return { items: body, raw: body };
  };
  return {
    calls,
    broadcastRequests,
    getAccountStats: vi.fn(async (context: never) => answer("account_stats", context, emptyStatsBody())),
    getEarningsStatsWindow: vi.fn(async (context: never) =>
      answer("earnings_stats", context, [])
    ),
    getEarningsMonthlyStats: vi.fn(async (context: never) =>
      answer("earnings_monthly", context, [])
    ),
    getTrackingLinks: vi.fn(async (context: never) => answer("tracking_links", context, [])),
    getDiscoveryMediaSuggestions: vi.fn(async (context: never) =>
      answer("discovery", context, { mediaOfferSuggestions: [] })
    ),
    getBroadcastStatsPage: vi.fn(async (
      context: never,
      params: { before: string | null; deleted: boolean },
    ) => {
      broadcastRequests.push({ before: params.before, deleted: params.deleted });
      return answer("broadcast", context, options.broadcastFor?.(params) ?? { messages: [] });
    }),
    getBroadcastScheduled: vi.fn(async (context: never) =>
      answer("broadcast_scheduled", context, { scheduledBroadcastMessages: [] })
    ),
    getPolls: vi.fn(async (context: never) => answer("polls", context, [])),
    getRecapStats: vi.fn(async (context: never) => answer("recapstats", context, [])),
  };
}

function appStub(adapter: ReturnType<typeof adapterStub>) {
  return fanslyLaneAppStub({
    database: testDb!,
    adapter,
    config: {
      fanslyStatsSnapshotSyncEnabled: true,
      fanslyStatsSnapshotPageAllowlist: "stats-budget",
      fanslyStatsSnapshotDailyCallBudget: 25,
      fanslyStatsHourlyEnabled: true,
      fanslyStatsHourlyBackfillMaxDays: 30,
      fanslyBackfillContinuationDelayMs: 20_000,
    },
  });
}

let syncRunId = 0;

async function seedPage() {
  const seeded = await seedFanslyLanePage(testDb!, {
    slug: "budget",
    name: "Budget",
    label: "stats-budget",
    accountRef: "acct-budget",
    stream: "stats_snapshot",
  });
  syncRunId = seeded.syncRunId;
  return seeded.page;
}

function input(
  pageId: number,
  telemetry: ReturnType<typeof telemetryStub>,
  budget = new SyncChunkBudget(),
  now = NOW,
  metadata: Record<string, unknown> = {},
) {
  const laneInput = fanslyLaneInput({
    pageId,
    label: "stats-budget",
    accountRef: "acct-budget",
    egressKey: "fansly:budget",
    telemetry,
    syncRunId,
    now,
    budget,
  });
  laneInput.pageContext.page.metadata = metadata;
  return laneInput as never;
}

async function cursor(pageId: number) {
  const checkpoint = await getCheckpoint(testDb!.db, pageId, "stats_snapshot");
  return parseFanslyStatsCursorState(checkpoint?.state, NOW);
}

async function journaledKinds(pageId: number): Promise<string[]> {
  const result = await testDb!.pool.query(
    `select kind from observations where account_id = $1 order by id`,
    [pageId],
  );
  return (result.rows as Array<{ kind: string }>).map((row) => row.kind);
}

describe("[sync-critical] WP-F1 per-lane daily call budget", () => {
  it("keeps snapshot bounds separate instead of claiming coverage across a capture gap", async (context) => {
    if (!testDb) { context.skip(); return; }
    const page = await seedPage();
    const common = { pageId: page.id, platform: "fansly" as const, plane: "stats_earnings",
      status: "window_captured" as const, acquisitionMode: "retroactive" as const,
      proof: "none" as const };
    await upsertCaptureCoverage(testDb.db, { ...common, scopeRef: "",
      oldestCapturedAt: new Date("2025-01-01Z"), newestCapturedAt: NOW });
    await upsertCaptureCoverage(testDb.db, { ...common, scopeRef: "steady", replaceWindowBounds: true,
      oldestCapturedAt: new Date("2026-07-01Z"), newestCapturedAt: new Date("2026-08-01Z") });
    await upsertCaptureCoverage(testDb.db, { ...common, scopeRef: "steady", replaceWindowBounds: true,
      oldestCapturedAt: new Date("2026-09-01Z"), newestCapturedAt: new Date("2026-10-01Z") });
    const { rows } = await testDb.pool.query(
      "select scope_ref, oldest_captured_at from capture_coverage where page_id=$1 order by scope_ref", [page.id]);
    expect(rows.map((row) => [row.scope_ref, new Date(row.oldest_captured_at).toISOString()]))
      .toEqual([["", "2025-01-01T00:00:00.000Z"], ["steady", "2026-09-01T00:00:00.000Z"]]);
  });

  it("journals a malformed stats envelope but withholds coverage and cursor progress", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const adapter = adapterStub();
    adapter.getAccountStats.mockImplementation(async (requestContext: {
      requestObserver?: { onRequestEvent: (event: unknown) => Promise<void> } | null;
    }) => {
      await requestContext.requestObserver?.onRequestEvent({
        requestId: "account_stats:malformed:1",
        state: "started",
        operation: "account_stats",
        endpointTemplate: "/it/amoie/stats",
        method: "GET",
        attemptNumber: 1,
      });
      const malformed = { aggregationData: {}, redactedFixture: "missing dataset" };
      return { items: malformed, raw: malformed };
    });
    const telemetry = telemetryStub();

    await expect(fanslyStatsSnapshotChunk(
      appStub(adapter),
      input(page.id, telemetry),
    )).rejects.toMatchObject({
      name: "FanslyLaneInvalidResponseError",
      observationKind: "account_stats",
    });

    expect(await journaledKinds(page.id)).toEqual(["account_stats"]);
    expect(await coverageRow(page.id, "stats_account_daily")).toBeNull();
    const checkpoint = await cursor(page.id);
    expect(checkpoint?.callsToday).toBe(1);
    expect(checkpoint?.backfill?.daily.trailingCaptured).toBe(false);
  });

  it("counts ATTEMPTS, not logical calls, and persists the count on the cursor", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const adapter = adapterStub({ attemptsPerCall: 3 });
    const telemetry = telemetryStub();
    // One chunk, five requests: the chunk budget stops it long before the day
    // cap does. What matters is the NUMBER it recorded.
    await fanslyStatsSnapshotChunk(appStub(adapter), input(page.id, telemetry));

    const state = await cursor(page.id);
    expect(state).not.toBeNull();
    // A cap counted in logical calls would read 5 here and let a retry storm
    // multiply real egress by up to the adapter's retry limit.
    expect(state!.callsToday).toBe(adapter.calls.length * 3);
    expect(state!.utcDay).toBe("2026-08-19");
  });

  it("defers at its own number, and still journals the response already fetched", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // A deliberately small cap, so the lane hits it with work still to do —
    // which is the only state in which "defers, never drops" means anything.
    await setConfigOverride(testDb.db, {
      key: "fanslyStatsSnapshotDailyCallBudget",
      value: 5,
      userId: null,
      groupId: randomUUID(),
    });
    const adapter = adapterStub();
    const telemetry = telemetryStub();

    // Each chunk is a fresh SyncChunkBudget — what a real re-dispatch looks
    // like. The DAY counter has to survive that, or it is not a day counter.
    let result: Awaited<ReturnType<typeof fanslyStatsSnapshotChunk>> | null = null;
    for (let chunk = 0; chunk < 5; chunk += 1) {
      result = await fanslyStatsSnapshotChunk(
        appStub(adapter),
        input(page.id, telemetry, new SyncChunkBudget()),
      );
      if (result.stats?.deferred === "daily_call_budget") {
        break;
      }
    }

    const state = await cursor(page.id);
    // AT the number, never past it: the check runs BEFORE the call, so the lane
    // cannot overshoot its own cap by a request.
    expect(state!.callsToday).toBe(5);
    expect(result?.stats?.deferred).toBe("daily_call_budget");
    // Deferral is "come back after the UTC roll", not a failure.
    expect(result?.satisfied).toBe(false);
    expect(result?.continuationRetryAt?.toISOString()).toBe("2026-08-20T00:05:00.000Z");
    // …and there is still work left, which is what makes the deferral real:
    // either a backfill lane is mid-walk or today's sweep has not completed.
    expect(state!.mode === "backfill" || state!.lastSweepDay !== "2026-08-19").toBe(true);

    // NEVER DROPS: every attempt spent produced a journaled body, and the lane
    // stopped only once the last one was safe.
    expect(await journaledKinds(page.id)).toHaveLength(5);
    expect(adapter.calls).toHaveLength(5);
  });

  it("resets the counter on the UTC roll and resumes at the same step", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await setConfigOverride(testDb.db, {
      key: "fanslyStatsSnapshotDailyCallBudget",
      value: 5,
      userId: null,
      groupId: randomUUID(),
    });
    const adapter = adapterStub();
    const telemetry = telemetryStub();
    for (let chunk = 0; chunk < 5; chunk += 1) {
      const result = await fanslyStatsSnapshotChunk(
        appStub(adapter),
        input(page.id, telemetry, new SyncChunkBudget()),
      );
      if (result.stats?.deferred === "daily_call_budget") break;
    }
    const deferredState = await cursor(page.id);
    expect(deferredState!.callsToday).toBe(5);
    const stepAtDefer = deferredState!.stepIndex;
    const modeAtDefer = deferredState!.mode;
    const backfillAtDefer = JSON.stringify(deferredState!.backfill);

    // The roll is a pure function of the cursor and the clock: nothing but the
    // counter moves, so a sweep that deferred mid-step resumes at that step
    // with its backfill position intact.
    const rolled = rollUtcDay(deferredState!, new Date("2026-08-20T00:06:00.000Z"));
    expect(rolled.callsToday).toBe(0);
    expect(rolled.utcDay).toBe("2026-08-20");
    expect(rolled.stepIndex).toBe(stepAtDefer);
    expect(rolled.mode).toBe(modeAtDefer);
    expect(JSON.stringify(rolled.backfill)).toBe(backfillAtDefer);
    expect(utcDayKey(new Date("2026-08-20T23:59:59.999Z"))).toBe("2026-08-20");

    // And the next day's chunk actually spends egress again.
    const tomorrow = new Date("2026-08-20T00:06:00.000Z");
    const before = adapter.calls.length;
    await fanslyStatsSnapshotChunk(
      appStub(adapter),
      input(page.id, telemetry, new SyncChunkBudget(), tomorrow),
    );
    expect(adapter.calls.length).toBeGreaterThan(before);
  });

  it("finishes yesterday's tail without marking today's head as captured", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const yesterday = new Date("2026-08-19T23:55:00.000Z");
    const today = new Date("2026-08-20T00:06:00.000Z");
    const seeded = emptyFanslyStatsCursorState(yesterday);
    seeded.mode = "steady";
    seeded.backfill = null;
    seeded.lastSweepDay = "2026-08-18";
    seeded.sweepDay = "2026-08-19";
    seeded.stepIndex = 10;
    seeded.callsToday = 25;
    seeded.lastHourlyCapturedAt = yesterday.toISOString();
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: seeded.lastSweepDay,
      state: seeded as unknown as Record<string, unknown>,
    });

    const adapter = adapterStub();
    const telemetry = telemetryStub();
    await fanslyStatsSnapshotChunk(
      appStub(adapter),
      input(page.id, telemetry, new SyncChunkBudget(), today),
    );

    // The old behavior returned immediately after recap and stamped 2026-08-20
    // complete even though step 0 had last run on 2026-08-19. The same chunk now
    // closes that tail under its own day, then starts today's head.
    expect(adapter.calls.slice(0, 2)).toEqual(["recapstats", "account_stats"]);
    expect(await journaledKinds(page.id)).toContain("account_stats");
    const resumed = await cursor(page.id);
    expect(resumed!.lastSweepDay).toBe("2026-08-19");
    expect(resumed!.sweepDay).toBe("2026-08-20");
    expect(resumed!.stepIndex).toBeGreaterThan(0);
  });

  it("skips before ANY egress when the gate is closed", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const adapter = adapterStub();
    const telemetry = telemetryStub();

    // FAIL-CLOSED: an empty allowlist is NO pages, never all of them.
    const closed = appStub(adapter) as unknown as {
      config: Record<string, unknown>;
    };
    closed.config.fanslyStatsSnapshotPageAllowlist = "";
    const notAllowlisted = await fanslyStatsSnapshotChunk(
      closed as never,
      input(page.id, telemetry),
    );
    expect(notAllowlisted.gatedSkip).toBe("not_allowlisted");

    closed.config.fanslyStatsSnapshotPageAllowlist = "stats-budget";
    closed.config.fanslyStatsSnapshotSyncEnabled = false;
    const flagOff = await fanslyStatsSnapshotChunk(closed as never, input(page.id, telemetry));
    expect(flagOff.gatedSkip).toBe("flag_off");

    expect(adapter.calls).toHaveLength(0);
    expect(await journaledKinds(page.id)).toHaveLength(0);
  });

  it("honours a LIVE budget change without a restart", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // The key is runtimeApply: "live", so the effective-config overlay is what
    // the chunk reads — a flip must not need a deploy.
    await setConfigOverride(testDb.db, {
      key: "fanslyStatsSnapshotDailyCallBudget",
      value: 2,
      userId: null,
      groupId: randomUUID(),
    });
    const adapter = adapterStub();
    const telemetry = telemetryStub();
    await fanslyStatsSnapshotChunk(appStub(adapter), input(page.id, telemetry));
    const state = await cursor(page.id);
    expect(state!.callsToday).toBe(2);
    expect(adapter.calls).toHaveLength(2);
  });

  it("spreads backfill continuations with delay AND jitter", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Burst shape, not daily volume, is the real ban-risk surface: a chunk
    // spends 5 requests in ~13 s and is re-queued immediately, so an unspaced
    // deep walk runs contiguously at ~23 req/min for as long as it has work.
    const base = new Date("2026-08-19T09:00:00.000Z");
    expect(backfillContinuationAt(base, 20_000, () => 0.5).getTime() - base.getTime()).toBe(20_000);
    expect(backfillContinuationAt(base, 20_000, () => 0).getTime() - base.getTime()).toBe(14_000);
    expect(backfillContinuationAt(base, 20_000, () => 1).getTime() - base.getTime()).toBe(26_000);
    // Steady-state lanes keep immediate continuation; only the backfill waits.
    expect(backfillContinuationAt(base, 0, () => 0.5).getTime()).toBe(base.getTime());
  });

  it("asserts window contiguity on two adjacent served windows", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // §7: the next window is derived from the RETURNED bounds, so adjacent
    // windows must overlap rather than leave a hole. On live data a violation
    // logs an anomaly and never discards a journaled response; the assertion
    // itself is checked here, on fixtures.
    const newer = { afterMs: Date.UTC(2026, 4, 1), beforeMs: Date.UTC(2026, 7, 9) };
    const older = { afterMs: Date.UTC(2026, 1, 1), beforeMs: Date.UTC(2026, 4, 2) };
    expect(windowsAreContiguous(older, newer)).toBe(true);
    const gapped = { afterMs: Date.UTC(2026, 1, 1), beforeMs: Date.UTC(2026, 3, 1) };
    expect(windowsAreContiguous(gapped, newer)).toBe(false);
    // Nothing served contradicts nothing.
    expect(windowsAreContiguous({ afterMs: null, beforeMs: null }, newer)).toBe(true);
  });

  // ── THE UNHONOURED-WINDOW GUARD ──────────────────────────────────────────
  //
  // PROD 2026-08-22 04:16–04:20 UTC, first enable, page ari-1 (lilly-1 the
  // same): the walk asked `/it/amoie/stats` for 100 days, the provider answered
  // with its own DEFAULT trailing 31, the walk derived its next window from THAT
  // — and then re-issued the identical request 23 more times until the daily cap
  // stopped it. Twenty-five 200s, twenty-five byte-identical bodies, one dedup
  // object id, a day of a page's egress spent learning nothing.
  //
  // Two of the three tests below are that sequence, held down so it cannot come
  // back; the third is the walk that still has to work when the provider does
  // honour its bounds.

  const DAY = 86_400_000;

  /** A window the provider describes, with as many datapoints as asked for. */
  function statsBodyFor(
    window: { afterMs: number; beforeMs: number },
    datapoints: number,
  ) {
    return {
      dataset: {
        period: 86_400_000,
        dateBefore: window.beforeMs,
        dateAfter: window.afterMs,
        datapointLimit: 100,
        datapoints: Array.from({ length: datapoints }, (_unused, index) => ({
          timestamp: window.afterMs + index * DAY,
          views: index,
        })),
        profileDatapoints: [],
      },
      aggregationData: {},
    };
  }

  /**
   * A stub that answers however the test says AND remembers what it was asked.
   * The defect is only visible in the SEQUENCE of requests, so the requests are
   * the thing under test — a stub that only counted calls would have watched the
   * production loop happen and reported five healthy chunks.
   */
  function windowAdapterStub(options: {
    statsFor: (
      params: { beforeDate: Date; afterDate: Date; periodMs: number; year?: number; month?: number },
    ) => unknown;
    earningsFor?: (params: { before: Date; after: Date; limit?: number | null; offset?: number | null }) => unknown;
    /** Attempts a call needs, retries included — each capped by the request's
     *  retry allowance the way the real adapter caps it. Unset: one attempt,
     *  allowance unread. */
    attemptsFor?: (name: string) => number;
  }) {
    const calls: string[] = [];
    const statsRequests: Array<
      { afterMs: number; beforeMs: number; periodMs: number; year: number; month: number }
    > = [];
    const earningsRequests: Array<{ afterMs: number; beforeMs: number; offset: number | null | undefined }> = [];
    const answer = async (
      name: string,
      context: {
        requestObserver?: { onRequestEvent: (event: unknown) => Promise<void> } | null;
        remainingAttempts?: (() => number) | null;
      },
      body: unknown,
    ) => {
      calls.push(name);
      if (options.attemptsFor !== undefined) {
        await observeFanslyLaneAttempts(context, {
          attempts: options.attemptsFor(name),
          requestId: `${name}:${calls.length}`,
          operation: name,
          endpointTemplate: `/${name}`,
        });
        return { items: body, raw: body };
      }
      await context.requestObserver?.onRequestEvent({
        requestId: `${name}:${calls.length}`,
        state: "started",
        operation: name,
        endpointTemplate: `/${name}`,
        method: "GET",
        attemptNumber: 1,
      });
      return { items: body, raw: body };
    };
    return {
      calls,
      statsRequests,
      earningsRequests,
      getAccountStats: vi.fn(async (
        context: never,
        params: {
          beforeDate: Date;
          afterDate: Date;
          periodMs: number;
          year?: number;
          month?: number;
        },
      ) => {
        statsRequests.push({
          afterMs: params.afterDate.getTime(),
          beforeMs: params.beforeDate.getTime(),
          periodMs: params.periodMs,
          // The MONTH is what selects the window on this route; 0/0 means "read
          // the bounds", which only works inside the trailing window.
          year: params.year ?? 0,
          month: params.month ?? 0,
        });
        return answer("account_stats", context, options.statsFor(params));
      }),
      getEarningsStatsWindow: vi.fn(async (
        context: never,
        params: { before: Date; after: Date; limit?: number | null; offset?: number | null },
      ) => {
        earningsRequests.push({
          afterMs: params.after.getTime(),
          beforeMs: params.before.getTime(),
          offset: params.offset,
        });
        return answer("earnings_stats", context, options.earningsFor?.(params) ?? []);
      }),
      getEarningsMonthlyStats: vi.fn(async (context: never) =>
        answer("earnings_monthly", context, [])
      ),
      getTrackingLinks: vi.fn(async (context: never) => answer("tracking_links", context, [])),
      getDiscoveryMediaSuggestions: vi.fn(async (context: never) =>
        answer("discovery", context, { mediaOfferSuggestions: [] })
      ),
      getBroadcastStatsPage: vi.fn(async (context: never) =>
        answer("broadcast", context, { messages: [] })
      ),
      getBroadcastScheduled: vi.fn(async (context: never) =>
        answer("broadcast_scheduled", context, { scheduledBroadcastMessages: [] })
      ),
      getPolls: vi.fn(async (context: never) => answer("polls", context, [])),
      getRecapStats: vi.fn(async (context: never) => answer("recapstats", context, [])),
    };
  }

  /** The app stub with the hourly lane closed, so a test about the daily and
   *  earnings walks is not also a test about eight hourly steps. */
  function dailyOnlyAppStub(adapter: ReturnType<typeof windowAdapterStub>) {
    const app = appStub(adapter as never);
    (app as unknown as { config: Record<string, unknown> }).config
      .fanslyStatsHourlyEnabled = false;
    return app;
  }

  async function coverageRow(pageId: number, plane: string, scopeRef = "") {
    const result = await testDb!.pool.query(
      `select status, proof, proof_observation_id, reason_code, acquisition_mode, cursor
         from capture_coverage where page_id = $1 and plane = $2 and scope_ref = $3`,
      [pageId, plane, scopeRef],
    );
    return (result.rows[0] ?? null) as
      | {
        status: string;
        proof: string;
        proof_observation_id: string | number | null;
        reason_code: string | null;
        acquisition_mode: string;
        cursor: Record<string, unknown>;
      }
      | null;
  }

  /** History-only scenarios begin after today's head — the hourly window
   *  included — has completed. */
  async function seedHistoryPage() {
    const page = await seedPage();
    const state = emptyFanslyStatsCursorState(NOW);
    state.lastSweepDay = utcDayKey(NOW);
    state.lastHourlyCapturedAt = NOW.toISOString();
    await upsertCheckpointProgress(testDb!.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: state.lastSweepDay,
      state: state as unknown as Record<string, unknown>,
    });
    return page;
  }

  /** Every one of these tests pins a REQUEST SEQUENCE, so the day cap is set to
   *  exactly the number of requests the lanes under test are allowed to spend:
   *  the lane then defers instead of rolling on into the steady sweep, and what
   *  the stub recorded is the sequence and nothing else. */
  async function capDayAt(calls: number) {
    await setConfigOverride(testDb!.db, {
      key: "fanslyStatsSnapshotDailyCallBudget",
      value: calls,
      userId: null,
      groupId: randomUUID(),
    });
  }

  /** Drives chunks the way the executor does — a fresh chunk budget each time —
   *  until `stop` says the state under test has been reached. */
  async function driveChunks(
    app: unknown,
    pageId: number,
    telemetry: ReturnType<typeof telemetryStub>,
    stop: (state: NonNullable<Awaited<ReturnType<typeof cursor>>>) => boolean,
    maxChunks = 8,
    metadata: Record<string, unknown> = {},
  ) {
    for (let chunk = 0; chunk < maxChunks; chunk += 1) {
      await fanslyStatsSnapshotChunk(
        app as never,
        input(pageId, telemetry, new SyncChunkBudget(), NOW, metadata),
      );
      const state = await cursor(pageId);
      if (state !== null && stop(state)) {
        return state;
      }
    }
    return await cursor(pageId);
  }

  /** The month index the walk asks for FIRST: the month before the trailing
   *  window, which the trailing window only partly covers. */
  const JULY_2026 = 2026 * 12 + 6;

  /** A body for a NAMED MONTH — served bounds are the month's own, which is
   *  what "the month form was honoured" looks like on the wire. */
  function monthBodyFor(year: number, month: number, datapoints: number) {
    return statsBodyFor(
      { afterMs: Date.UTC(year, month - 1, 1), beforeMs: Date.UTC(year, month, 1) },
      datapoints,
    );
  }

  /** A month the account had no traffic in: the rows exist and every counter in
   *  them is zero, which is what the floor rule has to read as empty. */
  function allZeroMonthBody(year: number, month: number) {
    return {
      dataset: {
        period: 86_400_000,
        dateBefore: Date.UTC(year, month, 1),
        dateAfter: Date.UTC(year, month - 1, 1),
        datapointLimit: 100,
        datapoints: [{ timestamp: Date.UTC(year, month - 1, 1), views: 0, uniqueViewers: 0 }],
        profileDatapoints: [{
          timestamp: Date.UTC(year, month - 1, 1),
          stats: [{ type: 10001, views: 0, interactionTime: 0, uniqueViewers: 0 }],
        }],
      },
      aggregationData: {},
    };
  }

  it("stops the MONTH walk when the provider answers the trailing window instead", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedHistoryPage();
    // THE PRODUCTION PROVIDER (lora-2, 2026-08-22): whatever you ask for —
    // historical bounds, a halved span, or a named month — you get the default
    // trailing 31 days, 200 OK, with data in it.
    const defaultTrailing = { afterMs: NOW.getTime() - 31 * DAY, beforeMs: NOW.getTime() };
    const adapter = windowAdapterStub({ statsFor: () => statsBodyFor(defaultTrailing, 28) });
    const telemetry = telemetryStub();
    // Three: the trailing window, and the two months it takes to see that the
    // month form is not being honoured either.
    await capDayAt(3);

    const state = await driveChunks(
      dailyOnlyAppStub(adapter),
      page.id,
      telemetry,
      (current) => current.backfill !== null && current.backfill.daily.done,
    );

    const daily = adapter.statsRequests.filter((request) => request.periodMs === 86_400_000);
    expect(daily).toHaveLength(3);
    // 1 — the TRAILING window, by date bounds, with year/month at 0: the one
    // window this route honours bounds for, because it serves it by default.
    expect(daily[0]).toMatchObject({
      afterMs: NOW.getTime() - 31 * DAY,
      beforeMs: NOW.getTime(),
      year: 0,
      month: 0,
    });
    // 2 and 3 — the MONTH form, newest month first, with the app's own trailing
    // bounds riding along ignored.
    expect(daily.slice(1).map((request) => [request.year, request.month])).toEqual([
      [2026, 7],
      [2026, 6],
    ]);
    for (const request of daily.slice(1)) {
      expect(request.beforeMs).toBe(NOW.getTime());
      expect(request.afterMs).toBe(NOW.getTime() - 30 * DAY);
    }
    // NEVER THE SAME MONTH TWICE, which is the loop stated as an invariant.
    // (July passes the honoured check because the trailing window really does
    // start inside July; June is where a server ignoring year/month is caught,
    // and that costs exactly one extra request.)
    expect(new Set(daily.slice(1).map((request) => `${request.year}-${request.month}`)).size)
      .toBe(2);

    expect(state!.backfill!.daily.done).toBe(true);
    expect(state!.backfill!.daily.trailingCaptured).toBe(true);

    // The claim is written down, with the response that proves it, and it says
    // MONTH FORM — not the superseded `window_not_honoured`, which was about a
    // walk that no longer exists.
    const row = await coverageRow(page.id, "stats_account_daily");
    expect(row?.status).toBe("partial_provider_surface");
    expect(row?.proof).toBe("terminal_response");
    expect(row?.reason_code).toBe("month_form_not_honoured");
    expect(row?.acquisition_mode).toBe("retroactive");
    expect(row?.proof_observation_id).not.toBeNull();
    expect(row?.cursor.requestedYear).toBe(2026);
    expect(row?.cursor.requestedMonth).toBe(6);

    // ONE anomaly for the plane — a loop that shouted once per iteration would
    // be its own kind of incident.
    const raised = telemetry.anomalies.filter(
      (anomaly) => anomaly.code === "fansly_stats_month_form_not_honoured",
    );
    expect(raised).toHaveLength(1);
    expect((raised[0]!.details as { trigger?: string }).trigger).toBe("served_window");
    // Every response is journaled, refusals included: the body that ignored our
    // month IS the evidence for the coverage row above.
    expect(await journaledKinds(page.id)).toHaveLength(3);
  });

  it("walks backwards by CALENDAR MONTH to the floor when months are honoured", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedHistoryPage();
    // A provider that answers the month it was named, has traffic through May
    // 2026, and serves all-zero rows for everything older. The all-zero months
    // are the case that matters: a walk that read a zero-valued bucket as data
    // would never find a floor at all (WP-F4 found that out on production).
    const adapter = windowAdapterStub({
      statsFor: (params) => {
        if ((params.year ?? 0) === 0) {
          return statsBodyFor(
            { afterMs: params.afterDate.getTime(), beforeMs: params.beforeDate.getTime() },
            28,
          );
        }
        const index = params.year! * 12 + (params.month! - 1);
        return index >= 2026 * 12 + 4
          ? monthBodyFor(params.year!, params.month!, 30)
          : allZeroMonthBody(params.year!, params.month!);
      },
    });
    const telemetry = telemetryStub();
    // The trailing window, three months of traffic, two empty months, and ONE
    // [E10] probe a year further back: seven requests to reach a floor.
    await capDayAt(7);

    const state = await driveChunks(
      dailyOnlyAppStub(adapter),
      page.id,
      telemetry,
      (current) => current.backfill !== null && current.backfill.daily.done,
    );

    const months = adapter.statsRequests
      .filter((request) => request.year !== 0)
      .map((request) => `${request.year}-${String(request.month).padStart(2, "0")}`);
    // NEWEST MONTH FIRST, one call per month, no gaps and no repeats — then the
    // probe, a year past the two empty months.
    expect(months).toEqual([
      "2026-07",
      "2026-06",
      "2026-05",
      "2026-04",
      "2026-03",
      "2025-03",
    ]);
    expect(new Set(months).size).toBe(months.length);

    // It reached the floor the way the design says: two empty months, then ONE
    // probe a year further back ([E10]), then a floor claim — not a refusal.
    expect(state!.backfill!.daily.done).toBe(true);
    expect(state!.backfill!.daily.probeSpent).toBe(true);
    // The floor is what the PROVIDER described — the oldest served `dateAfter`,
    // which is May 2026's own start, not the empty months after it.
    expect(state!.backfill!.daily.floorAt).toBe(new Date(Date.UTC(2026, 4, 1)).toISOString());

    const row = await coverageRow(page.id, "stats_account_daily");
    expect(row?.status).toBe("provider_exhausted");
    expect(row?.proof).toBe("empty_window");
    expect(row?.reason_code).toBe("empty_window_streak");
    expect(telemetry.anomalies.filter(
      (anomaly) => anomaly.code === "fansly_stats_month_form_not_honoured",
    )).toHaveLength(0);
    // Every empty month is journaled: the empty month IS the floor evidence.
    expect(await journaledKinds(page.id)).toHaveLength(7);
  });

  it("stops before a month earlier than the account creation month without egress", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedHistoryPage();
    const seeded = emptyFanslyStatsCursorState(NOW);
    seeded.lastSweepDay = utcDayKey(NOW);
    seeded.backfill!.daily.trailingCaptured = true;
    seeded.backfill!.daily.nextMonthIndex = 2024 * 12 + 11;
    seeded.backfill!.daily.emptyStreak = 2;
    seeded.backfill!.daily.probeSpent = true;
    seeded.backfill!.daily.probeResumeMonthIndex = 2025 * 12;
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: null,
      state: seeded as unknown as Record<string, unknown>,
    });

    const adapter = windowAdapterStub({
      statsFor: () => ({ aggregationData: {}, redactedFixture: "must not be requested" }),
    });
    const telemetry = telemetryStub();
    await capDayAt(1);

    await fanslyStatsSnapshotChunk(
      dailyOnlyAppStub(adapter),
      input(
        page.id,
        telemetry,
        new SyncChunkBudget(),
        NOW,
        { accountCreatedAt: "2025-02-06T12:00:00.000Z" },
      ),
    );

    expect(adapter.statsRequests.filter((request) => request.year !== 0)).toHaveLength(0);
    const state = await cursor(page.id);
    expect(state!.backfill!.daily.done).toBe(true);
    const row = await coverageRow(page.id, "stats_account_daily");
    expect(row?.status).toBe("provider_exhausted");
    expect(row?.proof).toBe("none");
    expect(row?.reason_code).toBe("account_creation_floor");
    expect(row?.cursor.requestedMonth).toBe("2024-12");
    expect(row?.cursor.accountCreatedAt).toBe("2025-02-06T12:00:00.000Z");
  });

  it("stops a probe on an invalid response instead of retrying it every day", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedHistoryPage();
    const seeded = emptyFanslyStatsCursorState(NOW);
    seeded.lastSweepDay = utcDayKey(NOW);
    seeded.backfill!.daily.trailingCaptured = true;
    seeded.backfill!.daily.nextMonthIndex = 2024 * 12 + 11;
    seeded.backfill!.daily.emptyStreak = 2;
    seeded.backfill!.daily.probeSpent = true;
    seeded.backfill!.daily.probeResumeMonthIndex = 2025 * 12;
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: null,
      state: seeded as unknown as Record<string, unknown>,
    });

    const adapter = windowAdapterStub({
      statsFor: (params) => (params.year ?? 0) === 0
        ? emptyStatsBody()
        : { aggregationData: {}, redactedFixture: "missing dataset" },
    });
    const telemetry = telemetryStub();
    await capDayAt(1);

    await expect(fanslyStatsSnapshotChunk(
      dailyOnlyAppStub(adapter),
      input(page.id, telemetry),
    )).resolves.toBeDefined();

    expect(adapter.statsRequests.filter((request) => request.year !== 0)).toHaveLength(1);
    expect((await cursor(page.id))!.backfill!.daily.done).toBe(true);
    const row = await coverageRow(page.id, "stats_account_daily");
    expect(row?.status).toBe("partial_provider_surface");
    expect(row?.proof).toBe("terminal_response");
    expect(row?.proof_observation_id).not.toBeNull();
    expect(row?.reason_code).toBe("probe_response_invalid");
    expect(telemetry.anomalies.filter(
      (anomaly) => anomaly.code === "fansly_stats_probe_response_invalid",
    )).toHaveLength(1);

    const tomorrow = new Date(NOW.getTime() + DAY);
    await fanslyStatsSnapshotChunk(
      dailyOnlyAppStub(adapter),
      input(page.id, telemetry, new SyncChunkBudget(), tomorrow),
    );
    expect(adapter.statsRequests.filter((request) => request.year !== 0)).toHaveLength(1);
  });

  it("resumes at the BOOKMARK when the [E10] probe finds older history", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedHistoryPage();
    // Traffic in July 2026 and in May 2025, nothing between: the long-idle
    // account [E10] exists for. The probe proves there IS older history, so the
    // eleven months it jumped over are unexamined rather than absent.
    const adapter = windowAdapterStub({
      statsFor: (params) => {
        if ((params.year ?? 0) === 0) {
          return statsBodyFor(
            { afterMs: params.afterDate.getTime(), beforeMs: params.beforeDate.getTime() },
            28,
          );
        }
        const index = params.year! * 12 + (params.month! - 1);
        return index === JULY_2026 || index === 2025 * 12 + 4
          ? monthBodyFor(params.year!, params.month!, 30)
          : allZeroMonthBody(params.year!, params.month!);
      },
    });
    const telemetry = telemetryStub();
    // Trailing, July (data), June and May (empty), the probe at 2025-05 (data).
    await capDayAt(5);

    const state = await driveChunks(
      dailyOnlyAppStub(adapter),
      page.id,
      telemetry,
      (current) => current.callsToday >= 5,
    );

    const months = adapter.statsRequests
      .filter((request) => request.year !== 0)
      .map((request) => `${request.year}-${String(request.month).padStart(2, "0")}`);
    expect(months).toEqual(["2026-07", "2026-06", "2026-05", "2025-05"]);
    // BACK TO THE GAP, not onwards from the probe: without the bookmark the
    // eleven months the probe jumped would be a hole nobody notices for a year.
    expect(state!.backfill!.daily.nextMonthIndex).toBe(2026 * 12 + 3);
    expect(state!.backfill!.daily.probeResumeMonthIndex).toBeNull();
    expect(state!.backfill!.daily.done).toBe(false);
    // The floor claim follows the OLDEST bound ever served, which is the probe's.
    expect(state!.backfill!.daily.floorAt).toBe(new Date(Date.UTC(2025, 4, 1)).toISOString());
    expect(state!.backfill!.daily.probeHitMonthIndex).toBe(2025 * 12 + 4);

    // …AND IT WALKS THAT GAP. The empty months between the bookmark and the
    // probe month are history the probe proved exists: two of them in a row
    // must not end the walk before it reaches May 2025. It steps past May —
    // journaled already — and only then earns a floor, on two empty months of
    // its own.
    await capDayAt(18);
    const finished = await driveChunks(
      dailyOnlyAppStub(adapter),
      page.id,
      telemetry,
      (current) => current.backfill !== null && current.backfill.daily.done,
    );
    const walked = adapter.statsRequests
      .filter((request) => request.year !== 0)
      .map((request) => `${request.year}-${String(request.month).padStart(2, "0")}`);
    expect(walked).toEqual([
      "2026-07", "2026-06", "2026-05", "2025-05",
      "2026-04", "2026-03", "2026-02", "2026-01", "2025-12", "2025-11",
      "2025-10", "2025-09", "2025-08", "2025-07", "2025-06",
      "2025-04", "2025-03",
    ]);
    expect(finished!.backfill!.daily.done).toBe(true);
    expect(finished!.backfill!.daily.probeHitMonthIndex).toBeNull();
    const row = await coverageRow(page.id, "stats_account_daily");
    expect(row?.status).toBe("provider_exhausted");
    expect(row?.reason_code).toBe("empty_window_streak");
    expect((row?.cursor as { lastMonth?: string }).lastMonth).toBe("2025-03");
  });

  it("walks to the account's CREATION month without probing when it is known", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedHistoryPage();
    // Traffic in July 2026 only; the account was created in September 2025.
    // Two empty months used to spend the probe a year back — into August 2025,
    // before the account existed — and the creation floor then ended the walk
    // with June 2025..April 2026 never asked.
    const adapter = windowAdapterStub({
      statsFor: (params) => {
        if ((params.year ?? 0) === 0) {
          return statsBodyFor(
            { afterMs: params.afterDate.getTime(), beforeMs: params.beforeDate.getTime() },
            28,
          );
        }
        const index = params.year! * 12 + (params.month! - 1);
        return index === JULY_2026
          ? monthBodyFor(params.year!, params.month!, 30)
          : allZeroMonthBody(params.year!, params.month!);
      },
    });
    const telemetry = telemetryStub();
    // The trailing window and eleven months; the free creation-floor check
    // still needs a day with room left in it, which the earnings walk behind
    // it then takes.
    await capDayAt(13);

    const state = await driveChunks(
      dailyOnlyAppStub(adapter),
      page.id,
      telemetry,
      (current) => current.backfill !== null && current.backfill.daily.done,
      8,
      { accountCreatedAt: "2025-09-10T08:00:00.000Z" },
    );

    const months = adapter.statsRequests
      .filter((request) => request.year !== 0)
      .map((request) => `${request.year}-${String(request.month).padStart(2, "0")}`);
    // EVERY month down to the creation month, one call each, and no probe.
    expect(months).toEqual([
      "2026-07", "2026-06", "2026-05", "2026-04", "2026-03", "2026-02",
      "2026-01", "2025-12", "2025-11", "2025-10", "2025-09",
    ]);
    expect(state!.backfill!.daily.done).toBe(true);
    expect(state!.backfill!.daily.probeSpent).toBe(false);
    const row = await coverageRow(page.id, "stats_account_daily");
    expect(row?.status).toBe("provider_exhausted");
    expect(row?.proof).toBe("none");
    expect(row?.reason_code).toBe("account_creation_floor");
    expect(row?.cursor.requestedMonth).toBe("2025-08");
  });

  /** The provider's answer for a month with no statistics at all, 200 and all:
   *  byte-for-byte what ari-1's creation month came back with on 2026-09-28. */
  const terminalNullMonth = () => ({ dataset: null, aggregationData: null });
  const MARCH_2026 = 2026 * 12 + 2;
  const monthsAsked = (adapter: ReturnType<typeof windowAdapterStub>) => adapter.statsRequests
    .filter((request) => request.year !== 0)
    .map((request) => `${request.year}-${String(request.month).padStart(2, "0")}`);

  /** A cursor parked exactly where ari-1's was: the trailing window and
   *  2026-07..04 walked, three empty months, the next month 2026-03. */
  async function seedAriCursor(pageId: number) {
    const seeded = emptyFanslyStatsCursorState(NOW);
    seeded.lastSweepDay = utcDayKey(NOW);
    const daily = seeded.backfill!.daily;
    daily.trailingCaptured = true;
    daily.nextMonthIndex = MARCH_2026;
    daily.lastMonthIndex = null;
    daily.emptyStreak = 3;
    daily.floorAt = new Date(Date.UTC(2026, 5, 30)).toISOString();
    await upsertCheckpointProgress(testDb!.db, {
      platformAccountId: pageId,
      stream: "stats_snapshot",
      cursorText: null,
      state: seeded as unknown as Record<string, unknown>,
    });
  }

  const ARI_CREATED = { accountCreatedAt: "2026-03-17T19:39:18.000Z" };

  it("ends the walk at the CREATION floor when the creation month answers terminal-null", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedHistoryPage();
    // ari-1 on 2026-09-28, on this file's clock: created mid-March, traffic in
    // July, one zero-valued row for each of June..April — and the creation
    // month answered with the terminal-null body. The lane threw on it six
    // times running and the walk could never finish.
    const adapter = windowAdapterStub({
      statsFor: (params) => {
        if ((params.year ?? 0) === 0) {
          return statsBodyFor(
            { afterMs: params.afterDate.getTime(), beforeMs: params.beforeDate.getTime() },
            28,
          );
        }
        const index = params.year! * 12 + (params.month! - 1);
        if (index === JULY_2026) return monthBodyFor(params.year!, params.month!, 21);
        if (index === MARCH_2026) return terminalNullMonth();
        return allZeroMonthBody(params.year!, params.month!);
      },
    });
    const telemetry = telemetryStub();
    // The trailing window and five months; the free creation-floor check needs
    // room left in the day, which the earnings walk behind it then takes.
    await capDayAt(7);

    const state = await driveChunks(
      dailyOnlyAppStub(adapter),
      page.id,
      telemetry,
      (current) => current.backfill !== null && current.backfill.daily.done,
      8,
      ARI_CREATED,
    );

    // 2026-03 ONCE, and nothing older: February predates the account, so the
    // walk ends there without egress.
    expect(monthsAsked(adapter)).toEqual(["2026-07", "2026-06", "2026-05", "2026-04", "2026-03"]);
    expect(state!.backfill!.daily.done).toBe(true);
    expect(state!.backfill!.daily.probeSpent).toBe(false);
    // The floor stays what the provider actually served: July's own start.
    expect(state!.backfill!.daily.floorAt).toBe(new Date(Date.UTC(2026, 6, 1)).toISOString());
    const row = await coverageRow(page.id, "stats_account_daily");
    expect(row?.status).toBe("provider_exhausted");
    expect(row?.proof).toBe("none");
    expect(row?.reason_code).toBe("account_creation_floor");
    expect(row?.cursor.requestedMonth).toBe("2026-02");
    // Capture first: the terminal-null answer is journaled like every month.
    expect((await journaledKinds(page.id)).filter((kind) => kind === "account_stats"))
      .toHaveLength(6);
  });

  it("resumes ari-1's PRODUCTION cursor: one request for the terminal-null month, then done", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedHistoryPage();
    await seedAriCursor(page.id);
    const adapter = windowAdapterStub({
      statsFor: (params) => (params.year ?? 0) === 0 ? emptyStatsBody() : terminalNullMonth(),
    });
    const telemetry = telemetryStub();
    await capDayAt(2);

    await expect(fanslyStatsSnapshotChunk(
      dailyOnlyAppStub(adapter),
      input(page.id, telemetry, new SyncChunkBudget(), NOW, ARI_CREATED),
    )).resolves.toBeDefined();

    expect(monthsAsked(adapter)).toEqual(["2026-03"]);
    const state = await cursor(page.id);
    expect(state!.backfill!.daily.done).toBe(true);
    expect(state!.backfill!.daily.floorAt).toBe(new Date(Date.UTC(2026, 5, 30)).toISOString());
    const row = await coverageRow(page.id, "stats_account_daily");
    expect(row?.status).toBe("provider_exhausted");
    expect(row?.proof).toBe("none");
    expect(row?.reason_code).toBe("account_creation_floor");
    expect(row?.cursor.requestedMonth).toBe("2026-02");
    expect(row?.cursor.accountCreatedAt).toBe(ARI_CREATED.accountCreatedAt);
    expect(telemetry.anomalies.filter(
      (anomaly) => anomaly.code === "fansly_stats_probe_response_invalid",
    )).toHaveLength(0);

    // A finished walk asks for no month again — not tomorrow, not ever.
    const tomorrow = new Date(NOW.getTime() + DAY);
    await fanslyStatsSnapshotChunk(
      dailyOnlyAppStub(adapter),
      input(page.id, telemetry, new SyncChunkBudget(), tomorrow, ARI_CREATED),
    );
    expect(monthsAsked(adapter)).toEqual(["2026-03"]);
  });

  it("reads a terminal-null month as EMPTY, never a floor: history below it is walked", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedHistoryPage();
    // lilly-1 on 2026-08-23: 2025-05 answered terminal-null a year after the
    // account was created, and 2024-05 below it carried traffic. Ending the
    // walk on that answer would have been a false floor.
    const adapter = windowAdapterStub({
      statsFor: (params) => {
        if ((params.year ?? 0) === 0) {
          return statsBodyFor(
            { afterMs: params.afterDate.getTime(), beforeMs: params.beforeDate.getTime() },
            28,
          );
        }
        const index = params.year! * 12 + (params.month! - 1);
        if (index === JULY_2026 || index === 2026 * 12 + 4) {
          return monthBodyFor(params.year!, params.month!, 20);
        }
        if (index === 2026 * 12 + 5) return terminalNullMonth();
        return allZeroMonthBody(params.year!, params.month!);
      },
    });
    const telemetry = telemetryStub();
    await capDayAt(6);

    const state = await driveChunks(
      dailyOnlyAppStub(adapter),
      page.id,
      telemetry,
      (current) => current.backfill !== null && current.backfill.daily.done,
      8,
      { accountCreatedAt: "2026-04-10T08:00:00.000Z" },
    );

    expect(monthsAsked(adapter)).toEqual(["2026-07", "2026-06", "2026-05", "2026-04"]);
    expect(state!.backfill!.daily.done).toBe(true);
    // May, BELOW the terminal-null June, is what the floor rests on.
    expect(state!.backfill!.daily.floorAt).toBe(new Date(Date.UTC(2026, 4, 1)).toISOString());
    const row = await coverageRow(page.id, "stats_account_daily");
    expect(row?.status).toBe("provider_exhausted");
    expect(row?.reason_code).toBe("account_creation_floor");
    expect(row?.cursor.requestedMonth).toBe("2026-03");
  });

  it("still THROWS on a near miss of the terminal-null shape and withholds progress", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedHistoryPage();
    await seedAriCursor(page.id);
    // One field off the proven shape is drift, exactly as the canonicalizer's
    // gate calls it: journaled, unstamped, and no claim about the month.
    const adapter = windowAdapterStub({
      statsFor: (params) => (params.year ?? 0) === 0
        ? emptyStatsBody()
        : { dataset: null, aggregationData: {} },
    });
    const telemetry = telemetryStub();
    await capDayAt(2);

    await expect(fanslyStatsSnapshotChunk(
      dailyOnlyAppStub(adapter),
      input(page.id, telemetry, new SyncChunkBudget(), NOW, ARI_CREATED),
    )).rejects.toMatchObject({
      name: "FanslyLaneInvalidResponseError",
      observationKind: "account_stats",
    });

    expect(monthsAsked(adapter)).toEqual(["2026-03"]);
    const state = await cursor(page.id);
    expect(state!.backfill!.daily.done).toBe(false);
    expect(state!.backfill!.daily.nextMonthIndex).toBe(MARCH_2026);
    expect(state!.backfill!.daily.lastMonthIndex).toBeNull();
    expect(await coverageRow(page.id, "stats_account_daily")).toBeNull();
    expect(await journaledKinds(page.id)).toEqual(["account_stats"]);
  });

  it("refuses to ask for the same MONTH twice, before any egress", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedHistoryPage();
    // A cursor that has ALREADY asked for exactly the month it is about to ask
    // for — a derivation that came back where it started, or corrupted state.
    // The guard is durable because the production loop spanned five chunks.
    const seeded = emptyFanslyStatsCursorState(NOW);
    seeded.lastSweepDay = utcDayKey(NOW);
    seeded.backfill!.daily.trailingCaptured = true;
    seeded.backfill!.daily.nextMonthIndex = JULY_2026;
    seeded.backfill!.daily.lastMonthIndex = JULY_2026;
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: null,
      state: seeded as unknown as Record<string, unknown>,
    });

    const adapter = windowAdapterStub({
      statsFor: (params) => monthBodyFor(params.year ?? 2026, params.month ?? 7, 30),
    });
    const telemetry = telemetryStub();
    await capDayAt(1);

    const state = await driveChunks(
      dailyOnlyAppStub(adapter),
      page.id,
      telemetry,
      (current) => current.backfill !== null && current.backfill.daily.done,
    );

    // SPENT BEFORE ANY EGRESS. There is nothing to learn from issuing it.
    expect(adapter.statsRequests).toHaveLength(0);
    expect(state!.backfill!.daily.done).toBe(true);
    const raised = telemetry.anomalies.filter(
      (anomaly) => anomaly.code === "fansly_stats_month_form_not_honoured",
    );
    expect(raised).toHaveLength(1);
    expect((raised[0]!.details as { trigger?: string }).trigger).toBe("repeat_request");
    const row = await coverageRow(page.id, "stats_account_daily");
    expect(row?.status).toBe("partial_provider_surface");
    // No journaled response to point at, so the honest proof is none.
    expect(row?.proof).toBe("none");
    expect(row?.reason_code).toBe("month_form_not_honoured");
  });

  it("SUPERSEDES a lane the date-bound walk stopped and resumes it by month", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedHistoryPage();
    // EXACTLY THE TWO PAGES ON PRODUCTION (lilly-2, lora-2): the guard stopped
    // the daily lane with `window_not_honoured`, all three walks were marked
    // done, and the cursor settled into the steady sweep. The claim was correct
    // about the walk it stopped and wrong about the surface: history is served
    // by month, and this lane never asked.
    const stoppedCursor = emptyFanslyStatsCursorState(NOW);
    stoppedCursor.lastSweepDay = utcDayKey(NOW);
    stoppedCursor.mode = "steady";
    stoppedCursor.backfill = null;
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: null,
      state: stoppedCursor as unknown as Record<string, unknown>,
    });
    await upsertCaptureCoverage(testDb.db, {
      pageId: page.id,
      platform: "fansly",
      plane: "stats_account_daily",
      scopeRef: "",
      status: "partial_provider_surface",
      acquisitionMode: "retroactive",
      // `proof: none` because this fixture has no journaled body to point at;
      // production's row points at the response that ignored the window, and
      // the supersede reads the REASON CODE either way.
      proof: "none",
      reasonCode: "window_not_honoured",
      proofObservationId: null,
    });

    const adapter = windowAdapterStub({
      statsFor: (params) => (params.year ?? 0) === 0
        ? statsBodyFor(
          { afterMs: params.afterDate.getTime(), beforeMs: params.beforeDate.getTime() },
          28,
        )
        : monthBodyFor(params.year!, params.month!, 30),
    });
    const telemetry = telemetryStub();
    await capDayAt(2);

    const state = await driveChunks(
      dailyOnlyAppStub(adapter),
      page.id,
      telemetry,
      (current) => current.callsToday >= 2,
    );

    // The lane is walking again, by month, starting at the month before the
    // trailing window — and it does NOT re-capture the trailing window it
    // already had, nor reopen the earnings walk, which honoured its own history.
    expect(state!.mode).toBe("backfill");
    expect(state!.backfill!.daily.trailingCaptured).toBe(true);
    expect(state!.backfill!.earnings.done).toBe(true);
    const months = adapter.statsRequests
      .filter((request) => request.year !== 0)
      .map((request) => `${request.year}-${String(request.month).padStart(2, "0")}`);
    expect(months).toEqual(["2026-07", "2026-06"]);

    // The superseded claim is GONE from the row — replaced, not accumulated.
    const row = await coverageRow(page.id, "stats_account_daily");
    expect(row?.status).toBe("in_progress");
    expect(row?.reason_code).toBeNull();
    expect(telemetry.anomalies.filter(
      (anomaly) => anomaly.code === "fansly_stats_month_walk_resumed",
    )).toHaveLength(1);

    // AND IT DOES NOT REOPEN AGAIN. The reason code that triggers the supersede
    // is gone, so the next dispatch is an ordinary continuation, not a reset.
    const before = adapter.statsRequests.length;
    await fanslyStatsSnapshotChunk(
      dailyOnlyAppStub(adapter) as never,
      input(page.id, telemetry, new SyncChunkBudget()),
    );
    expect(adapter.statsRequests.length).toBe(before);
    expect(telemetry.anomalies.filter(
      (anomaly) => anomaly.code === "fansly_stats_month_walk_resumed",
    )).toHaveLength(1);
  });

  it("gives the HOURLY plane the trailing window and no history walk at all", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedHistoryPage();
    // The hourly walk used to step backwards in 4-day windows. Those are DATE
    // BOUNDS on the same route the month walk exists because of, and the month
    // form has no hourly granularity to offer — so the plane is the trailing 25
    // hours and it says so, rather than spending calls proving it every day.
    // An account with a trailing window and no older months at all, so the
    // daily walk reaches its floor immediately and the hourly lane behind it
    // gets its turn inside one day's cap.
    const adapter = windowAdapterStub({
      statsFor: (params) => (params.year ?? 0) === 0
        ? statsBodyFor(
          { afterMs: params.afterDate.getTime(), beforeMs: params.beforeDate.getTime() },
          28,
        )
        : allZeroMonthBody(params.year!, params.month!),
    });
    const telemetry = telemetryStub();
    // Five: the trailing window, two empty months, the [E10] probe, and one for
    // the earnings lane behind it — the hourly lane costs NOTHING, which is the
    // whole point, so the cap has to leave room for the lane AFTER it.
    await capDayAt(5);

    // The hourly lane is ENABLED here — the point is that it makes no backfill
    // call even so.
    await driveChunks(
      appStub(adapter as never),
      page.id,
      telemetry,
      (current) => current.backfill !== null && current.backfill.hourly.done,
    );

    expect(adapter.statsRequests.filter((request) => request.periodMs === 3_600_000))
      .toHaveLength(0);
    const row = await coverageRow(page.id, "stats_account_hourly");
    expect(row?.status).toBe("partial_provider_surface");
    expect(row?.reason_code).toBe("hourly_trailing_window_only");
    expect(row?.proof).toBe("none");
    expect(row?.cursor.trailingHours).toBe(25);
  });

  it("probes older than two empty earnings windows before claiming the floor", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedHistoryPage();
    const adapter = windowAdapterStub({
      statsFor: (params) => (params.year ?? 0) === 0
        ? statsBodyFor(
          { afterMs: params.afterDate.getTime(), beforeMs: params.beforeDate.getTime() },
          0,
        )
        : allZeroMonthBody(params.year!, params.month!),
      earningsFor: () => [],
    });
    const telemetry = telemetryStub();
    // Four stats calls (trailing, two empty months, older probe), then two
    // ordinary empty earnings windows and the required older earnings probe.
    await capDayAt(7);

    await driveChunks(
      dailyOnlyAppStub(adapter),
      page.id,
      telemetry,
      (current) => current.backfill === null || current.backfill.earnings.done,
    );

    expect(adapter.earningsRequests).toHaveLength(3);
    const [first, second, probe] = adapter.earningsRequests;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(probe).toBeDefined();
    expect(probe!.beforeMs).toBeLessThan(second!.afterMs - 300 * DAY);
    const row = await coverageRow(page.id, "stats_earnings");
    expect(row?.status).toBe("provider_exhausted");
    expect(row?.proof).toBe("empty_window");
  });

  /** A page whose daily and hourly history is finished, so the only walk left
   *  is the earnings one, from NOW down. */
  async function seedEarningsOnlyPage() {
    const page = await seedPage();
    const state = emptyFanslyStatsCursorState(NOW);
    state.lastSweepDay = utcDayKey(NOW);
    state.backfill!.daily.done = true;
    state.backfill!.hourly.done = true;
    await upsertCheckpointProgress(testDb!.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: state.lastSweepDay,
      state: state as unknown as Record<string, unknown>,
    });
    return page;
  }

  /** Earnings rows at exactly these instants, served to any window holding one. */
  function earningsRowsAt(timestamps: number[]) {
    return (params: { before: Date; after: Date }) => timestamps
      .filter((ts) => ts >= params.after.getTime() && ts <= params.before.getTime())
      .map((ts) => ({ type: 1, totalGross: 1_000, totalNet: 900, accountId: "acct-budget", timestamp: ts }));
  }

  it("resumes the earnings walk at its BOOKMARK and walks the gap to the probe", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedEarningsOnlyPage();
    // Earnings this month and in May 2025, nothing between. The probe a year
    // back finds May 2025, which proves the year it jumped is unexamined.
    const adapter = windowAdapterStub({
      statsFor: () => emptyStatsBody(),
      earningsFor: earningsRowsAt([NOW.getTime() - 5 * DAY, Date.UTC(2025, 4, 1)]),
    });
    const telemetry = telemetryStub();
    await capDayAt(40);

    await driveChunks(
      dailyOnlyAppStub(adapter),
      page.id,
      telemetry,
      (current) => current.backfill === null || current.backfill.earnings.done,
    );

    const requests = adapter.earningsRequests;
    const secondEmpty = requests[2]!;
    const probe = requests[3]!;
    expect(probe.beforeMs).toBe(secondEmpty.afterMs - 1 - 365 * DAY);
    // BACK TO THE BOOKMARK — the window below the second empty one, which is
    // journaled and not asked for again.
    expect(requests[4]!.beforeMs).toBe(secondEmpty.afterMs - 1);
    // THE GAP, contiguous, empty windows and all: no streak ends the walk
    // until the next window would reach into the probe's.
    const gapEnd = requests.findIndex((request, index) =>
      index > 4 && request.beforeMs <= probe.beforeMs
    );
    expect(gapEnd).toBeGreaterThan(4 + 2);
    for (let index = 5; index < gapEnd; index += 1) {
      expect(requests[index]!.beforeMs).toBe(requests[index - 1]!.afterMs - 1);
    }
    // PAST THE PROBE WINDOW, which is journaled — then two empty windows of its
    // own, and only then the floor.
    expect(requests[gapEnd]!.beforeMs).toBe(probe.afterMs - 1);
    expect(requests).toHaveLength(gapEnd + 2);
    expect(requests.filter((request) => request.beforeMs === probe.beforeMs)).toHaveLength(1);
    const row = await coverageRow(page.id, "stats_earnings");
    expect(row?.status).toBe("provider_exhausted");
    expect(row?.reason_code).toBe("empty_window_streak");
  });

  it("walks earnings to the account's CREATION without probing when it is known", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedEarningsOnlyPage();
    // PRODUCTION lilly-1: created 2024-05-05, earnings in 2024-05 and again
    // recently, nothing between. Two empty windows and one empty probe a year
    // back used to be claimed as the floor, with the 2024 earnings never asked.
    const createdAt = "2024-05-05T10:00:00.000Z";
    const adapter = windowAdapterStub({
      statsFor: () => emptyStatsBody(),
      earningsFor: earningsRowsAt([NOW.getTime() - 5 * DAY, Date.UTC(2024, 4, 20)]),
    });
    const telemetry = telemetryStub();
    await capDayAt(40);

    await driveChunks(
      dailyOnlyAppStub(adapter),
      page.id,
      telemetry,
      (current) => current.backfill === null || current.backfill.earnings.done,
      12,
      { accountCreatedAt: createdAt },
    );

    const requests = adapter.earningsRequests;
    // NO PROBE: every window is the one right below the last.
    for (let index = 1; index < requests.length; index += 1) {
      expect(requests[index]!.beforeMs).toBe(requests[index - 1]!.afterMs - 1);
    }
    // Down to the window holding the creation date, and not one below it.
    const last = requests.at(-1)!;
    expect(last.afterMs).toBeLessThanOrEqual(Date.parse(createdAt));
    expect(last.beforeMs).toBeGreaterThan(Date.parse(createdAt));
    expect(requests.some((request) =>
      request.afterMs <= Date.UTC(2024, 4, 20) && request.beforeMs >= Date.UTC(2024, 4, 20)
    )).toBe(true);
    const row = await coverageRow(page.id, "stats_earnings");
    expect(row?.status).toBe("provider_exhausted");
    expect(row?.proof).toBe("none");
    expect(row?.reason_code).toBe("account_creation_floor");
    expect(row?.cursor.accountCreatedAt).toBe(createdAt);
  });

  it("reopens an earnings floor claimed from empty windows ONCE, when creation is known", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // PRODUCTION lilly-1 on 2026-09-28: steady state, and an earnings floor at
    // 2025-11-16 claimed from two empty windows and an empty probe, on an
    // account created 2024-05-05.
    const steady = emptyFanslyStatsCursorState(NOW);
    steady.lastSweepDay = utcDayKey(NOW);
    steady.mode = "steady";
    steady.backfill = null;
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: null,
      state: steady as unknown as Record<string, unknown>,
    });
    const claimedOldest = new Date("2025-11-16T00:00:00.000Z");
    await upsertCaptureCoverage(testDb.db, {
      pageId: page.id,
      platform: "fansly",
      plane: "stats_earnings",
      scopeRef: "",
      status: "provider_exhausted",
      acquisitionMode: "retroactive",
      proof: "none",
      oldestCapturedAt: claimedOldest,
      reasonCode: "empty_window_streak",
      proofObservationId: null,
    });
    const adapter = windowAdapterStub({ statsFor: () => emptyStatsBody(), earningsFor: () => [] });
    const telemetry = telemetryStub();
    await capDayAt(1);

    // Without a creation date the claim stands: it is the probe rule's own.
    await fanslyStatsSnapshotChunk(dailyOnlyAppStub(adapter), input(page.id, telemetry));
    expect(adapter.earningsRequests).toHaveLength(0);
    expect((await coverageRow(page.id, "stats_earnings"))?.reason_code)
      .toBe("empty_window_streak");

    const metadata = { accountCreatedAt: "2024-05-05T10:00:00.000Z" };
    await fanslyStatsSnapshotChunk(
      dailyOnlyAppStub(adapter),
      input(page.id, telemetry, new SyncChunkBudget(), NOW, metadata),
    );
    // Only the earnings walk reopens, right below where it had reached.
    expect(adapter.earningsRequests).toHaveLength(1);
    expect(adapter.earningsRequests[0]!.beforeMs).toBe(claimedOldest.getTime() - 1);
    expect(adapter.statsRequests).toHaveLength(0);
    const state = await cursor(page.id);
    expect(state!.mode).toBe("backfill");
    expect(state!.backfill!.daily.done).toBe(true);
    expect(state!.backfill!.hourly.done).toBe(true);
    expect(state!.backfill!.earnings.done).toBe(false);
    const row = await coverageRow(page.id, "stats_earnings");
    expect(row?.status).toBe("in_progress");
    expect(row?.reason_code).toBe("account_creation_floor_supersedes_empty_window");
    const resumed = () => telemetry.anomalies.filter(
      (anomaly) => anomaly.code === "fansly_stats_earnings_walk_resumed",
    );
    expect(resumed()).toHaveLength(1);

    // AND NOT AGAIN: the next dispatch continues the walk, it does not restart it.
    await capDayAt(2);
    await fanslyStatsSnapshotChunk(
      dailyOnlyAppStub(adapter),
      input(page.id, telemetry, new SyncChunkBudget(), NOW, metadata),
    );
    expect(adapter.earningsRequests).toHaveLength(2);
    expect(adapter.earningsRequests[1]!.beforeMs).toBe(adapter.earningsRequests[0]!.afterMs - 1);
    expect(resumed()).toHaveLength(1);
  });

  it("reopens below the two empty windows when no earnings window ever carried rows", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // PRODUCTION ari-1: created 2026-03-17, floor claimed with NO window that
    // ever carried rows, so there is no oldest capture to resume below. The two
    // empty windows the old walk spent sit below its start, and the claim was
    // written no earlier than that.
    const steady = emptyFanslyStatsCursorState(NOW);
    steady.lastSweepDay = utcDayKey(NOW);
    steady.mode = "steady";
    steady.backfill = null;
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: null,
      state: steady as unknown as Record<string, unknown>,
    });
    await upsertCaptureCoverage(testDb.db, {
      pageId: page.id,
      platform: "fansly",
      plane: "stats_earnings",
      scopeRef: "",
      status: "provider_exhausted",
      acquisitionMode: "retroactive",
      proof: "none",
      reasonCode: "empty_window_streak",
      proofObservationId: null,
    });
    const claimedAt = Date.parse("2026-08-10T04:00:00.000Z");
    await testDb.pool.query(
      `update capture_coverage set updated_at = $2
        where page_id = $1 and plane = 'stats_earnings' and scope_ref = ''`,
      [page.id, new Date(claimedAt)],
    );
    const adapter = windowAdapterStub({ statsFor: () => emptyStatsBody(), earningsFor: () => [] });
    await capDayAt(1);

    await fanslyStatsSnapshotChunk(
      dailyOnlyAppStub(adapter),
      input(page.id, telemetryStub(), new SyncChunkBudget(), NOW, {
        accountCreatedAt: "2026-03-17T12:00:00.000Z",
      }),
    );

    expect(adapter.earningsRequests).toHaveLength(1);
    expect(adapter.earningsRequests[0]!.beforeMs).toBe(claimedAt - 62 * DAY);
  });

  it("guards the earnings lane on the rows, since that route describes no window", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedHistoryPage();
    // Stats answer honestly and run out immediately, so what this test watches
    // is the earnings walk: rows stamped TODAY no matter which window is asked
    // for — the same refusal, on a route that states no bounds of its own.
    const adapter = windowAdapterStub({
      statsFor: (params) => statsBodyFor(
        { afterMs: params.afterDate.getTime(), beforeMs: params.beforeDate.getTime() },
        0,
      ),
      earningsFor: () => [
        { type: 1, totalGross: 1_000, totalNet: 900, accountId: "acct-budget", timestamp: NOW.getTime() },
      ],
    });
    const telemetry = telemetryStub();
    // The first earnings window is valid; the next returns rows outside its
    // bounds and must stop with the journaled response as evidence.
    await capDayAt(6);

    await driveChunks(
      dailyOnlyAppStub(adapter),
      page.id,
      telemetry,
      (current) => current.backfill === null || current.backfill.earnings.done,
    );

    expect(adapter.earningsRequests).toHaveLength(2);
    const [first, refused] = adapter.earningsRequests;
    expect(first!.beforeMs).toBe(NOW.getTime());
    expect(refused!.beforeMs).toBe(first!.afterMs - 1);
    expect(refused!.afterMs).toBeLessThan(first!.afterMs);
    expect(adapter.earningsRequests.every((request) => request.offset === undefined)).toBe(true);

    const row = await coverageRow(page.id, "stats_earnings");
    expect(row?.status).toBe("partial_provider_surface");
    expect(row?.proof).toBe("terminal_response");
    expect(row?.reason_code).toBe("earnings_window_not_honoured");
    expect(row?.proof_observation_id).not.toBeNull();
    expect(telemetry.anomalies.filter(
      (anomaly) => anomaly.code === "fansly_stats_earnings_window_not_honoured",
    )).toHaveLength(1);
  });

  /** Seed just the earnings lane so request sequences are independently visible. */
  async function seedEarningsLane(mode: "backfill" | "steady") {
    const page = await seedPage();
    const state = emptyFanslyStatsCursorState(NOW);
    state.mode = mode;
    state.lastHourlyCapturedAt = NOW.toISOString();
    if (mode === "backfill") {
      state.lastSweepDay = utcDayKey(NOW);
      state.backfill!.daily.done = true;
      state.backfill!.daily.trailingCaptured = true;
      state.backfill!.hourly.done = true;
    } else {
      state.backfill = null;
      state.sweepDay = utcDayKey(NOW);
      state.stepIndex = 2;
    }
    await upsertCheckpointProgress(testDb!.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: state.lastSweepDay,
      state: state as unknown as Record<string, unknown>,
    });
    return { page, state };
  }

  it.for(["backfill", "steady"] as const)(
    "captures every day/type with ignored offsets and persists %s splits across midnight",
    async (mode, context) => {
      if (!testDb) {
        context.skip();
        return;
      }
      const { page } = await seedEarningsLane(mode);
      // Five types on each midnight, including the split seam. A capped parent
      // omits 50 facts; both child windows are needed to recover all 150.
      const rows = Array.from({ length: 150 }, (_unused, index) => ({
        timestamp: Date.UTC(2026, 7, 19) - Math.floor(index / 5) * DAY,
        type: 15001 + index % 5,
        totalGross: 1_000,
        totalNet: 800,
        accountId: "acct-budget",
      }));
      const seen = new Set<string>();
      const adapter = windowAdapterStub({
        statsFor: () => emptyStatsBody(),
        earningsFor: (params) => {
          // Real provider behavior: limit is honoured; offset is ignored.
          const answer = rows.filter((row) => row.timestamp >= Math.floor(params.after.getTime() / DAY) * DAY
            && row.timestamp <= Math.floor(params.before.getTime() / DAY) * DAY).slice(0, params.limit ?? 100);
          for (const row of answer) seen.add(`${row.timestamp}:${row.type}`);
          return answer;
        },
      });
      const telemetry = telemetryStub();
      await fanslyStatsSnapshotChunk(
        appStub(adapter as never), input(page.id, telemetry, new SyncChunkBudget(1)),
      );
      const first = await cursor(page.id);
      const originalWalk = mode === "steady" ? first!.earningsWalk : first!.backfill!.earnings.walk;
      expect(originalWalk?.pending).toHaveLength(2);
      expect(first!.callsToday).toBe(1);
      expect(seen.size).toBe(100);
      const tomorrow = new Date("2026-08-20T00:06:00.000Z");
      // For history, finish tomorrow's fresh sweep before resuming its old
      // cursor. This emulates a new executor process loading the durable state.
      if (mode === "backfill") {
        first!.lastSweepDay = utcDayKey(tomorrow);
        first!.lastHourlyCapturedAt = tomorrow.toISOString();
        await upsertCheckpointProgress(testDb.db, {
          platformAccountId: page.id, stream: "stats_snapshot", cursorText: first!.lastSweepDay,
          state: first as unknown as Record<string, unknown>,
        });
      }
      for (let chunk = 0; chunk < 12; chunk += 1) {
        await fanslyStatsSnapshotChunk(appStub(adapter as never),
          input(page.id, telemetry, new SyncChunkBudget(1), tomorrow));
        const next = await cursor(page.id);
        const walk = mode === "steady" ? next!.earningsWalk : next!.backfill?.earnings.walk;
        if (walk == null) break;
        expect(walk.beforeMs).toBe(originalWalk!.beforeMs);
        expect(walk.afterMs).toBe(originalWalk!.afterMs);
      }
      expect(seen).toEqual(new Set(rows.map((row) => `${row.timestamp}:${row.type}`)));
      expect(adapter.earningsRequests.length).toBeGreaterThan(1);
      expect(adapter.earningsRequests.length).toBeLessThan(12);
      expect(new Set(adapter.earningsRequests.map((request) =>
        `${request.afterMs}:${request.beforeMs}`)).size).toBe(adapter.earningsRequests.length);
      expect(adapter.earningsRequests.every((request) => request.offset === undefined)).toBe(true);
      expect(adapter.earningsRequests.every((request) => request.beforeMs <= NOW.getTime())).toBe(true);
      expect((await journaledKinds(page.id)).filter((kind) => kind === "earnings_stats_snapshot"))
        .toHaveLength(adapter.earningsRequests.length);
      // Steady resumes YESTERDAY's sweep at 00:06, 15 h after the last hourly
      // capture: the next slot is in time, and the sweep ends within the cap,
      // so the call it holds back for the window is never spent. History
      // finished today's head, the window included, before resuming.
      expect(adapter.statsRequests.filter((request) => request.periodMs === 3_600_000))
        .toHaveLength(0);
      expect((await cursor(page.id))!.callsToday).toBe(adapter.earningsRequests.length - 1);
      expect(telemetry.anomalies).toHaveLength(0);
    },
  );

  it("recovers a v2 huge-offset history cursor without resetting budget or completed lanes", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, state } = await seedEarningsLane("backfill");
    const historicalBefore = Date.UTC(2025, 6, 15, 4);
    state.backfill!.earnings.nextBeforeMs = historicalBefore;
    state.backfill!.earnings.probeResumeBeforeMs = Date.UTC(2025, 7, 1);
    state.callsToday = 7;
    const legacy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    legacy.version = 2;
    legacy.earningsOffset = 700_000;
    legacy.earningsPreviousOffset = 699_900;
    const historical = (legacy.backfill as { earnings: Record<string, unknown> }).earnings;
    delete historical.walk;
    Object.assign(historical, { offset: 600_000, lastOffset: 599_900, windowRows: 600_000 });
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id, stream: "stats_snapshot", cursorText: state.lastSweepDay,
      state: legacy,
    });
    const adapter = windowAdapterStub({
      statsFor: () => emptyStatsBody(),
      earningsFor: () => Array.from({ length: 100 }, (_unused, type) => ({
        timestamp: Date.UTC(2025, 6, 14), type, totalGross: 1_000, totalNet: 800,
      })),
    });
    await fanslyStatsSnapshotChunk(appStub(adapter as never),
      input(page.id, telemetryStub(), new SyncChunkBudget(1)));
    expect(adapter.earningsRequests).toHaveLength(1);
    expect(adapter.earningsRequests[0]).toMatchObject({ beforeMs: historicalBefore, offset: undefined });
    const migrated = (await cursor(page.id))!;
    expect(migrated.version).toBe(2);
    expect(migrated.callsToday).toBe(8);
    expect(migrated.backfill!.daily.done).toBe(true);
    expect(migrated.backfill!.hourly.done).toBe(true);
    expect(migrated.backfill!.earnings.nextBeforeMs).toBe(historicalBefore);
    expect(migrated.backfill!.earnings.probeResumeBeforeMs).toBe(Date.UTC(2025, 7, 1));
    expect(migrated.backfill!.earnings.walk?.pending).toHaveLength(2);
  });

  it("runs the fresh head on each UTC day while history remains unfinished", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await capDayAt(18);
    const adapter = windowAdapterStub({
      statsFor: (params) => (params.year ?? 0) === 0 ? emptyStatsBody()
        : monthBodyFor(params.year!, params.month!, 2),
    });
    const telemetry = telemetryStub();
    const app = appStub(adapter as never);
    await driveChunks(app, page.id, telemetry, (state) => state.callsToday === 18);
    expect(adapter.calls.slice(0, 5)).toEqual([
      "account_stats", "account_stats", "earnings_stats", "earnings_monthly", "tracking_links",
    ]);
    const firstDay = (await cursor(page.id))!;
    expect(firstDay.lastSweepDay).toBe(utcDayKey(NOW));
    expect(firstDay.backfill!.daily.done).toBe(false);
    const bookmark = firstDay.backfill!.daily.nextMonthIndex;
    const oldCallCount = adapter.calls.length;
    const oldStatsCount = adapter.statsRequests.length;
    await fanslyStatsSnapshotChunk(app, input(page.id, telemetry, new SyncChunkBudget(2),
      new Date("2026-08-20T00:06:00.000Z")));
    const nextDay = (await cursor(page.id))!;
    // The hourly window first: with history open the lane will spend today's
    // cap and sleep until tomorrow's 00:05, 39 h after yesterday's capture.
    expect(adapter.calls.slice(oldCallCount)).toEqual(["account_stats", "account_stats"]);
    expect(adapter.statsRequests.slice(oldStatsCount).map((request) => request.periodMs))
      .toEqual([3_600_000, 86_400_000]);
    expect(nextDay.callsToday).toBe(2);
    expect(nextDay.sweepDay).toBe("2026-08-20");
    expect(nextDay.backfill!.daily.nextMonthIndex).toBe(bookmark);
  });

  it("marks a saturated business day partial and still completes the rest of the fresh sweep", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page } = await seedEarningsLane("steady");
    await upsertCaptureCoverage(testDb.db, {
      pageId: page.id, platform: "fansly", plane: "stats_earnings", scopeRef: "",
      status: "in_progress", acquisitionMode: "retroactive", proof: "none",
      reasonCode: "history_unfinished",
    });
    const timestamp = Date.UTC(2026, 7, 18);
    const adapter = windowAdapterStub({
      statsFor: () => emptyStatsBody(),
      earningsFor: (params) => timestamp >= params.after.getTime()
        && timestamp <= params.before.getTime()
        ? Array.from({ length: 100 }, (_unused, type) => ({ timestamp, type })) : [],
    });
    const telemetry = telemetryStub();
    const end = await driveChunks(appStub(adapter as never), page.id, telemetry,
      (state) => state.lastSweepDay === utcDayKey(NOW));
    expect(end!.lastSweepDay).toBe(utcDayKey(NOW));
    expect(adapter.calls).toContain("tracking_links");
    expect(adapter.calls).toContain("recapstats");
    expect(adapter.earningsRequests.length).toBeLessThan(10);
    expect(await coverageRow(page.id, "stats_earnings")).toMatchObject({
      status: "in_progress", reason_code: "history_unfinished",
    });
    expect(await coverageRow(page.id, "stats_earnings", "steady")).toMatchObject({
      status: "partial_provider_surface", proof: "terminal_response",
      reason_code: "earnings_saturated_day",
    });
    expect(telemetry.anomalies.filter((row) => row.code === "fansly_stats_earnings_saturated_day"))
      .toHaveLength(1);
  });

  it.for(["backfill", "steady"] as const)(
    "journals invalid %s earnings without treating them as empty history",
    async (mode, context) => {
      if (!testDb) {
        context.skip();
        return;
      }
      const { page } = await seedEarningsLane(mode);
      const adapter = windowAdapterStub({
        statsFor: () => emptyStatsBody(),
        earningsFor: () => ({ success: false, error: "invalid fixture" }),
      });
      await expect(fanslyStatsSnapshotChunk(appStub(adapter as never),
        input(page.id, telemetryStub(), new SyncChunkBudget(1)))).rejects.toMatchObject({
        name: "FanslyLaneInvalidResponseError", observationKind: "earnings_stats_snapshot",
      });
      expect(await journaledKinds(page.id)).toEqual(["earnings_stats_snapshot"]);
      expect(await coverageRow(page.id, "stats_earnings")).toBeNull();
      expect(await coverageRow(page.id, "stats_earnings", "steady")).toBeNull();
      const state = (await cursor(page.id))!;
      expect(state.callsToday).toBe(1);
      const walk = mode === "steady" ? state.earningsWalk : state.backfill!.earnings.walk;
      expect(walk?.pending).toHaveLength(1);
      if (mode === "backfill") expect(state.backfill!.earnings.done).toBe(false);
      else expect(state.stepIndex).toBe(2);
    },
  );

  it("walks BOTH broadcast lists to an empty page, reading `messages` by name", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Today's sweep has reached the broadcast steps with neither list walked.
    const page = await seedPage();
    const seeded = emptyFanslyStatsCursorState(NOW);
    seeded.mode = "steady";
    seeded.backfill = null;
    seeded.sweepDay = utcDayKey(NOW);
    seeded.stepIndex = 6;
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: null,
      state: seeded as unknown as Record<string, unknown>,
    });
    const pages: Record<string, unknown> = {
      // Media-less mass DMs: the empty `accountMedia` sidecar is the body's
      // FIRST array, and the page behind it is full.
      "live:": { accountMedia: [], accountMediaBundles: [], messages: [{ id: "300" }, { id: "200" }], tipGoals: [], tips: [] },
      "live:200": { accountMedia: [], messages: [] },
      "deleted:": { messages: [{ id: "90" }, { id: "80" }] },
      "deleted:80": { messages: [{ id: "70" }] },
      "deleted:70": { messages: [] },
    };
    const adapter = adapterStub({
      broadcastFor: (params) =>
        pages[`${params.deleted ? "deleted" : "live"}:${params.before ?? ""}`] ?? { messages: [] },
    });
    const telemetry = telemetryStub();

    for (let chunk = 0; chunk < 6; chunk += 1) {
      const result = await fanslyStatsSnapshotChunk(
        appStub(adapter),
        input(page.id, telemetry, new SyncChunkBudget()),
      );
      if (result.satisfied) break;
    }

    expect(adapter.broadcastRequests).toEqual([
      { deleted: false, before: null },
      { deleted: false, before: "200" },
      { deleted: true, before: null },
      { deleted: true, before: "80" },
      { deleted: true, before: "70" },
    ]);
    // Every page journaled, each beside the cursor that asked for it.
    const params = await testDb.pool.query(
      `select request_params from sync_raw_payloads
        where page_id = $1 and endpoint = 'broadcast_stats_deleted' order by id`,
      [page.id],
    );
    expect(params.rows.map((row) => (row as { request_params: unknown }).request_params)).toEqual([
      { before: null, walk: "first_enable_backfill" },
      { before: "80", walk: "first_enable_backfill" },
      { before: "70", walk: "first_enable_backfill" },
    ]);
    const walked = (await cursor(page.id))!;
    expect(walked.lastSweepDay).toBe(utcDayKey(NOW));
    expect(walked.broadcastFloorReached).toBe(true);
    expect(walked.broadcastWalkStop).toBe("empty_page");
    expect(walked.deletedBroadcastFloorReached).toBe(true);
    expect(walked.deletedBroadcastWalkStop).toBe("empty_page");
    expect(telemetry.anomalies).toHaveLength(0);

    // At the floor, the next day's sweep polls each list's head once.
    adapter.broadcastRequests.length = 0;
    const tomorrow = new Date("2026-08-20T09:00:00.000Z");
    for (let chunk = 0; chunk < 6; chunk += 1) {
      const result = await fanslyStatsSnapshotChunk(
        appStub(adapter),
        input(page.id, telemetry, new SyncChunkBudget(), tomorrow),
      );
      if (result.satisfied) break;
    }
    expect(adapter.broadcastRequests).toEqual([
      { deleted: false, before: null },
      { deleted: true, before: null },
    ]);
  });

  it("STOPS a deleted-list walk that ignores `before` with one anomaly, and finishes the sweep", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const seeded = emptyFanslyStatsCursorState(NOW);
    seeded.mode = "steady";
    seeded.backfill = null;
    seeded.sweepDay = utcDayKey(NOW);
    seeded.stepIndex = 6;
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: null,
      state: seeded as unknown as Record<string, unknown>,
    });
    // The live list is already at its floor; the deleted list serves its head
    // page whatever `before` asks for.
    const adapter = adapterStub({
      broadcastFor: (params) =>
        params.deleted ? { messages: [{ id: "90" }, { id: "80" }] } : { messages: [] },
    });
    const telemetry = telemetryStub();

    for (let chunk = 0; chunk < 6; chunk += 1) {
      const result = await fanslyStatsSnapshotChunk(
        appStub(adapter),
        input(page.id, telemetry, new SyncChunkBudget()),
      );
      if (result.satisfied) break;
    }

    // The head, then ONE page whose cursor did not move — and no third.
    expect(adapter.broadcastRequests.filter((request) => request.deleted)).toEqual([
      { deleted: true, before: null },
      { deleted: true, before: "80" },
    ]);
    const stopped = telemetry.anomalies
      .filter((a) => a.code === "fansly_stats_broadcast_walk_stopped");
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.severity).toBe("warn");
    expect(stopped[0]!.details).toMatchObject({
      kind: "broadcast_stats_deleted",
      stop: "cursor_not_advancing",
      before: "80",
    });
    // The walk is over rather than repeated tomorrow, and the sweep behind it
    // still ran: step 8 onward, and the day is stamped.
    const walked = (await cursor(page.id))!;
    expect(walked.deletedBroadcastFloorReached).toBe(true);
    expect(walked.deletedBroadcastWalkStop).toBe("cursor_not_advancing");
    expect(walked.broadcastWalkStop).toBe("empty_page");
    expect(adapter.calls).toContain("broadcast_scheduled");
    expect(walked.lastSweepDay).toBe(utcDayKey(NOW));
  });

  // ── THE HOURLY PLANE'S OWN CLOCK ─────────────────────────────────────────
  //
  // Hourly buckets exist only inside the route's trailing 25 h, so two hourly
  // captures further apart than that lose the hours between them for good.
  // PRODUCTION, 31 days to 2026-09-29: lilly-2 lost 123.9 h, lora-2 22.0 h,
  // lora-3 4.5 h, lilly-1 1.7 h — each time a sweep ran EARLY (a 00:05
  // continuation after a cap deferral, a deploy) and the next day's ran on its
  // slot. And where a served window ends moves by up to 2 h from call to call,
  // so even captures 24 h apart can miss one bucket: the lane keeps them within
  // 23 h. These tests drive the lane through whole days of dispatches.

  const HOUR = 3_600_000;

  /** lora-1's four stats slots in a UTC day. */
  const SLOT_TIMES = ["05:01", "11:01", "17:01", "23:01"] as const;

  function at(day: string, time: string) {
    return new Date(`${day}T${time}:00.000Z`);
  }

  function slotsOn(...days: string[]): Date[] {
    return days.flatMap((day) => SLOT_TIMES.map((time) => at(day, time)));
  }

  /** Stats windows echo what was asked, so an hourly request IS its window. */
  function echoStatsAdapter() {
    return windowAdapterStub({
      statsFor: (params) => statsBodyFor(
        { afterMs: params.afterDate.getTime(), beforeMs: params.beforeDate.getTime() },
        0,
      ),
    });
  }

  /**
   * Hourly windows served the way the route serves them: snapped to the hour
   * and ending `lag` hours before the request's hour, 25 buckets from
   * dateAfter to dateBefore INCLUSIVE. The lag is the provider's and moves
   * between 0 and 2 h from call to call (production 2026-09); each hourly
   * call takes the next of `lags`, then 1.
   */
  function hourGridStatsAdapter(lags: number[] = [], attemptsFor?: (name: string) => number) {
    const pending = [...lags];
    return windowAdapterStub({
      ...(attemptsFor === undefined ? {} : { attemptsFor }),
      statsFor: (params) => {
        if (params.periodMs !== HOUR) {
          return statsBodyFor(
            { afterMs: params.afterDate.getTime(), beforeMs: params.beforeDate.getTime() },
            0,
          );
        }
        const lag = pending.shift() ?? 1;
        const beforeMs = Math.floor(params.beforeDate.getTime() / HOUR) * HOUR - lag * HOUR;
        return statsBodyFor({ afterMs: beforeMs - 24 * HOUR, beforeMs }, 0);
      },
    });
  }

  /** A steady page whose last sweep completed on `lastSweepDay`; both broadcast
   *  lists are at their floor, so every sweep is its fixed twelve calls. */
  async function seedSteadyPage(lastSweepDay: string) {
    const page = await seedPage();
    const state = emptyFanslyStatsCursorState(NOW);
    state.mode = "steady";
    state.backfill = null;
    state.lastSweepDay = lastSweepDay;
    state.broadcastFloorReached = true;
    state.deletedBroadcastFloorReached = true;
    await upsertCheckpointProgress(testDb!.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: state.lastSweepDay,
      state: state as unknown as Record<string, unknown>,
    });
    return page;
  }

  /** One dispatch: chunks at the same instant until the lane settles, the way
   *  the executor chains a partial chunk's immediate continuation. */
  async function dispatchAt(
    app: unknown,
    pageId: number,
    telemetry: ReturnType<typeof telemetryStub>,
    instant: Date,
  ) {
    for (let chunk = 0; chunk < 8; chunk += 1) {
      const result = await fanslyStatsSnapshotChunk(
        app as never,
        input(pageId, telemetry, new SyncChunkBudget(), instant),
      );
      if (result.satisfied || result.continuationRetryAt != null) return result;
    }
    throw new Error(`dispatch at ${instant.toISOString()} did not settle`);
  }

  function hourlyCaptures(adapter: ReturnType<typeof windowAdapterStub>): string[] {
    return adapter.statsRequests
      .filter((request) => request.periodMs === HOUR)
      .map((request) => new Date(request.beforeMs).toISOString());
  }

  function gapHours(captures: string[]): number[] {
    return captures.slice(1).map((capture, index) =>
      (Date.parse(capture) - Date.parse(captures[index]!)) / HOUR);
  }

  it("keeps hourly captures within 23 h across an EARLY sweep, at no extra request", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // D = 2026-08-20. D−1 sweeps on its 05:01 slot, then the lane sits out
    // D−1's other slots — a pending cap deferral — and comes back at D 00:05,
    // where D's sweep runs early; every dispatch after that is an ordinary
    // slot. The sweep-bound capture took D+1's hourly at 05:01, 28.9 h after
    // D's: 3.9 hours no window ever reached.
    const page = await seedSteadyPage("2026-08-18");
    // The provider's end lag at its worst where the captures are furthest
    // apart: 2 h at D 00:05, then 0 h at D 23:01, 22.9 h later.
    const adapter = hourGridStatsAdapter([1, 2, 0, 2, 0]);
    const telemetry = telemetryStub();
    const app = appStub(adapter as never);
    for (const instant of [
      at("2026-08-19", "05:01"),
      at("2026-08-20", "00:05"),
      ...slotsOn("2026-08-20", "2026-08-21", "2026-08-22"),
    ]) {
      await dispatchAt(app, page.id, telemetry, instant);
    }

    const captures = hourlyCaptures(adapter);
    expect(Math.max(...gapHours(captures))).toBeLessThanOrEqual(23);
    // Caught up on D's last slot, then every third slot, 18 h apart — the
    // clock is the hourly plane's own, and the early sweep did not move it.
    expect(captures).toEqual([
      "2026-08-19T05:01:00.000Z",
      "2026-08-20T00:05:00.000Z",
      "2026-08-20T23:01:00.000Z",
      "2026-08-21T17:01:00.000Z",
      "2026-08-22T11:01:00.000Z",
    ]);
    // 22.9 h apart with the lag going 2 -> 0: the served windows still meet.
    expect(telemetry.anomalies.filter(
      (anomaly) => anomaly.code === "fansly_stats_hourly_capture_gap",
    )).toHaveLength(0);
    // The daily sweep did not move: one per UTC day, where it always ran.
    expect(adapter.statsRequests
      .filter((request) => request.periodMs === DAY)
      .map((request) => new Date(request.beforeMs).toISOString()))
      .toEqual([
        "2026-08-19T05:01:00.000Z",
        "2026-08-20T00:05:00.000Z",
        "2026-08-21T05:01:00.000Z",
        "2026-08-22T05:01:00.000Z",
      ]);
    expect(adapter.calls).toHaveLength(4 * 11 + captures.length);
  });

  it("captures hourly every 18 h on steady slots — within 23 h, one extra call in three days", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedSteadyPage("2026-08-18");
    // The end lag swinging its full 2 h on every call.
    const adapter = hourGridStatsAdapter([2, 0, 2, 0, 2, 0, 2, 0]);
    const telemetry = telemetryStub();
    const app = appStub(adapter as never);
    for (const instant of slotsOn(
      "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24",
    )) {
      await dispatchAt(app, page.id, telemetry, instant);
    }

    const captures = hourlyCaptures(adapter);
    // Every third 6-hourly slot: the next slot would be 24 h after the capture.
    expect(captures).toEqual([
      "2026-08-19T05:01:00.000Z",
      "2026-08-19T23:01:00.000Z",
      "2026-08-20T17:01:00.000Z",
      "2026-08-21T11:01:00.000Z",
      "2026-08-22T05:01:00.000Z",
      "2026-08-22T23:01:00.000Z",
      "2026-08-23T17:01:00.000Z",
      "2026-08-24T11:01:00.000Z",
    ]);
    expect(gapHours(captures)).toEqual([18, 18, 18, 18, 18, 18, 18]);
    const holes = await testDb.pool.query(
      `select scope_ref from capture_coverage
        where page_id = $1 and plane = 'stats_account_hourly' and scope_ref like 'gap:%'`,
      [page.id],
    );
    expect(holes.rows).toEqual([]);
    expect(telemetry.anomalies).toHaveLength(0);
    // Six sweeps of eleven calls, and eight hourly calls where a once-a-day
    // capture made six: +1 hourly call per page every three days.
    expect(adapter.calls).toHaveLength(6 * 11 + 8);
  });

  it("records the buckets between two captures an outage kept apart as a hole", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedSteadyPage("2026-08-18");
    const adapter = hourGridStatsAdapter();
    const telemetry = telemetryStub();
    const app = appStub(adapter as never);
    await dispatchAt(app, page.id, telemetry, at("2026-08-19", "05:01"));
    // An outage: nothing dispatches for a day and a half.
    await dispatchAt(app, page.id, telemetry, at("2026-08-21", "11:01"));

    expect(hourlyCaptures(adapter)).toEqual([
      "2026-08-19T05:01:00.000Z",
      "2026-08-21T11:01:00.000Z",
    ]);
    // Counted in SERVED buckets: the first window's newest is 08-19 04:00, the
    // second's oldest 08-20 10:00. The 29 buckets between them no window
    // carries, and the provider will never serve them hourly again.
    const holes = await testDb.pool.query(
      `select scope_ref, status, proof, reason_code, cursor, oldest_captured_at, newest_captured_at
         from capture_coverage
        where page_id = $1 and plane = 'stats_account_hourly' and scope_ref like 'gap:%'`,
      [page.id],
    );
    expect(holes.rows).toHaveLength(1);
    expect(holes.rows[0]).toMatchObject({
      scope_ref: "gap:2026-08-19T05:00:00.000Z/2026-08-20T10:00:00.000Z",
      status: "partial_provider_surface",
      proof: "none",
      reason_code: "hourly_capture_gap",
      // A hole is not a captured window: its bounds stay unclaimed.
      oldest_captured_at: null,
      newest_captured_at: null,
    });
    expect(holes.rows[0].cursor).toMatchObject({
      missingFrom: "2026-08-19T05:00:00.000Z",
      missingTo: "2026-08-20T10:00:00.000Z",
      missingHours: 29,
      basis: "served",
      previousCapturedAt: "2026-08-19T05:01:00.000Z",
      capturedAt: "2026-08-21T11:01:00.000Z",
    });
    const gaps = telemetry.anomalies.filter(
      (anomaly) => anomaly.code === "fansly_stats_hourly_capture_gap",
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.details).toMatchObject({
      missingFrom: "2026-08-19T05:00:00.000Z",
      missingTo: "2026-08-20T10:00:00.000Z",
    });
    // The steady row still describes the latest window, and only that.
    expect(await coverageRow(page.id, "stats_account_hourly", "steady")).toMatchObject({
      status: "window_captured",
    });
  });

  it("records a one-bucket hole the SERVED windows leave, and none where they meet", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Only the 05:01 slot reaches the lane — the other slots are missed — so
    // the captures are 24 h apart, past the 23 h the clock keeps on schedule,
    // and the requested windows always touch. The provider's lag goes 1, 0, 2,
    // 0 h. A window starting one hour after the last one's dateBefore has
    // missed nothing — that bucket was served — but after 2 -> 0 the 08-21
    // 04:00 bucket is in neither window (production, lilly-1 2026-09-21 -> 22,
    // 24.8 h apart: the 01:00 bucket).
    const page = await seedSteadyPage("2026-08-18");
    const adapter = hourGridStatsAdapter([1, 0, 2, 0]);
    const telemetry = telemetryStub();
    const app = appStub(adapter as never);
    for (const day of ["2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22"]) {
      await dispatchAt(app, page.id, telemetry, at(day, "05:01"));
    }

    expect(gapHours(hourlyCaptures(adapter))).toEqual([24, 24, 24]);
    const holes = await testDb.pool.query(
      `select scope_ref, cursor from capture_coverage
        where page_id = $1 and plane = 'stats_account_hourly' and scope_ref like 'gap:%'`,
      [page.id],
    );
    expect(holes.rows.map((row) => row.scope_ref)).toEqual([
      "gap:2026-08-21T04:00:00.000Z/2026-08-21T05:00:00.000Z",
    ]);
    expect(holes.rows[0].cursor).toMatchObject({ missingHours: 1, basis: "served" });
    expect(telemetry.anomalies.filter(
      (anomaly) => anomaly.code === "fansly_stats_hourly_capture_gap",
    )).toHaveLength(1);
    expect((await cursor(page.id))!.lastHourlyServedBefore).toBe("2026-08-22T05:00:00.000Z");
  });

  it("keeps a call of the cap for the hourly window when the sweep defers the lane", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // The last capture sits on the day's LAST slot, 23:01 — every fourth day
    // on 18 h spacing. The next day's sweep spends the cap and defers the lane
    // to 00:05; no slot dispatches it in between. Asked only about the next
    // slot (11:01), the 05:01 dispatch skipped the window and the next capture
    // came 25 h 04 min after the last. Capturing up front whenever a sweep
    // MIGHT defer would take the window every day's first chunk; the sweep
    // instead leaves the cap's last call for it and takes it when it defers.
    const page = await seedSteadyPage("2026-08-19");
    const seeded = (await cursor(page.id))!;
    seeded.lastHourlyCapturedAt = "2026-08-19T23:01:00.000Z";
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: seeded.lastSweepDay,
      state: seeded as unknown as Record<string, unknown>,
    });
    await capDayAt(3);
    const adapter = hourGridStatsAdapter();
    const telemetry = telemetryStub();
    const app = appStub(adapter as never);

    const deferredResult = await dispatchAt(app, page.id, telemetry, at("2026-08-20", "05:01"));
    expect(deferredResult.continuationRetryAt?.toISOString()).toBe("2026-08-21T00:05:00.000Z");
    expect(deferredResult.stats).toMatchObject({ deferred: "daily_call_budget", hourly: "captured" });
    // The sweep went first and stopped one call short of the cap; that call
    // was the hourly window, as the lane deferred.
    expect(adapter.calls).toEqual(["account_stats", "earnings_stats", "account_stats"]);
    expect(adapter.statsRequests.map((request) => request.periodMs)).toEqual([DAY, HOUR]);
    expect((await cursor(page.id))!.callsToday).toBe(3);
    await dispatchAt(app, page.id, telemetry, at("2026-08-21", "00:05"));

    const captures = ["2026-08-19T23:01:00.000Z", ...hourlyCaptures(adapter)];
    expect(captures).toEqual([
      "2026-08-19T23:01:00.000Z",
      "2026-08-20T05:01:00.000Z",
      "2026-08-21T00:05:00.000Z",
    ]);
    expect(Math.max(...gapHours(captures))).toBeLessThanOrEqual(23);
  });

  it("does not hold a call back from a sweep that finishes within the cap", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // The same page, but the day's cap fits the sweep's eleven calls and the
    // held one: that call is never spent, and the hourly window waits for its
    // own slot, 17:01, 18 h after the last capture.
    const page = await seedSteadyPage("2026-08-19");
    const seeded = (await cursor(page.id))!;
    seeded.lastHourlyCapturedAt = "2026-08-19T23:01:00.000Z";
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: seeded.lastSweepDay,
      state: seeded as unknown as Record<string, unknown>,
    });
    await capDayAt(12);
    const adapter = hourGridStatsAdapter();
    const telemetry = telemetryStub();
    const app = appStub(adapter as never);

    const result = await dispatchAt(app, page.id, telemetry, at("2026-08-20", "05:01"));
    expect(result.satisfied).toBe(true);
    expect(result.stats).toMatchObject({ mode: "steady", hourly: "not_due" });
    expect(hourlyCaptures(adapter)).toEqual([]);
    expect(adapter.calls).toHaveLength(11);
  });

  it("keeps the held call out of a sweep request's retries", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // The same 23:01 capture and 05:01 sweep, but the earnings request's first
    // attempt fails on the wire. Two attempts were left, one of them held, and
    // the adapter was allowed both: the retry spent the held call, the lane
    // deferred to 00:05 without the window, and the next capture came 25 h
    // 04 min after the last — two buckets lost as the lag went 2 h -> 0 h.
    const page = await seedSteadyPage("2026-08-19");
    const seeded = (await cursor(page.id))!;
    seeded.lastHourlyCapturedAt = "2026-08-19T23:01:00.000Z";
    seeded.lastHourlyServedBefore = "2026-08-19T21:00:00.000Z";
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: seeded.lastSweepDay,
      state: seeded as unknown as Record<string, unknown>,
    });
    await capDayAt(3);
    let earningsRequests = 0;
    const adapter = hourGridStatsAdapter(
      [0, 0],
      (name) => name === "earnings_stats" && (earningsRequests += 1) === 1 ? 2 : 1,
    );
    const telemetry = telemetryStub();
    const app = appStub(adapter as never);

    // The request's allowance leaves the held call out: one attempt, and the
    // request fails the chunk the way any exhausted retry does.
    await expect(dispatchAt(app, page.id, telemetry, at("2026-08-20", "05:01")))
      .rejects.toThrow("retry allowance exhausted");
    expect(adapter.calls).toEqual(["account_stats", "earnings_stats"]);
    expect((await cursor(page.id))!.callsToday).toBe(2);

    // The executor's retry finds the held call still there and spends it on
    // the window before the lane sleeps until 00:05.
    const deferredResult = await dispatchAt(app, page.id, telemetry, at("2026-08-20", "05:06"));
    expect(deferredResult.continuationRetryAt?.toISOString()).toBe("2026-08-21T00:05:00.000Z");
    expect(deferredResult.stats).toMatchObject({ deferred: "daily_call_budget", hourly: "captured" });
    expect((await cursor(page.id))!.callsToday).toBe(3);
    await dispatchAt(app, page.id, telemetry, at("2026-08-21", "00:05"));

    const captures = ["2026-08-19T23:01:00.000Z", ...hourlyCaptures(adapter)];
    expect(captures).toEqual([
      "2026-08-19T23:01:00.000Z",
      "2026-08-20T05:06:00.000Z",
      "2026-08-21T00:05:00.000Z",
    ]);
    expect(Math.max(...gapHours(captures))).toBeLessThanOrEqual(23);
    expect(telemetry.anomalies.filter(
      (anomaly) => anomaly.code === "fansly_stats_hourly_capture_gap",
    )).toHaveLength(0);
  });

  it("makes no hourly request at all while fanslyStatsHourlyEnabled is off", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedSteadyPage("2026-08-18");
    const adapter = echoStatsAdapter();
    const telemetry = telemetryStub();
    const app = dailyOnlyAppStub(adapter);
    for (const instant of [
      ...slotsOn("2026-08-19"),
      at("2026-08-20", "00:05"),
      ...slotsOn("2026-08-20", "2026-08-21"),
    ]) {
      await dispatchAt(app, page.id, telemetry, instant);
    }

    expect(hourlyCaptures(adapter)).toEqual([]);
    expect(adapter.calls).toHaveLength(3 * 11);
    const hourlyRows = await testDb.pool.query(
      "select scope_ref from capture_coverage where page_id = $1 and plane = 'stats_account_hourly'",
      [page.id],
    );
    expect(hourlyRows.rows).toEqual([]);
    expect((await cursor(page.id))!.lastHourlyCapturedAt).toBeNull();
  });

  it("captures hourly BEFORE a history walk defers the lane past 23 h", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // PRODUCTION 2026-09-28 23:02: reopened history walks spent the day's cap
    // and deferred to 00:05. While a deferral is pending no slot dispatches the
    // lane, so the next chance at the hourly window is 00:05 — here 31 h after
    // the last capture, even though the next SLOT would have been in time.
    const page = await seedPage();
    const dispatch = at("2026-08-20", "05:01");
    const state = emptyFanslyStatsCursorState(dispatch);
    state.lastSweepDay = "2026-08-20";
    state.backfill!.hourly.done = true;
    state.lastHourlyCapturedAt = "2026-08-19T17:01:00.000Z";
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: state.lastSweepDay,
      state: state as unknown as Record<string, unknown>,
    });
    await capDayAt(3);
    const adapter = echoStatsAdapter();
    const telemetry = telemetryStub();

    const result = await fanslyStatsSnapshotChunk(
      appStub(adapter as never),
      input(page.id, telemetry, new SyncChunkBudget(), dispatch),
    );

    expect(result.continuationRetryAt?.toISOString()).toBe("2026-08-21T00:05:00.000Z");
    expect(hourlyCaptures(adapter)).toEqual(["2026-08-20T05:01:00.000Z"]);
    // First, before the walk spent the rest of the day's cap.
    expect(adapter.statsRequests[0]!.periodMs).toBe(HOUR);
    expect((await cursor(page.id))!.lastHourlyCapturedAt).toBe("2026-08-20T05:01:00.000Z");
  });

  it("takes the hourly window once, not on every chunk, as a walk resumes at 00:05", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // A walk that deferred yesterday resumes at 00:05 and chains continuations
    // seconds apart until the cap. Asked against the next 00:05, the window is
    // 24 h out even right after it was taken — it must not be taken again.
    const page = await seedPage();
    const resume = at("2026-08-20", "00:05");
    const state = emptyFanslyStatsCursorState(resume);
    state.lastSweepDay = "2026-08-20";
    state.backfill!.hourly.done = true;
    state.lastHourlyCapturedAt = "2026-08-19T05:01:00.000Z";
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: state.lastSweepDay,
      state: state as unknown as Record<string, unknown>,
    });
    await capDayAt(5);
    const adapter = echoStatsAdapter();
    const telemetry = telemetryStub();
    const app = appStub(adapter as never);

    let deferredTo: Date | null | undefined = null;
    for (let chunk = 0; chunk < 10 && deferredTo == null; chunk += 1) {
      const result = await fanslyStatsSnapshotChunk(app, input(
        page.id, telemetry, new SyncChunkBudget(1), new Date(resume.getTime() + chunk * 20_000),
      ));
      if (result.stats?.deferred === "daily_call_budget") deferredTo = result.continuationRetryAt;
    }

    expect(deferredTo?.toISOString()).toBe("2026-08-21T00:05:00.000Z");
    expect(hourlyCaptures(adapter)).toEqual(["2026-08-20T00:05:00.000Z"]);
    expect(adapter.calls).toHaveLength(5);
  });

  it("defers to the UTC roll when the hourly window is due and the day's cap is spent", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // The sweep is done for the day and spent the whole cap (retries, or a
    // live cap cut). Completing "sweep_not_due" would leave the window to the
    // first slot after midnight; the lane defers the way the sweep does.
    const page = await seedPage();
    const dispatch = at("2026-08-20", "23:01");
    const state = emptyFanslyStatsCursorState(dispatch);
    state.mode = "steady";
    state.backfill = null;
    state.lastSweepDay = "2026-08-20";
    state.callsToday = 25;
    state.lastHourlyCapturedAt = "2026-08-19T23:01:00.000Z";
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: state.lastSweepDay,
      state: state as unknown as Record<string, unknown>,
    });
    const adapter = echoStatsAdapter();
    const telemetry = telemetryStub();
    const app = appStub(adapter as never);

    const deferredResult = await fanslyStatsSnapshotChunk(
      app,
      input(page.id, telemetry, new SyncChunkBudget(), dispatch),
    );
    expect(deferredResult.satisfied).toBe(false);
    expect(deferredResult.continuationRetryAt?.toISOString()).toBe("2026-08-21T00:05:00.000Z");
    expect(deferredResult.stats).toMatchObject({ deferred: "daily_call_budget", hourly: "deferred" });
    expect(adapter.calls).toEqual([]);

    await fanslyStatsSnapshotChunk(
      app,
      input(page.id, telemetry, new SyncChunkBudget(), at("2026-08-21", "00:05")),
    );
    expect(hourlyCaptures(adapter)).toEqual(["2026-08-21T00:05:00.000Z"]);
  });

  it("yields at once, never completes, when the chunk's own budget leaves the window due", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Today's sweep is done, there is no history walk and the cap has room,
    // but loading the config, context and checkpoint spent the chunk's 45 s
    // (or its requests). The window due at 23:01 was deferred and the chunk
    // completed as `sweep_not_due`: the next chance was the 05:01 slot, 24 h
    // after the last capture — one bucket lost as the lag went 2 h -> 0 h.
    const page = await seedSteadyPage("2026-08-20");
    const seeded = (await cursor(page.id))!;
    seeded.lastHourlyCapturedAt = "2026-08-20T05:01:00.000Z";
    seeded.lastHourlyServedBefore = "2026-08-20T03:00:00.000Z";
    await upsertCheckpointProgress(testDb.db, {
      platformAccountId: page.id,
      stream: "stats_snapshot",
      cursorText: seeded.lastSweepDay,
      state: seeded as unknown as Record<string, unknown>,
    });
    const adapter = hourGridStatsAdapter([0]);
    const telemetry = telemetryStub();
    const app = appStub(adapter as never);
    const dispatch = at("2026-08-20", "23:01");

    for (
      const [budget, yieldReason] of [
        [new SyncChunkBudget(5, 0), "wall_clock"],
        [new SyncChunkBudget(0), "request_budget"],
      ] as const
    ) {
      const result = await fanslyStatsSnapshotChunk(app, input(page.id, telemetry, budget, dispatch));
      expect(result).toMatchObject({ satisfied: false, yieldReason });
      // No wake-up time: the executor chains the next chunk at once.
      expect(result.continuationRetryAt ?? null).toBeNull();
      expect(result.stats).toMatchObject({ deferred: null, hourly: "deferred" });
    }
    expect(adapter.calls).toEqual([]);

    const continued = await dispatchAt(app, page.id, telemetry, dispatch);
    expect(continued).toMatchObject({ satisfied: true });
    expect(continued.stats).toMatchObject({ skipped: "sweep_not_due", hourly: "captured" });
    const captures = ["2026-08-20T05:01:00.000Z", ...hourlyCaptures(adapter)];
    expect(gapHours(captures)).toEqual([18]);
  });

  it("derives a legacy cursor's last hourly capture from its steady coverage row", async (
    context,
  ) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // A cursor written before the field existed. The steady row is written by
    // the capture itself, so its write time IS that capture's: deploying this
    // must not re-capture every page at once, nor wait past the window.
    const page = await seedSteadyPage("2026-08-20");
    await upsertCaptureCoverage(testDb.db, {
      pageId: page.id, platform: "fansly", plane: "stats_account_hourly", scopeRef: "steady",
      status: "window_captured", acquisitionMode: "retroactive", proof: "none",
      replaceWindowBounds: true,
      oldestCapturedAt: new Date("2026-08-19T05:00:00.000Z"),
      newestCapturedAt: new Date("2026-08-20T05:00:00.000Z"),
    });
    await testDb.pool.query(
      `update capture_coverage set updated_at = '2026-08-20T05:01:40.000Z'
        where page_id = $1 and plane = 'stats_account_hourly' and scope_ref = 'steady'`,
      [page.id],
    );
    const adapter = echoStatsAdapter();
    const telemetry = telemetryStub();
    const app = appStub(adapter as never);

    await dispatchAt(app, page.id, telemetry, at("2026-08-20", "11:01"));
    expect(hourlyCaptures(adapter)).toEqual([]);
    expect((await cursor(page.id))!.lastHourlyCapturedAt).toBe("2026-08-20T05:01:40.000Z");
    // …and the newest bucket that capture was served, for the next hole check.
    expect((await cursor(page.id))!.lastHourlyServedBefore).toBe("2026-08-20T05:00:00.000Z");

    await dispatchAt(app, page.id, telemetry, at("2026-08-21", "05:01"));
    expect(hourlyCaptures(adapter)).toEqual(["2026-08-21T05:01:00.000Z"]);
  });
});
