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
import type { Dispatcher } from "undici";

import { normalizeOnlyFansAvatarUrl } from "./onlyfans.ts";

const OFAPI_REQUEST_TIMEOUT_MS = 15_000;
const OFAPI_PROXY_READ_TIMEOUT_MS = 60_000;
const OFAPI_DEFAULT_REST_DELAY_MS = 500;
const OFAPI_OBSERVED_RETRIES = 3;
// fans/active hard-caps limit at 20 per the OpenAPI validation text.
const OFAPI_FANS_PAGE_LIMIT = 20;

// The only place the OFAPI host may appear in runtime code (D1 of
// docs/ofapi-parity-plan.md, enforced by a gate test): every OFAPI HTTP call
// goes through this client, which is also the single _meta/credit-spend tap.
export const OFAPI_DEFAULT_BASE_URL = "https://app.onlyfansapi.com/api";

export class OfapiApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: string | null,
    readonly upstreamStatus: number | null = null,
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
  displayName: string | null;
  onlyfansName: string | null;
  onlyfansUserId: string | null;
  avatarUrl: string | null;
}

export interface OfapiRequestContext {
  requestObserver?: HttpRequestObserver | null;
  // Account-scoped OFAPI reads must use the page egress dispatcher so large
  // response bodies do not go through the hub VPS direct route.
  dispatcher?: Dispatcher | null;
  egressKey?: string | null;
  // Attributes the request's credit spend to a page in the ledger (D2);
  // admin/account-global calls leave it unset.
  pageId?: number | null;
  // Stage 9: the acting principal for gateway reads; background REST
  // spenders leave it unset (NULL = system spend in the ledger).
  actorUserId?: number | null;
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
  nextMarker?: string | null;
  nextPageUrl?: string | null;
  meta: OfapiResponseMeta | null;
}

export interface OfapiRawResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface OfapiSentMessage {
  messageId: string;
}

export interface OfapiMediaMessageInput {
  text: string;
  price: number;
  mediaFiles: string[];
  previews: string[];
}

export interface OfapiTypingResult {
  success: true;
}

export interface OfapiUnsendResult {
  success: true;
}

export interface OfapiMarkReadResult {
  success: true;
}

// One credit-spend report per response that reached the server (retry attempts
// included — OFAPI charged each). Emitted by the client itself on BOTH request
// paths, so callers cannot forget to account spend (D1).
export interface OfapiCreditSpendObservation {
  operation: string;
  httpStatus: number;
  credits: number;
  estimated: boolean;
  balanceAfter: number | null;
  requestId: string;
  pageId: number | null;
  attemptNumber: number;
  isCached: boolean | null;
  actorUserId: number | null;
}

export type OfapiCreditSpendSink = (
  observation: OfapiCreditSpendObservation,
) => Promise<void> | void;

/**
 * Maps one HTTP response to its ledger spend, or null for no row. Server-reported
 * `_meta._credits.used` always wins (D3); a 2xx without _meta is assumed to be the
 * standard 1-credit uncached charge and flagged estimated; error responses without
 * _meta get no row — reconciliation absorbs any hidden charge and empirically
 * answers whether errors are billed (plan recommendation 1).
 */
export function resolveOfapiCreditSpend(input: {
  httpStatus: number;
  meta: OfapiResponseMeta | null;
}): { credits: number; estimated: boolean; balanceAfter: number | null } | null {
  const ok = input.httpStatus >= 200 && input.httpStatus < 300;
  const creditsUsed = input.meta?.creditsUsed ?? null;
  const balance = input.meta?.creditBalance ?? null;

  if (creditsUsed !== null) {
    return { credits: creditsUsed, estimated: false, balanceAfter: balance };
  }
  if (ok) {
    return { credits: 1, estimated: true, balanceAfter: balance };
  }
  if (balance !== null) {
    // An error response that still reported a balance: no spend claim, but the
    // balance observation is a free reconciliation anchor.
    return { credits: 0, estimated: true, balanceAfter: balance };
  }
  return null;
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
  // GET /api/{account}/fans/active — the audience sweep (docs/ofapi-parity-plan.md
  // Phase 3). The documented hard cap is 20 fans per request.
  listActiveFans(
    context: OfapiRequestContext,
    accountId: string,
    params: {
      limit?: number;
      offset?: number;
      pageIndex?: number;
    },
  ): Promise<OfapiListPage>;
  listTransactions?(
    context: OfapiRequestContext,
    accountId: string,
    params: {
      limit?: number;
      startDate?: string;
      marker?: string | null;
      pageIndex?: number;
    },
  ): Promise<OfapiListPage>;
  // GET /api/{account}/chargebacks (Stage 14) — vendored-spec shape: data.list
  // of { id, createdAt, paymentType, payment{...} }, limit/offset pagination.
  listChargebacks?(
    context: OfapiRequestContext,
    accountId: string,
    params: {
      limit?: number;
      offset?: number;
      startDate?: string;
      endDate?: string;
    },
  ): Promise<OfapiListPage>;
  // One cheap (1-credit) account-scoped request purely to observe the credit
  // balance: GET /accounts carries no _meta per the OFAPI OpenAPI spec, so the
  // ping reads a minimal chats page instead (reconciliation anchor on quiet days).
  pingBalance(context: OfapiRequestContext, accountId: string): Promise<OfapiListPage>;
  // Read-only desktop gateway path. The caller supplies an already validated
  // pathname/query pair and a bounded operation name. Exactly one upstream
  // attempt is made: desktop remains the retry authority during migration.
  proxyRead?(
    context: OfapiRequestContext,
    input: {
      operation: string;
      pathname: string;
      query: Record<string, string>;
      fallbackCredits: number;
      fallbackEstimated: boolean;
    },
  ): Promise<OfapiRawResponse>;
  // Decision #56: exactly one text-send attempt. Optional for legacy test
  // doubles; production createOfapiClient always implements it.
  sendTextMessage?(
    context: OfapiRequestContext,
    accountId: string,
    conversationId: string,
    input: { text: string },
  ): Promise<OfapiSentMessage>;
  // Decision #61: exactly one media/PPV send attempt. Payload accepts only
  // bounded media IDs, preview IDs, price, and optional caption text.
  sendMediaMessage?(
    context: OfapiRequestContext,
    accountId: string,
    conversationId: string,
    input: OfapiMediaMessageInput,
  ): Promise<OfapiSentMessage>;
  // Decision #57: exactly one advisory typing beacon. The endpoint is documented
  // as free, so fallback credit accounting records zero credits if _meta is absent.
  startTyping?(
    context: OfapiRequestContext,
    accountId: string,
    conversationId: string,
  ): Promise<OfapiTypingResult>;
  // Decision #59: exactly one message-unsend attempt. The target message id is
  // the only payload; no text/media fields are accepted or logged.
  unsendMessage?(
    context: OfapiRequestContext,
    accountId: string,
    conversationId: string,
    messageId: string,
  ): Promise<OfapiUnsendResult>;
  // Decision #60: exactly one mark-read attempt. Empty payload; no text/media
  // fields are accepted or logged.
  markChatRead?(
    context: OfapiRequestContext,
    accountId: string,
    conversationId: string,
  ): Promise<OfapiMarkReadResult>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function wrappedOnlyFansStatus(value: unknown): number | null {
  const record = asRecord(value);
  if (record?.error !== "ONLYFANS_COM_ERROR") {
    return null;
  }
  const onlyFansResponse = asRecord(record.onlyfans_response);
  const status = onlyFansResponse?.status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

function asNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringId(value: unknown) {
  const text = typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : asNonEmptyString(value);
  return text && text.length > 0 ? text : null;
}

function firstNonEmptyString(...values: unknown[]) {
  for (const value of values) {
    const text = asNonEmptyString(value);
    if (text) {
      return text;
    }
  }
  return null;
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

    const onlyfansUserData = asRecord(record?.onlyfans_user_data)
      ?? asRecord(record?.onlyfansUserData);
    accounts.push({
      id,
      username: firstNonEmptyString(
        record?.onlyfans_username,
        record?.onlyfansUsername,
        onlyfansUserData?.username,
        record?.username,
      ),
      displayName: firstNonEmptyString(record?.display_name, record?.displayName),
      onlyfansName: firstNonEmptyString(onlyfansUserData?.name, record?.name),
      onlyfansUserId: asStringId(
        onlyfansUserData?.id
          ?? record?.onlyfans_user_id
          ?? record?.onlyfansUserId,
      ),
      avatarUrl: normalizeOnlyFansAvatarUrl(firstNonEmptyString(
        record?.avatar,
        record?.avatar_url,
        record?.avatarUrl,
        onlyfansUserData?.avatar,
        onlyfansUserData?.avatar_url,
        onlyfansUserData?.avatarUrl,
      )),
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

function parseNextMarker(pagination: Record<string, unknown> | null) {
  const explicitMarker = pagination?.next_marker ?? pagination?.nextMarker;
  const explicit = asStringId(explicitMarker);
  if (explicit) {
    return explicit;
  }

  const nextPage = pagination?.next_page;
  if (typeof nextPage !== "string" || nextPage.length === 0) {
    return null;
  }
  try {
    return new URL(nextPage, "https://ofapi.local").searchParams.get("marker");
  } catch {
    return null;
  }
}

function toListPage(body: unknown): OfapiListPage {
  const record = asRecord(body);
  const dataRecord = asRecord(record?.data);
  const data = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(dataRecord?.list)
      ? dataRecord.list
      : [];
  const pagination = asRecord(record?._pagination);
  const nextPage = pagination?.next_page;
  const nextMarker = parseNextMarker(dataRecord) ?? parseNextMarker(pagination);
  return {
    items: data.flatMap((item) => {
      const itemRecord = asRecord(item);
      return itemRecord ? [itemRecord] : [];
    }),
    hasNextPage: typeof dataRecord?.hasMore === "boolean"
      ? dataRecord.hasMore
      : typeof nextPage === "string" && nextPage.length > 0,
    nextMarker,
    nextPageUrl: typeof nextPage === "string" && nextPage.length > 0 ? nextPage : null,
    meta: parseResponseMeta(body),
  };
}

/**
 * Fans endpoints wrap the page as {data: {list: [...], hasMore}} per the OFAPI
 * OpenAPI spec, unlike chats' bare {data: [...]}; tolerate both shapes since
 * the wrapper is only spec-verified, not live-verified.
 */
export function toFansListPage(body: unknown): OfapiListPage {
  const record = asRecord(body);
  const data = record?.data;
  const dataRecord = asRecord(data);
  const list = Array.isArray(dataRecord?.list)
    ? dataRecord.list
    : Array.isArray(data)
      ? data
      : [];
  const pagination = asRecord(record?._pagination);
  const nextPage = pagination?.next_page;
  return {
    items: list.flatMap((item) => {
      const itemRecord = asRecord(item);
      return itemRecord ? [itemRecord] : [];
    }),
    hasNextPage: typeof dataRecord?.hasMore === "boolean"
      ? dataRecord.hasMore
      : typeof nextPage === "string" && nextPage.length > 0,
    nextMarker: parseNextMarker(pagination),
    nextPageUrl: typeof nextPage === "string" && nextPage.length > 0 ? nextPage : null,
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
  baseUrl?: string;
  apiKey: string;
  restDelayMs?: number;
  onCreditSpend?: OfapiCreditSpendSink | null;
}): OfapiClient {
  const baseUrl = (input.baseUrl ?? OFAPI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const restDelayMs = Math.max(0, input.restDelayMs ?? OFAPI_DEFAULT_REST_DELAY_MS);
  const onCreditSpend = input.onCreditSpend ?? null;

  // Reports one response's spend to the injected sink; the sink owns durability
  // and error handling — a sink failure must never fail the API call itself.
  async function reportCreditSpend(report: {
    operation: string;
    httpStatus: number;
    body: unknown;
    requestId: string;
    pageId: number | null;
    attemptNumber: number;
    fallbackCredits?: number;
    fallbackEstimated?: boolean;
    actorUserId?: number | null;
  }) {
    if (!onCreditSpend) {
      return;
    }

    const meta = parseResponseMeta(report.body);
    const spend = report.httpStatus >= 200
      && report.httpStatus < 300
      && meta?.creditsUsed == null
      && report.fallbackCredits !== undefined
      ? {
        credits: report.fallbackCredits,
        estimated: report.fallbackEstimated ?? true,
        balanceAfter: meta?.creditBalance ?? null,
      }
      : resolveOfapiCreditSpend({ httpStatus: report.httpStatus, meta });
    if (!spend) {
      return;
    }

    try {
      await onCreditSpend({
        operation: report.operation,
        httpStatus: report.httpStatus,
        credits: spend.credits,
        estimated: spend.estimated,
        balanceAfter: spend.balanceAfter,
        requestId: report.requestId,
        pageId: report.pageId,
        attemptNumber: report.attemptNumber,
        isCached: meta?.isCached ?? null,
        actorUserId: report.actorUserId ?? null,
      });
    } catch (error) {
      // Spend recording is best-effort at this layer; reconciliation closes gaps.
    }
  }
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
    mapResponse?: (body: unknown) => OfapiListPage;
  }): Promise<OfapiListPage> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) {
        query.set(key, value);
      }
    }
    const url = `${baseUrl}${options.pathname}${query.size > 0 ? `?${query.toString()}` : ""}`;
    const requestId = `${options.operation}:${randomUUID()}`;

    return executeObservedRequest<{ response: Response; text: string }, OfapiListPage>({
      observer: options.context.requestObserver,
      requestId,
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
      onResponse: async ({ response, text }, executionContext) => {
        // Parse once for both the spend report and the success mapping; an
        // unparseable body reports as body=null (errors then write no row).
        let body: unknown = null;
        let bodyIsJson = text.length === 0;
        if (text.length > 0) {
          try {
            body = JSON.parse(text) as unknown;
            bodyIsJson = true;
          } catch {
            bodyIsJson = false;
          }
        }

        // Every attempt that produced an HTTP response is reported — the
        // server charged each one, retries included.
        await reportCreditSpend({
          operation: options.operation,
          httpStatus: response.status,
          body,
          requestId,
          pageId: options.context.pageId ?? null,
          attemptNumber: executionContext.attemptNumber,
        });

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

        if (!bodyIsJson) {
          const message = `OFAPI request failed: GET ${options.pathname} returned non-JSON body`;
          return {
            kind: "failed",
            failureKind: "http",
            httpStatus: response.status,
            errorMessage: message,
            error: new OfapiApiError(message, response.status, text.slice(0, 2000)),
          };
        }

        const page = (options.mapResponse ?? toListPage)(body);
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

  async function proxyReadRequest(
    context: OfapiRequestContext,
    options: {
      operation: string;
      pathname: string;
      query: Record<string, string>;
      fallbackCredits: number;
      fallbackEstimated: boolean;
    },
  ): Promise<OfapiRawResponse> {
    const query = new URLSearchParams(options.query);
    const url = `${baseUrl}${options.pathname}${query.size > 0 ? `?${query.toString()}` : ""}`;
    const requestId = `${options.operation}:${randomUUID()}`;
    await waitForRequestSlot();

    let response: Response;
    try {
      const init: RequestInit & { dispatcher?: Dispatcher } = {
        method: "GET",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(OFAPI_PROXY_READ_TIMEOUT_MS),
      };
      if (context.dispatcher) {
        init.dispatcher = context.dispatcher;
      }
      response = await fetch(url, init);
    } catch (error) {
      throw new OfapiApiError(
        `OFAPI request failed: GET ${options.pathname}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        null,
        null,
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new OfapiApiError(
        `OFAPI response body read failed: GET ${options.pathname}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        null,
        null,
      );
    }
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }

    await reportCreditSpend({
      operation: options.operation,
      httpStatus: response.status,
      body,
      requestId,
      pageId: context.pageId ?? null,
      attemptNumber: 1,
      fallbackCredits: options.fallbackCredits,
      fallbackEstimated: options.fallbackEstimated,
      actorUserId: context.actorUserId ?? null,
    });

    const headers: Record<string, string> = {};
    for (const name of [
      "content-type",
      "retry-after",
      "x-ofapi-credits-used",
      "x-ofapi-credits-balance",
      "x-rate-limit-remaining-minute",
      "x-rate-limit-limit-minute",
    ]) {
      const value = response.headers.get(name);
      if (value !== null) {
        headers[name] = value;
      }
    }

    return {
      status: response.status,
      body,
      headers,
    };
  }

  type OfapiCommandMessageBody = {
    text: string;
    price?: number;
    mediaFiles?: Array<string | number>;
    previews?: Array<string | number>;
    lockedText?: true;
  };

  function toWireMediaId(id: string): string | number {
    return /^[0-9]+$/.test(id) ? Number(id) : id;
  }

  async function sendMessageRequest(
    context: OfapiRequestContext,
    accountId: string,
    conversationId: string,
    operation: "ofapi_command_send_text" | "ofapi_command_send_media",
    body: OfapiCommandMessageBody,
  ): Promise<OfapiSentMessage> {
    const pathname = `/${encodeURIComponent(accountId)}/chats/${
      encodeURIComponent(conversationId)
    }/messages`;
    const requestId = `${operation}:${randomUUID()}`;
    await waitForRequestSlot();

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${pathname}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(OFAPI_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new OfapiApiError(
        `OFAPI command transport failed: POST ${pathname}`,
        null,
        null,
      );
    }

    const text = await response.text();
    let responseBody: unknown = null;
    let bodyIsJson = text.length === 0;
    if (text.length > 0) {
      try {
        responseBody = JSON.parse(text) as unknown;
        bodyIsJson = true;
      } catch {
        bodyIsJson = false;
      }
    }

    await reportCreditSpend({
      operation,
      httpStatus: response.status,
      body: responseBody,
      requestId,
      pageId: context.pageId ?? null,
      attemptNumber: 1,
    });

    if (!response.ok) {
      const upstreamStatus = wrappedOnlyFansStatus(responseBody);
      throw new OfapiApiError(
        `OFAPI command rejected: POST ${pathname} returned ${response.status}`,
        response.status,
        null,
        upstreamStatus,
      );
    }
    if (!bodyIsJson) {
      throw new OfapiApiError(
        `OFAPI command returned non-JSON success: POST ${pathname}`,
        response.status,
        null,
      );
    }

    const record = asRecord(unwrapData(responseBody));
    const rawId = record?.id;
    const messageId = typeof rawId === "string" && rawId.length > 0
      ? rawId
      : typeof rawId === "number" && Number.isFinite(rawId)
        ? String(rawId)
        : null;
    if (!messageId) {
      throw new OfapiApiError(
        `OFAPI command success omitted message id: POST ${pathname}`,
        response.status,
        null,
      );
    }
    return { messageId };
  }

  async function sendTextMessageRequest(
    context: OfapiRequestContext,
    accountId: string,
    conversationId: string,
    command: { text: string },
  ): Promise<OfapiSentMessage> {
    return sendMessageRequest(
      context,
      accountId,
      conversationId,
      "ofapi_command_send_text",
      { text: command.text },
    );
  }

  async function sendMediaMessageRequest(
    context: OfapiRequestContext,
    accountId: string,
    conversationId: string,
    command: OfapiMediaMessageInput,
  ): Promise<OfapiSentMessage> {
    const body: OfapiCommandMessageBody = {
      text: command.text,
      price: command.price,
      mediaFiles: command.mediaFiles.map(toWireMediaId),
    };
    if (command.previews.length > 0) {
      body.previews = command.previews.map(toWireMediaId);
    }
    if (command.price > 0 && command.text.trim() !== "") {
      body.lockedText = true;
    }
    return sendMessageRequest(
      context,
      accountId,
      conversationId,
      "ofapi_command_send_media",
      body,
    );
  }

  async function startTypingRequest(
    context: OfapiRequestContext,
    accountId: string,
    conversationId: string,
  ): Promise<OfapiTypingResult> {
    const operation = "ofapi_command_typing_active";
    const pathname = `/${encodeURIComponent(accountId)}/chats/${
      encodeURIComponent(conversationId)
    }/typing`;
    const requestId = `${operation}:${randomUUID()}`;
    await waitForRequestSlot();

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${pathname}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(OFAPI_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new OfapiApiError(
        `OFAPI command transport failed: POST ${pathname}`,
        null,
        null,
      );
    }

    const text = await response.text();
    let responseBody: unknown = null;
    let bodyIsJson = text.length === 0;
    if (text.length > 0) {
      try {
        responseBody = JSON.parse(text) as unknown;
        bodyIsJson = true;
      } catch {
        bodyIsJson = false;
      }
    }

    await reportCreditSpend({
      operation,
      httpStatus: response.status,
      body: responseBody,
      requestId,
      pageId: context.pageId ?? null,
      attemptNumber: 1,
      fallbackCredits: 0,
      fallbackEstimated: true,
    });

    if (!response.ok) {
      throw new OfapiApiError(
        `OFAPI command rejected: POST ${pathname} returned ${response.status}`,
        response.status,
        null,
      );
    }
    if (!bodyIsJson) {
      throw new OfapiApiError(
        `OFAPI command returned non-JSON success: POST ${pathname}`,
        response.status,
        null,
      );
    }

    return { success: true };
  }

  async function unsendMessageRequest(
    context: OfapiRequestContext,
    accountId: string,
    conversationId: string,
    messageId: string,
  ): Promise<OfapiUnsendResult> {
    const operation = "ofapi_command_unsend_message";
    const pathname = `/${encodeURIComponent(accountId)}/chats/${
      encodeURIComponent(conversationId)
    }/messages/${encodeURIComponent(messageId)}`;
    const requestId = `${operation}:${randomUUID()}`;
    await waitForRequestSlot();

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${pathname}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(OFAPI_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new OfapiApiError(
        `OFAPI command transport failed: DELETE ${pathname}`,
        null,
        null,
      );
    }

    const text = await response.text();
    let responseBody: unknown = null;
    let bodyIsJson = text.length === 0;
    if (text.length > 0) {
      try {
        responseBody = JSON.parse(text) as unknown;
        bodyIsJson = true;
      } catch {
        bodyIsJson = false;
      }
    }

    await reportCreditSpend({
      operation,
      httpStatus: response.status,
      body: responseBody,
      requestId,
      pageId: context.pageId ?? null,
      attemptNumber: 1,
    });

    if (!response.ok) {
      throw new OfapiApiError(
        `OFAPI command rejected: DELETE ${pathname} returned ${response.status}`,
        response.status,
        null,
      );
    }
    if (!bodyIsJson) {
      throw new OfapiApiError(
        `OFAPI command returned non-JSON success: DELETE ${pathname}`,
        response.status,
        null,
      );
    }
    if (text.length === 0) {
      return { success: true };
    }

    const record = asRecord(unwrapData(responseBody));
    if (record?.success !== true) {
      throw new OfapiApiError(
        `OFAPI command success omitted success=true: DELETE ${pathname}`,
        response.status,
        null,
      );
    }
    return { success: true };
  }

  async function markChatReadRequest(
    context: OfapiRequestContext,
    accountId: string,
    conversationId: string,
  ): Promise<OfapiMarkReadResult> {
    const operation = "ofapi_command_mark_chat_read";
    const pathname = `/${encodeURIComponent(accountId)}/chats/${
      encodeURIComponent(conversationId)
    }/mark-as-read`;
    const requestId = `${operation}:${randomUUID()}`;
    await waitForRequestSlot();

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${pathname}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(OFAPI_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new OfapiApiError(
        `OFAPI command transport failed: POST ${pathname}`,
        null,
        null,
      );
    }

    const text = await response.text();
    let responseBody: unknown = null;
    let bodyIsJson = text.length === 0;
    if (text.length > 0) {
      try {
        responseBody = JSON.parse(text) as unknown;
        bodyIsJson = true;
      } catch {
        bodyIsJson = false;
      }
    }

    await reportCreditSpend({
      operation,
      httpStatus: response.status,
      body: responseBody,
      requestId,
      pageId: context.pageId ?? null,
      attemptNumber: 1,
    });

    if (!response.ok) {
      throw new OfapiApiError(
        `OFAPI command rejected: POST ${pathname} returned ${response.status}`,
        response.status,
        null,
      );
    }
    if (!bodyIsJson) {
      throw new OfapiApiError(
        `OFAPI command returned non-JSON success: POST ${pathname}`,
        response.status,
        null,
      );
    }
    if (text.length === 0) {
      return { success: true };
    }

    const record = asRecord(unwrapData(responseBody));
    if (record?.success !== true) {
      throw new OfapiApiError(
        `OFAPI command success omitted success=true: POST ${pathname}`,
        response.status,
        null,
      );
    }
    return { success: true };
  }

  async function request(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
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
    let responseBody: unknown = null;
    let bodyIsJson = text.length === 0;
    if (text.length > 0) {
      try {
        responseBody = JSON.parse(text) as unknown;
        bodyIsJson = true;
      } catch {
        bodyIsJson = false;
      }
    }

    // The admin path spends credits too (D1) — report before any throw so
    // failed registrations and 4xx/5xx responses with _meta still land.
    await reportCreditSpend({
      operation,
      httpStatus: response.status,
      body: responseBody,
      requestId: `${operation}:${randomUUID()}`,
      pageId: null,
      attemptNumber: 1,
    });

    if (!response.ok) {
      throw new OfapiApiError(
        `OFAPI request failed: ${method} ${path} returned ${response.status}`,
        response.status,
        text.slice(0, 2000),
      );
    }

    if (!bodyIsJson) {
      throw new OfapiApiError(
        `OFAPI request failed: ${method} ${path} returned non-JSON body`,
        response.status,
        text.slice(0, 2000),
      );
    }

    return responseBody;
  }

  return {
    async createWebhook(registration) {
      return toWebhookRecord(await request(
        "ofapi_webhook_crud",
        "POST",
        "/webhooks",
        webhookRequestBody(registration),
      ));
    },
    async updateWebhook(id, registration) {
      return toWebhookRecord(await request(
        "ofapi_webhook_crud",
        "PUT",
        `/webhooks/${encodeURIComponent(id)}`,
        webhookRequestBody(registration),
      ));
    },
    async listAccounts() {
      return toAccountRecords(await request("ofapi_admin_accounts", "GET", "/accounts"));
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
    async listActiveFans(context, accountId, params) {
      // Docs prose says 1-50 but validation caps at 20 ("Must not be greater
      // than 20") — clamp so a misconfigured caller can't 422 every request.
      const limit = Math.min(params.limit ?? OFAPI_FANS_PAGE_LIMIT, OFAPI_FANS_PAGE_LIMIT);
      const offset = params.offset ?? 0;
      return observedListRequest({
        context,
        operation: "ofapi_fans_active",
        endpointTemplate: "/:accountId/fans/active",
        pathname: `/${encodeURIComponent(accountId)}/fans/active`,
        query: {
          limit: String(limit),
          offset: offset > 0 ? String(offset) : undefined,
        },
        pageIndex: params.pageIndex ?? 0,
        cursorPresent: offset > 0,
        requestMetadata: { limit, offset },
        mapResponse: toFansListPage,
      });
    },
    async listTransactions(context, accountId, params) {
      const limit = Math.min(params.limit ?? 100, 100);
      return observedListRequest({
        context,
        operation: "ofapi_transactions",
        endpointTemplate: "/:accountId/transactions",
        pathname: `/${encodeURIComponent(accountId)}/transactions`,
        query: {
          limit: String(limit),
          startDate: params.startDate,
          marker: params.marker ?? undefined,
        },
        pageIndex: params.pageIndex ?? 0,
        cursorPresent: params.marker != null,
        requestMetadata: {
          limit,
          hasStartDate: params.startDate != null,
          hasMarker: params.marker != null,
        },
      });
    },
    async listChargebacks(context, accountId, params) {
      const limit = Math.min(params.limit ?? 100, 100);
      return observedListRequest({
        context,
        operation: "ofapi_chargebacks",
        endpointTemplate: "/:accountId/chargebacks",
        pathname: `/${encodeURIComponent(accountId)}/chargebacks`,
        query: {
          limit: String(limit),
          offset: params.offset != null ? String(params.offset) : undefined,
          start_date: params.startDate,
          end_date: params.endDate,
        },
        pageIndex: params.offset != null ? Math.floor(params.offset / limit) : 0,
        cursorPresent: false,
        requestMetadata: {
          limit,
          offset: params.offset ?? 0,
          hasStartDate: params.startDate != null,
        },
      });
    },
    async pingBalance(context, accountId) {
      return observedListRequest({
        context,
        operation: "ofapi_balance_ping",
        endpointTemplate: "/:accountId/chats",
        pathname: `/${encodeURIComponent(accountId)}/chats`,
        query: { limit: "1" },
        pageIndex: 0,
        cursorPresent: false,
        requestMetadata: { purpose: "balance_ping" },
      });
    },
    async proxyRead(context, options) {
      return proxyReadRequest(context, options);
    },
    async sendTextMessage(context, accountId, conversationId, command) {
      return sendTextMessageRequest(context, accountId, conversationId, command);
    },
    async sendMediaMessage(context, accountId, conversationId, command) {
      return sendMediaMessageRequest(context, accountId, conversationId, command);
    },
    async startTyping(context, accountId, conversationId) {
      return startTypingRequest(context, accountId, conversationId);
    },
    async unsendMessage(context, accountId, conversationId, messageId) {
      return unsendMessageRequest(context, accountId, conversationId, messageId);
    },
    async markChatRead(context, accountId, conversationId) {
      return markChatReadRequest(context, accountId, conversationId);
    },
  };
}
