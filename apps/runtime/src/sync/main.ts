import {
  publishCaptureCasSettingsAtStartup,
  startRuntimeHeartbeat,
} from "../services/runtime-heartbeat.ts";
import { createSyncContext, type SyncContext } from "./context.ts";

// The `sync` role: the long-running process of the Fansly Sync Engine (plan
// §8, §12; design §9.1). It hosts one actor per Fansly page. This revision
// carries only the process itself — context, heartbeat, health file, signals —
// so the container can be deployed, watched and recreated before any engine
// code runs in it. It sends nothing and writes nothing but its heartbeat row.

/** The `sync` heartbeat cadence. Alert 5 (design §9.6) fires when no `sync`
 *  heartbeat is younger than 2 minutes, and the compose healthcheck wants the
 *  health file younger than 90 s: a 60 s beat would leave no margin for one
 *  slow or failed beat under either. */
export const SYNC_HEARTBEAT_INTERVAL_MS = 30_000;

/** Bound for closing the pool at shutdown; the heartbeat bounds its own stop
 *  at 5 s. Both sit well inside the container's 45 s stop grace. */
const SYNC_CLOSE_TIMEOUT_MS = 5_000;

export interface SyncRuntime {
  readonly instanceId: string;
  /** Stops the heartbeat (its row is removed) and lets the process idle out.
   *  Idempotent; does not close the context. */
  stop(): Promise<void>;
}

export interface StartSyncRuntimeOptions {
  startedAt?: Date;
  /** Written after every successful heartbeat upsert; the compose healthcheck
   *  watches its mtime. */
  healthFilePath?: string | null;
  heartbeatIntervalMs?: number;
}

export async function startSyncRuntime(
  context: SyncContext,
  options: StartSyncRuntimeOptions = {},
): Promise<SyncRuntime> {
  // Before anything in this process can capture: the page actors journal every
  // response, and the settings otherwise arrive only with the first beat.
  await publishCaptureCasSettingsAtStartup(context, "sync");
  // The heartbeat timer is unref'd and an idle pool closes its sockets, so
  // nothing else would hold the event loop open: the process lives until a
  // signal stops it.
  const keepAlive = setInterval(() => undefined, 60_000);
  const heartbeat = startRuntimeHeartbeat(context, "sync", {
    startedAt: options.startedAt,
    healthFilePath: options.healthFilePath ?? null,
    intervalMs: options.heartbeatIntervalMs ?? SYNC_HEARTBEAT_INTERVAL_MS,
  });
  let stopping: Promise<void> | null = null;

  return {
    instanceId: heartbeat.instanceId,
    stop() {
      stopping ??= (async () => {
        clearInterval(keepAlive);
        await heartbeat.stop();
      })();
      return stopping;
    },
  };
}

export async function runSyncRuntime(): Promise<void> {
  const startedAt = new Date();
  const context = await createSyncContext();
  let runtime: SyncRuntime;
  try {
    runtime = await startSyncRuntime(context, {
      startedAt,
      healthFilePath: process.env.SYNC_HEALTH_FILE ?? null,
    });
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
  context.logger.info(
    { instanceId: runtime.instanceId, heartbeatIntervalMs: SYNC_HEARTBEAT_INTERVAL_MS },
    "Sync runtime started (heartbeat only; no page actors in this release)",
  );

  const shutdown = async () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    context.logger.info({ instanceId: runtime.instanceId }, "Sync runtime stopping");
    await runtime.stop().catch(() => undefined);
    await settleWithin(context.close(), SYNC_CLOSE_TIMEOUT_MS);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
