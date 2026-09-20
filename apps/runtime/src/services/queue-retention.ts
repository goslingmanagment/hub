/**
 * S7 lifecycle pin: the ONE table that decides how long pg-boss keeps job rows.
 *
 * Why a table and not per-call-site options:
 *
 * 1. `createQueue` is `INSERT ... ON CONFLICT DO NOTHING` (pg-boss@12
 *    `plans.js:381`). Retention passed at a call site therefore only ever
 *    applies to a queue that does not exist yet — every production queue was
 *    already born, so the ONLY way to move it is `updateQueue`. That is what
 *    `reconcileQueueRetention` (sync-queue.ts) does with this table, on every
 *    boot of every role.
 * 2. Unpinned queues inherit library defaults (14d retention / 7d deletion,
 *    `QUEUE_DEFAULTS` in `plans.js:24`). A pg-boss upgrade may move those
 *    numbers silently; pinning every queue makes that a no-op instead of a
 *    surprise change in how much history the database carries.
 *
 * Effective deletion cadence is `deleteAfterSeconds` PLUS up to one
 * maintenance interval, so the three runtime roles construct PgBoss with
 * `maintenanceIntervalSeconds: 3600` (default is 24h — a 24h retention would
 * otherwise mean up to 48h of rows).
 *
 * Queue names are literals on purpose: this module must stay a leaf. Every
 * module that owns a queue name imports `ensureQueueCreated` from
 * `sync-queue.ts`, so importing those constants back into the table's module
 * would close an import cycle and hit the TDZ of a `const` still being
 * evaluated (a boot-time ReferenceError). The literals are pinned against the
 * real exported constants by `tests/queue-retention.test.ts` (static source
 * read) and by `tests/queue-retention.integration.test.ts`, which asserts that
 * every name here belongs to a queue the real `ensure*Queues` functions create.
 */

/** 24h — a heartbeat tick older than a day is worthless to replay. */
export const HEARTBEAT_RETENTION_SECONDS = 86_400;
/** pg-boss QUEUE_DEFAULTS.retention_seconds today (14 days). */
export const DEFAULT_RETENTION_SECONDS = 1_209_600;
/** pg-boss QUEUE_DEFAULTS.deletion_seconds today (7 days). */
export const DEFAULT_DELETE_AFTER_SECONDS = 604_800;
/**
 * Floor for anything a human or a business process would notice missing. A
 * queued cron tick is DISCARDED once `keep_until` passes (`plans.js:1163`,
 * `state < active AND keep_until < now()`), so retention shorter than the
 * longest tolerable outage silently drops the tick — for the observations
 * partition creator that is an incident, not a cleanup.
 */
export const BUSINESS_CRON_MIN_RETENTION_SECONDS = 604_800;

export type QueueRetentionClass =
  /** A: minutely/every-few-minutes heartbeats. Stale ticks have no value. */
  | "heartbeat-cron"
  /** B: real work. Job rows are a forensics surface — keep the defaults, pinned. */
  | "work"
  /** C: daily/hourly business crons. Retention must clear a plausible outage. */
  | "business-cron"
  /** D: dead letters. Never fetched, so `completed_on` stays NULL and
   *  `deleteAfterSeconds` cannot apply — only retention governs them. */
  | "dead-letter";

export interface QueueRetentionSetting {
  readonly queue: string;
  readonly retentionClass: QueueRetentionClass;
  /** Seconds a job may sit in created/retry before it is deleted. */
  readonly retentionSeconds: number;
  /**
   * Seconds a COMPLETED job is kept. Omitted only for dead letters, whose
   * rows never complete: setting it there would be a no-op that reads like a
   * policy.
   */
  readonly deleteAfterSeconds?: number;
}

export const QUEUE_RETENTION_SETTINGS: readonly QueueRetentionSetting[] = [
  { queue: "ofapi.collection.run", retentionClass: "work", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },
  { queue: "ofapi.collection.sweep", retentionClass: "heartbeat-cron", retentionSeconds: HEARTBEAT_RETENTION_SECONDS, deleteAfterSeconds: HEARTBEAT_RETENTION_SECONDS },
  // ---- Class A: pure cron heartbeats (24h / 24h) -------------------------
  { queue: "ofapi.media.sweep", retentionClass: "heartbeat-cron", retentionSeconds: HEARTBEAT_RETENTION_SECONDS, deleteAfterSeconds: HEARTBEAT_RETENTION_SECONDS },
  { queue: "ofapi.typed-export.sweep", retentionClass: "heartbeat-cron", retentionSeconds: HEARTBEAT_RETENTION_SECONDS, deleteAfterSeconds: HEARTBEAT_RETENTION_SECONDS },
  { queue: "sync.planner", retentionClass: "heartbeat-cron", retentionSeconds: HEARTBEAT_RETENTION_SECONDS, deleteAfterSeconds: HEARTBEAT_RETENTION_SECONDS },
  { queue: "ops.metrics.sample", retentionClass: "heartbeat-cron", retentionSeconds: HEARTBEAT_RETENTION_SECONDS, deleteAfterSeconds: HEARTBEAT_RETENTION_SECONDS },
  { queue: "voice.notes.sweep", retentionClass: "heartbeat-cron", retentionSeconds: HEARTBEAT_RETENTION_SECONDS, deleteAfterSeconds: HEARTBEAT_RETENTION_SECONDS },
  { queue: "ofapi.commands.sweep", retentionClass: "heartbeat-cron", retentionSeconds: HEARTBEAT_RETENTION_SECONDS, deleteAfterSeconds: HEARTBEAT_RETENTION_SECONDS },
  { queue: "notifications.delivery-outbox.sweep", retentionClass: "heartbeat-cron", retentionSeconds: HEARTBEAT_RETENTION_SECONDS, deleteAfterSeconds: HEARTBEAT_RETENTION_SECONDS },
  { queue: "canonicalize.sweep", retentionClass: "heartbeat-cron", retentionSeconds: HEARTBEAT_RETENTION_SECONDS, deleteAfterSeconds: HEARTBEAT_RETENTION_SECONDS },
  { queue: "projections.dm-reconcile.sweep", retentionClass: "heartbeat-cron", retentionSeconds: HEARTBEAT_RETENTION_SECONDS, deleteAfterSeconds: HEARTBEAT_RETENTION_SECONDS },
  { queue: "ofapi.events.sweep", retentionClass: "heartbeat-cron", retentionSeconds: HEARTBEAT_RETENTION_SECONDS, deleteAfterSeconds: HEARTBEAT_RETENTION_SECONDS },
  { queue: "projections.message-archive.sweep", retentionClass: "heartbeat-cron", retentionSeconds: HEARTBEAT_RETENTION_SECONDS, deleteAfterSeconds: HEARTBEAT_RETENTION_SECONDS },
  { queue: "agent.hydration.execute", retentionClass: "heartbeat-cron", retentionSeconds: HEARTBEAT_RETENTION_SECONDS, deleteAfterSeconds: HEARTBEAT_RETENTION_SECONDS },
  { queue: "projections.debt.sweep", retentionClass: "heartbeat-cron", retentionSeconds: HEARTBEAT_RETENTION_SECONDS, deleteAfterSeconds: HEARTBEAT_RETENTION_SECONDS },

  // ---- Class B: real work queues (14d / 7d, pinned defaults) -------------
  { queue: "sync.page.execute", retentionClass: "work", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },
  { queue: "sync.thread.backfill", retentionClass: "work", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },
  { queue: "ofapi.commands.execute", retentionClass: "work", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },
  { queue: "ofapi.events.process.v2", retentionClass: "work", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },

  // ---- Class C: daily/hourly business crons (14d / 7d, floor 7d) ---------
  { queue: "telegram.daily-report", retentionClass: "business-cron", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },
  { queue: "fansly.raw-payload-cleanup", retentionClass: "business-cron", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },
  { queue: "ofapi.credits.accrual", retentionClass: "business-cron", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },
  { queue: "ofapi.credits.reconcile", retentionClass: "business-cron", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },
  { queue: "ofapi.credits.balance-ping", retentionClass: "business-cron", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },
  { queue: "observations.partitions.ensure", retentionClass: "business-cron", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },
  { queue: "retention-tiering", retentionClass: "business-cron", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },
  { queue: "ofapi.chargebacks.reconcile", retentionClass: "business-cron", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },
  { queue: "ofapi.pending.reconcile", retentionClass: "business-cron", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },
  { queue: "ofapi.link-stats.reconcile", retentionClass: "business-cron", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },
  { queue: "ofapi.events.cleanup", retentionClass: "business-cron", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },
  { queue: "ofapi.dm-analytics.rebuild", retentionClass: "business-cron", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },
  { queue: "db.disk-usage.check", retentionClass: "business-cron", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },
  { queue: "capture.payload.parity.verify", retentionClass: "business-cron", retentionSeconds: DEFAULT_RETENTION_SECONDS, deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS },

  // ---- Class D: dead letters (14d retention, no deletion clock) ----------
  { queue: "sync.planner.dlq", retentionClass: "dead-letter", retentionSeconds: DEFAULT_RETENTION_SECONDS },
  { queue: "sync.page.execute.dlq", retentionClass: "dead-letter", retentionSeconds: DEFAULT_RETENTION_SECONDS },
];

/**
 * The exact whitelist `updateQueue` accepts. pg-boss THROWS on `policy` and
 * `partition` (`manager.js:677-683`), so a queue's creation options must never
 * be spread into an update — the payload is rebuilt field by field here.
 */
export function queueRetentionUpdate(
  setting: QueueRetentionSetting,
): { retentionSeconds: number; deleteAfterSeconds?: number } {
  return setting.deleteAfterSeconds === undefined
    ? { retentionSeconds: setting.retentionSeconds }
    : {
      retentionSeconds: setting.retentionSeconds,
      deleteAfterSeconds: setting.deleteAfterSeconds,
    };
}
