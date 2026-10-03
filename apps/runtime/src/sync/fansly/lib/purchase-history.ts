import { classifyFanslyResponse } from "./lane.ts";

// The purchase-history rules of the Sync Engine's `purchases.targets`
// resource (resources/purchases.ts) and the purchase announcements report:
// the media targets money facts and DM pages name, the legacy cursor the
// switch imports, and the classification of one captured order-history page.
// Pure; a classification reads only the durable status and body, so a parser
// repair can reclassify history without a request. The legacy lane
// (fansly-purchase-history.ts, executor-handlers.ts) imports them from here
// until step 4 deletes it.

type JsonRecord = Record<string, unknown>;

export type FanslyPurchaseHistoryTarget = {
  kind: "single" | "bundle";
  contentId: string;
};

export type FanslyPurchaseHistoryPendingTarget = FanslyPurchaseHistoryTarget & {
  /** Opaque order id passed back to Fansly as `before`. Null is page one. */
  before: string | null;
  /**
   * A rejected target re-queued ONCE after a rejection storm turned out to be
   * a repaired contract (Decision 358). Checkpoint reconciliation keeps a retry
   * even though its chain reads complete; a second rejection settles it.
   */
  retry?: true;
};

export type FanslyPurchaseHistoryCursorStateV2 = {
  version: 2;
  rawPayloadCursorId: number;
  pendingTargets: FanslyPurchaseHistoryTarget[];
};

export type FanslyPurchaseHistoryCursorStateV3 = {
  version: 3;
  transactionCursorId: number;
  rawPayloadCursorId: number;
  pendingTargets: FanslyPurchaseHistoryTarget[];
};

export type FanslyPurchaseHistoryCursorStateV4 = {
  version: 4;
  transactionCursorId: number;
  rawPayloadCursorId: number;
  pendingTargets: FanslyPurchaseHistoryPendingTarget[];
};

export type FanslyPurchaseHistoryCursorStateV5 = {
  version: 5;
  transactionCursorId: number;
  rawPayloadCursorId: number;
  pendingTargets: FanslyPurchaseHistoryPendingTarget[];
  utcDay: string;
  callsToday: number;
};

/**
 * Older cursor shapes remain readable so a deploy can resume in-flight work.
 * Parsed state is always normalized to v5: v4's per-target provider cursor,
 * plus the durable UTC-day attempt allowance shared by the other lanes. The
 * rejection streak (Decision 358) is deliberately NOT cursor state: it is
 * derived from the captures themselves, so a crash between a journaled
 * rejection and the checkpoint write cannot lose it.
 */
export type FanslyPurchaseHistoryCursorState =
  | FanslyPurchaseHistoryCursorStateV2
  | FanslyPurchaseHistoryCursorStateV3
  | FanslyPurchaseHistoryCursorStateV4
  | FanslyPurchaseHistoryCursorStateV5;

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

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
      const record = asRecord(item);
      return record ? [record] : [];
    })
    : [];
}

function hasPpvPermission(item: JsonRecord) {
  const permissions = asRecord(item.permissions);
  return records(permissions?.permissionFlags).some((permission) => {
    const flags = asNumber(permission.flags) ?? 0;
    return (flags & 1) === 1;
  });
}

export function fanslyPurchaseHistoryTargetKey(target: FanslyPurchaseHistoryTarget) {
  return `${target.kind}:${target.contentId}`;
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

/**
 * Finds PPV content ids from a captured Fansly /message page. The endpoint
 * contract is media-scoped: accountMediaId/accountMediaBundleId is required;
 * accountIds is only an optional buyer filter. We therefore walk observed PPV
 * media, never the cartesian product of every fan and every media item.
 */
export function extractFanslyPurchaseHistoryTargets(
  payloads: readonly unknown[],
): FanslyPurchaseHistoryTarget[] {
  // Fansly content ids are global, but historical DM payloads can describe a
  // bundle order through `accountMediaId` while the attachment and metadata
  // correctly identify the same id as a bundle. Keep one target per content
  // id and let concrete attachment/metadata evidence override the weaker
  // inline-order inference. Otherwise the same bundle is fetched once
  // correctly and then again as a single media item, which Fansly rejects.
  const targets = new Map<
    string,
    { target: FanslyPurchaseHistoryTarget; evidencePriority: number }
  >();
  const recordTarget = (
    target: FanslyPurchaseHistoryTarget,
    evidencePriority: number,
  ) => {
    const current = targets.get(target.contentId);
    if (!current || evidencePriority > current.evidencePriority) {
      targets.set(target.contentId, { target, evidencePriority });
    }
  };

  for (const payloadValue of payloads) {
    const payload = asRecord(payloadValue);
    if (!payload) {
      continue;
    }

    const mediaById = new Map(
      records(payload.accountMedia)
        .flatMap((item) => {
          const id = asString(item.id);
          return id ? [[id, item] as const] : [];
        }),
    );
    const bundlesById = new Map(
      records(payload.accountMediaBundles)
        .flatMap((item) => {
          const id = asString(item.id);
          return id ? [[id, item] as const] : [];
        }),
    );

    // An inline order is itself definitive evidence that the media target is
    // valid, even when the corresponding attachment/metadata was trimmed from
    // this particular DM page. Fetching that media recovers its other buyers.
    for (const order of records(payload.accountMediaOrders)) {
      const bundleId = asString(order.accountMediaBundleId);
      const mediaId = asString(order.accountMediaId);
      const target = bundleId
        ? { kind: "bundle" as const, contentId: bundleId }
        : mediaId
          ? {
            kind: bundlesById.has(mediaId) && !mediaById.has(mediaId)
              ? "bundle" as const
              : "single" as const,
            contentId: mediaId,
          }
          : null;
      if (target) {
        recordTarget(target, bundleId ? 3 : 1);
      }
    }

    for (const message of records(payload.messages)) {
      for (const attachment of records(message.attachments)) {
        const contentId = asString(attachment.contentId);
        if (!contentId) {
          continue;
        }

        const contentType = asNumber(attachment.contentType);
        const candidate = (() => {
          if (contentType === 1) {
            return mediaById.has(contentId)
              ? { kind: "single" as const, item: mediaById.get(contentId)! }
              : null;
          }
          if (contentType === 2) {
            return bundlesById.has(contentId)
              ? { kind: "bundle" as const, item: bundlesById.get(contentId)! }
              : null;
          }

          // Older payloads occasionally omit contentType. Resolve only when
          // the id exists in exactly one captured metadata map.
          const media = mediaById.get(contentId);
          const bundle = bundlesById.get(contentId);
          if (media && !bundle) {
            return { kind: "single" as const, item: media };
          }
          if (bundle && !media) {
            return { kind: "bundle" as const, item: bundle };
          }
          return null;
        })();

        if (!candidate || !hasPpvPermission(candidate.item)) {
          continue;
        }

        const target = { kind: candidate.kind, contentId };
        recordTarget(target, 2);
      }
    }
  }

  return [...targets.values()].map(({ target }) => target).sort((left, right) =>
    fanslyPurchaseHistoryTargetKey(left).localeCompare(
      fanslyPurchaseHistoryTargetKey(right),
      "en",
      { numeric: true },
    ));
}

export function parseFanslyPurchaseHistoryCursorState(
  value: unknown,
  now = new Date(),
): FanslyPurchaseHistoryCursorStateV5 | null {
  const state = asRecord(value);
  const version = asNumber(state?.version);
  if (version !== 2 && version !== 3 && version !== 4 && version !== 5) {
    return null;
  }
  const rawPayloadCursorId = asNumber(state?.rawPayloadCursorId);
  if (
    rawPayloadCursorId === null ||
    !Number.isSafeInteger(rawPayloadCursorId) ||
    rawPayloadCursorId < 0
  ) {
    return null;
  }
  const transactionCursorId = version === 2
    ? 0
    : asNumber(state?.transactionCursorId);
  if (
    transactionCursorId === null ||
    !Number.isSafeInteger(transactionCursorId) ||
    transactionCursorId < 0
  ) {
    return null;
  }

  const rawPendingTargets = state?.pendingTargets;
  if (!Array.isArray(rawPendingTargets)) {
    return null;
  }
  const pendingTargets = rawPendingTargets.flatMap<FanslyPurchaseHistoryPendingTarget>((item) => {
      const target = asRecord(item);
      const kind = target?.kind;
      const contentId = asString(target?.contentId);
      const rawBefore = version === 4 || version === 5 ? target?.before : null;
      const before = rawBefore === null ? null : asString(rawBefore);
      return (kind === "single" || kind === "bundle") && contentId &&
          (rawBefore === null || before !== null)
        ? [{ kind, contentId, before, ...(target?.retry === true ? { retry: true as const } : {}) }]
        : [];
    });
  if (pendingTargets.length !== rawPendingTargets.length) {
    return null;
  }
  if (
    new Set(pendingTargets.map(fanslyPurchaseHistoryTargetKey)).size !==
      pendingTargets.length
  ) {
    return null;
  }

  return {
    version: 5,
    transactionCursorId,
    rawPayloadCursorId,
    pendingTargets,
    utcDay: typeof state?.utcDay === "string"
      ? state.utcDay
      : now.toISOString().slice(0, 10),
    callsToday: Math.max(0, asNumber(state?.callsToday) ?? 0),
  };
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

/** The order rows of a purchase-history body (objects only); null when the
 *  body holds no order array (a refusal, a malformed page). */
export function fanslyPurchaseHistoryOrderRows(payloadValue: unknown): JsonRecord[] | null {
  const rows = fanslyPurchaseHistoryRows(payloadValue);
  return rows === null ? null : records(rows);
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
