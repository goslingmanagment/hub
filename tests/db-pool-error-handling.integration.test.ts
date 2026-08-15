import { setTimeout as sleep } from "node:timers/promises";

import { createPool } from "@agency_hub_core/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// A pooled Postgres client whose backend dies while nobody is querying it emits
// an 'error' event. Without a listener that event is an unhandled EventEmitter
// error — i.e. the api/worker process dies on any Postgres restart or failover
// (and a checked-out client killed mid-transaction raised an uncaught 57P01 in
// a drill). createPool absorbs both; an error that belongs to a query must
// still reject that query's promise.

type BackgroundEvent = {
  scope: "idle" | "checked-out";
  code: string | undefined;
  message: string;
};

const WAIT_TIMEOUT_MS = 10_000;

async function waitFor(predicate: () => boolean, description: string) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Timed out after ${WAIT_TIMEOUT_MS}ms waiting for ${description}`);
}

async function backendPid(queryable: { query: Pool["query"] }) {
  const result = await queryable.query<{ pid: number }>("select pg_backend_pid() as pid");
  const pid = result.rows[0]?.pid;
  if (typeof pid !== "number") {
    throw new Error("pg_backend_pid() returned no row");
  }
  return pid;
}

describe("createPool background error handling integration", () => {
  let testDb: StartedTestDatabase | null = null;
  // A second pool that stays healthy: it issues pg_terminate_backend against
  // the pool under test, and observes the victim's state in pg_stat_activity.
  let control: Pool | null = null;

  beforeAll(async () => {
    // Only the baseline migration: these tests need a live Postgres, not a schema.
    testDb = await startIntegrationTestDatabase({ through: "0000_baseline.sql" });
    if (!testDb) {
      return;
    }
    control = createPool(testDb.connectionString);
  });

  afterAll(async () => {
    await control?.end().catch(() => undefined);
    await testDb?.stop();
  });

  async function terminate(pid: number) {
    if (!control) {
      throw new Error("control pool is not started");
    }
    await control.query("select pg_terminate_backend($1)", [pid]);
  }

  async function waitUntilActive(pid: number) {
    if (!control) {
      throw new Error("control pool is not started");
    }
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = await control.query<{ count: number }>(
        "select count(*)::int as count from pg_stat_activity where pid = $1 and state = 'active'",
        [pid],
      );
      if ((result.rows[0]?.count ?? 0) > 0) {
        return;
      }
      await sleep(25);
    }
    throw new Error(`Backend ${pid} never reached state 'active'`);
  }

  it("absorbs an idle pooled client whose backend was killed and keeps serving queries", async () => {
    if (!testDb) {
      return;
    }

    const events: BackgroundEvent[] = [];
    const pool = createPool(testDb.connectionString, {
      onBackgroundError: (event) => events.push(event),
    });

    try {
      // One query creates one client and returns it to the idle set.
      const pid = await backendPid(pool);
      expect(pool.idleCount).toBe(1);

      await terminate(pid);

      // Unpatched, this is where the process dies: pg-pool re-attaches its idle
      // listener on release, that listener re-emits on the Pool, and an
      // EventEmitter 'error' with no listener throws out of the socket callback.
      await waitFor(() => events.some((event) => event.code === "57P01"), "the killed idle client to report 57P01");

      const absorbed = events.find((event) => event.code === "57P01");
      expect(absorbed?.scope).toBe("idle");
      expect(absorbed?.message).toMatch(/terminating connection/i);

      // The pool dropped the dead client and dials a fresh one on demand.
      const survivor = await pool.query<{ ok: number }>("select 1 as ok");
      expect(survivor.rows[0]?.ok).toBe(1);
      expect(await backendPid(pool)).not.toBe(pid);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }, 60_000);

  it("absorbs a checked-out client killed between queries and hands out a working client next", async () => {
    if (!testDb) {
      return;
    }

    const events: BackgroundEvent[] = [];
    const pool = createPool(testDb.connectionString, {
      onBackgroundError: (event) => events.push(event),
    });

    try {
      const client = await pool.connect();
      const pid = await backendPid(client);

      // Checked out, pg-pool has removed its own idle listener, so this client
      // has no error listener at all unless createPool attached one.
      await terminate(pid);
      await waitFor(
        () => events.some((event) => event.scope === "checked-out" && event.code === "57P01"),
        "the killed checked-out client to report 57P01",
      );

      await expect(client.query("select 1")).rejects.toThrow();
      client.release();

      const next = await pool.connect();
      try {
        const result = await next.query<{ ok: number }>("select 1 as ok");
        expect(result.rows[0]?.ok).toBe(1);
        expect(await backendPid(next)).not.toBe(pid);
      } finally {
        next.release();
      }
    } finally {
      await pool.end().catch(() => undefined);
    }
  }, 60_000);

  it("still rejects the in-flight query when its own backend dies, and never touches plain query errors", async () => {
    if (!testDb) {
      return;
    }

    const events: BackgroundEvent[] = [];
    const pool = createPool(testDb.connectionString, {
      onBackgroundError: (event) => events.push(event),
    });

    try {
      // A plain SQL error is the query's business only: it rejects, and no
      // background event is reported for it.
      await expect(pool.query("select 1 / 0")).rejects.toMatchObject({ code: "22012" });
      expect(events).toEqual([]);

      const client = await pool.connect();
      const pid = await backendPid(client);
      const inFlight = client.query("select pg_sleep(30)");
      // Swallow-guard: attach the assertion before terminating so the rejection
      // can never surface as an unhandled rejection instead.
      const rejection = expect(inFlight).rejects.toMatchObject({ code: "57P01" });

      await waitUntilActive(pid);
      await terminate(pid);

      // The error reached the active query, not the error-event path.
      await rejection;
      client.release();
    } finally {
      await pool.end().catch(() => undefined);
    }
  }, 60_000);
});
