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
