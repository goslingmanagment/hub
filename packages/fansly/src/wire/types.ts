import type { FanslySendCheck, FanslySendRefusalReason } from "../send-guard.ts";
import type {
  FanslyAccount,
  FanslyAccountMeResponse,
  FanslyEarningsAccount,
  FanslyEarningsTransaction,
  FanslyFollowersPage,
  FanslyGroupDetail,
  FanslyMessagesPage,
  FanslyMessagingGroupsPage,
  FanslyPostsPage,
  FanslySubscriber,
} from "../types.ts";

// The wire layer of the Fansly Sync Engine (plan §12: "wire contracts of the
// endpoints — URL, parameters, schema, pagination — without retries, pauses or
// redirects"). One spec per endpoint; one physical request per send; no state.
// Who may send, and when, is the engine's business (pacer, admission); what a
// request looks like and what an answer must contain is this layer's.

/** The observation kinds the specs journal under: today's kinds, unchanged —
 *  the canonicalizer families, replay, the agent scrub and the AI describer
 *  read them by these names. Each one is registered in
 *  `apps/runtime/src/services/observation-kinds.ts` (pinned by a test). */
export type FanslyObservationKind =
  | "account_lookup"
  | "account_me"
  | "account_media_batch"
  | "account_media_bundle_batch"
  | "account_stats"
  | "account_walls"
  | "automated_messages"
  | "broadcast_scheduled"
  | "broadcast_stats"
  | "broadcast_stats_deleted"
  | "discovery_feed"
  | "dm_conversations"
  | "dm_messages"
  | "earnings_accounts"
  | "earnings_monthlystats_snapshot"
  | "earnings_stats_snapshot"
  | "earnings_transactions"
  | "fan_earnings_monthly"
  | "fan_earnings_stats"
  | "followers"
  | "gift_codes"
  | "group_detail"
  | "media_offer_stats"
  | "notifications"
  | "payout_methods"
  | "payout_requests"
  | "polls"
  | "post_replies"
  | "post_tips"
  | "posts"
  | "purchase_history"
  | "recapstats"
  | "subscribers"
  | "subscription_tiers"
  | "tracking_links"
  | "uservault_albums"
  | "vault_albums"
  | "vault_media";

/** Where a spec is sent: the API (`fanslyBaseUrl`), a media CDN host (the
 *  signed URL of a chat file, step 3) or the WebSocket host (the Upgrade that
 *  opens the page's socket, step 3). Only an API route has a path of its own
 *  and journals its answer. */
export type FanslyWireHost = "api" | "cdn" | "ws";

/** A route that takes no parameters. */
export type FanslyWireNoParams = Record<string, never>;

/** Epoch milliseconds. Parameters are JSON (they are stored with the attempt),
 *  so instants travel as numbers, never as `Date`. */
export type EpochMs = number;

/** Parameters of every route, by wire id. Only what varies per request is a
 *  parameter; the values the app always sends (page sizes, sort orders,
 *  present-and-empty filters) are part of the spec. */
export interface FanslyWireParamsById {
  "account.me": FanslyWireNoParams;
  "accounts.by_ids": { ids: readonly string[] };
  "messaging.groups": { offset: number };
  "group.detail": { groupId: string };
  "messages.page": { groupId: string; before: string | null };
  "transactions.page": { limit: number; offset: number };
  "earnings.accounts": { afterMs: EpochMs; beforeMs: EpochMs };
  "earnings.stats_accounts": { correlationAccountId: string; afterMs: EpochMs; beforeMs: EpochMs };
  "earnings.monthly_accounts": { correlationAccountId: string; afterMs: EpochMs; beforeMs: EpochMs };
  "media.order_history": {
    target: { kind: "media" | "bundle"; id: string };
    before: string | null;
  };
  "payouts.methods": FanslyWireNoParams;
  "payouts.requests": { offset: number };
  "subscribers.page": { status: FanslySubscribersStatus; offset: number };
  "followers.page": { accountId: string; offset: number };
  "notifications.page": { before: string; types: readonly number[] | null };
  "posts.timeline": { accountId: string; before: string };
  "posts.tips": { targetIds: readonly string[] };
  "posts.by_ids": { ids: readonly string[] };
  "post.replies": { postId: string; before: string | null };
  "vault.albums": FanslyWireNoParams;
  "uservault.albums": { accountId: string };
  "subscriptions.tiers": FanslyWireNoParams;
  "subscriptions.giftcodes": FanslyWireNoParams;
  "message.automated": FanslyWireNoParams;
  "account.walls": FanslyWireNoParams;
  "vault.media": { albumId: string; before: string };
  "account.media_by_ids": { ids: readonly string[] };
  "account.bundles_by_ids": { ids: readonly string[] };
  "media.offer_stats": { mediaOfferId: string; beforeMs: EpochMs; afterMs: EpochMs; periodMs: number };
  "account.stats": {
    beforeMs: EpochMs;
    afterMs: EpochMs;
    periodMs: number;
    /** The named-month form: calendar year and month 1–12; both 0 = the bounds. */
    year?: number;
    month?: number;
  };
  "earnings.stats_window": { beforeMs: EpochMs; afterMs: EpochMs; limit: number };
  "earnings.monthly": { beforeMs: EpochMs | null; afterMs: EpochMs | null };
  "trackinglinks": FanslyWireNoParams;
  "discovery.suggestions": { limit: number; offset: number };
  "broadcast.stats": { before: string | null };
  "broadcast.stats_deleted": { before: string | null };
  "broadcast.scheduled": FanslyWireNoParams;
  "polls": FanslyWireNoParams;
  "recapstats": FanslyWireNoParams;
  /** The socket's HTTP Upgrade: the page's socket owner sends it. */
  "ws.upgrade": FanslyWireNoParams;
  /** One hop of a CDN download (0 = the signed URL, 1–2 = redirects). The URL
   *  itself is never a parameter: it is the work's secret (design J7). */
  "cdn.media": { hop: number };
}

export type FanslyWireId = keyof FanslyWireParamsById;
export type FanslyWireParams<I extends FanslyWireId> = FanslyWireParamsById[I];

/** `/subscribers` status filters: active (3,4) and expired (5). */
export type FanslySubscribersStatus = "3,4" | "5";

/** `/account/me` as its contract accepts it: the served object, with the two
 *  counters typed as what the contract proves (absent, null, or a count). */
export interface FanslyAccountMe {
  account: Omit<FanslyAccountMeResponse["account"], "followCount" | "subscriberCount"> & {
    followCount?: number | null;
    subscriberCount?: number | null;
  };
}

/** `/subscribers`: the subscriptions and the total that matches the status
 *  filter of the request. */
export interface FanslySubscribersPageContract {
  total: number;
  totalActive: number | null;
  totalExpired: number | null;
  subscriptions: FanslySubscriber[];
}

/** `/account/wallets/earnings/transactions` with every item accepted. */
export interface FanslyTransactionsPageContract {
  total: number;
  data: FanslyEarningsTransaction[];
}

/** The WebSocket Upgrade's answer (`ws.upgrade`): 101 opened the socket. */
export interface FanslyWsUpgradeAnswer {
  status: number;
}

/**
 * One CDN hop's answer (`cdn.media`), read by its status — the bytes of a
 * 2xx, the next hop of a 3xx, or the status alone. It lives in memory only and
 * is never journaled: `location` can be a signed URL and `body` is chat media
 * (design J7; owner decision №17 — the bytes cross to the describer through
 * the transient handoff buffer, they are not a captured fact).
 */
export interface FanslyCdnAnswer {
  status: number;
  contentType: string | null;
  /** A 3xx's `Location` as served (relative or absolute); null otherwise. */
  location: string | null;
  /** The body of a 2xx as received; null for any other status, and when it
   *  passed the byte cap (`tooLarge`). */
  body: Buffer | null;
  /** The body passed the byte cap (declared or while streaming): not read to
   *  the end. */
  tooLarge: boolean;
}

/** The answer of a route the spec opts into reading as "nothing here" (a 204,
 *  or an ok response with an empty body). Journaled as is. */
export interface FanslyEmptyResponse {
  __empty: true;
  httpStatus: number;
}

/** What each route's contract yields. `unknown` = the route is journaled
 *  before anything asserts on it; its lane predicate (apps/runtime) decides. */
export interface FanslyWireResultById {
  "account.me": FanslyAccountMe;
  "accounts.by_ids": FanslyAccount[];
  "messaging.groups": FanslyMessagingGroupsPage;
  "group.detail": FanslyGroupDetail;
  "messages.page": FanslyMessagesPage;
  "transactions.page": FanslyTransactionsPageContract;
  "earnings.accounts": FanslyEarningsAccount[];
  "earnings.stats_accounts": unknown;
  "earnings.monthly_accounts": unknown;
  "media.order_history": unknown;
  "payouts.methods": unknown;
  "payouts.requests": unknown;
  "subscribers.page": FanslySubscribersPageContract;
  "followers.page": FanslyFollowersPage;
  "notifications.page": unknown;
  "posts.timeline": FanslyPostsPage;
  "posts.tips": unknown;
  "posts.by_ids": FanslyPostsPage;
  "post.replies": unknown;
  "vault.albums": unknown;
  "uservault.albums": unknown;
  "subscriptions.tiers": unknown;
  "subscriptions.giftcodes": unknown;
  "message.automated": unknown;
  "account.walls": unknown;
  "vault.media": unknown;
  "account.media_by_ids": unknown;
  "account.bundles_by_ids": unknown;
  "media.offer_stats": unknown;
  "account.stats": unknown;
  "earnings.stats_window": unknown;
  "earnings.monthly": unknown;
  "trackinglinks": unknown;
  "discovery.suggestions": unknown;
  "broadcast.stats": unknown;
  "broadcast.stats_deleted": unknown;
  "broadcast.scheduled": unknown;
  "polls": unknown;
  "recapstats": unknown;
  "ws.upgrade": FanslyWsUpgradeAnswer;
  "cdn.media": FanslyCdnAnswer;
}
export type FanslyWireResult<I extends FanslyWireId> = FanslyWireResultById[I];

export interface FanslyContractViolation {
  /** The first field that failed (`account.id`, `data[3].createdAt`, …). */
  field: string;
  detail: string;
}

export type FanslyContractResult<R> =
  | { ok: true; value: R }
  | { ok: false; violation: FanslyContractViolation };

/**
 * What a request of a spec may carry (arena "vanished chat" R5, plan §7):
 *   - `session` — a page's route: the page's actor sends it under the page's
 *     session context, through the page's egress (`buildFanslyWireRequest`
 *     puts the session's headers on every API request; the socket's Upgrade
 *     and a CDN hop ride the same page). Every spec of `FANSLY_WIRE_SPECS`.
 *   - `none` — nothing of any session: no authorization, no session or client
 *     id, no client check, no cookie. Only the session-less public account
 *     reader's routes (`FANSLY_PUBLIC_WIRE_SPECS`, `wire/public.ts`), built by
 *     `buildFanslyPublicWireRequest` alone and sent through the public
 *     reader's own egress, never a page's.
 * Each builder refuses the other's specs before anything is built or sent.
 */
export type FanslyWireCredentials = "session" | "none";

export interface FanslyWireSpec<P, R> {
  readonly id: FanslyWireId;
  /** A page's route: always `session` (`FanslyWireCredentials`). */
  readonly credentials: "session";
  /** The observation kind the answer is journaled under; null for a route
   *  whose answer is never journaled (`capture`). */
  readonly kind: FanslyObservationKind | null;
  readonly host: FanslyWireHost;
  /**
   * A route whose answer is NOT journaled as an observation, read by its
   * status instead of the API envelope: `none` — nothing worth keeping (the
   * WebSocket Upgrade: the connection row is the record); `bytes` — a body the
   * resource hands on in memory (a CDN file). Absent for every API route.
   */
  readonly capture?: "none" | "bytes";
  /** The route with its path parameters named, as the legacy journal wrote it. */
  readonly endpointTemplate: string;
  /** The operation the legacy adapter journaled this route under
   *  (`sync_http_attempts.operation`, `fansly_send_log.operation`), so legacy
   *  volume maps onto wire ids. */
  readonly legacyOperation: string;
  path(params: P): string;
  /** The query, in the order the app sends it; `ngsw-bypass=true` is added by
   *  the request builder. A key that is absent is omitted; an empty string is
   *  sent present-and-empty — they are different requests. */
  query(params: P): Readonly<Record<string, string>>;
  /** Statuses this route answers with an empty body that mean "nothing here". */
  readonly emptyStatuses?: readonly number[];
  /** A 5xx carrying a well-formed Fansly error envelope is this route's own
   *  final answer (no `Retry-After`), not a wire failure. */
  readonly finalServerErrorEnvelope?: boolean;
  /** The contract over the envelope's `response` (or the empty marker). */
  parse(response: unknown, params: P): FanslyContractResult<R>;
}

export type FanslyWireSpecFor<I extends FanslyWireId> =
  FanslyWireSpec<FanslyWireParams<I>, FanslyWireResult<I>> & { readonly id: I };

/** The part of a spec an answer is read against (`readFanslyWireResponse`):
 *  a page's spec and a public one alike. */
export type FanslyWireReadSpec<P, R> = Pick<
  FanslyWireSpec<P, R>,
  "capture" | "emptyStatuses" | "finalServerErrorEnvelope" | "parse"
>;

/** One physical request, ready to send. Built per send: the headers carry the
 *  client timestamp of this request. */
export interface FanslyWireRequest {
  spec: FanslyWireId;
  url: string;
  headers: Record<string, string>;
  /** Total budget of the call: connect and proxy tunnel, headers and the
   *  whole body. */
  timeoutMs: number;
  /** The digest (sha256 hex, not a secret) of the credentials the request
   *  carries — the page's stored session and proxy, or an identity check's
   *  candidate. Journaled with the attempt; an auth hold is keyed on it. */
  credentialsGeneration?: string;
}

/** The send hooks of one admission. `check` runs synchronously at undici's
 *  `onRequestStart`, immediately before the request headers are written; a
 *  refusal aborts the dispatch and writes nothing. */
export interface FanslyWireSendHooks {
  check: FanslySendCheck;
}

/** How a send ended. `sent` / `sendMark` say whether bytes left for Fansly:
 *  `request_start` = the check passed at `onRequestStart`; `completion_fallback`
 *  = a response came back without that mark (no such path exists on undici
 *  dispatchers; the completion instant is then the safe upper bound).
 *  Before `onRequestStart`: the budget running out is a `timeout` with
 *  `sent: false` (the transport never became ready), the caller's cancel is
 *  `aborted_before_send` / `lease_inactive`, and a refusal of the check is
 *  `aborted_before_send` with its reason. */
export type FanslyWireOutcome =
  | {
    kind: "response";
    status: number;
    headers: Record<string, string>;
    /** The body, content-decoded as the browser would, as UTF-8 text. */
    bodyText: string;
    /** Bytes of the body as received, before content decoding. */
    bodyBytes: number;
    sendMark: "request_start" | "completion_fallback";
    /** The decoded body itself: `capture: 'bytes'` routes only (a CDN file),
     *  whose body is not text. */
    bodyBuffer?: Buffer;
    /** `capture: 'bytes'` only: the body passed the call's byte cap (declared
     *  or while streaming) and was not read to the end. */
    bodyOverflow?: boolean;
  }
  | { kind: "transport_error" | "timeout"; sent: boolean; message: string }
  | { kind: "aborted_before_send"; refusal: FanslySendRefusalReason };
