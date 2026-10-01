import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setConfigOverride } from "@agency_hub_core/db";

import { createSyncContext } from "../apps/runtime/src/sync/context.ts";
import { SYNC_HEARTBEAT_INTERVAL_MS, startSyncRuntime } from "../apps/runtime/src/sync/main.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// Sync Engine design §9.1, PR row S2-06a: the `sync` role is a process of its
// own (`node apps/runtime/dist/startup.js sync`). In this release it only
// lives: it boots like every other role (schema guard, boot overrides), beats
// its heartbeat row and health file on a 30 s cadence, writes nothing else,
// stays up while idle and exits 0 on SIGTERM with its row removed.

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
// node-postgres closes an idle pool client after 10 s. Past that, a process
// whose only timer is the (unref'd) heartbeat would have nothing left holding
// its event loop and would exit.
const IDLE_EXIT_WINDOW_MS = 12_000;

let testDb: StartedTestDatabase | null = null;
let scratch = "";

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
  scratch = mkdtempSync(path.join(tmpdir(), "sync-runtime-role-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function syncEnv(db: StartedTestDatabase, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: db.connectionString,
    APP_ENCRYPTION_KEY: ENCRYPTION_KEY,
    LOG_LEVEL: "silent",
    ...extra,
  };
}

interface SyncInstanceRow {
  instance_id: string;
  last_seen_at: Date;
  running: {
    values: Record<string, { value: unknown }>;
    skippedOverrides: Array<{ key: string; reason: string }>;
  };
}

async function syncRows(db: StartedTestDatabase) {
  const result = await db.pool.query<SyncInstanceRow>(
    "select instance_id, last_seen_at, running from runtime_instances where role = 'sync' order by instance_id",
  );
  return result.rows;
}

/** Row count of every table (partitions counted through their parent). */
async function tableCounts(db: StartedTestDatabase) {
  const result = await db.pool.query<{ name: string; n: string }>(`
    select c.relname as name,
           (xpath('/row/n/text()', query_to_xml(
             format('select count(*) as n from %I.%I', ns.nspname, c.relname), false, true, '')))[1]::text as n
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
     order by c.relname`);
  return Object.fromEntries(result.rows.map((row) => [row.name, Number(row.n)]));
}

function changedTables(before: Record<string, number>, after: Record<string, number>) {
  return Object.fromEntries(
    Object.keys({ ...before, ...after })
      .filter((name) => before[name] !== after[name])
      .map((name) => [name, { before: before[name] ?? null, after: after[name] ?? null }]),
  );
}

async function waitFor<T>(probe: () => Promise<T | null> | T | null, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

describe("the sync runtime role", () => {
  it("boots like every other role and heartbeats on its own cadence until stopped", async (context) => {
    if (!testDb) return context.skip();
    const db = testDb;
    // One boot override that applies and one whose prerequisite is off: every
    // role must report both exactly as api/worker do, or the Configuration
    // view would show drift and never clear pendingApply.
    await setConfigOverride(db.db, { key: "ofapiDmProjectionEnabled", value: true, userId: null, groupId: randomUUID() });
    await setConfigOverride(db.db, { key: "ofapiAccountHealthEnabled", value: true, userId: null, groupId: randomUUID() });

    const sync = await createSyncContext({ env: syncEnv(db) });
    try {
      expect(sync.rawConfig.ofapiDmProjectionEnabled).toBe(false);
      expect(sync.config.ofapiDmProjectionEnabled).toBe(true);
      expect(sync.bootSkipped.map((entry) => entry.key)).toEqual(["ofapiAccountHealthEnabled"]);

      const healthFile = path.join(scratch, "sync-health.json");
      const runtime = await startSyncRuntime(sync, { healthFilePath: healthFile, heartbeatIntervalMs: 200 });
      try {
        const [first] = await waitFor(async () => {
          const rows = await syncRows(db);
          return rows.length > 0 ? rows : null;
        }, 10_000, "the first sync heartbeat");
        expect(first!.instance_id).toBe(runtime.instanceId);
        expect(first!.running.values.ofapiDmProjectionEnabled).toEqual({ value: true });
        expect(first!.running.skippedOverrides.map((entry) => entry.key)).toEqual(["ofapiAccountHealthEnabled"]);

        await waitFor(() => (existsSync(healthFile) ? true : null), 10_000, "the health file");
        const firstMtimeMs = statSync(healthFile).mtimeMs;
        // Later beats move both the row and the file.
        await waitFor(async () => {
          const [row] = await syncRows(db);
          return row && row.last_seen_at > first!.last_seen_at && statSync(healthFile).mtimeMs > firstMtimeMs ? row : null;
        }, 10_000, "a later sync heartbeat");
      } finally {
        await runtime.stop();
      }
      expect(await syncRows(db)).toEqual([]);
    } finally {
      await sync.close();
    }
    expect(SYNC_HEARTBEAT_INTERVAL_MS).toBe(30_000);
  }, 60_000);

  it("refuses to boot on a schema that lacks the image's own latest migration", async (context) => {
    if (!testDb) return context.skip();
    const db = testDb;
    const removed = await db.pool.query<{ id: string }>(
      "delete from schema_migrations where id = (select max(id) from schema_migrations) returning id",
    );
    try {
      await expect(createSyncContext({ env: syncEnv(db) })).rejects.toThrow();
    } finally {
      await db.pool.query("insert into schema_migrations (id) values ($1)", [removed.rows[0]!.id]);
    }
  }, 60_000);

  it("runs as `startup.ts sync`: heartbeats, writes nothing else, stays up while idle, exits 0 on SIGTERM", async (context) => {
    if (!testDb) return context.skip();
    const db = testDb;
    const before = await tableCounts(db);
    const healthFile = path.join(scratch, "sync-health.json");
    const child = spawn(process.execPath, ["--import", "tsx/esm", "apps/runtime/src/startup.ts", "sync"], {
      env: { ...process.env, ...syncEnv(db, { SYNC_HEALTH_FILE: healthFile, LOG_LEVEL: "info" }) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    const alive = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`sync exited early (${child.exitCode ?? child.signalCode}); stderr:\n${stderr}\nstdout:\n${stdout}`);
      }
    };

    try {
      const [row] = await waitFor(async () => {
        alive();
        const rows = await syncRows(db);
        return rows.length > 0 ? rows : null;
      }, 90_000, "the sync process's first heartbeat");
      await waitFor(() => (existsSync(healthFile) ? true : null), 10_000, "the sync health file");
      // The engine host starts after the first beat (it owns no page here).
      await waitFor(() => (stdout.includes("Sync runtime started") ? true : null), 10_000, "the started line");

      await sleep(IDLE_EXIT_WINDOW_MS);
      alive();
      expect((await syncRows(db)).map((entry) => entry.instance_id)).toEqual([row!.instance_id]);
      expect(changedTables(before, await tableCounts(db))).toEqual({
        runtime_instances: { before: 0, after: 1 },
      });

      child.kill("SIGTERM");
      const result = await Promise.race([
        exited,
        sleep(15_000).then(() => {
          throw new Error(`sync did not exit within 15 s of SIGTERM; stderr:\n${stderr}`);
        }),
      ]);
      expect(result, stderr).toEqual({ code: 0, signal: null });
      expect(await syncRows(db)).toEqual([]);
      expect(changedTables(before, await tableCounts(db))).toEqual({});
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 180_000);
});
