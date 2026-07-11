import type { Db as PgBossDb, PgBoss, Queue } from "pg-boss";
import { buildSyncPageExecuteGroupId } from "@agency_hub_core/shared";

export const SYNC_PLANNER_QUEUE = "sync.planner";
export const SYNC_PLANNER_DLQ_QUEUE = "sync.planner.dlq";
export const SYNC_PAGE_EXECUTE_QUEUE = "sync.page.execute";
export const SYNC_PAGE_EXECUTE_DLQ_QUEUE = "sync.page.execute.dlq";
// The old 180s hard expiry exactly overlapped the observed OFAPI poison-chat
// path (three 60s single-attempt reads). pg-boss expiry is not extended by
// touch, so use conservative operational headroom above today's observed
// 3x60s / 4x60s paths. This is not a mathematical request deadline: the
// one-chunk/job contract and safe-handoff guard contain an overrun.
export const SYNC_PAGE_EXECUTE_EXPIRE_SECONDS = 15 * 60;
// page_sync_states is the durable retry/reconciliation authority. Queue jobs
// are disposable wakeups, so pg-boss must never retry the same job id: doing
// so creates an ABA window where a late attempt can complete a newer retry.
export const SYNC_PAGE_EXECUTE_RETRY_LIMIT = 0;
export const RAW_PAYLOAD_CLEANUP_QUEUE = "fansly.raw-payload-cleanup";
export const TELEGRAM_DAILY_REPORT_QUEUE = "telegram.daily-report";
export const WORKBOARD_RECOMPUTE_QUEUE = "workboard.recompute";
export const WORKBOARD_CLASSIFY_QUEUE = "workboard.classify-closing";
// Stage 23: debounced per-fan recompute driven by domain events.
export const WORKBOARD_FAN_RECOMPUTE_QUEUE = "workboard.fan-recompute";

export type SyncTriggerScope = "light" | "followers" | "all" | "data" | "messages";

export interface SyncPageExecutePayload {
  platformAccountId: number;
}

export interface QueueCreationClient {
  createQueue(name: string, options?: Omit<Queue, "name">): Promise<unknown>;
  updateQueue?(
    name: string,
    options: Omit<Queue, "name" | "partition" | "policy">,
  ): Promise<unknown>;
  getQueue?(name: string): Promise<Queue | null>;
  schedule?(
    name: string,
    cron: string,
    data?: object | null,
    options?: {
      tz?: string;
      key?: string;
    },
  ): Promise<unknown>;
  send?(
    name: string,
    data?: object | null,
    options?: {
      singletonKey?: string;
      priority?: number;
      startAfter?: number | string | Date;
      group?: {
        id: string;
      };
      expireInSeconds?: number;
      retryLimit?: number;
      db?: PgBossDb;
    },
  ): Promise<string | null | unknown>;
}

export interface SyncQueueLifecycleClient extends QueueCreationClient {
  updateQueue(
    name: string,
    options: Omit<Queue, "name" | "partition" | "policy">,
  ): Promise<unknown>;
  getQueue(name: string): Promise<Queue | null>;
}

const syncPageExecuteQueueOptions = {
  policy: "exclusive",
  expireInSeconds: SYNC_PAGE_EXECUTE_EXPIRE_SECONDS,
  heartbeatSeconds: 30,
  retryLimit: SYNC_PAGE_EXECUTE_RETRY_LIMIT,
  retryDelay: 30,
  retryBackoff: true,
  deadLetter: SYNC_PAGE_EXECUTE_DLQ_QUEUE,
} satisfies Omit<Queue, "name">;

async function reconcileSyncPageExecuteQueue(boss: SyncQueueLifecycleClient) {
  // pg-boss createQueue is INSERT ... ON CONFLICT DO NOTHING. Without this
  // explicit update, production keeps whatever mutable values existed when
  // the queue was first created (the incident queue remained at 180s/2).
  await boss.updateQueue(SYNC_PAGE_EXECUTE_QUEUE, {
    expireInSeconds: syncPageExecuteQueueOptions.expireInSeconds,
    heartbeatSeconds: syncPageExecuteQueueOptions.heartbeatSeconds,
    retryLimit: syncPageExecuteQueueOptions.retryLimit,
    retryDelay: syncPageExecuteQueueOptions.retryDelay,
    retryBackoff: syncPageExecuteQueueOptions.retryBackoff,
    deadLetter: syncPageExecuteQueueOptions.deadLetter,
  });

  const queue = await boss.getQueue(SYNC_PAGE_EXECUTE_QUEUE);
  if (!queue) {
    throw new Error(`Queue ${SYNC_PAGE_EXECUTE_QUEUE} was not readable after reconciliation`);
  }

  if (
    queue.policy !== syncPageExecuteQueueOptions.policy ||
    queue.expireInSeconds !== syncPageExecuteQueueOptions.expireInSeconds ||
    queue.heartbeatSeconds !== syncPageExecuteQueueOptions.heartbeatSeconds ||
    queue.retryLimit !== syncPageExecuteQueueOptions.retryLimit
  ) {
    throw new Error(
      `Queue ${SYNC_PAGE_EXECUTE_QUEUE} configuration drift: expected ` +
      `policy=${syncPageExecuteQueueOptions.policy}, ` +
      `expireInSeconds=${syncPageExecuteQueueOptions.expireInSeconds}, ` +
      `heartbeatSeconds=${syncPageExecuteQueueOptions.heartbeatSeconds}, ` +
      `retryLimit=${syncPageExecuteQueueOptions.retryLimit}`,
    );
  }
}

export async function ensureQueueCreated(
  boss: QueueCreationClient,
  queueName: string,
  options?: Omit<Queue, "name">,
  createdQueues?: Set<string>,
) {
  if (createdQueues?.has(queueName)) {
    return;
  }

  await boss.createQueue(queueName, options);
  createdQueues?.add(queueName);
}

export async function ensureSyncQueues(
  boss: SyncQueueLifecycleClient,
  createdQueues?: Set<string>,
) {
  await Promise.all([
    ensureQueueCreated(boss, SYNC_PLANNER_DLQ_QUEUE, {
      policy: "standard",
      retentionSeconds: 1_209_600,
    }, createdQueues),
    ensureQueueCreated(boss, SYNC_PAGE_EXECUTE_DLQ_QUEUE, {
      policy: "standard",
      retentionSeconds: 1_209_600,
    }, createdQueues),
  ]);

  await Promise.all([
    ensureQueueCreated(boss, SYNC_PLANNER_QUEUE, {
      policy: "exclusive",
      expireInSeconds: 120,
      heartbeatSeconds: 30,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      deadLetter: SYNC_PLANNER_DLQ_QUEUE,
    }, createdQueues),
    ensureQueueCreated(boss, SYNC_PAGE_EXECUTE_QUEUE, syncPageExecuteQueueOptions, createdQueues),
    ensureQueueCreated(boss, RAW_PAYLOAD_CLEANUP_QUEUE, {
      policy: "standard",
    }, createdQueues),
    ensureQueueCreated(boss, TELEGRAM_DAILY_REPORT_QUEUE, {
      policy: "standard",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
    }, createdQueues),
  ]);

  await reconcileSyncPageExecuteQueue(boss);
}

export async function ensurePlannerSchedule(
  boss: QueueCreationClient,
) {
  if (!boss.schedule) {
    return;
  }

  await boss.schedule(SYNC_PLANNER_QUEUE, "* * * * *");
}

export async function ensureTelegramDailyReportSchedule(
  boss: QueueCreationClient,
) {
  if (!boss.schedule) {
    return;
  }

  await boss.schedule(TELEGRAM_DAILY_REPORT_QUEUE, "0 * * * *", null, {
    tz: "UTC",
  });
}

export async function ensureWorkboardQueues(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(boss, WORKBOARD_FAN_RECOMPUTE_QUEUE, {
    policy: "standard",
    retryLimit: 3,
    retryDelay: 30,
  }, createdQueues);
  await ensureQueueCreated(boss, WORKBOARD_RECOMPUTE_QUEUE, {
    policy: "standard",
    retryLimit: 1,
    retryDelay: 60,
  }, createdQueues);
  await ensureQueueCreated(boss, WORKBOARD_CLASSIFY_QUEUE, {
    policy: "standard",
    retryLimit: 1,
    retryDelay: 120,
  }, createdQueues);
}

export async function ensureWorkboardRecomputeSchedule(
  boss: QueueCreationClient,
) {
  if (!boss.schedule) {
    return;
  }

  // Closing classification at 01:00 UTC (fresh verdicts feed the 03:00 recompute);
  // recompute itself at 03:00 UTC (after spend rollups settle).
  await boss.schedule(WORKBOARD_CLASSIFY_QUEUE, "0 1 * * *", null, { tz: "UTC" });
  await boss.schedule(WORKBOARD_RECOMPUTE_QUEUE, "0 3 * * *", null, { tz: "UTC" });
}

export async function sendSyncPlannerWakeup(
  boss: Pick<PgBoss, "send">,
): Promise<string | null> {
  return boss.send(SYNC_PLANNER_QUEUE);
}

export async function sendSyncPageWakeup(
  boss: Pick<PgBoss, "send">,
  input: {
    platformAccountId: number;
    priority: number;
    provider: "fansly" | "onlyfans";
    egressKey: string;
    db?: PgBossDb;
  },
): Promise<string | null> {
  return boss.send(
    SYNC_PAGE_EXECUTE_QUEUE,
    { platformAccountId: input.platformAccountId } satisfies SyncPageExecutePayload,
    {
      // Exactly one wakeup lane per page. Delays live durably in
      // page_sync_states.retry_at and are materialized by the planner only
      // when due; a deferred queue singleton must never block urgent work.
      singletonKey: String(input.platformAccountId),
      priority: input.priority,
      expireInSeconds: SYNC_PAGE_EXECUTE_EXPIRE_SECONDS,
      retryLimit: SYNC_PAGE_EXECUTE_RETRY_LIMIT,
      group: {
        id: buildSyncPageExecuteGroupId(input.provider, input.egressKey),
      },
      ...(input.db ? { db: input.db } : {}),
    },
  );
}
