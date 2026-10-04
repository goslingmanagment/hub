import { classifyFanslyResponse } from "./lane.ts";

// The purchase-history rules of the Sync Engine's `purchases.targets`
// resource (resources/purchases.ts): the media target a money fact names and
// the classification of one captured order-history page. Pure; a
// classification reads only the durable status and body, so a parser repair
// can reclassify history without a request.

type JsonRecord = Record<string, unknown>;

export type FanslyPurchaseHistoryTarget = {
  kind: "single" | "bundle";
  contentId: string;
};

export type FanslyMessagePurchaseTargetSource = {
  rawType: string | number;
  correlationId: string | null;
};

export type FanslyPurchaseHistoryCapture = {
  id: number | null;
  targetKey: string;
  /** The cursor used for this captured page. Null identifies page one. */
  requestBefore: string | null;
  statusCode: number | null;
  responsePayload: unknown;
};

export type FanslyPurchaseHistoryCaptureClassification =
  & FanslyPurchaseHistoryCapture
  & {
    contentId: string;
    captured: true;
    validatedPage: boolean;
    terminal: boolean;
    blocked: boolean;
    orderRows: number | null;
    nextBefore: string | null;
    outcome:
      | "continuation"
      | "terminal_empty"
      | "terminal_missing"
      | "terminal_rejected"
      | "contract_rejected"
      | "cursor_missing"
      | "cursor_repeated"
      | "cursor_conflict"
      | "http_rejected";
  };

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function purchaseHistoryTargetKindFromRawType(
  rawType: string | number,
): FanslyPurchaseHistoryTarget["kind"] | null {
  switch (String(rawType)) {
    case "2010":
    case "2110":
      return "single";
    case "2016":
    case "2116":
      return "bundle";
    default:
      return null;
  }
}

/**
 * The media target one Fansly money fact names: raw types 2010/2110 sell a
 * single media, 2016/2116 a bundle, and `correlationId` is the content id.
 * Null for any other fact or a missing id. Whether one content id seen as both
 * kinds across facts is drift is the caller's to decide.
 */
export function fanslyPurchaseHistoryTargetOfTransaction(
  row: FanslyMessagePurchaseTargetSource,
): FanslyPurchaseHistoryTarget | null {
  const kind = purchaseHistoryTargetKindFromRawType(row.rawType);
  const contentId = typeof row.correlationId === "string"
    ? row.correlationId.trim()
    : "";
  return kind && contentId ? { kind, contentId } : null;
}

function purchaseHistoryContentIdFromTargetKey(targetKey: string) {
  const separator = targetKey.indexOf(":");
  return separator >= 0 ? targetKey.slice(separator + 1) : targetKey;
}

function fanslyPurchaseHistoryRows(payloadValue: unknown): unknown[] | null {
  const payload = asRecord(payloadValue);
  if (!payload) {
    return null;
  }
  if (Array.isArray(payload.accountMediaOrderHistory)) {
    return payload.accountMediaOrderHistory;
  }
  if (Array.isArray(payload.accountMediaOrders)) {
    return payload.accountMediaOrders;
  }
  const aggregation = asRecord(payload.aggregationData);
  if (Array.isArray(aggregation?.accountMediaOrders)) {
    return aggregation.accountMediaOrders;
  }
  return null;
}

export function classifyFanslyPurchaseHistoryResponse(payloadValue: unknown) {
  return classifyFanslyResponse(payloadValue, {
    isValid: (value) => {
      const rows = fanslyPurchaseHistoryRows(value);
      return rows !== null && rows.every((row) => asRecord(row) !== null);
    },
    isEmpty: (value) => fanslyPurchaseHistoryRows(value)?.length === 0,
  });
}

/**
 * Classifies a captured target entirely from its durable status and raw body.
 * The function deliberately has no checkpoint or provider dependency so a
 * parser repair can reclassify historical captures without another request.
 */
export function classifyFanslyPurchaseHistoryCapture(
  capture: FanslyPurchaseHistoryCapture,
): FanslyPurchaseHistoryCaptureClassification {
  const contentId = purchaseHistoryContentIdFromTargetKey(capture.targetKey);
  if (capture.statusCode === 404 || capture.statusCode === 410) {
    return {
      ...capture,
      contentId,
      captured: true,
      validatedPage: true,
      terminal: true,
      blocked: false,
      orderRows: 0,
      nextBefore: null,
      outcome: "terminal_missing",
    };
  }
  // 422 is Fansly's "I understood the request but cannot serve THIS entity":
  // `{"error":{"code":99,"details":"error getting account media"}}` for a
  // media the account no longer holds (production, ari-1, 2026-09-02: one such
  // media parked the whole stream for two weeks). Code 99 is Fansly's generic
  // code and carries no signal on its own — the same 99 under HTTP 400 is the
  // bare-probe / parameter-drift shape ("missing accountMediaId"), which is a
  // fact about the request contract and stays a stream-level blocker below.
  // The status carries the distinction; the body is kept verbatim so a later
  // reading can refine it without another request.
  if (capture.statusCode === 422) {
    return {
      ...capture,
      contentId,
      captured: true,
      validatedPage: true,
      terminal: true,
      blocked: false,
      orderRows: 0,
      nextBefore: null,
      outcome: "terminal_rejected",
    };
  }

  if (
    capture.statusCode !== null &&
    (capture.statusCode < 200 || capture.statusCode >= 300)
  ) {
    return {
      ...capture,
      contentId,
      captured: true,
      validatedPage: false,
      terminal: false,
      blocked: true,
      orderRows: null,
      nextBefore: null,
      outcome: "http_rejected",
    };
  }

  const rawRows = fanslyPurchaseHistoryRows(capture.responsePayload);
  if (
    classifyFanslyPurchaseHistoryResponse(capture.responsePayload) === "invalid"
    || rawRows === null
  ) {
    return {
      ...capture,
      contentId,
      captured: true,
      validatedPage: false,
      terminal: false,
      blocked: true,
      orderRows: null,
      nextBefore: null,
      outcome: "contract_rejected",
    };
  }
  if (rawRows.length === 0) {
    return {
      ...capture,
      contentId,
      captured: true,
      validatedPage: true,
      terminal: true,
      blocked: false,
      orderRows: 0,
      nextBefore: null,
      outcome: "terminal_empty",
    };
  }

  // FBuddy's executable client walks to an EMPTY page, even after a short
  // page. The opaque cursor is the last row's orderId; row count is not proof
  // of exhaustion.
  const lastRow = asRecord(rawRows.at(-1))!;
  const nextBefore = asString(lastRow.orderId);
  if (!nextBefore) {
    return {
      ...capture,
      contentId,
      captured: true,
      validatedPage: false,
      terminal: false,
      blocked: true,
      orderRows: rawRows.length,
      nextBefore: null,
      outcome: "cursor_missing",
    };
  }
  if (nextBefore === capture.requestBefore) {
    return {
      ...capture,
      contentId,
      captured: true,
      validatedPage: false,
      terminal: false,
      blocked: true,
      orderRows: rawRows.length,
      nextBefore,
      outcome: "cursor_repeated",
    };
  }

  return {
    ...capture,
    contentId,
    captured: true,
    validatedPage: true,
    terminal: false,
    blocked: false,
    orderRows: rawRows.length,
    nextBefore,
    outcome: "continuation",
  };
}
