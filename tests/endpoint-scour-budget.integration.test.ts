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
} from "@agency_hub_core/db";
import { CONFIG_DESCRIPTORS } from "@agency_hub_core/shared";

import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import {
  backfillContinuationAt,
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
    // …and there is still work left, which is what makes the deferral real.
    expect(state!.mode === "backfill" || state!.stepIndex > 0).toBe(true);

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
    statsFor: (params: { beforeDate: Date; afterDate: Date; periodMs: number }) => unknown;
    earningsFor?: (params: { before: Date; after: Date }) => unknown;
  }) {
    const calls: string[] = [];
    const statsRequests: Array<{ afterMs: number; beforeMs: number; periodMs: number }> = [];
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
        params: { beforeDate: Date; afterDate: Date; periodMs: number },
      ) => {
        statsRequests.push({
          afterMs: params.afterDate.getTime(),
          beforeMs: params.beforeDate.getTime(),
          periodMs: params.periodMs,
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

  it("stops the daily walk when the provider ignores the window — never loops", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // THE PRODUCTION PROVIDER: whatever you ask for, you get the default
    // trailing 31 days, 200 OK, with data in it.
    const defaultTrailing = { afterMs: NOW.getTime() - 31 * DAY, beforeMs: NOW.getTime() };
    const adapter = windowAdapterStub({ statsFor: () => statsBodyFor(defaultTrailing, 28) });
    const telemetry = telemetryStub();
    // Three, the number the fixed walk is allowed to spend. On prod this lane
    // spent twenty-five and asked for the same window in twenty-four of them.
    await capDayAt(3);

    const state = await driveChunks(
      dailyOnlyAppStub(adapter),
      page.id,
      telemetry,
      (current) => current.backfill !== null && current.backfill.daily.done,
    );

    const daily = adapter.statsRequests.filter((request) => request.periodMs === 86_400_000);
    // THREE requests, and the third is the last: ask, halve, give up. The
    // production sequence spent twenty-five.
    expect(daily).toHaveLength(3);
    expect(daily.map((request) => [request.afterMs, request.beforeMs])).toEqual([
      // 1 — the trailing window, which the provider's default happens to match.
      [NOW.getTime() - 31 * DAY, NOW.getTime()],
      // 2 — the first HISTORICAL window, answered with the trailing one again.
      [NOW.getTime() - 61 * DAY, NOW.getTime() - 30 * DAY],
      // 3 — the same upper bound at half the span: the one retry.
      [NOW.getTime() - 45 * DAY, NOW.getTime() - 30 * DAY],
    ]);
    // NEVER THE SAME WINDOW TWICE, which is the loop stated as an invariant.
    expect(new Set(daily.map((request) => `${request.afterMs}:${request.beforeMs}`)).size)
      .toBe(daily.length);

    expect(state!.backfill!.daily.done).toBe(true);
    expect(state!.backfill!.daily.guard.spanDays).toBe(15);
    expect(state!.backfill!.daily.guard.narrowed).toBe(true);

    // The claim is written down, with the response that proves it.
    const row = await coverageRow(page.id, "stats_account_daily");
    expect(row?.status).toBe("partial_provider_surface");
    expect(row?.proof).toBe("terminal_response");
    expect(row?.reason_code).toBe("window_not_honoured");
    expect(row?.acquisition_mode).toBe("retroactive");
    expect(row?.proof_observation_id).not.toBeNull();

    // ONE anomaly for the plane — a loop that shouted once per iteration would
    // be its own kind of incident.
    const raised = telemetry.anomalies.filter(
      (anomaly) => anomaly.code === "fansly_stats_window_not_honoured"
        && (anomaly.details as { plane?: string } | undefined)?.plane === "stats_account_daily",
    );
    expect(raised).toHaveLength(1);
    expect((raised[0]!.details as { trigger?: string }).trigger).toBe("served_window");
  });

  it("walks backwards contiguously to the floor when windows ARE honoured", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // A provider that answers what it was asked, snapping to its bucket grid,
    // and has a hundred days of history. This is the walk the guard must not
    // have broken.
    const floorMs = NOW.getTime() - 100 * DAY;
    const adapter = windowAdapterStub({
      statsFor: (params) => {
        const window = { afterMs: params.afterDate.getTime(), beforeMs: params.beforeDate.getTime() };
        const covered = Math.min(window.beforeMs, NOW.getTime()) - Math.max(window.afterMs, floorMs);
        return statsBodyFor(window, covered > 0 ? Math.ceil(covered / DAY) : 0);
      },
    });
    const telemetry = telemetryStub();
    // Four windows of history, two empties, one [E10] probe: seven requests to
    // walk a hundred days and prove the floor.
    await capDayAt(7);

    const state = await driveChunks(
      dailyOnlyAppStub(adapter),
      page.id,
      telemetry,
      (current) => current.backfill !== null && current.backfill.daily.done,
    );

    const daily = adapter.statsRequests.filter((request) => request.periodMs === 86_400_000);
    // Every window is 31 days — the span the provider was shown to honour —
    // and never narrower, because nothing was ever refused.
    for (const request of daily) {
      expect(request.beforeMs - request.afterMs).toBe(31 * DAY);
    }
    // CONTIGUOUS, with the one-day overlap: adjacent windows must touch, and
    // the union must have no hole between the newest bound and the floor.
    const ordinary = daily.filter((request) => request.beforeMs >= floorMs - 31 * DAY);
    for (let index = 1; index < ordinary.length; index += 1) {
      expect(windowsAreContiguous(
        { afterMs: ordinary[index]!.afterMs, beforeMs: ordinary[index]!.beforeMs },
        { afterMs: ordinary[index - 1]!.afterMs, beforeMs: ordinary[index - 1]!.beforeMs },
      )).toBe(true);
      expect(ordinary[index - 1]!.afterMs - ordinary[index]!.beforeMs).toBe(-DAY);
    }
    expect(ordinary[0]!.beforeMs).toBe(NOW.getTime());
    expect(ordinary[ordinary.length - 1]!.afterMs).toBeLessThanOrEqual(floorMs);

    // It reached the floor the way the design says: empty windows, then ONE
    // probe a year further back ([E10]), then a floor claim — not a refusal.
    expect(state!.backfill!.daily.done).toBe(true);
    expect(state!.backfill!.daily.probeSpent).toBe(true);
    // The floor is what the PROVIDER described, not what we know the fixture
    // holds: this one echoes the bounds it was asked for (as the HAR's honoured
    // window did), so the floor claim is the oldest bound it ever answered with.
    expect(state!.backfill!.daily.floorAt)
      .toBe(new Date(NOW.getTime() - 121 * DAY).toISOString());
    expect(new Date(state!.backfill!.daily.floorAt!).getTime()).toBeLessThan(floorMs);
    const row = await coverageRow(page.id, "stats_account_daily");
    expect(row?.status).toBe("provider_exhausted");
    expect(row?.proof).toBe("empty_window");
    expect(row?.reason_code).toBe("empty_window_streak");
    expect(telemetry.anomalies.filter(
      (anomaly) => anomaly.code === "fansly_stats_window_not_honoured",
    )).toHaveLength(0);
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
