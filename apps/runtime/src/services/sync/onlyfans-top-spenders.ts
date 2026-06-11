// Gate for the OnlyFans top_spenders stream (Phase 5 of
// docs/ofapi-parity-plan.md, D10): rankings are computed from the existing
// transactions table — zero external requests — so eligibility is just the
// flag plus the platform. The executor handler itself lives next to the Fansly
// one in executor-handlers.ts (it reuses the same window/cursor machinery).

import {
  findPageById,
  listPageSyncStates,
  listPagesByPlatform,
  pausePageSync,
  type SyncStream,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";

export const ONLYFANS_TOP_SPENDERS_STREAMS = [
  "top_spenders",
] as const satisfies SyncStream[];

export function isOnlyFansTopSpendersEnabled(
  config?: Pick<AppContext["config"], "onlyFansTopSpendersEnabled">,
) {
  return config?.onlyFansTopSpendersEnabled === true;
}

export function isOnlyFansTopSpendersStream(stream: SyncStream) {
  return (ONLYFANS_TOP_SPENDERS_STREAMS as readonly SyncStream[]).includes(stream);
}

/** Strips top_spenders from OnlyFans requests while the flag is off. */
export function filterOnlyFansTopSpendersStreams(
  platform: "fansly" | "onlyfans",
  streams: readonly SyncStream[],
  config?: Pick<AppContext["config"], "onlyFansTopSpendersEnabled">,
) {
  if (platform !== "onlyfans" || isOnlyFansTopSpendersEnabled(config)) {
    return [...streams];
  }

  return streams.filter((stream) => !isOnlyFansTopSpendersStream(stream));
}

async function pauseOnlyFansTopSpendersForPage(app: AppContext, pageId: number, now: Date) {
  const states = await listPageSyncStates(app.db, {
    pageId,
    streams: [...ONLYFANS_TOP_SPENDERS_STREAMS],
  });
  if (
    states.length === ONLYFANS_TOP_SPENDERS_STREAMS.length &&
    states.every((state) => state.status === "paused")
  ) {
    return false;
  }

  await pausePageSync(app.db, {
    pageId,
    streams: [...ONLYFANS_TOP_SPENDERS_STREAMS],
    now,
  });
  return true;
}

export async function pauseDisabledOnlyFansTopSpendersForPage(
  app: AppContext,
  pageId: number,
  now = new Date(),
) {
  if (isOnlyFansTopSpendersEnabled(app.config)) {
    return false;
  }

  const storedPage = await findPageById(app.db, pageId);
  if (!storedPage || storedPage.page.platform !== "onlyfans") {
    return false;
  }

  return pauseOnlyFansTopSpendersForPage(app, pageId, now);
}

export async function pauseDisabledOnlyFansTopSpendersForAllPages(
  app: AppContext,
  now = new Date(),
) {
  if (isOnlyFansTopSpendersEnabled(app.config)) {
    return 0;
  }

  let pausedPages = 0;
  const pages = await listPagesByPlatform(app.db, "onlyfans");
  for (const page of pages) {
    if (await pauseOnlyFansTopSpendersForPage(app, page.id, now)) {
      pausedPages += 1;
    }
  }

  return pausedPages;
}
