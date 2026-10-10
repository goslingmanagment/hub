import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { upsertDemand, type Database } from "@agency_hub_core/db";

import type { CaptureCodec } from "../apps/runtime/src/sync/engine/commit.ts";
import { SyncEngineHost, type SyncHostOptions } from "../apps/runtime/src/sync/engine/host.ts";
import { createPacer } from "../apps/runtime/src/sync/engine/pacer.ts";
import type { ApplyInput, ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
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
  waitFor,
} from "./helpers/sync-engine-host.ts";

// Bug hunt Д3: a read whose capture never commits. The capture transaction
// rolls back the same way on every try (a NUL jsonb refuses, our own capture
// code throwing), the actor exits `failed`, the host takes the page again,
// recovery closes the attempt `unknown` and opens the work — and the same
// request went out again, forever, uncounted and unalerted. Now recovery
// quarantines a work whose two newest attempts are `unknown` within 10 min
// (alert 2, `unknown_repeated`), and the attempt says why it never committed
// (`commit_failed:<SQLSTATE|name>`). A NUL in a 2xx answer is journaled as
// U+FFFD with the first read, and the answer is applied from that journal
// copy, so the projection and the journal agree.

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

function registryOf(apply: ResourceModule["apply"] = async () => ({ work: { satisfiesRevision: true, close: "done" }, followups: [] })) {
  const read: ResourceModule = {
    plan: async () => ({ kind: "request", request: pollsRequest }),
    apply,
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
    registry: registryOf(),
    pause: { readSettingMs: async () => 50 },
    pacerFactory: (deps) => createPacer({ ...deps, minSettingMs: 1 }),
    routeTimeScale: 0,
    modeLoopIntervalMs: 200,
    capture: fanslyCaptureCodec,
    ...overrides,
  };
}

interface AttemptView {
  id: string;
  outcome: string;
  apply_state: string;
  error_class: string | null;
}

async function attempts(): Promise<AttemptView[]> {
  const result = await testDb!.pool.query<AttemptView>(
    "select id::text, outcome, apply_state, error_class from sync_attempts order by id",
  );
  return result.rows;
}

async function work(): Promise<{ state: string; last_error_class: string | null; result: unknown } | null> {
  const result = await testDb!.pool.query<{ state: string; last_error_class: string | null; result: unknown }>(
    "select state, last_error_class, result from sync_work where resource = $1", [KEY],
  );
  return result.rows[0] ?? null;
}

/** A host whose every read of `KEY` is answered by a 200 with a NUL in a
 *  string; runs until the work is quarantined, then 12 s more (a loop would
 *  have sent its third request by then). */
async function runUntilQuarantined(capture: CaptureCodec) {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
  await upsertDemand(db(), { pageId, resource: KEY, kind: "trigger", class: "urgent" });
  const transport = new ScriptedLiveTransport();
  transport.respond = () => okResponse({ polls: [{ id: "1", question: "nul\u0000here" }] });
  const alerts = new RecordingAlerts();
  const metrics = new RecordingMetrics();
  const host = new SyncEngineHost(hostOptions({ liveTransportFactory: async () => transport, alerts, metrics, capture }));
  await host.start();
  try {
    await waitFor(async () => ((await work())?.state === "quarantined" ? true : null), 45_000, "the quarantine");
    await sleep(12_000);
  } finally {
    await host.stop();
  }
  return { transport, alerts, metrics };
}

describe("a read whose capture never commits", () => {
  it("is sent at most twice in 10 min, then quarantined", async (context) => {
    if (!testDb) return context.skip();
    // The codec journals the answer verbatim: jsonb refuses its `\u0000` (22P05).
    const { transport, alerts, metrics } = await runUntilQuarantined({
      prepare: ({ response }) => response,
      served: ({ payload }) => payload,
    });

    expect(transport.hits).toHaveLength(2);
    const rows = await attempts();
    expect(rows).toMatchObject([
      { outcome: "unknown", apply_state: "none", error_class: "commit_failed:22P05" },
      { outcome: "unknown", apply_state: "none", error_class: "commit_failed:22P05" },
    ]);
    const row = await work();
    expect(row).toMatchObject({ state: "quarantined", last_error_class: "unknown_repeated" });
    const quarantine = (row!.result as { quarantine: { reason: string; attemptId: number; detail: Record<string, unknown> } }).quarantine;
    expect(quarantine.reason).toBe("unknown_repeated");
    expect(quarantine.attemptId).toBe(Number(rows[1]!.id));
    expect(quarantine.detail).toEqual({
      attempts: [Number(rows[1]!.id), Number(rows[0]!.id)],
      errorClasses: ["commit_failed:22P05", "commit_failed:22P05"],
    });
    expect(alerts.opened).toContainEqual(expect.objectContaining({
      subKey: "live_degraded",
      detail: "quarantined",
      context: expect.objectContaining({ resource: KEY, reason: "unknown_repeated" }),
    }));
    expect(metrics.get("sync_actor_failed")).toBe(2);
  }, 90_000);

  it("is bounded the same way when our own capture code throws", async (context) => {
    if (!testDb) return context.skip();
    const { transport, alerts, metrics } = await runUntilQuarantined({
      prepare: () => {
        throw new TypeError("a bug in the journal transform");
      },
      served: ({ payload }) => payload,
    });

    expect(transport.hits).toHaveLength(2);
    expect(await attempts()).toMatchObject([
      { outcome: "unknown", error_class: "commit_failed:TypeError" },
      { outcome: "unknown", error_class: "commit_failed:TypeError" },
    ]);
    expect(await work()).toMatchObject({ state: "quarantined", last_error_class: "unknown_repeated" });
    expect(alerts.opened).toContainEqual(expect.objectContaining({
      subKey: "live_degraded",
      detail: "quarantined",
      context: expect.objectContaining({ resource: KEY, reason: "unknown_repeated" }),
    }));
    expect(metrics.get("sync_actor_failed")).toBe(2);
  }, 90_000);
});

describe("a NUL in a 2xx answer", () => {
  it("is journaled as U+FFFD with one read and applied from the journal copy", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    await upsertDemand(db(), { pageId, resource: KEY, kind: "trigger", class: "urgent" });
    const seen: Array<Pick<ApplyInput, "parsed" | "observation">> = [];
    const transport = new ScriptedLiveTransport();
    transport.respond = () => okResponse({ polls: [{ id: "1", question: "nul\u0000here" }] });
    const host = new SyncEngineHost(hostOptions({
      registry: registryOf(async (_tx, input) => {
        seen.push({ parsed: input.parsed, observation: input.observation });
        return { work: { satisfiesRevision: true, close: "done" }, followups: [] };
      }),
      liveTransportFactory: async () => transport,
      alerts: new RecordingAlerts(),
      metrics: new RecordingMetrics(),
    }));
    await host.start();
    try {
      await waitFor(async () => ((await work())?.state === "done" ? true : null), 30_000, "the read applied");
      await sleep(1_000);
    } finally {
      await host.stop();
    }

    expect(transport.hits).toHaveLength(1);
    expect(await attempts()).toMatchObject([{ outcome: "response", apply_state: "applied", error_class: null }]);
    const observation = await testDb.pool.query<{ payload: unknown; text: string }>(
      "select payload, payload::text as text from observations where producer = $1", [`fansly-sync:${KEY}`],
    );
    expect(observation.rows).toHaveLength(1);
    expect(observation.rows[0]!.text).not.toContain("\\u0000");
    expect(observation.rows[0]!.payload).toEqual({ polls: [{ id: "1", question: "nul�here" }] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.parsed).toEqual({ polls: [{ id: "1", question: "nul�here" }] });
    expect(JSON.stringify(seen[0]!.parsed)).not.toContain("\\u0000");
    expect(await work()).toMatchObject({ state: "done" });
  }, 60_000);
});
