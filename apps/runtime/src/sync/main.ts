import { fanslyWsLivePayloadResolver } from "../services/fansly-ws/live-apply.ts";
import {
  publishCaptureCasSettingsAtStartup,
  startRuntimeHeartbeat,
} from "../services/runtime-heartbeat.ts";
import { createSyncContext, type SyncContext } from "./context.ts";
import { createIncidentAlertSink, SyncAlertEvaluator } from "./engine/alerts.ts";
import { SyncEngineHost } from "./engine/host.ts";
import { fanslyCaptureCodec } from "./fansly/capture.ts";
import { createFanslyRegistry } from "./fansly/registry.ts";
import { createFanslyShadowWsFeed } from "./fansly/ws/route-receipt.ts";
import { onHistoryThreadChainChanged, onHistoryWorkClosed } from "./requests/history.ts";

// The `sync` role: the long-running process of the Fansly Sync Engine (plan
// §8, §12; design §3.6, §9.1). It hosts one actor per Fansly page in `shadow`
// or `live`: context, CAS settings, heartbeat and health file, then the engine
// host; on SIGTERM the host finishes the step in flight, drains the live
// sockets and releases every page before the process exits. A page sends to
// Fansly only after the step-3 switch made it `live`, handed it the step-1
// guard row and imported the legacy state (I17, J1, J3).

/** The `sync` heartbeat cadence. Alert 5 (design §9.6) fires when no `sync`
 *  heartbeat is younger than 2 minutes, and the compose healthcheck wants the
 *  health file younger than 90 s: a 60 s beat would leave no margin for one
 *  slow or failed beat under either. */
export const SYNC_HEARTBEAT_INTERVAL_MS = 30_000;

/** Bound for closing the pool at shutdown; the heartbeat bounds its own stop
 *  at 5 s. With the host's budget (≤ 35 s) all sit inside the container's
 *  45 s stop grace. */
const SYNC_CLOSE_TIMEOUT_MS = 5_000;

/** The part of the engine host (and of its alert evaluator) the runtime drives. */
export interface SyncRuntimeTask {
  start(): Promise<void>;
  stop(): Promise<void>;
}
export type SyncRuntimeHost = SyncRuntimeTask;

/** The production host: the Fansly registry over this process's context.
 *  Nothing here may loosen a pace or live gate (pinned by a grep test). */
export function createSyncRuntimeHost(context: SyncContext): SyncRuntimeHost {
  return new SyncEngineHost({
    db: context.db,
    connectionString: context.config.databaseUrl,
    config: context.config,
    rawConfig: context.rawConfig,
    logger: context.logger,
    registry: createFanslyRegistry(),
    // Alerts 1–4 (design §9.6): a live page's alert opens its latch at once;
    // a shadow page's is logged only (D14). The evaluator resolves.
    alerts: createIncidentAlertSink({ db: context.db, logger: context.logger }),
    capture: fanslyCaptureCodec,
    // Shadow pages: the receipts the legacy receiver captured become shadow
    // demand, read through the payload seam (design §6.4).
    shadowFeed: createFanslyShadowWsFeed({ resolvePayload: fanslyWsLivePayloadResolver(context) }),
    // History requests (design §7.1.6): every history read and every DM read
    // that moved a chain settles the fans riding on it; a history work that
    // closes for a reason of its own ends its fans.
    onThreadChainChanged: onHistoryThreadChainChanged,
    onWorkClosed: onHistoryWorkClosed,
  });
}

/** The production alert evaluator: alerts 1–4 of every handover/live page
 *  from the database every 30 s, and the pace backstop. */
export function createSyncAlertEvaluator(context: SyncContext): SyncRuntimeTask {
  const evaluator = new SyncAlertEvaluator({
    db: context.db,
    logger: context.logger,
    registry: createFanslyRegistry(),
    resolvePayload: fanslyWsLivePayloadResolver(context),
  });
  return {
    async start() {
      evaluator.start();
      void evaluator.runOnce();
    },
    stop: () => evaluator.stop(),
  };
}

export interface SyncRuntime {
  readonly instanceId: string;
  /** Stops the engine host (the step in flight finishes, every page is
   *  released), then the heartbeat (its row is removed). Idempotent; does not
   *  close the context. */
  stop(): Promise<void>;
}

export interface StartSyncRuntimeOptions {
  startedAt?: Date;
  /** Written after every successful heartbeat upsert; the compose healthcheck
   *  watches its mtime. */
  healthFilePath?: string | null;
  heartbeatIntervalMs?: number;
  /** The engine host; default `createSyncRuntimeHost(context)`, null runs the
   *  heartbeat only. */
  host?: SyncRuntimeHost | null;
  /** The alert evaluator; default `createSyncAlertEvaluator(context)` with the
   *  default host, none otherwise. */
  alerts?: SyncRuntimeTask | null;
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
  const host = options.host === undefined ? createSyncRuntimeHost(context) : options.host;
  const alerts = options.alerts !== undefined
    ? options.alerts
    : options.host === undefined ? createSyncAlertEvaluator(context) : null;
  try {
    await host?.start();
    await alerts?.start();
  } catch (error) {
    await alerts?.stop().catch(() => undefined);
    await host?.stop().catch(() => undefined);
    clearInterval(keepAlive);
    await heartbeat.stop();
    throw error;
  }
  let stopping: Promise<void> | null = null;

  return {
    instanceId: heartbeat.instanceId,
    stop() {
      stopping ??= (async () => {
        // The pages first: the request in flight finishes and every page is
        // released while the process still heartbeats.
        await alerts?.stop();
        await host?.stop();
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
    "Sync runtime started (engine host: shadow pages and live pages run; a page is live only after the switch)",
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
