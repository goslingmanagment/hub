import { pathSegment } from "./path.js";
import type { PeriodOption } from "../stores/periodStore.js";
import type { SpenderPeriodOption } from "../stores/spenderPeriodStore.js";

export function resolveDashboardPeriod(value: string | null, fallback: PeriodOption): PeriodOption {
  return value !== null && ["today", "7d", "30d", "all"].includes(value) ? value as PeriodOption : fallback;
}

export function resolveSpenderPeriod(value: string | null, fallback: SpenderPeriodOption): SpenderPeriodOption {
  return value !== null && ["today", "7d", "30d", "90d", "180d", "all"].includes(value) ? value as SpenderPeriodOption : fallback;
}

export interface FanProfileNavigationState {
  backTo: string;
  fanLabel?: string;
}

export type SettingsTab =
  | "features"
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
  "features",
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

export function buildSettingsSectionRoute(source: URLSearchParams, tab: SettingsTab): string {
  const next = new URLSearchParams(source);
  next.set("tab", tab);
  // Feature selection belongs to its own links, not the section navigation.
  if (source.get("tab") === "features" || source.has("feature")) {
    next.delete("feature");
    next.delete("view");
    next.delete("q");
  }
  return `/settings?${next.toString()}`;
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

export function resolveLoginReturnPath(value: string | null | undefined): string {
  if (!value || !isSafeInAppPath(value)) return "/";
  const path = decodeURIComponent(new URL(value, "https://hub.invalid").pathname).replace(/\/+$/, "");
  const route = path.toLowerCase();
  if (route === "/login") return "/";
  // Decision 351: /join carries its one-time invitation secret in the URL
  // fragment, precisely because a fragment is never sent to the server. `next`
  // IS sent — it is a query parameter — so carrying the fragment across would
  // write the secret into the hub's request log and the host's access log.
  // Dropped here, centrally, so no caller can leak it by forwarding
  // `location.hash` without thinking about what is in it.
  //
  // Only /join. Fragments elsewhere are ordinary anchors and are kept: the
  // settings deep links return a person to the exact control they were sent
  // away from.
  if (route === "/join") return value.split("#")[0] ?? "/";
  return value;
}

export function buildLoginRoute(returnTo: string): string {
  const target = resolveLoginReturnPath(returnTo);
  return target === "/" ? "/login" : `/login?${new URLSearchParams({ next: target }).toString()}`;
}

/** Decision 351: the chatter's own home. The owner console is not theirs. */
export const CHATTER_HOME = "/account";

/**
 * Where a signed-in principal belongs. A chatter has no owner page to return
 * to — every one of them answers 403 — so a remembered `next` never overrides
 * the cabinet for them. Every other role keeps the requested destination.
 */
export function resolveRoleHome(role: string, requested: string): string {
  return role === "chatter" ? CHATTER_HOME : requested;
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
