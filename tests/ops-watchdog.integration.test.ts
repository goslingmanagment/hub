import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
import { runNotificationPagingSweepExclusive } from "../apps/runtime/src/services/notification-paging-sweep.ts";
import {
  OPS_WATCHDOG_SILENCE_MS,
  opsWatchdogNeedsDeliveryFallback,
  runOpsWatchdogCheck,
  runOpsWatchdogDeliveryFallback,
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
    expect(result).toEqual({ bootGrace: true, schedulerFresh: false, samplerFresh: false, syncStalled: false });
    expect(await openIncidents()).toEqual([]);
  });

  it("opens both silences on an empty database, resolves each on recovery", async () => {
    const first = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(first).toEqual({ bootGrace: false, schedulerFresh: false, samplerFresh: false, syncStalled: false });
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

  async function syncRunStarted(pageId: number, agoMs: number) {
    await harness.pool.query(
      `insert into sync_runs (page_id, stream, outcome, started_at, finished_at)
       values ($1, 'transactions', 'succeeded',
               now() - ($2::bigint || ' milliseconds')::interval,
               now() - ($2::bigint || ' milliseconds')::interval)`,
      [pageId, agoMs],
    );
  }

  async function syncSilent() {
    return getNotificationIncidentByKey(harness.db, "sync_silent:global");
  }

  it("opens after 16 min without a Fansly chunk while a stream is due, resolves on a fresh run", async () => {
    await syncRunStarted(fanslyPageId, 14 * MINUTE);
    const quiet = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(quiet.syncStalled).toBe(false);
    expect(await syncSilent()).toBeNull();

    await harness.pool.query("update sync_runs set started_at = now() - interval '16 minutes'");
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

    // A backoff that has run out is due again.
    await streamState(fanslyPageId, "posts", { status: "retrying", retryInMs: -MINUTE });
    expect((await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() })).syncStalled).toBe(true);
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
