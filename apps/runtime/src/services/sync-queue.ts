import type { PgBoss, Queue } from "pg-boss";
import { buildSyncPageExecuteGroupId } from "@agency_hub_core/shared";

export const SYNC_PLANNER_QUEUE = "sync.planner";
export const SYNC_PLANNER_DLQ_QUEUE = "sync.planner.dlq";
export const SYNC_PAGE_EXECUTE_QUEUE = "sync.page.execute";
export const SYNC_PAGE_EXECUTE_DLQ_QUEUE = "sync.page.execute.dlq";
export const RAW_PAYLOAD_CLEANUP_QUEUE = "fansly.raw-payload-cleanup";
export const TELEGRAM_DAILY_REPORT_QUEUE = "telegram.daily-report";

export type SyncTriggerScope = "light" | "followers" | "all" | "data" | "messages";

export interface SyncPageExecutePayload {
  platformAccountId: number;
}

export interface QueueCreationClient {
  createQueue(name: string, options?: Omit<Queue, "name">): Promise<unknown>;
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
      group?: {
        id: string;
      };
    },
  ): Promise<string | null | unknown>;
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
  boss: QueueCreationClient,
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
    ensureQueueCreated(boss, SYNC_PAGE_EXECUTE_QUEUE, {
      policy: "exclusive",
      expireInSeconds: 180,
      heartbeatSeconds: 30,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      deadLetter: SYNC_PAGE_EXECUTE_DLQ_QUEUE,
    }, createdQueues),
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
    dedupe?: boolean;
  },
): Promise<string | null | unknown> {
  return boss.send(
    SYNC_PAGE_EXECUTE_QUEUE,
    { platformAccountId: input.platformAccountId } satisfies SyncPageExecutePayload,
    {
      singletonKey: input.dedupe === false ? undefined : String(input.platformAccountId),
      priority: input.priority,
      group: {
        id: buildSyncPageExecuteGroupId(input.provider, input.egressKey, input.platformAccountId),
      },
    },
  );
}
