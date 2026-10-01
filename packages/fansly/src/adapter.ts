import { randomUUID } from "node:crypto";

import { fetch, type Dispatcher } from "undici";

import {
  assertHttpRequestActive,
  buildProxyEgressKey,
  buildProxyDispatcherCacheKey,
  classifyTransportError,
  createProxyRequestDispatcher,
  createRequestDispatcher,
  executeObservedRequest,
  exponentialRetryDelayMs,
  getHttpRequestSignal,
  MAX_RETRY_DELAY_MS,
  millsFromInteger,
  parseRetryAfterInstant,
  sanitizeError,
  redactSensitiveText,
  resolveRetryDelayMs,
  waitForHttpRequestDelay,
  waitForHttpRequestPermit,
  type ProxyConfig,
} from "@agency_hub_core/shared";

import { FanslyApiError, FanslyProxyMissingError } from "./errors.ts";
import { buildFanslyRequestHeaders } from "./request-headers.ts";
import {
  findFanslySendRefusal,
  type FanslySendCompletionOutcome,
  type FanslySendLease,
} from "./send-guard.ts";
import {
  isFanslyErrorEnvelope,
  parseFanslyEnvelope,
  parseFanslyFollowersPage,
  parseFanslyMessagesPage,
  parseFanslyMessagingGroupsPage,
  parseFanslySubscribersPage,
  parseFanslyTransactionsPage,
  type FanslyEnvelope,
} from "./wire/contracts.ts";
import {
  ACCOUNT_MEDIA_BATCH_SIZE,
  PAYOUT_REQUESTS_PAGE_SIZE,
  PAYOUT_REQUESTS_UNBOUNDED,
  POST_BATCH_SIZE,
  POST_REPLIES_EMPTY_STATUSES,
  VAULT_MEDIA_HEAD_CURSOR,
} from "./wire/specs.ts";
import type {
  FanslyAccount,
  FanslyAccountList,
  FanslyAccountListsResponse,
  FanslyAccountMeResponse,
  FanslyEarningsAccount,
  FanslyEarningsAccountsPageResponse,
  FanslyEarningsOverview,
  FanslyEarningsOverviewResponse,
  FanslyGroupDetail,
  FanslyListItem,
  FanslyListItemsPageResponse,
  FanslyMessagesPageResponse,
  FanslyMessagingGroupsPageResponse,
  FanslyPostsPage,
  FanslyPostsPageResponse,
  FanslyPostTip,
  FanslyPostTipsResponse,
  FanslyRequestContext,
  FanslyTrackingLink,
  FanslyTrackingLinksResponse,
} from "./types.ts";

interface AdapterOptions {
  baseUrl: string;
}

type RequestResult<T> = {
  parsed: T;
  raw: T;
};

const REQUEST_TIMEOUT_MS = 30_000;
/** How much of Fansly's `error.details` an error message carries. The whole
 *  body stays in `responseSnippet`. */
const ERROR_DETAILS_MAX_CHARS = 200;
const EARNINGS_ACCOUNTS_PAGE_LIMIT = 100;
// The wire facts of these routes live with their specs; the adapter sends
// the same values and keeps exporting them under the same names.
export {
  ACCOUNT_MEDIA_BATCH_SIZE,
  PAYOUT_REQUESTS_PAGE_SIZE,
  PAYOUT_REQUESTS_UNBOUNDED,
  POST_BATCH_SIZE,
  POST_REPLIES_EMPTY_STATUSES,
  VAULT_MEDIA_HEAD_CURSOR,
};

/**
 * Response summary for a route whose shape is NOT yet known (the WP-F9 / [E1]
 * liveness probes). Records enough to tell "did this answer, and with what" apart
 * from "this route is dead", without asserting a contract we have no evidence for.
 *
 * Field NAMES only, never values: this lands in `sync_http_attempts.response_shape`,
 * which is queryable operational state, and an unknown route may return anything.
 * The verbatim body is journaled separately under the capture-first rule; that is
 * where the values belong.
 */
function summarizeUnknownResponse(parsed: unknown): Record<string, unknown> {
  if (Array.isArray(parsed)) {
    const first = parsed[0];
    return {
      responseKind: "array",
      returnedItems: parsed.length,
      itemKeys: isRecord(first) ? Object.keys(first).sort().slice(0, 40) : null,
    };
  }

  if (isRecord(parsed)) {
    const keys = Object.keys(parsed).sort();
    // The house envelope is `{total, data[]}`; surface it when it is there so the
    // probe report can say "paginated list" rather than just "object".
    const data = parsed.data;
    return {
      responseKind: "object",
      objectKeys: keys.slice(0, 40),
      returnedItems: Array.isArray(data) ? data.length : null,
      total: typeof parsed.total === "number" ? parsed.total : null,
      itemKeys:
        Array.isArray(data) && isRecord(data[0]) ? Object.keys(data[0]).sort().slice(0, 40) : null,
    };
  }

  return {
    responseKind: parsed === null ? "null" : typeof parsed,
    returnedItems: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown) {
  return value === undefined || value === null || typeof value === "string";
}

function isNullableSafeInteger(value: unknown) {
  return value === undefined || value === null ||
    (typeof value === "number" && Number.isSafeInteger(value));
}

function isFanslyEarningsOverview(value: unknown): value is FanslyEarningsOverview {
  return isRecord(value) &&
    typeof value.pendingBalance === "number" &&
    Number.isSafeInteger(value.pendingBalance);
}

function isFanslyTrackingLink(value: unknown): value is FanslyTrackingLink {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    return false;
  }

  return [
    value.accountId,
    value.internalId,
    value.label,
    value.description,
    value.metadata,
  ].every(isNullableString) && [
    value.type,
    value.status,
    value.createdAt,
    value.clicks,
    value.claims,
    value.follows,
    value.subscriptions,
    value.totalNet,
    value.totalGross,
  ].every(isNullableSafeInteger);
}

function isFanslyTrackingLinks(value: unknown): value is FanslyTrackingLink[] {
  return Array.isArray(value) && value.every(isFanslyTrackingLink);
}

function isFanslyListItem(value: unknown): value is FanslyListItem {
  return isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isNullableString(value.sortId) &&
    isNullableString(value.listId) &&
    isNullableSafeInteger(value.type) &&
    isNullableString(value.metadata);
}

function isFanslyListItems(value: unknown): value is FanslyListItem[] {
  return Array.isArray(value) && value.every(isFanslyListItem);
}

function isFanslyAccountList(value: unknown): value is FanslyAccountList {
  return isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isNullableString(value.accountId) &&
    isNullableSafeInteger(value.pos) &&
    isNullableSafeInteger(value.type) &&
    isNullableString(value.label) &&
    isNullableSafeInteger(value.itemCount) &&
    (value.items === undefined || isFanslyListItems(value.items));
}

function isFanslyAccountLists(value: unknown): value is FanslyAccountList[] {
  return Array.isArray(value) && value.every(isFanslyAccountList);
}

export class FanslyAdapter {
  private readonly requestTimestamps = new Map<string, number>();
  private readonly rateLimitChains = new Map<string, Promise<void>>();
  private readonly proxyAgents = new Map<string, Dispatcher>();
  private readonly retiringDispatchers = new Set<Promise<void>>();
  private directDispatcher: Dispatcher = createRequestDispatcher();

  constructor(private readonly options: AdapterOptions) {}

  async close() {
    const activeDispatchers = [this.directDispatcher, ...this.proxyAgents.values()];
    const retiredDispatchers = Array.from(this.retiringDispatchers);

    this.proxyAgents.clear();
    this.retiringDispatchers.clear();

    await Promise.all([
      ...activeDispatchers.map((dispatcher) => dispatcher.close().catch(() => undefined)),
      ...retiredDispatchers,
    ]);
  }

  async getAccountMe(context: FanslyRequestContext) {
    return this.request<FanslyAccountMeResponse>(context, "/account/me", {
      operation: "account_me",
      endpointTemplate: "/account/me",
      category: "account",
      requestShape: {},
      summarizeResponse: (response) => ({
        accountId: response.account.id,
        followerCount: response.account.followCount,
        subscriberCount: response.account.subscriberCount,
      }),
    });
  }

  async getEarningsOverview(
    context: FanslyRequestContext,
  ): Promise<FanslyEarningsOverviewResponse> {
    const response = await this.request<unknown>(
      context,
      "/account/wallets/earnings",
      {
        operation: "earnings_overview",
        endpointTemplate: "/account/wallets/earnings",
        category: "transactions",
        requestShape: {},
        summarizeResponse: (parsed) => ({
          contractAccepted: isFanslyEarningsOverview(parsed),
        }),
      },
    );
    const parsed = isFanslyEarningsOverview(response.parsed) ? response.parsed : null;

    return {
      pendingBalanceMills: parsed === null
        ? null
        : millsFromInteger(parsed.pendingBalance),
      contractAccepted: parsed !== null,
      raw: response.raw,
    };
  }

  async getTrackingLinks(
    context: FanslyRequestContext,
  ): Promise<FanslyTrackingLinksResponse> {
    const response = await this.request<unknown>(context, "/trackinglinks", {
      operation: "tracking_links",
      endpointTemplate: "/trackinglinks",
      category: "account",
      requestShape: {},
      summarizeResponse: (parsed) => ({
        returnedItems: Array.isArray(parsed) ? parsed.length : null,
        contractAccepted: isFanslyTrackingLinks(parsed),
      }),
    });
    const parsed = isFanslyTrackingLinks(response.parsed) ? response.parsed : null;

    return {
      items: parsed ?? [],
      contractAccepted: parsed !== null,
      raw: response.raw,
    };
  }

  // ── WP-F1: the `stats_snapshot` lane ──────────────────────────────────────
  // Loosely typed `unknown` on purpose: the handler journals the body BEFORE
  // asserting anything about it (DP 7, the posts.ts journal-before-assert
  // pattern), so a shape assertion here would refuse bytes we are required to
  // keep. Every one of these goes through the same `request()` — same
  // `buildHeaders`, same per-page proxy, same 2.5 s + 100 ms pacing, and the
  // `ngsw-bypass=true` every URL already carries.

  /**
   * `/it/amoie/stats` — the account statistics response: profile datapoints,
   * account-media datapoints (where the VIDEO metrics actually live), the three
   * top-N planes, and the aggregation sidecars (media, bundles, tags, offer
   * locations).
   *
   * TWO FORMS, and the difference between them is where all this route's history
   * lives:
   *
   *   - `year = 0, month = 0` — the server reads `beforeDate`/`afterDate`, and
   *     it honours them ONLY INSIDE ITS OWN TRAILING WINDOW. Production
   *     2026-08-22 (lora-2) asked for `afterDate 2026-06-21 / beforeDate
   *     2026-07-22` and was served `dateAfter 2026-07-21 / dateBefore
   *     2026-08-21` — the trailing 31 days, 200 and all; halving the span to 15
   *     changed nothing. `datapointLimit: 100` was never the constraint.
   *   - `year`/`month` NON-ZERO — the server resolves the calendar month itself.
   *     This is the UI's "Jul / Jun / May 2026" preset, and the app sends the
   *     trailing bounds ALONGSIDE it unchanged: `beforeDate = now`,
   *     `afterDate = now − 30 d`, `period = 86 400 000` (bundle
   *     `main.pretty.js` :280600 and :196337). The bounds ride along ignored.
   *
   * So the caller supplies the bounds either way and adds `year`/`month` when it
   * wants a month; this method sends exactly what the client sends and nothing
   * clever of its own.
   */
  async getAccountStats(
    context: FanslyRequestContext,
    params: {
      beforeDate: Date;
      afterDate: Date;
      periodMs: number;
      /** Calendar year of the named-month form; 0 (the default) = use the bounds. */
      year?: number;
      /** 1–12 for the named-month form; 0 (the default) = use the bounds. */
      month?: number;
    },
  ): Promise<{ items: unknown; raw: unknown }> {
    const year = params.year ?? 0;
    const month = params.month ?? 0;
    const response = await this.request<unknown>(context, "/it/amoie/stats", {
      operation: "account_stats",
      endpointTemplate: "/it/amoie/stats",
      category: "account",
      query: {
        beforeDate: String(params.beforeDate.getTime()),
        afterDate: String(params.afterDate.getTime()),
        period: String(params.periodMs),
        year: String(year),
        month: String(month),
      },
      requestShape: {
        beforeDate: params.beforeDate.toISOString(),
        afterDate: params.afterDate.toISOString(),
        periodMs: params.periodMs,
        year,
        month,
      },
      summarizeResponse: summarizeUnknownResponse,
    });

    return { items: response.parsed, raw: response.raw };
  }

  /**
   * `/it/moie/statsnew` — per-media statistics. Added here with the rest of the
   * family; WP-F4's per-media lane is what calls it. Retroactive history is
   * confirmed (a July-2026 window returned data), and all six observed
   * responses carried SEVEN stat keys and no video fields at all — absence is a
   * property of this route, not of the asset ([E5] is what would settle why).
   */
  async getMediaOfferStats(
    context: FanslyRequestContext,
    params: { mediaOfferId: string; beforeDate: Date; afterDate: Date; periodMs: number },
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/it/moie/statsnew", {
      operation: "media_offer_stats",
      endpointTemplate: "/it/moie/statsnew",
      category: "media",
      query: {
        mediaOfferId: params.mediaOfferId,
        beforeDate: String(params.beforeDate.getTime()),
        afterDate: String(params.afterDate.getTime()),
        period: String(params.periodMs),
      },
      requestShape: {
        mediaOfferId: params.mediaOfferId,
        beforeDate: params.beforeDate.toISOString(),
        afterDate: params.afterDate.toISOString(),
        periodMs: params.periodMs,
      },
      // A 500 with Fansly's error envelope is this route's answer for a gone
      // item or a refused span, and a retry has never changed it.
      finalServerErrorEnvelope: true,
      summarizeResponse: summarizeUnknownResponse,
    });

    return { items: response.parsed, raw: response.raw };
  }

  /**
   * `/account/wallets/earnings/stats` — the revenue MIX: a flat array of
   * `{type, totalGross, totalNet, accountId, timestamp}`, one row per revenue
   * type per business day. The provider caps at `limit=100` but ignores
   * `offset`; the sync lane subdivides full windows at UTC day boundaries.
   *
   * Distinct from `/account/wallets/earnings/stats/accounts`, which is the
   * existing per-FAN `fan_earnings` lane and is not this.
   */
  async getEarningsStatsWindow(
    context: FanslyRequestContext,
    params: { before: Date; after: Date; limit?: number | null; offset?: number | null },
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/account/wallets/earnings/stats", {
      operation: "earnings_stats_window",
      endpointTemplate: "/account/wallets/earnings/stats",
      category: "transactions",
      query: {
        before: String(params.before.getTime()),
        after: String(params.after.getTime()),
        limit: params.limit != null ? String(params.limit) : undefined,
        offset: params.offset != null ? String(params.offset) : undefined,
      },
      requestShape: {
        before: params.before.toISOString(),
        after: params.after.toISOString(),
        limit: params.limit ?? null,
        offset: params.offset ?? null,
      },
      pagination: { limit: params.limit ?? null, offset: params.offset ?? null },
      summarizeResponse: summarizeUnknownResponse,
    });

    return { items: response.parsed, raw: response.raw };
  }

  /**
   * `/account/wallets/earnings/monthlystats` — per-month totals INCLUDING a
   * `year: 0, month: 0` rolling-rollup row, which is the creator's own
   * Statements header and is kept as a row like any other.
   *
   * The observed call carried `before`/`after`; both are optional here so the
   * caller can ask for all time. The UI's own window reached 2025-01, which is
   * where its `after` was set — NOT a demonstrated platform floor.
   */
  async getEarningsMonthlyStats(
    context: FanslyRequestContext,
    params?: { before?: Date | null; after?: Date | null },
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(
      context,
      "/account/wallets/earnings/monthlystats",
      {
        operation: "earnings_monthly_stats",
        endpointTemplate: "/account/wallets/earnings/monthlystats",
        category: "transactions",
        query: {
          before: params?.before ? String(params.before.getTime()) : undefined,
          after: params?.after ? String(params.after.getTime()) : undefined,
        },
        requestShape: {
          before: params?.before ? params.before.toISOString() : null,
          after: params?.after ? params.after.toISOString() : null,
        },
        summarizeResponse: summarizeUnknownResponse,
      },
    );

    return { items: response.parsed, raw: response.raw };
  }

  /**
   * `/contentdiscovery/media/suggestionsnew` — the discovery feed.
   *
   * The TAG COUNTERS are the payload we are here for: each suggestion carries
   * its `postTags[]` as full tag objects with PLATFORM-GLOBAL view/post counts,
   * which is a free tag-growth series. The suggestion rows themselves are a
   * SAMPLE and are labelled as one — never "the global FYP corpus".
   */
  async getDiscoveryMediaSuggestions(
    context: FanslyRequestContext,
    params: { limit?: number | null; before?: number | null; offset?: number | null },
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(
      context,
      "/contentdiscovery/media/suggestionsnew",
      {
        operation: "discovery_media_suggestions",
        endpointTemplate: "/contentdiscovery/media/suggestionsnew",
        category: "media",
        query: {
          before: String(params.before ?? 0),
          after: "0",
          tagIds: "",
          limit: params.limit != null ? String(params.limit) : undefined,
          offset: params.offset != null ? String(params.offset) : undefined,
        },
        requestShape: {
          before: params.before ?? 0,
          limit: params.limit ?? null,
          offset: params.offset ?? null,
        },
        pagination: { limit: params.limit ?? null, offset: params.offset ?? null },
        summarizeResponse: summarizeUnknownResponse,
      },
    );

    return { items: response.parsed, raw: response.raw };
  }

  /**
   * `/api/v1/notifications` — WP-F2's whole surface.
   *
   * THE CURSOR IS A NOTIFICATION ID, NOT A TIMESTAMP. `before=<id>` walks
   * BACKWARDS from that row; `before=0` is the head. Every page in the
   * 2026-08-19 capture carried 50 rows and the next call's `before` was the
   * oldest id of the previous page. Reading `before` as an epoch would ask for
   * notifications from 1970 and get an empty page that looks exactly like a
   * retention floor.
   *
   * `types` is OPTIONAL and that is deliberate (A1): the first call of every
   * poll goes UNFILTERED, because the filtered form can only ever return codes
   * we already know to ask for, and the unknown ones are the reason this lane
   * exists. The caller falls back to the client's full declared CSV — never the
   * eight-code UI CSV, which silently drops 32007 and 45012, both money.
   *
   * Loosely typed in and out for the same reason the WP-F1 calls are: the
   * handler journals the body BEFORE asserting anything about it.
   */
  async getNotificationsPage(
    context: FanslyRequestContext,
    params: { before?: string | null; after?: string | null; types?: readonly number[] | null },
  ): Promise<{ items: unknown; raw: unknown }> {
    const types = params.types ?? null;
    const response = await this.request<unknown>(context, "/notifications", {
      operation: "notifications_page",
      endpointTemplate: "/notifications",
      category: "account",
      query: {
        // "0" is the head, and it is what the UI itself sends first.
        before: params.before ?? "0",
        after: params.after ?? "0",
        // Omitted entirely on the unfiltered form — an empty `type=` is a
        // filter for nothing, not the absence of a filter.
        type: types !== null && types.length > 0 ? types.join(",") : undefined,
      },
      requestShape: {
        before: params.before ?? "0",
        after: params.after ?? "0",
        types: types === null ? null : [...types],
      },
      pagination: { cursorPresent: (params.before ?? "0") !== "0" },
      summarizeResponse: summarizeUnknownResponse,
    });

    return { items: response.parsed, raw: response.raw };
  }

  async getListsAccount(
    context: FanslyRequestContext,
    itemId: string | null = null,
  ): Promise<FanslyAccountListsResponse> {
    const normalizedItemId = itemId?.trim() || null;
    const response = await this.request<unknown>(context, "/lists/account", {
      operation: "lists_account",
      endpointTemplate: "/lists/account",
      query: {
        // Fansly uses the explicit empty value for the all-lists form.
        itemId: normalizedItemId ?? "",
      },
      category: "account",
      requestShape: {
        itemIdPresent: normalizedItemId !== null,
      },
      summarizeResponse: (parsed) => ({
        returnedItems: Array.isArray(parsed) ? parsed.length : null,
        contractAccepted: isFanslyAccountLists(parsed),
      }),
    });
    const parsed = isFanslyAccountLists(response.parsed) ? response.parsed : null;

    return {
      items: parsed ?? [],
      itemId: normalizedItemId,
      contractAccepted: parsed !== null,
      raw: response.raw,
    };
  }

  async getListItemsPage(
    context: FanslyRequestContext,
    params: {
      listId: string;
      limit?: number;
      after?: string | null;
      sortMode?: number;
    },
  ): Promise<FanslyListItemsPageResponse> {
    const listId = params.listId.trim();
    if (listId.length === 0) {
      throw new Error("Fansly list items request requires a list id");
    }
    const limit = params.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Fansly list items limit must be a safe integer between 1 and 100");
    }
    const sortMode = params.sortMode ?? 3;
    if (!Number.isSafeInteger(sortMode) || sortMode < 0) {
      throw new Error("Fansly list items sort mode must be a non-negative safe integer");
    }
    const after = params.after ?? null;
    if (after !== null && after.trim().length === 0) {
      throw new Error("Fansly list items cursor must be nonblank when supplied");
    }

    const response = await this.request<unknown>(context, "/lists/itemsnew", {
      operation: "list_items",
      endpointTemplate: "/lists/itemsnew",
      query: {
        listId,
        limit: String(limit),
        after: after ?? undefined,
        sortMode: String(sortMode),
      },
      category: "account",
      requestShape: {
        listIdPresent: true,
        limit,
        cursorPresent: after !== null,
        sortMode,
      },
      pagination: {
        limit,
        cursorPresent: after !== null,
      },
      summarizeResponse: (parsed) => ({
        returnedItems: Array.isArray(parsed) ? parsed.length : null,
        contractAccepted: isFanslyListItems(parsed),
      }),
    });
    const parsed = isFanslyListItems(response.parsed) ? response.parsed : null;

    return {
      items: parsed ?? [],
      listId,
      after,
      contractAccepted: parsed !== null,
      raw: response.raw,
    };
  }

  async getAccountsByIdsPage(context: FanslyRequestContext, ids: string[]) {
    if (ids.length > 100) {
      throw new Error("Fansly account lookup supports at most 100 ids per request");
    }

    return this.request<FanslyAccount[]>(context, "/account", {
      operation: "account_lookup",
      endpointTemplate: "/account",
      query: { ids: ids.join(",") },
      category: "account",
      requestShape: {
        idsCount: ids.length,
      },
      summarizeResponse: (response) => ({
        returnedItems: response.length,
      }),
    });
  }

  /**
   * Account timeline capture. The reverse-engineered contract names the path
   * parameter accountId while one third-party client also supplies wallId.
   * Default to the account-wide path and leave wallId unset; callers can opt
   * into a proven wall id without changing the pagination/capture contract.
   */
  async getPostsPage(
    context: FanslyRequestContext,
    accountId: string,
    params: {
      before?: string | null;
      wallId?: string | null;
      pageIndex?: number;
    } = {},
  ): Promise<FanslyPostsPageResponse> {
    const before = params.before ?? "0";
    const wallId = params.wallId ?? null;
    const response = await this.request<FanslyPostsPage>(
      context,
      `/timelinenew/${encodeURIComponent(accountId)}`,
      {
        operation: "timeline_posts",
        endpointTemplate: "/timelinenew/:accountId",
        query: {
          before,
          after: "0",
          wallId: wallId ?? undefined,
        },
        category: "posts",
        requestShape: {
          accountId,
          hasWallId: wallId !== null,
        },
        pagination: {
          pageIndex: params.pageIndex ?? 0,
          cursorPresent: before !== "0",
        },
        summarizeResponse: (parsed) => ({
          returnedItems: Array.isArray(parsed?.posts) ? parsed.posts.length : null,
        }),
      },
    );

    const items = Array.isArray(response.parsed?.posts)
      ? response.parsed.posts
      : [];
    const nextBefore = items.length > 0 && typeof items.at(-1)?.id === "string"
      ? items.at(-1)!.id
      : null;
    return {
      items,
      accountId,
      wallId,
      before,
      nextBefore,
      done: items.length === 0,
      contractAccepted: Array.isArray(response.parsed?.posts),
      raw: response.raw,
    };
  }

  /**
   * WP-F6 — `GET /post?ids=<csv>`: the batch post read, and the whole egress of
   * the engagement refresh phase.
   *
   * It returns the SAME envelope the timeline does (`{posts, aggregatedPosts,
   * accountMedia, accounts, tips, tipGoals, stories, polls}`), which is why the
   * refresh journals under the existing `posts` kind and the v6 family parses
   * it with no new branch: one response shape, one parser, one projection.
   *
   * It carries strictly MORE than the timeline: `wallIds` appears here and on
   * no `/timelinenew` post in the 2026-08-19 capture.
   */
  async getPostsByIds(
    context: FanslyRequestContext,
    ids: string[],
  ): Promise<FanslyPostsPageResponse> {
    if (ids.length === 0) {
      throw new Error("Fansly post batch read requires at least one id");
    }
    if (ids.length > POST_BATCH_SIZE) {
      throw new Error(`Fansly post batch read supports at most ${POST_BATCH_SIZE} ids per request`);
    }
    if (ids.some((id) => id.trim().length === 0)) {
      throw new Error("Fansly post batch read ids must be nonblank");
    }
    const response = await this.request<FanslyPostsPage>(context, "/post", {
      operation: "post_lookup",
      endpointTemplate: "/post",
      query: { ids: ids.join(",") },
      category: "posts",
      requestShape: {
        idsCount: ids.length,
      },
      summarizeResponse: (parsed) => ({
        returnedItems: Array.isArray(parsed?.posts) ? parsed.posts.length : null,
      }),
    });

    const items = Array.isArray(response.parsed?.posts) ? response.parsed.posts : [];
    return {
      items,
      // This route is keyed on ids, not on an account or a wall, and it does not
      // page. The response object keeps the shared shape so one journal/parse
      // path serves both reads; the cursor fields are inert by construction.
      accountId: "",
      wallId: null,
      before: "0",
      nextBefore: null,
      done: true,
      contractAccepted: Array.isArray(response.parsed?.posts),
      raw: response.raw,
    };
  }

  async getTipsByTargetIds(
    context: FanslyRequestContext,
    targetIds: string[],
  ): Promise<FanslyPostTipsResponse> {
    if (targetIds.length === 0) {
      throw new Error("Fansly post tips request requires at least one target id");
    }
    if (targetIds.some((targetId) => targetId.trim().length === 0)) {
      throw new Error("Fansly post tips target ids must be nonblank");
    }

    const response = await this.request<unknown>(context, "/tips", {
      operation: "post_tips",
      endpointTemplate: "/tips",
      query: {
        targetIds: targetIds.join(","),
      },
      category: "posts",
      requestShape: {
        targetIdsCount: targetIds.length,
      },
      summarizeResponse: (parsed) => ({
        returnedItems: Array.isArray(parsed) ? parsed.length : null,
        contractAccepted: Array.isArray(parsed),
      }),
    });
    const items = Array.isArray(response.parsed)
      ? response.parsed as FanslyPostTip[]
      : [];

    return {
      items,
      targetIds: [...targetIds],
      contractAccepted: Array.isArray(response.parsed),
      raw: response.raw,
    };
  }

  async getTransactionsPage(
    context: FanslyRequestContext,
    params: {
      after?: Date | null;
      before?: Date | null;
      limit?: number;
      offset?: number;
      /** Diagnostic-only A/B seam. Production sync keeps the historical
       * omitted form unless a caller explicitly asks for present-empty bounds. */
      unboundedQueryShape?: "omitted" | "present-empty";
    },
  ) {
    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;
    const unbounded = params.unboundedQueryShape === "present-empty" ? "" : undefined;
    const response = await this.request<unknown>(
      context,
      "/account/wallets/earnings/transactions",
      {
        operation: "earnings_transactions",
        endpointTemplate: "/account/wallets/earnings/transactions",
        query: {
          after: params.after ? String(params.after.getTime()) : unbounded,
          before: params.before ? String(params.before.getTime()) : unbounded,
          limit: params.limit != null ? String(params.limit) : undefined,
          offset: params.offset != null ? String(params.offset) : undefined,
        },
        category: "transactions",
        requestShape: {
          after: params.after ? params.after.toISOString() : null,
          before: params.before ? params.before.toISOString() : null,
          limit,
          offset,
          unboundedQueryShape: params.unboundedQueryShape ?? "omitted",
        },
        pagination: {
          offset,
          limit,
        },
        summarizeResponse: (parsed) => {
          const page = parseFanslyTransactionsPage(parsed);
          const accepted = page !== null && page.itemViolation === null;
          return {
            total: page?.total ?? null,
            returnedItems: accepted ? page.data.length : null,
            done: accepted ? page.data.length < limit : null,
            contractAccepted: accepted,
            ...(page?.itemViolation ? { itemViolation: page.itemViolation } : {}),
          };
        },
      },
    );

    const parsed = parseFanslyTransactionsPage(response.parsed);
    const accepted = parsed !== null && parsed.itemViolation === null;
    return {
      total: parsed?.total ?? null,
      items: accepted ? parsed.data : [],
      offset: params.offset ?? 0,
      done: accepted ? parsed.data.length < limit : false,
      contractAccepted: accepted,
      itemViolation: parsed?.itemViolation ?? null,
      raw: response.raw,
    };
  }

  async getEarningsAccountsPage(
    context: FanslyRequestContext,
    params: {
      after?: Date | null;
      before?: Date | null;
    },
  ): Promise<FanslyEarningsAccountsPageResponse> {
    const response = await this.request<FanslyEarningsAccount[]>(
      context,
      "/account/wallets/earnings/accounts",
      {
        operation: "earnings_accounts",
        endpointTemplate: "/account/wallets/earnings/accounts",
        query: {
          after: params.after ? String(params.after.getTime()) : undefined,
          before: params.before ? String(params.before.getTime()) : undefined,
        },
        category: "top_spenders",
        requestShape: {
          after: params.after ? params.after.toISOString() : null,
          before: params.before ? params.before.toISOString() : null,
        },
        summarizeResponse: (parsed) => ({
          returnedItems: parsed.length,
          done: parsed.length < EARNINGS_ACCOUNTS_PAGE_LIMIT,
        }),
      },
    );

    return {
      items: response.parsed,
      after: params.after ?? null,
      before: params.before ?? null,
      done: response.parsed.length < EARNINGS_ACCOUNTS_PAGE_LIMIT,
      raw: response.raw,
    };
  }

  async getSubscribersPage(
    context: FanslyRequestContext,
    params: {
      offset?: number;
      limit?: number;
      after?: Date | null;
      before?: Date | null;
      status?: string;
    },
  ) {
    const status = params.status ?? "3,4";
    const response = await this.request<unknown>(context, "/subscribers", {
      operation: "subscribers",
      endpointTemplate: "/subscribers",
      query: {
        offset: params.offset != null ? String(params.offset) : undefined,
        limit: params.limit != null ? String(params.limit) : undefined,
        after: params.after ? String(params.after.getTime()) : undefined,
        before: params.before ? String(params.before.getTime()) : undefined,
        status,
      },
      category: "subscribers",
      requestShape: {
        offset: params.offset ?? 0,
        limit: params.limit ?? 100,
        after: params.after ? params.after.toISOString() : null,
        before: params.before ? params.before.toISOString() : null,
        status,
      },
      pagination: {
        offset: params.offset ?? 0,
        limit: params.limit ?? 100,
      },
      summarizeResponse: (value) => {
        const parsed = parseFanslySubscribersPage(value, status);
        const total = parsed?.total ?? null;
        return {
          total,
          totalActive: parsed?.totalActive ?? null,
          totalExpired: parsed?.totalExpired ?? null,
          returnedItems: parsed?.subscriptions.length ?? null,
          done: parsed && total !== null
            ? parsed.subscriptions.length < (params.limit ?? 100) ||
              (params.offset ?? 0) + parsed.subscriptions.length >= total
            : null,
          contractAccepted: parsed !== null,
        };
      },
    });

    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;
    const parsed = parseFanslySubscribersPage(response.parsed, status);
    const total = parsed?.total ?? null;
    return {
      total,
      items: parsed?.subscriptions ?? [],
      offset,
      done: parsed && total !== null
        ? parsed.subscriptions.length < limit || offset + parsed.subscriptions.length >= total
        : false,
      contractAccepted: parsed !== null,
      raw: response.raw,
    };
  }

  async getFollowersPage(
    context: FanslyRequestContext,
    accountId: string,
    params: {
      offset?: number;
      limit?: number;
      after?: string | null;
      before?: string | null;
      lastSeenAfter?: number | null;
      minDelayMs?: number;
    },
  ) {
    const response = await this.request<unknown>(
      context,
      `/account/${accountId}/followersnew`,
      {
        operation: "followers",
        endpointTemplate: "/account/:accountId/followersnew",
        query: {
          offset: params.offset != null ? String(params.offset) : undefined,
          limit: params.limit != null ? String(params.limit) : undefined,
          after: params.after ?? undefined,
          before: params.before ?? undefined,
          lastSeenAfter: params.lastSeenAfter != null ? String(params.lastSeenAfter) : undefined,
        },
        category: "followers",
        minDelayMs: params.minDelayMs,
        requestShape: {
          offset: params.offset ?? 0,
          limit: params.limit ?? 100,
          afterPresent: Boolean(params.after),
          beforePresent: Boolean(params.before),
          lastSeenAfter: params.lastSeenAfter ?? null,
        },
        pagination: {
          offset: params.offset ?? 0,
          limit: params.limit ?? 100,
        },
        summarizeResponse: (value) => {
          const parsed = parseFanslyFollowersPage(value);
          return {
            returnedItems: parsed?.followers.length ?? null,
            accountCount: parsed ? parsed.aggregationData?.accounts?.length ?? 0 : null,
            done: parsed ? parsed.followers.length < (params.limit ?? 100) : null,
            contractAccepted: parsed !== null,
          };
        },
      },
    );

    const limit = params.limit ?? 100;
    const parsed = parseFanslyFollowersPage(response.parsed);
    return {
      items: parsed?.followers ?? [],
      total: parsed?.followers.length ?? null,
      offset: params.offset ?? 0,
      done: parsed ? parsed.followers.length < limit : false,
      accounts: parsed?.aggregationData?.accounts ?? [],
      contractAccepted: parsed !== null,
      raw: response.raw,
    };
  }

  async getMessagingGroupsPage(
    context: FanslyRequestContext,
    params: {
      offset?: number;
      limit?: number;
      sortOrder?: number;
      flags?: number;
      search?: string;
      subscriptionTierId?: string | null;
      listIds?: string | null;
    },
  ): Promise<FanslyMessagingGroupsPageResponse> {
    const response = await this.request<unknown>(context, "/messaging/groups", {
      operation: "messaging_groups",
      endpointTemplate: "/messaging/groups",
      query: {
        offset: params.offset != null ? String(params.offset) : undefined,
        limit: params.limit != null ? String(params.limit) : undefined,
        sortOrder: params.sortOrder !== undefined ? String(params.sortOrder) : undefined,
        flags: params.flags !== undefined ? String(params.flags) : undefined,
        search: params.search ?? undefined,
        subscriptionTierId: params.subscriptionTierId ?? undefined,
        listIds: params.listIds ?? undefined,
      },
      category: "dm_conversations",
      requestShape: {
        offset: params.offset ?? 0,
        limit: params.limit ?? 100,
        sortOrder: params.sortOrder ?? 1,
        flags: params.flags ?? 0,
        hasSearch: Boolean(params.search),
        hasSubscriptionTierId: Boolean(params.subscriptionTierId),
        hasListIds: Boolean(params.listIds),
      },
      pagination: {
        offset: params.offset ?? 0,
        limit: params.limit ?? 100,
      },
      summarizeResponse: (value) => {
        const parsed = parseFanslyMessagingGroupsPage(value);
        return {
          total: parsed?.aggregationData?.total ?? null,
          returnedItems: parsed?.data.length ?? null,
          accountCount: parsed ? parsed.aggregationData?.accounts?.length ?? 0 : null,
          groupCount: parsed ? parsed.aggregationData?.groups?.length ?? 0 : null,
          done: parsed ? parsed.data.length < (params.limit ?? 100) : null,
          contractAccepted: parsed !== null,
        };
      },
    });

    // A drifted body comes back as a refusable page with its raw bytes, never
    // as a TypeError before the caller could journal it.
    const limit = params.limit ?? 100;
    const parsed = parseFanslyMessagingGroupsPage(response.parsed);
    return {
      total: parsed?.aggregationData?.total,
      items: parsed?.data ?? [],
      offset: params.offset ?? 0,
      done: parsed ? parsed.data.length < limit : false,
      accounts: parsed?.aggregationData?.accounts ?? [],
      groups: parsed?.aggregationData?.groups ?? [],
      contractAccepted: parsed !== null,
      raw: response.raw,
    };
  }

  async getGroupDetail(
    context: FanslyRequestContext,
    groupId: string,
  ) {
    return this.request<FanslyGroupDetail>(context, `/group/${groupId}`, {
      operation: "group_detail",
      endpointTemplate: "/group/:groupId",
      category: "dm_conversations",
      requestShape: {
        groupId,
      },
      summarizeResponse: (parsed) => ({
        id: parsed.id,
        type: parsed.type,
        userCount: parsed.users.length,
        hasLastMessage: Boolean(parsed.lastMessage),
      }),
    });
  }

  async getMessagesPage(
    context: FanslyRequestContext,
    params: {
      groupId: string;
      limit?: number;
      before?: string | null;
    },
  ): Promise<FanslyMessagesPageResponse> {
    const response = await this.request<unknown>(context, "/message", {
      operation: "messages",
      endpointTemplate: "/message",
      query: {
        groupId: params.groupId,
        limit: params.limit != null ? String(params.limit) : undefined,
        before: params.before ?? undefined,
      },
      category: "dm_messages",
      requestShape: {
        groupId: params.groupId,
        limit: params.limit ?? 25,
        hasBefore: Boolean(params.before),
      },
      pagination: {
        cursorPresent: Boolean(params.before),
        limit: params.limit ?? 25,
      },
      summarizeResponse: (value) => {
        const parsed = parseFanslyMessagesPage(value);
        return {
          groupId: params.groupId,
          returnedItems: parsed?.messages.length ?? null,
          done: parsed ? parsed.messages.length < (params.limit ?? 25) : null,
          contractAccepted: parsed !== null,
        };
      },
    });

    const limit = params.limit ?? 25;
    const parsed = parseFanslyMessagesPage(response.parsed);
    return {
      items: parsed?.messages ?? [],
      groupId: params.groupId,
      before: params.before ?? null,
      done: parsed ? parsed.messages.length < limit : false,
      contractAccepted: parsed !== null,
      raw: response.raw,
    };
  }

  async verifySession(context: FanslyRequestContext) {
    const response = await this.getAccountMe(context);
    if (!isRecord(response.parsed) || !isRecord(response.parsed.account) ||
      typeof response.parsed.account.id !== "string" || response.parsed.account.id.length === 0) {
      throw new FanslyApiError("Fansly session verification returned an invalid account");
    }
    return response;
  }

  // ── Stage 6 replay-probe methods (read-only, loosely typed) ──
  // These test whether core can replay, server-side, the Fansly endpoint families
  // that today only the extension calls (DP 1-B). They reuse `buildHeaders` as-is
  // (the single pasted `fansly-client-check`); response typing is deliberately loose
  // (Stage 16 hardens it). See docs/migration-history/stages/stage-06-*.md.

  async getEarningsStatsAccountsPage(
    context: FanslyRequestContext,
    params: {
      correlationAccountId?: string | null;
      after?: Date | null;
      before?: Date | null;
    },
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(
      context,
      "/account/wallets/earnings/stats/accounts",
      {
        operation: "earnings_stats_accounts",
        endpointTemplate: "/account/wallets/earnings/stats/accounts",
        query: {
          correlationAccountId: params.correlationAccountId ?? undefined,
          after: params.after ? String(params.after.getTime()) : undefined,
          before: params.before ? String(params.before.getTime()) : undefined,
        },
        category: "top_spenders",
        requestShape: {
          correlationAccountId: params.correlationAccountId ?? null,
          after: params.after ? params.after.toISOString() : null,
          before: params.before ? params.before.toISOString() : null,
        },
        summarizeResponse: (parsed) => ({
          returnedItems: Array.isArray(parsed) ? parsed.length : null,
        }),
      },
    );

    return { items: response.parsed, raw: response.raw };
  }

  async getEarningsMonthlyStatsAccountsPage(
    context: FanslyRequestContext,
    params: {
      correlationAccountId?: string | null;
      after?: Date | null;
      before?: Date | null;
    },
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(
      context,
      "/account/wallets/earnings/monthlystats/accounts",
      {
        operation: "earnings_monthlystats_accounts",
        endpointTemplate: "/account/wallets/earnings/monthlystats/accounts",
        query: {
          correlationAccountId: params.correlationAccountId ?? undefined,
          after: params.after ? String(params.after.getTime()) : undefined,
          before: params.before ? String(params.before.getTime()) : undefined,
        },
        category: "top_spenders",
        requestShape: {
          correlationAccountId: params.correlationAccountId ?? null,
          after: params.after ? params.after.toISOString() : null,
          before: params.before ? params.before.toISOString() : null,
        },
        summarizeResponse: (parsed) => ({
          returnedItems: Array.isArray(parsed) ? parsed.length : null,
        }),
      },
    );

    return { items: response.parsed, raw: response.raw };
  }

  async getMediaOrderHistoryPage(
    context: FanslyRequestContext,
    params: {
      accountIds?: string | null;
      accountMediaId?: string | null;
      accountMediaBundleId?: string | null;
      before?: string | null;
      limit?: number;
    },
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/media/orderhistory", {
      operation: "media_orderhistory",
      endpointTemplate: "/media/orderhistory",
      query: {
        accountIds: params.accountIds ?? undefined,
        accountMediaId: params.accountMediaId ?? undefined,
        accountMediaBundleId: params.accountMediaBundleId ?? undefined,
        before: params.before ?? undefined,
        limit: params.limit != null ? String(params.limit) : undefined,
      },
      category: "media",
      requestShape: {
        hasAccountIds: Boolean(params.accountIds),
        hasAccountMediaId: Boolean(params.accountMediaId),
        hasAccountMediaBundleId: Boolean(params.accountMediaBundleId),
        cursorPresent: Boolean(params.before),
        limit: params.limit ?? 100,
      },
      pagination: {
        limit: params.limit ?? 100,
        cursorPresent: Boolean(params.before),
      },
      summarizeResponse: (parsed) => ({
        returnedItems: Array.isArray(parsed) ? parsed.length : null,
      }),
    });

    return { items: response.parsed, raw: response.raw };
  }

  // ---------------------------------------------------------------------------
  // LIVENESS PROBES — WP-F9 (`dm_commerce`) + [E1].
  //
  // Every route below came from the 2026-08-20 static bundle extraction, NOT from
  // a live capture: the client builds these requests, which is not proof the server
  // will serve them to us. They exist so ONE call each can settle that, on a canary
  // page, through the page's own proxy, BEFORE any capture machinery is designed
  // around them (the plan's "liveness first, budget second" rule).
  //
  // Deliberately loose: `unknown` in, `unknown` out, no mappers, no shape assertions.
  // Typing follows evidence, not the other way round — do not add parsing here; add
  // it in a canonicalizer once a real response has been inspected.
  //
  // NOTE on where the evidence comes from: the probe path passes NO `requestObserver`,
  // so these calls are NOT journaled — nothing lands in `sync_http_attempts` or
  // `sync_raw_payloads`. That is deliberate. Journaling would require standing up a
  // full sync run (and its `page_sync_states` bookkeeping) for a diagnostic, and it
  // would put fan PII into storage to learn a shape. The probe prints a REDACTED
  // structural skeleton instead — key names and value types, never values. When a
  // route graduates from probe to capture lane it gets journaled the ordinary way,
  // through the sync telemetry, like every other lane.
  //
  // All GETs. Nothing here mutates, and `request()` hardcodes the method.
  // ---------------------------------------------------------------------------

  /**
   * WP-F5's whole lane, and it is a BARE GET forever.
   *
   * [E1], settled: every observed `GET /post/{id}/replies` in the 2026-08-19
   * capture was preceded ~40 ms earlier by the browser's reply-verify POST
   * carrying the same post id (5/5). The probe issued the GET with NO preceding
   * POST and the comments came back (A25). So that POST is a client-side
   * affordance, not a server-side precondition — and it is never issued from
   * here, because §1 excludes write-shaped calls to the platform and a POST that
   * "only verifies" is still a POST to somebody else's server. A test greps this
   * WHOLE FILE for that route's path and fails if it ever appears, which is why
   * the path is not written out even in this comment.
   *
   * ── PAGINATION IS UNPROVEN, and this signature says so ────────────────────
   *
   * No observed response carried more than four replies, so no cursor has ever
   * been exercised. `before` is offered because it is the convention every
   * other paginated Fansly route uses (`/timelinenew`, `/message`,
   * `/notifications`) and because replies came back descending by id — but the
   * caller only sends it after a page looks suspiciously full, and it carries
   * its own repeat-cursor guard. Until a second page is actually served, the
   * lane records `possiblyTruncated` and refuses to call the walk complete.
   *
   * ── `emptyStatuses: [204]`, on THIS METHOD ONLY ───────────────────────────
   *
   * NO GET anywhere in the HAR returned 204 (all 197 are OPTIONS preflights),
   * and production has since answered "no replies" only as a 200 with an empty
   * `posts[]` — never a 204, never an empty body. The 204 / empty-body branch
   * returns `{__empty: true, httpStatus}` rather than throwing, so the walk
   * journals the response instead of recording a lane failure; the parser then
   * treats the marker as clear-only, never as proof that a comment is gone.
   */
  async getPostRepliesPage(
    context: FanslyRequestContext,
    params: { postId: string; before?: string | null },
  ): Promise<{ items: unknown; raw: unknown }> {
    const before = params.before ?? null;
    const response = await this.request<unknown>(
      context,
      `/post/${encodeURIComponent(params.postId)}/replies`,
      {
        operation: "post_replies",
        endpointTemplate: "/post/{postId}/replies",
        category: "posts",
        // OMITTED entirely on the first call — the bare form is the only one
        // five live responses prove. `before` appears only once the caller has
        // a reason to suspect a second page exists.
        query: before === null ? {} : { before },
        requestShape: { postId: params.postId, verifyPosted: false, before },
        pagination: { cursorPresent: before !== null },
        emptyStatuses: POST_REPLIES_EMPTY_STATUSES,
        summarizeResponse: summarizeUnknownResponse,
      },
    );

    return { items: response.parsed, raw: response.raw };
  }

  /**
   * The missing join between the DM plane and the money plane: which paid media
   * was offered to which fan in which conversation. The single highest-value route
   * in WP-F9 — if only one of these probes succeeds, this is the one that matters.
   */
  async getGroupMediaOffersPage(
    context: FanslyRequestContext,
    params: {
      groupId: string;
      accountId?: string | null;
      before?: string | null;
      after?: string | null;
      limit?: number | null;
      offset?: number | null;
    },
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/groups/mediaoffers", {
      operation: "group_mediaoffers_probe",
      endpointTemplate: "/groups/mediaoffers",
      category: "dm_conversations",
      query: {
        groupId: params.groupId,
        accountId: params.accountId ?? undefined,
        before: params.before ?? undefined,
        after: params.after ?? undefined,
        limit: params.limit != null ? String(params.limit) : undefined,
        offset: params.offset != null ? String(params.offset) : undefined,
      },
      requestShape: {
        groupId: params.groupId,
        hasAccountId: Boolean(params.accountId),
        cursorPresent: Boolean(params.before ?? params.after),
        limit: params.limit ?? null,
        offset: params.offset ?? null,
      },
      pagination: {
        limit: params.limit ?? null,
        offset: params.offset ?? null,
        cursorPresent: Boolean(params.before ?? params.after),
      },
      summarizeResponse: summarizeUnknownResponse,
    });

    return { items: response.parsed, raw: response.raw };
  }

  /**
   * Mass-DM performance. Paginated (`before` cursor), so it is a history rather
   * than a snapshot — the difference between "how are we selling" and "how did we
   * sell". The `/deleted` sibling carries broadcasts that were pulled, which is a
   * fact that disappears entirely if only the live list is ever read.
   */
  async getBroadcastStatsPage(
    context: FanslyRequestContext,
    params: { before?: string | null; limit?: number | null; deleted?: boolean },
  ): Promise<{ items: unknown; raw: unknown }> {
    const deleted = params.deleted === true;
    const pathname = deleted ? "/message/broadcast/stats/deleted" : "/message/broadcast/stats";
    const response = await this.request<unknown>(context, pathname, {
      operation: deleted ? "broadcast_stats_deleted_probe" : "broadcast_stats_probe",
      endpointTemplate: pathname,
      category: "dm_conversations",
      query: {
        before: params.before ?? undefined,
        limit: params.limit != null ? String(params.limit) : undefined,
      },
      requestShape: {
        deleted,
        cursorPresent: Boolean(params.before),
        limit: params.limit ?? null,
      },
      pagination: {
        limit: params.limit ?? null,
        cursorPresent: Boolean(params.before),
      },
      summarizeResponse: summarizeUnknownResponse,
    });

    return { items: response.parsed, raw: response.raw };
  }

  /** The mass-DM queue: intent, before it is sent. Pairs with the two stats routes. */
  async getBroadcastScheduled(
    context: FanslyRequestContext,
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/message/broadcast/scheduled", {
      operation: "broadcast_scheduled_probe",
      endpointTemplate: "/message/broadcast/scheduled",
      category: "dm_conversations",
      summarizeResponse: summarizeUnknownResponse,
    });

    return { items: response.parsed, raw: response.raw };
  }

  /**
   * Who bought which media. Order-shaped rather than ledger-shaped: expected to
   * CORRELATE with the wallet ledger (WP-F8), not duplicate it. Distinct from the
   * already-wired `/media/orderhistory` — that one is keyed by media/bundle id,
   * this one is a flat account-scoped list.
   */
  async getAccountMediaOrdersPage(
    context: FanslyRequestContext,
    params: { limit?: number | null; offset?: number | null },
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/account/media/orders", {
      operation: "account_media_orders_probe",
      endpointTemplate: "/account/media/orders",
      category: "media",
      query: {
        limit: params.limit != null ? String(params.limit) : undefined,
        offset: params.offset != null ? String(params.offset) : undefined,
      },
      requestShape: { limit: params.limit ?? null, offset: params.offset ?? null },
      pagination: { limit: params.limit ?? null, offset: params.offset ?? null },
      summarizeResponse: summarizeUnknownResponse,
    });

    return { items: response.parsed, raw: response.raw };
  }

  /**
   * Tips resolved per FAN (`/tips/account`).
   *
   * Note the sibling that is NOT here: `GET /tips` (by `targetIds`) is already
   * wired and live — `getTipsByTargetIds` above, operation `post_tips`, 531 calls
   * in the 10 days to 2026-08-21 with 530 successes. It was on the WP-F9 probe
   * list until the kernel was checked; probing it would have re-proven something
   * production does hourly.
   */
  async getTipsByAccountIds(
    context: FanslyRequestContext,
    params: { accountIds?: string | null },
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/tips/account", {
      operation: "tips_account_probe",
      endpointTemplate: "/tips/account",
      category: "transactions",
      query: { accountIds: params.accountIds ?? undefined },
      requestShape: { hasAccountIds: Boolean(params.accountIds) },
      summarizeResponse: summarizeUnknownResponse,
    });

    return { items: response.parsed, raw: response.raw };
  }

  /** Story viewer list — an audience surface with no other source anywhere in the plan. */
  async getMediaStoryViewsPage(
    context: FanslyRequestContext,
    params: { storyId: string; limit?: number | null; offset?: number | null },
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/mediastory/views", {
      operation: "mediastory_views_probe",
      endpointTemplate: "/mediastory/views",
      category: "media",
      query: {
        storyId: params.storyId,
        limit: params.limit != null ? String(params.limit) : undefined,
        offset: params.offset != null ? String(params.offset) : undefined,
      },
      requestShape: {
        storyId: params.storyId,
        limit: params.limit ?? null,
        offset: params.offset ?? null,
      },
      pagination: { limit: params.limit ?? null, offset: params.offset ?? null },
      summarizeResponse: summarizeUnknownResponse,
    });

    return { items: response.parsed, raw: response.raw };
  }

  /** Poll results per account. Catalog-adjacent, low volume. */
  async getPolls(context: FanslyRequestContext): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/polls", {
      operation: "polls_probe",
      endpointTemplate: "/polls",
      category: "posts",
      summarizeResponse: summarizeUnknownResponse,
    });

    return { items: response.parsed, raw: response.raw };
  }

  /**
   * Unidentified. Named like a periodic summary; the bundle gives no shape. One
   * probe call settles what it is — deliberately do NOT design for it before then.
   */
  async getRecapStats(context: FanslyRequestContext): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/recapstats", {
      operation: "recapstats_probe",
      endpointTemplate: "/recapstats",
      category: "account",
      summarizeResponse: summarizeUnknownResponse,
    });

    return { items: response.parsed, raw: response.raw };
  }

  // ---- WP-F3: the content-catalog lane ----

  /**
   * `/vault/albumsnew` — the creator's REAL vault: 27 albums on the live
   * capture, with `aggregationData.media[]` riding along.
   *
   * That sidecar carries `location`, `locations[]` and `variants[]` — signed
   * CDN material. It is journaled verbatim (DP 7) and NOTHING downstream may
   * put it in an event or a projection; the adapter hands the whole body
   * through and the handler journals before anything parses it.
   */
  async getVaultAlbums(
    context: FanslyRequestContext,
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/vault/albumsnew", {
      operation: "vault_albums",
      endpointTemplate: "/vault/albumsnew",
      category: "media",
      summarizeResponse: summarizeUnknownResponse,
    });
    return { items: response.parsed, raw: response.raw };
  }

  /**
   * `/uservault/albumsnew?accountId=` — a DIFFERENT resource from the one
   * above: the account's own Likes/Purchases shelves, whose contents are OTHER
   * creators' media. Captured for completeness and joined by native id; never
   * counted into the page's own inventory.
   *
   * `accountId` is required by the app's own caller and is passed through
   * exactly as it is stored on the page.
   */
  async getUserVaultAlbums(
    context: FanslyRequestContext,
    params: { accountId: string },
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/uservault/albumsnew", {
      operation: "uservault_albums",
      endpointTemplate: "/uservault/albumsnew",
      category: "media",
      query: { accountId: params.accountId },
      requestShape: { hasAccountId: params.accountId.length > 0 },
      summarizeResponse: summarizeUnknownResponse,
    });
    return { items: response.parsed, raw: response.raw };
  }

  /**
   * `/subscriptions/tiers` — FEAT-002's source. A flat array of tiers whose
   * REAL prices live in `plans[].price`; `tier.price` was 5 000 on all five
   * observed tiers and is a base, not a price.
   */
  async getSubscriptionTiers(
    context: FanslyRequestContext,
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/subscriptions/tiers", {
      operation: "subscription_tiers",
      endpointTemplate: "/subscriptions/tiers",
      category: "account",
      summarizeResponse: summarizeUnknownResponse,
    });
    return { items: response.parsed, raw: response.raw };
  }

  /** `/subscriptions/giftcodes` — 73 codes on the live capture; note
   *  `original_price` arrives snake_case amid otherwise camelCase keys. */
  async getGiftCodes(
    context: FanslyRequestContext,
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/subscriptions/giftcodes", {
      operation: "gift_codes",
      endpointTemplate: "/subscriptions/giftcodes",
      category: "account",
      summarizeResponse: summarizeUnknownResponse,
    });
    return { items: response.parsed, raw: response.raw };
  }

  /** `/message/automated` — the page's automation definitions.
   *  `messageTemplate` is a JSON OBJECT in every live value; the string-shape
   *  fallback lives in the canonicalizer, not here. */
  async getAutomatedMessages(
    context: FanslyRequestContext,
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/message/automated", {
      operation: "automated_messages",
      endpointTemplate: "/message/automated",
      category: "messaging",
      summarizeResponse: summarizeUnknownResponse,
    });
    return { items: response.parsed, raw: response.raw };
  }

  /** `/account/media?ids=` — media rows by id (the app's batch hydration for its own media). */
  async getAccountMediaByIds(
    context: FanslyRequestContext,
    params: { ids: string },
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/account/media", {
      operation: "account_media_by_ids_probe",
      endpointTemplate: "/account/media",
      category: "media",
      query: { ids: params.ids },
      requestShape: { idCount: params.ids.split(",").filter(Boolean).length },
      summarizeResponse: summarizeUnknownResponse,
    });
    return { items: response.parsed, raw: response.raw };
  }

  /** `/account/media/bundle?ids=` — bundle rows by id. */
  async getAccountMediaBundlesByIds(
    context: FanslyRequestContext,
    params: { ids: string },
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/account/media/bundle", {
      operation: "account_media_bundles_by_ids_probe",
      endpointTemplate: "/account/media/bundle",
      category: "media",
      query: { ids: params.ids },
      requestShape: { idCount: params.ids.split(",").filter(Boolean).length },
      summarizeResponse: summarizeUnknownResponse,
    });
    return { items: response.parsed, raw: response.raw };
  }

  /** `/account/walls?correlationPostIds=` — the profile walls (sections) for given posts. */
  async getAccountWalls(
    context: FanslyRequestContext,
    params: { correlationPostIds?: string | null },
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/account/walls", {
      operation: "account_walls_probe",
      endpointTemplate: "/account/walls",
      category: "account",
      query: { correlationPostIds: params.correlationPostIds ?? undefined },
      requestShape: { hasPostIds: Boolean(params.correlationPostIds) },
      summarizeResponse: summarizeUnknownResponse,
    });
    return { items: response.parsed, raw: response.raw };
  }

  /**
   * `/media/vaultnew` — the vault's media listing, in the form the app itself
   * sends. THIS FORM IS THE WHOLE FIX.
   *
   * The 2026-08-22 probe sent `albumId=…&search=&before=&after=` against a
   * 4 760-item album and got `{albumMedia: [], media: []}` — an empty page that
   * looks exactly like an exhausted album. Reading the app bundle settled why:
   * `getVaultAlbumMediaNewOrder` builds
   *
   *   /media/vaultnew?albumId=<id>&mediaType=<filter|"">&before=<cursor>&after=<"0">&search=<text|"">
   *
   * and its caller passes the LITERAL STRING "0" for both `before` and `after`
   * on the first page, `mediaType` present-and-empty when unfiltered, and
   * `before = <id of the last albumMedia row>` for every page after the first.
   * An empty `before=` is not "start at the head" to this endpoint; it is a
   * cursor the server does not honour.
   *
   * `mediaType` is therefore ALWAYS sent (empty when unfiltered) rather than
   * omitted, and `search` likewise — the app sends both on every call, and this
   * lane's job is to be indistinguishable from the app.
   *
   * The second variant, `?type=<vaultType>&before&after`, lists by vault type
   * rather than by album; it is kept because the app has it, and the catalog
   * walk does not use it.
   */
  async getVaultMediaPage(
    context: FanslyRequestContext,
    params: {
      albumId?: string | null;
      type?: number | null;
      /** Present and EMPTY when unfiltered — the app's own `getMediaTypeFilter()`
       *  returns "" when neither images nor video are hidden. */
      mediaType?: string | null;
      /** The LITERAL "0" on the first page; the last row's id afterwards. */
      before?: string | null;
      /** The literal "0". The app never sends anything else here. */
      after?: string | null;
      search?: string | null;
    },
  ): Promise<{ items: unknown; raw: unknown }> {
    const byAlbum = typeof params.albumId === "string" && params.albumId.length > 0;
    const response = await this.request<unknown>(context, "/media/vaultnew", {
      operation: "vault_media",
      endpointTemplate: "/media/vaultnew",
      category: "media",
      query: byAlbum
        ? {
          albumId: params.albumId ?? undefined,
          // Present-and-empty, never omitted.
          mediaType: params.mediaType ?? "",
          search: params.search ?? "",
          before: params.before ?? VAULT_MEDIA_HEAD_CURSOR,
          after: params.after ?? VAULT_MEDIA_HEAD_CURSOR,
        }
        : {
          type: params.type != null ? String(params.type) : undefined,
          before: params.before ?? VAULT_MEDIA_HEAD_CURSOR,
          after: params.after ?? VAULT_MEDIA_HEAD_CURSOR,
        },
      requestShape: {
        byAlbum,
        type: params.type ?? null,
        before: params.before ?? VAULT_MEDIA_HEAD_CURSOR,
      },
      pagination: {
        cursorPresent: (params.before ?? VAULT_MEDIA_HEAD_CURSOR) !== VAULT_MEDIA_HEAD_CURSOR,
      },
      summarizeResponse: summarizeUnknownResponse,
    });
    return { items: response.parsed, raw: response.raw };
  }

  // ---------------------------------------------------------------------------
  // WP-F7 — the payouts lane. TWO routes, both GET, both verified live
  // 2026-08-20 (`artifacts/fansly-payouts-capture-2026-08-20/`).
  //
  // `/account/wallets/earnings` is NOT here: it is `getEarningsOverview` above.
  // Neither is `/account/wallets/earnings/transactions` — that is the existing
  // `transactions` stream, and A28-1 settled it by matching seven transaction
  // ids from this very HAR against rows the kernel already holds.
  // ---------------------------------------------------------------------------

  /**
   * `/payments/payoutmethods` — the creator's own payout methods, as a BARE
   * ARRAY under the envelope. One call, no query, no pagination.
   *
   * LOOSELY TYPED ON PURPOSE, like every other route in this initiative: the
   * body is journaled before anything asserts on its shape, and the decode —
   * including `metadata`, which arrives as a JSON-ENCODED STRING — happens in
   * the canonicalizer where a fixture can bite it. The adapter is a transport.
   *
   * WHAT IT CARRIES, AND WHY THAT MATTERS HERE MORE THAN ANYWHERE ELSE:
   * provider 2 (Paxum, per A22-4 — the API spec says PayPal and is wrong)
   * returns the creator's FULL email address in plaintext. It reaches the raw
   * journal under the restricted class and goes no further; nothing derived
   * from it but a mask ever reaches a projection.
   */
  async getPayoutMethods(
    context: FanslyRequestContext,
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/payments/payoutmethods", {
      operation: "payout_methods",
      endpointTemplate: "/payments/payoutmethods",
      category: "transactions",
      requestShape: {},
      summarizeResponse: summarizeUnknownResponse,
    });
    return { items: response.parsed, raw: response.raw };
  }

  /**
   * `/payments/payout/requests` — the payout-request history, OFFSET-PAGED.
   *
   * THE QUERY FORM IS THE APP'S OWN, character for character:
   *
   *   ?before=&after=&limit=10&offset=<0,10,20,…>&ngsw-bypass=true
   *
   * `before` and `after` are PRESENT AND EMPTY — the app sends them unbounded
   * on every one of the nine observed calls, and the wallet UI never exposed a
   * date filter to fill them. They are sent the same way here rather than
   * omitted, because "the form the app sends" is the only form any of this is
   * proven against and an omitted parameter is a different request.
   *
   * `limit` is 10 because that is what the UI asks for and what the server was
   * observed to serve. Whether a larger limit is honoured on THIS route has
   * never been measured, so the caller assumes 10 and the walk carries a
   * repeat-request guard rather than a belief.
   */
  async getPayoutRequestsPage(
    context: FanslyRequestContext,
    params: {
      /** Present and EMPTY when unbounded — exactly as the app sends it. */
      before?: string | null;
      after?: string | null;
      limit: number;
      /** Zero-based ROW offset, not a page index. */
      offset: number;
    },
  ): Promise<{ items: unknown; raw: unknown }> {
    const response = await this.request<unknown>(context, "/payments/payout/requests", {
      operation: "payout_requests",
      endpointTemplate: "/payments/payout/requests",
      category: "transactions",
      query: {
        // Present-and-empty, never omitted.
        before: params.before ?? PAYOUT_REQUESTS_UNBOUNDED,
        after: params.after ?? PAYOUT_REQUESTS_UNBOUNDED,
        limit: String(params.limit),
        offset: String(params.offset),
      },
      requestShape: { limit: params.limit, offset: params.offset },
      pagination: { offset: params.offset, limit: params.limit },
      summarizeResponse: summarizeUnknownResponse,
    });
    return { items: response.parsed, raw: response.raw };
  }

  private async request<T>(
    context: FanslyRequestContext,
    pathname: string,
    options: {
      query?: Record<string, string | undefined>;
      category: string;
      operation: string;
      endpointTemplate: string;
      requestShape?: Record<string, unknown>;
      pagination?: {
        offset?: number | null;
        limit?: number | null;
        pageIndex?: number | null;
        cursorPresent?: boolean | null;
      };
      minDelayMs?: number;
      retries?: number;
      /**
       * WP-F5. HTTP statuses this route answers with an EMPTY BODY, which are a
       * legitimate "nothing here" rather than a broken envelope.
       *
       * Opt-in per method, and deliberately not a global rule: everywhere else
       * in this adapter a body that carries no `{success, response}` envelope
       * IS a failure, and softening that globally would let a truncated
       * response read as "no data" on every lane at once. When a status
       * matches, the call succeeds with `FANSLY_EMPTY_RESPONSE`-shaped material
       * — `{__empty: true, httpStatus}` — so the caller can tell an empty
       * answer from an absent one and the journal records which.
       */
      emptyStatuses?: readonly number[];
      /**
       * An HTTP 5xx that carries a well-formed Fansly error envelope
       * (`isFanslyErrorEnvelope`) is FINAL on this route: the application's
       * own answer about this request, not the wire's, so it fails on the
       * first attempt. Opt-in per method, because only `/it/moie/statsnew` is
       * measured: none of its thousands of such retries in a week recovered
       * (`error getting graph`, `error getting media offer`). A `Retry-After`,
       * a body that is not such an envelope, a 429 and a transport failure keep
       * the retries every route has.
       */
      finalServerErrorEnvelope?: boolean;
      summarizeResponse?: (parsed: T) => Record<string, unknown>;
    },
  ): Promise<RequestResult<T>> {
    const query = new URLSearchParams({ "ngsw-bypass": "true" });
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        query.set(key, value);
      }
    }

    const url = `${this.options.baseUrl}${pathname}?${query.toString()}`;
    const retryAllowance = Math.max(0, context.remainingAttempts?.() ?? Number.MAX_SAFE_INTEGER);
    const retries = Math.min(options.retries ?? 3, Math.max(0, retryAllowance - 1));
    const minDelayMs = options.minDelayMs ?? 0;
    const requestId = `${options.operation}:${randomUUID()}`;
    const requestTimeoutMs = context.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

    // The send-guard lease of the attempt between its admission and its
    // dispatch. An attempt that never reaches `execute` (an observer refused
    // it, the run was cancelled, a decoder threw) still gives the page back:
    // the outer `finally` completes it as never sent. A capture that resolves
    // after the request settled is released on arrival.
    let admittedLease: FanslySendLease | null = null;
    let requestSettled = false;
    const releaseUnusedLease = async () => {
      const lease = admittedLease;
      admittedLease = null;
      await lease?.complete({ outcome: "aborted_before_send" });
    };

    try {
      return await executeObservedRequest({
        observer: context.requestObserver,
        requestId,
        operation: options.operation,
        endpointTemplate: options.endpointTemplate,
        method: "GET",
        pagination: options.pagination ?? null,
        requestMetadata: options.requestShape ?? {},
        retries,
        waitForRateLimit: async () => {
          await releaseUnusedLease();
          // Endpoint pauses first, then the page's send guard (plan §2.5): the
          // guard's capture is the last thing before the attempt starts.
          const endpointWaitMs = await this.waitForEndpointPause(context, options.category, minDelayMs);
          assertHttpRequestActive();
          const captureStartedAt = Date.now();
          const lease = await context.sendGuard.acquire({
            operation: options.operation,
            requestTimeoutMs,
            signal: getHttpRequestSignal() ?? null,
          });
          if (requestSettled) {
            await lease.complete({ outcome: "aborted_before_send" });
            throw new Error("Fansly request settled before its send-guard capture resolved");
          }
          admittedLease = lease;
          return endpointWaitMs + (Date.now() - captureStartedAt);
        },
        execute: async () => {
          const lease = admittedLease;
          admittedLease = null;
          if (!lease) {
            throw new Error("Fansly request reached dispatch without a send-guard lease");
          }
          let outcome: FanslySendCompletionOutcome = "transport_error";
          let httpStatus: number | null = null;
          try {
            const response = await fetch(url, {
              method: "GET",
              headers: buildFanslyRequestHeaders(context.session, pathname),
              signal: AbortSignal.timeout(requestTimeoutMs),
              dispatcher: lease.bind(this.getDispatcher(context.proxy)),
              // One capture is one physical request: a 3xx is an answer, never
              // a second request undici sends on its own.
              redirect: "manual",
            });
            httpStatus = response.status;
            const text = await response.text();
            outcome = "response";
            return {
              response,
              text,
              envelope: this.safeParseEnvelope<T>(text),
            };
          } catch (error) {
            outcome = lease.sendRefused && !lease.sent
              ? "aborted_before_send"
              : classifyTransportError(error) === "timeout" ? "timeout" : "transport_error";
            throw error;
          } finally {
            await lease.complete({ outcome, httpStatus });
          }
        },
        onTransportError: (error, executionContext) => {
          // The guard refused the dispatch: nothing was sent. The next attempt
          // captures the page again (and is paced by it), so there is no
          // transport to reset and no backoff to wait out.
          const refusal = findFanslySendRefusal(error);
          if (refusal) {
            const errorMessage = refusal.message;
            return executionContext.retriesRemaining > 0
              ? { kind: "retry", failureKind: "policy", retryDelayMs: 0, errorMessage, error }
              : { kind: "failed", failureKind: "policy", errorMessage, error };
          }
          const failureKind = classifyTransportError(error);
          if (failureKind === "transport") {
            this.resetDispatcher(context.proxy);
          }

          if (executionContext.retriesRemaining > 0) {
            return {
              kind: "retry",
              failureKind,
              retryDelayMs: exponentialRetryDelayMs(executionContext.attemptNumber),
              errorMessage: sanitizeError(error, { format: "chain" }).message,
              error,
            };
          }

          return {
            kind: "failed",
            failureKind,
            errorMessage: sanitizeError(error, { format: "chain" }).message,
            error,
          };
        },
        onResponse: ({ response, text, envelope }, executionContext) => {
          const envelopeMessage = envelope?.error?.message === undefined
            ? undefined
            : redactSensitiveText(envelope.error.message);
          // Redact BEFORE slicing: a cut through a credential URL leaves a
          // fragment the redactor no longer recognises as one (decision #248).
          const responseSnippet = redactSensitiveText(text).slice(0, 400);
          // Fansly puts the reason in `error.details`, not `message`. Redacted
          // before it is sliced, like the snippet.
          const envelopeDetails = envelope?.error?.details === undefined
            || envelope.error.details.trim().length === 0
            ? undefined
            : redactSensitiveText(envelope.error.details.trim()).slice(0, ERROR_DETAILS_MAX_CHARS);
          /** The provider's message when it sent one; otherwise ours, with the
           *  provider's details after it. */
          const failureMessage = (fallback: string) =>
            envelopeMessage
              ?? (envelopeDetails === undefined ? fallback : `${fallback}: ${envelopeDetails}`);
          const retryAfterHeader = response.headers.get("retry-after");
          const observedAt = Date.now();
          // Unclamped on purpose: the provider's deadline is a fact, and a
          // terminal failure carries it to the durable retry.
          const retryAfterAt = parseRetryAfterInstant(retryAfterHeader, observedAt);
          // A Retry-After beyond what this loop may sleep cannot be waited out
          // in process: clamping it to 60s would burn every remaining attempt on
          // a window the provider already told us is closed, and each attempt is
          // one more 429 against the same page. Stop here and let the caller
          // sleep durably until `retryAfterAt`.
          const retryAfterExceedsInProcessClamp = retryAfterAt !== null
            && retryAfterAt.getTime() - observedAt > MAX_RETRY_DELAY_MS;
          const failureResponseMetadata = {
            bodyLength: text.length,
            errorCode: envelope?.error?.code ?? null,
            errorMessage: envelopeMessage ?? null,
            responseSnippet: responseSnippet.length > 0 ? responseSnippet : null,
          };

          if (response.status === 401 || response.status === 403) {
            return {
              kind: "failed",
              failureKind: "http",
              httpStatus: response.status,
              errorMessage: failureMessage(`Fansly authorization failed (${response.status})`),
              responseMetadata: failureResponseMetadata,
              error: new FanslyApiError(
                failureMessage(`Fansly authorization failed (${response.status})`),
                response.status,
                envelope?.error?.code,
                responseSnippet,
              ),
            };
          }

          // WP-F5's opt-in empty answer. It sits AFTER the auth check (a 401 is
          // never "no replies") and before the envelope check, because a 204 —
          // or an ok response with a zero-length body — carries no envelope to
          // parse and would otherwise fail as `provider` drift.
          const emptyStatuses = options.emptyStatuses ?? [];
          if (
            emptyStatuses.includes(response.status)
            || (emptyStatuses.length > 0 && response.ok && text.trim().length === 0)
          ) {
            const empty = { __empty: true, httpStatus: response.status } as const;
            return {
              kind: "success",
              value: { parsed: empty as unknown as T, raw: empty as unknown as T },
              httpStatus: response.status,
              responseMetadata: { responseKind: "empty", bodyLength: text.length },
            };
          }

          // The route's own deterministic answer, where the route opts in (see
          // `finalServerErrorEnvelope`): it falls through to the terminal failure
          // below on the first attempt. A `Retry-After` says "come back later",
          // which is the opposite claim, so it keeps its retries.
          const finalServerError = options.finalServerErrorEnvelope === true
            && response.status >= 500
            && retryAfterHeader === null
            && isFanslyErrorEnvelope(envelope);
          if (
            [429, 500, 502, 503, 504].includes(response.status)
            && executionContext.retriesRemaining > 0
            && !retryAfterExceedsInProcessClamp
            && !finalServerError
          ) {
            return {
              kind: "retry",
              failureKind: "http",
              httpStatus: response.status,
              retryDelayMs: resolveRetryDelayMs(
                retryAfterHeader,
                executionContext.attemptNumber,
                observedAt,
              ),
              responseMetadata: failureResponseMetadata,
              errorMessage: failureMessage(`Fansly request failed (${response.status})`),
            };
          }

          if (!response.ok) {
            return {
              kind: "failed",
              failureKind: "http",
              httpStatus: response.status,
              errorMessage: failureMessage(`Fansly request failed (${response.status})`),
              responseMetadata: failureResponseMetadata,
              error: new FanslyApiError(
                failureMessage(`Fansly request failed (${response.status})`),
                response.status,
                envelope?.error?.code,
                responseSnippet,
                retryAfterAt,
              ),
            };
          }

          if (!envelope?.success || envelope.response === undefined) {
            return {
              kind: "failed",
              failureKind: "provider",
              httpStatus: response.status,
              errorMessage: failureMessage("Fansly response envelope was unsuccessful"),
              responseMetadata: failureResponseMetadata,
              error: new FanslyApiError(
                failureMessage("Fansly response envelope was unsuccessful"),
                response.status,
                envelope?.error?.code,
                responseSnippet,
              ),
            };
          }

          let responseMetadata: Record<string, unknown>;
          try {
            responseMetadata = options.summarizeResponse?.(envelope.response) ?? {};
          } catch {
            // Summaries are diagnostics, not the contract validator. Preserve the
            // response for ordered capture; never turn its contents (e.g. DM text)
            // or a decoder's exception message into a diagnostic snippet.
            responseMetadata = { summaryUnavailable: true };
          }
          return {
            kind: "success",
            value: {
              parsed: envelope.response,
              raw: envelope.response,
            },
            httpStatus: response.status,
            responseMetadata,
          };
        },
      });
    } finally {
      requestSettled = true;
      await releaseUnusedLease();
    }
  }

  private safeParseEnvelope<T>(text: string): FanslyEnvelope<T> | null {
    return parseFanslyEnvelope<T>(text);
  }

  private getDispatcher(proxy?: ProxyConfig | null) {
    // W3.1 (decision #124): fail closed. Every Fansly request funnels through
    // here; without the page's proxy it would egress from the shared VPS IP.
    // resolveStoredPageContext refuses first — this is the belt.
    if (!proxy) {
      throw new FanslyProxyMissingError();
    }
    return this.buildProxyDispatcher(proxy);
  }

  private buildProxyDispatcher(proxy: ProxyConfig) {
    const cacheKey = this.buildProxyCacheKey(proxy);
    const cached = this.proxyAgents.get(cacheKey);
    if (cached) {
      return cached;
    }

    const agent = createProxyRequestDispatcher(proxy);
    this.proxyAgents.set(cacheKey, agent);
    return agent;
  }

  private resetDispatcher(proxy?: ProxyConfig | null) {
    if (!proxy) {
      const previous = this.directDispatcher;
      this.directDispatcher = createRequestDispatcher();
      this.retireDispatcher(previous);
      return;
    }

    const cacheKey = this.buildProxyCacheKey(proxy);
    const previous = this.proxyAgents.get(cacheKey);
    const replacement = createProxyRequestDispatcher(proxy);
    this.proxyAgents.set(cacheKey, replacement);
    if (previous) {
      this.retireDispatcher(previous);
    }
  }

  private retireDispatcher(dispatcher: Dispatcher) {
    const closePromise: Promise<void> = dispatcher
      .close()
      .catch(() => undefined)
      .then(() => undefined)
      .finally(() => {
        this.retiringDispatchers.delete(closePromise);
      });
    this.retiringDispatchers.add(closePromise);
  }

  private buildProxyCacheKey(proxy: ProxyConfig) {
    return buildProxyDispatcherCacheKey(proxy);
  }

  /**
   * The legacy endpoint pauses (`followers_page`, `dm_conversations`,
   * `dm_messages`), which stay until the guard has passed its acceptance
   * (plan §2.5 p.4). The page-wide spacing is no longer here: the send guard
   * replaced the per-egress `global` scope and its +100 ms.
   */
  private async waitForEndpointPause(
    context: FanslyRequestContext,
    category: string,
    minDelayMs: number,
  ) {
    const scopes: Array<{ provider: "fansly" | "onlyfans"; scope: string }> = [
      ...(category === "followers" && minDelayMs > 0
        ? [{ provider: "fansly", scope: "followers_page" } as const]
        : []),
      ...(category === "dm_conversations"
        ? [{ provider: "fansly", scope: "dm_conversations" } as const]
        : []),
      ...(category === "dm_messages"
        ? [{ provider: "fansly", scope: "dm_messages" } as const]
        : []),
    ];

    if (context.rateLimitWaiter) {
      return scopes.length === 0 ? 0 : context.rateLimitWaiter(scopes);
    }

    // No shared limiter in this process: the category's own minimum delay,
    // kept in process memory.
    const egressKey = context.egressKey ?? buildProxyEgressKey(context.proxy);
    const categoryKey = `${egressKey}:${category}`;

    const categoryGate = this.enterRateLimitChain(this.rateLimitChains.get(categoryKey) ?? Promise.resolve());
    this.rateLimitChains.set(categoryKey, categoryGate.chain);

    try {
      await waitForHttpRequestPermit(() => categoryGate.previous);
      assertHttpRequestActive();
      const categoryWaitMs = await this.waitForMinimumDelay(
        this.requestTimestamps.get(categoryKey),
        minDelayMs,
      );
      assertHttpRequestActive();
      this.requestTimestamps.set(categoryKey, Date.now());
      return categoryWaitMs;
    } finally {
      categoryGate.release();
      // A cancelled waiter may still follow an occupied predecessor. Keep
      // that chain visible until it settles, or a third caller could bypass
      // the predecessor's pacing slot.
      void categoryGate.chain.then(() => {
        if (this.rateLimitChains.get(categoryKey) === categoryGate.chain) {
          this.rateLimitChains.delete(categoryKey);
        }
      });
    }
  }

  private enterRateLimitChain(previous: Promise<void>) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      previous,
      chain: previous.then(() => gate),
      release,
    };
  }

  private async waitForMinimumDelay(lastStartedAt: number | null | undefined, minDelayMs: number) {
    if (lastStartedAt === null || lastStartedAt === undefined || minDelayMs <= 0) {
      return 0;
    }

    const elapsed = Date.now() - lastStartedAt;
    if (elapsed >= minDelayMs) {
      return 0;
    }

    const waitedMs = minDelayMs - elapsed;
    await waitForHttpRequestDelay(waitedMs);
    return waitedMs;
  }
}
