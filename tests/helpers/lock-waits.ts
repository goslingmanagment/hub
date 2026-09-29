import { setTimeout as sleep } from "node:timers/promises";

import type { Pool } from "pg";

/**
 * Condition waits for lock-ordering tests: wait until a contender is PROVABLY
 * parked on a lock, instead of sleeping a fixed time and assuming it got there.
 * A poll is stronger than the sleep it replaces (the sleep passed even when the
 * contender never blocked) and returns as soon as the state holds.
 *
 * Scope matters. Test databases are clones inside one cluster, and pg_locks
 * spans the cluster.
 * - A ROW-lock wait shows up in pg_locks as an ungranted `transactionid` (or
 *   `tuple`) lock whose `database` column is NULL, so a `pg_locks.database`
 *   filter never matches it. Row waits are scoped through
 *   `pg_stat_activity.datname` instead.
 * - A TABLE-lock wait does carry `pg_locks.database`, and clones share relation
 *   OIDs, so table waits are scoped by that column.
 */

type Queryable = Pick<Pool, "query">;

export interface LockWaitOptions {
  /** The operation expected to block. If it settles before the wait is seen,
   * it never waited, and the helper fails at once instead of timing out. */
  blocked?: Promise<unknown>;
  timeoutMs?: number;
}

async function pollUntil(
  check: () => Promise<boolean>,
  what: string,
  options: LockWaitOptions,
): Promise<void> {
  let settled = false;
  options.blocked?.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  for (;;) {
    if (await check()) {
      return;
    }
    if (settled) {
      throw new Error(`the blocked operation settled before ${what} was observed`);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(10);
  }
}

/** Resolves once another backend of THIS database waits on a heavyweight lock
 * while running a statement whose text matches every ILIKE pattern (none: any
 * waiter). pg_stat_activity truncates the text at track_activity_query_size
 * (1 kB by default), so a pattern must sit near the start of the statement. */
export function waitForRowLockWait(
  pool: Queryable,
  queryLike: readonly string[],
  options: LockWaitOptions = {},
): Promise<void> {
  return pollUntil(async () => {
    const { rows } = await pool.query<{ waiting: boolean }>(
      `select exists (
         select 1 from pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()
            and wait_event_type = 'Lock'
            and query ilike all ($1::text[])
       ) as waiting`,
      [queryLike],
    );
    return rows[0]?.waiting === true;
  }, `a lock wait on a statement like ${queryLike.join(" + ")}`, options);
}

/** Resolves once some backend of THIS database waits for a table lock on the
 * named relation. */
export function waitForRelationLockWait(
  pool: Queryable,
  relation: string,
  options: LockWaitOptions = {},
): Promise<void> {
  return pollUntil(async () => {
    const { rows } = await pool.query<{ waiting: boolean }>(
      `select exists (
         select 1 from pg_locks l
           join pg_class c on c.oid = l.relation
          where l.locktype = 'relation'
            and not l.granted
            and c.relname = $1
            and l.database = (select oid from pg_database where datname = current_database())
       ) as waiting`,
      [relation],
    );
    return rows[0]?.waiting === true;
  }, `a table lock wait on ${relation}`, options);
}

/** True when the promise has already settled. A settled promise's reactions
 * run in microtasks, which all drain before the setImmediate macrotask. */
export async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol("pending");
  const outcome = await Promise.race([
    promise.then(() => true, () => true),
    new Promise<symbol>((resolve) => setImmediate(() => resolve(pending))),
  ]);
  return outcome !== pending;
}
