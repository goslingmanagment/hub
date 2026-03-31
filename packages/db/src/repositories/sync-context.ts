import { AsyncLocalStorage } from "node:async_hooks";

import type { SyncControlStream } from "./sync.ts";

export interface SyncTaskExecutionContext {
  platformAccountId: number;
  task: SyncControlStream;
  generation: number;
  leaseToken: string;
}

const syncTaskExecutionContextStorage = new AsyncLocalStorage<SyncTaskExecutionContext>();

export function runWithSyncTaskExecutionContext<T>(
  context: SyncTaskExecutionContext,
  run: () => Promise<T>,
): Promise<T> {
  return syncTaskExecutionContextStorage.run(context, run);
}

export function getSyncTaskExecutionContext() {
  return syncTaskExecutionContextStorage.getStore() ?? null;
}
