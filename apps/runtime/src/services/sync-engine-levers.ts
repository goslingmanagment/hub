import {
  adjustPausedResources,
  closeQuarantinedWork,
  closeWorkRows,
  getOpenWorkForKey,
  getSyncPage,
  isFanslyPageEngineOwned,
  listSyncPages,
  lockWorkRows,
  requeueQuarantinedWork,
  upsertDemand,
  type Database,
  type SyncPageRow,
  type SyncStream,
} from "@agency_hub_core/db";

import { demandToUpsert } from "../sync/engine/resource.ts";
import { fanslyFilesForStreams, fanslyKeysForStreams } from "../sync/fansly/legacy-streams.ts";
import { fanslyResourceSpec } from "../sync/fansly/registry.ts";
import { OWNER_DEMAND_REASON } from "../sync/fansly/resources/followers.ts";
import { refreshSyncPage } from "../sync/inspect.ts";
import { ConflictError } from "./errors.ts";
import { FanslyPageSwitchingError } from "./sync-engine-guard.ts";
import type { SyncTriggerScope } from "./sync-queue.ts";

// The owner's legacy levers on a page the Fansly Sync Engine owns (design
// step 3 §3.2 item 4). The Settings buttons and the admin routes speak in
// legacy streams; on an engine page each one becomes the engine's own lever
// over the registry keys that took those streams over:
//
//   trigger  → the keys' polls become due now ("sync now", NOTIFY);
//   pause    → the keys join the page's paused set (the rest is kept);
//   resume   → the keys leave it;
//   reset    → the keys' quarantined work is requeued (a captured answer is
//              re-applied from the journal, no request) — legacy state
//              (`page_sync_states`, cursors) is never touched (J5).
//
// A page in `handover` has no sender (nothing reaches the mode since step 4,
// S4-21), so a lever that would make the engine read refuses with 409
// `fansly_page_switching`.
//
// Since step 4 (S4-10) the legacy executor serves no Fansly page, so the
// trigger scopes of a Fansly page ("sync now" for `light`, `data`, … in
// `POST /admin/sync/trigger` and `trigger-all`) resolve here, straight to the
// engine's registry keys, and no longer through the platform registry.

/** The legacy streams each trigger scope names on a Fansly page — the scope
 *  policy the platform registry held until step 4 (Stage 16: `all` leaves out
 *  the bulk crawls) — which `fanslyFilesForStreams` turns into the registry
 *  keys' resource files. */
export const FANSLY_ENGINE_SCOPE_STREAMS: Readonly<Record<SyncTriggerScope, readonly SyncStream[]>> = {
  light: ["light"],
  followers: ["followers"],
  posts: ["posts"],
  data: ["light", "transactions", "top_spenders", "subscribers", "followers", "followers_reconcile"],
  messages: ["dm_conversations", "dm_messages"],
  all: [
    "light",
    "transactions",
    "top_spenders",
    "subscribers",
    "followers",
    "followers_reconcile",
    "dm_conversations",
    "dm_messages",
  ],
};

/** The engine modes in which a page is no longer the legacy engine's. */
export type EngineOwnedMode = "handover" | "live";

/** A lever that would make the engine read, asked of a page in `handover`. */
export { FanslyPageSwitchingError };

/** What an engine lever did: the keys or files it acted on and how many rows
 *  or keys it moved. */
export interface EngineLeverOutcome {
  mode: EngineOwnedMode;
  resources: string[];
  affected: number;
}

/** The page's engine row when the engine owns it (`handover`/`live`), else
 *  null: the legacy engine's levers apply. */
export async function engineOwnedSyncPage(
  db: Database,
  pageId: number,
): Promise<(SyncPageRow & { mode: EngineOwnedMode }) | null> {
  if (!(await isFanslyPageEngineOwned(db, pageId)).owned) return null;
  const page = await getSyncPage(db, pageId);
  if (page === null || (page.mode !== "handover" && page.mode !== "live")) return null;
  return page as SyncPageRow & { mode: EngineOwnedMode };
}

/** The engine row of the page with this label when the engine owns it. */
export async function engineOwnedSyncPageByLabel(
  db: Database,
  pageLabel: string,
): Promise<(SyncPageRow & { mode: EngineOwnedMode }) | null> {
  const page = (await listSyncPages(db, { modes: ["handover", "live"] })).find((row) => row.pageLabel === pageLabel);
  return page === undefined ? null : page as SyncPageRow & { mode: EngineOwnedMode };
}

function labelOf(page: SyncPageRow): string {
  return page.pageLabel ?? String(page.pageId);
}

/** Refuse a reading lever while the page is in `handover`. */
export function assertEngineReads(page: SyncPageRow & { mode: EngineOwnedMode }): void {
  if (page.mode === "handover") throw new FanslyPageSwitchingError(labelOf(page));
}

/** "Sync now" for legacy streams: the polls of their resource files. */
export async function triggerEngineStreams(
  db: Database,
  page: SyncPageRow & { mode: EngineOwnedMode },
  streams: readonly SyncStream[],
): Promise<EngineLeverOutcome> {
  assertEngineReads(page);
  const files = fanslyFilesForStreams(streams);
  if (files.length === 0) return { mode: page.mode, resources: [], affected: 0 };
  const { bumped } = await refreshSyncPage(db, page, files);
  return { mode: page.mode, resources: files, affected: bumped };
}

/** "Sync now" for a trigger scope of a Fansly page: the polls of the
 *  resource files its streams map to (`FANSLY_ENGINE_SCOPE_STREAMS`). */
export async function triggerEngineScope(
  db: Database,
  page: SyncPageRow & { mode: EngineOwnedMode },
  scope: SyncTriggerScope,
): Promise<EngineLeverOutcome> {
  return triggerEngineStreams(db, page, FANSLY_ENGINE_SCOPE_STREAMS[scope]);
}

/** Pause (or resume) the keys that took the streams over; every other key
 *  of the page's paused set is kept. */
export async function pauseEngineStreams(
  db: Database,
  page: SyncPageRow & { mode: EngineOwnedMode },
  streams: readonly SyncStream[],
  action: "pause" | "resume",
): Promise<EngineLeverOutcome> {
  const keys = fanslyKeysForStreams(streams);
  const before = new Set(page.pausedResources);
  const updated = await adjustPausedResources(db, {
    pageId: page.pageId,
    ...(action === "pause" ? { add: keys } : { remove: keys }),
  });
  const after = new Set(updated?.pausedResources ?? []);
  const changed = keys.filter((key) => before.has(key) !== after.has(key)).length;
  return { mode: page.mode, resources: keys, affected: changed };
}

/** Requeue the quarantined live work of the keys that took the streams over
 *  (a captured answer re-applies from the journal without a request). */
export async function requeueEngineStreams(
  db: Database,
  page: SyncPageRow & { mode: EngineOwnedMode },
  streams: readonly SyncStream[],
): Promise<EngineLeverOutcome & { requeued: Array<{ id: number; resource: string; reapplied: boolean }> }> {
  assertEngineReads(page);
  const keys = fanslyKeysForStreams(streams);
  const requeued = keys.length === 0
    ? []
    : await requeueQuarantinedWork(db, { pageId: page.pageId, resources: keys, shadow: false });
  return {
    mode: page.mode,
    resources: keys,
    affected: requeued.length,
    requeued: requeued.map((row) => ({ id: row.id, resource: row.resource, reapplied: row.reapplyAttemptId !== null })),
  };
}

const FOLLOWERS_RECONCILE_KEY = "followers.reconcile";

/**
 * The follower-reconcile reset on an engine page: the walk's open or
 * quarantined row is cancelled and a fresh owner demand starts a new walk
 * from offset zero under a new generation (the owner's demand passes the
 * daily floor). A row with a read in flight is refused — retry once it lands.
 * Returns the new row's demand revision.
 */
export async function resetEngineFollowersReconcile(
  db: Database,
  page: SyncPageRow & { mode: EngineOwnedMode },
): Promise<{ workId: number; demandRevision: number }> {
  assertEngineReads(page);
  const spec = fanslyResourceSpec(FOLLOWERS_RECONCILE_KEY);
  if (spec === null) throw new Error(`No registry entry ${FOLLOWERS_RECONCILE_KEY}`);
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const open = await getOpenWorkForKey(txDb, {
      pageId: page.pageId,
      shadow: false,
      resource: FOLLOWERS_RECONCILE_KEY,
      subject: "",
    });
    if (open !== null) {
      const [locked] = await lockWorkRows(txDb, [open.id]);
      if (locked?.state === "running") {
        throw new ConflictError("The follower reconcile has a read in flight; reset it once that read lands");
      }
      if (locked?.state === "quarantined") {
        await closeQuarantinedWork(txDb, { workId: locked.id, to: "cancelled", closeReason: "owner_reset" });
      } else if (locked?.state === "open") {
        await closeWorkRows(txDb, { workIds: [locked.id], to: "cancelled", closeReason: "owner_reset" });
      }
    }
    const upsert = demandToUpsert(
      { resource: FOLLOWERS_RECONCILE_KEY, demand: { reason: OWNER_DEMAND_REASON } },
      spec,
      { pageId: page.pageId, shadow: false, now: new Date(), page },
    );
    if (upsert === null) {
      throw new ConflictError(`${FOLLOWERS_RECONCILE_KEY} is switched off on ${labelOf(page)} (sync page override)`);
    }
    const result = await upsertDemand(txDb, upsert);
    return { workId: result.id, demandRevision: result.demandRevision };
  });
}
