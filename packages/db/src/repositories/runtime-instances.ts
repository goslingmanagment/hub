import { and, asc, eq, gte, lt } from "drizzle-orm";
import type { RunningSnapshot } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import { runtimeInstances } from "../schema.ts";

export type RuntimeInstanceRow = typeof runtimeInstances.$inferSelect;

/** A row is considered live if its last_seen_at is within this window. Set to a few
 *  missed heartbeats so a single slow tick does not drop an instance. Past this the
 *  view classifies the instance as STALE (still shown, with a warning) rather than
 *  active. */
export const INSTANCE_STALE_TTL_MS = 3 * 60_000;

/** Rows are hard-deleted only past this much longer window, so a recently-stopped
 *  process keeps showing as "stale" for a while instead of silently vanishing
 *  (the exact failure that motivated this surface). */
export const INSTANCE_REAP_TTL_MS = 30 * 60_000;

export interface InstanceHeartbeatInput {
  role: string;
  instanceId: string;
  startedAt: Date;
  imageTag?: string | null;
  running: RunningSnapshot;
}

export async function upsertInstanceHeartbeat(
  db: Database,
  input: InstanceHeartbeatInput,
): Promise<void> {
  const now = new Date();
  await db
    .insert(runtimeInstances)
    .values({
      role: input.role,
      instanceId: input.instanceId,
      startedAt: input.startedAt,
      lastSeenAt: now,
      imageTag: input.imageTag ?? null,
      running: input.running,
    })
    .onConflictDoUpdate({
      target: [runtimeInstances.role, runtimeInstances.instanceId],
      set: {
        startedAt: input.startedAt,
        lastSeenAt: now,
        imageTag: input.imageTag ?? null,
        running: input.running,
      },
    });
}

/** Live instances only (last_seen within the TTL), so a stopped/restarted process
 *  does not contribute a stale snapshot to the view or to drift detection. */
export async function listActiveInstances(
  db: Database,
  ttlMs: number = INSTANCE_STALE_TTL_MS,
): Promise<RuntimeInstanceRow[]> {
  const cutoff = new Date(Date.now() - ttlMs);
  return db.query.runtimeInstances.findMany({
    where: gte(runtimeInstances.lastSeenAt, cutoff),
    orderBy: [asc(runtimeInstances.role), asc(runtimeInstances.instanceId)],
  });
}

/** Every instance row (active and stale), ordered by role then instance id. The
 *  view classifies each by last_seen_at so a stopped process is surfaced as stale
 *  rather than hidden. */
export async function listAllInstances(db: Database): Promise<RuntimeInstanceRow[]> {
  return db.query.runtimeInstances.findMany({
    orderBy: [asc(runtimeInstances.role), asc(runtimeInstances.instanceId)],
  });
}

/** Remove a single instance row (called on graceful shutdown so a stopped process
 *  does not linger in the view until the TTL reaps it). */
export async function removeInstance(
  db: Database,
  role: string,
  instanceId: string,
): Promise<void> {
  await db
    .delete(runtimeInstances)
    .where(and(eq(runtimeInstances.role, role), eq(runtimeInstances.instanceId, instanceId)));
}

/** Hard-delete rows past the (long) reap TTL. Returns how many were removed. Uses
 *  the reap window, not the stale window, so stale rows survive to be shown. */
export async function reapStaleInstances(
  db: Database,
  ttlMs: number = INSTANCE_REAP_TTL_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - ttlMs);
  const deleted = await db
    .delete(runtimeInstances)
    .where(lt(runtimeInstances.lastSeenAt, cutoff))
    .returning({ instanceId: runtimeInstances.instanceId });
  return deleted.length;
}
