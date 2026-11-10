import { pathSegment } from "./path.js";
import { isChatterSite, isConsoleSite } from "./sites.js";
import type { Period, PeriodOption } from "../stores/periodStore.js";

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

export interface FanProfileNavigationState {
  backTo: string;
  fanLabel?: string;
}

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

/** A page's collection screen: the page is in the path, so a lever on it cannot
 *  take its target from anywhere else. */
export function buildPageCollectionRoute(pageLabel: string) {
  return `/system/collection/${pathSegment(pageLabel)}`;
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

/**
 * Workboard: another app on this host (`/workboard/`, served by Hub beside the
 * console). Its sign-in is this one, and a `next` into it is opened with a page
 * load: the console's router has no such route. Only these paths, and only
 * after `resolveLoginReturnPath` has checked they are paths of this host.
 */
export function isWorkboardPath(path: string): boolean {
  const pathname = path.split(/[?#]/)[0] ?? "";
  return pathname === "/workboard" || pathname.startsWith("/workboard/");
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
