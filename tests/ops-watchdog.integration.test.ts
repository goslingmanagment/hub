import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  getLatestOpsMetricSampleAt,
  getNotificationDeliveryOutboxByIncident,
  getNotificationIncidentByKey,
  getTelegramSettings,
  insertOpsMetricSamples,
} from "@agency_hub_core/db";

import {
  runNotificationDeliveryOutbox,
  type NotificationOutboxDelivery,
} from "../apps/runtime/src/services/notification-delivery-outbox.ts";
import {
  runNotificationPagingSweep,
  runNotificationPagingSweepExclusive,
} from "../apps/runtime/src/services/notification-paging-sweep.ts";
import {
  OPS_WATCHDOG_SILENCE_MS,
  opsWatchdogNeedsDeliveryFallback,
  runOpsWatchdogCheck,
  runOpsWatchdogDeliveryFallback,
  startOpsWatchdog,
} from "../apps/runtime/src/services/ops-watchdog.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// W5.2 (A53): the api-side deadman for the scheduler heartbeat and the
// golden-signal sampler — the two silences that used to be invisible.

let harness: StartedTestDatabase;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) {
    throw new Error("Docker-backed Postgres is required for this integration test");
  }
  harness = started;
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

function appStub() {
  return {
    db: harness.db,
    config: { telegramEnabled: false },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

/** A startedAtMs far enough in the past that the boot grace has elapsed. */
const PAST_BOOT_GRACE = () => Date.now() - 10 * 60_000;

async function openIncidents(): Promise<string[]> {
  // kind is an enum: order by its TEXT so assertions are alphabetical.
  const rows = await harness.pool.query(
    "select kind from notification_incidents where kind in ('scheduler_silent','ops_sampler_silent') and status = 'open' order by kind::text",
  );
  return rows.rows.map((row: { kind: string }) => row.kind);
}

describe("ops watchdog (W5.2 / A53)", () => {
  it("opens nothing inside the boot grace window (deploy-restart guard)", async () => {
    const result = await runOpsWatchdogCheck(appStub(), { startedAtMs: Date.now() });
    expect(result).toEqual({ bootGrace: true, schedulerFresh: false, samplerFresh: false, syncStalled: false, syncEngineSilent: false });
    expect(await openIncidents()).toEqual([]);
  });

  it("opens both silences on an empty database, resolves each on recovery", async () => {
    const first = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(first).toEqual({ bootGrace: false, schedulerFresh: false, samplerFresh: false, syncStalled: false, syncEngineSilent: false });
    expect(await openIncidents()).toEqual(["ops_sampler_silent", "scheduler_silent"]);

    // Scheduler heartbeat lands → scheduler_silent resolves, sampler stays.
    await harness.pool.query(`
      insert into runtime_instances (role, instance_id, started_at, last_seen_at, running)
      values ('scheduler', 'wd-test-1', now(), now(), '{}'::jsonb)
      on conflict (role, instance_id) do update set last_seen_at = excluded.last_seen_at
    `);
    const second = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(second).toMatchObject({ schedulerFresh: true, samplerFresh: false });
    expect(await openIncidents()).toEqual(["ops_sampler_silent"]);

    // A fresh sample lands → sampler resolves too.
    await insertOpsMetricSamples(harness.db, [{ metric: "capture", quantile: "p95", valueMs: 1 }]);
    const third = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(third).toMatchObject({ schedulerFresh: true, samplerFresh: true });
    expect(await openIncidents()).toEqual([]);
  });

  it("a STALE heartbeat (wedged-but-alive scheduler) is silence, not health", async () => {
    // Upsert (not update) so this test owns its fixture regardless of order.
    await harness.pool.query(
      `insert into runtime_instances (role, instance_id, started_at, last_seen_at, running)
       values ('scheduler', 'wd-test-1', now(), now() - ($1::bigint || ' milliseconds')::interval, '{}'::jsonb)
       on conflict (role, instance_id) do update set last_seen_at = excluded.last_seen_at`,
      [OPS_WATCHDOG_SILENCE_MS + 60_000],
    );
    // Keep the sampler fresh so only the scheduler leg flips.
    await insertOpsMetricSamples(harness.db, [{ metric: "capture", quantile: "p95", valueMs: 1 }]);
    const result = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(result.schedulerFresh).toBe(false);
    expect(result.samplerFresh).toBe(true);
    expect(await openIncidents()).toEqual(["scheduler_silent"]);

    // Heartbeat recovers → resolves.
    await harness.pool.query(
      "update runtime_instances set last_seen_at = now() where role = 'scheduler'",
    );
    const recovered = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(recovered.schedulerFresh).toBe(true);
    expect(await openIncidents()).toEqual([]);
  });

  it("an hourly disk_* gauge is never sampler liveness", async () => {
    // The disk check writes capacity gauges into the same table once an HOUR.
    // If the deadman counted them, a dead minutely sampler would look alive
    // for an hour after each disk row and ops_sampler_silent would flap.
    await harness.pool.query(
      `insert into runtime_instances (role, instance_id, started_at, last_seen_at, running)
       values ('scheduler', 'wd-test-1', now(), now(), '{}'::jsonb)
       on conflict (role, instance_id) do update set last_seen_at = excluded.last_seen_at`,
    );
    // Age out every real sample, then leave only fresh disk gauges behind.
    await harness.pool.query("update ops_metric_samples set sampled_at = now() - interval '1 day'");
    await insertOpsMetricSamples(harness.db, [
      { metric: "capture", quantile: "p95", valueMs: 1, sampledAt: new Date(Date.now() - 86_400_000) },
      { metric: "disk_free_bytes", quantile: "p50", valueMs: 40_265_318_400 },
      { metric: "disk_used_bytes", quantile: "p50", valueMs: 67_108_864_000 },
      { metric: "disk_used_percent_bp", quantile: "p50", valueMs: 6250 },
    ]);

    const latest = await getLatestOpsMetricSampleAt(harness.db);
    expect(latest).not.toBeNull();
    expect(Date.now() - latest!.getTime()).toBeGreaterThan(OPS_WATCHDOG_SILENCE_MS);

    const silent = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(silent.samplerFresh).toBe(false);
    expect(await openIncidents()).toEqual(["ops_sampler_silent"]);

    // A real minutely sample — and only that — resolves the silence.
    await insertOpsMetricSamples(harness.db, [{ metric: "capture", quantile: "p95", valueMs: 1 }]);
    const recovered = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(recovered.samplerFresh).toBe(true);
    expect(await openIncidents()).toEqual([]);
  });
});

const MINUTE = 60_000;

async function schedulerHeartbeat(ageMs: number) {
  await harness.pool.query(
    `insert into runtime_instances (role, instance_id, started_at, last_seen_at, running)
     values ('scheduler', 'wd-test-1', now(), now() - ($1::bigint || ' milliseconds')::interval, '{}'::jsonb)
     on conflict (role, instance_id) do update set last_seen_at = excluded.last_seen_at`,
    [ageMs],
  );
}

describe("ops watchdog boot grace (deploys opened false scheduler_silent episodes)", () => {
  beforeEach(async () => {
    await resetIntegrationDatabase(harness.pool);
  });

  it("a fresh heartbeat inside the boot grace resolves the latch the previous api opened", async () => {
    // The outgoing api saw the scheduler restart and opened the latch...
    await schedulerHeartbeat(OPS_WATCHDOG_SILENCE_MS + MINUTE);
    await insertOpsMetricSamples(harness.db, [{ metric: "capture", quantile: "p95", valueMs: 1 }]);
    await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(await openIncidents()).toEqual(["scheduler_silent"]);

    // ...and the new api, one minute into its grace, finds it beating again.
    await schedulerHeartbeat(0);
    const result = await runOpsWatchdogCheck(appStub(), { startedAtMs: Date.now() - MINUTE });
    expect(result).toMatchObject({ bootGrace: true, schedulerFresh: true, samplerFresh: true });
    expect(await openIncidents()).toEqual([]);
  });

  it("a stale heartbeat inside the boot grace opens nothing", async () => {
    await schedulerHeartbeat(15 * MINUTE);
    const result = await runOpsWatchdogCheck(appStub(), { startedAtMs: Date.now() - MINUTE });
    expect(result).toMatchObject({ bootGrace: true, schedulerFresh: false });
    expect(await openIncidents()).toEqual([]);
    expect(opsWatchdogNeedsDeliveryFallback(result)).toBe(false);
  });
});

describe("api-side delivery fallback (pages while the scheduler or worker is down)", () => {
  beforeEach(async () => {
    await resetIntegrationDatabase(harness.pool);
    await getTelegramSettings(harness.db);
  });

  function recordingSender() {
    const sent: NotificationOutboxDelivery[] = [];
    const sender = async (delivery: NotificationOutboxDelivery) => {
      sent.push(delivery);
      return { status: "sent" as const, chatId: "1", messageId: sent.length };
    };
    return { sent, sender };
  }

  it("pages scheduler_silent from the api alone, once, even when a worker sweep races it", async () => {
    // Only the api is up: no pg-boss, no worker, a scheduler that stopped
    // beating 15 minutes ago. The sampler is kept fresh so one leg flips.
    const app = createTestAppContext(harness);
    await schedulerHeartbeat(15 * MINUTE);
    await insertOpsMetricSamples(harness.db, [{ metric: "capture", quantile: "p95", valueMs: 1 }]);
    const { sent, sender } = recordingSender();

    const t0 = new Date();
    const check = await runOpsWatchdogCheck(app, { startedAtMs: PAST_BOOT_GRACE(), now: t0 });
    expect(check).toMatchObject({ bootGrace: false, schedulerFresh: false, samplerFresh: true });
    expect(await openIncidents()).toEqual(["scheduler_silent"]);
    expect(opsWatchdogNeedsDeliveryFallback(check)).toBe(true);

    // Inside the 10 min hold: evaluated, not paged.
    const early = await runOpsWatchdogDeliveryFallback(app, { now: t0, sender });
    expect(early.sweep).toMatchObject({ examined: 1, paged: 0 });
    expect(sent).toEqual([]);

    // t0 + 11 min: the api's own sweep pages, and a worker that comes back at
    // that very moment runs its sweep and delivery alongside.
    const t11 = new Date(t0.getTime() + 11 * MINUTE);
    await Promise.all([
      runOpsWatchdogDeliveryFallback(app, { now: t11, sender }),
      (async () => {
        await runNotificationPagingSweepExclusive(app, { now: t11 });
        await runNotificationDeliveryOutbox(app, { now: t11, sender });
      })(),
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("🚨 Scheduler heartbeat silent — cron is not firing");
    expect(sent[0]?.text).toContain("Open for 11 min");

    // Later ticks while it stays down send nothing more.
    await runOpsWatchdogDeliveryFallback(app, { now: new Date(t0.getTime() + 12 * MINUTE), sender });
    expect(sent).toHaveLength(1);
    const incident = await getNotificationIncidentByKey(harness.db, "scheduler_silent:global");
    const rows = await getNotificationDeliveryOutboxByIncident(harness.db, incident!.id);
    expect(rows.map((row) => [row.transition, row.state])).toEqual([["opened", "delivered"]]);
  });

  it("shutdown lets an in-flight fallback send settle and leases no further row", async () => {
    // Both deadmen tripped 11 min ago and already paged: two rows are due and
    // only the api is up to deliver them.
    const app = createTestAppContext(harness);
    await schedulerHeartbeat(15 * MINUTE);
    const t0 = new Date(Date.now() - 11 * MINUTE);
    await runOpsWatchdogCheck(app, { startedAtMs: t0.getTime() - 10 * MINUTE, now: t0 });
    expect(await openIncidents()).toEqual(["ops_sampler_silent", "scheduler_silent"]);
    expect(await runNotificationPagingSweep(app, { now: new Date() })).toMatchObject({ paged: 2 });

    // Telegram is slow: the first send is still in flight when SIGTERM lands.
    let releaseSend: () => void = () => {};
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sent: NotificationOutboxDelivery[] = [];
    const sender = async (delivery: NotificationOutboxDelivery) => {
      sent.push(delivery);
      await sendGate;
      return { status: "sent" as const, chatId: "1", messageId: sent.length };
    };
    const watchdog = startOpsWatchdog(app, { startedAtMs: PAST_BOOT_GRACE(), intervalMs: 20, sender });
    try {
      await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 10_000 });
      const stopped = watchdog.stop();
      releaseSend();
      await stopped;

      // Settled, not left leased for the worker to resend after the lease;
      // the other row stays pending for the next process, never half-sent.
      const states = await harness.pool.query<{ state: string }>(
        "select state from notification_delivery_outbox order by state",
      );
      expect(states.rows.map((row) => row.state)).toEqual(["delivered", "pending"]);
      expect(sent).toHaveLength(1);
    } finally {
      releaseSend();
      await watchdog.stop();
    }
  });
});

describe("sync_silent: the Fansly planner / executor deadman (E-2)", () => {
  let fanslyPageId = 0;
  let onlyFansPageId = 0;

  beforeEach(async () => {
    await resetIntegrationDatabase(harness.pool);
    // Scheduler and sampler healthy: only the sync leg is under test.
    await schedulerHeartbeat(0);
    await insertOpsMetricSamples(harness.db, [{ metric: "capture", quantile: "p95", valueMs: 1 }]);
    const model = await createModel(harness.db, { slug: "lilly", name: "Lilly" });
    fanslyPageId = (await createFanslyPage(harness.db, { modelId: model!.id, label: "lilly-fansly" }))!.id;
    onlyFansPageId = (await createOnlyFansPage(harness.db, { modelId: model!.id, label: "lilly-of" }))!.id;
    await streamState(fanslyPageId, "transactions", {});
    await streamState(onlyFansPageId, "transactions", {});
  });

  async function streamState(
    pageId: number,
    stream: string,
    state: { status?: string; blockerKind?: string | null; retryInMs?: number | null },
  ) {
    await harness.pool.query(
      `insert into page_sync_states (page_id, stream, status, blocker_kind, retry_at, cadence_seconds, slot_offset_seconds)
       values ($1, $2::sync_stream, $3::page_sync_status, $4,
               case when $5::bigint is null then null else now() + ($5::bigint || ' milliseconds')::interval end,
               300, 0)
       on conflict (page_id, stream) do update
         set status = excluded.status, blocker_kind = excluded.blocker_kind, retry_at = excluded.retry_at`,
      [pageId, stream, state.status ?? "idle", state.blockerKind ?? null, state.retryInMs ?? null],
    );
  }

  /** Start times come from the host clock the watchdog measures with, not
   * the database's: a Postgres VM clock a few ms ahead of the host would read
   * "16 min ago" as 15 min 59.99 s. */
  async function syncRunStarted(pageId: number, agoMs: number) {
    const startedAt = new Date(Date.now() - agoMs);
    await harness.pool.query(
      `insert into sync_runs (page_id, stream, outcome, started_at, finished_at)
       values ($1, 'transactions', 'succeeded', $2, $2)`,
      [pageId, startedAt],
    );
  }

  async function syncSilent() {
    return getNotificationIncidentByKey(harness.db, "sync_silent:global");
  }

  const HOUR = 60 * MINUTE;

  /** A whole hour a few hours back. The scenarios below run each check at a
   * `now` of their own on this clock, so the heartbeat and the sample written
   * above stay fresh and the boot grace is measured from the same clock. */
  function pastHour(): number {
    return Math.floor(Date.now() / HOUR) * HOUR - 3 * HOUR;
  }

  function checkAt(atMs: number) {
    return runOpsWatchdogCheck(appStub(), { startedAtMs: atMs - 10 * MINUTE, now: new Date(atMs) });
  }

  async function chunkStartedAt(pageId: number, atMs: number) {
    await harness.pool.query(
      `insert into sync_runs (page_id, stream, outcome, started_at, finished_at)
       values ($1, 'light', 'succeeded', $2, $2)`,
      [pageId, new Date(atMs)],
    );
  }

  /** The hourly light stream at slot offset 0, so slot k starts on hour k. */
  async function lightStream(
    pageId: number,
    state: { scheduledAt: number; requestSeq: number; appliedSeq: number; requestedAt: number; startedAt: number },
  ) {
    await harness.pool.query(
      `insert into page_sync_states (page_id, stream, status, cadence_seconds, slot_offset_seconds,
                                     last_scheduled_slot, request_seq, applied_seq, requested_at, started_at)
       values ($1, 'light', case when $3::bigint > $4::bigint then 'pending' else 'idle' end::page_sync_status,
               3600, 0, $2, $3, $4, $5, $6)
       on conflict (page_id, stream) do update
         set status = excluded.status, last_scheduled_slot = excluded.last_scheduled_slot,
             request_seq = excluded.request_seq, applied_seq = excluded.applied_seq,
             requested_at = excluded.requested_at, started_at = excluded.started_at`,
      [
        pageId,
        Math.floor(state.scheduledAt / HOUR),
        state.requestSeq,
        state.appliedSeq,
        new Date(state.requestedAt),
        new Date(state.startedAt),
      ],
    );
  }

  it("opens after 16 min without a Fansly chunk while a stream is due, resolves on a fresh run", async () => {
    await syncRunStarted(fanslyPageId, 14 * MINUTE);
    const quiet = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(quiet.syncStalled).toBe(false);
    expect(await syncSilent()).toBeNull();

    await harness.pool.query("update sync_runs set started_at = $1", [new Date(Date.now() - 16 * MINUTE)]);
    const stalled = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(stalled.syncStalled).toBe(true);
    expect(opsWatchdogNeedsDeliveryFallback(stalled)).toBe(true);
    expect(await syncSilent()).toMatchObject({
      status: "open",
      errorSummary: "No Fansly sync chunk started for 16 min — planner or executor stalled",
    });

    await syncRunStarted(fanslyPageId, 0);
    const recovered = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(recovered.syncStalled).toBe(false);
    expect((await syncSilent())?.status).toBe("resolved");
  });

  it("reads a run older than the one-hour lookback as over an hour of silence", async () => {
    await syncRunStarted(fanslyPageId, 3 * 60 * MINUTE);
    const stalled = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(stalled.syncStalled).toBe(true);
    expect((await syncSilent())?.errorSummary)
      .toBe("No Fansly sync chunk started for over 60 min — planner or executor stalled");
  });

  it("stays quiet while every Fansly stream is paused, blocked or backing off", async () => {
    await syncRunStarted(fanslyPageId, 30 * MINUTE);
    await streamState(fanslyPageId, "transactions", { status: "paused" });
    await streamState(fanslyPageId, "dm_messages", { status: "blocked", blockerKind: "auth" });
    await streamState(fanslyPageId, "posts", { status: "retrying", retryInMs: 20 * MINUTE });
    const result = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(result.syncStalled).toBe(false);
    expect(await syncSilent()).toBeNull();

    // A backoff that ran out a minute ago waits for the next planner tick;
    // one that ran out a full threshold ago is due work nothing picked up.
    await streamState(fanslyPageId, "posts", { status: "retrying", retryInMs: -MINUTE });
    expect((await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() })).syncStalled).toBe(false);
    await streamState(fanslyPageId, "posts", { status: "retrying", retryInMs: -16 * MINUTE });
    expect((await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() })).syncStalled).toBe(true);
  });

  it("an hourly stream idling to its next slot is not a stall, with every other stream paused", async () => {
    // Codex review: with only the hourly light stream runnable, a normal run at
    // 00:00 opened sync_silent at 00:16 and paged at ~00:26, while the next
    // run was scheduled for 01:00.
    await streamState(fanslyPageId, "transactions", { status: "paused" });
    const t0 = pastHour();
    await lightStream(fanslyPageId, { scheduledAt: t0, requestSeq: 1, appliedSeq: 1, requestedAt: t0, startedAt: t0 });
    await chunkStartedAt(fanslyPageId, t0 + 5_000);

    for (const minute of [1, 15, 16, 30, 45, 59]) {
      expect((await checkAt(t0 + minute * MINUTE)).syncStalled, `${minute} min into the idle hour`).toBe(false);
    }

    // 01:00: the planner claims the slot, and a check lands before the
    // executor has started the chunk.
    const claimedAt = t0 + HOUR + 20_000;
    await lightStream(fanslyPageId, {
      scheduledAt: t0 + HOUR, requestSeq: 2, appliedSeq: 1, requestedAt: claimedAt, startedAt: t0,
    });
    expect((await checkAt(claimedAt + 10_000)).syncStalled).toBe(false);
    await chunkStartedAt(fanslyPageId, claimedAt + 20_000);
    expect((await checkAt(t0 + HOUR + MINUTE)).syncStalled).toBe(false);
    expect(await syncSilent()).toBeNull();
  });

  it("an outstanding request no chunk has picked up for 16 min opens it", async () => {
    await streamState(fanslyPageId, "transactions", { status: "paused" });
    const t0 = pastHour();
    await chunkStartedAt(fanslyPageId, t0);
    // A request between slots (manual, event): the next slot is 01:00.
    const requestedAt = t0 + 10 * MINUTE;
    await lightStream(fanslyPageId, { scheduledAt: t0, requestSeq: 2, appliedSeq: 1, requestedAt, startedAt: t0 });

    // Outstanding for 10 min, silent for 20: the executor still has time.
    expect((await checkAt(requestedAt + 10 * MINUTE)).syncStalled).toBe(false);
    const stalled = await checkAt(requestedAt + 16 * MINUTE);
    expect(stalled.syncStalled).toBe(true);
    expect(await syncSilent()).toMatchObject({
      status: "open",
      errorSummary: "No Fansly sync chunk started for 26 min — planner or executor stalled",
    });
  });

  it("a slot the planner never claimed opens it once it has been due for 16 min", async () => {
    await streamState(fanslyPageId, "transactions", { status: "paused" });
    const t0 = pastHour();
    await lightStream(fanslyPageId, { scheduledAt: t0, requestSeq: 1, appliedSeq: 1, requestedAt: t0, startedAt: t0 });
    // The last Fansly chunk started at 00:50; the 01:00 slot is never claimed.
    await chunkStartedAt(fanslyPageId, t0 + 50 * MINUTE);

    // Silent for 24 min, but the slot has been due for 14 only.
    expect((await checkAt(t0 + HOUR + 14 * MINUTE)).syncStalled).toBe(false);
    const stalled = await checkAt(t0 + HOUR + 16 * MINUTE);
    expect(stalled.syncStalled).toBe(true);
    expect(await syncSilent()).toMatchObject({
      status: "open",
      errorSummary: "No Fansly sync chunk started for 26 min — planner or executor stalled",
    });
  });

  it("an OnlyFans-only run does not mask a Fansly stall", async () => {
    await syncRunStarted(fanslyPageId, 20 * MINUTE);
    await syncRunStarted(onlyFansPageId, 0);
    const result = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(result.syncStalled).toBe(true);
    expect((await syncSilent())?.status).toBe("open");
  });

  it("inside the boot grace a stall opens nothing, and a fresh run still resolves", async () => {
    await syncRunStarted(fanslyPageId, 20 * MINUTE);
    const inGrace = await runOpsWatchdogCheck(appStub(), { startedAtMs: Date.now() - MINUTE });
    expect(inGrace).toMatchObject({ bootGrace: true, syncStalled: true });
    expect(await syncSilent()).toBeNull();
    expect(opsWatchdogNeedsDeliveryFallback(inGrace)).toBe(false);

    await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect((await syncSilent())?.status).toBe("open");

    await syncRunStarted(fanslyPageId, 0);
    await runOpsWatchdogCheck(appStub(), { startedAtMs: Date.now() - MINUTE });
    expect((await syncSilent())?.status).toBe("resolved");
  });
});
