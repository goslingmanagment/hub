import type { FanslySessionBundle } from "@agency_hub_core/shared";

import { FanslyCredentialsRefusedError } from "../errors.ts";
import { buildFanslyRequestHeaders } from "../request-headers.ts";
import type { FanslyEarningsAccount, FanslyPostsPage } from "../types.ts";
import {
  parseFanslyAccountMe,
  parseFanslyAccountsByIds,
  parseFanslyFollowersPage,
  parseFanslyGroupDetail,
  parseFanslyMessagesPage,
  parseFanslyMessagingGroupsPage,
  parseFanslySubscribersPage,
  parseFanslyTransactionsPage,
} from "./contracts.ts";
import type {
  FanslyCdnAnswer,
  FanslyContractResult,
  FanslyStatsWindow,
  FanslyTransactionsPageContract,
  FanslyWsUpgradeAnswer,
  FanslyWireId,
  FanslyWireParams,
  FanslyWireRequest,
  FanslyWireSpecFor,
} from "./types.ts";

// One spec per Fansly route the engine reads. Every request shape is the
// deleted legacy adapter method's, key for key and in the same order,
// including the present-and-empty values the app sends
// (`tests/fansly-wire-specs.test.ts` pins each URL to the one the adapter
// sent). Only what varies per request is a parameter; page sizes and fixed
// filters are the app's and live here. A route the adapter never read
// (`legacyOperation: null`) takes its shape from the web app's own request.

/**
 * WP-F3: `/media/vaultnew`'s head cursor is the LITERAL STRING "0", for both
 * `before` and `after`. An empty `before=` is a cursor the server does not
 * honour — it answers `{albumMedia: [], media: []}` for an album with 4 760
 * items, which is indistinguishable from an exhausted album. The app's own
 * caller sends "0"; so does this spec.
 */
export const VAULT_MEDIA_HEAD_CURSOR = "0";
/**
 * WP-F3: ids per `/account/media?ids=` and `/account/media/bundle?ids=` call.
 *
 * NOT a guess: the app batches its own hydration at `splice(0, 100)` in both
 * `requestMediaTick` and `requestBundleTick`, so 100 is the size the server is
 * known to answer for. A smaller batch would triple the call count of the
 * hydration step for no benefit; a larger one would be a shape nobody has
 * observed the server accept.
 */
export const ACCOUNT_MEDIA_BATCH_SIZE = 100;

/**
 * WP-F6: ids per `GET /post?ids=` call.
 *
 * The app's own `getPosts` joins the id list with no splice of its own — its
 * two live call sites hydrate one or two ids — so unlike
 * `ACCOUNT_MEDIA_BATCH_SIZE` this number is NOT read out of a batching loop in
 * the bundle. It is the size the same app uses for every OTHER `?ids=` route it
 * batches (`requestedAccountIds_`, `requestedMediaIds_`, `requestedBundleIds_`
 * are all `splice(0, 100)`), and the refresh lane's arithmetic is sized on it.
 * A larger batch would be a shape nobody has seen the server accept.
 */
export const POST_BATCH_SIZE = 100;

/**
 * WP-F5: the statuses `/post/{postId}/replies` may answer with an empty body.
 *
 * NOT live-proven — no GET anywhere in the 2026-08-19 HAR returned 204 (all 197
 * are OPTIONS preflights), and production's "no replies" is a 200 with an empty
 * `posts[]` — so this is the handling of a case we have never seen rather than
 * a contract we have observed. It is scoped to that ONE
 * method deliberately: everywhere else an envelope-less body is a failure, and
 * a global softening would let a truncated response read as "no data" on every
 * lane at once.
 */
export const POST_REPLIES_EMPTY_STATUSES = [204] as const;

/**
 * WP-F7: the page size `/payments/payout/requests` is walked at.
 *
 * The wallet UI requests 10 and the server served 10 on eight of nine observed
 * pages (the ninth, the last, returned 3 of a `total` of 83). Whether a larger
 * `limit` is honoured on this route was NEVER measured — the one authorized
 * follow-up probe answered it for `/earnings/transactions`, a different route —
 * so 10 is assumed rather than believed, which costs nine calls once per page
 * and buys a walk that cannot silently skip rows.
 */
export const PAYOUT_REQUESTS_PAGE_SIZE = 10;

/**
 * The value `before` and `after` carry on `/payments/payout/requests`: PRESENT
 * AND EMPTY.
 *
 * The app sent them that way on all nine observed calls, and the wallet surface
 * never exposed a control that would fill them. An OMITTED parameter is a
 * different request from an empty one, and only the empty one has ever been
 * answered — the same lesson `/media/vaultnew` taught the catalog lane, where a
 * guessed cursor form returned an empty page for a 4 760-item album.
 */
export const PAYOUT_REQUESTS_UNBOUNDED = "";

/** `/messaging/groups` page size (with `sortOrder=1&flags=0`), as the
 *  conversation sweep has always read it. */
export const FANSLY_MESSAGING_GROUPS_PAGE_LIMIT = 100;
/** `/message` page size: the app's own, and the unit of a chain read. */
export const FANSLY_MESSAGES_PAGE_LIMIT = 25;
/** `/subscribers` page size. */
export const FANSLY_SUBSCRIBERS_PAGE_LIMIT = 100;
/** `/account/:id/followersnew` page size (incremental and full walks). */
export const FANSLY_FOLLOWERS_PAGE_LIMIT = 100;
/** `/media/orderhistory` page size (`FANSLY_PURCHASE_HISTORY_RESULT_LIMIT`). */
export const FANSLY_ORDER_HISTORY_PAGE_LIMIT = 100;
/** Ids per `/account?ids=` lookup. */
export const FANSLY_ACCOUNT_LOOKUP_BATCH_SIZE = 100;
/** The head cursor of `/notifications`, `/timelinenew` and the discovery feed. */
export const FANSLY_HEAD_CURSOR = "0";

/** A non-negative integer parameter, as the app writes it. A fraction or a
 *  negative value is a caller bug: refused before anything is sent. */
function count(name: string, value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Fansly wire parameter ${name} must be a non-negative integer (got ${value})`);
  }
  return String(value);
}

function nonBlank(name: string, value: string): string {
  if (value.trim().length === 0) {
    throw new RangeError(`Fansly wire parameter ${name} must be nonblank`);
  }
  return value;
}

/** A path segment: a platform id, encoded so it can only ever be one segment. */
function segment(name: string, value: string): string {
  return encodeURIComponent(nonBlank(name, value));
}

function idList(name: string, ids: readonly string[], max?: number): string {
  if (ids.length === 0 || (max !== undefined && ids.length > max)) {
    const range = max === undefined ? "at least one id" : `1–${max} ids`;
    throw new RangeError(`Fansly wire parameter ${name} takes ${range} (got ${ids.length})`);
  }
  ids.forEach((id, index) => nonBlank(`${name}[${index}]`, id));
  return ids.join(",");
}

/** A count of at least one (a page size, a span in hours). */
function positive(name: string, value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Fansly wire parameter ${name} must be a positive integer (got ${value})`);
  }
  return String(value);
}

/** An integer that may be negative (a time-zone offset). */
function integer(name: string, value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Fansly wire parameter ${name} must be an integer (got ${value})`);
  }
  return String(value);
}

/** One of the values the route defines. Parameters arrive as JSON from a work
 *  row or the owner's probe, so their type alone does not hold them. */
function oneOf<T extends string | number>(name: string, value: T, allowed: readonly T[]): string {
  if (!allowed.includes(value)) {
    throw new RangeError(`Fansly wire parameter ${name} must be one of ${allowed.join(", ")} (got ${String(value)})`);
  }
  return String(value);
}

const STATS_SOURCES = [0, 1, 4] as const;

/** The window of a statistics route, as the app sends it: the first and the
 *  last UTC day. A reversed window is a caller bug. */
function statsWindow(p: FanslyStatsWindow): { after: string; before: string } {
  if (p.afterMs > p.beforeMs) {
    throw new RangeError(`Fansly statistics window is reversed (afterMs ${p.afterMs} > beforeMs ${p.beforeMs})`);
  }
  return { after: count("afterMs", p.afterMs), before: count("beforeMs", p.beforeMs) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accepted<R>(value: R): FanslyContractResult<R> {
  return { ok: true, value };
}

function refused<R>(field: string, detail: string): FanslyContractResult<R> {
  return { ok: false, violation: { field, detail } };
}

function fromLegacyParser<R>(value: R | null, detail: string): FanslyContractResult<R> {
  return value === null ? refused("response", detail) : accepted(value);
}

/**
 * The routes whose bodies are journaled BEFORE anything asserts on them: the
 * envelope is the whole wire contract, and the content contract is the lane's
 * own predicate (`classifyNotificationResponse`, `classifyPostRepliesResponse`,
 * `classifyFanslyPurchaseHistoryCapture`, …), applied by the resource in
 * apps/runtime, which this package cannot import.
 */
function journalFirst(response: unknown): FanslyContractResult<unknown> {
  return accepted(response);
}

function postsPage(response: unknown): FanslyContractResult<FanslyPostsPage> {
  return isRecord(response) && Array.isArray(response.posts)
    ? accepted(response as FanslyPostsPage)
    : refused("posts", "response carries no posts array");
}

function transactionsPage(response: unknown): FanslyContractResult<FanslyTransactionsPageContract> {
  const page = parseFanslyTransactionsPage(response);
  if (page === null) {
    return refused("response", "not a {total, data[]} transactions page");
  }
  if (page.itemViolation !== null) {
    const { index, transactionId, field } = page.itemViolation;
    return refused(
      `data[${index}].${field}`,
      `transaction ${transactionId ?? "(no id)"} failed the item contract`,
    );
  }
  return accepted({ total: page.total, data: page.data });
}

function earningsAccounts(response: unknown): FanslyContractResult<FanslyEarningsAccount[]> {
  if (!Array.isArray(response)) {
    return refused("response", "earnings accounts is not an array");
  }
  const index = response.findIndex((item) => !isRecord(item));
  return index === -1
    ? accepted(response as FanslyEarningsAccount[])
    : refused(`[${index}]`, "earnings account row is not an object");
}

function wsUpgradeAnswer(response: unknown): FanslyContractResult<FanslyWsUpgradeAnswer> {
  return isRecord(response) && response.status === 101
    ? accepted({ status: 101 })
    : refused("status", "an Upgrade is answered by 101");
}

function cdnAnswer(response: unknown): FanslyContractResult<FanslyCdnAnswer> {
  if (!isRecord(response) || typeof response.status !== "number") return refused("status", "a CDN answer carries its status");
  if (response.body !== null && !Buffer.isBuffer(response.body)) return refused("body", "a CDN body is bytes");
  return accepted(response as unknown as FanslyCdnAnswer);
}

/** A route without a path of its own: its URL is not the API's. */
function noApiPath(id: FanslyWireId, why: string): never {
  throw new RangeError(`Fansly wire route ${id} is not an API route: ${why}`);
}

type SpecTable = { readonly [I in FanslyWireId]: FanslyWireSpecFor<I> };

const noQuery = () => ({});

export const FANSLY_WIRE_SPECS: SpecTable = {
  "account.me": {
    id: "account.me",
    credentials: "session",
    kind: "account_me",
    host: "api",
    endpointTemplate: "/account/me",
    legacyOperation: "account_me",
    path: () => "/account/me",
    query: noQuery,
    parse: (response) => parseFanslyAccountMe(response),
  },
  "accounts.by_ids": {
    id: "accounts.by_ids",
    credentials: "session",
    kind: "account_lookup",
    host: "api",
    endpointTemplate: "/account",
    legacyOperation: "account_lookup",
    path: () => "/account",
    query: (p) => ({ ids: idList("ids", p.ids, FANSLY_ACCOUNT_LOOKUP_BATCH_SIZE) }),
    parse: (response) => parseFanslyAccountsByIds(response),
  },
  "messaging.groups": {
    id: "messaging.groups",
    credentials: "session",
    kind: "dm_conversations",
    host: "api",
    endpointTemplate: "/messaging/groups",
    legacyOperation: "messaging_groups",
    path: () => "/messaging/groups",
    query: (p) => ({
      offset: count("offset", p.offset),
      limit: String(FANSLY_MESSAGING_GROUPS_PAGE_LIMIT),
      sortOrder: "1",
      flags: "0",
    }),
    parse: (response) => fromLegacyParser(
      parseFanslyMessagingGroupsPage(response),
      "not a {data[]} conversation page with an id on every row, group and account",
    ),
  },
  "group.detail": {
    id: "group.detail",
    credentials: "session",
    kind: "group_detail",
    host: "api",
    endpointTemplate: "/group/:groupId",
    legacyOperation: "group_detail",
    path: (p) => `/group/${segment("groupId", p.groupId)}`,
    query: noQuery,
    parse: (response, p) => parseFanslyGroupDetail(response, p.groupId),
  },
  "messages.page": {
    id: "messages.page",
    credentials: "session",
    kind: "dm_messages",
    host: "api",
    endpointTemplate: "/message",
    legacyOperation: "messages",
    path: () => "/message",
    query: (p) => ({
      groupId: nonBlank("groupId", p.groupId),
      limit: String(FANSLY_MESSAGES_PAGE_LIMIT),
      ...(p.before === null ? {} : { before: nonBlank("before", p.before) }),
    }),
    parse: (response) => fromLegacyParser(parseFanslyMessagesPage(response), "not a {messages[]} page"),
  },
  "transactions.page": {
    id: "transactions.page",
    credentials: "session",
    kind: "earnings_transactions",
    host: "api",
    endpointTemplate: "/account/wallets/earnings/transactions",
    legacyOperation: "earnings_transactions",
    path: () => "/account/wallets/earnings/transactions",
    // Never `after`/`before`: the app sends no bound on this route, and a bound
    // makes `total` disagree with (or suppress) the returned rows.
    query: (p) => ({ limit: count("limit", p.limit), offset: count("offset", p.offset) }),
    parse: (response) => transactionsPage(response),
  },
  "earnings.accounts": {
    id: "earnings.accounts",
    credentials: "session",
    kind: "earnings_accounts",
    host: "api",
    endpointTemplate: "/account/wallets/earnings/accounts",
    legacyOperation: "earnings_accounts",
    path: () => "/account/wallets/earnings/accounts",
    query: (p) => ({ after: count("afterMs", p.afterMs), before: count("beforeMs", p.beforeMs) }),
    parse: (response) => earningsAccounts(response),
  },
  "earnings.stats_accounts": {
    id: "earnings.stats_accounts",
    credentials: "session",
    kind: "fan_earnings_stats",
    host: "api",
    endpointTemplate: "/account/wallets/earnings/stats/accounts",
    legacyOperation: "earnings_stats_accounts",
    path: () => "/account/wallets/earnings/stats/accounts",
    query: (p) => ({
      correlationAccountId: nonBlank("correlationAccountId", p.correlationAccountId),
      after: count("afterMs", p.afterMs),
      before: count("beforeMs", p.beforeMs),
    }),
    parse: journalFirst,
  },
  "earnings.monthly_accounts": {
    id: "earnings.monthly_accounts",
    credentials: "session",
    kind: "fan_earnings_monthly",
    host: "api",
    endpointTemplate: "/account/wallets/earnings/monthlystats/accounts",
    legacyOperation: "earnings_monthlystats_accounts",
    path: () => "/account/wallets/earnings/monthlystats/accounts",
    query: (p) => ({
      correlationAccountId: nonBlank("correlationAccountId", p.correlationAccountId),
      after: count("afterMs", p.afterMs),
      before: count("beforeMs", p.beforeMs),
    }),
    parse: journalFirst,
  },
  "media.order_history": {
    id: "media.order_history",
    credentials: "session",
    kind: "purchase_history",
    host: "api",
    endpointTemplate: "/media/orderhistory",
    legacyOperation: "media_orderhistory",
    path: () => "/media/orderhistory",
    query: (p) => ({
      ...(p.target.kind === "media"
        ? { accountMediaId: nonBlank("target.id", p.target.id) }
        : { accountMediaBundleId: nonBlank("target.id", p.target.id) }),
      ...(p.before === null ? {} : { before: nonBlank("before", p.before) }),
      limit: String(FANSLY_ORDER_HISTORY_PAGE_LIMIT),
    }),
    parse: journalFirst,
  },
  "payouts.methods": {
    id: "payouts.methods",
    credentials: "session",
    kind: "payout_methods",
    host: "api",
    endpointTemplate: "/payments/payoutmethods",
    legacyOperation: "payout_methods",
    path: () => "/payments/payoutmethods",
    query: noQuery,
    parse: journalFirst,
  },
  "payouts.requests": {
    id: "payouts.requests",
    credentials: "session",
    kind: "payout_requests",
    host: "api",
    endpointTemplate: "/payments/payout/requests",
    legacyOperation: "payout_requests",
    path: () => "/payments/payout/requests",
    query: (p) => ({
      before: PAYOUT_REQUESTS_UNBOUNDED,
      after: PAYOUT_REQUESTS_UNBOUNDED,
      limit: String(PAYOUT_REQUESTS_PAGE_SIZE),
      offset: count("offset", p.offset),
    }),
    parse: journalFirst,
  },
  "subscribers.page": {
    id: "subscribers.page",
    credentials: "session",
    kind: "subscribers",
    host: "api",
    endpointTemplate: "/subscribers",
    legacyOperation: "subscribers",
    path: () => "/subscribers",
    query: (p) => ({
      offset: count("offset", p.offset),
      limit: String(FANSLY_SUBSCRIBERS_PAGE_LIMIT),
      status: p.status,
    }),
    parse: (response, p) => fromLegacyParser(
      parseFanslySubscribersPage(response, p.status),
      `not a subscribers page with a ${p.status} total and an id on every subscription`,
    ),
  },
  "followers.page": {
    id: "followers.page",
    credentials: "session",
    kind: "followers",
    host: "api",
    endpointTemplate: "/account/:accountId/followersnew",
    legacyOperation: "followers",
    path: (p) => `/account/${segment("accountId", p.accountId)}/followersnew`,
    query: (p) => ({ offset: count("offset", p.offset), limit: String(FANSLY_FOLLOWERS_PAGE_LIMIT) }),
    parse: (response) => fromLegacyParser(
      parseFanslyFollowersPage(response),
      "not a {followers[]} page with an id on every follow and account",
    ),
  },
  "notifications.page": {
    id: "notifications.page",
    credentials: "session",
    kind: "notifications",
    host: "api",
    endpointTemplate: "/notifications",
    legacyOperation: "notifications_page",
    path: () => "/notifications",
    // `type` is omitted on the unfiltered form: an empty `type=` filters for
    // nothing, it is not the absence of a filter.
    query: (p) => ({
      before: nonBlank("before", p.before),
      after: FANSLY_HEAD_CURSOR,
      ...(p.types !== null && p.types.length > 0
        ? { type: p.types.map((type, index) => count(`types[${index}]`, type)).join(",") }
        : {}),
    }),
    parse: journalFirst,
  },
  "posts.timeline": {
    id: "posts.timeline",
    credentials: "session",
    kind: "posts",
    host: "api",
    endpointTemplate: "/timelinenew/:accountId",
    legacyOperation: "timeline_posts",
    path: (p) => `/timelinenew/${segment("accountId", p.accountId)}`,
    query: (p) => ({ before: nonBlank("before", p.before), after: FANSLY_HEAD_CURSOR }),
    parse: (response) => postsPage(response),
  },
  "posts.tips": {
    id: "posts.tips",
    credentials: "session",
    kind: "post_tips",
    host: "api",
    endpointTemplate: "/tips",
    legacyOperation: "post_tips",
    path: () => "/tips",
    query: (p) => ({ targetIds: idList("targetIds", p.targetIds) }),
    // An optional companion read: a body that drifted away from an array is
    // journaled and counted by the posts walk, which moves on (the legacy lane
    // never let it wedge the timeline), so the wire refuses nothing here.
    parse: journalFirst,
  },
  "posts.by_ids": {
    id: "posts.by_ids",
    credentials: "session",
    kind: "posts",
    host: "api",
    endpointTemplate: "/post",
    legacyOperation: "post_lookup",
    path: () => "/post",
    query: (p) => ({ ids: idList("ids", p.ids, POST_BATCH_SIZE) }),
    parse: (response) => postsPage(response),
  },
  "post.replies": {
    id: "post.replies",
    credentials: "session",
    kind: "post_replies",
    host: "api",
    endpointTemplate: "/post/{postId}/replies",
    legacyOperation: "post_replies",
    path: (p) => `/post/${segment("postId", p.postId)}/replies`,
    // Bare on the first call; `before` only once a full page suggests more.
    query: (p) => (p.before === null ? {} : { before: nonBlank("before", p.before) }),
    emptyStatuses: POST_REPLIES_EMPTY_STATUSES,
    parse: journalFirst,
  },
  "vault.albums": {
    id: "vault.albums",
    credentials: "session",
    kind: "vault_albums",
    host: "api",
    endpointTemplate: "/vault/albumsnew",
    legacyOperation: "vault_albums",
    path: () => "/vault/albumsnew",
    query: noQuery,
    parse: journalFirst,
  },
  "uservault.albums": {
    id: "uservault.albums",
    credentials: "session",
    kind: "uservault_albums",
    host: "api",
    endpointTemplate: "/uservault/albumsnew",
    legacyOperation: "uservault_albums",
    path: () => "/uservault/albumsnew",
    query: (p) => ({ accountId: nonBlank("accountId", p.accountId) }),
    parse: journalFirst,
  },
  "subscriptions.tiers": {
    id: "subscriptions.tiers",
    credentials: "session",
    kind: "subscription_tiers",
    host: "api",
    endpointTemplate: "/subscriptions/tiers",
    legacyOperation: "subscription_tiers",
    path: () => "/subscriptions/tiers",
    query: noQuery,
    parse: journalFirst,
  },
  "subscriptions.giftcodes": {
    id: "subscriptions.giftcodes",
    credentials: "session",
    kind: "gift_codes",
    host: "api",
    endpointTemplate: "/subscriptions/giftcodes",
    legacyOperation: "gift_codes",
    path: () => "/subscriptions/giftcodes",
    query: noQuery,
    parse: journalFirst,
  },
  "message.automated": {
    id: "message.automated",
    credentials: "session",
    kind: "automated_messages",
    host: "api",
    endpointTemplate: "/message/automated",
    legacyOperation: "automated_messages",
    path: () => "/message/automated",
    query: noQuery,
    parse: journalFirst,
  },
  "account.walls": {
    id: "account.walls",
    credentials: "session",
    kind: "account_walls",
    host: "api",
    endpointTemplate: "/account/walls",
    legacyOperation: "account_walls_probe",
    path: () => "/account/walls",
    // Present and empty: every wall, not the walls of some posts.
    query: () => ({ correlationPostIds: "" }),
    parse: journalFirst,
  },
  "vault.media": {
    id: "vault.media",
    credentials: "session",
    kind: "vault_media",
    host: "api",
    endpointTemplate: "/media/vaultnew",
    legacyOperation: "vault_media",
    path: () => "/media/vaultnew",
    // The app's own form: `mediaType` and `search` present and empty, the head
    // cursor the literal "0" for both `before` and `after`.
    query: (p) => ({
      albumId: nonBlank("albumId", p.albumId),
      mediaType: "",
      search: "",
      before: nonBlank("before", p.before),
      after: VAULT_MEDIA_HEAD_CURSOR,
    }),
    parse: journalFirst,
  },
  "account.media_by_ids": {
    id: "account.media_by_ids",
    credentials: "session",
    kind: "account_media_batch",
    host: "api",
    endpointTemplate: "/account/media",
    legacyOperation: "account_media_by_ids_probe",
    path: () => "/account/media",
    query: (p) => ({ ids: idList("ids", p.ids, ACCOUNT_MEDIA_BATCH_SIZE) }),
    parse: journalFirst,
  },
  "account.bundles_by_ids": {
    id: "account.bundles_by_ids",
    credentials: "session",
    kind: "account_media_bundle_batch",
    host: "api",
    endpointTemplate: "/account/media/bundle",
    legacyOperation: "account_media_bundles_by_ids_probe",
    path: () => "/account/media/bundle",
    query: (p) => ({ ids: idList("ids", p.ids, ACCOUNT_MEDIA_BATCH_SIZE) }),
    parse: journalFirst,
  },
  "media.offer_stats": {
    id: "media.offer_stats",
    credentials: "session",
    kind: "media_offer_stats",
    host: "api",
    endpointTemplate: "/it/moie/statsnew",
    legacyOperation: "media_offer_stats",
    path: () => "/it/moie/statsnew",
    query: (p) => ({
      mediaOfferId: nonBlank("mediaOfferId", p.mediaOfferId),
      beforeDate: count("beforeMs", p.beforeMs),
      afterDate: count("afterMs", p.afterMs),
      period: count("periodMs", p.periodMs),
    }),
    // A 500 with Fansly's error envelope is this route's answer for a gone
    // item or a refused span, and a retry has never changed it.
    finalServerErrorEnvelope: true,
    parse: journalFirst,
  },
  "account.stats": {
    id: "account.stats",
    credentials: "session",
    kind: "account_stats",
    host: "api",
    endpointTemplate: "/it/amoie/stats",
    legacyOperation: "account_stats",
    path: () => "/it/amoie/stats",
    query: (p) => ({
      beforeDate: count("beforeMs", p.beforeMs),
      afterDate: count("afterMs", p.afterMs),
      period: count("periodMs", p.periodMs),
      year: count("year", p.year ?? 0),
      month: count("month", p.month ?? 0),
    }),
    parse: journalFirst,
  },
  "earnings.stats_window": {
    id: "earnings.stats_window",
    credentials: "session",
    kind: "earnings_stats_snapshot",
    host: "api",
    endpointTemplate: "/account/wallets/earnings/stats",
    legacyOperation: "earnings_stats_window",
    path: () => "/account/wallets/earnings/stats",
    query: (p) => ({
      before: count("beforeMs", p.beforeMs),
      after: count("afterMs", p.afterMs),
      limit: count("limit", p.limit),
    }),
    parse: journalFirst,
  },
  "earnings.monthly": {
    id: "earnings.monthly",
    credentials: "session",
    kind: "earnings_monthlystats_snapshot",
    host: "api",
    endpointTemplate: "/account/wallets/earnings/monthlystats",
    legacyOperation: "earnings_monthly_stats",
    path: () => "/account/wallets/earnings/monthlystats",
    query: (p) => ({
      ...(p.beforeMs === null ? {} : { before: count("beforeMs", p.beforeMs) }),
      ...(p.afterMs === null ? {} : { after: count("afterMs", p.afterMs) }),
    }),
    parse: journalFirst,
  },
  "trackinglinks": {
    id: "trackinglinks",
    credentials: "session",
    kind: "tracking_links",
    host: "api",
    endpointTemplate: "/trackinglinks",
    legacyOperation: "tracking_links",
    path: () => "/trackinglinks",
    query: noQuery,
    parse: journalFirst,
  },
  "discovery.suggestions": {
    id: "discovery.suggestions",
    credentials: "session",
    kind: "discovery_feed",
    host: "api",
    endpointTemplate: "/contentdiscovery/media/suggestionsnew",
    legacyOperation: "discovery_media_suggestions",
    path: () => "/contentdiscovery/media/suggestionsnew",
    query: (p) => ({
      before: FANSLY_HEAD_CURSOR,
      after: FANSLY_HEAD_CURSOR,
      tagIds: "",
      limit: count("limit", p.limit),
      offset: count("offset", p.offset),
    }),
    parse: journalFirst,
  },
  "broadcast.stats": {
    id: "broadcast.stats",
    credentials: "session",
    kind: "broadcast_stats",
    host: "api",
    endpointTemplate: "/message/broadcast/stats",
    legacyOperation: "broadcast_stats_probe",
    path: () => "/message/broadcast/stats",
    query: (p) => (p.before === null ? {} : { before: nonBlank("before", p.before) }),
    parse: journalFirst,
  },
  "broadcast.stats_deleted": {
    id: "broadcast.stats_deleted",
    credentials: "session",
    kind: "broadcast_stats_deleted",
    host: "api",
    endpointTemplate: "/message/broadcast/stats/deleted",
    legacyOperation: "broadcast_stats_deleted_probe",
    path: () => "/message/broadcast/stats/deleted",
    query: (p) => (p.before === null ? {} : { before: nonBlank("before", p.before) }),
    parse: journalFirst,
  },
  "broadcast.scheduled": {
    id: "broadcast.scheduled",
    credentials: "session",
    kind: "broadcast_scheduled",
    host: "api",
    endpointTemplate: "/message/broadcast/scheduled",
    legacyOperation: "broadcast_scheduled_probe",
    path: () => "/message/broadcast/scheduled",
    query: noQuery,
    parse: journalFirst,
  },
  "polls": {
    id: "polls",
    credentials: "session",
    kind: "polls",
    host: "api",
    endpointTemplate: "/polls",
    legacyOperation: "polls_probe",
    path: () => "/polls",
    query: noQuery,
    parse: journalFirst,
  },
  "recapstats": {
    id: "recapstats",
    credentials: "session",
    kind: "recapstats",
    host: "api",
    endpointTemplate: "/recapstats",
    legacyOperation: "recapstats_probe",
    path: () => "/recapstats",
    query: noQuery,
    parse: journalFirst,
  },
  // ── The creator statistics pages of 2026-10 ──────────────────────────────
  // (reference/fansly-creator-stats). No legacy sender ever read these routes
  // and no resource collects them yet: the specs exist so the owner's
  // `sync probe` can send them and journal the answer. Keys are in the order
  // the web app writes them.
  "stats.summary": {
    id: "stats.summary",
    credentials: "session",
    kind: "creator_stats_summary",
    host: "api",
    endpointTemplate: "/account/stats/summary",
    legacyOperation: null,
    path: () => "/account/stats/summary",
    query: (p) => statsWindow(p),
    parse: journalFirst,
  },
  "stats.series": {
    id: "stats.series",
    credentials: "session",
    kind: "creator_stats_series",
    host: "api",
    endpointTemplate: "/account/stats/series",
    legacyOperation: null,
    path: () => "/account/stats/series",
    query: (p) => ({
      family: oneOf("family", p.family, ["views", "profile", "follows", "subscriptions", "revenue"]),
      granularity: oneOf("granularity", p.granularity, ["hour", "day", "month"]),
      ...statsWindow(p),
    }),
    parse: journalFirst,
  },
  "stats.media_top": {
    id: "stats.media_top",
    credentials: "session",
    kind: "creator_stats_media_top",
    host: "api",
    endpointTemplate: "/account/stats/media/top",
    legacyOperation: null,
    path: () => "/account/stats/media/top",
    query: (p) => ({
      source: oneOf("source", p.source, STATS_SOURCES),
      ...(p.mediaType === null ? {} : { mediaType: oneOf("mediaType", p.mediaType, [1, 2]) }),
      ...statsWindow(p),
      orderBy: oneOf("orderBy", p.orderBy, ["views", "uniqueViewers", "watchMs", "completedViews", "watchLift"]),
      limit: positive("limit", p.limit),
    }),
    parse: journalFirst,
  },
  "stats.media": {
    id: "stats.media",
    credentials: "session",
    kind: "creator_stats_media",
    host: "api",
    endpointTemplate: "/account/stats/media",
    legacyOperation: null,
    path: () => "/account/stats/media",
    query: (p) => ({
      mediaOfferId: nonBlank("mediaOfferId", p.mediaOfferId),
      source: oneOf("source", p.source, [-1, ...STATS_SOURCES]),
      ...statsWindow(p),
    }),
    parse: journalFirst,
  },
  "stats.media_benchmarks": {
    id: "stats.media_benchmarks",
    credentials: "session",
    kind: "creator_stats_media_benchmarks",
    host: "api",
    endpointTemplate: "/account/stats/media/benchmarks",
    legacyOperation: null,
    path: () => "/account/stats/media/benchmarks",
    query: (p) => ({ source: oneOf("source", p.source, STATS_SOURCES), ...statsWindow(p) }),
    parse: journalFirst,
  },
  "stats.media_shown": {
    id: "stats.media_shown",
    credentials: "session",
    kind: "creator_stats_media_shown",
    host: "api",
    endpointTemplate: "/account/stats/media/shown",
    legacyOperation: null,
    path: () => "/account/stats/media/shown",
    query: (p) => ({ end: count("endMs", p.endMs), hours: positive("hours", p.hours) }),
    parse: journalFirst,
  },
  "stats.geo": {
    id: "stats.geo",
    credentials: "session",
    kind: "creator_stats_geo",
    host: "api",
    endpointTemplate: "/account/stats/geo",
    legacyOperation: null,
    path: () => "/account/stats/geo",
    query: (p) => ({
      source: oneOf("source", p.source, STATS_SOURCES),
      ...statsWindow(p),
      limit: positive("limit", p.limit),
    }),
    parse: journalFirst,
  },
  "stats.active_hours": {
    id: "stats.active_hours",
    credentials: "session",
    kind: "creator_stats_active_hours",
    host: "api",
    endpointTemplate: "/account/stats/activehours",
    legacyOperation: null,
    path: () => "/account/stats/activehours",
    query: (p) => ({
      source: oneOf("source", p.source, STATS_SOURCES),
      ...statsWindow(p),
      timezoneOffsetMinutes: integer("timezoneOffsetMinutes", p.timezoneOffsetMinutes),
    }),
    parse: journalFirst,
  },
  "stats.tags": {
    id: "stats.tags",
    credentials: "session",
    kind: "creator_stats_tags",
    host: "api",
    endpointTemplate: "/account/stats/tags",
    legacyOperation: null,
    path: () => "/account/stats/tags",
    // The app always asks for `orderBy=views` and sorts the other modes itself.
    query: (p) => ({
      source: oneOf("source", p.source, STATS_SOURCES),
      kind: oneOf("kind", p.kind, [1, 2]),
      ...statsWindow(p),
      orderBy: "views",
      limit: positive("limit", p.limit),
    }),
    parse: journalFirst,
  },
  "stats.posts": {
    id: "stats.posts",
    credentials: "session",
    kind: "creator_stats_posts",
    host: "api",
    endpointTemplate: "/account/stats/posts",
    legacyOperation: null,
    path: () => "/account/stats/posts",
    query: (p) => ({ postIds: idList("postIds", p.postIds, POST_BATCH_SIZE), ...statsWindow(p) }),
    parse: journalFirst,
  },
  "stats.fans_top": {
    id: "stats.fans_top",
    credentials: "session",
    kind: "creator_stats_fans_top",
    host: "api",
    endpointTemplate: "/account/stats/fans/top",
    legacyOperation: null,
    path: () => "/account/stats/fans/top",
    query: (p) => ({
      ...statsWindow(p),
      orderBy: oneOf("orderBy", p.orderBy, ["netMills", "grossMills", "transactions"]),
      limit: positive("limit", p.limit),
    }),
    parse: journalFirst,
  },
  "stats.fan": {
    id: "stats.fan",
    credentials: "session",
    kind: "creator_stats_fan",
    host: "api",
    endpointTemplate: "/account/stats/fans",
    legacyOperation: null,
    path: () => "/account/stats/fans",
    query: (p) => ({
      fanId: nonBlank("fanId", p.fanId),
      ...statsWindow(p),
      granularity: oneOf("granularity", p.granularity, ["day", "month"]),
    }),
    parse: journalFirst,
  },
  "earnings.transactions_account": {
    id: "earnings.transactions_account",
    credentials: "session",
    kind: "fan_earnings_transactions",
    host: "api",
    endpointTemplate: "/account/wallets/earnings/transactions/accounts",
    legacyOperation: null,
    path: () => "/account/wallets/earnings/transactions/accounts",
    query: (p) => ({
      correlationAccountId: nonBlank("correlationAccountId", p.correlationAccountId),
      before: count("beforeMs", p.beforeMs),
      after: count("afterMs", p.afterMs),
      cursor: nonBlank("cursor", p.cursor),
      limit: positive("limit", p.limit),
    }),
    parse: journalFirst,
  },
  // Step 3, live only. Neither journals its answer (`capture`): the Upgrade's
  // record is the connection row, and a CDN file's bytes are handed to the AI
  // describer in memory and through the transient handoff buffer.
  "ws.upgrade": {
    id: "ws.upgrade",
    credentials: "session",
    kind: null,
    host: "ws",
    capture: "none",
    // The socket URL itself is the socket owner's (`openFanslyReceiverSocket`).
    endpointTemplate: "/?v=3",
    legacyOperation: "ws_connect",
    path: () => noApiPath("ws.upgrade", "the page's socket owner sends the Upgrade"),
    query: () => noApiPath("ws.upgrade", "the page's socket owner sends the Upgrade"),
    parse: wsUpgradeAnswer,
  },
  "cdn.media": {
    id: "cdn.media",
    credentials: "session",
    kind: null,
    host: "cdn",
    capture: "bytes",
    endpointTemplate: "<signed CDN URL>",
    legacyOperation: "media_download",
    path: () => noApiPath("cdn.media", "its URL is the work's secret"),
    query: () => noApiPath("cdn.media", "its URL is the work's secret"),
    parse: cdnAnswer,
  },
};

export const FANSLY_WIRE_IDS = Object.keys(FANSLY_WIRE_SPECS) as FanslyWireId[];

export function isFanslyWireId(value: unknown): value is FanslyWireId {
  return typeof value === "string" && Object.hasOwn(FANSLY_WIRE_SPECS, value);
}

export function fanslyWireSpec<I extends FanslyWireId>(id: I): FanslyWireSpecFor<I> {
  return FANSLY_WIRE_SPECS[id];
}

/** Whether `id` is an API route (a path under `fanslyBaseUrl`, journaled). */
export function isFanslyApiWireId(id: FanslyWireId): boolean {
  return fanslyWireSpec(id).host === "api";
}

/** The pathname and query of one request, exactly as the legacy adapter wrote
 *  them: `ngsw-bypass=true` first, then the spec's keys in order. Throws on a
 *  parameter no request may carry, before anything is admitted or sent. */
export function buildFanslyWireTarget<I extends FanslyWireId>(
  id: I,
  params: FanslyWireParams<I>,
): { pathname: string; search: string } {
  const spec = fanslyWireSpec(id);
  if (spec.host !== "api") noApiPath(id, `it is sent to the ${spec.host} host`);
  const query = new URLSearchParams({ "ngsw-bypass": "true" });
  for (const [key, value] of Object.entries(spec.query(params))) {
    query.set(key, value);
  }
  return { pathname: spec.path(params), search: `?${query.toString()}` };
}

export function buildFanslyWireUrl<I extends FanslyWireId>(
  id: I,
  params: FanslyWireParams<I>,
  baseUrl: string,
): string {
  const { pathname, search } = buildFanslyWireTarget(id, params);
  return `${baseUrl}${pathname}${search}`;
}

/** One request, built at send time: the browser headers of the captured HAR
 *  with this request's client timestamp, through `buildFanslyRequestHeaders`
 *  — the headers the legacy adapter sent for the same route. A page's route
 *  only (`credentials: "session"`): a session-less spec is the public
 *  builder's (`buildFanslyPublicWireRequest`) and is refused here before
 *  anything is built. */
export function buildFanslyWireRequest<I extends FanslyWireId>(
  id: I,
  params: FanslyWireParams<I>,
  input: { baseUrl: string; session: FanslySessionBundle; timeoutMs: number; nowMs?: number },
): FanslyWireRequest {
  const spec: { credentials?: unknown } | undefined = isFanslyWireId(id) ? fanslyWireSpec(id) : undefined;
  if (spec?.credentials !== "session") {
    throw new FanslyCredentialsRefusedError("page", String(id), "not a page route that carries the page's session");
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new RangeError(`Fansly wire request timeout must be a positive integer (got ${input.timeoutMs})`);
  }
  const { pathname, search } = buildFanslyWireTarget(id, params);
  return {
    spec: id,
    url: `${input.baseUrl}${pathname}${search}`,
    headers: buildFanslyRequestHeaders(input.session, pathname, input.nowMs),
    timeoutMs: input.timeoutMs,
  };
}
