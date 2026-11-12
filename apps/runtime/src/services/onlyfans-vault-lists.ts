import type { OfapiVaultListsWire } from "@agency_hub_core/contracts";
import {
  applyOnlyfansVaultListWalk,
  getOnlyfansVaultListWalk,
  listOnlyfansVaultLists,
  listRequestedOnlyfansVaultListWalks,
  onlyfansVaultListPageBound,
  requestOnlyfansVaultListWalk,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import { readOnlyfansVaultLists } from "./publications-onlyfans-reads.ts";

// Hub knows the vault albums of OnlyFans (8-docs 2026-11-12-of-vault-album,
// plan PR 3). The owner's «Обновить альбомы» asks for a walk of the page's
// vault lists; the minutely OnlyFans checks job answers it (reads only, at
// most 12 requests, owner actions marked `publication_read`) and stores what
// it saw. Never a `vault_catalog` collection job: the latest job of that
// category says whether the whole vault was read.

/** Walks per minute: each is up to 12 requests in the background lane. */
const WALKS_PER_TICK = 1;

/** The owner pressed «Обновить альбомы». */
export async function requestOwnerOnlyfansVaultListWalk(app: AppContext, pageId: number, userId: number): Promise<OfapiVaultListsWire> {
  const bound = await onlyfansVaultListPageBound(app.db, pageId);
  if (bound === null) throw new NotFoundError("Not an OnlyFans page");
  if (!bound) throw new ConflictError("The page is not bound to an OnlyFans API account");
  await requestOnlyfansVaultListWalk(app.db, { pageId, userId });
  return readOnlyfansVaultListsWire(app, pageId);
}

/** The minutely job's share: answer the oldest asked-for walk. Returns how many walked. */
export async function answerOnlyfansVaultListWalks(app: AppContext, now = new Date()): Promise<number> {
  if (!app.ofapi?.dispatchGovernedRaw) return 0;
  let walked = 0;
  for (const request of await listRequestedOnlyfansVaultListWalks(app.db)) {
    if (walked >= WALKS_PER_TICK) break;
    if (request.requestedByUserId === null) continue;
    walked += 1;
    const walk = await readOnlyfansVaultLists({ app, pageId: request.pageId, actorUserId: request.requestedByUserId })
      .catch((error: unknown) => ({
        lists: [], complete: false, requests: 0, intentIds: [],
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 200),
      }));
    await applyOnlyfansVaultListWalk(app.db, {
      pageId: request.pageId,
      seenAt: now,
      lists: walk.lists.map((list) => ({ listRef: list.id, name: list.name, type: list.type, mediaCount: list.mediaCount })),
      complete: walk.complete,
      requests: walk.requests,
      failure: walk.reason,
      answeredRequestAt: request.requestedAt,
    });
  }
  return walked;
}

export async function readOnlyfansVaultListsWire(app: AppContext, pageId: number): Promise<OfapiVaultListsWire> {
  const [lists, walk] = await Promise.all([listOnlyfansVaultLists(app.db, pageId), getOnlyfansVaultListWalk(app.db, pageId)]);
  const iso = (at: Date | null) => at?.toISOString() ?? null;
  return {
    pageId,
    lists: lists.map((list) => ({
      listRef: list.listRef, name: list.name, type: list.type, mediaCount: list.mediaCount,
      firstSeenAt: list.firstSeenAt.toISOString(), lastSeenAt: list.lastSeenAt.toISOString(), missingSince: iso(list.missingSince),
    })),
    walk: {
      requestedAt: iso(walk?.requestedAt ?? null),
      completedAt: iso(walk?.completedAt ?? null),
      completedRequests: walk?.completedRequests ?? null,
      failedAt: iso(walk?.failedAt ?? null),
      failure: walk?.failure ?? null,
    },
  };
}
