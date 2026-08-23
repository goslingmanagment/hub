// WP-F1 — the per-lane daily call budget, against a real database.
//
// After A28-4 this cap is the WHOLE request-count enforcement in the design:
// the per-egress-key counter, `sync_rate_limit_days`, the 2×-of-trailing-norm
// ops signal and the boot/PATCH limiter invariants were all deleted, and [A19]
// had already removed the global per-page cap. So what this file holds is
// small and load-bearing:
//
//  - the cap is counted in HTTP ATTEMPTS, retries included;
//  - crossing it DEFERS the lane to the next UTC day and NEVER drops — a lane
//    crossed mid-chunk still journals the response it already fetched;
//  - the counter survives the checkpoint round-trip, which is why this is an
//    integration test and not a mocked one: a cap that resets on every lease
//    is not a cap;
//  - the UTC roll resets it, and resets nothing else;
//  - and the negative pins, which are the ones that keep a deleted mechanism
//    deleted.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import {
  createFanslyPage,
  createModel,
  getCheckpoint,
  setConfigOverride,
  startSyncRun,
  upsertCaptureCoverage,
  upsertCheckpointProgress,
} from "@agency_hub_core/db";
import { CONFIG_DESCRIPTORS } from "@agency_hub_core/shared";

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
function adapterStub(options: { attemptsPerCall?: number } = {}) {
  const attemptsPerCall = options.attemptsPerCall ?? 1;
  const calls: string[] = [];
  const answer = async (
    name: string,
    context: { requestObserver?: { onRequestEvent: (event: unknown) => Promise<void> } | null },
    body: unknown,
  ) => {
    calls.push(name);
    for (let attempt = 0; attempt < attemptsPerCall; attempt += 1) {
      await context.requestObserver?.onRequestEvent({
        requestId: `${name}:${calls.length}:${attempt}`,
        state: "started",
        operation: name,
        endpointTemplate: `/${name}`,
        method: "GET",
        attemptNumber: attempt + 1,
      });
    }
    return { items: body, raw: body };
  };
  return {
    calls,
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

function telemetryStub() {
  const anomalies: Array<Record<string, unknown>> = [];
  return {
    anomalies,
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    addAnomaly: vi.fn(async (input: Record<string, unknown>) => {
      anomalies.push(input);
    }),
    getRequestObserver: vi.fn(() => null),
  };
}

function appStub(adapter: ReturnType<typeof adapterStub>) {
  return {
    db: testDb!.db,
    adapter,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    config: {
      fanslyStatsSnapshotSyncEnabled: true,
      fanslyStatsSnapshotPageAllowlist: "stats-budget",
      fanslyStatsSnapshotDailyCallBudget: 25,
      fanslyStatsHourlyEnabled: true,
      fanslyStatsHourlyBackfillMaxDays: 30,
      fanslyBackfillContinuationDelayMs: 20_000,
    },
  } as never;
}

let syncRunId = 0;

async function seedPage() {
  const model = await createModel(testDb!.db, { slug: "budget", name: "Budget" });
  if (!model) throw new Error("Expected the budget test model to be created");
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label: "stats-budget" });
  if (!page) throw new Error("Expected the budget test page to be created");
  await testDb!.pool.query("update pages set external_page_id = $1 where id = $2", [
    "acct-budget",
    page.id,
  ]);
  // `sync_raw_payloads.sync_run_id` is a real FK: the journal is attributed to
  // the run that fetched it, and a capture with no run is not a capture.
  const run = await startSyncRun(testDb!.db, {
    platformAccountId: page.id,
    stream: "stats_snapshot",
    trigger: "scheduled",
  });
  if (!run) throw new Error("Expected the budget test sync run to be created");
  syncRunId = run.id;
  return page;
}

function input(
  pageId: number,
  telemetry: ReturnType<typeof telemetryStub>,
  budget = new SyncChunkBudget(),
  now = NOW,
) {
  return {
    budget,
    pageContext: {
      platform: "fansly",
      page: { id: pageId, label: "stats-budget", platformAccountId: "acct-budget", metadata: {} },
      session: { authorization: "token" },
      proxy: { url: "socks5://proxy.example:1080" },
      egressKey: "fansly:budget",
    },
    telemetry,
    streamState: { requestSeq: 1 },
    syncRunId,
    now,
  } as never;
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
    earningsFor?: (params: { before: Date; after: Date }) => unknown;
  }) {
    const calls: string[] = [];
    const statsRequests: Array<
      { afterMs: number; beforeMs: number; periodMs: number; year: number; month: number }
    > = [];
    const earningsRequests: Array<{ afterMs: number; beforeMs: number }> = [];
    const answer = async (
      name: string,
      context: { requestObserver?: { onRequestEvent: (event: unknown) => Promise<void> } | null },
      body: unknown,
    ) => {
      calls.push(name);
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
        params: { before: Date; after: Date },
      ) => {
        earningsRequests.push({
          afterMs: params.after.getTime(),
          beforeMs: params.before.getTime(),
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

  async function coverageRow(pageId: number, plane: string) {
    const result = await testDb!.pool.query(
      `select status, proof, proof_observation_id, reason_code, acquisition_mode, cursor
         from capture_coverage where page_id = $1 and plane = $2`,
      [pageId, plane],
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
  ) {
    for (let chunk = 0; chunk < maxChunks; chunk += 1) {
      await fanslyStatsSnapshotChunk(
        app as never,
        input(pageId, telemetry, new SyncChunkBudget()),
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
    const page = await seedPage();
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
    const page = await seedPage();
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

  it("resumes at the BOOKMARK when the [E10] probe finds older history", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
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
  });

  it("refuses to ask for the same MONTH twice, before any egress", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // A cursor that has ALREADY asked for exactly the month it is about to ask
    // for — a derivation that came back where it started, or corrupted state.
    // The guard is durable because the production loop spanned five chunks.
    const seeded = emptyFanslyStatsCursorState(NOW);
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
    const page = await seedPage();
    // EXACTLY THE TWO PAGES ON PRODUCTION (lilly-2, lora-2): the guard stopped
    // the daily lane with `window_not_honoured`, all three walks were marked
    // done, and the cursor settled into the steady sweep. The claim was correct
    // about the walk it stopped and wrong about the surface: history is served
    // by month, and this lane never asked.
    const stoppedCursor = emptyFanslyStatsCursorState(NOW);
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
    const page = await seedPage();
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
  it("guards the earnings lane on the rows, since that route describes no window", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
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
    // Three empty stats windows to the floor, then the three the earnings walk
    // is allowed: ask, halve, give up.
    await capDayAt(6);

    await driveChunks(
      dailyOnlyAppStub(adapter),
      page.id,
      telemetry,
      (current) => current.backfill === null || current.backfill.earnings.done,
    );

    expect(adapter.earningsRequests).toHaveLength(3);
    expect(adapter.earningsRequests.map((request) => [request.afterMs, request.beforeMs])).toEqual([
      [NOW.getTime() - 31 * DAY, NOW.getTime()],
      [NOW.getTime() - 62 * DAY, NOW.getTime() - 31 * DAY],
      [NOW.getTime() - 46 * DAY, NOW.getTime() - 31 * DAY],
    ]);
    expect(new Set(
      adapter.earningsRequests.map((request) => `${request.afterMs}:${request.beforeMs}`),
    ).size).toBe(3);

    const row = await coverageRow(page.id, "stats_earnings");
    expect(row?.status).toBe("partial_provider_surface");
    expect(row?.proof).toBe("terminal_response");
    expect(row?.reason_code).toBe("window_not_honoured");
    // The halve-and-retry is on the record too: the span it gave up at.
    expect(row?.cursor.spanDays).toBe(15);
    expect(telemetry.anomalies.filter(
      (anomaly) => anomaly.code === "fansly_stats_window_not_honoured"
        && (anomaly.details as { plane?: string } | undefined)?.plane === "stats_earnings",
    )).toHaveLength(1);
  });

  // THE NEGATIVE PINS. Each names a mechanism that was DELETED by decision, and
  // a key reappearing is how a deleted mechanism comes back without one.
  it("holds the A19/A20/A28-4 removals", async () => {
    const keys = new Set(CONFIG_DESCRIPTORS.map((descriptor) => descriptor.key));
    // [A19]: no global per-page daily request cap.
    expect(keys.has("fanslyPageDailyRequestCap")).toBe(false);
    // [A20]: no byte ceiling, and therefore no byte-budget deferral anywhere.
    expect(keys.has("fanslyUntrimmedCaptureByteCeilingPerDay")).toBe(false);
    // A28-4: the §3.5 per-egress-key DAY counter and the 2×-of-norm ops signal
    // were deleted. `syncSharedRateLimitEnabled` is a PRE-EXISTING key and is
    // deliberately not pinned away — what A28-4 removed is the day-counter key
    // and the boot/PATCH invariants that would have been added beside it.
    expect(keys.has("fanslyEgressKeyDailyRequestCap")).toBe(false);
    expect(keys.has("syncRateLimitDaysRetentionDays")).toBe(false);
  });
});
