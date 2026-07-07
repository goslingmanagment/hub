import { AsyncLocalStorage } from "node:async_hooks";

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { pageSyncStates } from "../schema.ts";
import type { SyncStream } from "./page-sync.ts";

export interface PageSyncExecutionContext {
  pageId: number;
  stream: SyncStream;
  requestSeq: number;
  leaseToken: string;
  /** Mutable per-chunk fetch counter (observation idempotency keys). */
  fetchSeq?: number;
}

const pageSyncExecutionContextStorage = new AsyncLocalStorage<PageSyncExecutionContext>();

/** Unique per fetch within a chunk: "<requestSeq>.<n>". Null outside one.
 * Multi-fetch chunks (pagination walks, multi-endpoint units) previously all
 * shared the chunk's requestSeq, and every observation after the first was
 * silently dropped by the (source, idempotency_key) claim. */
export function nextPageSyncObservationSeq(): string | null {
  const context = pageSyncExecutionContextStorage.getStore();
  if (!context) {
    return null;
  }
  context.fetchSeq = (context.fetchSeq ?? 0) + 1;
  return `${context.requestSeq}.${context.fetchSeq}`;
}

export class PageSyncLeaseLostError extends Error {
  constructor(message = "Page sync lease lost") {
    super(message);
    this.name = "PageSyncLeaseLostError";
  }
}

export function runWithPageSyncExecutionContext<T>(
  context: PageSyncExecutionContext,
  run: () => Promise<T>,
): Promise<T> {
  return pageSyncExecutionContextStorage.run(context, run);
}

export function getPageSyncExecutionContext() {
  return pageSyncExecutionContextStorage.getStore() ?? null;
}

export async function assertOwnedPageSyncLease(
  db: Database,
  input?: {
    lock?: boolean;
  },
) {
  const executionContext = getPageSyncExecutionContext();
  if (!executionContext) {
    return;
  }

  const result = await db.execute(sql`
    select 1
    from ${pageSyncStates}
    where page_id = ${executionContext.pageId}
      and stream = ${executionContext.stream}
      and lease_token = ${executionContext.leaseToken}
      and leased_seq = ${executionContext.requestSeq}
      and status = 'running'
    limit 1
    ${input?.lock ? sql`for update` : sql``}
  `);

  if ((result.rowCount ?? 0) === 0) {
    throw new PageSyncLeaseLostError();
  }
}

export async function withOwnedPageSyncTransaction<T>(
  db: Database,
  run: (tx: Database) => Promise<T>,
): Promise<T> {
  const executionContext = getPageSyncExecutionContext();
  const transaction = (
    db as Database & {
      transaction?: (callback: (tx: unknown) => Promise<T>) => Promise<T>;
    }
  ).transaction;

  if (typeof transaction !== "function") {
    if (executionContext) {
      await assertOwnedPageSyncLease(db);
    }
    const result = await run(db);
    if (executionContext) {
      await assertOwnedPageSyncLease(db);
    }
    return result;
  }

  if (!executionContext) {
    return transaction.call(db, async (tx) => run(tx as unknown as Database));
  }

  return transaction.call(db, async (tx) => {
    const database = tx as unknown as Database;
    await assertOwnedPageSyncLease(database);
    const result = await run(database);
    await assertOwnedPageSyncLease(database, { lock: true });
    return result;
  });
}
