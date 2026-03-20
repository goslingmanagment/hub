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
  formatObservedError,
  resolveRetryDelayMs,
  type FanslySessionBundle,
  type ProxyConfig,
} from "@agency_hub_core/shared";

import { FanslyApiError } from "./errors.ts";
import type {
  FanslyAccount,
  FanslyAccountMeResponse,
  FanslyFollowersPage,
  FanslyGroupDetail,
  FanslyMessagesPage,
  FanslyMessagesPageResponse,
  FanslyMessagingGroupsPage,
  FanslyMessagingGroupsPageResponse,
  FanslyRequestContext,
  FanslySubscribersPage,
  FanslyTransactionsPage,
} from "./types.ts";

interface AdapterOptions {
  baseUrl: string;
  globalDelayMs?: number;
}

type ApiEnvelope<T> = {
  success: boolean;
  response?: T;
  error?: {
    code?: number;
    message?: string;
    details?: string;
  };
};

type RequestResult<T> = {
  parsed: T;
  raw: T;
};

const REQUEST_TIMEOUT_MS = 30_000;
const GLOBAL_DELAY_SAFETY_MARGIN_MS = 100;

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

  async getTransactionsPage(
    context: FanslyRequestContext,
    params: {
      after?: Date | null;
      before?: Date | null;
      limit?: number;
      offset?: number;
    },
  ) {
    const response = await this.request<FanslyTransactionsPage>(
      context,
      "/account/wallets/earnings/transactions",
      {
        operation: "earnings_transactions",
        endpointTemplate: "/account/wallets/earnings/transactions",
        query: {
          after: params.after ? String(params.after.getTime()) : undefined,
          before: params.before ? String(params.before.getTime()) : undefined,
          limit: params.limit ? String(params.limit) : undefined,
          offset: params.offset ? String(params.offset) : undefined,
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
        summarizeResponse: (parsed) => ({
          total: parsed.total,
          returnedItems: parsed.data.length,
          done: parsed.data.length < (params.limit ?? 100),
        }),
      },
    );

    const limit = params.limit ?? 100;
    return {
      total: response.parsed.total,
      items: response.parsed.data,
      offset: params.offset ?? 0,
      done: response.parsed.data.length < limit,
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
    const response = await this.request<FanslySubscribersPage>(context, "/subscribers", {
      operation: "subscribers",
      endpointTemplate: "/subscribers",
      query: {
        offset: params.offset ? String(params.offset) : undefined,
        limit: params.limit ? String(params.limit) : undefined,
        after: params.after ? String(params.after.getTime()) : undefined,
        before: params.before ? String(params.before.getTime()) : undefined,
        status: params.status ?? "3,4",
      },
      category: "subscribers",
      requestShape: {
        offset: params.offset ?? 0,
        limit: params.limit ?? 100,
        after: params.after ? params.after.toISOString() : null,
        before: params.before ? params.before.toISOString() : null,
        status: params.status ?? "3,4",
      },
      pagination: {
        offset: params.offset ?? 0,
        limit: params.limit ?? 100,
      },
      summarizeResponse: (parsed) => ({
        total: parsed.stats.total,
        totalActive: parsed.stats.totalActive,
        returnedItems: parsed.subscriptions.length,
        done: parsed.subscriptions.length < (params.limit ?? 100),
      }),
    });

    const limit = params.limit ?? 100;
    return {
      total: response.parsed.stats.total,
      items: response.parsed.subscriptions,
      offset: params.offset ?? 0,
      done: response.parsed.subscriptions.length < limit,
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
          offset: params.offset ? String(params.offset) : undefined,
          limit: params.limit ? String(params.limit) : undefined,
          after: params.after ?? undefined,
          before: params.before ?? undefined,
        },
        category: "followers",
        minDelayMs: params.minDelayMs,
        requestShape: {
          offset: params.offset ?? 0,
          limit: params.limit ?? 100,
          afterPresent: Boolean(params.after),
          beforePresent: Boolean(params.before),
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
        offset: params.offset ? String(params.offset) : undefined,
        limit: params.limit ? String(params.limit) : undefined,
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
        limit: params.limit ? String(params.limit) : undefined,
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
            errorMessage: formatObservedError(error),
            error,
          };
        }

        return {
          kind: "failed",
          failureKind,
          errorMessage: formatObservedError(error),
          error,
        };
      },
      onResponse: ({ response, text, envelope }, executionContext) => {
        const envelopeMessage = envelope?.error?.message;

        if (response.status === 401 || response.status === 403) {
          return {
            kind: "failed",
            failureKind: "http",
            httpStatus: response.status,
            errorMessage: envelopeMessage ?? `Fansly authorization failed (${response.status})`,
            error: new FanslyApiError(
              envelopeMessage ?? `Fansly authorization failed (${response.status})`,
              response.status,
              envelope?.error?.code,
              text.slice(0, 400),
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
            errorMessage: envelopeMessage ?? `Fansly request failed (${response.status})`,
          };
        }

        if (!response.ok) {
          return {
            kind: "failed",
            failureKind: "http",
            httpStatus: response.status,
            errorMessage: envelopeMessage ?? `Fansly request failed (${response.status})`,
            error: new FanslyApiError(
              envelopeMessage ?? `Fansly request failed (${response.status})`,
              response.status,
              envelope?.error?.code,
              text.slice(0, 400),
            ),
          };
        }

        if (!envelope?.success || envelope.response === undefined) {
          return {
            kind: "failed",
            failureKind: "provider",
            httpStatus: response.status,
            errorMessage: envelopeMessage ?? "Fansly response envelope was unsuccessful",
            error: new FanslyApiError(
              envelopeMessage ?? "Fansly response envelope was unsuccessful",
              response.status,
              envelope?.error?.code,
              text.slice(0, 400),
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
      return JSON.parse(text) as ApiEnvelope<T>;
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
    return proxy ? this.buildProxyDispatcher(proxy) : this.directDispatcher;
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
    let closePromise!: Promise<void>;
    closePromise = dispatcher
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

    const egressKey = buildProxyEgressKey(context.proxy);
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
  return 5000 * attemptNumber;
}
