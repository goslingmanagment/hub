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
    expect(result).toEqual({ bootGrace: true, schedulerFresh: false, samplerFresh: false, syncEngineSilent: false });
    expect(await openIncidents()).toEqual([]);
  });

  it("opens both silences on an empty database, resolves each on recovery", async () => {
    const first = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(first).toEqual({ bootGrace: false, schedulerFresh: false, samplerFresh: false, syncEngineSilent: false });
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

  it("a role's process_* memory gauge is never sampler liveness", async () => {
    // Every role's heartbeat writes its memory gauges into the same table every
    // 5 minutes, whether or not the minutely sampler is alive.
    await harness.pool.query(
      `insert into runtime_instances (role, instance_id, started_at, last_seen_at, running)
       values ('scheduler', 'wd-test-1', now(), now(), '{}'::jsonb)
       on conflict (role, instance_id) do update set last_seen_at = excluded.last_seen_at`,
    );
    await harness.pool.query("update ops_metric_samples set sampled_at = now() - interval '1 day'");
    await insertOpsMetricSamples(harness.db, [
      { metric: "capture", quantile: "p95", valueMs: 1, sampledAt: new Date(Date.now() - 86_400_000) },
      { metric: "process_rss_bytes_worker", quantile: "p50", valueMs: 431_000_000 },
      { metric: "process_heap_used_bytes_api", quantile: "p50", valueMs: 140_000_000 },
    ]);

    const latest = await getLatestOpsMetricSampleAt(harness.db);
    expect(latest).not.toBeNull();
    expect(Date.now() - latest!.getTime()).toBeGreaterThan(OPS_WATCHDOG_SILENCE_MS);

    const silent = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(silent.samplerFresh).toBe(false);
    expect(await openIncidents()).toEqual(["ops_sampler_silent"]);

    await insertOpsMetricSamples(harness.db, [{ metric: "capture", quantile: "p95", valueMs: 1 }]);
    const recovered = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(recovered.samplerFresh).toBe(true);
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

describe("no legacy sync deadman (E-2's leg went with the legacy Fansly streams, step 4 S4-21)", () => {
  beforeEach(async () => {
    await resetIntegrationDatabase(harness.pool);
  });

  it("a legacy stream left due for hours with no chunk ever started opens nothing", async () => {
    await schedulerHeartbeat(0);
    await insertOpsMetricSamples(harness.db, [{ metric: "capture", quantile: "p95", valueMs: 1 }]);
    const model = await createModel(harness.db, { slug: "lilly", name: "Lilly" });
    for (const page of [
      await createFanslyPage(harness.db, { modelId: model!.id, label: "lilly-fansly" }),
      await createOnlyFansPage(harness.db, { modelId: model!.id, label: "lilly-of" }),
    ]) {
      await harness.pool.query(
        `insert into page_sync_states (page_id, stream, status, cadence_seconds, slot_offset_seconds,
                                       request_seq, applied_seq, requested_at)
         values ($1, 'transactions', 'pending', 300, 0, 2, 1, now() - interval '3 hours')`,
        [page!.id],
      );
    }

    const result = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(result).toEqual({ bootGrace: false, schedulerFresh: true, samplerFresh: true, syncEngineSilent: false });
    expect(opsWatchdogNeedsDeliveryFallback(result)).toBe(false);
    expect(await getNotificationIncidentByKey(harness.db, "sync_silent:global")).toBeNull();
    expect((await harness.pool.query("select count(*)::int as n from notification_incidents")).rows[0].n).toBe(0);
  });
});

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
