import type { Pool, PoolClient } from "pg";

// Kernel Stage 25: scheduler leader election. One session-level advisory
// lock names the active scheduler; a standby boots, fails to acquire, and
// retries on an interval (stateless — takeover is just the next successful
// acquire after the leader's session dies). Namespace 58212 (58211 is the
// Stage-3-era OFAPI event-worker singleton, deleted in this stage's Task 4).

export const SCHEDULER_LEADER_LOCK_NS = 58212;
export const SCHEDULER_LEADER_LOCK_KEY = 1;
export const SCHEDULER_STANDBY_RETRY_MS = 10_000;

export interface SchedulerLeaderHandle {
  /** Resolves when leadership is LOST (session/connection death). */
  lost: Promise<void>;
  release(): Promise<void>;
}

export interface SchedulerLeaderOptions {
  pool: Pool;
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Standby heartbeat — called after every failed acquire attempt. */
  onStandby?: () => void;
  /** Abort standby waiting (shutdown). */
  isStopped?: () => boolean;
}

/**
 * Blocks until this process becomes the scheduler leader (or `isStopped`).
 * The advisory lock is session-scoped: the returned handle pins the pg client
 * for the whole leadership; losing the connection loses the lock, and `lost`
 * resolves so the caller can exit for a supervised restart.
 */
export async function acquireSchedulerLeadership(
  options: SchedulerLeaderOptions,
): Promise<SchedulerLeaderHandle | null> {
  const retryMs = options.retryMs ?? SCHEDULER_STANDBY_RETRY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (;;) {
    if (options.isStopped?.()) {
      return null;
    }
    let client: PoolClient;
    try {
      client = await options.pool.connect();
    } catch {
      await sleep(retryMs);
      continue;
    }
    let acquired = false;
    try {
      const result = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock($1, $2) as locked",
        [SCHEDULER_LEADER_LOCK_NS, SCHEDULER_LEADER_LOCK_KEY],
      );
      acquired = result.rows[0]?.locked === true;
    } catch {
      client.release();
      await sleep(retryMs);
      continue;
    }
    if (!acquired) {
      client.release();
      options.onStandby?.();
      await sleep(retryMs);
      continue;
    }

    let resolveLost: () => void;
    const lost = new Promise<void>((resolve) => {
      resolveLost = resolve;
    });
    const onDeath = (): void => resolveLost();
    client.on("error", onDeath);
    // 'end' fires when the underlying connection closes for any reason.
    (client as unknown as { connection?: { on(event: string, fn: () => void): void } })
      .connection?.on("end", onDeath);

    return {
      lost,
      async release() {
        client.removeListener("error", onDeath);
        try {
          await client.query("select pg_advisory_unlock($1, $2)", [
            SCHEDULER_LEADER_LOCK_NS,
            SCHEDULER_LEADER_LOCK_KEY,
          ]);
        } catch {
          // The session dying releases the lock anyway.
        }
        // Destroy rather than return to the pool — the session carried lock state.
        client.release(true);
        resolveLost();
      },
    };
  }
}
