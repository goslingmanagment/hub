import type { AppContext } from "../../bootstrap.ts";

const PAGE_SYNC_LOCK_NAMESPACE = 43101;

export class PageSyncLockedError extends Error {
  constructor(readonly pageLabel: string) {
    super(`Page "${pageLabel}" is already syncing`);
    this.name = "PageSyncLockedError";
  }
}

export async function withPageSyncLock<T>(
  app: Pick<AppContext, "pool">,
  input: {
    pageId: number;
    pageLabel: string;
  },
  run: () => Promise<T>,
) {
  const client = await app.pool.connect();

  try {
    const result = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1, $2) as locked",
      [PAGE_SYNC_LOCK_NAMESPACE, input.pageId],
    );

    if (!result.rows[0]?.locked) {
      throw new PageSyncLockedError(input.pageLabel);
    }

    try {
      return await run();
    } finally {
      await client
        .query("select pg_advisory_unlock($1, $2)", [PAGE_SYNC_LOCK_NAMESPACE, input.pageId])
        .catch(() => undefined);
    }
  } finally {
    client.release();
  }
}
