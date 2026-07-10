import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  computeGoldenSignals,
  getGoldenSignalsReport,
  runGoldenSignalSample,
} from "../apps/runtime/src/services/golden-signals.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// Kernel Stage 25 Task 3: the golden-signal sampler — five lags computed
// over a trailing window, persisted as p50/p95 rows, thresholds flipping the
// incident latch, and the report the ops endpoint serves.

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

describe("golden signals (Stage 25)", () => {
  it("computes capture lag from settled webhook rows and smoke staleness from the checkpoint", async () => {
    // Capture: one webhook settled 5 s after receipt, inside the window.
    await harness.pool.query(`
      insert into ofapi_webhook_events (idempotency_key, event_type, ofapi_account_id, payload, status, received_at, processed_at)
      values ('gs-1', 'messages.received', 'acct_gs', '{}', 'processed', now() - interval '65 seconds', now() - interval '60 seconds')
    `);
    // SSE delivery: a fresh smoke checkpoint.
    await harness.pool.query(`
      insert into domain_events_smoke_checkpoint (id, cursor, frames_seen, gap_count, duplicate_count, updated_at)
      values (1, 'CUR', 10, 0, 0, now() - interval '30 seconds')
      on conflict (id) do update set updated_at = excluded.updated_at, frames_seen = excluded.frames_seen
    `);

    const { samples, failedProbes } = await computeGoldenSignals(appStub());
    expect(failedProbes).toEqual([]);
    // PR3: every health-floor family emits its backlog gauge (zero when
    // caught up), so the series exists from the very first sample.
    const floorSamples = samples.filter((sample) => sample.metric.startsWith("obs_backlog_"));
    expect(floorSamples.length).toBeGreaterThanOrEqual(2);
    for (const sample of floorSamples) {
      expect(sample.valueMs).toBe(0);
    }
    const capture = samples.find((sample) => sample.metric === "capture" && sample.quantile === "p95");
    expect(capture).toBeDefined();
    expect(capture!.valueMs).toBeGreaterThanOrEqual(4_000);
    expect(capture!.valueMs).toBeLessThan(10_000);

    const sse = samples.find((sample) => sample.metric === "sse_delivery" && sample.quantile === "p95");
    expect(sse).toBeDefined();
    expect(sse!.valueMs).toBeGreaterThanOrEqual(25_000);
    expect(sse!.valueMs).toBeLessThan(120_000);
  });

  it("samples persist, the report serves them with thresholds, and healthy signals keep the latch closed", async () => {
    const result = await runGoldenSignalSample(appStub());
    expect(result.sampled).toBeGreaterThanOrEqual(4); // capture p50/p95 + sse p50/p95 (+ projection when watermarks exist)
    expect(result.breaches).toEqual([]);

    const report = await getGoldenSignalsReport(appStub());
    expect(report.samples.length).toBeGreaterThanOrEqual(4);
    expect(report.thresholdsMs.capture).toBe(60_000);
    expect(report.smoke).toMatchObject({ framesSeen: 10, gapCount: 0, duplicateCount: 0 });

    const incidents = await harness.pool.query(
      "select count(*)::int as open from notification_incidents where kind = 'golden_signal_lag' and status = 'open'",
    );
    expect(incidents.rows[0].open).toBe(0);
  });

  it("measures real observation backlog through the health-floor gauge (PR3)", async () => {
    // One webhook observation stuck below the family floor for 20 minutes.
    const { HEALTH_FLOOR_REGISTRY } = await import("../apps/runtime/src/services/health-floors.ts");
    const webhookFloor = HEALTH_FLOOR_REGISTRY.find((floor) => floor.source === "webhook");
    expect(webhookFloor).toBeDefined();
    const kind = webhookFloor!.kinds![0]!;
    await harness.pool.query(
      `insert into observations (id, source, producer, kind, payload, payload_hash, idempotency_key, received_at, parse_version)
       overriding system value
       values (nextval(pg_get_serial_sequence('observations', 'id')), 'webhook', 'test', $1, '{}', '\\x00', 'floor-probe-1', now() - interval '20 minutes', 0)`,
      [kind],
    );
    const { samples } = await computeGoldenSignals(appStub());
    const gauge = samples.find(
      (sample) => sample.metric === webhookFloor!.name && sample.quantile === "p95",
    );
    expect(gauge).toBeDefined();
    expect(gauge!.valueMs).toBeGreaterThan(600_000);
    // The gauge rides the p95 latch: the sample run flags the family metric.
    const breached = await runGoldenSignalSample(appStub());
    expect(breached.breaches).toContain(webhookFloor!.name);
    // Consume it (stamp to the floor) → the gauge returns to zero.
    await harness.pool.query(
      "update observations set parse_version = $1 where idempotency_key = 'floor-probe-1'",
      [webhookFloor!.version],
    );
    const after = await runGoldenSignalSample(appStub());
    expect(after.breaches).toEqual([]);
  });

  it("opens the incident latch on a p95 breach and resolves it on recovery", async () => {
    // A smoke checkpoint stale beyond the 10-minute threshold = breach.
    await harness.pool.query(
      "update domain_events_smoke_checkpoint set updated_at = now() - interval '20 minutes' where id = 1",
    );
    const breached = await runGoldenSignalSample(appStub());
    expect(breached.breaches).toContain("sse_delivery");

    const open = await harness.pool.query(
      "select count(*)::int as open from notification_incidents where kind = 'golden_signal_lag' and status = 'open'",
    );
    expect(open.rows[0].open).toBe(1);

    // Recovery: fresh checkpoint → the latch resolves.
    await harness.pool.query(
      "update domain_events_smoke_checkpoint set updated_at = now() where id = 1",
    );
    const recovered = await runGoldenSignalSample(appStub());
    expect(recovered.breaches).toEqual([]);
    const after = await harness.pool.query(
      "select count(*)::int as open from notification_incidents where kind = 'golden_signal_lag' and status = 'open'",
    );
    expect(after.rows[0].open).toBe(0);
  });
});
