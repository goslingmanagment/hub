import {
  findPageById,
  listPageSyncStates,
  listPagesByPlatform,
  pausePageSync,
  type SyncStream,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { isOfapiDmSyncEligiblePage } from "./ofapi-dm-sync.ts";

export const ONLYFANS_DM_POLLING_STREAMS = [
  "dm_conversations",
] as const satisfies SyncStream[];

export const ONLYFANS_RETIRED_DM_STREAM = "dm_messages" as const satisfies SyncStream;

export const ONLYFANS_DM_POLLING_DISABLED_MESSAGE =
  "OnlyFans DM polling is disabled by ONLYFANS_DM_POLLING_ENABLED=false";

type DmStreamGateConfig = Pick<
  AppContext["config"],
  "onlyFansDmPollingEnabled" | "ofapiDmSyncEnabled"
>;

export function isOnlyFansDmPollingEnabled(
  config?: Pick<AppContext["config"], "onlyFansDmPollingEnabled">,
) {
  return config?.onlyFansDmPollingEnabled === true;
}

export function isOnlyFansDmPollingStream(stream: SyncStream) {
  return (ONLYFANS_DM_POLLING_STREAMS as readonly SyncStream[]).includes(stream);
}

export function filterOnlyFansDmPollingStreams(
  platform: "fansly" | "onlyfans",
  streams: readonly SyncStream[],
  config?: DmStreamGateConfig,
  // OFAPI-mapped pages keep their DM streams even with polling disabled — the
  // streams run the OFAPI REST handlers, not the parked OnlyMonster poller.
  page?: { ofapiAccountId: string | null },
) {
  if (platform !== "onlyfans") {
    return [...streams];
  }
  const withoutRetiredHistory = streams.filter(
    (stream) => stream !== ONLYFANS_RETIRED_DM_STREAM,
  );
  if (isOnlyFansDmPollingEnabled(config)) {
    return withoutRetiredHistory;
  }
  if (page && isOfapiDmSyncEligiblePage(config, { platform, ofapiAccountId: page.ofapiAccountId })) {
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

export async function pauseDisabledOnlyFansDmPollingForPage(
  app: AppContext,
  pageId: number,
  now = new Date(),
) {
  if (!app.config || isOnlyFansDmPollingEnabled(app.config)) {
    return false;
  }

  const storedPage = await findPageById(app.db, pageId);
  if (!storedPage || storedPage.page.platform !== "onlyfans") {
    return false;
  }
  if (isOfapiDmSyncEligiblePage(app.config, storedPage.page)) {
    return false;
  }

  return pauseOnlyFansDmPollingForPage(app, pageId, now);
}

export async function pauseDisabledOnlyFansDmPollingForAllPages(
  app: AppContext,
  now = new Date(),
) {
  if (!app.config || isOnlyFansDmPollingEnabled(app.config)) {
    return 0;
  }

  let pausedPages = 0;
  const pages = await listPagesByPlatform(app.db, "onlyfans");
  for (const page of pages) {
    if (isOfapiDmSyncEligiblePage(app.config, page)) {
      continue;
    }
    if (await pauseOnlyFansDmPollingForPage(app, page.id, now)) {
      pausedPages += 1;
    }
  }

  return pausedPages;
}
