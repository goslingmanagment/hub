import { isFanslyGroupDetailIdentity } from "../response-contracts.ts";
import type {
  FanslyAccount,
  FanslyEarningsTransaction,
  FanslyFollowersPage,
  FanslyGroupDetail,
  FanslyMessagesPage,
  FanslyMessagingGroupsPage,
  FanslySubscribersPage,
  FanslyTransactionsPage,
} from "../types.ts";
import type {
  FanslyAccountMe,
  FanslyContractResult,
  FanslyContractViolation,
  FanslyEmptyResponse,
  FanslySubscribersPageContract,
  FanslyWireSpec,
} from "./types.ts";

// The response contracts of the Fansly API: the envelope every route answers
// in, and the container/identity contracts of the routes whose bodies a writer
// applies directly. The legacy parsers moved here unchanged from the adapter
// (which imports them back); the engine reads the same answer the same way.

/** Fansly's response envelope: `{success, response}` or `{success:false, error}`. */
export type FanslyEnvelope<T = unknown> = {
  success?: boolean;
  response?: T;
  error?: {
    code?: number;
    message?: string;
    details?: string;
    [key: string]: unknown;
  } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApiError(value: unknown): value is NonNullable<FanslyEnvelope["error"]> {
  return isRecord(value) &&
    (value.code === undefined ||
      (typeof value.code === "number" && Number.isFinite(value.code))) &&
    (value.message === undefined || typeof value.message === "string") &&
    (value.details === undefined || typeof value.details === "string");
}

function isApiEnvelope(value: unknown): value is FanslyEnvelope {
  return isRecord(value) &&
    (value.success === undefined || typeof value.success === "boolean") &&
    (value.error === undefined || value.error === null || isApiError(value.error));
}

/** The envelope of a response body, or null when the body is not JSON or not
 *  shaped like one (a proxy page, an empty body, a truncated answer). */
export function parseFanslyEnvelope<T = unknown>(text: string): FanslyEnvelope<T> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isApiEnvelope(parsed) ? parsed as FanslyEnvelope<T> : null;
  } catch {
    return null;
  }
}

/**
 * Fansly's own APPLICATION error, well-formed: `success: false` with a numeric
 * `error.code` and a non-empty `error.details`, e.g.
 * `{"success":false,"error":{"code":500,"details":"error getting graph"}}`.
 * A proxy or gateway page, an empty body or a bare `{success:false}` is not one.
 */
export function isFanslyErrorEnvelope(envelope: FanslyEnvelope<unknown> | null): boolean {
  return envelope !== null &&
    envelope.success === false &&
    typeof envelope.error?.code === "number" &&
    typeof envelope.error.details === "string" &&
    envelope.error.details.trim().length > 0;
}

// A createdAt before 2019 (before Fansly) or more than two days past the clock
// is a unit change (seconds for milliseconds), not a sale time.
const FANSLY_TRANSACTION_MIN_CREATED_AT_MS = Date.UTC(2019, 0, 1);
const FANSLY_TRANSACTION_MAX_CREATED_AT_LEAD_MS = 2 * 24 * 60 * 60 * 1000;

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** Mills on the wire: an integer, or an integer string. A fraction is refused
 * here rather than truncated later by `millsFromInteger`. */
function parseFanslyMillsInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
  return isSafeInteger(parsed) ? parsed : null;
}

/** The fields the ledger writes or computes from. Returns the item with its
 * amounts as numbers, or the first field that fails. */
export function parseFanslyEarningsTransaction(
  value: unknown,
  nowMs: number,
): { item: FanslyEarningsTransaction } | { field: string } {
  if (!isRecord(value)) {
    return { field: "item" };
  }
  if (typeof value.transactionId !== "string" || value.transactionId.length === 0) {
    return { field: "transactionId" };
  }
  if (!isSafeInteger(value.type)) {
    return { field: "type" };
  }
  if (!isSafeInteger(value.status)) {
    return { field: "status" };
  }
  const amount = parseFanslyMillsInteger(value.amount);
  if (amount === null) {
    return { field: "amount" };
  }
  const destinationAmount = parseFanslyMillsInteger(value.destinationAmount);
  if (destinationAmount === null) {
    return { field: "destinationAmount" };
  }
  if (value.destinationTax !== null && !isSafeInteger(value.destinationTax)) {
    return { field: "destinationTax" };
  }
  if (
    !isSafeInteger(value.createdAt) ||
    value.createdAt < FANSLY_TRANSACTION_MIN_CREATED_AT_MS ||
    value.createdAt > nowMs + FANSLY_TRANSACTION_MAX_CREATED_AT_LEAD_MS
  ) {
    return { field: "createdAt" };
  }

  return {
    item: { ...value, amount, destinationAmount } as unknown as FanslyEarningsTransaction,
  };
}

/**
 * A malformed total or data array rejects the page (null). A malformed item
 * keeps the total and names the first bad item: the caller fails the page
 * without treating the offset scan as unstable.
 */
export function parseFanslyTransactionsPage(value: unknown): FanslyTransactionsPage | null {
  if (
    !isRecord(value) ||
    typeof value.total !== "number" ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0 ||
    !Array.isArray(value.data)
  ) {
    return null;
  }

  const nowMs = Date.now();
  const data: FanslyEarningsTransaction[] = [];
  for (const [index, entry] of value.data.entries()) {
    const parsed = parseFanslyEarningsTransaction(entry, nowMs);
    if ("field" in parsed) {
      const transactionId = isRecord(entry) &&
          typeof entry.transactionId === "string" &&
          entry.transactionId.length > 0
        ? entry.transactionId
        : null;
      return {
        total: value.total,
        data: [],
        itemViolation: { index, transactionId, field: parsed.field },
      };
    }
    data.push(parsed.item);
  }

  return {
    total: value.total,
    data,
    itemViolation: null,
  };
}

function isNonNegativeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The subscriptions and the total that matches the request's status filter
 *  (`3,4` active, `5` expired, anything else the overall total). */
export function parseFanslySubscribersPage(
  value: unknown,
  status: string,
): FanslySubscribersPageContract | null {
  if (!isRecord(value) || !isRecord(value.stats) || !Array.isArray(value.subscriptions) ||
    !value.subscriptions.every((item) => isRecord(item) &&
      typeof item.id === "string" && item.id.length > 0 &&
      typeof item.subscriberId === "string" && item.subscriberId.length > 0 &&
      typeof item.status === "number" && Number.isFinite(item.status))) {
    return null;
  }
  const total = status === "5" ? value.stats.totalExpired
    : status === "3,4" ? value.stats.totalActive : value.stats.total;
  if (!isNonNegativeCount(total)) return null;
  return {
    total,
    totalActive: isNonNegativeCount(value.stats.totalActive) ? value.stats.totalActive : null,
    totalExpired: isNonNegativeCount(value.stats.totalExpired) ? value.stats.totalExpired : null,
    subscriptions: value.subscriptions as FanslySubscribersPage["subscriptions"],
  };
}

export function parseFanslyFollowersPage(value: unknown): FanslyFollowersPage | null {
  if (!isRecord(value) || !Array.isArray(value.followers) ||
    !value.followers.every((item) => isRecord(item) &&
      typeof item.id === "string" && item.id.length > 0 &&
      typeof item.followerId === "string" && item.followerId.length > 0)) {
    return null;
  }
  if (value.aggregationData !== undefined && value.aggregationData !== null &&
    (!isRecord(value.aggregationData) ||
      (value.aggregationData.accounts !== undefined && value.aggregationData.accounts !== null &&
        (!Array.isArray(value.aggregationData.accounts) ||
          !value.aggregationData.accounts.every((item) => isRecord(item) &&
            typeof item.id === "string" && item.id.length > 0))))) {
    return null;
  }
  return value as unknown as FanslyFollowersPage;
}

function hasNullableIdentityRecords(value: unknown) {
  return value === undefined || value === null ||
    (Array.isArray(value) && value.every((item) => isRecord(item) &&
      typeof item.id === "string" && item.id.length > 0));
}

/** The container and identity contract of `/messaging/groups`, mirroring
 * parseFanslyFollowersPage: a row, group or account without its id cannot be
 * applied, and the capture trim would silently drop it. Scalar fields (flags,
 * counters, head ids, `total`) stay with the lane's own guards. */
export function parseFanslyMessagingGroupsPage(value: unknown): FanslyMessagingGroupsPage | null {
  if (!isRecord(value) || !Array.isArray(value.data) ||
    !value.data.every((item) => isRecord(item) &&
      typeof item.groupId === "string" && item.groupId.length > 0)) {
    return null;
  }
  if (value.aggregationData !== undefined && value.aggregationData !== null &&
    (!isRecord(value.aggregationData) ||
      !hasNullableIdentityRecords(value.aggregationData.groups) ||
      !hasNullableIdentityRecords(value.aggregationData.accounts))) {
    return null;
  }
  return value as unknown as FanslyMessagingGroupsPage;
}

/** Container contract only. Per-message drift (a missing id or createdAt) is
 * the lane's to account for after capture; rejecting the page for one bad
 * message would wedge the conversation sweep's limit-1 head repair. */
export function parseFanslyMessagesPage(value: unknown): FanslyMessagesPage | null {
  return isRecord(value) && Array.isArray(value.messages)
    ? value as unknown as FanslyMessagesPage
    : null;
}

function accept<R>(value: R): FanslyContractResult<R> {
  return { ok: true, value };
}

function reject<R>(field: string, detail: string): FanslyContractResult<R> {
  return { ok: false, violation: { field, detail } };
}

/** A counter of `/account/me`: absent, null, or a non-negative integer. */
function isOptionalCount(value: unknown) {
  return value === undefined || value === null || isNonNegativeCount(value);
}

/**
 * `/account/me`: the account the session belongs to. The id is what identity
 * checks compare and what every page write keys on, so it must be there; the
 * two counters feed `pages.follower_count`/`subscriber_count` (the subscribers
 * stated-empty rule reads the latter), so a present counter must be a count —
 * an absent one is cleared by the writer, never guessed.
 */
export function parseFanslyAccountMe(value: unknown): FanslyContractResult<FanslyAccountMe> {
  if (!isRecord(value) || !isRecord(value.account)) {
    return reject("account", "response carries no account object");
  }
  const account = value.account;
  if (typeof account.id !== "string" || account.id.length === 0) {
    return reject("account.id", "account id is not a non-empty string");
  }
  if (!isOptionalCount(account.followCount)) {
    return reject("account.followCount", "follower count is not a non-negative integer");
  }
  if (!isOptionalCount(account.subscriberCount)) {
    return reject("account.subscriberCount", "subscriber count is not a non-negative integer");
  }
  return accept(value as unknown as FanslyAccountMe);
}

/**
 * `/account?ids=`: an array of accounts, each with its id. A non-array answer
 * marks nothing as looked up; a row without an id cannot be matched to the fan
 * it answers for, so it rejects the batch rather than being skipped.
 */
export function parseFanslyAccountsByIds(value: unknown): FanslyContractResult<FanslyAccount[]> {
  if (!Array.isArray(value)) {
    return reject("response", "account lookup is not an array");
  }
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0) {
      return reject(`[${index}].id`, "account row without a non-empty id");
    }
  }
  return accept(value as FanslyAccount[]);
}

/** `/group/:groupId`: the group the request named, with a user id on every
 *  member (`isFanslyGroupDetailIdentity`, the check both legacy readers use). */
export function parseFanslyGroupDetail(
  value: unknown,
  expectedGroupId: string,
): FanslyContractResult<FanslyGroupDetail> {
  return isFanslyGroupDetailIdentity(value, expectedGroupId)
    ? accept(value as FanslyGroupDetail)
    : reject("response", `not a group detail of ${expectedGroupId} with an id on every user`);
}

/** How one answer reads against its spec: the shared prelude of every apply,
 *  replay and classification, in the order the adapter has always read it. */
export type FanslyWireRead<R> =
  /** A 2xx success envelope (or an opted-in empty answer) the contract accepts.
   *  `response` is what the journal keeps: the envelope's `response`, or the
   *  empty marker. */
  | { kind: "accepted"; status: number; response: unknown; value: R }
  /** A 2xx success envelope the contract refuses. Journaled, then quarantined. */
  | { kind: "contract_violation"; status: number; response: unknown; violation: FanslyContractViolation }
  /** A 2xx whose body is not a successful envelope (`success` not true, or no
   *  `response`, or not an envelope at all). */
  | { kind: "envelope_unsuccessful"; status: number; envelope: FanslyEnvelope | null }
  /** Any non-2xx answer, 3xx included: a redirect is an answer, never a hop. */
  | {
    kind: "http_error";
    status: number;
    envelope: FanslyEnvelope | null;
    retryAfter: string | null;
    /** The route's own final answer (`finalServerErrorEnvelope` routes only). */
    finalServerError: boolean;
  };

function isOkStatus(status: number) {
  return status >= 200 && status <= 299;
}

export function readFanslyWireResponse<P, R>(
  spec: FanslyWireSpec<P, R>,
  params: P,
  answer: { status: number; headers: Readonly<Record<string, string>>; bodyText: string },
): FanslyWireRead<R> {
  const { status, bodyText } = answer;
  const envelope = parseFanslyEnvelope(bodyText);
  const retryAfter = answer.headers["retry-after"] ?? null;
  const httpError = (): FanslyWireRead<R> => ({
    kind: "http_error",
    status,
    envelope,
    retryAfter,
    finalServerError: spec.finalServerErrorEnvelope === true &&
      status >= 500 &&
      retryAfter === null &&
      isFanslyErrorEnvelope(envelope),
  });
  const contract = (response: unknown): FanslyWireRead<R> => {
    const parsed = spec.parse(response, params);
    return parsed.ok
      ? { kind: "accepted", status, response, value: parsed.value }
      : { kind: "contract_violation", status, response, violation: parsed.violation };
  };

  // An authorization failure is never "nothing here".
  if (status === 401 || status === 403) {
    return httpError();
  }
  const emptyStatuses = spec.emptyStatuses ?? [];
  if (
    emptyStatuses.includes(status) ||
    (emptyStatuses.length > 0 && isOkStatus(status) && bodyText.trim().length === 0)
  ) {
    const empty: FanslyEmptyResponse = { __empty: true, httpStatus: status };
    return contract(empty);
  }
  if (!isOkStatus(status)) {
    return httpError();
  }
  if (!envelope?.success || envelope.response === undefined) {
    return { kind: "envelope_unsuccessful", status, envelope };
  }
  return contract(envelope.response);
}
