import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { fetch, ProxyAgent } from "undici";

import type { FanslySessionBundle, ProxyConfig } from "@fansly-connect/shared";

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
      requestShape?: Record<string, unknown>;
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
    const logicalRequestId = `${options.operation}:${randomUUID()}`;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const startedAt = Date.now();
      const attemptId = await context.telemetry?.startAttempt({
        logicalRequestId,
        attemptNumber: attempt + 1,
        operation: options.operation,
        requestShape: options.requestShape ?? {},
      }) ?? null;

      await this.waitForRateLimit(options.category, minDelayMs);

      let response: Awaited<ReturnType<typeof fetch>>;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: this.buildHeaders(context.session),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          dispatcher: context.proxy ? this.buildProxyDispatcher(context.proxy) : undefined,
        });
      } catch (error) {
        const failureKind = classifyTransportError(error);
        const durationMs = Date.now() - startedAt;
        if (attempt < retries) {
          const retryDelayMs = 5000 * (attempt + 1);
          await context.telemetry?.finishAttempt({
            attemptId,
            logicalRequestId,
            attemptNumber: attempt + 1,
            operation: options.operation,
            state: "retry",
            failureKind,
            retryDelayMs,
            durationMs,
            errorMessage: errorMessage(error),
          });
          await delay(retryDelayMs);
          continue;
        }

        await context.telemetry?.finishAttempt({
          attemptId,
          logicalRequestId,
          attemptNumber: attempt + 1,
          operation: options.operation,
          state: "failed",
          failureKind,
          durationMs,
          errorMessage: errorMessage(error),
        });
        throw error;
      }

      const text = await response.text();
      const envelope = this.safeParseEnvelope<T>(text);
      const durationMs = Date.now() - startedAt;

      if (response.status === 401 || response.status === 403) {
        await context.telemetry?.finishAttempt({
          attemptId,
          logicalRequestId,
          attemptNumber: attempt + 1,
          operation: options.operation,
          state: "failed",
          failureKind: "http",
          httpStatus: response.status,
          durationMs,
          errorMessage: envelope?.error?.message ?? `Fansly authorization failed (${response.status})`,
        });
        throw new FanslyApiError(
          envelope?.error?.message ?? `Fansly authorization failed (${response.status})`,
          response.status,
          envelope?.error?.code,
          text.slice(0, 400),
        );
      }

      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < retries) {
        const retryAfterSeconds = Number(response.headers.get("retry-after") ?? "0");
        const waitMs = retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 5000 * (attempt + 1);
        await context.telemetry?.finishAttempt({
          attemptId,
          logicalRequestId,
          attemptNumber: attempt + 1,
          operation: options.operation,
          state: "retry",
          failureKind: "http",
          httpStatus: response.status,
          retryDelayMs: waitMs,
          durationMs,
          errorMessage: envelope?.error?.message ?? `Fansly request failed (${response.status})`,
        });
        await delay(waitMs);
        continue;
      }

      if (!response.ok) {
        await context.telemetry?.finishAttempt({
          attemptId,
          logicalRequestId,
          attemptNumber: attempt + 1,
          operation: options.operation,
          state: "failed",
          failureKind: "http",
          httpStatus: response.status,
          durationMs,
          errorMessage: envelope?.error?.message ?? `Fansly request failed (${response.status})`,
        });
        throw new FanslyApiError(
          envelope?.error?.message ?? `Fansly request failed (${response.status})`,
          response.status,
          envelope?.error?.code,
          text.slice(0, 400),
        );
      }

      if (!envelope?.success || envelope.response === undefined) {
        await context.telemetry?.finishAttempt({
          attemptId,
          logicalRequestId,
          attemptNumber: attempt + 1,
          operation: options.operation,
          state: "failed",
          failureKind: "provider",
          httpStatus: response.status,
          durationMs,
          errorMessage: envelope?.error?.message ?? "Fansly response envelope was unsuccessful",
        });
        throw new FanslyApiError(
          envelope?.error?.message ?? "Fansly response envelope was unsuccessful",
          response.status,
          envelope?.error?.code,
          text.slice(0, 400),
        );
      }

      await context.telemetry?.finishAttempt({
        attemptId,
        logicalRequestId,
        attemptNumber: attempt + 1,
        operation: options.operation,
        state: "success",
        httpStatus: response.status,
        durationMs,
        responseShape: options.summarizeResponse?.(envelope.response) ?? {},
      });

      return {
        parsed: envelope.response,
        raw: envelope.response,
      };
    }

    throw new FanslyApiError("Fansly request exhausted retries");
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
      if (lastStartedAt !== undefined) {
        const elapsed = now - lastStartedAt;
        if (elapsed < minDelayMs) {
          await delay(minDelayMs - elapsed);
        }
      }
      this.requestTimestamps.set(category, Date.now());
    } finally {
      release();
      if (this.rateLimitChains.get(category) === chain) {
        this.rateLimitChains.delete(category);
      }
    }
  }
}
