import { sql } from "drizzle-orm";

import type { Database } from "@agency_hub_core/db";

import { TARGETED_THREAD_BACKFILL_QUEUE } from "../../services/sync/targeted-thread-backfill.ts";

// Switch phase B (design step 3 §3.5 item 7, §11.1 B, J3): is the legacy
// engine of a page really stopped? One read-only statement over every place a
// legacy request of the page could still be in flight. Lease expiry alone is
// never proof (plan §2.5); the guard row handed to the engine with no holder
// is the catch-all, the rest says the fenced machinery has drained.

/** The `(58213, pageId)` advisory lock of the page's socket (step 1). */
export const FANSLY_WS_OWNERSHIP_LOCK_NAMESPACE = 58_213;

export interface LegacyStopEvidence {
  /** `page_sync_states` rows running under an unexpired lease. */
  runningLeases: number;
  /** `sync_runs` without a finish, started in the last 10 minutes. */
  openRuns: number;
  /** `sync_http_attempts` started in the last 90 s and not finished. */
  openHttp: number;
  /** `fansly_send_log` captures of the last 10 minutes without a completion. */
  openGuarded: number;
  /** Sessions holding the page's socket lock in this database. */
  wsLockHolders: number;
  /** Active `sync.thread.backfill` jobs of the page's chats. */
  activeThreadBackfills: number;
  /** The guard row belongs to the engine and nobody holds it. */
  guardHanded: boolean;
  /** Open legacy connection rows without a lock holder: reported, not
   *  blocking (the engine's first connection closes them `abandoned`). */
  openWsConnections: number;
}

/** Every count 0 and the guard handed. */
export function legacyStopped(evidence: LegacyStopEvidence): boolean {
  return evidence.runningLeases === 0
    && evidence.openRuns === 0
    && evidence.openHttp === 0
    && evidence.openGuarded === 0
    && evidence.wsLockHolders === 0
    && evidence.activeThreadBackfills === 0
    && evidence.guardHanded;
}

/** The first check that fails (null: stopped). */
export function failingStopCheck(evidence: LegacyStopEvidence): string | null {
  if (!evidence.guardHanded) return "guard_not_handed";
  if (evidence.runningLeases > 0) return `running_leases=${evidence.runningLeases}`;
  if (evidence.openRuns > 0) return `open_runs=${evidence.openRuns}`;
  if (evidence.openHttp > 0) return `open_http=${evidence.openHttp}`;
  if (evidence.openGuarded > 0) return `open_guarded=${evidence.openGuarded}`;
  if (evidence.wsLockHolders > 0) return `ws_lock_holders=${evidence.wsLockHolders}`;
  if (evidence.activeThreadBackfills > 0) return `active_thread_backfills=${evidence.activeThreadBackfills}`;
  return null;
}

export async function readLegacyStopEvidence(db: Database, pageId: number): Promise<LegacyStopEvidence> {
  // pg-boss owns its schema; a database without it (a fresh test database)
  // has no backfill job to wait for.
  const boss = await db.execute<{ present: boolean }>(sql`select to_regclass('pgboss.job') is not null as present`);
  const backfills = boss.rows[0]?.present === true
    ? sql`(select count(*)::int from pgboss.job j
             join page_dm_threads t on t.id = (j.data ->> 'threadId')::bigint
            where j.name = ${TARGETED_THREAD_BACKFILL_QUEUE} and j.state = 'active'
              and t.platform_account_id = ${pageId})`
    : sql`0`;
  const result = await db.execute<{
    runningLeases: number;
    openRuns: number;
    openHttp: number;
    openGuarded: number;
    wsLockHolders: number;
    activeThreadBackfills: number;
    guardHanded: boolean | null;
    openWsConnections: number;
  }>(sql`
    select
      (select count(*)::int from page_sync_states
        where page_id = ${pageId} and status = 'running'
          and lease_expires_at > clock_timestamp())                                   as "runningLeases",
      (select count(*)::int from sync_runs
        where page_id = ${pageId} and finished_at is null
          and started_at > clock_timestamp() - interval '10 minutes')                 as "openRuns",
      (select count(*)::int from sync_http_attempts
        where page_id = ${pageId} and state = 'started' and finished_at is null
          and started_at > clock_timestamp() - interval '90 seconds')                 as "openHttp",
      (select count(*)::int from fansly_send_log
        where page_id = ${pageId} and completed_at is null
          and captured_at > clock_timestamp() - interval '10 minutes')                as "openGuarded",
      (select count(*)::int from pg_locks l
        where l.locktype = 'advisory' and l.classid = ${FANSLY_WS_OWNERSHIP_LOCK_NAMESPACE}
          and l.objid = ${pageId} and l.objsubid = 2 and l.granted
          and l.database = (select oid from pg_database where datname = current_database())) as "wsLockHolders",
      ${backfills}                                                                     as "activeThreadBackfills",
      (select owner_engine = 'fansly_sync_engine' and holder_token is null
         from fansly_page_send_guards where page_id = ${pageId})                      as "guardHanded",
      (select count(*)::int from fansly_ws_connections
        where page_id = ${pageId} and closed_at is null)                               as "openWsConnections"
  `);
  const row = result.rows[0]!;
  return {
    runningLeases: Number(row.runningLeases),
    openRuns: Number(row.openRuns),
    openHttp: Number(row.openHttp),
    openGuarded: Number(row.openGuarded),
    wsLockHolders: Number(row.wsLockHolders),
    activeThreadBackfills: Number(row.activeThreadBackfills),
    guardHanded: row.guardHanded === true,
    openWsConnections: Number(row.openWsConnections),
  };
}
