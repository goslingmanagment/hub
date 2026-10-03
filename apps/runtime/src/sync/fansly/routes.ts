import { createHash } from "node:crypto";

import { FANSLY_WIRE_SPECS, type FanslyWireId } from "@agency_hub_core/fansly";

// The Fansly route policy table (step 3b, owner decisions №21–№26, plan PR
// 1-1): every route a request of a page can take — each wire spec of
// `packages/fansly/src/wire/specs.ts`, the socket's Upgrade and the media CDN
// included, plus the endpoints only the legacy engine reads — with its family
// and its budget. Fansly's quota is a bucket per page and endpoint (≈ 20 a
// minute, `impl/research-astra-quota-model.md`), so each route of a page gets
// its own strict budget, never a burst above it; two families whose shared
// quota the data cannot rule out also share one (messaging, earnings).
//
// A canonical route is one method + host class + path template: one GET
// endpoint. Its parameters (a chat, a media, an offset, a window) never make
// another route. The engine sends only wire routes, under their wire id; the
// legacy send log (`fansly_send_log.operation`) names the adapter's
// operation, mapped here so both journals count against the same budgets
// after a switch (`FANSLY_LEGACY_OPERATION_ROUTES`, pinned complete by
// tests/sync-route-policy.test.ts).
//
// Budgets are code constants: S stays the owner's only setting. Each has a
// `ceiling` (the code maximum) and a `current` (what every page runs at);
// `current` moves only by a calibration PR, +1/min per evidenced step, never
// above the ceiling (A2). A page's stored route state (`engine/route-policy.ts`)
// may only make a route slower.

/** The endpoints only the legacy engine reads (its adapter's lanes and
 *  probes without an engine resource): routes of their own, so a legacy send
 *  on them is counted where it belongs. */
const LEGACY_ONLY_ROUTES = {
  "earnings.overview": "/account/wallets/earnings",
  "lists.account": "/lists/account",
  "lists.items": "/lists/itemsnew",
  "groups.mediaoffers": "/groups/mediaoffers",
  "account.media_orders": "/account/media/orders",
  "tips.account": "/tips/account",
  "mediastory.views": "/mediastory/views",
} as const;

type LegacyOnlyRoute = keyof typeof LEGACY_ONLY_ROUTES;

/** A canonical Fansly route: a wire id (the engine's) or a legacy-only one. */
export type FanslyRoute = FanslyWireId | LegacyOnlyRoute;

export type FanslyRouteHost = "api" | "ws" | "cdn";

export interface FanslyRouteSpec {
  route: FanslyRoute;
  /** Every route is a GET (Fansly is only read; the Upgrade is a GET too). */
  method: "GET";
  host: FanslyRouteHost;
  /** The path template (`:id` / `{id}` for a path parameter). */
  template: string;
  /** The wire spec that sends it; null for a legacy-only endpoint. */
  wire: FanslyWireId | null;
}

/** The families that share one budget besides each route's own. */
export const FANSLY_ROUTE_FAMILIES = {
  /** The chat reads: the list, a group's detail and `/message` — one shared
   *  bucket (≈ 19.9/min, 10 burst) explains every answer on record. */
  messaging: ["messaging.groups", "group.detail", "messages.page"],
  /** `/account/wallets/earnings/*`: proven ≥ 22.8/min as a whole for an hour. */
  earnings: [
    "earnings.overview",
    "transactions.page",
    "earnings.accounts",
    "earnings.stats_accounts",
    "earnings.monthly_accounts",
    "earnings.stats_window",
    "earnings.monthly",
  ],
} as const satisfies Record<string, readonly FanslyRoute[]>;

export type FanslyRouteFamily = keyof typeof FANSLY_ROUTE_FAMILIES;

export const FANSLY_ROUTE_FAMILY_IDS = Object.keys(FANSLY_ROUTE_FAMILIES) as FanslyRouteFamily[];

export interface RouteBudget {
  /** The code maximum, requests a minute: the owner's answer (≤ 15; the list
   *  12; the media statistics 12). */
  ceilingPerMin: number;
  /** What every page runs at, ≤ the ceiling: a calibration PR moves it, +1/min
   *  a step, on evidence (`budgets-calibration.sql`). */
  currentPerMin: number;
}

/** Every route without an entry of its own (owner decision №21: 15/min). */
export const DEFAULT_ROUTE_BUDGET: RouteBudget = { ceilingPerMin: 15, currentPerMin: 15 };

/** The routes with a budget of their own (owner decisions №21, №14, №20, D2). */
export const ROUTE_BUDGETS: Readonly<Partial<Record<FanslyRoute, RouteBudget>>> = {
  // The conversation list: months on a 5 s floor without a 429.
  "messaging.groups": { ceilingPerMin: 12, currentPerMin: 12 },
  // The media statistics start at 5/min (12 s): safe under every quota model
  // the data leaves (a 405-an-hour window, a slow 7.5/min refill); the
  // ceiling is the owner's original 12/min, reached only by evidence steps.
  "media.offer_stats": { ceilingPerMin: 12, currentPerMin: 5 },
};

/** The family budgets (owner decision №21, D4): combined, on top of each
 *  member's own. */
export const FAMILY_BUDGETS: Readonly<Record<FanslyRouteFamily, RouteBudget>> = {
  messaging: { ceilingPerMin: 15, currentPerMin: 15 },
  earnings: { ceilingPerMin: 17, currentPerMin: 17 },
};

/**
 * `fansly_send_log.operation` → the route it read: every operation a legacy
 * sender journals — the adapter's lanes and probes (`packages/fansly/src/
 * adapter.ts`), the media download, the binding preflight, the socket
 * connect and the socket probes. Pinned complete against the code and each
 * wire spec's `legacyOperation` by tests/sync-route-policy.test.ts.
 */
export const FANSLY_LEGACY_OPERATION_ROUTES: Readonly<Record<string, FanslyRoute>> = {
  account_me: "account.me",
  account_lookup: "accounts.by_ids",
  messaging_groups: "messaging.groups",
  group_detail: "group.detail",
  messages: "messages.page",
  earnings_overview: "earnings.overview",
  earnings_transactions: "transactions.page",
  earnings_accounts: "earnings.accounts",
  earnings_stats_accounts: "earnings.stats_accounts",
  earnings_monthlystats_accounts: "earnings.monthly_accounts",
  earnings_stats_window: "earnings.stats_window",
  earnings_monthly_stats: "earnings.monthly",
  media_orderhistory: "media.order_history",
  payout_methods: "payouts.methods",
  payout_requests: "payouts.requests",
  subscribers: "subscribers.page",
  followers: "followers.page",
  notifications_page: "notifications.page",
  lists_account: "lists.account",
  list_items: "lists.items",
  timeline_posts: "posts.timeline",
  post_tips: "posts.tips",
  post_lookup: "posts.by_ids",
  post_replies: "post.replies",
  vault_albums: "vault.albums",
  uservault_albums: "uservault.albums",
  subscription_tiers: "subscriptions.tiers",
  gift_codes: "subscriptions.giftcodes",
  automated_messages: "message.automated",
  account_walls_probe: "account.walls",
  vault_media: "vault.media",
  account_media_by_ids_probe: "account.media_by_ids",
  account_media_bundles_by_ids_probe: "account.bundles_by_ids",
  media_offer_stats: "media.offer_stats",
  account_stats: "account.stats",
  tracking_links: "trackinglinks",
  discovery_media_suggestions: "discovery.suggestions",
  broadcast_stats_probe: "broadcast.stats",
  broadcast_stats_deleted_probe: "broadcast.stats_deleted",
  broadcast_scheduled_probe: "broadcast.scheduled",
  polls_probe: "polls",
  recapstats_probe: "recapstats",
  group_mediaoffers_probe: "groups.mediaoffers",
  account_media_orders_probe: "account.media_orders",
  tips_account_probe: "tips.account",
  mediastory_views_probe: "mediastory.views",
  media_download: "cdn.media",
  ws_connect: "ws.upgrade",
  ws_probe: "ws.upgrade",
};

function buildCatalogue(): ReadonlyMap<FanslyRoute, FanslyRouteSpec> {
  const routes = new Map<FanslyRoute, FanslyRouteSpec>();
  for (const spec of Object.values(FANSLY_WIRE_SPECS)) {
    routes.set(spec.id, { route: spec.id, method: "GET", host: spec.host, template: spec.endpointTemplate, wire: spec.id });
  }
  for (const [route, template] of Object.entries(LEGACY_ONLY_ROUTES) as Array<[LegacyOnlyRoute, string]>) {
    routes.set(route, { route, method: "GET", host: "api", template, wire: null });
  }
  return routes;
}

/** Every canonical route, the wire routes first. */
export const FANSLY_ROUTES: ReadonlyMap<FanslyRoute, FanslyRouteSpec> = buildCatalogue();

const FAMILY_OF: ReadonlyMap<FanslyRoute, FanslyRouteFamily> = new Map(
  FANSLY_ROUTE_FAMILY_IDS.flatMap((family) => FANSLY_ROUTE_FAMILIES[family].map((route) => [route, family] as const)),
);

export function isFanslyRoute(value: unknown): value is FanslyRoute {
  return typeof value === "string" && FANSLY_ROUTES.has(value as FanslyRoute);
}

/** The route a wire id sends on (each wire spec is one route). */
export function routeOfWireId(id: FanslyWireId): FanslyRoute {
  return id;
}

/** The route of an engine attempt's `operation` (a wire id); null for an
 *  operation this build does not know. */
export function routeOfEngineOperation(operation: string): FanslyRoute | null {
  const route = operation as FanslyRoute;
  return FANSLY_ROUTES.get(route)?.wire === route ? route : null;
}

/** The route of a legacy send log `operation`; null for one this build does
 *  not know (its clock then counts against every route). */
export function routeOfLegacyOperation(operation: string): FanslyRoute | null {
  return Object.hasOwn(FANSLY_LEGACY_OPERATION_ROUTES, operation) ? FANSLY_LEGACY_OPERATION_ROUTES[operation]! : null;
}

export function familyOfRoute(route: FanslyRoute): FanslyRouteFamily | null {
  return FAMILY_OF.get(route) ?? null;
}

export function routeBudget(route: FanslyRoute): RouteBudget {
  return ROUTE_BUDGETS[route] ?? DEFAULT_ROUTE_BUDGET;
}

/** The policy table as one canonical document (sorted; budgets explicit). */
function policyDocument(): unknown {
  return {
    routes: [...FANSLY_ROUTES.keys()].sort().map((route) => [route, familyOfRoute(route), routeBudget(route)]),
    families: FANSLY_ROUTE_FAMILY_IDS.slice().sort().map((family) => [family, [...FANSLY_ROUTE_FAMILIES[family]].sort(), FAMILY_BUDGETS[family]]),
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The hash of the whole budget policy: two builds with the same hash pace
 *  every route alike (the shadow report's fingerprint). */
export const ROUTE_POLICY_HASH: string = digest(policyDocument());

/** A route's policy version: the hash of the budgets that pace it (its own and
 *  its family's), so a calibration PR that moves one changes it. Stored with a
 *  page's slowdown of the route. */
export function routePolicyVersion(route: FanslyRoute): string {
  const family = familyOfRoute(route);
  return digest([route, routeBudget(route), family, family === null ? null : FAMILY_BUDGETS[family]]).slice(0, 16);
}

/** One budget's interval: the shortest gap between two sends it allows. */
export function intervalMsOf(perMin: number): number {
  if (!(Number.isFinite(perMin) && perMin > 0)) throw new RangeError(`A route budget must be a positive rate (got ${perMin})`);
  return Math.ceil(60_000 / perMin);
}
