import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { upsertDemand, type Database } from "@agency_hub_core/db";

import { SyncEngineHost, type SyncHostOptions } from "../apps/runtime/src/sync/engine/host.ts";
import type { ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { fanslyCaptureCodec } from "../apps/runtime/src/sync/fansly/capture.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  okResponse,
  pollsRequest,
  quietLogger,
  RecordingAlerts,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  testConfig,
  testRegistry,
  testSpec,
} from "./helpers/sync-engine-host.ts";

// Final adversarial review (adv-1, Д3): the same capture-poison loop as
// tests/bughunt-core-capture-poison.integration.test.ts, but under the
// production pacing constants instead of the test's sped-up ones: S = 2 500 ms
// (prod `sync_attempts.setting_ms` on 2026-10-09), the production pause floor
// (no `pacerFactory` override: FANSLY_PAUSE_MIN_MS), the production host loop
// (no `modeLoopIntervalMs` override: MODE_LOOP_INTERVAL_MS = 2 s). Route
// budgets stay off (`routeTimeScale: 0`) — they can only lengthen a cycle.
// Purpose: measure the cycle of the loop on an urgent key, to check the
// report's "≈300–400 identical requests per hour". Passes when it reproduces.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

const KEY = "poison.read";

function poisonRegistry() {
  const read: ResourceModule = {
    plan: async () => ({ kind: "request", request: pollsRequest }),
    apply: async () => ({ work: { satisfiesRevision: true, close: "done" }, followups: [] }),
  };
  return testRegistry([testSpec(KEY, read)]);
}

describe("bughunt final adv-1: the capture-poison loop at production pace", () => {
  it("repeats the same request every ≈10–13 s with no breaker and no alert", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    await upsertDemand(db(), { pageId, resource: KEY, kind: "trigger", class: "urgent" });

    const transport = new ScriptedLiveTransport();
    transport.respond = () => okResponse({ polls: [{ id: "1", question: "nul\u0000here" }] });
    const alerts = new RecordingAlerts();
    const metrics = new RecordingMetrics();
    const options: SyncHostOptions = {
      db: db(),
      connectionString: testDb.connectionString,
      config: testConfig(testDb.connectionString),
      rawConfig: testConfig(testDb.connectionString),
      logger: quietLogger,
      registry: poisonRegistry(),
      pause: { readSettingMs: async () => 2_500 },
      routeTimeScale: 0,
      capture: fanslyCaptureCodec,
      liveTransportFactory: async () => transport,
      alerts,
      metrics,
    };
    const host = new SyncEngineHost(options);
    await host.start();
    try {
      await sleep(75_000);
    } finally {
      await host.stop();
    }

    const gaps = transport.hits.slice(1).map((hit, i) => Math.round(hit.mono - transport.hits[i]!.mono));
    const work = await testDb.pool.query<{ state: string; failure_count: number; breaker_until: Date | null }>(
      "select state, failure_count, breaker_until from sync_work where resource = $1", [KEY],
    );
    const observations = await testDb.pool.query<{ n: number }>(
      "select count(*)::int as n from observations where producer = $1", [`fansly-sync:${KEY}`],
    );
    const meanGapMs = gaps.length === 0 ? null : Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    const report = JSON.stringify({
      sends: transport.hits.length,
      gapsMs: gaps,
      meanGapMs,
      perHourAtMeanGap: meanGapMs === null ? null : Math.round(3_600_000 / meanGapMs),
      work: work.rows,
      observations: observations.rows[0]!.n,
      alerts: alerts.opened,
      actorFailed: metrics.get("sync_actor_failed"),
    }, null, 2);
    console.log(report);
    if (process.env.ADV1_OUT) writeFileSync(process.env.ADV1_OUT, report);

    expect(transport.hits.length).toBeGreaterThanOrEqual(4);
    expect(observations.rows[0]!.n).toBe(0);
    expect(work.rows[0]!.failure_count).toBe(0);
    expect(work.rows[0]!.breaker_until).toBeNull();
    expect(alerts.opened).toEqual([]);
  }, 150_000);
});
