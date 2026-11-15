import { pathSegment } from "./path.js";

/**
 * The addresses of «Фаны» (products package M): its screens live in Workboard (`/workboard/fans…`); these paths are
 * the router's own there (`/fans/…`). The console's old `/fans…` addresses lead there (its redirects).
 */

export interface FanProfileNavigationState {
  backTo: string;
  fanLabel?: string;
}

export function decodeRouteSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function withQuery(path: string, params: Readonly<Record<string, string | null | undefined>>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") query.set(key, value);
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

/** A list of fans of one page. `?page=` only narrows the list. */
export function buildFansRoute(
  view: "paying" | "subscribers" | "followers" | "gone" | "by-spend",
  pageLabel: string,
  params: Readonly<Record<string, string | null | undefined>> = {},
) {
  return withQuery(view === "paying" ? "/fans" : `/fans/${view}`, { page: pageLabel, ...params });
}

export function buildPageSpenderAutoListRoute(
  pageLabel: string,
  bucketKey: string,
  params: Readonly<Record<string, string | null | undefined>> = {},
) {
  return withQuery(`/fans/by-spend/${pathSegment(bucketKey)}`, { page: pageLabel, ...params });
}

function buildFanProfileRoute(
  pageLabel: string,
  platform: string,
  platformUserId: string,
) {
  return `/fans/${pathSegment(pageLabel)}/${pathSegment(platform)}/${pathSegment(platformUserId)}`;
}

export function buildFanProfileNavigation(
  pageLabel: string,
  platform: string,
  platformUserId: string,
  backTo: string,
  fanLabel?: string,
) {
  return {
    to: buildFanProfileRoute(pageLabel, platform, platformUserId),
    state: { backTo, ...(fanLabel === undefined ? {} : { fanLabel }) } satisfies FanProfileNavigationState,
  };
}

export function isSafeInAppPath(value: string) {
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\p{Cc}\s]/u.test(value))
    return false;
  try {
    const url = new URL(value, "https://hub.invalid");
    const decoded = decodeURIComponent(url.pathname);
    return url.origin === "https://hub.invalid"
      && !/[\\\p{Cc}]/u.test(decoded)
      && !decoded.startsWith("//");
  } catch {
    return false;
  }
}

export function resolveFanProfileBackTarget(
  state: unknown,
  pageLabel: string | undefined,
) {
  if (
    typeof state === "object"
    && state !== null
    && "backTo" in state
    && typeof state.backTo === "string"
    && isSafeInAppPath(state.backTo)
  ) {
    return state.backTo;
  }

  return pageLabel ? buildFansRoute("paying", pageLabel) : "/";
}

export function safeBackTo(params: URLSearchParams): string {
  const backTo = params.get("backTo");
  return backTo && isSafeInAppPath(backTo) ? backTo : "/";
}

export const SUBSCRIBER_FILTERS = [
  "all",
  "paid",
  "free",
  "expiring7d",
  "new24h",
  "norenew",
] as const;

export type SubscriberFilter = (typeof SUBSCRIBER_FILTERS)[number];

export function subscriberFilter(value: string | null): SubscriberFilter {
  return SUBSCRIBER_FILTERS.includes(value as SubscriberFilter)
    ? (value as SubscriberFilter)
    : "all";
}

export function listOffset(value: string | null): number {
  const offset = Number(value);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}
