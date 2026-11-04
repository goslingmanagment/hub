import { pathSegment } from "./path.js";
import { isChatterSite, isConsoleSite } from "./sites.js";
import type { Period, PeriodOption, SpenderPeriodOption } from "../stores/periodStore.js";

/**
 * The period a revenue report shows for the console's period. Revenue is
 * computed for today, 7 and 30 days and all time only; a longer spender
 * window shows its last 30 days there, and the period control marks 30 days.
 */
export function revenuePeriod(period: Period): PeriodOption {
  if (period === "90d" || period === "180d" || period === "365d") return "30d";
  return period === "14d" ? "7d" : period;
}

const KNOWN_PERIODS: readonly string[] = ["today", "7d", "14d", "30d", "90d", "180d", "365d", "all"];

/** A period from the address, or the remembered one. */
function askedPeriod(value: string | null, fallback: Period): Period {
  return value !== null && KNOWN_PERIODS.includes(value) ? value as Period : fallback;
}

export function resolveDashboardPeriod(value: string | null, fallback: Period): PeriodOption {
  return revenuePeriod(askedPeriod(value, fallback));
}

export function resolveSpenderPeriod(value: string | null, fallback: Period): SpenderPeriodOption {
  const asked = askedPeriod(value, fallback);
  if (asked === "365d") return "180d";
  return asked === "14d" ? "7d" : asked;
}

export interface FanProfileNavigationState {
  backTo: string;
  fanLabel?: string;
}

export type SettingsTab =
  | "features"
  | "credentials"
  | "engine"
  | "sync"
  | "collection"
  | "models"
  | "personas"
  | "pages"
  | "users"
  | "agentKeys"
  | "configuration"
  | "ofapi"
  | "notifications";

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

/** A tab or a screen of a page's card (the page is in the path). */
export function buildPageSectionRoute(pageLabel: string, section: "account" | "promo" | "mass-messages" | "browser-login") {
  return `${buildPageRoute(pageLabel)}/${section}`;
}

function withQuery(path: string, params: Readonly<Record<string, string | null | undefined>>): string {
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

/**
 * The Analytics page's range presets.
 *
 * The periods of «Статистика», and 30d is the default because that is the window
 * Fansly's own widget shows — which is also the ONLY window where the Suggestions
 * denominator warning applies (A8).
 */
export const ANALYTICS_RANGES = ["7d", "30d", "90d", "180d", "365d"] as const;

export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

const ANALYTICS_RANGE_DAYS: Readonly<Record<AnalyticsRange, number>> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "180d": 180,
  "365d": 365,
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

/** The two ways a page is read: `engine` is the Fansly Sync Engine's, `sync` the
 *  legacy page-sync executor's. Both show a page at /system/collection/:pageLabel. */
export type SyncSettingsTab = Extract<SettingsTab, "engine" | "sync">;

/** The platforms the Fansly Sync Engine reads; every other platform's pages
 *  are the legacy executor's. One table, so no screen compares a platform to
 *  decide where a page's sync is shown. */
const SYNC_SETTINGS_TAB_BY_PLATFORM: Readonly<Partial<Record<string, SyncSettingsTab>>> = {
  fansly: "engine",
};

/** Which of the two reads a page of this platform. */
export function syncSettingsTab(platform: string): SyncSettingsTab {
  return SYNC_SETTINGS_TAB_BY_PLATFORM[platform] ?? "sync";
}

/** Where each old Settings tab lives now. */
const SETTINGS_TAB_ROUTES: Readonly<Record<SettingsTab, string>> = {
  pages: "/settings/pages",
  models: "/settings/pages",
  credentials: "/settings/pages",
  users: "/team/people",
  personas: "/settings/ai/personas",
  notifications: "/settings/notifications",
  collection: "/system/onlyfans-api/collection",
  ofapi: "/system/onlyfans-api/tools",
  agentKeys: "/system/agent-keys",
  features: "/settings/ai/features",
  configuration: "/system/dev/config",
  engine: "/system/collection",
  sync: "/system/collection",
};

export function buildSettingsRoute(tab: SettingsTab, pageLabel?: string) {
  if ((tab === "sync" || tab === "engine") && pageLabel) return buildPageCollectionRoute(pageLabel);
  return SETTINGS_TAB_ROUTES[tab];
}

/** A page's collection screen: the page is in the path, so a lever on it cannot
 *  take its target from anywhere else. */
export function buildPageCollectionRoute(pageLabel: string) {
  return `/system/collection/${pathSegment(pageLabel)}`;
}

/** A page's sync detail. */
export function buildPageSyncRoute(_platform: string, pageLabel: string) {
  return buildPageCollectionRoute(pageLabel);
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
  // /join carries its one-time invitation secret in the URL
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

/** The chatter's own home. The owner console is not theirs. */
export const CHATTER_HOME = "/account";

/**
 * Where a chatter is sent from a console page. Their cabinet — except on the
 * console's own production name: no cabinet is served there, a chatter login
 * is not a way in, and the sign-in page ends the session and says where the
 * account is.
 */
export function chatterExit(): string {
  return isConsoleSite() ? "/login" : CHATTER_HOME;
}

/**
 * Where a signed-in principal belongs. A chatter has no owner page to return
 * to — every one of them answers 403 — so a remembered `next` never overrides
 * the cabinet for them. On the chatters' site that holds for every role: the
 * console is not served on that name, so the cabinet is the only home there.
 * Elsewhere every other role keeps the requested destination.
 */
export function resolveRoleHome(role: string, requested: string): string {
  return isChatterSite() || role === "chatter" ? CHATTER_HOME : requested;
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

/** The second part of connecting a page: its browser, by its profile. */
export function browserProfileRoute(profileId: string): string {
  return `/settings/pages/connect/${pathSegment(profileId)}`;
}

/** The first part of connecting a page; `name` opens that draft. */
export function browserDraftRoute(name?: string): string {
  return name === undefined ? "/settings/pages/connect" : `/settings/pages/connect?name=${encodeURIComponent(name)}`;
}
