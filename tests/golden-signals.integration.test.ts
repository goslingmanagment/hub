import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openNotificationIncidentWithRecoveryGuard } from "@agency_hub_core/db";

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

  // ——— W5.1 (B8+A25): always-emit gauges + per-signal latch ———

  it("always emits the wedge gauges, zero when idle (B8)", async () => {
    const { samples } = await computeGoldenSignals(appStub());
    const pending = samples.find((s) => s.metric === "capture_pending_age" && s.quantile === "p95");
    const queued = samples.find((s) => s.metric === "command_queued_age" && s.quantile === "p95");
    const acceptance = samples.find((s) => s.metric === "acceptance_events_1h" && s.quantile === "p95");
    expect(pending).toBeDefined();
    expect(pending!.valueMs).toBe(0);
    expect(queued).toBeDefined();
    expect(queued!.valueMs).toBe(0);
    expect(acceptance).toBeDefined();
  });

  it("an aged UNPROCESSED webhook row breaches capture_pending_age (a wedge is not quiet)", async () => {
    await harness.pool.query(`
      insert into ofapi_webhook_events (idempotency_key, event_type, ofapi_account_id, payload, status, received_at, processed_at)
      values ('gs-wedge-1', 'messages.received', 'acct_gs', '{}', 'pending', now() - interval '20 minutes', null)
    `);
    const breached = await runGoldenSignalSample(appStub());
    expect(breached.breaches).toContain("capture_pending_age");
    const open = await harness.pool.query(
      "select incident_key from notification_incidents where kind = 'golden_signal_lag' and status = 'open'",
    );
    expect(open.rows.map((r: { incident_key: string }) => r.incident_key))
      .toContain("golden_signal_lag:global:capture_pending_age");

    // Settle it just outside the latency window: pending gauge returns to 0
    // without producing a capture-latency sample.
    await harness.pool.query(`
      update ofapi_webhook_events
      set processed_at = now() - interval '11 minutes', status = 'processed'
      where idempotency_key = 'gs-wedge-1'
    `);
    const recovered = await runGoldenSignalSample(appStub());
    expect(recovered.breaches).not.toContain("capture_pending_age");
    expect(recovered.resolved).toContain("capture_pending_age");
  });

  it("latches per signal: one standing breach never masks or resolves another (A25)", async () => {
    // Standing breach #1: stale smoke checkpoint (sse_delivery).
    await harness.pool.query(
      "update domain_events_smoke_checkpoint set updated_at = now() - interval '30 minutes' where id = 1",
    );
    // Breach #2: an aged unprocessed webhook row (capture_pending_age).
    await harness.pool.query(`
      insert into ofapi_webhook_events (idempotency_key, event_type, ofapi_account_id, payload, status, received_at, processed_at)
      values ('gs-two-1', 'messages.received', 'acct_gs', '{}', 'pending', now() - interval '25 minutes', null)
    `);
    const both = await runGoldenSignalSample(appStub());
    expect(both.breaches).toEqual(expect.arrayContaining(["sse_delivery", "capture_pending_age"]));
    const open = await harness.pool.query(
      "select incident_key from notification_incidents where kind = 'golden_signal_lag' and status = 'open' order by incident_key",
    );
    expect(open.rows.map((r: { incident_key: string }) => r.incident_key)).toEqual([
      "golden_signal_lag:global:capture_pending_age",
      "golden_signal_lag:global:sse_delivery",
    ]);

    // Fix ONLY the webhook wedge: its incident resolves; sse stays open.
    await harness.pool.query(`
      update ofapi_webhook_events
      set processed_at = now() - interval '11 minutes', status = 'processed'
      where idempotency_key = 'gs-two-1'
    `);
    const partial = await runGoldenSignalSample(appStub());
    expect(partial.breaches).toContain("sse_delivery");
    const stillOpen = await harness.pool.query(
      "select incident_key from notification_incidents where kind = 'golden_signal_lag' and status = 'open'",
    );
    expect(stillOpen.rows.map((r: { incident_key: string }) => r.incident_key))
      .toEqual(["golden_signal_lag:global:sse_delivery"]);

    // Cleanup: fresh checkpoint resolves the last latch.
    await harness.pool.query(
      "update domain_events_smoke_checkpoint set updated_at = now() where id = 1",
    );
    const clean = await runGoldenSignalSample(appStub());
    expect(clean.breaches).toEqual([]);
  });

  it("absence never resolves: a signal that stops emitting keeps its latch (B8)", async () => {
    // Isolate: push every earlier test's webhook row outside the trailing
    // window so this test fully controls the capture series.
    await harness.pool.query(`
      update ofapi_webhook_events
      set received_at = received_at - interval '2 hours',
          processed_at = processed_at - interval '2 hours'
    `);
    // Breach capture: a row processed NOW that took 20 minutes.
    await harness.pool.query(`
      insert into ofapi_webhook_events (idempotency_key, event_type, ofapi_account_id, payload, status, received_at, processed_at)
      values ('gs-abs-1', 'messages.received', 'acct_gs', '{}', 'processed', now() - interval '20 minutes', now())
    `);
    const breached = await runGoldenSignalSample(appStub());
    expect(breached.breaches).toContain("capture");

    // Push the settle outside the trailing window: capture emits NO sample.
    // The latch must stay open — absence is a dead pipeline, not health.
    await harness.pool.query(`
      update ofapi_webhook_events
      set processed_at = now() - interval '11 minutes', received_at = now() - interval '31 minutes'
      where idempotency_key = 'gs-abs-1'
    `);
    const silent = await runGoldenSignalSample(appStub());
    expect(silent.breaches).not.toContain("capture");
    expect(silent.resolved).not.toContain("capture");
    const stillOpen = await harness.pool.query(
      "select count(*)::int as open from notification_incidents where incident_key = 'golden_signal_lag:global:capture' and status = 'open'",
    );
    expect(stillOpen.rows[0].open).toBe(1);

    // A healthy settle inside the window resolves it.
    await harness.pool.query(`
      insert into ofapi_webhook_events (idempotency_key, event_type, ofapi_account_id, payload, status, received_at, processed_at)
      values ('gs-abs-2', 'messages.received', 'acct_gs', '{}', 'processed', now() - interval '3 seconds', now() - interval '2 seconds')
    `);
    const recovered = await runGoldenSignalSample(appStub());
    expect(recovered.resolved).toContain("capture");
    const after = await harness.pool.query(
      "select count(*)::int as open from notification_incidents where incident_key = 'golden_signal_lag:global:capture' and status = 'open'",
    );
    expect(after.rows[0].open).toBe(0);
  });

  it("retires the legacy SHARED latch key on the first run (one-time migration)", async () => {
    await openNotificationIncidentWithRecoveryGuard(harness.db, {
      incidentKey: "golden_signal_lag:global",
      kind: "golden_signal_lag",
      platformAccountId: null,
      stream: null,
      errorCode: null,
      errorSummary: "pre-W5 shared latch",
      metadata: {},
      occurredAt: new Date(),
    });
    await runGoldenSignalSample(appStub());
    const legacy = await harness.pool.query(
      "select status from notification_incidents where incident_key = 'golden_signal_lag:global'",
    );
    expect(legacy.rows[0].status).toBe("resolved");
  });
});
