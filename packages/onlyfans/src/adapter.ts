import { setTimeout as delay } from "node:timers/promises";

import { fetch, ProxyAgent } from "undici";

import type { ProxyConfig } from "@fansly-connect/shared";

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
  private readonly proxyAgents = new Map<string, ProxyAgent>();

  constructor(private readonly options: AdapterOptions) {}

  async close() {
    await Promise.all(Array.from(this.proxyAgents.values(), (agent) => agent.close()));
    this.proxyAgents.clear();
  }

  async listAccountsPage(
    context: OnlyFansRequestContext,
    params?: {
      cursor?: string | null;
      limit?: number;
    },
  ) {
    return this.request<OnlyMonsterAccountsResponse>(context, "/api/v0/accounts", {
      category: "accounts",
      query: {
        cursor: params?.cursor ?? undefined,
        limit: params?.limit ? String(params.limit) : undefined,
      },
    });
  }

  async getAccount(context: OnlyFansRequestContext, accountId: number) {
    return this.request<OnlyMonsterAccountResponse>(
      context,
      `/api/v0/accounts/${accountId}`,
      { category: "accounts" },
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
    },
  ) {
    return this.request<OnlyMonsterCursorResponse<OnlyMonsterTransaction>>(
      context,
      `/api/v0/platforms/onlyfans/accounts/${platformAccountId}/transactions`,
      {
        category: "transactions",
        query: {
          start: params.start.toISOString(),
          end: params.end.toISOString(),
          cursor: params.cursor ?? undefined,
          limit: params.limit ? String(params.limit) : undefined,
        },
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
    },
  ) {
    return this.request<OnlyMonsterCursorResponse<OnlyMonsterChargeback>>(
      context,
      `/api/v0/platforms/onlyfans/accounts/${platformAccountId}/chargebacks`,
      {
        category: "chargebacks",
        query: {
          start: params.start.toISOString(),
          end: params.end.toISOString(),
          cursor: params.cursor ?? undefined,
          limit: params.limit ? String(params.limit) : undefined,
        },
      },
    );
  }

  private async request<TParsed>(
    context: OnlyFansRequestContext,
    pathname: string,
    options: {
      category: string;
      query?: Record<string, string | undefined>;
      retries?: number;
      minDelayMs?: number;
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

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      await this.waitForRateLimit(options.category, minDelayMs);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-om-auth-token": context.auth.token,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        dispatcher: context.proxy ? this.buildProxyDispatcher(context.proxy) : undefined,
      });

      const text = await response.text();

      if (response.status === 401 || response.status === 403) {
        throw new OnlyMonsterApiError(
          `OnlyMonster authorization failed (${response.status})`,
          response.status,
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
        throw new OnlyMonsterApiError(
          `OnlyMonster request failed (${response.status})`,
          response.status,
          text.slice(0, 400),
        );
      }

      try {
        const parsed = JSON.parse(text) as TParsed;
        return {
          parsed,
          raw: parsed,
        };
      } catch {
        throw new OnlyMonsterApiError(
          "OnlyMonster response was not valid JSON",
          response.status,
          text.slice(0, 400),
        );
      }
    }

    throw new OnlyMonsterApiError("OnlyMonster request exhausted retries");
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
