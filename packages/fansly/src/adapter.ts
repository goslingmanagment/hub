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
      category: "account",
    });
  }

  async getAccountsByIdsPage(context: FanslyRequestContext, ids: string[]) {
    if (ids.length > 100) {
      throw new Error("Fansly account lookup supports at most 100 ids per request");
    }

    return this.request<FanslyAccount[]>(context, "/account", {
      query: { ids: ids.join(",") },
      category: "account",
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
        query: {
          after: params.after ? String(params.after.getTime()) : undefined,
          before: params.before ? String(params.before.getTime()) : undefined,
          limit: params.limit ? String(params.limit) : undefined,
          offset: params.offset ? String(params.offset) : undefined,
        },
        category: "transactions",
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
      query: {
        offset: params.offset ? String(params.offset) : undefined,
        limit: params.limit ? String(params.limit) : undefined,
        after: params.after ? String(params.after.getTime()) : undefined,
        before: params.before ? String(params.before.getTime()) : undefined,
        status: params.status ?? "3,4",
      },
      category: "subscribers",
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
        query: {
          offset: params.offset ? String(params.offset) : undefined,
          limit: params.limit ? String(params.limit) : undefined,
          after: params.after ?? undefined,
          before: params.before ?? undefined,
        },
        category: "followers",
        minDelayMs: params.minDelayMs,
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
      minDelayMs?: number;
      retries?: number;
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

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      await this.waitForRateLimit(options.category, minDelayMs);

      const response = await fetch(url, {
        method: "GET",
        headers: this.buildHeaders(context.session),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        dispatcher: context.proxy ? this.buildProxyDispatcher(context.proxy) : undefined,
      });

      const text = await response.text();
      const envelope = this.safeParseEnvelope<T>(text);

      if (response.status === 401 || response.status === 403) {
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
        await delay(waitMs);
        continue;
      }

      if (!response.ok) {
        throw new FanslyApiError(
          envelope?.error?.message ?? `Fansly request failed (${response.status})`,
          response.status,
          envelope?.error?.code,
          text.slice(0, 400),
        );
      }

      if (!envelope?.success || envelope.response === undefined) {
        throw new FanslyApiError(
          envelope?.error?.message ?? "Fansly response envelope was unsuccessful",
          response.status,
          envelope?.error?.code,
          text.slice(0, 400),
        );
      }

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
