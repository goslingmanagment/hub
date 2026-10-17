import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import { createPool } from "@agency_hub_core/db";
import { deletion } from "../apps/runtime/node_modules/pg-boss/dist/plans.js";
import { reconcileQueueRetention } from "../apps/runtime/src/services/sync-queue.ts";
import { PG_BOSS_SEND_IT_QUEUE } from "../apps/runtime/src/services/queue-retention.ts";
import { startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let db: StartedTestDatabase;
beforeAll(async () => { db = await startTestDatabase(); });
afterAll(async () => { await db?.stop(); });

it("PR550 changes the lifetime of new jobs, retaining existing jobs for seven days", async () => {
  const boss = new PgBoss({ connectionString: db.connectionString, schedule: false, supervise: false });
  boss.on("error", () => undefined);
  try {
    await boss.start();
    await boss.createQueue(PG_BOSS_SEND_IT_QUEUE);
    const oldId = await boss.send(PG_BOSS_SEND_IT_QUEUE, { type: "before" });
    await reconcileQueueRetention(boss);
    const newId = await boss.send(PG_BOSS_SEND_IT_QUEUE, { type: "after" });
    const before = await db.pool.query("select id, deletion_seconds from pgboss.job where id = any($1::uuid[]) order by deletion_seconds desc", [[oldId,newId]]);
    expect(before.rows).toEqual([{id:oldId,deletion_seconds:604800},{id:newId,deletion_seconds:86400}]);
    await db.pool.query("update pgboss.job set state='completed', completed_on=now()-interval '2 days' where id=any($1::uuid[])", [[oldId,newId]]);
    await db.pool.query(deletion("pgboss", "job_common", [PG_BOSS_SEND_IT_QUEUE]));
    const remaining = await db.pool.query("select id from pgboss.job where id=any($1::uuid[])", [[oldId,newId]]);
    expect(remaining.rows).toEqual([{id:oldId}]);
    await writeFile("/tmp/hub-pr-verification-20261010/queue-retention-proof.json", JSON.stringify({oldSeconds:604800,newSeconds:86400,bothCompletedDaysAgo:2,oldJobSurvivesMaintenance:true,newJobDeleted:true}));
  } finally { await boss.stop(); }
});

it("PR545 lifetime expiration preserves a checked-out lock and LISTEN until release", async () => {
  const pool = createPool(db.connectionString, { lifetime: { idleTimeoutMillis: 300000, maxLifetimeSeconds: 1 } });
  const holder = await pool.connect();
  let released = false;
  try {
    await holder.query("listen review_lifetime");
    await holder.query("select pg_advisory_lock(98142,775)");
    const before = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
    await sleep(1200);
    const after = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
    expect(after).toBe(before);
    expect((await holder.query("select * from pg_listening_channels() as channel")).rows).toEqual([{channel:"review_lifetime"}]);
    const locked = await db.pool.query("select pg_try_advisory_lock(98142,775) as obtained");
    expect(locked.rows[0].obtained).toBe(false);
    holder.release(); released = true;
    const replacement = await pool.query("select pg_backend_pid() as pid");
    expect(replacement.rows[0].pid).not.toBe(before);
  } finally { if (!released) holder.release(true); await pool.end(); }
});
