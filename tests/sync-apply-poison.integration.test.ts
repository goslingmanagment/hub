import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { upsertDemand, type Database } from "@agency_hub_core/db";

import type { ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  makeTestActor,
  pollsRequest,
  RecordingAlerts,
  ScriptedLiveTransport,
  seedSyncPage,
  testRegistry,
  testSpec,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// A failing apply never blocks the page (design §3.7.3, SK10): a
// deterministic error (SQLSTATE class 23) quarantines its work and attempt at
// once with alert 2; an unexpected error is retried from the journal (no new
// request) and quarantined at the third failure; a transient one (40P01) is
// retried without being counted. Other work of the page goes on meanwhile.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  await testDb?.pool.query("create table if not exists sync_test_unique (id int primary key)");
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

describe("a poisoned apply", () => {
  it("is quarantined or retried by class, and never stops the page", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    await testDb.pool.query("insert into sync_test_unique (id) values (1)");

    let boomCalls = 0;
    let deadlockCalls = 0;
    const order: string[] = [];
    const done = { work: { satisfiesRevision: true, close: "done" as const }, followups: [] };
    const module = (apply: ResourceModule["apply"]): ResourceModule => ({
      plan: async () => ({ kind: "request", request: pollsRequest }),
      apply,
      shadow: async () => done,
    });
    const registry = testRegistry([
      testSpec("poison.dup", module(async (tx) => {
        await tx.execute("insert into sync_test_unique (id) values (1)" as never);
        return done;
      })),
      testSpec("poison.boom", module(async () => {
        boomCalls += 1;
        throw new Error("a resource bug");
      })),
      testSpec("poison.deadlock", module(async () => {
        deadlockCalls += 1;
        if (deadlockCalls === 1) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        return done;
      })),
      testSpec("fine.read", module(async (_tx, input) => {
        order.push(input.work.subject);
        return done;
      })),
    ]);
    for (const resource of ["poison.dup", "poison.boom", "poison.deadlock"]) {
      await upsertDemand(db(), { pageId, shadow: false, resource, kind: "trigger", class: "urgent" });
    }
    for (const subject of ["a", "b", "c"]) {
      await upsertDemand(db(), { pageId, shadow: false, resource: "fine.read", subject, kind: "trigger", class: "urgent" });
    }

    const transport = new ScriptedLiveTransport();
    const alerts = new RecordingAlerts();
    const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, mode: "live", registry, transport, alerts });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => {
        const rows = await testDb!.pool.query<{ resource: string; state: string }>(
          "select resource, state from sync_work order by id",
        );
        const states = new Map(rows.rows.map((row) => [row.resource + ":" + row.state, true]));
        const fineDone = rows.rows.filter((row) => row.resource === "fine.read" && row.state === "done").length;
        return states.has("poison.dup:quarantined") && states.has("poison.boom:quarantined")
          && states.has("poison.deadlock:done") && fineDone === 3 ? true : null;
      }, 30_000, "every work settled");
    } finally {
      stop.abort();
      await run;
    }

    const attempts = await testDb.pool.query<{ resource: string; apply_state: string; apply_failures: number; apply_error: string | null }>(
      "select resource, apply_state, apply_failures, apply_error from sync_attempts order by id",
    );
    const byResource = (resource: string) => attempts.rows.filter((row) => row.resource === resource);
    // One request per work: every retry is an apply from the journal.
    expect(transport.hits).toHaveLength(6);
    expect(attempts.rows).toHaveLength(6);
    expect(byResource("poison.dup")).toEqual([
      { resource: "poison.dup", apply_state: "quarantined", apply_failures: 1, apply_error: "23505" },
    ]);
    expect(byResource("poison.boom")).toEqual([
      { resource: "poison.boom", apply_state: "quarantined", apply_failures: 3, apply_error: "Error" },
    ]);
    expect(boomCalls).toBe(3);
    expect(byResource("poison.deadlock")).toEqual([
      { resource: "poison.deadlock", apply_state: "applied", apply_failures: 0, apply_error: null },
    ]);
    expect(deadlockCalls).toBe(2);
    expect(byResource("fine.read").map((row) => row.apply_state)).toEqual(["applied", "applied", "applied"]);
    expect(order.sort()).toEqual(["a", "b", "c"]);
    // Alert 2 for each quarantine (two), nothing for the transient error.
    expect(alerts.opened.filter((alert) => alert.subKey === "live_degraded" && alert.detail === "quarantined")).toHaveLength(2);
    expect(alerts.opened.every((alert) => alert.shadow === false)).toBe(true);
    // The quarantined work still takes demand (it merges into the row) but no admission.
    await upsertDemand(db(), { pageId, shadow: false, resource: "poison.dup", kind: "trigger", class: "urgent" });
    const dup = await testDb.pool.query<{ state: string; demand_revision: string }>(
      "select state, demand_revision::text from sync_work where resource = 'poison.dup'",
    );
    expect(dup.rows).toEqual([{ state: "quarantined", demand_revision: "2" }]);
  }, 60_000);
});
