import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  reapStaleInstances,
  removeInstance,
  upsertInstanceHeartbeat,
} from "@agency_hub_core/db";
import { buildRunningSnapshot, type AppConfig } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import {
  publishCaptureCasDualWritePages,
  publishCaptureCasPointerOnlyPages,
} from "./capture-cas-dual-write.ts";
import { publishCaptureCasReadMode } from "./payload-reader.ts";
import { loadEffectiveConfig } from "./effective-config.ts";

export type RuntimeRole = "api" | "worker" | "scheduler" | "sync";

/** What a heartbeat reads from its process: the DB, the boot config (boot
 *  overrides applied) with what boot skipped, and a logger. Every role's
 *  context has these — the full AppContext of api/worker/scheduler and the
 *  adapter-free SyncContext of the `sync` role. */
export type RuntimeHeartbeatContext = Pick<AppContext, "db" | "config" | "logger" | "bootSkipped">;

/** How often each process refreshes its heartbeat row by default. The
 *  staleness TTL on the repository side (INSTANCE_STALE_TTL_MS) is a small
 *  multiple of this. A role whose liveness is judged on a tighter clock passes
 *  `intervalMs` (the `sync` role: 30 s, against its 2-minute alert). */
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const HEARTBEAT_STOP_TIMEOUT_MS = 5_000;

export interface RuntimeHeartbeat {
  readonly instanceId: string;
  stop(): Promise<void>;
}

/** Liveness file for Docker healthchecks: mtime freshness is the signal, the
 *  JSON body is for humans. The worker writes it around its service lifecycle;
 *  the scheduler rides startRuntimeHeartbeat (healthFilePath option), where a
 *  write happens only AFTER a successful heartbeat upsert — so a fresh file
 *  certifies both the event loop and a DB round-trip. */
export async function writeRuntimeHealthFile(
  path: string,
  status: "starting" | "ready" | "stopping",
) {
  await mkdir(dirname(path), { recursive: true });
  // Write a sibling and rename it over the file: a healthcheck (or a test)
  // reading concurrently sees the old body or the new one, never half of it.
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({
    status,
    timestamp: new Date().toISOString(),
    pid: process.pid,
  })}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function waitForShutdownStep(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<"settled" | "timed-out"> {
  const settled = promise.then(() => "settled" as const, () => "settled" as const);
  if (timeoutMs <= 0) return "timed-out";

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function remainingStopMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

/** Publish the capture seam's CAS settings from one effective-config read.
 *  The heartbeat calls this every beat; each role that captures or reads
 *  payloads also calls it once at startup (publishCaptureCasSettingsAtStartup). */
function publishCaptureCasSettings(effectiveConfig: AppConfig): void {
  // G5 slice 1: publish the CAS dual-write canary bound to this process.
  // The capture seam (services/sync/shared.ts persistRawPayload) is the
  // hottest write path in the system and must not pay a config read per
  // capture; the heartbeat already loads the effective config once a minute in
  // every role, so the flag rides along for free. A flip therefore lands
  // within one heartbeat interval, which is the right latency for a canary
  // whose ramp is measured in days.
  publishCaptureCasDualWritePages(effectiveConfig.captureCasDualWritePages);
  // G5 slice 3c-1: the pointer-only bound rides the same read. Published
  // right after the canary it is subordinate to, so a process can never act
  // on a fresh pointer-only list against a stale dual-write list within one
  // beat — and even if it did, the subordination is structural (no catalog
  // reference, no permission to skip the inline body), not a comparison of
  // these two strings.
  publishCaptureCasPointerOnlyPages(effectiveConfig.captureCasPointerOnlyPages);
  // G5 slice 2: publish the payload READ mode the same way and for the same
  // reason — read sites resolve row by row and must never pay a config query.
  publishCaptureCasReadMode(effectiveConfig.captureCasReadMode);
}

/** Publish the capture seam's CAS settings once, before a role starts
 *  consuming work (the worker's job handlers, the api's routes).
 *
 *  Without it the settings exist only after the first heartbeat beat, and the
 *  worker starts its heartbeat only after its queue services: a job picked up
 *  in that window captured with the empty defaults, which fail closed to
 *  inline bodies with no catalog reference (prod 2026-09-30, raw row 3238568,
 *  ~2.2 s after process start, just before "Worker started").
 *
 *  Never throws. A failed read leaves the fail-closed defaults in place —
 *  inline bodies, no catalog reference, inline reads — which is valid capture,
 *  only without dedup; the first successful heartbeat publishes the real
 *  values. */
export async function publishCaptureCasSettingsAtStartup(
  app: Pick<RuntimeHeartbeatContext, "db" | "config" | "logger">,
  role: RuntimeRole,
): Promise<void> {
  try {
    publishCaptureCasSettings(await loadEffectiveConfig(app.db, app.config));
  } catch (error) {
    app.logger.warn(
      { err: error, role },
      "capture CAS settings not loaded at startup; captures stay inline until the first successful heartbeat",
    );
  }
}

/** Publishes a heartbeat row for this process carrying the sanitized config values
 *  it is actually using, so the dashboard Configuration view can show per-instance
 *  running values and detect drift between the api and worker containers.
 *
 *  Stage A: the running snapshot is derived from the immutable boot config, which is
 *  exactly what the process consumes. When Stage B introduces a runtime overlay, the
 *  snapshot source should switch to the live effective-config provider so `running`
 *  stays equal to what the process actually reads. */
export function startRuntimeHeartbeat(
  app: RuntimeHeartbeatContext,
  role: RuntimeRole,
  options: {
    startedAt?: Date | undefined;
    stopTimeoutMs?: number | undefined;
    healthFilePath?: string | null | undefined;
    intervalMs?: number | undefined;
  } = {},
): RuntimeHeartbeat {
  const instanceId = randomUUID();
  const startedAt = options.startedAt ?? new Date();
  const imageTag = process.env.IMAGE_TAG ?? process.env.GIT_SHA ?? null;
  const stopTimeoutMs = options.stopTimeoutMs ?? HEARTBEAT_STOP_TIMEOUT_MS;
  const healthFilePath = options.healthFilePath ?? null;
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;

  // `stopped` flips on shutdown so an in-flight beat skips its upsert; `inFlight` serializes
  // beats (a slow beat must not overlap the next tick) and lets stop() await the active beat
  // before removing the row, so a late upsert can never resurrect a removed instance.
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const beat = async () => {
    try {
      // Report the EFFECTIVE config this process actually consumes: loadEffectiveConfig
      // overlays only wired live (editable + reload) overrides, so `running` matches the
      // read-sites and pendingApply clears once every instance has applied. Restart/
      // non-live keys are untouched, so they keep reporting boot env (pendingApply stays
      // true for them until a real restart) — which is the honest answer.
      const effectiveConfig = await loadEffectiveConfig(app.db, app.config);
      // Published BEFORE the `stopped` check on purpose: the values are only
      // ever consumed by capture and by payload reads, and a process that is
      // still capturing or serving reads must act on the freshest values it
      // has read.
      publishCaptureCasSettings(effectiveConfig);
      // If stop() ran while we were reading, do NOT upsert: that would resurrect the row
      // removeInstance is about to delete, leaving a zombie "active" instance until the TTL.
      if (stopped) return;
      await upsertInstanceHeartbeat(app.db, {
        role,
        instanceId,
        startedAt,
        imageTag,
        // app.config already has the boot ('boot') overrides baked in, so values are
        // correct; attach the boot-skipped list so the view can surface ignored overrides.
        running: buildRunningSnapshot(effectiveConfig, app.bootSkipped),
      });
      // The health file refreshes only after a SUCCESSFUL upsert: a wedged
      // event loop or a lost DB both stop the mtime, which is what the
      // container healthcheck watches.
      if (healthFilePath) {
        await writeRuntimeHealthFile(healthFilePath, "ready");
      }
      // Idempotent across instances; whichever process runs it first wins.
      await reapStaleInstances(app.db).catch(() => undefined);
    } catch (error) {
      app.logger.warn({ err: error, role }, "runtime heartbeat upsert failed");
    }
  };

  // Never start a beat while one is in flight (no overlap) or after stop().
  const runBeat = () => {
    if (stopped || inFlight) return;
    inFlight = beat().finally(() => {
      inFlight = null;
    });
  };

  // Publish immediately so the view is populated right after boot, then on interval.
  runBeat();
  const timer = setInterval(runBeat, intervalMs);
  // Never keep the event loop alive solely for the heartbeat.
  timer.unref?.();

  return {
    instanceId,
    async stop() {
      stopped = true;
      clearInterval(timer);
      const deadlineMs = Date.now() + stopTimeoutMs;
      // Prefer removeInstance after the beat settles: its `stopped` check skips an upsert that
      // has not started yet, and a finished upsert cannot resurrect a removed row. If the beat
      // never settles, return so process shutdown can continue; the stale-row TTL will clean up.
      if (inFlight) {
        const state = await waitForShutdownStep(inFlight, remainingStopMs(deadlineMs));
        if (state === "timed-out") {
          app.logger.warn(
            { role, instanceId, timeoutMs: stopTimeoutMs },
            "runtime heartbeat stop timed out waiting for in-flight beat; leaving instance row for TTL cleanup",
          );
          return;
        }
      }
      const removeTimeoutMs = remainingStopMs(deadlineMs);
      const removed = removeTimeoutMs > 0
        ? await waitForShutdownStep(removeInstance(app.db, role, instanceId), removeTimeoutMs)
        : "timed-out";
      if (removed === "timed-out") {
        app.logger.warn(
          { role, instanceId, timeoutMs: stopTimeoutMs },
          "runtime heartbeat stop timed out removing instance row; leaving instance row for TTL cleanup",
        );
      }
    },
  };
}
