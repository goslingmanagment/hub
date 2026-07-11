import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { insertOpsMetricSamples } from "@agency_hub_core/db";

import {
  OPS_WATCHDOG_SILENCE_MS,
  runOpsWatchdogCheck,
} from "../apps/runtime/src/services/ops-watchdog.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

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
  it("skips every check inside the boot grace window (deploy-restart guard)", async () => {
    const result = await runOpsWatchdogCheck(appStub(), { startedAtMs: Date.now() });
    expect(result).toEqual({ skipped: true, schedulerFresh: null, samplerFresh: null });
    expect(await openIncidents()).toEqual([]);
  });

  it("opens both silences on an empty database, resolves each on recovery", async () => {
    const first = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(first).toEqual({ skipped: false, schedulerFresh: false, samplerFresh: false });
    expect(await openIncidents()).toEqual(["ops_sampler_silent", "scheduler_silent"]);

    // Scheduler heartbeat lands → scheduler_silent resolves, sampler stays.
    await harness.pool.query(`
      insert into runtime_instances (role, instance_id, started_at, last_seen_at, running)
      values ('scheduler', 'wd-test-1', now(), now(), '{}'::jsonb)
      on conflict (role, instance_id) do update set last_seen_at = excluded.last_seen_at
    `);
    const second = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(second).toEqual({ skipped: false, schedulerFresh: true, samplerFresh: false });
    expect(await openIncidents()).toEqual(["ops_sampler_silent"]);

    // A fresh sample lands → sampler resolves too.
    await insertOpsMetricSamples(harness.db, [{ metric: "capture", quantile: "p95", valueMs: 1 }]);
    const third = await runOpsWatchdogCheck(appStub(), { startedAtMs: PAST_BOOT_GRACE() });
    expect(third).toEqual({ skipped: false, schedulerFresh: true, samplerFresh: true });
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
});
