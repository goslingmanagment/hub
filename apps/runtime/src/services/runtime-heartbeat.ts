import { randomUUID } from "node:crypto";

import {
  reapStaleInstances,
  removeInstance,
  upsertInstanceHeartbeat,
} from "@agency_hub_core/db";
import { buildRunningSnapshot } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { loadEffectiveConfig } from "./effective-config.ts";

export type RuntimeRole = "api" | "worker";

/** How often each process refreshes its heartbeat row. The staleness TTL on the
 *  repository side (INSTANCE_STALE_TTL_MS) is a small multiple of this. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

export interface RuntimeHeartbeat {
  readonly instanceId: string;
  stop(): Promise<void>;
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
  app: AppContext,
  role: RuntimeRole,
  options: { startedAt?: Date } = {},
): RuntimeHeartbeat {
  const instanceId = randomUUID();
  const startedAt = options.startedAt ?? new Date();
  const imageTag = process.env.IMAGE_TAG ?? process.env.GIT_SHA ?? null;

  const beat = async () => {
    try {
      // Report the EFFECTIVE config this process actually consumes: loadEffectiveConfig
      // overlays only wired live (editable + reload) overrides, so `running` matches the
      // read-sites and pendingApply clears once every instance has applied. Restart/
      // non-live keys are untouched, so they keep reporting boot env (pendingApply stays
      // true for them until a real restart) — which is the honest answer.
      const effectiveConfig = await loadEffectiveConfig(app.db, app.config);
      await upsertInstanceHeartbeat(app.db, {
        role,
        instanceId,
        startedAt,
        imageTag,
        // app.config already has the boot ('boot') overrides baked in, so values are
        // correct; attach the boot-skipped list so the view can surface ignored overrides.
        running: buildRunningSnapshot(effectiveConfig, app.bootSkipped),
      });
      // Idempotent across instances; whichever process runs it first wins.
      await reapStaleInstances(app.db).catch(() => undefined);
    } catch (error) {
      app.logger.warn({ err: error, role }, "runtime heartbeat upsert failed");
    }
  };

  // Publish immediately so the view is populated right after boot, then on interval.
  void beat();
  const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
  // Never keep the event loop alive solely for the heartbeat.
  timer.unref?.();

  return {
    instanceId,
    async stop() {
      clearInterval(timer);
      await removeInstance(app.db, role, instanceId).catch(() => undefined);
    },
  };
}
