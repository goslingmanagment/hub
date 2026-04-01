import { AsyncLocalStorage } from "node:async_hooks";

import type { SyncStream } from "./page-sync.ts";

export interface PageSyncExecutionContext {
  pageId: number;
  stream: SyncStream;
  requestSeq: number;
  leaseToken: string;
}

const pageSyncExecutionContextStorage = new AsyncLocalStorage<PageSyncExecutionContext>();

export function runWithPageSyncExecutionContext<T>(
  context: PageSyncExecutionContext,
  run: () => Promise<T>,
): Promise<T> {
  return pageSyncExecutionContextStorage.run(context, run);
}

export function getPageSyncExecutionContext() {
  return pageSyncExecutionContextStorage.getStore() ?? null;
}
