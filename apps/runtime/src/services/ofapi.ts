// Client for the onlyfansapi.com API: webhook CRUD + account list (admin flow)
// plus credit-budgeted, observed chat/message reads for the DM sync (Phase 2 of
// docs/ofapi-integration-plan.md). Not to be confused with packages/onlyfans,
// which is the OnlyMonster adapter.

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  executeObservedRequest,
  type HttpRequestObserver,
} from "@agency_hub_core/shared";

const OFAPI_REQUEST_TIMEOUT_MS = 15_000;
const OFAPI_DEFAULT_REST_DELAY_MS = 500;
const OFAPI_OBSERVED_RETRIES = 3;

export class OfapiApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: string | null,
  ) {
    super(message);
    this.name = "OfapiApiError";
  }
}

export interface OfapiWebhookRegistrationInput {
  endpointUrl: string;
  signingSecret: string;
  events: string[];
  accountScope: "global" | "inclusive" | "exclusive";
}

export interface OfapiWebhookRecord {
  id: string | null;
}

export interface OfapiAccountRecord {
  id: string;
  username: string | null;
}

export interface OfapiRequestContext {
  requestObserver?: HttpRequestObserver | null;
}

// Every OFAPI REST response carries _meta with the remaining credit balance —
// the budget/floor guards and ops views run off this, no extra calls needed.
export interface OfapiResponseMeta {
  creditsUsed: number | null;
  creditBalance: number | null;
  isCached: boolean | null;
  rateRemainingMinute: number | null;
}

export interface OfapiListPage {
  items: Record<string, unknown>[];
  hasNextPage: boolean;
  meta: OfapiResponseMeta | null;
}

export interface OfapiClient {
  createWebhook(input: OfapiWebhookRegistrationInput): Promise<OfapiWebhookRecord>;
  updateWebhook(id: string, input: OfapiWebhookRegistrationInput): Promise<OfapiWebhookRecord>;
  listAccounts(): Promise<OfapiAccountRecord[]>;
  listChats(
    context: OfapiRequestContext,
    accountId: string,
    params: {
      limit?: number;
      offset?: number;
      order?: "recent" | "old";
      pageIndex?: number;
    },
  ): Promise<OfapiListPage>;
  listChatMessages(
    context: OfapiRequestContext,
    accountId: string,
    chatId: string,
    params: {
      limit?: number;
      // first_id pagination cursor for order=desc. OFAPI treats it as inclusive
      // ("include this message ID as the first message in the results"), so
      // callers must drop the cursor row if it reappears.
      firstId?: string | null;
      pageIndex?: number;
    },
  ): Promise<OfapiListPage>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// OFAPI wraps most responses in {data}; tolerate both wrapped and bare shapes.
function unwrapData(value: unknown): unknown {
  const record = asRecord(value);
  return record && "data" in record ? record.data : value;
}

function toWebhookRecord(value: unknown): OfapiWebhookRecord {
  const record = asRecord(unwrapData(value));
  const id = record?.id;
  return {
    id: typeof id === "string" && id.length > 0
      ? id
      : typeof id === "number"
        ? String(id)
        : null,
  };
}

function toAccountRecords(value: unknown): OfapiAccountRecord[] {
  const data = unwrapData(value);
  if (!Array.isArray(data)) {
    return [];
  }

  const accounts: OfapiAccountRecord[] = [];
  for (const item of data) {
    const record = asRecord(item);
    const id = record?.id;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }

    const username = record?.onlyfans_username;
    accounts.push({
      id,
      username: typeof username === "string" && username.length > 0 ? username : null,
    });
  }

  return accounts;
}

function webhookRequestBody(input: OfapiWebhookRegistrationInput) {
  return {
    endpoint_url: input.endpointUrl,
    signing_secret: input.signingSecret,
    events: input.events,
    account_scope: input.accountScope,
  };
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseResponseMeta(body: unknown): OfapiResponseMeta | null {
  const meta = asRecord(asRecord(body)?._meta);
  if (!meta) {
    return null;
  }

  const credits = asRecord(meta._credits);
  const cache = asRecord(meta._cache);
  const rateLimits = asRecord(meta._rate_limits);
  return {
    creditsUsed: asNumberOrNull(credits?.used),
    creditBalance: asNumberOrNull(credits?.balance),
    isCached: typeof cache?.is_cached === "boolean" ? cache.is_cached : null,
    rateRemainingMinute: asNumberOrNull(rateLimits?.remaining_minute),
  };
}

function toListPage(body: unknown): OfapiListPage {
  const record = asRecord(body);
  const data = Array.isArray(record?.data) ? record.data : [];
  const pagination = asRecord(record?._pagination);
  const nextPage = pagination?.next_page;
  return {
    items: data.flatMap((item) => {
      const itemRecord = asRecord(item);
      return itemRecord ? [itemRecord] : [];
    }),
    hasNextPage: typeof nextPage === "string" && nextPage.length > 0,
    meta: parseResponseMeta(body),
  };
}

function resolveRetryAfterMs(retryAfter: string | null, attemptNumber: number) {
  const fallbackMs = Math.min(2 ** attemptNumber * 1000, 30_000);
  if (!retryAfter) {
    return fallbackMs;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 60_000);
  }
  return fallbackMs;
}

export function createOfapiClient(input: {
  baseUrl: string;
  apiKey: string;
  restDelayMs?: number;
}): OfapiClient {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const restDelayMs = Math.max(0, input.restDelayMs ?? OFAPI_DEFAULT_REST_DELAY_MS);
  // Client-wide pacing across concurrent executor chunks: each caller claims the
  // next slot and sleeps until it; OFAPI rate limits are account-global.
  let nextRequestSlotAt = 0;

  async function waitForRequestSlot() {
    const now = Date.now();
    const slotAt = Math.max(now, nextRequestSlotAt);
    nextRequestSlotAt = slotAt + restDelayMs;
    const waitMs = slotAt - now;
    if (waitMs > 0) {
      await delay(waitMs);
    }
    return waitMs;
  }

  async function observedListRequest(options: {
    context: OfapiRequestContext;
    operation: string;
    endpointTemplate: string;
    pathname: string;
    query: Record<string, string | undefined>;
    pageIndex: number;
    cursorPresent: boolean;
    requestMetadata: Record<string, unknown>;
  }): Promise<OfapiListPage> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) {
        query.set(key, value);
      }
    }
    const url = `${baseUrl}${options.pathname}${query.size > 0 ? `?${query.toString()}` : ""}`;

    return executeObservedRequest<{ response: Response; text: string }, OfapiListPage>({
      observer: options.context.requestObserver,
      requestId: `${options.operation}:${randomUUID()}`,
      operation: options.operation,
      endpointTemplate: options.endpointTemplate,
      method: "GET",
      pagination: {
        pageIndex: options.pageIndex,
        cursorPresent: options.cursorPresent,
      },
      requestMetadata: options.requestMetadata,
      retries: OFAPI_OBSERVED_RETRIES,
      waitForRateLimit: waitForRequestSlot,
      execute: async () => {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(OFAPI_REQUEST_TIMEOUT_MS),
        });
        return { response, text: await response.text() };
      },
      onTransportError: (error, executionContext) => {
        const errorMessage = `OFAPI request failed: GET ${options.pathname}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        if (executionContext.retriesRemaining > 0) {
          return {
            kind: "retry",
            failureKind: "transport",
            retryDelayMs: Math.min(2 ** executionContext.attemptNumber * 1000, 30_000),
            errorMessage,
            error,
          };
        }
        return {
          kind: "failed",
          failureKind: "transport",
          errorMessage,
          error: new OfapiApiError(errorMessage, null, null),
        };
      },
      onResponse: ({ response, text }, executionContext) => {
        if (response.status === 429 && executionContext.retriesRemaining > 0) {
          return {
            kind: "retry",
            failureKind: "http",
            httpStatus: 429,
            retryDelayMs: resolveRetryAfterMs(
              response.headers.get("retry-after"),
              executionContext.attemptNumber,
            ),
            errorMessage: "OFAPI rate limited (429)",
          };
        }

        if ([500, 502, 503, 504].includes(response.status) && executionContext.retriesRemaining > 0) {
          return {
            kind: "retry",
            failureKind: "http",
            httpStatus: response.status,
            retryDelayMs: Math.min(2 ** executionContext.attemptNumber * 1000, 30_000),
            errorMessage: `OFAPI request failed (${response.status})`,
          };
        }

        if (!response.ok) {
          const message = `OFAPI request failed: GET ${options.pathname} returned ${response.status}`;
          return {
            kind: "failed",
            failureKind: "http",
            httpStatus: response.status,
            errorMessage: message,
            error: new OfapiApiError(message, response.status, text.slice(0, 2000)),
          };
        }

        let body: unknown;
        try {
          body = text.length > 0 ? JSON.parse(text) as unknown : null;
        } catch {
          const message = `OFAPI request failed: GET ${options.pathname} returned non-JSON body`;
          return {
            kind: "failed",
            failureKind: "http",
            httpStatus: response.status,
            errorMessage: message,
            error: new OfapiApiError(message, response.status, text.slice(0, 2000)),
          };
        }

        const page = toListPage(body);
        return {
          kind: "success",
          value: page,
          httpStatus: response.status,
          // Lands in sync_http_attempts.response_shape — credits/rate budget
          // telemetry per request, as the plan requires.
          responseMetadata: {
            returnedItems: page.items.length,
            hasNextPage: page.hasNextPage,
            creditsUsed: page.meta?.creditsUsed ?? null,
            creditBalance: page.meta?.creditBalance ?? null,
            isCached: page.meta?.isCached ?? null,
            rateRemainingMinute: page.meta?.rateRemainingMinute ?? null,
          },
        };
      },
    });
  }

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(OFAPI_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new OfapiApiError(
        `OFAPI request failed: ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`,
        null,
        null,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new OfapiApiError(
        `OFAPI request failed: ${method} ${path} returned ${response.status}`,
        response.status,
        text.slice(0, 2000),
      );
    }

    try {
      return text.length > 0 ? JSON.parse(text) as unknown : null;
    } catch {
      throw new OfapiApiError(
        `OFAPI request failed: ${method} ${path} returned non-JSON body`,
        response.status,
        text.slice(0, 2000),
      );
    }
  }

  return {
    async createWebhook(registration) {
      return toWebhookRecord(await request("POST", "/webhooks", webhookRequestBody(registration)));
    },
    async updateWebhook(id, registration) {
      return toWebhookRecord(await request(
        "PUT",
        `/webhooks/${encodeURIComponent(id)}`,
        webhookRequestBody(registration),
      ));
    },
    async listAccounts() {
      return toAccountRecords(await request("GET", "/accounts"));
    },
    async listChats(context, accountId, params) {
      const limit = params.limit ?? 100;
      const offset = params.offset ?? 0;
      return observedListRequest({
        context,
        operation: "ofapi_chats",
        endpointTemplate: "/:accountId/chats",
        pathname: `/${encodeURIComponent(accountId)}/chats`,
        query: {
          limit: String(limit),
          offset: offset > 0 ? String(offset) : undefined,
          order: params.order ?? "recent",
        },
        pageIndex: params.pageIndex ?? 0,
        cursorPresent: offset > 0,
        requestMetadata: {
          limit,
          offset,
          order: params.order ?? "recent",
        },
      });
    },
    async listChatMessages(context, accountId, chatId, params) {
      const limit = params.limit ?? 100;
      return observedListRequest({
        context,
        operation: "ofapi_chat_messages",
        endpointTemplate: "/:accountId/chats/:chatId/messages",
        pathname: `/${encodeURIComponent(accountId)}/chats/${encodeURIComponent(chatId)}/messages`,
        query: {
          limit: String(limit),
          order: "desc",
          first_id: params.firstId ?? undefined,
        },
        pageIndex: params.pageIndex ?? 0,
        cursorPresent: params.firstId != null,
        requestMetadata: {
          limit,
          order: "desc",
          hasFirstId: params.firstId != null,
        },
      });
    },
  };
}
