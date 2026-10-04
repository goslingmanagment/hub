import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setTimeout as sleep } from "node:timers/promises";

import { PlatformAccountIdentityImmutableError, upsertDemand, type Database } from "@agency_hub_core/db";

import { WrongTransactionsWriterError } from "../apps/runtime/src/services/transactions-writer-gate.ts";
import { RESOURCE_HOLD_LADDER_MS } from "../apps/runtime/src/sync/engine/errors.ts";
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
// Two deterministic errors stop more than their work: an identity error the
// whole page (§3.8, §5.1), a wrong transactions writer its resource file
// (§5.6).

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

const done = { work: { satisfiesRevision: true, close: "done" as const }, followups: [] };

function requestModule(apply: ResourceModule["apply"]): ResourceModule {
  return {
    plan: async () => ({ kind: "request", request: pollsRequest }),
    apply,
  };
}

describe("a poisoned apply", () => {
  it("is quarantined or retried by class, and never stops the page", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    await testDb.pool.query("insert into sync_test_unique (id) values (1)");

    let boomCalls = 0;
    let deadlockCalls = 0;
    const order: string[] = [];
    const module = requestModule;
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
      await upsertDemand(db(), { pageId, resource, kind: "trigger", class: "urgent" });
    }
    for (const subject of ["a", "b", "c"]) {
      await upsertDemand(db(), { pageId, resource: "fine.read", subject, kind: "trigger", class: "urgent" });
    }

    const transport = new ScriptedLiveTransport();
    const alerts = new RecordingAlerts();
    const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, registry, transport, alerts });
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
    // The quarantined work still takes demand (it merges into the row) but no admission.
    await upsertDemand(db(), { pageId, resource: "poison.dup", kind: "trigger", class: "urgent" });
    const dup = await testDb.pool.query<{ state: string; demand_revision: string }>(
      "select state, demand_revision::text from sync_work where resource = 'poison.dup'",
    );
    expect(dup.rows).toEqual([{ state: "quarantined", demand_revision: "2" }]);
  }, 60_000);

  it("an identity error holds the whole page until new credentials, with alerts 1 and 2", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    let identityCalls = 0;
    const fine: string[] = [];
    const registry = testRegistry([
      testSpec("account.verify", requestModule(async () => {
        identityCalls += 1;
        throw new PlatformAccountIdentityImmutableError("lora-1", "111", "999");
      })),
      testSpec("fine.read", requestModule(async (_tx, input) => {
        fine.push(input.work.subject);
        return done;
      })),
    ]);
    await upsertDemand(db(), { pageId, resource: "account.verify", kind: "trigger", class: "urgent" });

    const transport = new ScriptedLiveTransport();
    const alerts = new RecordingAlerts();
    const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, registry, transport, alerts });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => {
        const rows = await testDb!.pool.query("select 1 from sync_pages where page_id = $1 and hold_kind = 'identity_mismatch'", [pageId]);
        return rows.rowCount === 1 ? true : null;
      }, 30_000, "the identity hold");
      // Demand that arrives under the hold is never admitted.
      await upsertDemand(db(), { pageId, resource: "fine.read", subject: "a", kind: "trigger", class: "urgent" });
      await sleep(1_500);
    } finally {
      stop.abort();
      await run;
    }

    expect(transport.hits).toHaveLength(1);
    expect(identityCalls).toBe(1);
    expect(fine).toEqual([]);
    const page = await testDb.pool.query<{ hold_kind: string; indefinite: boolean; held_under: unknown; credentials_generation: unknown }>(
      `select hold_kind, hold_until = 'infinity'::timestamptz as indefinite,
              hold_detail -> 'credentialsGeneration' as held_under, to_jsonb(credentials_generation) as credentials_generation
         from sync_pages where page_id = $1`,
      [pageId],
    );
    expect(page.rows[0]).toMatchObject({ hold_kind: "identity_mismatch", indefinite: true });
    expect(page.rows[0]!.held_under).toEqual(page.rows[0]!.credentials_generation);
    const attempts = await testDb.pool.query<{ resource: string; apply_state: string; apply_failures: number; apply_error: string }>(
      "select resource, apply_state, apply_failures, apply_error from sync_attempts order by id",
    );
    expect(attempts.rows).toEqual([
      { resource: "account.verify", apply_state: "quarantined", apply_failures: 1, apply_error: "PlatformAccountIdentityImmutableError" },
    ]);
    const work = await testDb.pool.query<{ resource: string; state: string; last_error_class: string | null }>(
      "select resource, state, last_error_class from sync_work order by id",
    );
    expect(work.rows).toEqual([
      { resource: "account.verify", state: "quarantined", last_error_class: "identity_mismatch" },
      { resource: "fine.read", state: "open", last_error_class: null },
    ]);
    expect(alerts.opened.map((alert) => [alert.subKey, alert.detail])).toEqual([
      ["page_stopped", "identity_mismatch"],
      ["live_degraded", "quarantined"],
    ]);
  }, 60_000);

  it("a wrong transactions writer holds its resource file; other files go on", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    const served: string[] = [];
    const registry = testRegistry([
      testSpec("transactions.head", requestModule(async () => {
        served.push("transactions.head");
        throw new WrongTransactionsWriterError({ platformAccountId: pageId, attemptedWriter: "fansly", assignedWriter: "ofapi" });
      })),
      testSpec("transactions.rescan", requestModule(async () => {
        served.push("transactions.rescan");
        return done;
      })),
      testSpec("fine.read", requestModule(async (_tx, input) => {
        served.push(`fine.read:${input.work.subject}`);
        return done;
      })),
    ]);
    await upsertDemand(db(), { pageId, resource: "transactions.head", kind: "trigger", class: "urgent" });

    const transport = new ScriptedLiveTransport();
    const alerts = new RecordingAlerts();
    const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, registry, transport, alerts });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    const heldAt = Date.now();
    try {
      await waitFor(async () => {
        const rows = await testDb!.pool.query("select 1 from sync_pages where page_id = $1 and resource_holds ? 'transactions'", [pageId]);
        return rows.rowCount === 1 ? true : null;
      }, 30_000, "the resource hold");
      await upsertDemand(db(), { pageId, resource: "transactions.rescan", kind: "trigger", class: "urgent" });
      await upsertDemand(db(), { pageId, resource: "fine.read", subject: "a", kind: "trigger", class: "urgent" });
      await waitFor(async () => (served.includes("fine.read:a") ? true : null), 30_000, "the other file's work");
      await sleep(500);
    } finally {
      stop.abort();
      await run;
    }

    // The held file's other work waits; the other file is served.
    expect(served).toEqual(["transactions.head", "fine.read:a"]);
    expect(transport.hits).toHaveLength(2);
    const page = await testDb.pool.query<{ hold_kind: string | null; step: number; until_ms: number }>(
      `select hold_kind, (resource_holds -> 'transactions' ->> 'step')::int as step,
              (extract(epoch from (resource_holds -> 'transactions' ->> 'until')::timestamptz) * 1000)::float8 as until_ms
         from sync_pages where page_id = $1`,
      [pageId],
    );
    expect(page.rows[0]).toMatchObject({ hold_kind: null, step: 1 });
    expect(page.rows[0]!.until_ms).toBeGreaterThan(heldAt + RESOURCE_HOLD_LADDER_MS[0]! - 60_000);
    const attempts = await testDb.pool.query<{ resource: string; apply_state: string; apply_failures: number; apply_error: string | null }>(
      "select resource, apply_state, apply_failures, apply_error from sync_attempts order by id",
    );
    expect(attempts.rows).toEqual([
      { resource: "transactions.head", apply_state: "quarantined", apply_failures: 1, apply_error: "WrongTransactionsWriterError" },
      { resource: "fine.read", apply_state: "applied", apply_failures: 0, apply_error: null },
    ]);
    const work = await testDb.pool.query<{ resource: string; state: string }>("select resource, state from sync_work order by id");
    expect(work.rows).toEqual([
      { resource: "transactions.head", state: "quarantined" },
      { resource: "transactions.rescan", state: "open" },
      { resource: "fine.read", state: "done" },
    ]);
    expect(alerts.opened.map((alert) => [alert.subKey, alert.detail])).toEqual([["live_degraded", "quarantined"]]);
  }, 60_000);
});
