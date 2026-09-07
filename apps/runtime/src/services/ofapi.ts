import type { OfapiExtendedCommandKind, OfapiExtendedCommandPayload } from "@agency_hub_core/shared";
import { buildOfapiSendV2Body, ofapiExtendedAction } from "./ofapi-command-composer.ts";
import { ofapiResponseEvidence } from "./ofapi-response-evidence.ts";
import type { OfapiUsageWindow } from "@agency_hub_core/contracts";
import type { OfapiCollectionContext } from "@agency_hub_core/shared";
import type { OfapiCollectionDispatch } from "./ofapi-collection-policy.ts";
// Client for the onlyfansapi.com API: webhook CRUD + account list (admin flow)
// plus credit-budgeted, observed chat/message reads for the DM sync (Phase 2 of
// docs/ofapi-integration-plan.md). Not to be confused with packages/onlyfans,
// which is the OnlyMonster adapter.

import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  classifyTransportFailure,
  executeObservedRequest,
  iterateErrorChain,
  type HttpRequestObserver,
} from "@agency_hub_core/shared";
import type { Dispatcher } from "undici";

import type { EgressPriorityClass } from "@agency_hub_core/platform-core";

import type { EgressPacer } from "./egress/pacer.ts";

import { normalizeOnlyFansAvatarUrl } from "./onlyfans.ts";

const OFAPI_REQUEST_TIMEOUT_MS = 15_000;
// Live-bug fix (2026-07-05): chat-message history reads scrape OnlyFans
// server-side and scale with chat size — two prod conversations consistently
// exceeded the 15 s abort (400 wasted attempts/24 h, zero successes ever on
// lora-of/lora-vip-of). Slow-lane timeout for that operation only.
const OFAPI_SLOW_READ_TIMEOUT_MS = 60_000;
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
  declare readonly validationResponse?: string;
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: string | null,
    readonly upstreamStatus: number | null = null,
    validationResponse?: string,
  ) {
    super(message);
    this.name = "OfapiApiError";
    // Explicit draft feedback is available to the outbox, never generic error serialization.
    if (validationResponse !== undefined) Object.defineProperty(this, "validationResponse", { value: validationResponse, enumerable: false });
  }
}

/** A missing account is a typed provider diagnosis, never a generic 404. */
export function ofapiAccountNotFound(status: number | null, body: string | null): boolean {
  if (status !== 404 || !body) return false;
  try {
    const parsed = asRecord(JSON.parse(body));
    const error = asRecord(parsed?.error);
    return (error?.code ?? parsed?.code ?? parsed?.error) === "account_not_found";
  } catch { return false; }
}

export interface OfapiWebhookRegistrationInput {
  endpointUrl: string;
  signingSecret: string;
  events: string[];
  accountScope: "global" | "inclusive" | "exclusive";
}

export interface OfapiWebhookRecord {
  id: string | null;
  creditAccounting?: "pending";
}

export interface OfapiAccountRecord {
  id: string;
  username: string | null;
  displayName: string | null;
  onlyfansName: string | null;
  onlyfansUserId: string | null;
  isAuthenticated?: boolean;
  identityStatus?: "verified" | "nested_fallback" | "missing" | "conflict";
  avatarUrl: string | null;
}

export interface OfapiRequestContext {
  collectionContext?: OfapiCollectionContext;
  requestObserver?: HttpRequestObserver | null;
  // Governed/gateway callers resolve the vendor transport in ofapi-egress.
  // Production OFAPI is vendor-direct; a page proxy is not account identity.
  dispatcher?: Dispatcher | null;
  egressKey?: string | null;
  // Attributes the request's credit spend to a page in the ledger (D2);
  // admin/account-global calls leave it unset.
  pageId?: number | null;
  // Stage 9: the acting principal for gateway reads; background REST
  // spenders leave it unset (NULL = system spend in the ledger).
  actorUserId?: number | null;
  // Attributes physical retry spend to a dedicated legacy lane as well as
  // the shared global ceiling. Governed mirror calls use their own plane.
  creditBudgetScope?: "audience" | "backfill" | "link_stats" | null;
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
  /** Internal acknowledgement that the physical-attempt sink accounted this
   * logical request. Test/custom clients omit it and use guard settlement. */
  creditSpendAccounted?: true;
}

export interface OfapiRawResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface OfapiGovernedRawResponse {
  status: number;
  bodyBytes: Buffer;
  headers: Record<string, string>;
  receivedAt: Date;
}

export interface OfapiTransportDiagnostics {
  stage: "response_headers" | "response_body";
  transportClass: "connect" | "timeout" | "transport" | null;
  causeName: string | null;
  causeCode: string | null;
  elapsedMs: number;
  timeoutMs: number;
  status: number | null;
  declaredLength: number | null;
  bytesRead: number;
  maxResponseBytes: number;
}

// Names/codes are untrusted strings too. Only known machine values may cross
// into durable/operator diagnostics; no message, URL, socket or proxy fields.
const DIAGNOSTIC_ERROR_NAMES = new Set([
  "Error", "TypeError", "AbortError", "TimeoutError", "ConnectTimeoutError",
  "HeadersTimeoutError", "BodyTimeoutError", "SocketError", "SocksClientError",
]);
const DIAGNOSTIC_ERROR_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH",
  "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "EHOSTDOWN", "ENETDOWN", "EPIPE",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function transportDiagnostics(
  error: unknown,
  input: Omit<OfapiTransportDiagnostics, "transportClass" | "causeName" | "causeCode" | "elapsedMs"> & {
    startedAt: number;
  },
): OfapiTransportDiagnostics {
  let causeName: string | null = null;
  let causeCode: string | null = null;
  for (const cause of iterateErrorChain(error)) {
    if (!(cause instanceof Error)) continue;
    if (DIAGNOSTIC_ERROR_NAMES.has(cause.name)) causeName = cause.name;
    const code = (cause as Error & { code?: unknown }).code;
    if (typeof code === "string" && DIAGNOSTIC_ERROR_CODES.has(code)) causeCode = code;
  }
  const { startedAt, ...fields } = input;
  return {
    ...fields,
    transportClass: error === null ? null : classifyTransportFailure(error),
    causeName,
    causeCode,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  };
}

export class OfapiGovernedRequestError extends Error {
  readonly diagnostics: OfapiTransportDiagnostics | undefined;
  constructor(
    message: string,
    readonly phase: "pre_dispatch" | "post_dispatch",
    readonly reason: "cancelled" | "deadline" | "transport" | "body_read" | "body_too_large",
    options?: { cause?: unknown; diagnostics?: OfapiTransportDiagnostics },
  ) {
    super(message, options);
    this.name = "OfapiGovernedRequestError";
    this.diagnostics = options?.diagnostics;
  }
}

export interface OfapiSentMessage {
  messageId: string;
  creditAccounting?: "pending";
}

export interface OfapiMediaMessageInput {
  text: string;
  price: number;
  mediaFiles: string[];
  previews: string[];
}

export interface OfapiTypingResult {
  success: true;
  creditAccounting?: "pending";
}

export interface OfapiUnsendResult {
  success: true;
  creditAccounting?: "pending";
}

export interface OfapiMarkReadResult {
  success: true;
  creditAccounting?: "pending";
}

// One credit-spend report per response that reached the server (retry attempts
// included — OFAPI charged each). Emitted by the client itself on BOTH request
// paths, so callers cannot forget to account spend (D1).
export interface OfapiCreditSpendObservation {
  responseEvidence?: ReturnType<typeof ofapiResponseEvidence>["evidence"];
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
  budgetScope?: "audience" | "backfill" | "link_stats" | null;
  receivedAt?: string;
}

export type OfapiCreditSpendSink = ((
  observation: OfapiCreditSpendObservation,
) => Promise<boolean | null | void> | boolean | null | void) & {
  recoverPending?: () => Promise<boolean>;
};

/** A new request was refused locally; an earlier response still needs accounting. */
export class OfapiCreditAccountingUnavailableError extends OfapiApiError {
  constructor() {
    super("OFAPI credit accounting unavailable before dispatch", null, null);
    this.name = "OfapiCreditAccountingUnavailableError";
  }
}

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

export interface OfapiAdminCapture { observationId: number; receivedAt: Date }

export interface OfapiClient {
  getBannedWordsPage?(page: number): Promise<{ body: unknown; evidence: OfapiAdminCapture | null }>;
  executeExtendedCommand?(context: OfapiRequestContext, accountId: string, conversationId: string, kind: OfapiExtendedCommandKind, payload: OfapiExtendedCommandPayload, providerKey?: string): Promise<{ messageId?: string; creditAccounting?: "pending" }>;
  getCreditUsage?(window: OfapiUsageWindow): Promise<{ body: unknown; evidence: OfapiAdminCapture | null }>;
  createWebhook(input: OfapiWebhookRegistrationInput): Promise<OfapiWebhookRecord>;
  updateWebhook(id: string, input: OfapiWebhookRegistrationInput): Promise<OfapiWebhookRecord>;
  listAccounts(): Promise<OfapiAccountRecord[]>;
  listAccountsSnapshot?(): Promise<{ accounts: OfapiAccountRecord[]; evidence: OfapiAdminCapture | null }>;
  getCredentialPreflight?(): Promise<OfapiCredentialPreflight>;
  assertCredentialReady?(): Promise<void>;
  /** Drains pending credit receipts; rejects with OfapiCreditAccountingUnavailableError while accounting is unready. */
  assertCreditAccountingReady?(): Promise<void>;
  getWebhook?(id: string): Promise<Record<string, unknown>>;
  listWebhookEvents?(): Promise<{ body: unknown; capture: OfapiAdminCapture | null }>;
  listWebhooks?(): Promise<Record<string, unknown>[]>;
  listWebhookDeliveries?(id: string, params: { from: string; to: string; limit: number; offset: number }): Promise<{ body: unknown; capture: OfapiAdminCapture | null }>;
  redeliverWebhookDelivery?(id: string, attemptId: number): Promise<{ body: unknown; capture: OfapiAdminCapture | null }>;

  listDataExports?(input: { page: number; perPage: number; type: string }): Promise<{ body: unknown; capture: OfapiAdminCapture | null }>;
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
      // Per-request retry override (0 = single attempt). The DM circuit
      // breaker's adaptive limit probes must not multiply a 60s vendor
      // timeout by the default retry budget.
      retries?: number;
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
  // Stage 14 tracking/trial-link family (fan_identities OFAPI branch). All are
  // data.list + limit/offset per the vendored spec.
  listTrackingLinks?(
    context: OfapiRequestContext,
    accountId: string,
    params: { limit?: number; offset?: number },
  ): Promise<OfapiListPage>;
  listTrackingLinkUsers?(
    context: OfapiRequestContext,
    accountId: string,
    trackingLinkId: string,
    kind: "subscribers" | "spenders",
    params: { limit?: number; offset?: number },
  ): Promise<OfapiListPage>;
  listTrialLinks?(
    context: OfapiRequestContext,
    accountId: string,
    params: { limit?: number; offset?: number },
  ): Promise<OfapiListPage>;
  listTrialLinkSubscribers?(
    context: OfapiRequestContext,
    accountId: string,
    trialLinkId: string,
    params: { limit?: number; offset?: number },
  ): Promise<OfapiListPage>;
  // Free stored-cache variants of the two link lists (no OnlyFans call,
  // `_credits.used: 0` per the vendored spec; live-verified 2026-07-22): same
  // item shape as the live endpoints, limit up to 1000, and the cache also
  // returns finished/removed links the live list hides.
  listStoredTrackingLinks?(
    context: OfapiRequestContext,
    accountId: string,
    params: { limit?: number; offset?: number },
  ): Promise<OfapiListPage>;
  listStoredTrialLinks?(
    context: OfapiRequestContext,
    accountId: string,
    params: { limit?: number; offset?: number },
  ): Promise<OfapiListPage>;
  // Free, account-independent usage balance probe; retained method name for callers.
  pingBalance(context: OfapiRequestContext, accountId?: string): Promise<OfapiListPage>;
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
  // Capture-first transport. The caller durably reserves the attempt before
  // calling this method and atomically flips it to dispatching in
  // beforeDispatch. The client performs exactly one HTTP request and returns
  // unparsed bytes; credit settlement and parsing happen only after capture.
  dispatchGovernedRaw?(
    context: OfapiRequestContext,
    input: {
      attemptId: string;
      operation: string;
      method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
      pathname: string;
      query?: Record<string, string>;
      bodyBytes?: Buffer | null;
      contentType?: string | null;
      priorityClass: EgressPriorityClass;
      deadlineAt: Date;
      timeoutMs?: number;
      maxResponseBytes?: number;
      deferAccountResponse?: boolean;
      beforeDispatch: () => Promise<boolean>;
    },
  ): Promise<OfapiGovernedRawResponse>;
  recordGovernedAccountResponse?(accountId: string, generation: number, status: number, body: string): Promise<void>;
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
  // as free, so an absent/non-charging _meta does not create a permanent credit
  // ledger row; an unexpected provider-reported charge is still recorded.
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

export function toAccountRecords(value: unknown): OfapiAccountRecord[] {
  const data = unwrapData(value);
  if (!Array.isArray(data)) {
    throw new OfapiApiError("OFAPI account roster shape unavailable", 200, null);
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
    const top = asStringId(record?.onlyfans_id);
    const nested = [onlyfansUserData?.id, record?.onlyfans_user_id, record?.onlyfansUserId]
      .map(asStringId).filter((id): id is string => id !== null);
    const ids = [...new Set([top, ...nested].filter((id): id is string => id !== null))];
    const invalidNumericId = [record?.onlyfans_id, onlyfansUserData?.id, record?.onlyfans_user_id, record?.onlyfansUserId]
      .some(value => typeof value === "number" && !Number.isSafeInteger(value));
    const conflict = invalidNumericId || ids.length > 1 || ids.some(id => !/^[1-9]\d*$/.test(id));
    accounts.push({
      id,
      ...(typeof record?.is_authenticated === "boolean" ? { isAuthenticated: record.is_authenticated } : {}),
      username: firstNonEmptyString(
        record?.onlyfans_username,
        record?.onlyfansUsername,
        onlyfansUserData?.username,
        record?.username,
      ),
      displayName: firstNonEmptyString(record?.display_name, record?.displayName),
      onlyfansName: firstNonEmptyString(onlyfansUserData?.name, record?.name),
      onlyfansUserId: conflict ? null : ids[0] ?? null,
      identityStatus: conflict ? "conflict" : top ? "verified" : ids.length ? "nested_fallback" : "missing",
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

export function parseResponseMeta(body: unknown, headers?: Headers | Record<string, string>): OfapiResponseMeta | null {
  const parsed = ofapiResponseEvidence(body, headers);
  return parsed.present ? parsed.meta : null;
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

function toListPage(body: unknown, arrayOnlyLimit?: number): OfapiListPage {
  const record = asRecord(body);
  const dataRecord = asRecord(record?.data);
  const data = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(dataRecord?.list)
      ? dataRecord.list
      : null;
  if (data === null) throw new OfapiApiError("OFAPI list page shape unavailable", 200, null);
  const pagination = asRecord(record?._pagination);
  const nextPage = pagination?.next_page;
  const nextMarker = parseNextMarker(dataRecord) ?? parseNextMarker(pagination);
  const hasMore = dataRecord?.hasMore;
  if (hasMore !== undefined && typeof hasMore !== "boolean") {
    throw new OfapiApiError("OFAPI list page continuation invalid", 200, null);
  }
  if (nextPage !== undefined && nextPage !== null && typeof nextPage !== "string") {
    throw new OfapiApiError("OFAPI list page continuation invalid", 200, null);
  }
  // Spenders alone document an unpaginated array family. Every other list
  // needs explicit continuation/termination evidence; missing is not empty.
  if (typeof hasMore !== "boolean" && nextPage === undefined && nextMarker === null &&
      !(arrayOnlyLimit !== undefined && Array.isArray(record?.data))) {
    throw new OfapiApiError("OFAPI list page continuation unavailable", 200, null);
  }
  return {
    items: data.map((item) => {
      const itemRecord = asRecord(item);
      if (!itemRecord) throw new OfapiApiError("OFAPI list item shape unavailable", 200, null);
      return itemRecord;
    }),
    hasNextPage: (typeof nextPage === "string" && nextPage.length > 0) ||
      (typeof hasMore === "boolean" ? hasMore : nextMarker !== null ? true : nextPage === null ? false :
        arrayOnlyLimit !== undefined && data.length >= arrayOnlyLimit),
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
  if (!Array.isArray(dataRecord?.list) && !Array.isArray(data)) {
    throw new OfapiApiError("OFAPI fan page shape unavailable", 200, null);
  }
  const pagination = asRecord(record?._pagination);
  const nextPage = pagination?.next_page;
  if (typeof dataRecord?.hasMore !== "boolean" && nextPage !== null && typeof nextPage !== "string") {
    throw new OfapiApiError("OFAPI fan page continuation unavailable", 200, null);
  }
  return {
    items: list.map(item => {
      const itemRecord = asRecord(item);
      if (!itemRecord) throw new OfapiApiError("OFAPI fan item shape unavailable", 200, null);
      return itemRecord;
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

export interface OfapiCredentialPreflight {
  status: "verified" | "unknown" | "mismatch" | "denied";
  expectedTeam: string | null;
  observedTeam: string | null;
  credentialFingerprint: string;
  checkedAt: string;
  reason: string | null;
  rosterScope: "unknown";
}

/** A local adoption refusal, distinguishable from an HTTP response. The base
 * class keeps existing non-command callers' error mapping compatible. */
export class OfapiCredentialNotReadyError extends OfapiApiError {
  constructor(
    readonly preflightStatus: OfapiCredentialPreflight["status"],
    readonly reason: string | null,
  ) {
    super(`OFAPI credential preflight ${preflightStatus}`, 403, null);
    this.name = "OfapiCredentialNotReadyError";
  }
}

export function createOfapiClient(input: {
  beforeCollectionRequest?: (input: OfapiCollectionDispatch) => Promise<void>;
  onCollectionResponse?: (requestId: string, actualCredits: number | null) => Promise<void>;
  onCollectionCancelled?: (requestId: string) => Promise<void>;
  credentialPolicy?: { expectedTeamSlug: string | null };
  beforeOperationRequest?: (request: { operation: string; accountId: string | null; method: string }) => Promise<void>;
  beforeAccountRequest?: (pageId: number | null | undefined, accountId: string, generation?: number) => Promise<number>;
  onAccountResponse?: (accountId: string, generation: number, status: number, body: string) => Promise<void>;
  onAdminResponse?: (response: { operation: string; status: number; body: string; receivedAt: Date; headers?: Record<string, string>; pageId?: number | null; accountId?: string }) => Promise<void | OfapiAdminCapture>;
  onPreflight?: (result: OfapiCredentialPreflight) => Promise<void>;
  baseUrl?: string;
  apiKey: string;
  restDelayMs?: number;
  onCreditSpend?: OfapiCreditSpendSink | null;
  // Stage 26: class-aware egress pacer. shadow = the legacy process-global
  // slot still enforces while the pacer's decision is computed off-path and
  // reported through onShadowDiff; enforce = the pacer paces.
  pacer?: EgressPacer | null;
  onShadowDiff?: (diff: {
    priorityClass: EgressPriorityClass;
    oldWaitMs: number;
    newWaitMs: number;
  }) => void;
}): OfapiClient {
  const baseUrl = (input.baseUrl ?? OFAPI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const restDelayMs = Math.max(0, input.restDelayMs ?? OFAPI_DEFAULT_REST_DELAY_MS);
  const onCreditSpend = input.onCreditSpend ?? null;
  async function authorizeOperation(operation: string, method: string, pathname: string) {
    const segment = pathname.split("/")[1];
    await input.beforeOperationRequest?.({ operation, method,
      accountId: segment?.startsWith("acct_") ? decodeURIComponent(segment) : null });
  }
  let pendingCreditReceipts = new Map<string, OfapiCreditSpendObservation>();
  function retirePendingReceipt(key: string) {
    // Retire only process memory; the durable financial receipt stays retained.
    pendingCreditReceipts = new Map([...pendingCreditReceipts].filter(([pendingKey]) => pendingKey !== key));
  }
  let accountingRecovery: Promise<void> | null = null;
  async function assertCreditAccountingReady() {
    accountingRecovery ??= (async () => {
      if (!onCreditSpend) return;
      for (const [key, receipt] of pendingCreditReceipts) {
        let result: boolean | null | void;
        try { result = await onCreditSpend(receipt); }
        catch { throw new OfapiCreditAccountingUnavailableError(); }
        if (result === false) throw new OfapiCreditAccountingUnavailableError();
        retirePendingReceipt(key);
      }
      if (onCreditSpend.recoverPending && !await onCreditSpend.recoverPending()) {
        throw new OfapiCreditAccountingUnavailableError();
      }
    })();
    try { await accountingRecovery; }
    finally { accountingRecovery = null; }
  }

  let preflight: Promise<OfapiCredentialPreflight> | null = null;
  let preflightRetryAt = 0;
  async function getCredentialPreflight(): Promise<OfapiCredentialPreflight> {
    // A single shared in-flight promise owns refresh. Do not move the retry
    // deadline at start: concurrent callers must await that same fresh result.
    if (preflight && Date.now() >= preflightRetryAt) preflight = null;
    preflight ??= (async () => {
      const result: OfapiCredentialPreflight = {
        status: "unknown", expectedTeam: input.credentialPolicy?.expectedTeamSlug ?? null,
        observedTeam: null, credentialFingerprint: createHash("sha256").update(input.apiKey).digest("hex"),
        checkedAt: new Date().toISOString(), reason: "expected_team_unconfigured", rosterScope: "unknown",
      };
      if (result.expectedTeam) {
        try {
          const body = await request("ofapi_credential_preflight", "GET", "/whoami");
          result.observedTeam = firstNonEmptyString(asRecord(asRecord(body)?.team)?.slug);
          result.status = result.observedTeam === null ? "unknown" : result.observedTeam === result.expectedTeam ? "verified" : "mismatch";
          result.reason = result.status === "verified" ? null : result.status === "mismatch" ? "team_mismatch" : "team_missing";
        } catch (error) {
          // HTML edge rejection is indeterminate access, not provider IAM.
          const denied = error instanceof OfapiApiError && [401, 403].includes(error.status ?? 0) &&
            error.body?.trimStart().startsWith("{");
          result.status = denied ? "denied" : "unknown";
          result.reason = denied ? "provider_access_denied" : "preflight_unavailable";
        }
      }
      try {
        await input.onPreflight?.(result);
      } catch {
        result.status = "unknown";
        result.reason = "preflight_persistence_unavailable";
      }
      preflightRetryAt = result.status === "verified" || result.status === "mismatch" ||
        result.reason === "expected_team_unconfigured" ? Infinity : Date.now() + 30_000;
      return result;
    })();
    // Infinity denotes in-flight, too; only settlement sets a retry deadline.
    if (preflightRetryAt <= Date.now()) preflightRetryAt = Infinity;
    return preflight;
  }
  async function assertCredentialReady() {
    if (!input.credentialPolicy) return; // Injection-only clients have no adoption policy.
    const checked = await getCredentialPreflight();
    if (checked.status !== "verified") throw new OfapiCredentialNotReadyError(checked.status, checked.reason);
  }

  // Reports one physical response's spend before retry/return. A configured
  // sink can fail closed so a billed attempt is never followed by more egress
  // while both durable accounting paths are unavailable.
  async function reportCreditSpend(report: {
    operation: string;
    httpStatus: number;
    headers?: Headers;
    body: unknown;
    requestId: string;
    pageId: number | null;
    attemptNumber: number;
    fallbackCredits?: number;
    fallbackEstimated?: boolean;
    /** Ephemeral free operations (typing) must not create one permanent
     * ledger row per UI beacon. A provider-reported non-zero charge still
     * reaches the sink and is never hidden. */
    suppressZeroCredits?: boolean;
    actorUserId?: number | null;
    budgetScope?: "audience" | "backfill" | "link_stats" | null;
  }) {
    const meta = parseResponseMeta(report.body, report.headers);
    await input.onCollectionResponse?.(`${report.requestId}:${report.attemptNumber}`, meta?.creditsUsed ?? null);
    if (!onCreditSpend) {
      return null;
    }
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
      return null;
    }
    if (report.suppressZeroCredits === true && spend.credits === 0) {
      return null;
    }

    const observation: OfapiCreditSpendObservation = {
        responseEvidence: ofapiResponseEvidence(report.body, report.headers).evidence,
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
        receivedAt: new Date().toISOString(),
        ...(report.budgetScope ? { budgetScope: report.budgetScope } : {}),
    };
    const key = `${observation.requestId}:${observation.attemptNumber}`;
    pendingCreditReceipts.set(key, observation);
    try {
      const outcome = await onCreditSpend(observation);
      if (outcome !== false) retirePendingReceipt(key);
      // Existing injected sinks are observational and return void. Treat that
      // as acknowledgement; the production sink returns explicit true/false.
      return outcome === undefined ? true : outcome;
    } catch {
      // A configured sink that throws did not establish durable accounting.
      return false;
    }
  }
  // Client-wide pacing across concurrent executor chunks: each caller claims the
  // next slot and sleeps until it; OFAPI rate limits are account-global.
  // Stage 26: in enforce mode the class-aware DB pacer replaces this slot
  // machine; in shadow mode the slot machine still enforces while the pacer's
  // decision is computed fire-and-forget (no latency added) and diffed.
  const pacer = input.pacer ?? null;
  let nextRequestSlotAt = 0;

  async function waitForRequestSlot(priorityClass: EgressPriorityClass = "bulk", checkAccounting = true) {
    if (checkAccounting) await assertCreditAccountingReady();
    if (pacer && pacer.mode === "enforce") {
      return pacer.pace(priorityClass);
    }

    const now = Date.now();
    const slotAt = Math.max(now, nextRequestSlotAt);
    nextRequestSlotAt = slotAt + restDelayMs;
    const waitMs = slotAt - now;

    if (pacer && pacer.mode === "shadow") {
      void pacer.plan(priorityClass)
        .then((decision) => {
          input.onShadowDiff?.({
            priorityClass,
            oldWaitMs: waitMs,
            newWaitMs: decision.waitMs,
          });
        })
        .catch(() => undefined);
    }

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
    timeoutMs?: number;
    // Caller override of the transport/HTTP retry budget (0 = single attempt).
    retries?: number;
  }): Promise<OfapiListPage> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) {
        query.set(key, value);
      }
    }
    const url = `${baseUrl}${options.pathname}${query.size > 0 ? `?${query.toString()}` : ""}`;
    const requestId = `${options.operation}:${randomUUID()}`;
    const accountId = options.pathname.split("/")[1]!;
    const generation = await input.beforeAccountRequest?.(options.context.pageId, accountId);

    let collectionAttempt = 0;
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
      retries: options.retries ?? OFAPI_OBSERVED_RETRIES,
      waitForRateLimit: async () => {
        const waited = await waitForRequestSlot("bulk");
        // Admission is outside the transport retry catch, but is evaluated
        // before every physical attempt, including a permitted HTTP retry.
        await authorizeOperation(options.operation, "GET", options.pathname);
        return waited;
      },
      execute: async () => {
        await input.beforeAccountRequest?.(options.context.pageId, accountId, generation);
        collectionAttempt += 1;
        await input.beforeCollectionRequest?.({ operation: options.operation, method: "GET", accountId, pageId: options.context.pageId, requestId: `${requestId}:${collectionAttempt}`, context: options.context.collectionContext });
        const response = await fetch(url, {
          method: "GET",
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(options.timeoutMs ?? OFAPI_REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        if (generation !== undefined) await input.onAccountResponse?.(accountId, generation, response.status, text);
        return { response, text };
      },
      onTransportError: (error, executionContext) => {
        // A collection-policy refusal happens before any fetch: it is a local
        // decision, not a vendor outage. It gets its own attempt failure kind
        // and surfaces unchanged so the executor can read `reason`/`retryAt`
        // (review #136). Never a transport retry.
        if (error instanceof Error && error.name === "OfapiCollectionPolicyError") {
          return {
            kind: "failed",
            failureKind: "policy",
            errorMessage: `OFAPI collection policy refused ${options.operation}: ${
              (error as { reason?: unknown }).reason ?? "unknown"
            }`,
            error,
          };
        }
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
        const creditSpendRecorded = await reportCreditSpend({
          operation: options.operation,
          httpStatus: response.status,
          headers: response.headers,
          body,
          requestId,
          pageId: options.context.pageId ?? null,
          attemptNumber: executionContext.attemptNumber,
          budgetScope: options.context.creditBudgetScope ?? null,
        });

        if (creditSpendRecorded === false) {
          const message =
            `OFAPI request failed closed: credit accounting unavailable for ${options.operation}`;
          return {
            kind: "failed",
            failureKind: "transport",
            httpStatus: response.status,
            errorMessage: message,
            // Keep this outside vendor HTTP classification: callers must stop
            // the whole request path, not quarantine one resource and continue.
            error: new OfapiApiError(message, null, null),
          };
        }

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
          value: creditSpendRecorded === true
            ? { ...page, creditSpendAccounted: true as const }
            : page,
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
    await waitForRequestSlot("interactive");

    const accountId = options.pathname.split("/")[1]!;
    const generation = await input.beforeAccountRequest?.(context.pageId, accountId);
    await authorizeOperation(options.operation, "GET", options.pathname);
    await input.beforeCollectionRequest?.({ operation: options.operation, method: "GET", accountId, pageId: context.pageId, requestId: `${requestId}:1`, context: context.collectionContext, interactive: true, reservedCredits: options.fallbackCredits });
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
    if (generation !== undefined) await input.onAccountResponse?.(accountId, generation, response.status, text);
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }

    const creditAccounted = await reportCreditSpend({
      operation: options.operation,
      httpStatus: response.status,
      headers: response.headers,
      body,
      requestId,
      pageId: context.pageId ?? null,
      attemptNumber: 1,
      fallbackCredits: options.fallbackCredits,
      fallbackEstimated: options.fallbackEstimated,
      actorUserId: context.actorUserId ?? null,
    });

    if (creditAccounted === false) throw new OfapiApiError("OFAPI read credit accounting unavailable", null, null);

    const headers: Record<string, string> = {};
    for (const name of [
      "content-type",
      "retry-after",
      "x-ofapi-credits-used",
      "x-ofapi-credits-balance",
      "x-ofapi-is-cached",
      "idempotent-replayed",
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

  async function readGovernedResponseBytes(
    response: Response, maxBytes: number, startedAt: number, timeoutMs: number,
  ) {
    const contentLength = response.headers.get("content-length");
    const length = contentLength === null ? NaN : Number(contentLength);
    const declaredLength = Number.isFinite(length) && length >= 0 ? length : null;
    const details = (error: unknown, bytesRead: number) => transportDiagnostics(error, {
      startedAt, timeoutMs, stage: "response_body", status: response.status,
      declaredLength, bytesRead, maxResponseBytes: maxBytes,
    });
    if (declaredLength !== null && declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new OfapiGovernedRequestError(
        `OFAPI response exceeds ${maxBytes} byte capture limit`,
        "post_dispatch",
        "body_too_large",
        { diagnostics: details(null, 0) },
      );
    }

    if (!response.body) {
      return Buffer.alloc(0);
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        const chunk = Buffer.from(result.value);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new OfapiGovernedRequestError(
            `OFAPI response exceeds ${maxBytes} byte capture limit`,
            "post_dispatch",
            "body_too_large",
            { diagnostics: details(null, totalBytes) },
          );
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof OfapiGovernedRequestError) {
        throw error;
      }
      throw new OfapiGovernedRequestError(
        "OFAPI governed response body read failed",
        "post_dispatch",
        "body_read",
        { cause: error, diagnostics: details(error, totalBytes) },
      );
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, totalBytes);
  }

  async function dispatchGovernedRawRequest(
    context: OfapiRequestContext,
    options: Parameters<NonNullable<OfapiClient["dispatchGovernedRaw"]>>[1],
  ): Promise<OfapiGovernedRawResponse> {
    try {
      await waitForRequestSlot(options.priorityClass);
      await authorizeOperation(options.operation, options.method, options.pathname);
    }
    catch (error) {
      throw new OfapiGovernedRequestError("OFAPI dispatch admission unavailable", "pre_dispatch", "cancelled", { cause: error });
    }
    if (Date.now() >= options.deadlineAt.getTime()) {
      throw new OfapiGovernedRequestError(
        `OFAPI governed attempt ${options.attemptId} missed its deadline`,
        "pre_dispatch",
        "deadline",
      );
    }

    const accountId = options.pathname.split("/")[1]!;
    let generation: number | undefined;
    if (accountId.startsWith("acct_")) {
      try { generation = await input.beforeAccountRequest?.(context.pageId, accountId); }
      catch (error) { throw new OfapiGovernedRequestError("OFAPI binding unavailable", "pre_dispatch", "cancelled", { cause: error }); }
    }
    try {
      await input.beforeCollectionRequest?.({ operation: options.operation, method: options.method, accountId: options.pathname.split("/")[1]!, pageId: context.pageId, requestId: options.attemptId, context: context.collectionContext, interactive: options.priorityClass === "interactive" && context.actorUserId != null });
    } catch (error) {
      throw new OfapiGovernedRequestError("OFAPI collection policy refused dispatch", "pre_dispatch", "cancelled", { cause: error });
    }
    let mayDispatch = false;
    let dispatchError: unknown;
    try {
      mayDispatch = await options.beforeDispatch();
    } catch (error) {
      dispatchError = error;
    }
    if (!mayDispatch) {
      // The callback checks changing authority as well as the durable fence.
      // A thrown check still precedes HTTP and must release unused admission.
      try {
        await input.onCollectionCancelled?.(options.attemptId);
      } catch (error) {
        dispatchError = dispatchError === undefined ? error
          : new AggregateError([dispatchError, error], "OFAPI pre-dispatch cleanup failed");
      }
      throw new OfapiGovernedRequestError(
        `OFAPI governed attempt ${options.attemptId} lost its dispatch fence`,
        "pre_dispatch",
        "cancelled",
        { cause: dispatchError },
      );
    }

    const query = new URLSearchParams(options.query ?? {});
    const url = `${baseUrl}${options.pathname}${query.size > 0 ? `?${query.toString()}` : ""}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${input.apiKey}`,
      accept: "application/json",
      "x-agency-hub-attempt-id": options.attemptId,
    };
    if (options.contentType) {
      headers["content-type"] = options.contentType;
    }

    let response: Response;
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? OFAPI_PROXY_READ_TIMEOUT_MS;
    const maxResponseBytes = Math.max(1, options.maxResponseBytes ?? 10 * 1024 * 1024);
    try {
      const init: RequestInit & { dispatcher?: Dispatcher } = {
        method: options.method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (options.bodyBytes) {
        init.body = Uint8Array.from(options.bodyBytes);
      }
      if (context.dispatcher) {
        init.dispatcher = context.dispatcher;
      }
      response = await fetch(url, init);
    } catch (error) {
      throw new OfapiGovernedRequestError(
        "OFAPI governed request failed before response headers",
        "post_dispatch",
        "transport",
        { cause: error, diagnostics: transportDiagnostics(error, {
          startedAt, timeoutMs, stage: "response_headers", status: null,
          declaredLength: null, bytesRead: 0, maxResponseBytes,
        }) },
      );
    }

    const receivedAt = new Date();
    const bodyBytes = await readGovernedResponseBytes(
      response,
      maxResponseBytes, startedAt, timeoutMs,
    );
    if (generation !== undefined && !options.deferAccountResponse) await input.onAccountResponse?.(accountId, generation, response.status, bodyBytes.toString("utf8"));
    const responseHeaders: Record<string, string> = {};
    for (const name of [
      "content-type",
      "retry-after",
      "x-ofapi-credits-used",
      "x-ofapi-credits-balance",
      "x-ofapi-is-cached",
      "idempotent-replayed",
      "x-rate-limit-remaining-minute",
      "x-rate-limit-limit-minute",
    ]) {
      const value = response.headers.get(name);
      if (value !== null) {
        responseHeaders[name] = value;
      }
    }

    return {
      status: response.status,
      bodyBytes,
      headers: responseHeaders,
      receivedAt,
    };
  }

  type OfapiCommandMessageBody = {
    text: string;
    price?: number;
    mediaFiles?: Array<string | number>;
    previews?: Array<string | number>;
    lockedText?: boolean;
    replyToMessageId?: string | number;
    giphyId?: string;
    rfTag?: Array<string | number>;
    rfPartner?: Array<string | number>;
    rfGuest?: Array<string | number>;
    blockBannedWords?: string;
  };

  function toWireMediaId(id: string): string | number {
    const numeric = /^[0-9]+$/.test(id) ? Number(id) : NaN;
    return Number.isSafeInteger(numeric) ? numeric : id;
  }

  async function sendMessageRequest(
    context: OfapiRequestContext,
    accountId: string,
    conversationId: string,
    operation: "ofapi_command_send_text" | "ofapi_command_send_media" | "ofapi_command_send_v2",
    body: OfapiCommandMessageBody,
    providerKey?: string,
  ): Promise<OfapiSentMessage> {
    const pathname = `/${encodeURIComponent(accountId)}/chats/${
      encodeURIComponent(conversationId)
    }/messages`;
    const requestId = `${operation}:${randomUUID()}`;
    await waitForRequestSlot("commands");

    await authorizeOperation(operation, "POST", pathname);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${pathname}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          accept: "application/json",
          "content-type": "application/json",
          ...(providerKey ? { "Idempotency-Key": providerKey } : {}),
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
    let captureError: unknown;
    if (operation === "ofapi_command_send_v2") {
      try { await input.onAdminResponse?.({ operation, status: response.status, body: text, receivedAt: new Date(), pageId: context.pageId ?? null, accountId,
        headers: Object.fromEntries(["x-ofapi-credits-used", "x-ofapi-credits-balance", "idempotent-replayed"].flatMap(name => { const value = response.headers.get(name); return value === null ? [] : [[name, value]]; })) }); }
      catch (error) { captureError = error; }
    }
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

    const creditAccounted = await reportCreditSpend({
      operation,
      httpStatus: response.status,
      headers: response.headers,
      body: responseBody,
      requestId,
      pageId: context.pageId ?? null,
      attemptNumber: 1,
    });

    if (captureError) throw new OfapiApiError("OFAPI response capture unavailable after dispatch", null, null);
    if (!response.ok) {
      const upstreamStatus = wrappedOnlyFansStatus(responseBody);
      throw new OfapiApiError(
        `OFAPI command rejected: POST ${pathname} returned ${response.status}`,
        response.status,
        null,
        upstreamStatus,
        operation === "ofapi_command_send_v2" && response.status === 422 ? text.slice(0, 4000) : undefined,
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
      : typeof rawId === "number" && Number.isSafeInteger(rawId)
        ? String(rawId)
        : null;
    if (!messageId) {
      throw new OfapiApiError(
        `OFAPI command success omitted message id: POST ${pathname}`,
        response.status,
        null,
      );
    }
    return { messageId, ...(creditAccounted === false ? { creditAccounting: "pending" as const } : {}) };
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
    await waitForRequestSlot("commands");

    await authorizeOperation(operation, "POST", pathname);
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

    const creditAccounted = await reportCreditSpend({
      operation,
      httpStatus: response.status,
      headers: response.headers,
      body: responseBody,
      requestId,
      pageId: context.pageId ?? null,
      attemptNumber: 1,
      fallbackCredits: 0,
      fallbackEstimated: true,
      suppressZeroCredits: true,
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

    return { success: true, ...(creditAccounted === false ? { creditAccounting: "pending" as const } : {}) };
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
    await waitForRequestSlot("commands");

    await authorizeOperation(operation, "DELETE", pathname);
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

    const creditAccounted = await reportCreditSpend({
      operation,
      httpStatus: response.status,
      headers: response.headers,
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
      return { success: true, ...(creditAccounted === false ? { creditAccounting: "pending" as const } : {}) };
    }

    const record = asRecord(unwrapData(responseBody));
    if (record?.success !== true) {
      throw new OfapiApiError(
        `OFAPI command success omitted success=true: DELETE ${pathname}`,
        response.status,
        null,
      );
    }
    return { success: true, ...(creditAccounted === false ? { creditAccounting: "pending" as const } : {}) };
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
    await waitForRequestSlot("commands");

    await authorizeOperation(operation, "POST", pathname);
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

    const creditAccounted = await reportCreditSpend({
      operation,
      httpStatus: response.status,
      headers: response.headers,
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
      return { success: true, ...(creditAccounted === false ? { creditAccounting: "pending" as const } : {}) };
    }

    const record = asRecord(unwrapData(responseBody));
    if (record?.success !== true) {
      throw new OfapiApiError(
        `OFAPI command success omitted success=true: POST ${pathname}`,
        response.status,
        null,
      );
    }
    return { success: true, ...(creditAccounted === false ? { creditAccounting: "pending" as const } : {}) };
  }

  async function requestCaptured(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
    priorityClass: EgressPriorityClass = "interactive",
    context?: OfapiRequestContext,
  ): Promise<{ body: unknown; capture: OfapiAdminCapture | null; creditAccounting?: "pending" }> {
    if (method !== "GET") await assertCredentialReady();
    const freeRead = method === "GET" && ["ofapi_balance_ping", "ofapi_credential_preflight", "ofapi_webhook_inventory", "ofapi_webhook_event_catalog", "ofapi_admin_accounts", "ofapi_vendor_usage", "ofapi_webhook_deliveries", "ofapi_export_inventory"].includes(operation);
    await waitForRequestSlot(priorityClass, !freeRead);
    await authorizeOperation(operation, method, path);
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
    // Fix the transport boundary before capture can wait for a DB connection/nextval.
    const receivedAt = new Date();
    const capture = (await input.onAdminResponse?.({ operation, status: response.status, body: text, receivedAt, pageId: context?.pageId ?? null, headers: Object.fromEntries(["x-ofapi-credits-used", "x-ofapi-credits-balance", "x-ofapi-is-cached", "idempotent-replayed"].flatMap(name => { const value = response.headers.get(name); return value === null ? [] : [[name, value]]; })) })) ?? null;
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
    const creditAccounted = await reportCreditSpend({
      operation,
      httpStatus: response.status,
      headers: response.headers,
      body: responseBody,
      requestId: `${operation}:${randomUUID()}`,
      pageId: context?.pageId ?? null,
      attemptNumber: 1,
      ...(["ofapi_balance_ping", "ofapi_credential_preflight", "ofapi_webhook_inventory", "ofapi_webhook_event_catalog", "ofapi_admin_accounts", "ofapi_vendor_usage", "ofapi_webhook_deliveries", "ofapi_webhook_redelivery", "ofapi_export_inventory"].includes(operation)
        ? { fallbackCredits: 0, fallbackEstimated: false } : {}),
    });

    if (creditAccounted === false && method === "GET" && !freeRead) {
      throw new OfapiApiError("OFAPI admin read credit accounting unavailable", null, null);
    }

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

    return { body: responseBody, capture, ...(creditAccounted === false ? { creditAccounting: "pending" as const } : {}) };
  }

  async function request(operation: string, method: string, path: string, body?: unknown): Promise<unknown> {
    return (await requestCaptured(operation, method, path, body)).body;
  }

  return {
    async executeExtendedCommand(context, accountId, conversationId, kind, payload, providerKey) {
      await assertCredentialReady();
      if (kind === "send_message_v2") return sendMessageRequest(context, accountId, conversationId, "ofapi_command_send_v2", buildOfapiSendV2Body(payload), providerKey);
      const action = ofapiExtendedAction(kind, accountId, conversationId, payload);
      const result = await requestCaptured(`ofapi_command_${kind}`, action.method, action.path, action.body, "commands", context);
      const record = asRecord(unwrapData(result.body));
      const success = kind === "set_fan_custom_name_v1" ? String(record?.id ?? "") === conversationId && typeof record?.displayName === "string"
        : result.body === null || record?.success === true;
      if (!success) throw new OfapiApiError("OFAPI action response did not confirm the requested result", 200, null);
      return { ...(result.creditAccounting ? { creditAccounting: result.creditAccounting } : {}) };
    },
    async getBannedWordsPage(page) {
      const result = await requestCaptured("ofapi_banned_words", "GET", `/banned-words?per_page=100&page=${page}`);
      return { body: result.body, evidence: result.capture };
    },
    async getCreditUsage(window) {
      const query = new URLSearchParams({ from: window.from, to: window.to, group_by: window.groupBy, include_today: String(window.includeToday) });
      if (window.accountId) query.set("account_id", window.accountId);
      const result = await requestCaptured("ofapi_vendor_usage", "GET", `/usage/credits?${query}`);
      return { body: result.body, evidence: result.capture };
    },
    getCredentialPreflight,
    assertCredentialReady,
    assertCreditAccountingReady,
    async getWebhook(id) {
      const body = await request("ofapi_webhook_inventory", "GET", `/webhooks/${encodeURIComponent(id)}`);
      const record = asRecord(unwrapData(body));
      if (!record || record.id !== id) throw new OfapiApiError("OFAPI webhook identity unavailable", 200, null);
      return record;
    },
    async listDataExports(options) {
      const query = new URLSearchParams({ page: String(options.page), per_page: String(options.perPage), type: options.type, download_url_expires_in: "1" });
      return requestCaptured("ofapi_export_inventory", "GET", `/data-exports?${query}`);
    },
    async listWebhookEvents() {
      return requestCaptured("ofapi_webhook_event_catalog", "GET", "/webhooks/events");
    },
    async listWebhooks() {
      const body = unwrapData(await request("ofapi_webhook_inventory", "GET", "/webhooks"));
      if (!Array.isArray(body)) throw new OfapiApiError("OFAPI webhook inventory unavailable", 200, null);
      return body.flatMap(value => asRecord(value) ? [asRecord(value)!] : []);
    },
    async listWebhookDeliveries(id, params) {
      const query = new URLSearchParams({ date_start: params.from, date_end: params.to,
        limit: String(params.limit), offset: String(params.offset) });
      return requestCaptured("ofapi_webhook_deliveries", "GET", `/webhooks/${encodeURIComponent(id)}/deliveries?${query}`, undefined, "bulk");
    },
    async redeliverWebhookDelivery(id, attemptId) {
      return requestCaptured("ofapi_webhook_redelivery", "POST", `/webhooks/${encodeURIComponent(id)}/deliveries/${attemptId}/redeliver`);
    },
    async createWebhook(registration) {
      const result = await requestCaptured(
        "ofapi_webhook_crud",
        "POST",
        "/webhooks",
        webhookRequestBody(registration),
      );
      return { ...toWebhookRecord(result.body), ...(result.creditAccounting ? { creditAccounting: result.creditAccounting } : {}) };
    },
    async updateWebhook(id, registration) {
      const result = await requestCaptured(
        "ofapi_webhook_crud",
        "PUT",
        `/webhooks/${encodeURIComponent(id)}`,
        webhookRequestBody(registration),
      );
      return { ...toWebhookRecord(result.body), ...(result.creditAccounting ? { creditAccounting: result.creditAccounting } : {}) };
    },
    async listAccountsSnapshot() {
      const { body, capture } = await requestCaptured("ofapi_admin_accounts", "GET", "/accounts");
      return { accounts: toAccountRecords(body), evidence: capture };
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
        // Chat history reads are scraped server-side and scale with chat size;
        // the default 15 s abort starved the largest chats forever.
        timeoutMs: OFAPI_SLOW_READ_TIMEOUT_MS,
        ...(params.retries !== undefined ? { retries: params.retries } : {}),
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
      // OFAPI treats end_date as part of a bounded range, not as a standalone
      // upper bound. Keep the transport fail-safe even if a future caller
      // accidentally supplies endDate without startDate.
      const endDate = params.startDate === undefined ? undefined : params.endDate;
      return observedListRequest({
        context,
        operation: "ofapi_chargebacks",
        endpointTemplate: "/:accountId/chargebacks",
        pathname: `/${encodeURIComponent(accountId)}/chargebacks`,
        query: {
          limit: String(limit),
          offset: params.offset != null ? String(params.offset) : undefined,
          start_date: params.startDate,
          end_date: endDate,
        },
        pageIndex: params.offset != null ? Math.floor(params.offset / limit) : 0,
        cursorPresent: false,
        requestMetadata: {
          limit,
          offset: params.offset ?? 0,
          hasStartDate: params.startDate != null,
          hasEndDate: endDate != null,
        },
      });
    },
    async listTrackingLinks(context, accountId, params) {
      const limit = Math.min(params.limit ?? 100, 100);
      return observedListRequest({
        context,
        operation: "ofapi_tracking_links",
        endpointTemplate: "/:accountId/tracking-links",
        pathname: `/${encodeURIComponent(accountId)}/tracking-links`,
        query: {
          limit: String(limit),
          offset: params.offset != null ? String(params.offset) : undefined,
        },
        pageIndex: params.offset != null ? Math.floor(params.offset / limit) : 0,
        cursorPresent: false,
        requestMetadata: { limit, offset: params.offset ?? 0 },
      });
    },
    async listTrackingLinkUsers(context, accountId, trackingLinkId, kind, params) {
      const limit = Math.min(params.limit ?? 100, 100);
      return observedListRequest({
        context,
        operation: `ofapi_tracking_link_${kind}`,
        endpointTemplate: `/:accountId/tracking-links/:trackingLinkId/${kind}`,
        pathname: `/${encodeURIComponent(accountId)}/tracking-links/${
          encodeURIComponent(trackingLinkId)
        }/${kind}`,
        query: {
          limit: String(limit),
          offset: params.offset != null ? String(params.offset) : undefined,
        },
        pageIndex: params.offset != null ? Math.floor(params.offset / limit) : 0,
        cursorPresent: false,
        requestMetadata: { limit, offset: params.offset ?? 0, trackingLinkId, kind },
        ...(kind === "spenders" ? { mapResponse: (body: unknown) => toListPage(body, limit) } : {}),
      });
    },
    async listTrialLinks(context, accountId, params) {
      const limit = Math.min(params.limit ?? 100, 100);
      return observedListRequest({
        context,
        operation: "ofapi_trial_links",
        endpointTemplate: "/:accountId/trial-links",
        pathname: `/${encodeURIComponent(accountId)}/trial-links`,
        query: {
          limit: String(limit),
          offset: params.offset != null ? String(params.offset) : undefined,
        },
        pageIndex: params.offset != null ? Math.floor(params.offset / limit) : 0,
        cursorPresent: false,
        requestMetadata: { limit, offset: params.offset ?? 0 },
      });
    },
    async listTrialLinkSubscribers(context, accountId, trialLinkId, params) {
      const limit = Math.min(params.limit ?? 100, 100);
      return observedListRequest({
        context,
        operation: "ofapi_trial_link_subscribers",
        endpointTemplate: "/:accountId/trial-links/:trialLinkId/subscribers",
        pathname: `/${encodeURIComponent(accountId)}/trial-links/${
          encodeURIComponent(trialLinkId)
        }/subscribers`,
        query: {
          limit: String(limit),
          offset: params.offset != null ? String(params.offset) : undefined,
        },
        pageIndex: params.offset != null ? Math.floor(params.offset / limit) : 0,
        cursorPresent: false,
        requestMetadata: { limit, offset: params.offset ?? 0, trialLinkId },
      });
    },
    async listStoredTrackingLinks(context, accountId, params) {
      const limit = Math.min(params.limit ?? 1000, 1000);
      return observedListRequest({
        context,
        operation: "ofapi_stored_tracking_links",
        endpointTemplate: "/:accountId/stored/tracking-links",
        pathname: `/${encodeURIComponent(accountId)}/stored/tracking-links`,
        query: {
          limit: String(limit),
          offset: params.offset != null ? String(params.offset) : undefined,
        },
        pageIndex: params.offset != null ? Math.floor(params.offset / limit) : 0,
        cursorPresent: false,
        requestMetadata: { limit, offset: params.offset ?? 0 },
      });
    },
    async listStoredTrialLinks(context, accountId, params) {
      const limit = Math.min(params.limit ?? 1000, 1000);
      return observedListRequest({
        context,
        operation: "ofapi_stored_trial_links",
        endpointTemplate: "/:accountId/stored/trial-links",
        pathname: `/${encodeURIComponent(accountId)}/stored/trial-links`,
        query: {
          limit: String(limit),
          offset: params.offset != null ? String(params.offset) : undefined,
        },
        pageIndex: params.offset != null ? Math.floor(params.offset / limit) : 0,
        cursorPresent: false,
        requestMetadata: { limit, offset: params.offset ?? 0 },
      });
    },
    async pingBalance() {
      const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const body = await request("ofapi_balance_ping", "GET", `/usage/credits?from=${day}&to=${day}`);
      return { items: [], hasNextPage: false, meta: parseResponseMeta(body), creditSpendAccounted: true };
    },
    async proxyRead(context, options) {
      return proxyReadRequest(context, options);
    },
    async dispatchGovernedRaw(context, options) {
      if (options.method !== "GET") {
        try { await assertCredentialReady(); }
        catch (error) { throw new OfapiGovernedRequestError("OFAPI credential preflight unavailable", "pre_dispatch", "cancelled", { cause: error }); }
      }
      return dispatchGovernedRawRequest(context, options);
    },
    async recordGovernedAccountResponse(accountId, generation, status, body) {
      await input.onAccountResponse?.(accountId, generation, status, body);
    },
    async sendTextMessage(context, accountId, conversationId, command) {
      await assertCredentialReady();
      return sendTextMessageRequest(context, accountId, conversationId, command);
    },
    async sendMediaMessage(context, accountId, conversationId, command) {
      await assertCredentialReady();
      return sendMediaMessageRequest(context, accountId, conversationId, command);
    },
    async startTyping(context, accountId, conversationId) {
      await assertCredentialReady();
      return startTypingRequest(context, accountId, conversationId);
    },
    async unsendMessage(context, accountId, conversationId, messageId) {
      await assertCredentialReady();
      return unsendMessageRequest(context, accountId, conversationId, messageId);
    },
    async markChatRead(context, accountId, conversationId) {
      await assertCredentialReady();
      return markChatReadRequest(context, accountId, conversationId);
    },
  };
}
