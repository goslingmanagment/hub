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
  | "account_lists"
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
  | "creator_stats_active_hours"
  | "creator_stats_fan"
  | "creator_stats_fans_top"
  | "creator_stats_geo"
  | "creator_stats_media"
  | "creator_stats_media_benchmarks"
  | "creator_stats_media_shown"
  | "creator_stats_media_top"
  | "creator_stats_posts"
  | "creator_stats_series"
  | "creator_stats_stream_session"
  | "creator_stats_stream_tips"
  | "creator_stats_streams"
  | "creator_stats_summary"
  | "creator_stats_tags"
  | "discovery_feed"
  | "dm_conversations"
  | "dm_messages"
  | "earnings_accounts"
  | "earnings_monthlystats_snapshot"
  | "earnings_stats_snapshot"
  | "earnings_transactions"
  | "fan_earnings_monthly"
  | "fan_earnings_stats"
  | "fan_earnings_transactions"
  | "followers"
  | "gift_codes"
  | "group_detail"
  | "list_items"
  | "lists_add"
  | "lists_create"
  | "lists_remove"
  | "media_offer_stats"
  | "notifications"
  | "payout_methods"
  | "payout_requests"
  | "polls"
  | "post_replies"
  | "post_tips"
  | "posts"
  | "posts_scheduled"
  | "media_stories"
  | "publish_account_media"
  | "publish_account_media_bundle"
  | "publish_post"
  | "publish_post_cancel"
  | "publish_post_delete"
  | "publish_story"
  | "publish_upload_complete"
  | "publish_upload_create"
  | "publish_upload_status"
  | "publish_vault_album_create"
  | "publish_vault_album_media"
  | "purchase_history"
  | "recapstats"
  | "subscribers"
  | "subscription_tiers"
  | "tracking_links"
  | "uservault_albums"
  | "vault_albums"
  | "vault_media";

/** Where a spec is sent: the API (`fanslyBaseUrl`), the upload API
 *  (`FANSLY_UPLOAD_BASE_URL`, mediav2: a publication's file, wall posts PR 6),
 *  a media CDN host (the signed URL of a chat file, step 3), the WebSocket
 *  host (the Upgrade that opens the page's socket, step 3) or the storage an
 *  upload's part goes to (the signed URL its create's answer named, wall
 *  posts PR 8). Only the two APIs have a path of their own and journal their
 *  answer. */
export type FanslyWireHost = "api" | "upload" | "cdn" | "ws" | "storage";

/** The method of a route: every read is a GET (the Upgrade too); the
 *  publishing routes (wall posts PR 6) are POSTs with a JSON body, and a
 *  part of an upload (PR 8) a PUT of the file's bytes. */
export type FanslyWireMethod = "GET" | "POST" | "PUT";

/**
 * Who a publication's attachment is for, as Hub decides it (spec §5; the
 * contract §3): every viewer (a FYP post); the subscribers — of every tier
 * (`tiers` empty: a subscriber post with no tier named, a story), or of each
 * tier named, with its name as the site sends it — and, with `priceMills`,
 * whoever else pays it (a subscriber post anyone may buy); or whoever pays
 * `priceMills` (a paid post). Mills, 1000 = $1, as every amount in Hub.
 */
export type FanslyPublishAudience =
  | { kind: "everyone" }
  | { kind: "subscribers"; tiers: ReadonlyArray<{ id: string; name: string }>; priceMills: number | null }
  /** `subscribers`: only they buy it — of each tier named, or of every tier
   *  (empty); null: anyone buys it. */
  | { kind: "price"; priceMills: number; subscribers: ReadonlyArray<{ id: string; name: string }> | null };

/** Who may reply to a post besides the model (the contract §12.4). */
export type FanslyReplyLock = "followers" | "subscribers";

/** One file of an attachment: its media, and its own preview's media (a
 *  paid file's, contract §3; null: none). */
export interface FanslyPublishMedia {
  mediaId: string;
  previewId: string | null;
}

/** One attachment of a post: an account media (`contentType` 1) or a bundle (2). */
export interface FanslyPublishAttachment {
  contentId: string;
  contentType: 1 | 2;
  pos: number;
}

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
  /** The page's own user lists (`GET /lists/account?itemId=`). */
  "lists.account": FanslyWireNoParams;
  /** One page of a list's members, after the last one read (`sortId`). */
  "lists.items": { listId: string; after: string | null };
  "posts.timeline": { accountId: string; before: string };
  "posts.tips": { targetIds: readonly string[] };
  "posts.by_ids": { ids: readonly string[] };
  "posts.scheduled": FanslyWireNoParams;
  /** The account's stories (`GET /mediastoriesnew?accountId=`, the contract §7). */
  "stories.list": { accountId: string };
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
  // The creator statistics pages of 2026-10 (`/account/stats/*`,
  // reference/fansly-creator-stats). Every window is a pair of UTC day
  // buckets, both included; the server rounds other instants to the day and
  // shortens a span past its cap without an error (it echoes the bounds).
  "stats.summary": FanslyStatsWindow;
  "stats.series": FanslyStatsWindow & { family: FanslyStatsSeriesFamily; granularity: FanslyStatsGranularity };
  "stats.media_top": FanslyStatsWindow & {
    source: FanslyStatsSource;
    /** 1 = images, 2 = videos; null = both (the key is then not sent). */
    mediaType: 1 | 2 | null;
    orderBy: FanslyStatsMediaOrder;
    limit: number;
  };
  /** `source` -1 = every surface, with per-surface daily rows but no totals,
   *  retention, tags or hours. */
  "stats.media": FanslyStatsWindow & { mediaOfferId: string; source: FanslyStatsSource | -1 };
  "stats.media_benchmarks": FanslyStatsWindow & { source: FanslyStatsSource };
  /** `endMs` 0 = the current hour. */
  "stats.media_shown": { endMs: EpochMs; hours: number };
  "stats.geo": FanslyStatsWindow & { source: FanslyStatsSource; limit: number };
  /** `timezoneOffsetMinutes` = minutes east of UTC (UTC+3 is 180). */
  "stats.active_hours": FanslyStatsWindow & { source: FanslyStatsSource; timezoneOffsetMinutes: number };
  /** `kind` 1 = tags viewers browsed by, 2 = tags of posts. */
  "stats.tags": FanslyStatsWindow & { source: FanslyStatsSource; kind: 1 | 2; limit: number };
  "stats.posts": FanslyStatsWindow & { postIds: readonly string[] };
  "stats.fans_top": FanslyStatsWindow & { orderBy: FanslyStatsFanOrder; limit: number };
  "stats.fan": FanslyStatsWindow & { fanId: string; granularity: "day" | "month" };
  /** The live streams of a window (the Streams tab of 2026-10-21). The bounds
   *  are instants: the app sends the window's first UTC day and the day after
   *  its last. `light` asks for the sessions without their detail (the
   *  summary tiles and the "last stream" card); the tab itself sends none. */
  "stats.streams": { afterMs: EpochMs; beforeMs: EpochMs; limit: number; light: boolean };
  /** One stream: the session, its viewer curve by minute, top tippers and chatters. */
  "stats.stream_session": { sessionId: string };
  /** One stream's tips, newest first, paged by the last tip id held (null:
   *  the first page). */
  "stats.stream_tips": { sessionId: string; beforeTipId: string | null; limit: number };
  /** One supporter's transactions. The bounds are instants in milliseconds
   *  (not transaction ids, unlike `transactions.page`); `cursor` is "0" for
   *  the first page, then the answer's `nextCursor`. */
  "earnings.transactions_account": {
    correlationAccountId: string;
    beforeMs: EpochMs;
    afterMs: EpochMs;
    cursor: string;
    limit: number;
  };
  /** The socket's HTTP Upgrade: the page's socket owner sends it. */
  "ws.upgrade": FanslyWireNoParams;
  /** One hop of a CDN download (0 = the signed URL, 1–2 = redirects). The URL
   *  itself is never a parameter: it is the work's secret (design J7). */
  "cdn.media": { hop: number };
  // ── publishing (wall posts PR 6): POSTs, `writeContract: "unverified"` ─────
  // The parameters are what Hub decides; the body each spec builds of them
  // follows the FBuddy map (docs/plans/project-browser/fbuddy/
  // 02-operations-and-media.md) until the stand's capture
  // (fansly-publish-contract.md, session 0.2) confirms or corrects it.
  /** An upload begun (mediav2): the file's size, type and name. */
  "publish.upload_create": {
    fileSize: number;
    mimeType: string;
    fileName: string;
    /** Into the vault alone, as the site's "Upload to Vault" sends it
     *  (`uploadFormData: null`, the contract §2, §13) — a vault album's file. */
    vault?: boolean;
  };
  /** An upload's parts done: the upload, its part size and each part's ETag. */
  "publish.upload_complete": {
    uploadId: string;
    uploadType: number;
    partSize: number;
    parts: ReadonlyArray<{ index: number; eTag: string }>;
  };
  /** Account media of uploaded or vault media, for one audience. */
  "publish.account_media": { media: readonly FanslyPublishMedia[]; audience: FanslyPublishAudience };
  /** A bundle of several files for one audience (the contract §3: the site
   *  makes one whenever a post has more than one file), each with its own
   *  preview. */
  "publish.account_media_bundle": {
    media: readonly FanslyPublishMedia[];
    audience: FanslyPublishAudience;
  };
  /** A post: now (`scheduledForMs` 0) or into Fansly's own schedule. */
  "publish.post": {
    content: string;
    attachments: readonly FanslyPublishAttachment[];
    scheduledForMs: EpochMs;
    /** The post's end (absolute); 0 = it never expires. */
    expiresAtMs: EpochMs;
    wallIds: readonly string[];
    fyp: boolean;
    /** The walls it is pinned on (none: not pinned). */
    pinWallIds: readonly string[];
    /** Who may reply, any of them (none: everyone). */
    replyLock: readonly FanslyReplyLock[];
  };
  /** A story of one account media. */
  "publish.story": { contentId: string; contentType: 1 | 2 };
  /** A scheduled post taken off Fansly's schedule. */
  "publish.post_cancel": { postId: string };
  /** A published post deleted from the wall (the contract §5). */
  "publish.post_delete": { postId: string };
  /** A vault album created with its title (the contract §13). */
  "publish.vault_album_create": { title: string };
  /** Media added to a vault album in one request: the album shows the last
   *  of the list first (the contract §13). */
  "publish.vault_album_media": { albumId: string; mediaIds: readonly string[] };
  // ── the page's user lists Hub keeps (fan set lists, 2026-10-28) ───────────
  /** A user list of the page created with its label (no description). */
  "lists.create": { label: string };
  /** Accounts added to one list of the page (their Fansly account ids). */
  "lists.add": { listId: string; accountIds: readonly string[] };
  /** Accounts removed from one list of the page. */
  "lists.remove": { listId: string; accountIds: readonly string[] };
  // ── an upload's bytes (wall posts PR 8) ───────────────────────────────────
  /**
   * One part of an upload: a PUT of the file's bytes `[byteOffset,
   * byteOffset + byteLength)` to the storage URL the upload's create named
   * for part `partIndex`. The URL is signed: it is never a parameter — the
   * create's command keeps it sealed (`uploadCommandId`) and the page's
   * transport opens it right before the send; `host` and `path` (no query)
   * are what the request's fingerprint covers, with the part's sha256.
   */
  "publish.upload_part": {
    uploadCommandId: number;
    partIndex: number;
    host: string;
    path: string;
    fileId: number;
    byteOffset: number;
    byteLength: number;
    partSha256: string;
  };
  /** An upload as Fansly holds it (mediav2 `GET /media/upload/{id}`): its
   *  processing, and the media it became. */
  "publish.upload_status": { uploadId: string };
}

export type FanslyWireId = keyof FanslyWireParamsById;
export type FanslyWireParams<I extends FanslyWireId> = FanslyWireParamsById[I];

/** The window of a statistics route: the first and the last UTC day, both included. */
export interface FanslyStatsWindow {
  afterMs: EpochMs;
  beforeMs: EpochMs;
}

/** A surface of the statistics pages: 0 For You, 1 Timeline, 4 Other. (2 and 3
 *  exist in profile-visit answers; as a filter the server treats them as 0.) */
export type FanslyStatsSource = 0 | 1 | 4;
export type FanslyStatsSeriesFamily = "views" | "profile" | "follows" | "subscriptions" | "revenue";
export type FanslyStatsGranularity = "hour" | "day" | "month";
export type FanslyStatsMediaOrder = "views" | "uniqueViewers" | "watchMs" | "completedViews" | "watchLift";
export type FanslyStatsFanOrder = "netMills" | "grossMills" | "transactions";

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

/**
 * A storage's receipt of one part of an upload (`publish.upload_part`, wall
 * posts PR 8), read by its status and its `ETag` — the bytes were Hub's own,
 * so nothing of the answer is platform data: it is never journaled, and the
 * part's command keeps the ETag.
 */
export interface FanslyStorageReceipt {
  status: number;
  eTag: string | null;
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
  "lists.account": unknown;
  "lists.items": unknown;
  "posts.timeline": FanslyPostsPage;
  "posts.tips": unknown;
  "posts.by_ids": FanslyPostsPage;
  "posts.scheduled": unknown;
  "stories.list": unknown;
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
  "stats.summary": unknown;
  "stats.series": unknown;
  "stats.media_top": unknown;
  "stats.media": unknown;
  "stats.media_benchmarks": unknown;
  "stats.media_shown": unknown;
  "stats.geo": unknown;
  "stats.active_hours": unknown;
  "stats.tags": unknown;
  "stats.posts": unknown;
  "stats.fans_top": unknown;
  "stats.fan": unknown;
  "stats.streams": unknown;
  "stats.stream_session": unknown;
  "stats.stream_tips": unknown;
  "earnings.transactions_account": unknown;
  "ws.upgrade": FanslyWsUpgradeAnswer;
  "cdn.media": FanslyCdnAnswer;
  // Publishing: journaled first (`publish_*` kinds), read by the command's
  // apply, whose own reader takes the ids it needs (the shapes are the
  // stand's to confirm).
  "publish.upload_create": unknown;
  "publish.upload_complete": unknown;
  "publish.account_media": unknown;
  "publish.account_media_bundle": unknown;
  "publish.post": unknown;
  "publish.story": unknown;
  "publish.post_cancel": unknown;
  "publish.post_delete": unknown;
  "publish.vault_album_create": unknown;
  "publish.vault_album_media": unknown;
  "lists.create": unknown;
  "lists.add": unknown;
  "lists.remove": unknown;
  "publish.upload_part": FanslyStorageReceipt;
  "publish.upload_status": unknown;
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
 *   - `session` — a page's route: the page's actor sends it through the
 *     page's own browser, under its live session. Every spec of
 *     `FANSLY_WIRE_SPECS`.
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
   * resource hands on in memory (a CDN file); `receipt` — a storage's
   * receipt of a part Hub uploaded, its status and `ETag` (the part's command
   * is the record). Absent for every API route.
   */
  readonly capture?: "none" | "bytes" | "receipt";
  /** The route with its path parameters named, as the legacy journal wrote it. */
  readonly endpointTemplate: string;
  /** The operation the legacy adapter journaled this route under
   *  (`sync_http_attempts.operation`, `fansly_send_log.operation`), so legacy
   *  volume maps onto wire ids. Null for a route no legacy sender ever read:
   *  the send log holds nothing to map. */
  readonly legacyOperation: string | null;
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
  /** A write (wall posts PR 6): `POST`, with `body`; a part of an upload
   *  (PR 8): `PUT` of the file's bytes, by reference. Absent: a GET. */
  readonly method?: "POST" | "PUT";
  /** A write's JSON body, built of its parameters (`buildFanslyWireBody`
   *  serializes it). Required with `POST`, absent otherwise: a `PUT`'s bytes
   *  are a file's, sent by reference (`describeFanslyPart`). */
  body?(params: P): unknown;
  /**
   * A write's contract: `unverified` until the stand's capture of the site's
   * own requests (docs/plans/2026-10-23-wall-posts/fansly-publish-contract.md)
   * confirms its path, body and answer — the engine sends no write whose
   * contract is unverified (`isFanslyWriteSendable`). Required with `method`.
   */
  readonly writeContract?: "unverified" | "verified";
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
  /** Absent: a GET (every read). A write is a `POST` with `body`. */
  method?: FanslyWireMethod;
  url: string;
  headers: Record<string, string>;
  /** A write's body, the exact bytes it sends (JSON text). */
  body?: string;
  /** A write's fingerprint (`fanslyWriteFingerprint`: method, host, path and
   *  query, the body's sha256), recorded on its command before the send: the
   *  page's browser lets go only a request that matches it (PR 7). */
  writeFingerprint?: string;
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
 *  dispatchers; the completion instant is then the safe upper bound);
 *  `transport_reported` = a sender outside the process (a page's browser)
 *  reported when the request left, `sentMono` on the caller's monotonic clock.
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
    sendMark: "request_start" | "completion_fallback" | "transport_reported";
    /** `transport_reported` only: when the request left, as its sender
     *  reported it, on the caller's monotonic clock (`Clock.monoNow`). */
    sentMono?: number;
    /** The answer is not the server's confirmed word (a page's browser: its
     *  cache nobody revalidated, the site's service worker): kept in the
     *  journal as a rejected answer, never applied as a refresh. */
    unconfirmed?: "cache_unconfirmed" | "service_worker";
    /** The decoded body itself: `capture: 'bytes'` routes only (a CDN file),
     *  whose body is not text. */
    bodyBuffer?: Buffer;
    /** `capture: 'bytes'` only: the body passed the call's byte cap (declared
     *  or while streaming) and was not read to the end. */
    bodyOverflow?: boolean;
  }
  | {
    kind: "transport_error" | "timeout";
    sent: boolean;
    message: string;
    /** With `sent`: when the request left, as a sender outside the process
     *  reported it (the caller's monotonic clock); absent — the completion
     *  instant stands for it (the safe upper bound). */
    sentMono?: number;
  }
  | { kind: "aborted_before_send"; refusal: FanslySendRefusalReason };
