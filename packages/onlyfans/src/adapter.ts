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
  OnlyMonsterCursorResponse,
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

    const rateLimitKey = `${buildProxyEgressKey(context.proxy)}:${category}`;

    const previous = this.rateLimitChains.get(rateLimitKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => gate);
    this.rateLimitChains.set(rateLimitKey, chain);

    await previous;
    try {
      const lastStartedAt = this.requestTimestamps.get(rateLimitKey);
      const now = Date.now();
      let waitedMs = 0;
      if (lastStartedAt !== undefined) {
        const elapsed = now - lastStartedAt;
        if (elapsed < minDelayMs) {
          waitedMs = minDelayMs - elapsed;
          await delay(waitedMs);
        }
      }
      this.requestTimestamps.set(rateLimitKey, Date.now());
      return waitedMs;
    } finally {
      release();
      if (this.rateLimitChains.get(rateLimitKey) === chain) {
        this.rateLimitChains.delete(rateLimitKey);
      }
    }
  }
}

function retryDelayMs(attemptNumber: number) {
  return 5000 * attemptNumber;
}
