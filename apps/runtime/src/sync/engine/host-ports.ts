import pg from "pg";

import { SYNC_PAGE_OWNERSHIP_LOCK_NAMESPACE, SYNC_WORK_NOTIFY_CHANNEL, type Database } from "@agency_hub_core/db";
import { sql } from "drizzle-orm";

import type { SyncLogger } from "./commit.ts";
import type { Clock, OwnershipSession, Wake } from "./ports.ts";

// The stateful ports of the host (design §3.2, §3.6): the ownership session
// (one dedicated `pg.Client` that holds every page lock of the process) and
// the LISTEN wake (one dedicated `pg.Client` on `fansly_sync_work`). Both are
// plain clients, outside the pool: their session state (advisory locks,
// LISTEN) must never be handed to another caller.

export const SYNC_OWNER_APPLICATION_NAME = "fansly-sync-owner";
export const SYNC_WAKE_APPLICATION_NAME = "fansly-sync-wake";
/** A successful ping younger than this is shared by every actor (§3.2). */
export const PING_SHARE_MS = 1_000;
/** Statement and client timeouts of the ownership session. */
export const OWNERSHIP_SESSION_TIMEOUT_MS = 5_000;
export const WAKE_RECONNECT_MIN_MS = 1_000;
export const WAKE_RECONNECT_MAX_MS = 30_000;

/**
 * The lock session. `alive()` turns false — for good — the moment the client
 * reports `error` or `end`: a lost session is never re-used, the host opens a
 * new one and every page is acquired again through its rules.
 */
export class PgOwnershipSession implements OwnershipSession {
  readonly #client: pg.Client;
  readonly #checkDb: Database;
  readonly #held = new Set<number>();
  #alive = true;
  #backendPid: number | null = null;
  #lastOkMono = Number.NEGATIVE_INFINITY;
  #pingInFlight: Promise<"ok" | "timeout"> | null = null;
  #onLost: (() => void) | null;

  private constructor(client: pg.Client, checkDb: Database, onLost: (() => void) | null) {
    this.#client = client;
    this.#checkDb = checkDb;
    this.#onLost = onLost;
    client.on("error", () => this.#lose());
    client.on("end", () => this.#lose());
  }

  /** Connect a new session. `checkDb` (the pool) answers `stillHolds` from
   *  `pg_locks`, so the re-check never queues behind a stuck ping. */
  static async open(input: {
    connectionString: string;
    checkDb: Database;
    onLost?: () => void;
  }): Promise<PgOwnershipSession> {
    const client = new pg.Client({
      connectionString: input.connectionString,
      application_name: SYNC_OWNER_APPLICATION_NAME,
      connectionTimeoutMillis: OWNERSHIP_SESSION_TIMEOUT_MS,
      query_timeout: OWNERSHIP_SESSION_TIMEOUT_MS,
      statement_timeout: OWNERSHIP_SESSION_TIMEOUT_MS,
    });
    const session = new PgOwnershipSession(client, input.checkDb, input.onLost ?? null);
    try {
      await client.connect();
      const result = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      session.#backendPid = Number(result.rows[0]?.pid ?? 0) || null;
    } catch (error) {
      session.#lose();
      await client.end().catch(() => undefined);
      throw error;
    }
    return session;
  }

  /** The backend pid of the session (tests terminate it). */
  get backendPid(): number | null {
    return this.#backendPid;
  }

  alive(): boolean {
    return this.#alive;
  }

  async ping(timeoutMs: number): Promise<"ok" | "timeout"> {
    if (!this.#alive) return "timeout";
    if (performance.now() - this.#lastOkMono < PING_SHARE_MS) return "ok";
    this.#pingInFlight ??= this.#client.query("select 1")
      .then(() => {
        this.#lastOkMono = performance.now();
        return "ok" as const;
      }, () => "timeout" as const)
      .finally(() => {
        this.#pingInFlight = null;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#pingInFlight,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async stillHolds(pageId: number): Promise<boolean> {
    if (!this.#alive || this.#backendPid === null || !this.#held.has(pageId)) return false;
    try {
      const result = await this.#checkDb.execute<{ held: boolean }>(sql`
        select exists (
          select 1 from pg_locks l
           where l.locktype = 'advisory'
             and l.classid = ${SYNC_PAGE_OWNERSHIP_LOCK_NAMESPACE}::oid
             and l.objid = ${pageId}::oid
             and l.objsubid = 2
             and l.pid = ${this.#backendPid}::int
             and l.granted
        ) as held
      `);
      return result.rows[0]?.held === true;
    } catch {
      return false;
    }
  }

  async tryLock(pageId: number): Promise<boolean> {
    if (!this.#alive) return false;
    if (this.#held.has(pageId)) return true;
    const result = await this.#client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1::int, $2::int) as locked",
      [SYNC_PAGE_OWNERSHIP_LOCK_NAMESPACE, pageId],
    );
    const locked = result.rows[0]?.locked === true;
    if (locked) this.#held.add(pageId);
    return locked;
  }

  async unlock(pageId: number): Promise<void> {
    if (!this.#held.delete(pageId) || !this.#alive) return;
    await this.#client.query(
      "select pg_advisory_unlock($1::int, $2::int)",
      [SYNC_PAGE_OWNERSHIP_LOCK_NAMESPACE, pageId],
    );
  }

  holds(pageId: number): boolean {
    return this.#alive && this.#held.has(pageId);
  }

  async close(): Promise<void> {
    this.#onLost = null;
    this.#lose();
    await this.#client.end().catch(() => undefined);
  }

  #lose(): void {
    if (!this.#alive) return;
    this.#alive = false;
    this.#held.clear();
    const onLost = this.#onLost;
    this.#onLost = null;
    onLost?.();
  }
}

interface Waiter {
  resolve(result: "notified" | "timeout"): void;
}

/**
 * The actors' wake-up: a NOTIFY on `fansly_sync_work` with the page id wakes
 * that page's actor; a notification that finds no waiter is kept for the
 * page's next wait. The listener reconnects 1 → 30 s after a loss; meanwhile
 * every wait still ends by its timeout (≤ 1 s in the actor), so a lost NOTIFY
 * costs at most that (§8).
 */
export class PgWake implements Wake {
  readonly #connectionString: string;
  readonly #logger: SyncLogger;
  readonly #waiters = new Map<number, Set<Waiter>>();
  readonly #pending = new Set<number>();
  #client: pg.Client | null = null;
  #connecting: Promise<void> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectDelayMs = WAKE_RECONNECT_MIN_MS;
  #closed = false;
  /** Notifications received (tests). */
  notifications = 0;

  constructor(input: { connectionString: string; logger: SyncLogger }) {
    this.#connectionString = input.connectionString;
    this.#logger = input.logger;
  }

  get listening(): boolean {
    return this.#client !== null;
  }

  start(): Promise<void> {
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  wait(pageId: number, ms: number, signal: AbortSignal): Promise<"notified" | "timeout"> {
    if (this.#pending.delete(pageId)) return Promise.resolve("notified");
    if (signal.aborted || !(ms > 0)) return Promise.resolve("timeout");
    return new Promise((resolve) => {
      let set = this.#waiters.get(pageId);
      if (set === undefined) {
        set = new Set();
        this.#waiters.set(pageId, set);
      }
      const waiters = set;
      const finish = (result: "notified" | "timeout") => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        waiters.delete(waiter);
        resolve(result);
      };
      const waiter: Waiter = { resolve: finish };
      const onAbort = () => finish("timeout");
      const timer = setTimeout(() => finish("timeout"), ms);
      signal.addEventListener("abort", onAbort, { once: true });
      waiters.add(waiter);
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    const client = this.#client;
    this.#client = null;
    await client?.end().catch(() => undefined);
    for (const set of this.#waiters.values()) for (const waiter of [...set]) waiter.resolve("timeout");
  }

  #notify(pageId: number): void {
    this.notifications += 1;
    const set = this.#waiters.get(pageId);
    if (set === undefined || set.size === 0) {
      this.#pending.add(pageId);
      return;
    }
    for (const waiter of [...set]) waiter.resolve("notified");
  }

  async #connect(): Promise<void> {
    if (this.#closed || this.#client !== null) return;
    const client = new pg.Client({
      connectionString: this.#connectionString,
      application_name: SYNC_WAKE_APPLICATION_NAME,
      connectionTimeoutMillis: OWNERSHIP_SESSION_TIMEOUT_MS,
    });
    const lost = () => {
      if (this.#client !== client) return;
      this.#client = null;
      client.end().catch(() => undefined);
      this.#scheduleReconnect();
    };
    client.on("error", lost);
    client.on("end", lost);
    client.on("notification", (message) => {
      if (message.channel !== SYNC_WORK_NOTIFY_CHANNEL) return;
      const pageId = Number(message.payload);
      if (Number.isSafeInteger(pageId) && pageId > 0) this.#notify(pageId);
    });
    try {
      await client.connect();
      await client.query(`listen ${SYNC_WORK_NOTIFY_CHANNEL}`);
      if (this.#closed) {
        await client.end().catch(() => undefined);
        return;
      }
      this.#client = client;
      this.#reconnectDelayMs = WAKE_RECONNECT_MIN_MS;
    } catch (error) {
      await client.end().catch(() => undefined);
      this.#logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "Fansly sync: LISTEN connect failed; retrying");
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer !== null) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.start();
    }, this.#reconnectDelayMs);
    this.#reconnectTimer.unref?.();
    this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, WAKE_RECONNECT_MAX_MS);
  }
}

/** A wake without LISTEN: every wait runs to its timeout (tests, tools). */
export function createTimerWake(clock: Clock): Wake {
  return {
    async wait(_pageId, ms, signal) {
      await clock.sleep(ms, signal).catch(() => undefined);
      return "timeout";
    },
  };
}
