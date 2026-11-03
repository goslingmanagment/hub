/**
 * Every old address of the console and where it lives now (design/ia.md §8.2).
 *
 * A promise to the owner: an old bookmark, a link in a message and the browser's
 * history land where they always did, with their query parameters, their anchor
 * and their navigation state. A redirect only navigates: it never writes, and
 * rights are checked by the route it lands on.
 */
import { matchPath } from "react-router";
import { decodedPath, pathSegment } from "./path.js";

export type RouteParams = Readonly<Record<string, string | undefined>>;

export interface LegacyRule {
  /** A path pattern of the new address, or a function of the old one's params and
   *  query. The function may change `query` (it is the target's query). */
  to: string | ((params: RouteParams, query: URLSearchParams) => string);
  /** Old parameter → new parameter. */
  rename?: Readonly<Record<string, string>>;
  /** This parameter holds a number of days: its value + "d" goes to `period`. */
  days?: string;
  /** `:pageLabel` of the old path → `?page=`. */
  pageFromPath?: boolean;
  /** Fixed parameters of the target. */
  set?: Readonly<Record<string, string>>;
  /** Removed after `to` ran, since `to` may read them. */
  drop?: readonly string[];
  /** A fixed anchor; otherwise the old one is kept. */
  hash?: string;
}

export interface LegacyTarget {
  pathname: string;
  search: string;
  hash: string;
}

function fillPath(pattern: string, params: RouteParams): string {
  return pattern.replace(/:([A-Za-z]+)/g, (_, name: string) => pathSegment(params[name] ?? ""));
}

/** Where a rule takes this old address. Keeps every parameter it was not told to touch. */
export function legacyTarget(rule: LegacyRule, params: RouteParams, search: string, hash: string): LegacyTarget {
  const query = new URLSearchParams(search);
  for (const [from, to] of Object.entries(rule.rename ?? {})) {
    const value = query.get(from);
    if (value !== null) {
      query.delete(from);
      query.set(to, value);
    }
  }
  if (rule.days) {
    const value = query.get(rule.days);
    if (value !== null) {
      query.delete(rule.days);
      query.set("period", `${value}d`);
    }
  }
  if (rule.pageFromPath && params.pageLabel !== undefined) query.set("page", params.pageLabel);
  for (const [key, value] of Object.entries(rule.set ?? {})) query.set(key, value);
  const pathname = typeof rule.to === "function" ? rule.to(params, query) : fillPath(rule.to, params);
  for (const name of rule.drop ?? []) query.delete(name);
  const text = query.toString();
  return { pathname, search: text ? `?${text}` : "", hash: rule.hash ?? hash };
}

/** Addresses that are only old now: a route of their own, numbers as in §8.2. */
export const LEGACY_ROUTES: ReadonlyArray<LegacyRule & { path: string }> = [
  { path: "transactions", to: "/money/transactions", rename: { pageLabel: "page" } }, // 2
  { path: "pages", to: "/settings/pages" }, // 3
  { path: "pages/:pageLabel/subscribers", to: "/fans/subscribers", pageFromPath: true }, // 5
  { path: "pages/:pageLabel/followers", to: "/fans/followers", pageFromPath: true }, // 6
  { path: "pages/:pageLabel/top-supporters", to: "/fans", pageFromPath: true }, // 7
  { path: "pages/:pageLabel/deleted-fans", to: "/fans/gone", pageFromPath: true }, // 8
  { path: "pages/:pageLabel/profile", to: "/pages/:pageLabel/account" }, // 9
  { path: "pages/:pageLabel/settings", to: "/pages/:pageLabel/account", hash: "#fansly-settings" }, // 10
  { path: "pages/:pageLabel/spender-autolists/:bucketKey", to: "/fans/by-spend/:bucketKey", pageFromPath: true }, // 11
  { path: "pages/:pageLabel/fans/:platform/:platformUserId", to: "/fans/:pageLabel/:platform/:platformUserId" }, // 12
  { path: "browser-profiles/new", to: "/settings/pages/connect", rename: { page: "forPage" } }, // 13
  { path: "browser-profiles/:profileId", to: "/settings/pages/connect/:profileId" }, // 14
  {
    path: "ofapi-marketing", // 15, 16
    to: (_, query) => {
      const page = query.get("page");
      query.delete("page");
      return page ? `/pages/${pathSegment(page)}/promo` : "/system/onlyfans-api";
    },
  },
  { path: "ofapi-media", to: "/system/onlyfans-api/media" }, // 17
  { path: "ofapi-exports", to: "/system/onlyfans-api/exports" }, // 18
  { path: "ofapi-actions", to: "/system/onlyfans-api/actions" }, // 19
  { path: "ofapi-credits", to: "/money/costs/onlyfans-api" }, // 20
  { path: "usage", to: "/money/costs/ai" }, // 21
  { path: "ai-spend", to: "/money/costs/ai" }, // 22
  { path: "publication-settings", to: "/publications", set: { panel: "settings" } }, // 23
  { path: "team", to: "/team/shifts" }, // 24
  {
    path: "team/authors", // 25
    to: (_, query) => {
      const period: Readonly<Record<string, string>> = { "1": "24h", "3": "3d", "7": "7d" };
      query.set("period", period[query.get("days") ?? "7"] ?? "7d");
      query.delete("days");
      return "/team/shifts";
    },
    hash: "#authors",
  },
  { path: "team/approaches", to: "/team/win-back", days: "days" }, // 26
  { path: "team/numbers", to: "/team/chatters" }, // 27
  { path: "team/shift-reports", to: "/team/payouts" }, // 28
  {
    path: "team/chatter-stats", // 29, 30
    days: "days",
    to: (_, query) => {
      const user = query.get("user");
      query.delete("user");
      return user ? `/team/chatters/${pathSegment(user)}` : "/team/chatters";
    },
  },
  { path: "held-sends", to: "/team/held-sends" }, // 31
  { path: "agent-hydration", to: "/system/history-requests" }, // 32
  { path: "incidents", to: "/system/failures" }, // 33
  { path: "analytics", to: "/stats", rename: { range: "period" } }, // 34
  { path: "notifications", drop: ["tab"], to: (_, query) => (query.get("tab") === "incidents" ? "/system/failures" : "/settings/notifications") }, // 39, 40
  { path: "dev", to: "/system/dev/log" }, // 58
  { path: "dev/log", to: "/system/dev/log" }, // 59
  { path: "dev/queue", to: "/system/dev/queue" }, // 60
  { path: "dev/db-stats", to: "/system/dev/database" }, // 61
  { path: "dev/incidents", to: "/system/dev/log", set: { problems: "1" } }, // 62
  {
    path: "dev/sync-status", // 63, 64
    to: (_, query) => {
      const run = query.get("runId");
      query.delete("runId");
      return run ? `/system/dev/log/${pathSegment(run)}` : "/system/dev/log";
    },
  },
  { path: "dev/client-health", to: "/system/dev/extension" }, // §7.1, row 50
  // The roots of the new sections (65–69).
  { path: "money", to: "/money/income" },
  { path: "money/costs", to: "/money/costs/ai" },
  { path: "settings/ai", to: "/settings/ai/personas" },
  { path: "system", to: "/system/collection" },
  { path: "system/dev", to: "/system/dev/log" },
];

// Four addresses are alive: the same path is a new screen, some of its old
// parameters are not. Each answers with a rule or stays where it is.

/** `/`: row, chart and sort belong to Income; a bare `/` and `/?period=` stay Home (1). */
export function homeLegacyRule(query: URLSearchParams): LegacyRule | null {
  return query.has("row") || query.has("chart") || query.has("sort") ? { to: "/money/income" } : null;
}

/** `/pages/:pageLabel`: the old block of operations (4). */
export function pageCardLegacyRule(query: URLSearchParams): LegacyRule | null {
  return query.has("type") || query.has("txOffset")
    ? { to: "/money/transactions", pageFromPath: true, rename: { txOffset: "offset" } }
    : null;
}

/** `/stats`: the old tabs and days (35–38). */
export function statsLegacyRule(query: URLSearchParams): LegacyRule | null {
  const tab = query.get("tab");
  if (tab === null && !query.has("days")) return null;
  return {
    days: "days",
    drop: ["tab"],
    to: tab === "content" ? "/stats/content" : tab === "audience" ? "/stats/audience" : "/stats",
  };
}

const SETTINGS_TAB_TARGET: Readonly<Record<string, string>> = {
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

/** `/settings`: every old `?tab=` (41–57); a new settings screen has its own path. */
export const SETTINGS_INDEX_RULE: LegacyRule = {
  drop: ["tab"],
  to: (_, query) => {
    const tab = query.get("tab") ?? "";
    const page = query.get("page");
    query.delete("page");
    if ((tab === "engine" || tab === "sync") && page) return `/system/collection/${pathSegment(page)}`;
    const feature = query.get("feature");
    if (tab === "configuration" && feature) {
      query.delete("feature");
      return `/settings/ai/features/${pathSegment(feature)}`;
    }
    return SETTINGS_TAB_TARGET[tab] ?? "/settings/pages";
  },
};

/**
 * The address an old one lands on, or null if this address is not an old one.
 * The table test reads this; the routes in routes/legacy.tsx apply the same rules.
 */
export function resolveLegacyUrl(url: string): string | null {
  const parsed = new URL(url, "https://hub.invalid");
  const { search, hash } = parsed;
  const pathname = decodedPath(parsed.pathname);
  const query = new URLSearchParams(search);
  const live = pathname === "/" ? homeLegacyRule(query)
    : pathname === "/stats" ? statsLegacyRule(query)
      : pathname === "/settings" ? SETTINGS_INDEX_RULE
        : null;
  if (live) return printTarget(legacyTarget(live, {}, search, hash));
  const card = matchPath({ path: "/pages/:pageLabel", end: true }, pathname);
  if (card && pathname !== "/pages/") {
    const rule = pageCardLegacyRule(query);
    if (rule) return printTarget(legacyTarget(rule, card.params, search, hash));
  }
  for (const rule of LEGACY_ROUTES) {
    const match = matchPath({ path: `/${rule.path}`, end: true }, pathname);
    if (match) return printTarget(legacyTarget(rule, match.params, search, hash));
  }
  return null;
}

function printTarget(target: LegacyTarget): string {
  return `${target.pathname}${target.search}${target.hash}`;
}
