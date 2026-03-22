import type { AppContext } from "../../bootstrap.ts";

const PAGE_SYNC_LOCK_NAMESPACE = 43101;

export class PageSyncLockedError extends Error {
  constructor(readonly pageLabel: string) {
    super(`Page "${pageLabel}" is already syncing`);
    this.name = "PageSyncLockedError";
  }
}

export class PageSyncLockReleaseError extends Error {
  constructor(
    readonly pageLabel: string,
    cause?: unknown,
  ) {
    super(`Failed to release page sync lock for "${pageLabel}"`, {
      cause: cause instanceof Error ? cause : undefined,
    });
    this.name = "PageSyncLockReleaseError";
  }
}

function attachLockReleaseError(error: unknown, releaseError: PageSyncLockReleaseError) {
  if (!(error instanceof Error)) {
    return error;
  }

  Object.defineProperty(error, "lockReleaseError", {
    value: releaseError,
    configurable: true,
    enumerable: false,
    writable: true,
  });
  return error;
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
  let releaseError: PageSyncLockReleaseError | null = null;
  let runError: unknown = null;

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
    } catch (error) {
      runError = error;
      throw error;
    } finally {
      try {
        const unlockResult = await client.query<{ unlocked: boolean }>(
          "select pg_advisory_unlock($1, $2) as unlocked",
          [PAGE_SYNC_LOCK_NAMESPACE, input.pageId],
        );
        if (!unlockResult.rows[0]?.unlocked) {
          throw new Error(`Session did not release advisory lock for page "${input.pageLabel}"`);
        }
      } catch (error) {
        releaseError = new PageSyncLockReleaseError(input.pageLabel, error);
        if (runError !== null) {
          throw attachLockReleaseError(runError, releaseError);
        }
        throw releaseError;
      }
    }
  } finally {
    client.release(releaseError ?? undefined);
  }
}
