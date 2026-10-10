import { drizzle } from "drizzle-orm/node-postgres";
import pg, { Pool, type Client, type PoolClient } from "pg";

import * as schema from "./schema.ts";

pg.types.setTypeParser(20, (value: string) => BigInt(value));

/**
 * Where a pooled connection was when node-postgres raised an error that belongs
 * to no query — i.e. what the failure costs us.
 *
 * - "idle": a spare connection died while parked in the pool (a Postgres
 *   restart/failover kills every one of them). pg has already dropped it and
 *   dials a replacement on the next checkout; nothing else is affected.
 * - "checked-out": a connection someone is holding died between its queries
 *   (e.g. mid-transaction). That holder's next query fails, so this one is
 *   worth reading in the logs.
 */
export type PoolBackgroundErrorScope = "idle" | "checked-out";

export type PoolBackgroundErrorEvent = {
  scope: PoolBackgroundErrorScope;
  /** SQLSTATE when the backend sent one ("57P01" on a terminate), else a Node errno, else undefined. */
  code: string | undefined;
  message: string;
  error: unknown;
};

export type PoolBackgroundErrorHandler = (event: PoolBackgroundErrorEvent) => void;

/**
 * Bounds that turn a hung database call into an error the caller already
 * handles. Without them (the default) node-postgres waits for a connection,
 * and Postgres runs a statement, waits for a lock and keeps an idle
 * transaction open, for ever.
 */
export type PoolTimeouts = {
  /** A checkout (a free connection, or a new dial) that takes longer fails. */
  connectionTimeoutMillis: number;
  /** Server side, per session: `statement_timeout`. */
  statementTimeoutMs: number;
  /** Server side, per session: `lock_timeout`. */
  lockTimeoutMs: number;
  /** Server side, per session: `idle_in_transaction_session_timeout`. */
  idleInTransactionSessionTimeoutMs: number;
};

/**
 * How long a pooled connection lives. node-postgres closes an idle one after
 * 10 s, which suits a one-shot command: its open sockets would otherwise keep
 * the process alive. A role that queries every few seconds pays for it in new
 * sessions instead (prod 2026-10-10: ~31 a minute across the roles, each a
 * fork, a SCRAM exchange and a cold catalog cache in a new backend).
 */
export type PoolLifetime = {
  /** An idle connection closes after this long. */
  idleTimeoutMillis: number;
  /** A connection is retired, once idle, after this long, so a backend's
   *  caches cannot grow for the life of the process. */
  maxLifetimeSeconds: number;
};

/** The long-lived roles' pools (api, worker, scheduler, sync), pg-boss's included. */
export const RUNTIME_POOL_LIFETIME: PoolLifetime = {
  idleTimeoutMillis: 5 * 60_000,
  maxLifetimeSeconds: 60 * 60,
};

export type CreatePoolOptions = {
  /**
   * Called for every absorbed background error. Defaults to a console.warn so
   * packages/db stays dependency-free; apps/runtime can hand its pino logger in
   * without changing any existing call.
   */
  onBackgroundError?: PoolBackgroundErrorHandler;
  /** Every connection of the pool starts its session with these. */
  timeouts?: PoolTimeouts;
  /** Absent: node-postgres' defaults (idle 10 s, no lifetime cap). */
  lifetime?: PoolLifetime;
};

/** The server-side timeouts a pooled session runs with, as Postgres reports
 *  them (`current_setting`: `1min`, `30s`, `0` for none). */
export type PoolSessionTimeouts = {
  statementTimeout: string;
  lockTimeout: string;
  idleInTransactionSessionTimeout: string;
};

export async function readPoolSessionTimeouts(pool: Pool): Promise<PoolSessionTimeouts> {
  const result = await pool.query<PoolSessionTimeouts>(`
    select current_setting('statement_timeout') as "statementTimeout",
           current_setting('lock_timeout') as "lockTimeout",
           current_setting('idle_in_transaction_session_timeout') as "idleInTransactionSessionTimeout"
  `);
  const row = result.rows[0];
  if (row === undefined) throw new Error("current_setting returned no row");
  return row;
}

function readErrorCode(error: unknown) {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function warnBackgroundError(event: PoolBackgroundErrorEvent) {
  console.warn(
    `[db.pool] background error absorbed (scope=${event.scope}, code=${event.code ?? "none"}): ${event.message}`,
  );
}

/**
 * A pg Pool that survives Postgres restarts.
 *
 * node-postgres routes a backend error to the query that caused it whenever one
 * is in flight, and only then. With no query in flight it emits 'error' on the
 * client instead — and an EventEmitter 'error' with no listener THROWS, which
 * took whole api/worker processes down on a Postgres restart. pg's own listener
 * covers a client only while it sits idle in the pool (and just re-emits on the
 * Pool, where an unhandled 'error' throws just the same); a checked-out client
 * has no listener at all, so a 57P01 between two queries was an uncaught
 * exception.
 *
 * So both are absorbed here, and nothing that belongs to a query is: a query's
 * rejection is pg's own path and is untouched — for a socket-level failure pg
 * both rejects the in-flight query AND emits the event, and only the duplicate
 * event is swallowed.
 */
export function createPool(connectionString: string, options: CreatePoolOptions = {}) {
  const timeouts = options.timeouts;
  const pool = new Pool({
    connectionString,
    ...(timeouts === undefined ? {} : {
      connectionTimeoutMillis: timeouts.connectionTimeoutMillis,
      statement_timeout: timeouts.statementTimeoutMs,
      lock_timeout: timeouts.lockTimeoutMs,
      idle_in_transaction_session_timeout: timeouts.idleInTransactionSessionTimeoutMs,
    }),
    ...(options.lifetime === undefined ? {} : {
      idleTimeoutMillis: options.lifetime.idleTimeoutMillis,
      maxLifetimeSeconds: options.lifetime.maxLifetimeSeconds,
    }),
  });
  const report = options.onBackgroundError ?? warnBackgroundError;
  // pg re-emits an idle client's error on the Pool, so the same Error object can
  // reach both listeners below: report it once.
  const reported = new WeakSet<object>();
  const checkedOut = new WeakSet<PoolClient>();

  const absorb = (scope: PoolBackgroundErrorScope, error: unknown) => {
    if (typeof error === "object" && error !== null) {
      if (reported.has(error)) {
        return;
      }
      reported.add(error);
    }

    try {
      report({ scope, code: readErrorCode(error), message: readErrorMessage(error), error });
    } catch {
      // A logger that throws must not become the crash this handler exists to prevent.
    }
  };

  pool.on("acquire", (client) => {
    checkedOut.add(client);
  });
  pool.on("release", (_error, client) => {
    checkedOut.delete(client);
  });

  // The listener whose absence is the crash: every new client keeps one for its
  // whole life, including the stretch when pg has removed its own.
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      absorb(checkedOut.has(client) ? "checked-out" : "idle", error);
    });
  });

  // pg's documented channel for an idle client's error. The listener above
  // normally reports first (it is attached to the client itself), so this one is
  // usually the deduped duplicate — but it must exist, or the re-emit throws.
  pool.on("error", (error) => {
    absorb("idle", error);
  });

  return pool;
}

/** A database over the pool, or over one dedicated client (a session of its
 *  own that no pool checkout can block). */
export function createDb(client: Pool | Client) {
  return drizzle(client, { schema });
}

export type Database = Omit<ReturnType<typeof createDb>, "$client">;
