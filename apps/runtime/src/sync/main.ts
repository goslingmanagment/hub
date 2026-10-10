import { writeSync } from "node:fs";

import pg from "pg";

import { createDb, RUNTIME_POOL_LIFETIME } from "@agency_hub_core/db";

import { fanslyWsLivePayloadResolver } from "../services/fansly-ws/live-apply.ts";
import { notifySyncEngineIncident } from "../services/notification-incidents.ts";
import {
  publishCaptureCasSettingsAtStartup,
  startRuntimeHeartbeat,
} from "../services/runtime-heartbeat.ts";
import { createSyncContext, SYNC_POOL_TIMEOUTS, type SyncContext } from "./context.ts";
import { createIncidentAlertSink, SyncAlertEvaluator } from "./engine/alerts.ts";
import type { SyncLogger } from "./engine/commit.ts";
import { SyncEngineHost } from "./engine/host.ts";
import {
  SYNC_STALL_REPORT_TIMEOUT_MS,
  SyncStallWatchdog,
  type StallTracking,
  type SyncStall,
} from "./engine/watchdog.ts";
import { fanslyCaptureCodec } from "./fansly/capture.ts";
import { createFanslyPublicLookupReader } from "./fansly/public-lookup.ts";
import { createFanslyRegistry } from "./fansly/registry.ts";
import { onHistoryChatUnavailable, onHistoryThreadChainChanged, onHistoryWorkClosed } from "./requests/history.ts";

// The `sync` role: the long-running process of the Fansly Sync Engine (plan
// §8, §12; design §3.6, §9.1). It hosts one actor per `live` Fansly page:
// context (its pool bounded by `SYNC_POOL_TIMEOUTS`), CAS settings, the stall
// watchdog, heartbeat and health file, then the engine host; on SIGTERM the
// host finishes the step in flight, drains the live sockets and releases
// every page before the process exits — within `SYNC_SHUTDOWN_CAP_MS`
// whatever is still running. A page sends to Fansly
// only on a `live` row with the engine's step-1 guard row and its import mark
// (I17, J1, J3): a page is born so at onboarding; the six earlier pages were
// taken over by the step-3 switch.

/** The `sync` heartbeat cadence. Alert 5 (design §9.6) fires when no `sync`
 *  heartbeat is younger than 2 minutes, and the compose healthcheck wants the
 *  health file younger than 90 s: a 60 s beat would leave no margin for one
 *  slow or failed beat under either. */
export const SYNC_HEARTBEAT_INTERVAL_MS = 30_000;

/** Bound for closing the pool at shutdown; the heartbeat bounds its own stop
 *  at 5 s. With the host's budget (≤ 35 s) all sit inside the container's
 *  45 s stop grace. */
const SYNC_CLOSE_TIMEOUT_MS = 5_000;

/** SIGTERM: the process exits this long after the signal whatever is still
 *  running, inside the container's 45 s stop grace — Docker's SIGKILL never
 *  comes. What did not finish writes no safe release: its pages wait for the
 *  OS proof of the next start (fail closed). */
export const SYNC_SHUTDOWN_CAP_MS = 40_000;

/** The stall incident's own session (`pg_stat_activity.application_name`). */
export const SYNC_WATCHDOG_APPLICATION_NAME = "fansly-sync-watchdog";

/** The part of the engine host (and of its alert evaluator) the runtime drives. */
export interface SyncRuntimeTask {
  start(): Promise<void>;
  stop(): Promise<void>;
}
export type SyncRuntimeHost = SyncRuntimeTask;

/** The production host: the Fansly registry over this process's context.
 *  Nothing here may loosen a pace or live gate (pinned by a grep test). */
export function createSyncRuntimeHost(context: SyncContext, watchdog: StallTracking | null = null): SyncRuntimeHost {
  return new SyncEngineHost({
    db: context.db,
    connectionString: context.config.databaseUrl,
    config: context.config,
    rawConfig: context.rawConfig,
    logger: context.logger,
    registry: createFanslyRegistry(),
    // Alerts 1–4 (design §9.6): an alert opens its latch at once; the
    // evaluator resolves.
    alerts: createIncidentAlertSink({ db: context.db, logger: context.logger }),
    capture: fanslyCaptureCodec,
    // History requests (design §7.1.6): every history read and every DM read
    // that moved a chain settles the fans riding on it; a history work that
    // closes for a reason of its own ends its fans; a chat whose refusal is
    // established refuses the fans that need its head (arena §2.4).
    onThreadChainChanged: onHistoryThreadChainChanged,
    onWorkClosed: onHistoryWorkClosed,
    onChatUnavailable: onHistoryChatUnavailable,
    ...(watchdog === null ? {} : { watchdog }),
  });
}

/** The production alert evaluator: alerts 1–4 of every handover/live page
 *  from the database every 30 s, and the pace backstop. */
export function createSyncAlertEvaluator(context: SyncContext, watchdog: StallTracking | null = null): SyncRuntimeTask {
  const evaluator = new SyncAlertEvaluator({
    db: context.db,
    logger: context.logger,
    registry: createFanslyRegistry(),
    resolvePayload: fanslyWsLivePayloadResolver(context),
    ...(watchdog === null ? {} : { watchdog }),
  });
  return {
    async start() {
      evaluator.start();
      void evaluator.runOnce();
    },
    stop: () => evaluator.stop(),
  };
}

/** The session-less public account reader (arena "vanished chat" R5): one
 *  per process, under its own advisory lock across processes; it sends
 *  nothing while `fanslyPublicLookupEnabled` is off (the default) or it has no
 *  proxy of its own. */
export function createSyncPublicLookupTask(context: SyncContext): SyncRuntimeTask {
  const reader = createFanslyPublicLookupReader(context);
  return {
    async start() {
      reader.start();
    },
    stop: () => reader.stop(),
  };
}

export interface SyncRuntime {
  readonly instanceId: string;
  /** Stops the stall watchdog, then the engine host (the step in flight
   *  finishes, every page is released), then the heartbeat (its row is
   *  removed). Idempotent; does not close the context. */
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
  /** The public account reader; default `createSyncPublicLookupTask(context)`
   *  with the default host, none otherwise. */
  publicLookup?: SyncRuntimeTask | null;
  /** The stall watchdog (`engine/watchdog.ts`); default: 120 s, its incident
   *  through `createStallIncidentReport`, `process.exit(70)`; null: none. It
   *  watches every heartbeat beat and the default host and evaluator (a host
   *  passed in is watched when it was built with it). */
  watchdog?: SyncStallWatchdog | null;
}

export async function startSyncRuntime(
  context: SyncContext,
  options: StartSyncRuntimeOptions = {},
): Promise<SyncRuntime> {
  // Before anything in this process can capture: the page actors journal every
  // response, and the settings otherwise arrive only with the first beat.
  await publishCaptureCasSettingsAtStartup(context, "sync");
  const watchdog = options.watchdog !== undefined
    ? options.watchdog
    : new SyncStallWatchdog({
      report: createStallIncidentReport({ connectionString: context.config.databaseUrl, logger: context.logger }),
    });
  watchdog?.start();
  // The heartbeat timer is unref'd and an idle pool closes its sockets, so
  // nothing else would hold the event loop open: the process lives until a
  // signal stops it.
  const keepAlive = setInterval(() => undefined, 60_000);
  const heartbeat = startRuntimeHeartbeat(context, "sync", {
    startedAt: options.startedAt,
    healthFilePath: options.healthFilePath ?? null,
    intervalMs: options.heartbeatIntervalMs ?? SYNC_HEARTBEAT_INTERVAL_MS,
    watchBeat: watchdog === null ? undefined : () => watchdog.track({ component: "heartbeat" }, "beat"),
  });
  const host = options.host === undefined ? createSyncRuntimeHost(context, watchdog) : options.host;
  const alerts = options.alerts !== undefined
    ? options.alerts
    : options.host === undefined ? createSyncAlertEvaluator(context, watchdog) : null;
  const publicLookup = options.publicLookup !== undefined
    ? options.publicLookup
    : options.host === undefined ? createSyncPublicLookupTask(context) : null;
  try {
    await host?.start();
    await alerts?.start();
    await publicLookup?.start();
  } catch (error) {
    watchdog?.stop();
    await publicLookup?.stop().catch(() => undefined);
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
        // A stop is not a stall: the watchdog lets the steps in flight finish.
        watchdog?.stop();
        // The pages first: the request in flight finishes and every page is
        // released while the process still heartbeats. The public reader's
        // request in flight (≤ its 20 s budget) finishes beside them.
        await alerts?.stop();
        await Promise.all([publicLookup?.stop(), host?.stop()]);
        clearInterval(keepAlive);
        await heartbeat.stop();
      })();
      return stopping;
    },
  };
}

/**
 * The stall watchdog's incident: alert 5's latch (`process`), so the owner
 * learns why the process restarted. Written through a client of its own —
 * the pool may be what stalled — and bounded like the watchdog's wait for it.
 */
export function createStallIncidentReport(input: {
  connectionString: string;
  logger: SyncLogger;
}): (stall: SyncStall) => Promise<void> {
  return async (stall) => {
    const client = new pg.Client({
      connectionString: input.connectionString,
      application_name: SYNC_WATCHDOG_APPLICATION_NAME,
      connectionTimeoutMillis: SYNC_STALL_REPORT_TIMEOUT_MS,
      query_timeout: SYNC_STALL_REPORT_TIMEOUT_MS,
      statement_timeout: SYNC_STALL_REPORT_TIMEOUT_MS,
    });
    client.on("error", () => undefined);
    try {
      await client.connect();
      await notifySyncEngineIncident({ db: createDb(client), logger: input.logger }, {
        subKey: "process",
        pageId: null,
        pageLabel: null,
        detail: "stalled",
        errorSummary: describeSyncStall(stall),
        occurredAt: new Date(),
      });
    } finally {
      await client.end().catch(() => undefined);
    }
  };
}

/** The incident's one line: what stalled, where, for how long. */
export function describeSyncStall(stall: SyncStall): string {
  const what = stall.component === "actor"
    ? `the actor of page ${stall.pageId} (owner generation ${stall.generation})`
    : stall.component === "host"
      ? "the host's mode loop"
      : stall.component === "heartbeat" ? "a heartbeat beat" : "an alert pass";
  const others = stall.stale > 1 ? `; ${stall.stale - 1} more stalled` : "";
  return `The sync process stalled: ${what} made no progress for ${Math.round(stall.ageMs / 1_000)} s `
    + `(phase ${stall.phase}${others}). It exited (70) for Docker to restart it; its pages wait for that restart.`;
}

export async function runSyncRuntime(): Promise<void> {
  const startedAt = new Date();
  const context = await createSyncContext({ poolTimeouts: SYNC_POOL_TIMEOUTS, poolLifetime: RUNTIME_POOL_LIFETIME });
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
    "Sync runtime started (engine host: live pages run; a page is live from its onboarding)",
  );
  handleSyncShutdownSignals(context, runtime);
}

export interface SyncShutdownOptions {
  /** Default `SYNC_SHUTDOWN_CAP_MS`. */
  capMs?: number;
}

/**
 * SIGINT/SIGTERM: stop the runtime (its pages released), close the pool,
 * exit 0 — and exit 0 at `capMs` after the signal whatever is still running.
 */
export function handleSyncShutdownSignals(
  context: Pick<SyncContext, "logger" | "close">,
  runtime: SyncRuntime,
  options: SyncShutdownOptions = {},
): void {
  const capMs = options.capMs ?? SYNC_SHUTDOWN_CAP_MS;
  const shutdown = async () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    const cap = setTimeout(() => {
      writeSync(2, `${JSON.stringify({ msg: "Fansly sync: shutdown cap reached; exiting", capMs })}\n`);
      process.exit(0);
    }, capMs);
    cap.unref();
    context.logger.info({ instanceId: runtime.instanceId }, "Sync runtime stopping");
    await runtime.stop().catch(() => undefined);
    await settleWithin(context.close(), SYNC_CLOSE_TIMEOUT_MS);
    clearTimeout(cap);
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
