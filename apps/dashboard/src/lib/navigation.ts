import { pathSegment } from "./path.js";

export interface FanProfileNavigationState {
  backTo: string;
  fanLabel?: string;
}

export type SettingsTab =
  | "credentials"
  | "sync"
  | "collection"
  | "models"
  | "personas"
  | "pages"
  | "users"
  | "agentKeys"
  | "configuration";

const SETTINGS_TABS = new Set<SettingsTab>([
  "credentials",
  "sync",
  "collection",
  "models",
  "personas",
  "pages",
  "users",
  "agentKeys",
  "configuration",
]);

export function buildPageRoute(pageLabel: string) {
  return `/pages/${pathSegment(pageLabel)}`;
}

export function decodeRouteSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildPageSectionRoute(pageLabel: string, section: string) {
  return `${buildPageRoute(pageLabel)}/${section}`;
}

export function buildPageSpenderAutoListRoute(pageLabel: string, bucketKey: string) {
  return `${buildPageSectionRoute(pageLabel, "spender-autolists")}/${pathSegment(bucketKey)}`;
}

export function buildWorkboardRoute(pageLabel: string) {
  return buildPageSectionRoute(pageLabel, "workboard");
}

/**
 * The Analytics page's range presets.
 *
 * Three, not seven, and 30d is the default because that is the window Fansly's
 * own widget shows — which is also the ONLY window where the Suggestions
 * denominator warning applies (A8). Keeping the set small keeps that warning
 * attached to the one view it is true of.
 */
export const ANALYTICS_RANGES = ["7d", "30d", "90d"] as const;

export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

const ANALYTICS_RANGE_DAYS: Readonly<Record<AnalyticsRange, number>> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

/** An unknown or absent value resolves to 30d rather than throwing: a deep link
 *  someone edited by hand should land on the page, not on an error. */
export function resolveAnalyticsRange(value: string | null | undefined): AnalyticsRange {
  return (ANALYTICS_RANGES as readonly string[]).includes(value ?? "")
    ? value as AnalyticsRange
    : "30d";
}

/** The granularity `now` is truncated to before it becomes a window bound.
 *
 *  A millisecond-precise `to` makes every remount a cache miss: the seven
 *  Analytics queries key on `window.from`/`window.to`, so a fresh `new Date()`
 *  produced seven new keys and seven refetches on every navigation back to the
 *  page, `staleTime` notwithstanding. A minute is coarse enough to hit the
 *  cache and fine enough that nobody can see the difference in a 7–90 day
 *  window. Keying by the PRESET alone would be wrong the other way — the
 *  window would never advance for as long as the tab stayed open. */
const ANALYTICS_WINDOW_GRANULARITY_MS = 60_000;

/** `[from, to)` for a range preset, as RFC 3339 instants with an explicit
 *  offset — the only form the serving routes accept. `to` is truncated to the
 *  minute so the bounds (and therefore the query keys built from them) are
 *  stable for every call made within the same minute. */
export function analyticsRange(
  range: AnalyticsRange,
  now: Date = new Date(),
): { from: string; to: string } {
  const to = new Date(
    Math.floor(now.getTime() / ANALYTICS_WINDOW_GRANULARITY_MS) * ANALYTICS_WINDOW_GRANULARITY_MS,
  );
  const from = new Date(to.getTime() - ANALYTICS_RANGE_DAYS[range] * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function buildAnalyticsRoute(pageLabel?: string | null, range?: AnalyticsRange) {
  const query = new URLSearchParams();
  if (pageLabel) {
    query.set("page", pageLabel);
  }
  if (range) {
    query.set("range", range);
  }
  const suffix = query.toString();
  return suffix.length > 0 ? `/analytics?${suffix}` : "/analytics";
}

export function buildAiAnalyticsRoute(pageLabel?: string | null) {
  if (!pageLabel) {
    return "/ai-analytics";
  }
  const query = new URLSearchParams({ page: pageLabel }).toString();
  return `/ai-analytics?${query}`;
}

export function resolveLegacyWorkboardRedirect(pageLabel: string | undefined) {
  return pageLabel ? buildWorkboardRoute(pageLabel) : "/";
}

export function buildFanProfileRoute(
  pageLabel: string,
  platform: string,
  platformUserId: string,
) {
  return `${buildPageRoute(pageLabel)}/fans/${pathSegment(platform)}/${pathSegment(platformUserId)}`;
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
    state: { backTo, fanLabel } satisfies FanProfileNavigationState,
  };
}

export function resolveFanLabelFromState(state: unknown): string | undefined {
  if (
    typeof state === "object"
    && state !== null
    && "fanLabel" in state
    && typeof state.fanLabel === "string"
  ) {
    return state.fanLabel;
  }
  return undefined;
}

export function buildSettingsRoute(tab: SettingsTab, pageLabel?: string) {
  const params = new URLSearchParams({ tab });
  if (tab === "sync" && pageLabel) {
    params.set("page", pageLabel);
  }
  return `/settings?${params.toString()}`;
}

export function resolveSettingsTab(value: string | null | undefined): SettingsTab {
  return typeof value === "string" && SETTINGS_TABS.has(value as SettingsTab)
    ? value as SettingsTab
    : "credentials";
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

  return pageLabel ? buildPageRoute(pageLabel) : "/";
}
