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
//     `site.other` (spec §2.4, decision №3);
//   - writes are closed FOR NOW, except the login operations: each opens by a
//     decision of its own when it is needed. There is no permanent "never":
//     what was "never" is closed until a separate decision (spec §2.5), and
//     payouts left that list.
//
// Modes of a row (spec §2): "automation", "manual_login", "both"; "closed" —
// refused in both until the owner opens it.

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
 *   ws          the site's socket only, each by the engine's admission
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

/** Local and private destinations (plan §4.5): refused by the proxy even
 *  with the exit open, and by the extension (its rules work on the address
 *  in the request only). Kept as text the rules builder turns into DNR
 *  expressions and the proxy into its checks: one list for both. */
export const LOCAL = {
  /** Names: these and every name under them; a name without a dot too. */
  names: ["localhost", "local", "internal", "home.arpa"],
  /** IPv4: the leading octets of a range, as expressions (the dots are
   *  separators, the rest is matched by the address's other octets). */
  ipv4: ["0", "10", "127", "169\\.254", "192\\.168", "172\\.(1[6-9]|2[0-9]|3[01])", "100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])", "22[4-9]", "2[3-5][0-9]"],
  /** IPv6 (lower case): unspecified and loopback, and these prefixes —
   *  mapped IPv4, unique local, link-local, multicast. */
  ipv6Exact: ["::", "::1"],
  ipv6Prefixes: ["::ffff:", "fc", "fd", "fe8", "fe9", "fea", "feb", "ff"],
} as const;

/** Special-use names that exist nowhere (RFC 6761, 9476): the proxy refuses
 *  them too. Not local, so not in the extension's rules — the placeholder of
 *  Hub's requests (`<host>.pb-hold.invalid`, hub-requests/page.ts) lives
 *  under `invalid`, and Chrome must issue those. */
export const RESERVED_NAMES: readonly string[] = ["invalid", "test", "example", "onion", "alt"];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const LOCAL_IPV4 = new RegExp(`^(${LOCAL.ipv4.join("|")})\\.`);

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
  const host = normalHost(raw);
  if (host === "") return true;
  if (host.includes(":")) return (LOCAL.ipv6Exact as readonly string[]).includes(host) || LOCAL.ipv6Prefixes.some((prefix) => host.startsWith(prefix));
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
  /** A closed row's example path (from `API_BASE`): the identity test sends
   *  it to both layers. */
  example?: string;
}

const CATALOGUE = "catalogue (fansly/routes.ts)";
const LEGACY = "catalogue, not sent by the engine (†, fansly/routes.ts:31-39)";

function read(template: string, route: string, source = CATALOGUE): ApiRow {
  return { methods: ["GET"], template, mode: "automation", route, platformData: true, what: "a read of the catalogue", source };
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

/** The reads of the login screens (stage 1, sessions 1–5): in the manual
 *  login they pass with the login operations (the engine's
 *  LOGIN_SCREEN_READS, engine/site-admission.ts — the test holds the two
 *  equal). Their route is `site.other`. */
export const LOGIN_SCREEN_ROWS: readonly ApiRow[] = [
  { methods: ["GET"], template: "/versioning", mode: "both", route: SITE_OTHER_ROUTE, platformData: true, what: "the app's version", source: "stage 1, §9; engine LOGIN_SCREEN_READS" },
  { methods: ["GET"], template: "/thirdpartyconnect/providers", mode: "both", route: SITE_OTHER_ROUTE, platformData: true, what: "the third-party sign-in providers", source: "stage 1, §9; engine LOGIN_SCREEN_READS" },
  // A device id the site sends as a session header: not platform data.
  { methods: ["GET"], template: "/device/id", mode: "both", route: SITE_OTHER_ROUTE, platformData: false, what: "the device id", source: "stage 1, §9; engine LOGIN_SCREEN_READS" },
];

/** The login operations (spec §2.4; stage 1, §9): the only writes open on
 *  the first stage, in the manual login only. The engine's LOGIN_PATHS
 *  (fansly/route-match.ts) — the test holds the two equal. */
export const LOGIN_ROWS: readonly ApiRow[] = [
  { methods: ["POST"], template: "/login", mode: "manual_login", route: "auth.login", platformData: false, what: "the login and password", source: "spec §2.4; stage 1, §9" },
  { methods: ["POST"], template: "/login/twofa", mode: "manual_login", route: "auth.twofa", platformData: false, what: "the 2FA code", source: "spec §2.4; stage 1, §9" },
];

/** Every other API read, and the preflights (spec §2.4). */
export const OPEN_ROWS: readonly ApiRow[] = [
  { methods: ["GET"], template: "/**", mode: "automation", route: SITE_OTHER_ROUTE, platformData: true, what: "an API read outside the catalogue", source: "spec §2.4; decision №3" },
  { methods: ["OPTIONS"], template: "/**", mode: "both", route: null, platformData: false, what: "a CORS preflight: under its request's admission", source: "spec §2.4; decision №1" },
];

const WRITES = ["POST", "PUT", "PATCH", "DELETE"];

function closed(template: string, example: string, what: string, source: string, methods: readonly string[] = WRITES): ApiRow {
  return { methods, template, mode: "closed", route: null, platformData: false, what, source, example };
}

const BUNDLE = "the site's public bundle (prototype, 2026-10-11)";

/** Closed one by one until the owner opens each (spec §2.5): in both modes,
 *  during manual access and without the operator. While every write but the
 *  login is closed anyway, these stay closed when writes start to open. */
export const CLOSED_ROWS: readonly ApiRow[] = [
  // Read marks: the site sends them by itself; open, they would clear the
  // chatters' unread.
  closed("/message/ack", "/message/ack", "a read mark", "spec §2.5; plan §4.6"),
  closed("/message/ack/all", "/message/ack/all", "a read mark (every chat)", BUNDLE),
  closed("/notifications/ack", "/notifications/ack", "a read mark (notifications)", BUNDLE),
  closed("/groups/users/readreceipts", "/groups/users/readreceipts", "a read receipt", BUNDLE),
  closed("/message/typing", "/message/typing", "typing", "spec §2.5; plan §4.6"),
  closed("/status", "/status", "the presence status", "spec §2.5; plan §4.6"),
  // The account: its e-mail, its deletion, its payout details.
  closed("/account/emailchange/**", "/account/emailchange/request", "an e-mail change", `spec §2.5; ${BUNDLE}`),
  closed("/account/disable", "/account/disable", "the account's deletion", `spec §2.5; ${BUNDLE}`),
  closed("/payments/payoutmethods/**", "/payments/payoutmethods", "the payout details (a write to the payout methods)", "spec §2.5: the catalogue's read of them, written"),
  // The password and the 2FA settings (entering them at a login is a login
  // operation, above).
  closed("/login/password*/**", "/login/password/change", "a password change", `spec §2.5; ${BUNDLE}`),
  closed("/twofa/**", "/twofa/disable", "the 2FA settings", `spec §2.5; ${BUNDLE}`),
];

/** Every API row, closed ones first: the order the operator decides in. */
export const API_ROWS: readonly ApiRow[] = [...CLOSED_ROWS, ...LOGIN_ROWS, ...LOGIN_SCREEN_ROWS, ...CATALOGUE_ROWS, ...OPEN_ROWS];

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

/** Percent-encoded letters, digits, `-._~` and the slash. */
const DECODED = /%(2[DdEeFf]|3[0-9]|4[1-9A-Fa-f]|5[0-9Aa]|5[Ff]|6[1-9A-Fa-f]|7[0-9Aa]|7[Ee])/g;

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
  return COMPILED_CLOSED.find((entry) => entry.row.methods.includes(verb) && templateMatches(entry.template, parts, true))?.row ?? null;
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

/** A read of the login screens (the engine's `apiPathOf`), or null. */
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
 *   socket    the site's socket: the engine admits its tunnel (`wsAdmit`)
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
