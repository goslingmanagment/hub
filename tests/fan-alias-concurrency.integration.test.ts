import { setTimeout as sleep } from "node:timers/promises";

import {
  createDb,
  upsertFans,
  type createPool,
  type Database,
} from "@agency_hub_core/db";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

const GATE_KEY = "90030912081";
let harness: StartedTestDatabase;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Docker-backed Postgres is required for this integration test");
  harness = started;
  // Stop each statement before its second alias, after the first real row lock.
  // The shared advisory lock is released before that second row is touched: it
  // schedules the overlap but is never held during a possible real lock cycle.
  await harness.pool.query(`
    create function test_fan_alias_second_row_gate() returns trigger
    language plpgsql as $$
    declare attempt integer;
    begin
      if current_setting('test.fan_alias_gate', true) = 'on' then
        attempt := coalesce(nullif(current_setting('test.fan_alias_attempt', true), '')::integer, 0) + 1;
        perform set_config('test.fan_alias_attempt', attempt::text, true);
        if attempt = 2 then
          perform pg_advisory_lock_shared(${GATE_KEY}::bigint);
          perform pg_advisory_unlock_shared(${GATE_KEY}::bigint);
        end if;
      end if;
      return new;
    end $$
  `);
  await harness.pool.query(`
    create trigger test_fan_alias_second_row_gate
    before insert on fan_username_aliases
    for each row execute function test_fan_alias_second_row_gate()
  `);
}, 120_000);

afterAll(async () => { await harness?.stop(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function pauseBeforeAliases(client: PoolClient, go: Promise<void>) {
  const ready = deferred();
  const proxied = new Proxy(client, {
    get(target, property) {
      if (property === "query") {
        return async (...args: unknown[]) => {
          const config = args[0];
          const text = typeof config === "string" ? config : (config as { text?: string }).text ?? "";
          if (/^insert into "fan_username_aliases"/.test(text)) {
            ready.resolve();
            await go;
          }
          return Reflect.apply(target.query, target, args);
        };
      }
      return Reflect.get(target, property, target);
    },
  });
  // A dedicated PoolClient keeps real autocommit boundaries and lets the test
  // inspect each backend. No query text, parameters or result rows are changed.
  return {
    db: createDb(proxied as unknown as ReturnType<typeof createPool>) as Database,
    ready: ready.promise,
  };
}

async function requireReady(ready: Promise<void>, operation: Promise<unknown>) {
  const timeout = new AbortController();
  try {
    await Promise.race([
      ready,
      operation.then(() => { throw new Error("Writer finished before the alias gate"); }),
      sleep(10_000, undefined, { signal: timeout.signal })
        .then(() => { throw new Error("Writer did not reach the alias gate"); }),
    ]);
  } finally {
    timeout.abort();
  }
}

async function waitForAliasOverlap(pids: number[]) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const { rows } = await harness.pool.query<{
      pid: number; wait_event: string | null; blockers: number[];
    }>(
      "select pid, wait_event, pg_blocking_pids(pid) as blockers from pg_stat_activity where pid = any($1::int[])",
      [pids],
    );
    const gated = rows.filter((row) => row.wait_event === "advisory").length;
    // With a common order, one writer owns the first alias and the other waits
    // on it. With the regression, both own different first aliases. Release
    // either schedule, then assert the actual result of the two SQL statements.
    if (gated === 2 || (gated === 1 && rows.some((row) =>
      row.wait_event !== "advisory" && row.blockers.some((pid) => pids.includes(pid))))) return;
    if (Date.now() >= deadline) {
      throw new Error(`Expected alias lock overlap was not reached: ${JSON.stringify(rows)}`);
    }
    await sleep(10);
  }
}

describe("fan username alias concurrency", () => {
  it.each([false, true])("completes overlapping partial-change batches (reverse second input: %s)", async (reverseSecond) => {
    const prefix = `alias-lock-${reverseSecond}`;
    const input = [
      { platform: "onlyfans" as const, platformUserId: `${prefix}-a`, username: `${prefix}-a`, displayName: "A0" },
      { platform: "onlyfans" as const, platformUserId: `${prefix}-b`, username: `${prefix}-b`, displayName: "B0" },
    ];
    const [a, b] = await upsertFans(harness.db, input);
    const client1 = await harness.pool.connect();
    const client2 = await harness.pool.connect();
    const control = await harness.pool.connect();
    const go = deferred();
    const operations: ReturnType<typeof upsertFans>[] = [];
    let gateHeld = false;
    try {
      for (const client of [client1, client2]) {
        await client.query("set statement_timeout = '10s'");
        await client.query("select set_config('test.fan_alias_gate', 'on', false)");
      }
      const pid1 = Number((await client1.query("select pg_backend_pid() as pid")).rows[0].pid);
      const pid2 = Number((await client2.query("select pg_backend_pid() as pid")).rows[0].pid);
      await control.query("select pg_advisory_lock($1::bigint)", [GATE_KEY]);
      gateHeld = true;

      const first = pauseBeforeAliases(client1, go.promise);
      const second = pauseBeforeAliases(client2, go.promise);
      // First fan write changes only A and commits. The second changes only B,
      // so RETURNING plus no-op read-back produces the opposite internal order.
      const op1 = upsertFans(first.db, [{ ...input[0]!, displayName: "A1" }, input[1]!]);
      operations.push(op1);
      void op1.catch(() => undefined);
      await requireReady(first.ready, op1);
      const secondInput = [{ ...input[0]!, displayName: "A1" }, { ...input[1]!, displayName: "B1" }];
      const op2 = upsertFans(second.db, reverseSecond ? secondInput.reverse() : secondInput);
      operations.push(op2);
      void op2.catch(() => undefined);
      await requireReady(second.ready, op2);
      go.resolve();

      await waitForAliasOverlap([pid1, pid2]);
      await control.query("select pg_advisory_unlock($1::bigint)", [GATE_KEY]);
      gateHeld = false;
      const results = await Promise.all(operations);
      expect(results[0]!.map((fan) => fan.id)).toEqual([a!.id, b!.id]);
      expect(results[1]!.map((fan) => fan.id))
        .toEqual(reverseSecond ? [b!.id, a!.id] : [a!.id, b!.id]);
      const { rows } = await harness.pool.query<{ username: string; display_name: string }>(
        "select username, display_name from fans where id = any($1::bigint[]) order by id",
        [[a!.id, b!.id]],
      );
      expect(rows).toEqual([
        { username: `${prefix}-a`, display_name: "A1" },
        { username: `${prefix}-b`, display_name: "B1" },
      ]);
    } finally {
      go.resolve();
      try {
        if (gateHeld) await control.query("select pg_advisory_unlock($1::bigint)", [GATE_KEY]);
        await Promise.allSettled(operations);
      } finally {
        // Close these dedicated sessions so gates and timeouts cannot leak to
        // later tests through the connection pool, even after an assertion fails.
        client1.release(true);
        client2.release(true);
        control.release(true);
      }
    }
  }, 30_000);

  it("preserves no-op alias versions and keeps prior usernames after a rename", async () => {
    const input = { platform: "onlyfans" as const, platformUserId: "alias-no-op", username: "original" };
    const [fan] = await upsertFans(harness.db, [input]);
    const readAliases = () => harness.pool.query<{
      username: string; version: string; first_seen_at: Date; last_seen_at: Date;
    }>(
      "select username, xmin::text as version, first_seen_at, last_seen_at from fan_username_aliases where fan_id = $1 order by username",
      [fan!.id],
    );
    const before = (await readAliases()).rows;
    await upsertFans(harness.db, [input]);
    expect((await readAliases()).rows).toEqual(before);

    await upsertFans(harness.db, [{ ...input, username: "renamed" }]);
    const after = (await readAliases()).rows;
    expect(after.map((alias) => alias.username)).toEqual(["original", "renamed"]);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]!.first_seen_at).toEqual(fan!.firstSeenAt);
  });
});
