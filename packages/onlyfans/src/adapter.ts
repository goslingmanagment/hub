import { randomUUID } from "node:crypto";
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

function classifyTransportError(error: unknown) {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout" as const;
  }

  return "transport" as const;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

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
      operation: "onlymonster_accounts",
      category: "accounts",
      query: {
        cursor: params?.cursor ?? undefined,
        limit: params?.limit ? String(params.limit) : undefined,
      },
      requestShape: {
        cursorPresent: Boolean(params?.cursor),
        limit: params?.limit ?? null,
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
    },
  ) {
    return this.request<OnlyMonsterCursorResponse<OnlyMonsterTransaction>>(
      context,
      `/api/v0/platforms/onlyfans/accounts/${platformAccountId}/transactions`,
      {
        operation: "onlymonster_transactions",
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
    },
  ) {
    return this.request<OnlyMonsterCursorResponse<OnlyMonsterChargeback>>(
      context,
      `/api/v0/platforms/onlyfans/accounts/${platformAccountId}/chargebacks`,
      {
        operation: "onlymonster_chargebacks",
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
      category: string;
      query?: Record<string, string | undefined>;
      retries?: number;
      minDelayMs?: number;
      requestShape?: Record<string, unknown>;
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
          headers: {
            accept: "application/json",
            "x-om-auth-token": context.auth.token,
          },
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
          errorMessage: `OnlyMonster authorization failed (${response.status})`,
        });
        throw new OnlyMonsterApiError(
          `OnlyMonster authorization failed (${response.status})`,
          response.status,
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
          errorMessage: `OnlyMonster request failed (${response.status})`,
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
          errorMessage: `OnlyMonster request failed (${response.status})`,
        });
        throw new OnlyMonsterApiError(
          `OnlyMonster request failed (${response.status})`,
          response.status,
          text.slice(0, 400),
        );
      }

      try {
        const parsed = JSON.parse(text) as TParsed;
        await context.telemetry?.finishAttempt({
          attemptId,
          logicalRequestId,
          attemptNumber: attempt + 1,
          operation: options.operation,
          state: "success",
          httpStatus: response.status,
          durationMs,
          responseShape: options.summarizeResponse?.(parsed) ?? {},
        });
        return {
          parsed,
          raw: parsed,
        };
      } catch (error) {
        await context.telemetry?.finishAttempt({
          attemptId,
          logicalRequestId,
          attemptNumber: attempt + 1,
          operation: options.operation,
          state: "failed",
          failureKind: "provider",
          httpStatus: response.status,
          durationMs,
          errorMessage: "OnlyMonster response was not valid JSON",
        });
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
