import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { fetch, ProxyAgent } from "undici";

import {
  executeObservedRequest,
  type FanslySessionBundle,
  type ProxyConfig,
} from "@fansly-connect/shared";

import { FanslyApiError } from "./errors.ts";
import type {
  FanslyAccount,
  FanslyAccountMeResponse,
  FanslyFollowersPage,
  FanslyRequestContext,
  FanslySubscribersPage,
  FanslyTransactionsPage,
} from "./types.ts";

interface AdapterOptions {
  baseUrl: string;
  defaultDelayMs?: number;
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

function classifyTransportError(error: unknown) {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout" as const;
  }

  return "transport" as const;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export class FanslyAdapter {
  private readonly requestTimestamps = new Map<string, number>();
  private readonly rateLimitChains = new Map<string, Promise<void>>();
  private readonly proxyAgents = new Map<string, ProxyAgent>();

  constructor(private readonly options: AdapterOptions) {}

  async close() {
    await Promise.all(Array.from(this.proxyAgents.values(), (agent) => agent.close()));
    this.proxyAgents.clear();
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
      waitForRateLimit: () => this.waitForRateLimit(options.category, minDelayMs),
      execute: async () => {
        const response = await fetch(url, {
          method: "GET",
          headers: this.buildHeaders(context.session),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          dispatcher: context.proxy ? this.buildProxyDispatcher(context.proxy) : undefined,
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
        if (executionContext.retriesRemaining > 0) {
          return {
            kind: "retry",
            failureKind,
            retryDelayMs: retryDelayMs(executionContext.attemptNumber),
            errorMessage: errorMessage(error),
            error,
          };
        }

        return {
          kind: "failed",
          failureKind,
          errorMessage: errorMessage(error),
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
          const retryAfterSeconds = Number(response.headers.get("retry-after") ?? "0");
          return {
            kind: "retry",
            failureKind: "http",
            httpStatus: response.status,
            retryDelayMs: retryAfterSeconds > 0
              ? retryAfterSeconds * 1000
              : retryDelayMs(executionContext.attemptNumber),
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

  private buildProxyDispatcher(proxy: ProxyConfig) {
    const proxyUrl = new URL(proxy.url);
    if (proxy.username && proxy.password) {
      proxyUrl.username = proxy.username;
      proxyUrl.password = proxy.password;
    }

    const cacheKey = proxyUrl.toString();
    const cached = this.proxyAgents.get(cacheKey);
    if (cached) {
      return cached;
    }

    const agent = new ProxyAgent(cacheKey);
    this.proxyAgents.set(cacheKey, agent);
    return agent;
  }

  private async waitForRateLimit(category: string, minDelayMs: number) {
    const previous = this.rateLimitChains.get(category) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => gate);
    this.rateLimitChains.set(category, chain);

    await previous;
    try {
      const lastStartedAt = this.requestTimestamps.get(category);
      const now = Date.now();
      let waitedMs = 0;
      if (lastStartedAt !== undefined) {
        const elapsed = now - lastStartedAt;
        if (elapsed < minDelayMs) {
          waitedMs = minDelayMs - elapsed;
          await delay(waitedMs);
        }
      }
      this.requestTimestamps.set(category, Date.now());
      return waitedMs;
    } finally {
      release();
      if (this.rateLimitChains.get(category) === chain) {
        this.rateLimitChains.delete(category);
      }
    }
  }
}

function retryDelayMs(attemptNumber: number) {
  return 5000 * attemptNumber;
}
