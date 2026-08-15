import { drizzle } from "drizzle-orm/node-postgres";
import pg, { Pool, type PoolClient } from "pg";

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

export type CreatePoolOptions = {
  /**
   * Called for every absorbed background error. Defaults to a console.warn so
   * packages/db stays dependency-free; apps/runtime can hand its pino logger in
   * without changing any existing call.
   */
  onBackgroundError?: PoolBackgroundErrorHandler;
};

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
  const pool = new Pool({ connectionString });
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

export function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}

export type Database = Omit<ReturnType<typeof createDb>, "$client">;
