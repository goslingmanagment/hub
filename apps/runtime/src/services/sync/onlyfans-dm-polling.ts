import {
  findPageById,
  listPageSyncStates,
  listPagesByPlatform,
  pausePageSync,
  type SyncStream,
} from "@agency_hub_core/db";

import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { isOfapiDmSyncEligiblePage } from "./ofapi-dm-sync.ts";

// OnlyFans DM streams run only through the OFAPI REST handlers (the OnlyMonster
// poller is gone): a page that is not mapped to an OFAPI account keeps its DM
// stream parked until it is mapped.
export const ONLYFANS_DM_POLLING_STREAMS = [
  "dm_conversations",
] as const satisfies SyncStream[];

export const ONLYFANS_RETIRED_DM_STREAM = "dm_messages" as const satisfies SyncStream;

export const ONLYFANS_DM_REQUIRES_OFAPI_MESSAGE =
  "OnlyFans DM sync needs the page mapped to an OFAPI account";

export function isOnlyFansDmPollingStream(stream: SyncStream) {
  return (ONLYFANS_DM_POLLING_STREAMS as readonly SyncStream[]).includes(stream);
}

export function filterOnlyFansDmPollingStreams(
  platform: Platform,
  streams: readonly SyncStream[],
  page?: { ofapiAccountId: string | null },
) {
  if (platform !== "onlyfans") {
    return [...streams];
  }
  const withoutRetiredHistory = streams.filter(
    (stream) => stream !== ONLYFANS_RETIRED_DM_STREAM,
  );
  if (page && isOfapiDmSyncEligiblePage({ platform, ofapiAccountId: page.ofapiAccountId })) {
    return withoutRetiredHistory;
  }

  return withoutRetiredHistory.filter((stream) => !isOnlyFansDmPollingStream(stream));
}

async function pauseOnlyFansDmPollingForPage(
  app: AppContext,
  pageId: number,
  now: Date,
) {
  const states = await listPageSyncStates(app.db, {
    pageId,
    streams: [...ONLYFANS_DM_POLLING_STREAMS],
  });
  if (
    states.length === ONLYFANS_DM_POLLING_STREAMS.length &&
    states.every((state) => state.status === "paused")
  ) {
    return false;
  }

  await pausePageSync(app.db, {
    pageId,
    streams: [...ONLYFANS_DM_POLLING_STREAMS],
    now,
  });
  return true;
}

export async function pauseUnmappedOnlyFansDmForPage(
  app: AppContext,
  pageId: number,
  now = new Date(),
) {
  const storedPage = await findPageById(app.db, pageId);
  if (!storedPage || storedPage.page.platform !== "onlyfans") {
    return false;
  }
  if (isOfapiDmSyncEligiblePage(storedPage.page)) {
    return false;
  }

  return pauseOnlyFansDmPollingForPage(app, pageId, now);
}

export async function pauseUnmappedOnlyFansDmForAllPages(
  app: AppContext,
  now = new Date(),
) {
  let pausedPages = 0;
  const pages = await listPagesByPlatform(app.db, "onlyfans");
  for (const page of pages) {
    if (isOfapiDmSyncEligiblePage(page)) {
      continue;
    }
    if (await pauseOnlyFansDmPollingForPage(app, page.id, now)) {
      pausedPages += 1;
    }
  }

  return pausedPages;
}
