import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SCHEDULER_LEADER_LOCK_KEY,
  SCHEDULER_LEADER_LOCK_NS,
  acquireSchedulerLeadership,
} from "../apps/runtime/src/services/scheduler-leader.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// Kernel Stage 25: scheduler leader election — one active leader on the
// session advisory lock, stateless standby takeover, loud loss on session
// death (no window where two schedulers could both fire cron).

let harness: StartedTestDatabase;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) {
    throw new Error("Docker-backed Postgres is required for this integration test");
  }
  harness = started;
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

describe("scheduler leader election", () => {
  it("elects one leader; the standby takes over only after release", async () => {
    const leader = await acquireSchedulerLeadership({ pool: harness.pool, retryMs: 50 });
    expect(leader).not.toBeNull();

    // The standby loops on the lock — watch it fail a few cycles, prove it stays out.
    let standbyAttempts = 0;
    let standbyStopped = false;
    const standbyPromise = acquireSchedulerLeadership({
      pool: harness.pool,
      retryMs: 25,
      onStandby: () => {
        standbyAttempts += 1;
      },
      isStopped: () => standbyStopped,
    });
    await expect.poll(() => standbyAttempts, { timeout: 5_000, interval: 10 })
      .toBeGreaterThanOrEqual(2);

    // Leadership hand-off: release → the standby acquires within its retry.
    await leader!.release();
    const successor = await standbyPromise;
    expect(successor).not.toBeNull();

    // Exactly one session holds the lock now.
    const locks = await harness.pool.query(
      "select count(*)::int as held from pg_locks where locktype = 'advisory' and classid = $1 and objid = $2 "
      // pg_locks spans the whole cluster; sibling test databases share it.
      + "and database = (select oid from pg_database where datname = current_database())",
      [SCHEDULER_LEADER_LOCK_NS, SCHEDULER_LEADER_LOCK_KEY],
    );
    expect(locks.rows[0].held).toBe(1);

    standbyStopped = true;
    await successor!.release();
  });

  it("resolves `lost` when the lock session dies out from under the leader", async () => {
    const leader = await acquireSchedulerLeadership({ pool: harness.pool, retryMs: 50 });
    expect(leader).not.toBeNull();

    let lostSeen = false;
    void leader!.lost.then(() => {
      lostSeen = true;
    });

    // Kill the leader's backend from another session (crash/failover stand-in).
    await harness.pool.query(
      `select pg_terminate_backend(pid)
       from pg_locks
       where locktype = 'advisory' and classid = $1 and objid = $2
         -- pg_locks spans the whole cluster: without this a sibling test
         -- database's leader would be killed too.
         and database = (select oid from pg_database where datname = current_database())`,
      [SCHEDULER_LEADER_LOCK_NS, SCHEDULER_LEADER_LOCK_KEY],
    );
    await expect.poll(() => lostSeen, { timeout: 5_000, interval: 10 }).toBe(true);

    // The lock is free again — a new contender wins immediately.
    const successor = await acquireSchedulerLeadership({ pool: harness.pool, retryMs: 50 });
    expect(successor).not.toBeNull();
    await successor!.release();
  });

  it("stops contending when asked (clean shutdown of a standby)", async () => {
    const leader = await acquireSchedulerLeadership({ pool: harness.pool, retryMs: 25 });
    let stopped = false;
    let standbyAttempts = 0;
    const standby = acquireSchedulerLeadership({
      pool: harness.pool,
      retryMs: 25,
      onStandby: () => {
        standbyAttempts += 1;
      },
      isStopped: () => stopped,
    });
    // Stop only once it is really contending (it has lost at least one attempt).
    await expect.poll(() => standbyAttempts, { timeout: 5_000, interval: 10 })
      .toBeGreaterThanOrEqual(1);
    stopped = true;
    const outcome = await standby;
    expect(outcome).toBeNull();
    await leader!.release();
  });
});
