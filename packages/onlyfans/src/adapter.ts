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
  type ProxyConfig,
} from "@agency_hub_core/shared";

import { OnlyMonsterApiError } from "./errors.ts";
import type {
  OnlyFansRequestContext,
  OnlyMonsterAccount,
  OnlyMonsterAccountResponse,
  OnlyMonsterAccountsResponse,
  OnlyMonsterChargeback,
  OnlyMonsterChatFansResponse,
  OnlyMonsterChatMessagesResponse,
  OnlyMonsterCursorResponse,
  OnlyMonsterLinkUser,
  OnlyMonsterTransaction,
} from "./types.ts";

interface AdapterOptions {
  baseUrl: string;
  defaultDelayMs?: number;
}

type RequestResult<TParsed, TRaw = TParsed> = {
  parsed: TParsed;
  raw: TRaw;
};

const REQUEST_TIMEOUT_MS = 30_000;

export class OnlyFansAdapter {
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

  async listAccountsPage(
    context: OnlyFansRequestContext,
    params?: {
      cursor?: string | null;
      limit?: number;
      pageIndex?: number;
    },
  ) {
    return this.request<OnlyMonsterAccountsResponse>(context, "/api/v0/accounts", {
      operation: "onlymonster_accounts",
      endpointTemplate: "/api/v0/accounts",
      category: "accounts",
      query: {
        cursor: params?.cursor ?? undefined,
        limit: params?.limit ? String(params.limit) : undefined,
      },
      requestShape: {
        cursorPresent: Boolean(params?.cursor),
        limit: params?.limit ?? null,
      },
      pagination: {
        pageIndex: params?.pageIndex ?? 0,
        cursorPresent: Boolean(params?.cursor),
      },
      summarizeResponse: (parsed) => ({
        returnedItems: parsed.accounts.length,
        cursorPresent: Boolean(parsed.nextCursor),
      }),
    });
  }

  async getAccount(context: OnlyFansRequestContext, accountId: number) {
    return this.request<OnlyMonsterAccountResponse>(
      context,
      `/api/v0/accounts/${accountId}`,
      {
        operation: "onlymonster_account",
        endpointTemplate: "/api/v0/accounts/:accountId",
        category: "accounts",
        requestShape: {},
        summarizeResponse: (parsed) => ({
          accountId: parsed.account.platform_account_id,
          username: parsed.account.username,
        }),
      },
    );
  }

  async getTransactionsPage(
    context: OnlyFansRequestContext,
    platformAccountId: string,
    params: {
      start: Date;
      end: Date;
      cursor?: string | null;
      limit?: number;
      pageIndex?: number;
    },
  ) {
    return this.request<OnlyMonsterCursorResponse<OnlyMonsterTransaction>>(
      context,
      `/api/v0/platforms/onlyfans/accounts/${platformAccountId}/transactions`,
      {
        operation: "onlymonster_transactions",
        endpointTemplate: "/api/v0/platforms/onlyfans/accounts/:platformAccountId/transactions",
        category: "transactions",
        query: {
          start: params.start.toISOString(),
          end: params.end.toISOString(),
          cursor: params.cursor ?? undefined,
          limit: params.limit ? String(params.limit) : undefined,
        },
        requestShape: {
          start: params.start.toISOString(),
          end: params.end.toISOString(),
          cursorPresent: Boolean(params.cursor),
          limit: params.limit ?? 100,
        },
        pagination: {
          pageIndex: params.pageIndex ?? 0,
          cursorPresent: Boolean(params.cursor),
        },
        summarizeResponse: (parsed) => ({
          returnedItems: parsed.items.length,
          cursorPresent: Boolean(parsed.cursor),
        }),
      },
    );
  }

  async getChargebacksPage(
    context: OnlyFansRequestContext,
    platformAccountId: string,
    params: {
      start: Date;
      end: Date;
      cursor?: string | null;
      limit?: number;
      pageIndex?: number;
    },
  ) {
    return this.request<OnlyMonsterCursorResponse<OnlyMonsterChargeback>>(
      context,
      `/api/v0/platforms/onlyfans/accounts/${platformAccountId}/chargebacks`,
      {
        operation: "onlymonster_chargebacks",
        endpointTemplate: "/api/v0/platforms/onlyfans/accounts/:platformAccountId/chargebacks",
        category: "chargebacks",
        query: {
          start: params.start.toISOString(),
          end: params.end.toISOString(),
          cursor: params.cursor ?? undefined,
          limit: params.limit ? String(params.limit) : undefined,
        },
        requestShape: {
          start: params.start.toISOString(),
          end: params.end.toISOString(),
          cursorPresent: Boolean(params.cursor),
          limit: params.limit ?? 100,
        },
        pagination: {
          pageIndex: params.pageIndex ?? 0,
          cursorPresent: Boolean(params.cursor),
        },
        summarizeResponse: (parsed) => ({
          returnedItems: parsed.items.length,
          cursorPresent: Boolean(parsed.cursor),
        }),
      },
    );
  }

  async getTrackingLinkUsersPage(
    context: OnlyFansRequestContext,
    platformAccountId: string,
    params?: {
      collectedFrom?: Date | null;
      collectedTo?: Date | null;
      cursor?: string | null;
      limit?: number;
      linkId?: string | null;
      pageIndex?: number;
    },
  ) {
    return this.getLinkUsersPage(
      context,
      platformAccountId,
      "tracking",
      params,
    );
  }

  async getTrialLinkUsersPage(
    context: OnlyFansRequestContext,
    platformAccountId: string,
    params?: {
      collectedFrom?: Date | null;
      collectedTo?: Date | null;
      cursor?: string | null;
      limit?: number;
      linkId?: string | null;
      pageIndex?: number;
    },
  ) {
    return this.getLinkUsersPage(
      context,
      platformAccountId,
      "trial",
      params,
    );
  }

  async getRecentChatFanIds(
    context: OnlyFansRequestContext,
    accountId: number,
    params?: {
      limit?: number;
    },
  ) {
    return this.request<OnlyMonsterChatFansResponse>(
      context,
      `/api/v0/accounts/${accountId}/fans`,
      {
        operation: "onlymonster_chat_fans",
        endpointTemplate: "/api/v0/accounts/:accountId/fans",
        category: "messages",
        query: {
          limit: params?.limit ? String(params.limit) : undefined,
        },
        requestShape: {
          limit: params?.limit ?? 10000,
        },
        summarizeResponse: (parsed) => ({
          returnedItems: parsed.fan_ids.length,
        }),
      },
    );
  }

  async getChatMessagesPage(
    context: OnlyFansRequestContext,
    accountId: number,
    chatId: string,
    params?: {
      limit?: number;
      messageId?: number | string | null;
      order?: "asc" | "desc";
      pageIndex?: number;
    },
  ) {
    return this.request<OnlyMonsterChatMessagesResponse>(
      context,
      `/api/v0/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages`,
      {
        operation: "messages",
        endpointTemplate: "/api/v0/accounts/:accountId/chats/:chatId/messages",
        category: "messages",
        query: {
          limit: params?.limit ? String(params.limit) : undefined,
          message_id: params?.messageId != null ? String(params.messageId) : undefined,
          order: params?.order,
        },
        requestShape: {
          limit: params?.limit ?? 100,
          hasMessageId: params?.messageId != null,
          order: params?.order ?? null,
        },
        pagination: {
          pageIndex: params?.pageIndex ?? 0,
          cursorPresent: params?.messageId != null,
        },
        summarizeResponse: (parsed) => ({
          returnedItems: parsed.items.length,
          hasMore: parsed.has_more ?? null,
        }),
      },
    );
  }

  private async getLinkUsersPage(
    context: OnlyFansRequestContext,
    platformAccountId: string,
    linkKind: "tracking" | "trial",
    params?: {
      collectedFrom?: Date | null;
      collectedTo?: Date | null;
      cursor?: string | null;
      limit?: number;
      linkId?: string | null;
      pageIndex?: number;
    },
  ) {
    const endpointSuffix = linkKind === "tracking"
      ? "tracking-link-users"
      : "trial-link-users";
    return this.request<OnlyMonsterCursorResponse<OnlyMonsterLinkUser>>(
      context,
      `/api/v0/platforms/onlyfans/accounts/${platformAccountId}/${endpointSuffix}`,
      {
        operation: `onlymonster_${linkKind}_link_users`,
        endpointTemplate: `/api/v0/platforms/onlyfans/accounts/:platformAccountId/${endpointSuffix}`,
        category: "statistics",
        query: {
          collected_from: params?.collectedFrom?.toISOString(),
          collected_to: params?.collectedTo?.toISOString(),
          cursor: params?.cursor ?? undefined,
          limit: params?.limit ? String(params.limit) : undefined,
          link_id: params?.linkId ?? undefined,
        },
        requestShape: {
          collectedFromPresent: Boolean(params?.collectedFrom),
          collectedToPresent: Boolean(params?.collectedTo),
          cursorPresent: Boolean(params?.cursor),
          limit: params?.limit ?? 100,
          linkIdPresent: Boolean(params?.linkId),
        },
        pagination: {
          pageIndex: params?.pageIndex ?? 0,
          cursorPresent: Boolean(params?.cursor),
        },
        summarizeResponse: (parsed) => ({
          returnedItems: parsed.items.length,
          cursorPresent: Boolean(parsed.cursor),
        }),
      },
    );
  }

  private async request<TParsed>(
    context: OnlyFansRequestContext,
    pathname: string,
    options: {
      operation: string;
      endpointTemplate: string;
      category: string;
      query?: Record<string, string | undefined>;
      retries?: number;
      minDelayMs?: number;
      requestShape?: Record<string, unknown>;
      pagination?: {
        offset?: number | null;
        limit?: number | null;
        pageIndex?: number | null;
        cursorPresent?: boolean | null;
      };
      summarizeResponse?: (parsed: TParsed) => Record<string, unknown>;
    },
  ): Promise<RequestResult<TParsed>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        query.set(key, value);
      }
    }

    const url = `${this.options.baseUrl}${pathname}${query.size > 0 ? `?${query.toString()}` : ""}`;
    const retries = options.retries ?? 3;
    const minDelayMs = options.minDelayMs ?? this.options.defaultDelayMs ?? 1000;
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
          headers: {
            accept: "application/json",
            "x-om-auth-token": context.auth.token,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          dispatcher: this.getDispatcher(context.proxy),
        });
        const text = await response.text();
        return {
          response,
          text,
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
      onResponse: ({ response, text }, executionContext) => {
        if (response.status === 401 || response.status === 403) {
          return {
            kind: "failed",
            failureKind: "http",
            httpStatus: response.status,
            errorMessage: `OnlyMonster authorization failed (${response.status})`,
            error: new OnlyMonsterApiError(
              `OnlyMonster authorization failed (${response.status})`,
              response.status,
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
            errorMessage: `OnlyMonster request failed (${response.status})`,
          };
        }

        if (!response.ok) {
          return {
            kind: "failed",
            failureKind: "http",
            httpStatus: response.status,
            errorMessage: `OnlyMonster request failed (${response.status})`,
            error: new OnlyMonsterApiError(
              `OnlyMonster request failed (${response.status})`,
              response.status,
              text.slice(0, 400),
            ),
          };
        }

        try {
          const parsed = JSON.parse(text) as TParsed;
          return {
            kind: "success",
            value: {
              parsed,
              raw: parsed,
            },
            httpStatus: response.status,
            responseMetadata: options.summarizeResponse?.(parsed) ?? {},
          };
        } catch {
          return {
            kind: "failed",
            failureKind: "provider",
            httpStatus: response.status,
            errorMessage: "OnlyMonster response was not valid JSON",
            error: new OnlyMonsterApiError(
              "OnlyMonster response was not valid JSON",
              response.status,
              text.slice(0, 400),
            ),
          };
        }
      },
    });
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
    context: OnlyFansRequestContext,
    category: string,
    minDelayMs: number,
  ) {
    if (context.rateLimitWaiter) {
      return context.rateLimitWaiter([
        { provider: "onlyfans", scope: "global" },
      ]);
    }

    const egressKey = buildProxyEgressKey(context.proxy);
    const categoryKey = `${egressKey}:${category}`;
    const globalKey = egressKey;
    const categoryGate = this.enterRateLimitChain(this.rateLimitChains.get(categoryKey) ?? Promise.resolve());
    this.rateLimitChains.set(categoryKey, categoryGate.chain);

    await categoryGate.previous;
    try {
      const globalGate = this.enterRateLimitChain(this.rateLimitChains.get(globalKey) ?? Promise.resolve());
      this.rateLimitChains.set(globalKey, globalGate.chain);

      await globalGate.previous;
      try {
        const waitedMs = await this.waitForMinimumDelay(
          this.requestTimestamps.get(globalKey),
          minDelayMs,
        );
        const startedAt = Date.now();
        this.requestTimestamps.set(globalKey, startedAt);
        return waitedMs;
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
