import { pathSegment } from "@agency_hub_core/ui/path";
import { NO_SILENT_SIGNIN, isChatterSite, isConsoleSite, peerSiteOrigin, signInHopHref, silentSignInHref, workboardEntryHref } from "./sites.js";
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

/**
 * A page itself: Главная on that page. The page is a filter (its card left on
 * 12.11); `params` go along (`period`).
 */
export function buildPageRoute(pageLabel: string, params: Readonly<Record<string, string | null | undefined>> = {}) {
  return withQuery("/", { page: pageLabel, ...params });
}

export function decodeRouteSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * A page's own screen (they were the tabs of its card): its Fansly account and
 * login under Настройки → Модели и страницы, its promo under Трафик, its mass
 * messages under Публикации.
 */
export function buildPageSectionRoute(pageLabel: string, section: "account" | "promo" | "mass-messages" | "browser-login") {
  if (section === "account") return `/settings/pages/${pathSegment(pageLabel)}/account`;
  if (section === "browser-login") return `/settings/pages/${pathSegment(pageLabel)}/login`;
  return withQuery(section === "promo" ? "/traffic/promo" : "/content/mass-messages", { page: pageLabel });
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

/**
 * The sign-in page after a sign-out: it does not ask the other name, so a
 * session left there from before the names shared one does not sign the
 * person straight back in.
 */
export const SIGNED_OUT_LOGIN = `/login?${new URLSearchParams({ [NO_SILENT_SIGNIN.param]: NO_SILENT_SIGNIN.value }).toString()}`;

/**
 * The silent try of a sign-in page arrived at without a session (ecosystem plan
 * §3.2, «вошёл в одном месте — вошёл везде»): one round trip asks the other of
 * the two names; signed in there (a full session) → signed in here too, on this
 * same page, which then leads on as for anyone signed in; nobody → this page
 * again with the marker, which shows the form. Null — no other name (a local
 * build on one name, a test), or the marker is already here: no try.
 */
export function silentSignInTry(search: URLSearchParams, returnTo: string): string | null {
  if (search.get(NO_SILENT_SIGNIN.param) === NO_SILENT_SIGNIN.value) return null;
  const other = peerSiteOrigin();
  if (other === null || typeof window === "undefined") return null;
  const back = new URLSearchParams(returnTo === "/" ? {} : { next: returnTo });
  back.set(NO_SILENT_SIGNIN.param, NO_SILENT_SIGNIN.value);
  return silentSignInHref(other, `${window.location.origin}/login?${back.toString()}`);
}

export function buildLoginRoute(returnTo: string): string {
  const target = resolveLoginReturnPath(returnTo);
  return target === "/" ? "/login" : `/login?${new URLSearchParams({ next: target }).toString()}`;
}

/**
 * The account page (`/account`): devices, password, one's own AI spend — of
 * any role, and on the chatters' site every other role's only page: the
 * console is not served on that name.
 */
export const CABINET_PATH = "/account";

/**
 * Hub is the owner's place: a team lead and a chatter have Workboard alone
 * (products plan §2.2; the server's `productsOf` says the same).
 */
export function hasHub(role: string): boolean {
  return role === "owner";
}

/**
 * Workboard's home (`/workboard/`): a chatter's «Мои смены» (or «Начало» while a
 * newcomer's step is open), the team's Смены. Another app: a page load, never
 * the console's router; on the console's name it is on the team's name
 * (`workboardHere`).
 */
export const WORKBOARD_HOME = "/workboard/";

/** «Мои смены» itself: where the cabinet's old tabs lead a chatter. */
export const CHATTER_SHIFTS = "/workboard/my/shifts";

/** «Аккаунт и устройства»: Workboard's screen since 12.11 (the console's /account leads there). */
export const ACCOUNT_SCREEN = "/workboard/account";

/** The one-time code's way between the names (`/api/v1/auth/sso?…`): a page load, never the console's router. */
export function isSigninContinuation(path: string): boolean {
  return (path.split(/[?#]/)[0] ?? "") === "/api/v1/auth/sso";
}

/** A place outside the console's router on this host: Workboard, or the way to the other name. */
export function leavesTheConsole(path: string): boolean {
  return isWorkboardPath(path) || isSigninContinuation(path);
}

/**
 * A Workboard address (`/workboard/account`) as this page opens it: Workboard
 * has one address, the team's name, so from the console's name the browser goes
 * there through the one-time hand-off, signed in on the way (packages/ui sites.ts).
 */
export function workboardHere(path: string): string {
  return typeof window === "undefined" || !isWorkboardPath(path) ? path : workboardEntryHref(window.location.origin, path);
}

/**
 * Where someone without Hub (a team lead, a chatter) is sent from a console
 * page: Workboard's home. On the console's own name that home is on the team's
 * name: they are taken there, signed in (the session crosses by a one-time
 * code) — never turned away.
 */
export function workboardExit(): string {
  return workboardHere(WORKBOARD_HOME);
}

/**
 * Where a signed-in principal belongs. Someone without Hub (a team lead, a
 * chatter) has no console page to return to, so a remembered `next` wins only
 * when it is a place of theirs: Workboard or the account page; anything else,
 * or nothing, is Workboard's home. On the chatters' site the owner too lands in
 * Workboard or on the account page when that was asked for: the console is not
 * served on that name. Elsewhere the owner keeps the requested destination.
 * `requested` has passed `resolveLoginReturnPath`: a path of this host.
 */
export function resolveRoleHome(role: string, requested: string): string {
  if (hasHub(role) && !isChatterSite()) return requested;
  return opensWorkboard(requested) || opensCabinet(requested) ? requested : WORKBOARD_HOME;
}

/**
 * The address a fresh sign-in loads next. On the console's name the session is
 * planted on the team's name on the way (one-time code, a few redirects):
 * Workboard is there, and the owner's Hub home stays here. On the team's name
 * the owner's session is planted on the console's name too; anyone else stays
 * (Hub has nothing for them). A way back into the code's flow
 * (`/api/v1/auth/sso?…`, another name asking) is followed as it is. A local
 * build on one name has no other name: the home itself.
 */
export function afterSignIn(role: string, requested: string): string {
  if (isSigninContinuation(requested)) return requested;
  const home = resolveRoleHome(role, requested);
  const peer = peerSiteOrigin();
  if (peer === null || typeof window === "undefined") return home;
  if (isConsoleSite()) {
    return signInHopHref(peer, !hasHub(role) || opensWorkboard(home) ? `${peer}${home}` : `${window.location.origin}${home}`);
  }
  return hasHub(role) ? signInHopHref(peer, `${window.location.origin}${home}`) : home;
}

/**
 * The cabinet's old addresses of a chatter's shifts — the reports tab
 * (`/account?tab=report`) and the statistics (`/account?days=7|14|30`) — are
 * «Мои смены» now, with the window they asked for when Workboard's one period
 * has it (14 or 30 days). null: the account page itself (`/account`,
 * `?tab=profile`).
 */
export function cabinetRedirect(search: URLSearchParams): string | null {
  const tab = search.get("tab");
  const statistics = tab === null && search.has("days");
  if (tab !== "report" && !statistics) return null;
  const days = search.get("days");
  return days === "14" || days === "30" ? `${CHATTER_SHIFTS}?days=${days}` : CHATTER_SHIFTS;
}

/** The account page, with whatever it carries (`/account?tab=profile`). */
function opensCabinet(path: string): boolean {
  if (!isSafeInAppPath(path)) return false;
  return new URL(path, "https://hub.invalid").pathname.replace(/\/+$/, "") === CABINET_PATH;
}

/** A path into Workboard as the browser will open it: `/workboard/../settings` is the console's /settings. */
function opensWorkboard(path: string): boolean {
  if (!isSafeInAppPath(path)) return false;
  return isWorkboardPath(new URL(path, "https://hub.invalid").pathname);
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
