export const SYNC_TRIGGER_QUEUE = "sync.trigger";
export const RAW_PAYLOAD_CLEANUP_QUEUE = "fansly.raw-payload-cleanup";

export type SyncTriggerScope = "light" | "followers" | "all";

export interface SyncTriggerPayload {
  pageLabel: string;
  scope: SyncTriggerScope;
}

export interface QueueCreationClient {
  createQueue(name: string): Promise<unknown>;
}

export interface SyncTriggerQueueClient extends QueueCreationClient {
  send(name: string, data: SyncTriggerPayload): Promise<unknown>;
}

export function lightQueueName(page: { label: string; platform: "fansly" | "onlyfans" }) {
  return `${page.platform}.sync.light.${page.label}`;
}

export function followerQueueName(page: { label: string }) {
  return `fansly.sync.followers.${page.label}`;
}

export async function ensureQueueCreated(
  boss: QueueCreationClient,
  queueName: string,
  createdQueues?: Set<string>,
) {
  if (createdQueues?.has(queueName)) {
    return;
  }

  await boss.createQueue(queueName);
  createdQueues?.add(queueName);
}

export async function enqueueSyncTriggerJob(
  boss: SyncTriggerQueueClient,
  payload: SyncTriggerPayload,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(boss, SYNC_TRIGGER_QUEUE, createdQueues);
  await boss.send(SYNC_TRIGGER_QUEUE, payload);
}

export async function enqueueInitialFullSync(
  boss: SyncTriggerQueueClient,
  pageLabel: string,
  createdQueues?: Set<string>,
) {
  await enqueueSyncTriggerJob(boss, { pageLabel, scope: "all" }, createdQueues);
}
