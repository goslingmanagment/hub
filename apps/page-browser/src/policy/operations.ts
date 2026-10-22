// The map of operations (plan §4.6; spec §2; owner decision №2 of
// 2026-10-13): one table of what a page's browser may send — host, method,
// path template, mode, the engine's route, "platform data" — and the one
// source of both layers that hold it:
//   - the rules extension: policy/rules.ts builds its rules.json from this
//     file when the image is built (extension/build.ts), and they act without
//     the operator, during the owner's manual access too;
//   - the operator: `decide` below is its table of decisions for the site's
//     own requests (the interception takes it in PR 7).
// The identity test (tests/page-browser-rules.test.ts) holds the two to one
// set: every closed row has an example, and both layers cancel it in both
// modes.
//
// Decision №2:
//   - every host the site loads goes out — third-party ones through the
//     page's SOCKS5 as any browser's would, journaled ("why forbid it — would
//     it not look suspicious"); only local, private and special-use
//     addresses are refused;
//   - every API read is allowed: the catalogue's routes and, outside it,
//     `site.other` (spec §2.4, decision №3) — but for the four reads that are
//     no reads (spec §2.5): they change state or hand a token to a third
//     party on a GET, and are closed by every method;
//   - the reads whose answers carry the page's secrets (its managers'
//     session tokens, its sign-ins' addresses, its identity verification…)
//     are open as every read — the site's settings screens read them — but
//     their answers are no platform data and are never kept
//     (`SECRET_READ_ROWS`; the PB audit of 2026-10-22, P2-3);
//   - writes are closed FOR NOW, except the login operations: each opens by a
//     decision of its own when it is needed. There is no permanent "never":
//     what the prototype held as "never" is closed one by one until a
//     separate decision (spec §2.5) — all of it but the payouts, which left
//     that list ("the rest I would keep closed for now, just not forever").
//
// Modes of a row (spec §2): "automation", "manual_login", "both"; "closed" —
// refused in both until the owner opens it.

import { REFUSED_IPV4_TEXT, REFUSED_IPV6_TEXT } from "./special-addresses.ts";

/** A row's mode (spec §2). */
export type RowMode = "automation" | "manual_login" | "both" | "closed";
/** The operator's mode (spec §6.1 `Mode`). */
export type OperatorMode = "automation" | "manual_login";

// ── hosts (spec §2.1) ──────────────────────────────────────────────────────

/** Fansly's own domain: every host under it is Fansly's. */
export const FANSLY_DOMAIN = "fansly.com";
/** The site's page. */
export const SITE_HOST = "fansly.com";
/** The API: paths from `API_BASE` (packages/shared/src/config.ts). */
export const API_HOST = "apiv3.fansly.com";
export const API_BASE = "/api/v1";
/** The site's socket `wss://wsv3.fansly.com/?v=3`. */
export const SOCKET_HOST = "wsv3.fansly.com";
/** Media and previews (`*` stands for part of one label). */
export const CDN_HOST = "cdn*.fansly.com";

/** How a host's requests go out.
 *   site        Fansly's page, scripts, styles, fonts — and any other host
 *               under fansly.com: at once, unpaced, journaled; writes closed
 *   api         by the engine's admission (spec §2.2–2.5)
 *   ws          the site's socket only, observed (variant Б, plan-b §4.1.9)
 *   cdn         media and previews: the site's unpaced, Hub's admitted;
 *               writes closed
 *   closed      nothing at all, until the owner opens it
 *   third_party a host the site loads that is not Fansly's: through the
 *               page's SOCKS5, unpaced, journaled (decision №2)
 *   denied      local, private and special-use names: refused always */
export type HostClass = "site" | "api" | "ws" | "cdn" | "closed" | "third_party" | "denied";

export interface HostRow {
  /** A name, or a pattern with `*` standing for part of one label. */
  host: string;
  cls: Exclude<HostClass, "third_party" | "denied">;
  mode: RowMode;
  what: string;
  source: string;
}

/** Fansly's hosts with a role of their own, in the order they are tried. */
export const HOST_ROWS: readonly HostRow[] = [
  { host: SITE_HOST, cls: "site", mode: "both", what: "the site's page, scripts, styles, fonts", source: "spec §2.1" },
  { host: API_HOST, cls: "api", mode: "both", what: "the API: by the rows of API_ROWS", source: "spec §2.1–2.5" },
  { host: SOCKET_HOST, cls: "ws", mode: "automation", what: "the site's socket `/?v=3` (ws.upgrade); nothing else to it", source: "spec §2.1, §2.3; stage 1, §3.2" },
  { host: CDN_HOST, cls: "cdn", mode: "both", what: "media and previews (cdn.media)", source: "spec §2.1, §2.3" },
  { host: "chatws.fansly.com", cls: "closed", mode: "closed", what: "the second socket of the site (live chats)", source: "spec §2.1; plan §3.2" },
  { host: "mediav2.fansly.com", cls: "closed", mode: "closed", what: "the media upload API (stage 2)", source: "spec §2.1, §2.4" },
];

/** Methods that do not write: what Fansly's non-API hosts are open to. */
export const READ_METHODS: readonly string[] = ["GET", "HEAD", "OPTIONS"];
/** What the API is open to besides the login operations: reads and their
 *  preflights (a HEAD is not in the map). */
export const API_OPEN_METHODS: readonly string[] = ["GET", "OPTIONS"];

/** Local, private and special-use destinations (plan §4.5): refused by the
 *  proxy even with the exit open, and by the extension. Kept as text the
 *  rules builder turns into DNR expressions and the proxy into its checks:
 *  one list for both. The addresses are every entry of IANA's
 *  special-purpose registries that is no destination
 *  (policy/special-addresses.ts, held to the registries by a test).
 *
 *  Both refuse the address IN THE REQUEST — a name, or a literal address.
 *  What the page's SOCKS5 resolves a name to is not seen: DNS is resolved at
 *  the page's proxy by design (plan §4.5 — the operator passes the name and
 *  never resolves it; resolving it here would change the page's DNS
 *  behaviour), and the private addresses behind that proxy are its
 *  provider's network, not Hub's — the container's own rules let the
 *  operator reach only the SOCKS5's address and port (spec §2.1). */
export const LOCAL = {
  /** Names: these and every name under them; a name without a dot too. */
  names: ["localhost", "local", "internal", "home.arpa"],
  /** IPv4: expressions over the dotted text, each a whole address. */
  ipv4: REFUSED_IPV4_TEXT,
  /** IPv6: expressions over the canonical text, each a whole address. */
  ipv6: REFUSED_IPV6_TEXT,
} as const;

/** Special-use names that exist nowhere (RFC 6761, 9476): the proxy refuses
 *  them too. Not local, so not in the extension's rules — the placeholder of
 *  Hub's requests (`<host>.pb-hold.invalid`, hub-requests/page.ts) lives
 *  under `invalid`, and Chrome must issue those. */
export const RESERVED_NAMES: readonly string[] = ["invalid", "test", "example", "onion", "alt"];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const LOCAL_IPV4 = new RegExp(`^(${LOCAL.ipv4.join("|")})$`);
const LOCAL_IPV6 = new RegExp(`^(${LOCAL.ipv6.join("|")})$`);

/** An address literal in the text a URL gives it (WHATWG's, Chrome's): an
 *  IPv4 in dotted decimal however it was written, an IPv6 per RFC 5952. A
 *  name stays as it is; an IPv6 literal that does not parse is null. */
export function canonicalAddress(host: string): string | null {
  if (host.includes(":")) {
    try {
      return new URL(`http://[${host}]/`).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return null;
    }
  }
  try {
    return new URL(`http://${host}/`).hostname;
  } catch {
    return host;
  }
}

function under(host: string, name: string): boolean {
  return host === name || host.endsWith(`.${name}`);
}

/** A host's name as the map compares it: lower case, no trailing dot, no
 *  IPv6 brackets. */
export function normalHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/** A local or private address (`LOCAL`): what the extension blocks too. */
export function isLocalAddress(raw: string): boolean {
  const named = normalHost(raw);
  if (named === "") return true;
  const host = canonicalAddress(named);
  // An IPv6 literal that does not parse goes nowhere.
  if (host === null) return true;
  if (host.includes(":")) return LOCAL_IPV6.test(host);
  if (IPV4.test(host)) return LOCAL_IPV4.test(host);
  if (!host.includes(".")) return true;
  return LOCAL.names.some((name) => under(host, name));
}

/** A special-use name that exists nowhere (`RESERVED_NAMES`). */
export function isReservedName(raw: string): boolean {
  const host = normalHost(raw);
  return RESERVED_NAMES.some((name) => under(host, name));
}

/** Local, private or special-use: never reachable from the page. */
export function isLocalHost(raw: string): boolean {
  return isLocalAddress(raw) || isReservedName(raw);
}

/** A host list entry is a name, or a pattern with `*` standing for part of
 *  one label (`cdn*.fansly.com`). */
export function hostMatches(entry: string, host: string): boolean {
  if (!entry.includes("*")) return entry === host;
  const pattern = entry
    .split("*")
    .map((part) => part.replace(/[.\\^$+?()[\]{}|]/g, "\\$&"))
    .join("[^.]*");
  return new RegExp(`^${pattern}$`).test(host);
}

/** The class of a host (spec §2.1, decision №2). */
export function classifyHost(raw: string): HostClass {
  if (isLocalHost(raw)) return "denied";
  const host = normalHost(raw);
  const row = HOST_ROWS.find((entry) => hostMatches(entry.host, host));
  if (row) return row.cls;
  return under(host, FANSLY_DOMAIN) ? "site" : "third_party";
}

// ── the API (spec §2.2–2.5) ────────────────────────────────────────────────

/** One row of the API. A template is a path from `API_BASE`: literal
 *  segments, `:name` or `{name}` for exactly one segment, `prefix*` for a
 *  segment that starts with `prefix`, and a last `**` for any further
 *  segments (none included). */
export interface ApiRow {
  methods: readonly string[];
  template: string;
  mode: RowMode;
  /** The engine's route (fansly/routes.ts); null for a preflight (its
   *  request's route) and a closed row. */
  route: string | null;
  /** Its answers carry platform data: they go to `observations` (plan §3.2). */
  platformData: boolean;
  what: string;
  source: string;
  /** A closed or a secret row's example path (from `API_BASE`): the
   *  identity test sends it to both layers. */
  example?: string;
}

const CATALOGUE = "catalogue (fansly/routes.ts)";
const LEGACY = "catalogue, not sent by the engine (†, fansly/routes.ts:31-39)";

/** Every API read the map opens is open in the manual login too: plan §4.8
 *  «разрешены вход, подтверждение 2FA и чтения, которые делает интерфейс»,
 *  with owner decision №2 (every API read open) — under the same site
 *  admission, pacer and budgets (PR 15). */
function read(template: string, route: string, source = CATALOGUE): ApiRow {
  return { methods: ["GET"], template, mode: "both", route, platformData: true, what: "a read of the catalogue", source };
}

/** The engine's catalogue of API reads (spec §2.2): 52 routes of the wire
 *  specs and 7 the engine does not send (†). The test holds them to
 *  FANSLY_ROUTES: one set of (method, template, route). */
export const CATALOGUE_ROWS: readonly ApiRow[] = [
  // messaging, 15/min
  read("/messaging/groups", "messaging.groups"),
  read("/group/:groupId", "group.detail"),
  read("/message", "messages.page"),
  // earnings, 17/min
  read("/account/wallets/earnings", "earnings.overview", LEGACY),
  read("/account/wallets/earnings/transactions", "transactions.page"),
  read("/account/wallets/earnings/transactions/accounts", "earnings.transactions_account"),
  read("/account/wallets/earnings/accounts", "earnings.accounts"),
  read("/account/wallets/earnings/stats", "earnings.stats_window"),
  read("/account/wallets/earnings/stats/accounts", "earnings.stats_accounts"),
  read("/account/wallets/earnings/monthlystats", "earnings.monthly"),
  read("/account/wallets/earnings/monthlystats/accounts", "earnings.monthly_accounts"),
  // creator_stats, 5/min
  read("/account/stats/summary", "stats.summary"),
  read("/account/stats/series", "stats.series"),
  read("/account/stats/media", "stats.media"),
  read("/account/stats/media/top", "stats.media_top"),
  read("/account/stats/media/benchmarks", "stats.media_benchmarks"),
  read("/account/stats/media/shown", "stats.media_shown"),
  read("/account/stats/geo", "stats.geo"),
  read("/account/stats/activehours", "stats.active_hours"),
  read("/account/stats/tags", "stats.tags"),
  read("/account/stats/posts", "stats.posts"),
  read("/account/stats/fans", "stats.fan"),
  read("/account/stats/fans/top", "stats.fans_top"),
  // the account and its audience
  read("/account/me", "account.me"),
  read("/account", "accounts.by_ids"),
  read("/account/walls", "account.walls"),
  read("/account/:accountId/followersnew", "followers.page"),
  read("/subscribers", "subscribers.page"),
  read("/subscriptions/tiers", "subscriptions.tiers"),
  read("/subscriptions/giftcodes", "subscriptions.giftcodes"),
  read("/notifications", "notifications.page"),
  read("/lists/account", "lists.account", LEGACY),
  read("/lists/itemsnew", "lists.items", LEGACY),
  // messages and broadcasts
  read("/message/automated", "message.automated"),
  read("/message/broadcast/stats", "broadcast.stats"),
  read("/message/broadcast/stats/deleted", "broadcast.stats_deleted"),
  read("/message/broadcast/scheduled", "broadcast.scheduled"),
  // posts
  read("/timelinenew/:accountId", "posts.timeline"),
  read("/post", "posts.by_ids"),
  read("/post/{postId}/replies", "post.replies"),
  read("/tips", "posts.tips"),
  read("/tips/account", "tips.account", LEGACY),
  read("/polls", "polls"),
  read("/mediastory/views", "mediastory.views", LEGACY),
  // media and the vault
  read("/media/vaultnew", "vault.media"),
  read("/vault/albumsnew", "vault.albums"),
  read("/uservault/albumsnew", "uservault.albums"),
  read("/account/media", "account.media_by_ids"),
  read("/account/media/bundle", "account.bundles_by_ids"),
  read("/account/media/orders", "account.media_orders", LEGACY),
  read("/media/orderhistory", "media.order_history"),
  read("/groups/mediaoffers", "groups.mediaoffers", LEGACY),
  read("/contentdiscovery/media/suggestionsnew", "discovery.suggestions"),
  // money and statistics outside the families
  read("/payments/payoutmethods", "payouts.methods"),
  read("/payments/payout/requests", "payouts.requests"),
  read("/it/moie/statsnew", "media.offer_stats"),
  read("/it/amoie/stats", "account.stats"),
  read("/trackinglinks", "trackinglinks"),
  read("/recapstats", "recapstats"),
];

/** The route of an API read outside the catalogue (decision №3). */
export const SITE_OTHER_ROUTE = "site.other";

/** The reads of the login screens (stage 1, sessions 1–5), named apart:
 *  `/device/id` carries no platform data (the engine's LOGIN_SCREEN_READS,
 *  engine/site-admission.ts — the test holds the two equal). Their route is
 *  `site.other`; like every API read the map opens, they pass in both modes. */
export const LOGIN_SCREEN_ROWS: readonly ApiRow[] = [
  { methods: ["GET"], template: "/versioning", mode: "both", route: SITE_OTHER_ROUTE, platformData: true, what: "the app's version", source: "stage 1, §9; engine LOGIN_SCREEN_READS" },
  { methods: ["GET"], template: "/thirdpartyconnect/providers", mode: "both", route: SITE_OTHER_ROUTE, platformData: true, what: "the third-party sign-in providers", source: "stage 1, §9; engine LOGIN_SCREEN_READS" },
  // A device id the site sends as a session header: not platform data.
  { methods: ["GET"], template: "/device/id", mode: "both", route: SITE_OTHER_ROUTE, platformData: false, what: "the device id", source: "stage 1, §9; engine LOGIN_SCREEN_READS" },
];

/** The login operations (spec §2.4; stage 1, §9): the only writes open on
 *  the first stage, in the manual login only. The engine's LOGIN_PATHS
 *  (fansly/route-match.ts) — the test holds the two equal.
 *
 *  The confirmation by e-mail of a login from a new device (owner decision
 *  2026-10-15: open for the time of the login only) is `/login/twofa` too:
 *  by the site's bundle, `/login` answers it with `twofa` of type 2, Fansly
 *  e-mails a code, and the site sends it as it sends a 2FA code, `{token,
 *  code}` — no link, no read that waits for it, no other operation. The
 *  bundle's `/login/email`, `/login/email/verify` and
 *  `/login/email/verification{,/token}` change or confirm the account's
 *  address in its settings: no login operation, closed as every write. */
export const LOGIN_ROWS: readonly ApiRow[] = [
  { methods: ["POST"], template: "/login", mode: "manual_login", route: "auth.login", platformData: false, what: "the login and password", source: "spec §2.4; stage 1, §9" },
  { methods: ["POST"], template: "/login/twofa", mode: "manual_login", route: "auth.twofa", platformData: false, what: "the 2FA code, or the code Fansly e-mails a new device", source: "spec §2.4; stage 1, §9; owner decision 2026-10-15" },
];

/** Every other API read, and the preflights (spec §2.4). The only reads
 *  `GET /**` does not open are the four rows of `CLOSED_ROWS` closed by
 *  every method, and a path in a spelling no client writes (`PLAIN_ESCAPES`):
 *  the closed rows and that spelling are decided before these. A secret read
 *  (`SECRET_READ_ROWS`) is opened by its own row, before this one: its answer
 *  is not kept. */
export const OPEN_ROWS: readonly ApiRow[] = [
  { methods: ["GET"], template: "/**", mode: "both", route: SITE_OTHER_ROUTE, platformData: true, what: "an API read outside the catalogue", source: "spec §2.4; decision №3; PR 15: the manual login reads too" },
  { methods: ["OPTIONS"], template: "/**", mode: "both", route: null, platformData: false, what: "a CORS preflight: under its request's admission", source: "spec §2.4; decision №1" },
];

const WRITES = ["POST", "PUT", "PATCH", "DELETE"];
/** In a closed row's methods: every method, a GET and its preflight too. */
export const ANY_METHOD = "*";

function closed(template: string, example: string, what: string, source: string, methods: readonly string[] = WRITES): ApiRow {
  return { methods, template, mode: "closed", route: null, platformData: false, what, source, example };
}

const BUNDLE = "the site's public bundle (prototype, 2026-10-11)";

/** Closed one by one until the owner opens each (spec §2.5): in both modes,
 *  during manual access and without the operator. The list is the
 *  prototype's "never" without the payouts (decision №2). While every write
 *  but the login is closed anyway, these stay closed when writes start to
 *  open; the last four are closed by every method — the only closed reads. */
export const CLOSED_ROWS: readonly ApiRow[] = [
  // Read marks: the site sends them by itself; open, they would clear the
  // chatters' unread.
  closed("/message/ack", "/message/ack", "a read mark", "spec §2.5; plan §4.6"),
  closed("/message/ack/all", "/message/ack/all", "a read mark (every chat)", BUNDLE),
  closed("/notifications/ack", "/notifications/ack", "a read mark (notifications)", BUNDLE),
  closed("/groups/users/readreceipts", "/groups/users/readreceipts", "a read receipt", BUNDLE),
  closed("/message/typing", "/message/typing", "typing", "spec §2.5; plan §4.6"),
  closed("/status", "/status", "the presence status", "spec §2.5; plan §4.6"),
  closed("/message/like", "/message/like", "a like of a message", BUNDLE),
  closed("/message/like/remove", "/message/like/remove", "a like of a message taken back", BUNDLE),
  // The account: its e-mail, its deletion, its payout details, its money.
  closed("/account/emailchange/**", "/account/emailchange/request", "an e-mail change", `spec §2.5; ${BUNDLE}`),
  closed("/account/disable", "/account/disable", "the account's deletion", `spec §2.5; ${BUNDLE}`),
  closed("/payments/payoutmethods/**", "/payments/payoutmethods", "the payout details (a write to the payout methods)", "spec §2.5: the catalogue's read of them, written"),
  closed("/account/wallets/transaction/refund", "/account/wallets/transaction/refund", "a refund of a transaction", BUNDLE),
  closed("/payments/wallets*/**", "/payments/wallets/1/withdraw", "the wallets", BUNDLE),
  // The password and the 2FA settings (entering them at a login is a login
  // operation, above); the sessions; who manages the page; other sign-ins.
  closed("/login/password*/**", "/login/password/change", "a password change", `spec §2.5; ${BUNDLE}`),
  closed("/twofa/**", "/twofa/disable", "the 2FA settings", `spec §2.5; ${BUNDLE}`),
  closed("/session/close", "/session/close", "a session closed", BUNDLE),
  closed("/logout", "/logout", "the logout", BUNDLE),
  closed("/management/**", "/management/invite", "the page's management", BUNDLE),
  closed("/webpush/delete", "/webpush/delete", "a push subscription removed", BUNDLE),
  // Writes only: reading the providers is a read of the login screens.
  closed("/thirdpartyconnect/**", "/thirdpartyconnect/connect", "a third-party sign-in", BUNDLE),
  // Reads that are no reads: closed by every method.
  closed("/emails/unsubscribe", "/emails/unsubscribe", "an unsubscribe by link (a GET that changes state)", `${BUNDLE}; Astra's review 2 of the prototype`, [ANY_METHOD]),
  closed("/account/verifynsfw", "/account/verifynsfw", "the content filter's verification (a GET that changes state)", `${BUNDLE}; Astra's review 2 of the prototype`, [ANY_METHOD]),
  closed("/intercom/authorize", "/intercom/authorize", "the support widget's authorisation (a token for a third party)", `${BUNDLE}; Astra's review 2 of the prototype`, [ANY_METHOD]),
  closed("/zendesk/authorize", "/zendesk/authorize", "the support desk's authorisation (a token for a third party)", `${BUNDLE}; Astra's review 2 of the prototype`, [ANY_METHOD]),
];

function secret(template: string, example: string, what: string, source: string): ApiRow {
  return { methods: ["GET"], template, mode: "both", route: SITE_OTHER_ROUTE, platformData: false, what, source, example };
}

const AUDIT = "PB audit 2026-10-22, P2-3";
const UI_WALK = `${AUDIT}: the UI walk's HAR of 2026-08-21, by its field names`;

/** The reads whose answers carry the page's secrets (the PB audit of
 *  2026-10-22, P2-3). Open as every read, in both modes — the site's
 *  settings screens must keep working — but their answers are no platform
 *  data: the operator never reads their bodies and sends no `site.response`
 *  for them (`platformData: false`, as for `/device/id`), so no answer of
 *  theirs reaches the buffer's volume or `observations`, and none is a hole
 *  to backfill. What left and how it ended is still told to the engine and
 *  journaled: the fact stays, the answer does not. Their other methods keep
 *  nothing either: a write under them is closed by its row or the general
 *  rule, or is a login operation, and a preflight's answer is never kept.
 *
 *  Read the way the closed rows read a path (`closedSegments`: any case,
 *  slashes run together), so no spelling keeps an answer, and decided before
 *  every other read. None is a read of the catalogue (the test holds it):
 *  `/payments/payoutmethods` itself is one — Hub reads and journals that list
 *  by its own route every cycle — so only one method's paths under it are
 *  here.
 *
 *  Hub's capture never writes these answers either, for an operator from
 *  before this list (it kept them as `site.other`): `SECRET_SITE_READS` in
 *  apps/runtime/src/sync/fansly/browser-site-capture.ts, the same templates
 *  side by side (the engine never loads this app) — the test holds the two
 *  equal. */
export const SECRET_READ_ROWS: readonly ApiRow[] = [
  // The site reads `/management/…`, `/sessions`, `/idv/…`,
  // `/login/password/status`, `/payouts/documentation` and
  // `/streaming/channel` today; under the others its bundle only writes, and
  // a read there would answer the same secrets.
  secret("/management/**", "/management/managementsessions", "who manages the page, and their sessions' tokens", UI_WALK),
  // `/sessions` itself too: a last `**` takes no segment as well.
  secret("/sessions/**", "/sessions", "the page's sign-ins: their addresses and places", UI_WALK),
  secret("/session/**", "/session/1", "a session of the page", AUDIT),
  secret("/idv/**", "/idv/accountsessions", "the identity verification (KYC)", UI_WALK),
  secret("/twofa/**", "/twofa", "the 2FA settings", AUDIT),
  // The login's own POSTs are login operations; these are its reads.
  secret("/login/**", "/login/password/status", "the login's settings: the password, the e-mail", `${UI_WALK}; ${BUNDLE}`),
  secret("/account/emailchange/**", "/account/emailchange", "an e-mail change", AUDIT),
  secret("/payments/payoutmethods/:methodId/**", "/payments/payoutmethods/1", "a payout method's own paths (the list is a read of the catalogue)", AUDIT),
  secret("/payouts/documentation/**", "/payouts/documentation", "the payouts' tax forms", `${AUDIT}; ${BUNDLE} (getAccountPayoutDocumentation)`),
  secret("/streaming/channel/**", "/streaming/channel", "the live channel: its stream key and ingest endpoint", `${AUDIT}; ${BUNDLE} (channel.streamKey)`),
];

/** Every API row, closed ones first: the order the operator decides in. */
export const API_ROWS: readonly ApiRow[] = [...CLOSED_ROWS, ...LOGIN_ROWS, ...SECRET_READ_ROWS, ...LOGIN_SCREEN_ROWS, ...CATALOGUE_ROWS, ...OPEN_ROWS];

/** What the map closes beyond the rows: the general rules of spec §2.4 and
 *  §2.1, each with examples (method, URL) both layers must cancel. */
export const GENERAL_CLOSURES: ReadonlyArray<{ rule: string; what: string; examples: ReadonlyArray<{ method: string; url: string; type?: string }> }> = [
  {
    rule: "api_writes",
    what: "any API request but the open rows: every write outside the login operations, a HEAD, a path outside the API, a port or scheme of its own",
    examples: [
      { method: "POST", url: "https://apiv3.fansly.com/api/v1/message" },
      { method: "POST", url: "https://apiv3.fansly.com/api/v1/pb-unknown-write" },
      { method: "PUT", url: "https://apiv3.fansly.com/api/v1/account" },
      { method: "PATCH", url: "https://apiv3.fansly.com/api/v1/post" },
      { method: "DELETE", url: "https://apiv3.fansly.com/api/v1/post/1" },
      { method: "HEAD", url: "https://apiv3.fansly.com/api/v1/account/me" },
      { method: "GET", url: "https://apiv3.fansly.com/" },
      { method: "GET", url: "https://apiv3.fansly.com/api/v2/account/me" },
      { method: "GET", url: "https://apiv3.fansly.com:8443/api/v1/account/me" },
      { method: "GET", url: "http://apiv3.fansly.com/api/v1/account/me" },
      { method: "POST", url: "https://apiv3.fansly.com/api/v1/LOGIN" },
    ],
  },
  {
    rule: "api_spelling",
    what: "an API path with an escape of a plain character or of a slash: no client writes one, and a server may read it as the character — a closed read could hide behind it",
    examples: [
      { method: "GET", url: "https://apiv3.fansly.com/api/v1/emails/%75nsubscribe" },
      { method: "GET", url: "https://apiv3.fansly.com/api/v1/emails%2Funsubscribe" },
      { method: "GET", url: "https://apiv3.fansly.com/api/v1/intercom/authori%7Ae" },
      { method: "GET", url: "https://apiv3.fansly.com/api/v1/account/%6De" },
      { method: "POST", url: "https://apiv3.fansly.com/api/v1/message/%61ck" },
    ],
  },
  {
    rule: "fansly_writes",
    what: "a write to any other host of Fansly",
    examples: [
      { method: "POST", url: "https://fansly.com/" },
      { method: "PUT", url: "https://cdn3.fansly.com/x" },
      { method: "POST", url: "https://leaderboard.fansly.com/api/v1/x" },
      { method: "POST", url: "https://fansly.com/", type: "main_frame" },
    ],
  },
  {
    rule: "closed_hosts",
    what: "the closed hosts, every request",
    examples: [
      { method: "GET", url: "wss://chatws.fansly.com/", type: "websocket" },
      { method: "GET", url: "https://chatws.fansly.com/" },
      { method: "POST", url: "https://mediav2.fansly.com/upload" },
      { method: "GET", url: "https://mediav2.fansly.com/x" },
    ],
  },
  {
    rule: "socket_host",
    what: "the socket host serves the site's socket only",
    examples: [
      { method: "GET", url: "https://wsv3.fansly.com/?v=3" },
      { method: "GET", url: "wss://wsv3.fansly.com/other", type: "websocket" },
      { method: "GET", url: "ws://wsv3.fansly.com/?v=3", type: "websocket" },
    ],
  },
  {
    rule: "local",
    what: "local and private addresses",
    examples: [
      { method: "GET", url: "http://127.0.0.1:9222/json" },
      { method: "GET", url: "http://localhost:7700/rpc" },
      { method: "POST", url: "http://10.230.0.2:7700/" },
      { method: "GET", url: "https://192.168.1.1/" },
      { method: "GET", url: "https://172.20.0.1/" },
      { method: "GET", url: "http://169.254.169.254/latest" },
      { method: "GET", url: "http://[::1]:3128/" },
      { method: "GET", url: "http://[fd00::1]/" },
      { method: "GET", url: "http://router.local/" },
      { method: "GET", url: "http://intranet/" },
      { method: "GET", url: "https://198.18.0.1/" },
      { method: "GET", url: "https://203.0.113.7/" },
      { method: "GET", url: "https://192.0.0.8/" },
      { method: "GET", url: "http://[2001:db8::1]/" },
      { method: "GET", url: "http://[100::1]/" },
      { method: "GET", url: "https://[2001:2::1]/" },
      { method: "GET", url: "https://[3fff::1]/" },
      { method: "GET", url: "https://[5f00::1]/" },
      { method: "GET", url: "https://[2002:a00:1::1]/" },
      { method: "GET", url: "https://[64:ff9b:1::a00:1]/" },
      { method: "GET", url: "https://192.88.99.2/" },
    ],
  },
];

// ── matching ───────────────────────────────────────────────────────────────

type Segment = { kind: "literal"; text: string } | { kind: "param" } | { kind: "prefix"; text: string };

export interface ParsedTemplate {
  segments: Segment[];
  /** A last `**`: any further segments. */
  rest: boolean;
}

function isParam(segment: string): boolean {
  return /^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment) || /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(segment);
}

export function parseTemplate(template: string): ParsedTemplate {
  if (!template.startsWith("/")) throw new Error(`a template starts with "/": ${template}`);
  const parts = template === "/" ? [] : template.slice(1).split("/");
  const rest = parts[parts.length - 1] === "**";
  if (rest) parts.pop();
  const segments = parts.map((part): Segment => {
    if (part === "" || part === "**") throw new Error(`a template's segment is empty or a ** not at its end: ${template}`);
    if (isParam(part)) return { kind: "param" };
    if (part.endsWith("*")) {
      const text = part.slice(0, -1);
      if (text === "" || text.includes("*")) throw new Error(`a prefix segment needs its prefix: ${template}`);
      return { kind: "prefix", text };
    }
    if (part.includes("*") || part.includes(":") || part.includes("{")) throw new Error(`a literal segment with a pattern character: ${template}`);
    return { kind: "literal", text: part };
  });
  return { segments, rest };
}

function segmentMatches(segment: Segment, value: string, fold: boolean): boolean {
  const seen = fold ? value.toLowerCase() : value;
  switch (segment.kind) {
    case "literal":
      return seen === (fold ? segment.text.toLowerCase() : segment.text);
    case "param":
      return value !== "";
    case "prefix":
      return seen.startsWith(fold ? segment.text.toLowerCase() : segment.text);
  }
}

/** Whether `parts` (an API path's segments) fall under a template. */
export function templateMatches(template: ParsedTemplate, parts: readonly string[], fold = false): boolean {
  if (parts.length < template.segments.length) return false;
  if (!template.rest && parts.length !== template.segments.length) return false;
  return template.segments.every((segment, i) => segmentMatches(segment, parts[i]!, fold));
}

/** An API path as the engine reads it (fansly/route-match.ts): no query, one
 *  trailing slash dropped, split at every slash. */
function engineSegments(apiPath: string): string[] {
  const bare = apiPath.split("?", 1)[0]!.split("#", 1)[0]!;
  const trimmed = bare.length > 1 && bare.endsWith("/") ? bare.slice(0, -1) : bare;
  return trimmed.split("/").slice(1);
}

/** The escapes of plain characters — letters, digits, `-._~` — and of the
 *  slash, as the two hex digits after `%` (in any case). No client writes
 *  them, and a server may read each as its character: on the API a path
 *  with one is closed by both layers, so no closed row can be spelled around
 *  — a closed read above all, which no general rule stands behind. */
export const PLAIN_ESCAPES = "2[def]|3[0-9]|4[1-9a-f]|5[0-9af]|6[1-9a-f]|7[0-9ae]";
const PLAIN_ESCAPE = new RegExp(`%(${PLAIN_ESCAPES})`, "i");
const DECODED = new RegExp(`%(${PLAIN_ESCAPES})`, "gi");

/** An API path as the closed rows read it, so that no spelling slips past
 *  them: percent-encoded letters, digits, `-._~` and slashes decoded, runs
 *  of slashes taken as one, no trailing slash, any case (Fansly's own rules
 *  for these are not known). */
export function closedSegments(apiPath: string): string[] {
  const decoded = apiPath.split("?", 1)[0]!.split("#", 1)[0]!.replace(DECODED, (escape) => String.fromCharCode(parseInt(escape.slice(1), 16)));
  return decoded
    .split("/")
    .filter((part) => part !== "")
    .map((part) => part.toLowerCase());
}

interface Compiled {
  row: ApiRow;
  template: ParsedTemplate;
}

const compile = (rows: readonly ApiRow[]): Compiled[] => rows.map((row) => ({ row, template: parseTemplate(row.template) }));

const COMPILED_CLOSED = compile(CLOSED_ROWS);
const COMPILED_SECRET = compile(SECRET_READ_ROWS);
/** The rows with exact templates the engine matches its way: by length, a
 *  literal before a parameter at the first place they differ. */
const COMPILED_EXACT = compile([...CATALOGUE_ROWS]).sort((a, b) => {
  if (a.template.segments.length !== b.template.segments.length) return 0;
  for (let i = 0; i < a.template.segments.length; i++) {
    const aLiteral = a.template.segments[i]!.kind === "literal";
    const bLiteral = b.template.segments[i]!.kind === "literal";
    if (aLiteral !== bLiteral) return aLiteral ? -1 : 1;
  }
  return 0;
});

/** The closed row a request falls under, or null. */
export function closedRowOf(method: string, apiPath: string): ApiRow | null {
  const verb = method.toUpperCase();
  const parts = closedSegments(apiPath);
  return COMPILED_CLOSED.find((entry) => (entry.row.methods.includes(verb) || entry.row.methods.includes(ANY_METHOD)) && templateMatches(entry.template, parts, true))?.row ?? null;
}

/** The secret read a GET falls under (its path from `API_BASE`), read as
 *  the closed rows read a path, or null. */
export function secretReadRowOf(apiPath: string): ApiRow | null {
  const parts = closedSegments(apiPath);
  return COMPILED_SECRET.find((entry) => templateMatches(entry.template, parts, true))?.row ?? null;
}

/** The route of an API read, the engine's way: a catalogue route, else
 *  `site.other` (fansly/route-match.ts `matchSiteRequest`). */
export function readRouteOf(apiPath: string): string {
  const parts = engineSegments(apiPath);
  if (parts.some((part) => part === "")) return SITE_OTHER_ROUTE;
  return COMPILED_EXACT.find((entry) => templateMatches(entry.template, parts))?.row.route ?? SITE_OTHER_ROUTE;
}

/** The login operation of a POST, the engine's way, or null. */
export function loginRowOf(apiPath: string): ApiRow | null {
  const normalized = `/${engineSegments(apiPath).join("/")}`;
  return LOGIN_ROWS.find((row) => row.template === normalized) ?? null;
}

/** A read of the login screens (its path from `/api/v1`, its query and one
 *  trailing slash aside), or null. */
export function loginScreenRowOf(apiPath: string): ApiRow | null {
  const bare = apiPath.split("?", 1)[0]!;
  const trimmed = bare.length > 1 && bare.endsWith("/") ? bare.slice(0, -1) : bare;
  return LOGIN_SCREEN_ROWS.find((row) => row.template === trimmed) ?? null;
}

// ── the operator's decisions ───────────────────────────────────────────────

export interface MapRequest {
  method: string;
  url: string;
  /** CDP's resource type (`WebSocket`, `XHR`, `Document`…) when known. */
  resourceType?: string;
}

/** What the operator does with a request of the site (plan §4.3):
 *   pass      on at once, unpaced, journaled (the site's page and static
 *             files, Fansly's other hosts, third-party hosts)
 *   admit     by the engine's admission (`siteAdmit`): its route, a read or
 *             a login operation, whether its answer is platform data
 *   preflight a CORS preflight: under its request's admission (decision №1)
 *   socket    the site's socket (its tunnel goes on at the proxy, observed)
 *   refuse    failed (BlockedByClient) and journaled: closed by the map, not
 *             of the operator's mode, or a local or special-use address */
export type MapDecision =
  | { action: "pass"; cls: "site" | "cdn" | "third_party"; rule: string }
  | { action: "admit"; route: string; operation: "read" | "login"; platformData: boolean; mode: RowMode; rule: string }
  | { action: "preflight"; rule: string }
  | { action: "socket"; route: "ws.upgrade"; rule: string }
  | { action: "refuse"; refusal: "closed" | "mode" | "denied"; rule: string; why: string };

function describe(row: ApiRow): string {
  return `${row.methods.join("|")} ${row.template}`;
}

function admitted(row: ApiRow, route: string, operation: "read" | "login", mode: OperatorMode): MapDecision {
  const rule = `api: ${describe(row)} → ${route}`;
  if (row.mode !== "both" && row.mode !== mode) return { action: "refuse", refusal: "mode", rule, why: `${row.what}: ${row.mode === "manual_login" ? "the manual login's only" : "not in the manual login"}` };
  return { action: "admit", route, operation, platformData: row.platformData, mode: row.mode, rule };
}

function decideApi(url: URL, method: string, mode: OperatorMode): MapDecision {
  const refuse = (why: string): MapDecision => ({ action: "refuse", refusal: "closed", rule: "api_writes", why });
  // The API in one spelling only (the extension opens no other): HTTPS, its
  // port, its name as it is, no user.
  if (url.protocol !== "https:" || url.port !== "" || url.hostname !== API_HOST || url.username !== "" || url.password !== "") return refuse("the API only by HTTPS, on its port, by its own name");
  const path = url.pathname;
  // A spelling no client writes (the rules extension closes it too).
  if (PLAIN_ESCAPE.test(path)) return { action: "refuse", refusal: "closed", rule: "api_spelling", why: "an API path with an escape of a plain character or of a slash" };
  // Closed rows first, by their tolerant reading of the whole path.
  const tolerant = closedSegments(path);
  if (tolerant[0] === "api" && tolerant[1] === "v1") {
    const row = closedRowOf(method, `/${tolerant.slice(2).join("/")}`);
    if (row) return { action: "refuse", refusal: "closed", rule: `closed: ${describe(row)}`, why: `${row.what}: closed until the owner opens it` };
  }
  if (path !== API_BASE && !path.startsWith(`${API_BASE}/`)) return refuse("not an API path");
  const apiPath = path.slice(API_BASE.length) || "/";
  switch (method) {
    case "POST": {
      const login = loginRowOf(apiPath);
      return login ? admitted(login, login.route!, "login", mode) : refuse("a write outside the login operations: closed for now");
    }
    case "OPTIONS":
      return { action: "preflight", rule: `api: ${describe(OPEN_ROWS[1]!)}` };
    case "GET": {
      const route = readRouteOf(apiPath);
      // A secret read: let through by the engine's route, its answer never
      // kept.
      const secretRow = secretReadRowOf(apiPath);
      if (secretRow) return admitted(secretRow, route, "read", mode);
      const screen = loginScreenRowOf(apiPath);
      if (screen && route === SITE_OTHER_ROUTE) return admitted(screen, route, "read", mode);
      const row = CATALOGUE_ROWS.find((entry) => entry.route === route) ?? OPEN_ROWS[0]!;
      return admitted(row, route, "read", mode);
    }
    default:
      return refuse(`${method} is not open on the API`);
  }
}

/** The map's decision on one request of the site, in the operator's mode.
 *  The operator's own requests — Hub's (hub-requests/), the self-test's
 *  probes — are decided by their own paths before this. */
export function decide(request: MapRequest, mode: OperatorMode): MapDecision {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { action: "refuse", refusal: "denied", rule: "url", why: "the URL does not parse" };
  }
  const method = request.method.toUpperCase();
  if (!/^(https?|wss?):$/.test(url.protocol)) return { action: "refuse", refusal: "denied", rule: "scheme", why: `${url.protocol} goes nowhere through the proxy` };
  const cls = classifyHost(url.hostname);
  switch (cls) {
    case "denied":
      return { action: "refuse", refusal: "denied", rule: "local", why: "a local, private or special-use address" };
    case "closed": {
      const row = HOST_ROWS.find((entry) => hostMatches(entry.host, normalHost(url.hostname)))!;
      return { action: "refuse", refusal: "closed", rule: "closed_hosts", why: `${row.what}: closed until the owner opens it` };
    }
    case "api":
      return decideApi(url, method, mode);
    case "ws": {
      const socket = method === "GET" && /^websocket$/i.test(request.resourceType ?? "") && url.protocol === "wss:" && url.port === "" && url.hostname === SOCKET_HOST && url.username === "" && url.password === "" && url.pathname === "/";
      if (socket) return mode === "automation" ? { action: "socket", route: "ws.upgrade", rule: "socket: GET /?v=3 → ws.upgrade" } : { action: "refuse", refusal: "mode", rule: "socket", why: "the site's socket: not in the manual login" };
      return { action: "refuse", refusal: "closed", rule: "socket_host", why: "the socket host serves the site's socket only" };
    }
    case "site":
    case "cdn":
      if (!READ_METHODS.includes(method)) return { action: "refuse", refusal: "closed", rule: "fansly_writes", why: "a write to Fansly: closed for now" };
      return { action: "pass", cls, rule: `host: ${cls}` };
    case "third_party":
      return { action: "pass", cls, rule: "host: third_party (decision №2)" };
  }
}
