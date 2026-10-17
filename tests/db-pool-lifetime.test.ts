import { readFile } from "node:fs/promises";

import { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";

import { createPool, RUNTIME_POOL_LIFETIME } from "@agency_hub_core/db";

import { poolLifetimeForRole } from "../apps/runtime/src/bootstrap.ts";
import { FANSLY_SEND_HOLDER_ROLES } from "../apps/runtime/src/services/fansly-send-guard/os-probe.ts";

// node-postgres closes an idle connection after 10 s. The long-lived roles
// query every few seconds, so on prod they opened ~31 sessions a minute (each a
// fork, a SCRAM exchange and a cold catalog cache). Their pools, pg-boss's
// included, now keep idle connections 5 minutes and retire each after an hour;
// a one-shot command keeps the 10 s close that lets its process exit.

/** pg-pool keeps its resolved options here; no connection is opened. */
function poolOptions(pool: ReturnType<typeof createPool>) {
  return (pool as unknown as { options: { idleTimeoutMillis: number; maxLifetimeSeconds: number; statement_timeout?: number } }).options;
}

describe("pool lifetime", () => {
  it("keeps node-postgres' defaults unless a lifetime is given", async () => {
    const pool = createPool("postgres://user:secret@127.0.0.1:1/none");
    expect(poolOptions(pool)).toMatchObject({ idleTimeoutMillis: 10_000, maxLifetimeSeconds: 0 });
    await pool.end();
  });

  it("applies the runtime lifetime next to the session timeouts", async () => {
    const pool = createPool("postgres://user:secret@127.0.0.1:1/none", {
      timeouts: {
        connectionTimeoutMillis: 30_000,
        statementTimeoutMs: 60_000,
        lockTimeoutMs: 30_000,
        idleInTransactionSessionTimeoutMs: 60_000,
      },
      lifetime: RUNTIME_POOL_LIFETIME,
    });
    expect(poolOptions(pool)).toMatchObject({
      idleTimeoutMillis: 300_000,
      maxLifetimeSeconds: 3_600,
      statement_timeout: 60_000,
    });
    await pool.end();
  });

  it("gives the lifetime to the long-lived roles only", () => {
    const longLived = FANSLY_SEND_HOLDER_ROLES.filter((role) => poolLifetimeForRole(role) !== undefined);
    expect(longLived.sort()).toEqual(["api", "scheduler", "sync", "worker"]);
    expect(poolLifetimeForRole("api")).toBe(RUNTIME_POOL_LIFETIME);
    expect(poolLifetimeForRole(undefined)).toBeUndefined();
  });

  it("reaches pg-boss's own pool: its config keeps the options it does not declare", () => {
    const boss = new PgBoss({
      connectionString: "postgres://user:secret@127.0.0.1:1/none",
      schedule: false,
      ...RUNTIME_POOL_LIFETIME,
    });
    // Db spreads this config into `new pg.Pool(config)` when the boss starts.
    expect((boss.getDb() as unknown as { config: Record<string, unknown> }).config).toMatchObject({
      idleTimeoutMillis: 300_000,
      maxLifetimeSeconds: 3_600,
    });
  });

  it("is spread into every long-lived role's pg-boss and the sync process's pool", async () => {
    for (const [file, spread] of [
      ["apps/runtime/src/api/server.ts", "...(appContext.poolLifetime ?? {})"],
      ["apps/runtime/src/worker-runtime.ts", "...(app.poolLifetime ?? {})"],
      ["apps/runtime/src/scheduler-runtime.ts", "...(app.poolLifetime ?? {})"],
    ] as const) {
      const source = await readFile(file, "utf8");
      const instantiations = source.split(/new PgBoss\(\{/).slice(1);
      expect(instantiations, file).toHaveLength(1);
      expect(instantiations[0]!.split("});")[0], file).toContain(spread);
    }
    const sync = await readFile("apps/runtime/src/sync/main.ts", "utf8");
    expect(sync).toContain("createSyncContext({ poolTimeouts: SYNC_POOL_TIMEOUTS, poolLifetime: RUNTIME_POOL_LIFETIME })");
  });
});
