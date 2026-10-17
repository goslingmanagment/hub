import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { upsertDemand, type Database } from "@agency_hub_core/db";

import { SyncEngineHost, type SyncHostOptions } from "../apps/runtime/src/sync/engine/host.ts";
import { createPacer } from "../apps/runtime/src/sync/engine/pacer.ts";
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

// BUG HUNT 2026-10-09 (core): a capture transaction (tx 2) that fails the
// same way on every try turns the engine into an unbounded request loop.
// The trigger here is U+0000 inside a JSON string of a 2xx body: the capture
// journals the PARSED answer with `JSON.stringify(payload)::jsonb`, jsonb
// refuses the `\u0000` escape (SQLSTATE 22P05), the actor's `#committed`
// retries 3 times, exits `failed`, the host takes the page again 5 s later,
// recovery marks the attempt `unknown` and reopens the work with no breaker,
// and the same request goes out again — forever.

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

function hostOptions(overrides: Partial<SyncHostOptions>): SyncHostOptions {
  return {
    db: db(),
    connectionString: testDb!.connectionString,
    config: testConfig(testDb!.connectionString),
    rawConfig: testConfig(testDb!.connectionString),
    logger: quietLogger,
    registry: poisonRegistry(),
    pause: { readSettingMs: async () => 50 },
    pacerFactory: (deps) => createPacer({ ...deps, minSettingMs: 1 }),
    routeTimeScale: 0,
    modeLoopIntervalMs: 200,
    // The production journal codec (main.ts): trims, token strip, lone
    // surrogates — and nothing for U+0000.
    capture: fanslyCaptureCodec,
    ...overrides,
  };
}

describe("bughunt core: a deterministic capture failure", () => {
  it("is bounded: at most one repeat, then a breaker and an alert (FAILS: it re-sends forever)", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    await upsertDemand(db(), { pageId, resource: KEY, kind: "trigger", class: "urgent" });

    // A 2xx answer whose JSON carries a NUL inside a string (as Fansly would
    // serialize a fan's text holding one: the `\u0000` escape).
    const transport = new ScriptedLiveTransport();
    transport.respond = () => okResponse({ polls: [{ id: "1", question: "nul\u0000here" }] });
    const alerts = new RecordingAlerts();
    const metrics = new RecordingMetrics();
    const host = new SyncEngineHost(hostOptions({ liveTransportFactory: async () => transport, alerts, metrics }));
    const started = Date.now();
    await host.start();
    try {
      await sleep(24_000);
    } finally {
      await host.stop();
    }
    const elapsedS = (Date.now() - started) / 1000;

    const attempts = await testDb.pool.query<{ outcome: string; apply_state: string; owner_generation: string; observation_id: string | null }>(
      "select outcome, apply_state, owner_generation::text, observation_id::text from sync_attempts order by id",
    );
    const work = await testDb.pool.query<{
      state: string; failure_count: number; breaker_until: Date | null; blocked_by_vendor_at: Date | null; attempts_count: number;
    }>("select state, failure_count, breaker_until, blocked_by_vendor_at, attempts_count from sync_work where resource = $1", [KEY]);
    const observations = await testDb.pool.query<{ n: number }>("select count(*)::int as n from observations where producer = $1", [`fansly-sync:${KEY}`]);

    console.log(JSON.stringify({
      elapsedS,
      sends: transport.hits.length,
      sendGapsMs: transport.hits.slice(1).map((hit, i) => Math.round(hit.mono - transport.hits[i]!.mono)),
      attempts: attempts.rows,
      work: work.rows,
      observations: observations.rows[0]!.n,
      alerts: alerts.opened,
      actorFailed: metrics.get("sync_actor_failed"),
    }, null, 2));

    // What the engine SHOULD do (fails on 71a05b5b): a capture that can never
    // commit is bounded — at most one repeat of the read, then a breaker (or a
    // quarantine) on the work, and the owner is told. Actual: the same request
    // every ~9.5 s for as long as the process runs, every attempt `unknown`,
    // nothing journaled, no breaker, no alert.
    expect({
      sends: transport.hits.length <= 2,
      breakerOrQuarantine: work.rows[0]!.failure_count > 0 || work.rows[0]!.breaker_until !== null || work.rows[0]!.state === "quarantined",
      alerted: alerts.opened.length > 0,
    }).toEqual({ sends: true, breakerOrQuarantine: true, alerted: true });
  }, 60_000);
});
