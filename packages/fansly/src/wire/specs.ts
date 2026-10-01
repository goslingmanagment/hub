import type { FanslySessionBundle } from "@agency_hub_core/shared";

import { buildFanslyRequestHeaders } from "../request-headers.ts";
import type { FanslyEarningsAccount, FanslyPostsPage, FanslyPostTip } from "../types.ts";
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
  FanslyContractResult,
  FanslyTransactionsPageContract,
  FanslyWireId,
  FanslyWireParams,
  FanslyWireRequest,
  FanslyWireSpecFor,
} from "./types.ts";

// One spec per Fansly route the engine reads. Every request shape is the
// adapter method's, key for key and in the same order, including the
// present-and-empty values the app sends (`tests/fansly-wire-specs.test.ts`
// compares each URL with the adapter's own). Only what varies per request is a
// parameter; page sizes and fixed filters are the app's and live here.

/**
 * WP-F3: `/media/vaultnew`'s head cursor is the LITERAL STRING "0", for both
 * `before` and `after`. An empty `before=` is a cursor the server does not
 * honour — it answers `{albumMedia: [], media: []}` for an album with 4 760
 * items, which is indistinguishable from an exhausted album. The app's own
 * caller sends "0"; so does this adapter.
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

function postTips(response: unknown): FanslyContractResult<FanslyPostTip[]> {
  return Array.isArray(response)
    ? accepted(response as FanslyPostTip[])
    : refused("response", "post tips is not an array");
}

type SpecTable = { readonly [I in FanslyWireId]: FanslyWireSpecFor<I> };

const noQuery = () => ({});

export const FANSLY_WIRE_SPECS: SpecTable = {
  "account.me": {
    id: "account.me",
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
    kind: "post_tips",
    host: "api",
    endpointTemplate: "/tips",
    legacyOperation: "post_tips",
    path: () => "/tips",
    query: (p) => ({ targetIds: idList("targetIds", p.targetIds) }),
    parse: (response) => postTips(response),
  },
  "posts.by_ids": {
    id: "posts.by_ids",
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
    kind: "recapstats",
    host: "api",
    endpointTemplate: "/recapstats",
    legacyOperation: "recapstats_probe",
    path: () => "/recapstats",
    query: noQuery,
    parse: journalFirst,
  },
};

export const FANSLY_WIRE_IDS = Object.keys(FANSLY_WIRE_SPECS) as FanslyWireId[];

export function isFanslyWireId(value: unknown): value is FanslyWireId {
  return typeof value === "string" && Object.hasOwn(FANSLY_WIRE_SPECS, value);
}

export function fanslyWireSpec<I extends FanslyWireId>(id: I): FanslyWireSpecFor<I> {
  return FANSLY_WIRE_SPECS[id];
}

/** The pathname and query of one request, exactly as the adapter writes them:
 *  `ngsw-bypass=true` first, then the spec's keys in order. Throws on a
 *  parameter no request may carry, before anything is admitted or sent. */
export function buildFanslyWireTarget<I extends FanslyWireId>(
  id: I,
  params: FanslyWireParams<I>,
): { pathname: string; search: string } {
  const spec = fanslyWireSpec(id);
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
 *  — the same headers the adapter sends for the same route. */
export function buildFanslyWireRequest<I extends FanslyWireId>(
  id: I,
  params: FanslyWireParams<I>,
  input: { baseUrl: string; session: FanslySessionBundle; timeoutMs: number; nowMs?: number },
): FanslyWireRequest {
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
