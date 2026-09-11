import {
  buildFanProfileNavigation,
  isSafeInAppPath,
  resolveFanProfileBackTarget,
} from "./navigation.js";
import type { SpenderPeriodOption as SpenderPeriod } from "../stores/spenderPeriodStore.js";

export type FollowerFilter = "all" | "new24h" | "unmessaged" | "active" | "subscribers";

const FOLLOWER_FILTERS = new Set<FollowerFilter>(["all", "new24h", "unmessaged", "active", "subscribers"]);

export function followerFilter(value: string | null): FollowerFilter {
  return FOLLOWER_FILTERS.has(value as FollowerFilter) ? value as FollowerFilter : "all";
}

export function audiencePeriod(value: string | null, fallback: SpenderPeriod): SpenderPeriod {
  return value !== null && ["today", "7d", "30d", "90d", "180d", "all"].includes(value)
    ? value as SpenderPeriod
    : fallback;
}

/** Change filters atomically so a new query never inherits an old page offset. */
export function updateAudienceSearch(
  previous: URLSearchParams,
  changes: Record<string, string | null>,
  resetOffset = true,
) {
  const next = new URLSearchParams(previous);
  if (resetOffset) next.delete("offset");
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
  }
  return next;
}

/** Include the return path in the URL as well as state: new tabs retain it. */
export function buildAudienceFanNavigation(
  pageLabel: string,
  platform: string,
  platformUserId: string,
  backTo: string,
  fanLabel?: string,
  period?: SpenderPeriod,
) {
  let safeBackTo = resolveFanProfileBackTarget({ backTo }, pageLabel);
  if (period) {
    const source = new URL(safeBackTo, "https://hub.invalid");
    source.searchParams.set("period", period);
    safeBackTo = `${source.pathname}${source.search}${source.hash}`;
  }
  const navigation = buildFanProfileNavigation(pageLabel, platform, platformUserId, safeBackTo, fanLabel);
  const search = new URLSearchParams({ backTo: safeBackTo });
  if (period) search.set("period", period);
  return {
    ...navigation,
    to: `${navigation.to}?${search}`,
  };
}

export function resolveAudienceBackTarget(search: string, state: unknown, pageLabel: string | undefined) {
  const backTo = new URLSearchParams(search).get("backTo");
  return backTo && isSafeInAppPath(backTo)
    ? backTo
    : resolveFanProfileBackTarget(state, pageLabel);
}

export const audiencePaginationLabels = {
  emptyLabel: "0 записей",
  previousLabel: "Назад",
  nextLabel: "Далее",
  formatRange: (start: number, end: number, total: number) => `${start}–${end} из ${total}`,
};
