import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { fetch, type Dispatcher } from "undici";

import {
  buildProxyEgressKey,
  buildProxyDispatcherCacheKey,
  classifyTransportError,
  createProxyRequestDispatcher,
  createRequestDispatcher,
  executeObservedRequest,
  millsFromInteger,
  sanitizeError,
  redactSensitiveText,
  resolveRetryDelayMs,
  type FanslySessionBundle,
  type ProxyConfig,
} from "@agency_hub_core/shared";

import { FanslyApiError, FanslyProxyMissingError } from "./errors.ts";
import type {
  FanslyAccount,
  FanslyAccountList,
  FanslyAccountListsResponse,
  FanslyAccountMeResponse,
  FanslyEarningsAccount,
  FanslyEarningsAccountsPageResponse,
  FanslyEarningsOverview,
  FanslyEarningsOverviewResponse,
  FanslyFollowersPage,
  FanslyGroupDetail,
  FanslyListItem,
  FanslyListItemsPageResponse,
  FanslyMessagesPage,
  FanslyMessagesPageResponse,
  FanslyMessagingGroupsPage,
  FanslyMessagingGroupsPageResponse,
  FanslyPostsPage,
  FanslyPostsPageResponse,
  FanslyRequestContext,
  FanslySubscribersPage,
  FanslyTrackingLink,
  FanslyTrackingLinksResponse,
  FanslyTransactionsPage,
} from "./types.ts";

interface AdapterOptions {
  baseUrl: string;
  globalDelayMs?: number;
}

type ApiEnvelope<T> = {
  success?: boolean;
  response?: T;
  error?: {
    code?: number;
    message?: string;
    details?: string;
    [key: string]: unknown;
  } | null;
};

type RequestResult<T> = {
  parsed: T;
  raw: T;
};

const REQUEST_TIMEOUT_MS = 30_000;
const GLOBAL_DELAY_SAFETY_MARGIN_MS = 100;
const EARNINGS_ACCOUNTS_PAGE_LIMIT = 100;

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

function isApiError(value: unknown): value is NonNullable<ApiEnvelope<unknown>["error"]> {
  return isRecord(value) &&
    (value.code === undefined ||
      (typeof value.code === "number" && Number.isFinite(value.code))) &&
    (value.message === undefined || typeof value.message === "string") &&
    (value.details === undefined || typeof value.details === "string");
}

function isApiEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  return isRecord(value) &&
    (value.success === undefined || typeof value.success === "boolean") &&
    (value.error === undefined || value.error === null || isApiError(value.error));
}

function parseFanslyTransactionsPage(value: unknown): FanslyTransactionsPage | null {
  if (
    !isRecord(value) ||
    typeof value.total !== "number" ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0 ||
    !Array.isArray(value.data)
  ) {
    return null;
  }

  return {
    total: value.total,
    data: value.data as FanslyTransactionsPage["data"],
  };
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

  async getTransactionsPage(
    context: FanslyRequestContext,
    params: {
      after?: Date | null;
      before?: Date | null;
      limit?: number;
      offset?: number;
    },
  ) {
    const limit = params.limit ?? 100;
    const response = await this.request<unknown>(
      context,
      "/account/wallets/earnings/transactions",
      {
        operation: "earnings_transactions",
        endpointTemplate: "/account/wallets/earnings/transactions",
        query: {
          after: params.after ? String(params.after.getTime()) : undefined,
          before: params.before ? String(params.before.getTime()) : undefined,
          limit: params.limit != null ? String(params.limit) : undefined,
          offset: params.offset != null ? String(params.offset) : undefined,
        },
        category: "transactions",
        requestShape: {
          after: params.after ? params.after.toISOString() : null,
          before: params.before ? params.before.toISOString() : null,
          limit: params.limit ?? 100,
          offset: params.offset ?? 0,
        },
        pagination: {
          offset: params.offset ?? 0,
          limit: params.limit ?? 100,
        },
        summarizeResponse: (parsed) => {
          const accepted = parseFanslyTransactionsPage(parsed);
          return {
            total: accepted?.total ?? null,
            returnedItems: accepted?.data.length ?? null,
            done: accepted ? accepted.data.length < limit : null,
            contractAccepted: accepted !== null,
          };
        },
      },
    );

    const parsed = parseFanslyTransactionsPage(response.parsed);
    return {
      total: parsed?.total ?? null,
      items: parsed?.data ?? [],
      offset: params.offset ?? 0,
      done: parsed ? parsed.data.length < limit : false,
      contractAccepted: parsed !== null,
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
    const response = await this.request<FanslySubscribersPage>(context, "/subscribers", {
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
      summarizeResponse: (parsed) => ({
        total: status === "5"
          ? parsed.stats.totalExpired
          : status === "3,4"
            ? parsed.stats.totalActive
            : parsed.stats.total,
        totalActive: parsed.stats.totalActive,
        totalExpired: parsed.stats.totalExpired,
        returnedItems: parsed.subscriptions.length,
        done: parsed.subscriptions.length < (params.limit ?? 100) ||
          (params.offset ?? 0) + parsed.subscriptions.length >= (
            status === "5"
              ? parsed.stats.totalExpired
              : status === "3,4"
                ? parsed.stats.totalActive
                : parsed.stats.total
          ),
      }),
    });

    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;
    const total = status === "5"
      ? response.parsed.stats.totalExpired
      : status === "3,4"
        ? response.parsed.stats.totalActive
        : response.parsed.stats.total;
    return {
      total,
      items: response.parsed.subscriptions,
      offset,
      done: response.parsed.subscriptions.length < limit ||
        offset + response.parsed.subscriptions.length >= total,
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
    const response = await this.request<FanslyFollowersPage>(
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
        summarizeResponse: (parsed) => ({
          returnedItems: parsed.followers.length,
          accountCount: parsed.aggregationData?.accounts?.length ?? 0,
          done: parsed.followers.length < (params.limit ?? 100),
        }),
      },
    );

    const limit = params.limit ?? 100;
    return {
      items: response.parsed.followers,
      total: response.parsed.followers.length,
      offset: params.offset ?? 0,
      done: response.parsed.followers.length < limit,
      accounts: response.parsed.aggregationData?.accounts ?? [],
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
    const response = await this.request<FanslyMessagingGroupsPage>(context, "/messaging/groups", {
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
      summarizeResponse: (parsed) => ({
        total: parsed.aggregationData?.total ?? null,
        returnedItems: parsed.data.length,
        accountCount: parsed.aggregationData?.accounts?.length ?? 0,
        groupCount: parsed.aggregationData?.groups?.length ?? 0,
        done: parsed.data.length < (params.limit ?? 100),
      }),
    });

    const limit = params.limit ?? 100;
    return {
      total: response.parsed.aggregationData?.total,
      items: response.parsed.data,
      offset: params.offset ?? 0,
      done: response.parsed.data.length < limit,
      accounts: response.parsed.aggregationData?.accounts ?? [],
      groups: response.parsed.aggregationData?.groups ?? [],
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
    const response = await this.request<FanslyMessagesPage>(context, "/message", {
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
      summarizeResponse: (parsed) => ({
        groupId: params.groupId,
        returnedItems: parsed.messages.length,
        done: parsed.messages.length < (params.limit ?? 25),
      }),
    });

    const limit = params.limit ?? 25;
    return {
      items: response.parsed.messages,
      groupId: params.groupId,
      before: params.before ?? null,
      done: response.parsed.messages.length < limit,
      raw: response.raw,
    };
  }

  async verifySession(context: FanslyRequestContext) {
    return this.getAccountMe(context);
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
    const retries = options.retries ?? 3;
    const minDelayMs = options.minDelayMs ?? 0;
    const requestId = `${options.operation}:${randomUUID()}`;

    return executeObservedRequest({
      observer: context.requestObserver,
      requestId,
      operation: options.operation,
      endpointTemplate: options.endpointTemplate,
      method: "GET",
      pagination: options.pagination ?? null,
      requestMetadata: options.requestShape ?? {},
      retries,
      waitForRateLimit: () => this.waitForRateLimit(context, options.category, minDelayMs),
      execute: async () => {
        const response = await fetch(url, {
          method: "GET",
          headers: this.buildHeaders(context.session),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          dispatcher: this.getDispatcher(context.proxy),
        });
        const text = await response.text();
        return {
          response,
          text,
          envelope: this.safeParseEnvelope<T>(text),
        };
      },
      onTransportError: (error, executionContext) => {
        const failureKind = classifyTransportError(error);
        if (failureKind === "transport") {
          this.resetDispatcher(context.proxy);
        }

        if (executionContext.retriesRemaining > 0) {
          return {
            kind: "retry",
            failureKind,
            retryDelayMs: retryDelayMs(executionContext.attemptNumber),
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
        const responseSnippet = redactSensitiveText(text.slice(0, 400));
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
            errorMessage: envelopeMessage ?? `Fansly authorization failed (${response.status})`,
            responseMetadata: failureResponseMetadata,
            error: new FanslyApiError(
              envelopeMessage ?? `Fansly authorization failed (${response.status})`,
              response.status,
              envelope?.error?.code,
              responseSnippet,
            ),
          };
        }

        if ([429, 500, 502, 503, 504].includes(response.status) && executionContext.retriesRemaining > 0) {
          return {
            kind: "retry",
            failureKind: "http",
            httpStatus: response.status,
            retryDelayMs: resolveRetryDelayMs(
              response.headers.get("retry-after"),
              executionContext.attemptNumber,
            ),
            responseMetadata: failureResponseMetadata,
            errorMessage: envelopeMessage ?? `Fansly request failed (${response.status})`,
          };
        }

        if (!response.ok) {
          return {
            kind: "failed",
            failureKind: "http",
            httpStatus: response.status,
            errorMessage: envelopeMessage ?? `Fansly request failed (${response.status})`,
            responseMetadata: failureResponseMetadata,
            error: new FanslyApiError(
              envelopeMessage ?? `Fansly request failed (${response.status})`,
              response.status,
              envelope?.error?.code,
              responseSnippet,
            ),
          };
        }

        if (!envelope?.success || envelope.response === undefined) {
          return {
            kind: "failed",
            failureKind: "provider",
            httpStatus: response.status,
            errorMessage: envelopeMessage ?? "Fansly response envelope was unsuccessful",
            responseMetadata: failureResponseMetadata,
            error: new FanslyApiError(
              envelopeMessage ?? "Fansly response envelope was unsuccessful",
              response.status,
              envelope?.error?.code,
              responseSnippet,
            ),
          };
        }

        return {
          kind: "success",
          value: {
            parsed: envelope.response,
            raw: envelope.response,
          },
          httpStatus: response.status,
          responseMetadata: options.summarizeResponse?.(envelope.response) ?? {},
        };
      },
    });
  }

  private safeParseEnvelope<T>(text: string): ApiEnvelope<T> | null {
    try {
      const parsed: unknown = JSON.parse(text);
      return isApiEnvelope(parsed) ? parsed as ApiEnvelope<T> : null;
    } catch {
      return null;
    }
  }

  private buildHeaders(session: FanslySessionBundle) {
    const headers: Record<string, string> = {
      authorization: session.authorization,
      "fansly-client-ts": String(Date.now()),
      accept: "application/json, text/plain, */*",
      referrer: "https://fansly.com/",
    };

    if (session.fanslyClientId) {
      headers["fansly-client-id"] = session.fanslyClientId;
    }

    if (session.fanslyClientCheck) {
      headers["fansly-client-check"] = session.fanslyClientCheck;
    }

    if (session.fanslySessionId) {
      headers["fansly-session-id"] = session.fanslySessionId;
    }

    return headers;
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

  private async waitForRateLimit(
    context: FanslyRequestContext,
    category: string,
    minDelayMs: number,
  ) {
    const scopes: Array<{ provider: "fansly" | "onlyfans"; scope: string }> = [
      { provider: "fansly", scope: "global" },
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
      return context.rateLimitWaiter(scopes);
    }

    const egressKey = context.egressKey ?? buildProxyEgressKey(context.proxy);
    const categoryKey = `${egressKey}:${category}`;
    const globalKey = egressKey;

    const categoryGate = this.enterRateLimitChain(this.rateLimitChains.get(categoryKey) ?? Promise.resolve());
    this.rateLimitChains.set(categoryKey, categoryGate.chain);

    await categoryGate.previous;
    try {
      const categoryWaitMs = await this.waitForMinimumDelay(
        this.requestTimestamps.get(categoryKey),
        minDelayMs,
      );
      const globalGate = this.enterRateLimitChain(this.rateLimitChains.get(globalKey) ?? Promise.resolve());
      this.rateLimitChains.set(globalKey, globalGate.chain);

      await globalGate.previous;
      try {
        const configuredGlobalDelayMs = this.options.globalDelayMs ?? 2500;
        const effectiveGlobalDelayMs = configuredGlobalDelayMs > 0
          ? configuredGlobalDelayMs + GLOBAL_DELAY_SAFETY_MARGIN_MS
          : 0;
        const globalWaitMs = await this.waitForMinimumDelay(
          this.requestTimestamps.get(globalKey),
          effectiveGlobalDelayMs,
        );
        const startedAt = Date.now();
        this.requestTimestamps.set(categoryKey, startedAt);
        this.requestTimestamps.set(globalKey, startedAt);
        return categoryWaitMs + globalWaitMs;
      } finally {
        globalGate.release();
        if (this.rateLimitChains.get(globalKey) === globalGate.chain) {
          this.rateLimitChains.delete(globalKey);
        }
      }
    } finally {
      categoryGate.release();
      if (this.rateLimitChains.get(categoryKey) === categoryGate.chain) {
        this.rateLimitChains.delete(categoryKey);
      }
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
    await delay(waitedMs);
    return waitedMs;
  }
}

function retryDelayMs(attemptNumber: number) {
  const delay = 5000 * attemptNumber;
  // Jitter the transport-retry backoff so concurrent failures on a shared
  // egress don't all reconnect on the same boundary (thundering herd).
  return Math.round(delay * (0.5 + Math.random() * 0.5));
}
