import { FanslyPurchaseHistoryContractError } from "./errors.ts";

type JsonRecord = Record<string, unknown>;

export type FanslyPurchaseHistoryTarget = {
  kind: "single" | "bundle";
  contentId: string;
};

export type FanslyPurchaseHistoryPendingTarget = FanslyPurchaseHistoryTarget & {
  /** Opaque order id passed back to Fansly as `before`. Null is page one. */
  before: string | null;
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

/**
 * Older cursor shapes remain readable so a deploy can resume in-flight work.
 * Parsed state is always normalized to v4, which adds a per-target provider
 * cursor and therefore never has to replay an already captured page.
 */
export type FanslyPurchaseHistoryCursorState =
  | FanslyPurchaseHistoryCursorStateV2
  | FanslyPurchaseHistoryCursorStateV3
  | FanslyPurchaseHistoryCursorStateV4;

export type FanslyMessagePurchaseTargetSource = {
  rawType: string | number;
  correlationId: string | null;
};

export const FANSLY_PURCHASE_HISTORY_RESULT_LIMIT = 100;

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
      | "contract_rejected"
      | "cursor_missing"
      | "cursor_repeated"
      | "cursor_conflict"
      | "http_rejected";
  };

export type FanslyPurchaseHistoryTargetChain = {
  target: FanslyPurchaseHistoryTarget;
  targetKey: string;
  firstCaptureId: number | null;
  orderRows: number;
  requestCursors: Array<string | null>;
  status: "complete" | "resumable" | "blocked";
  nextBefore: string | null;
  blockedCapture: FanslyPurchaseHistoryCaptureClassification | null;
};

export type FanslyPurchaseHistoryCaptureIndex = {
  captures: FanslyPurchaseHistoryCaptureClassification[];
  capturedTargetKeys: string[];
  capturedContentIds: string[];
  validatedCompleteTargetKeys: string[];
  validatedCompleteContentIds: string[];
  resumableTargets: FanslyPurchaseHistoryPendingTarget[];
  chains: FanslyPurchaseHistoryTargetChain[];
  blocked: FanslyPurchaseHistoryCaptureClassification[];
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

function purchaseHistoryTargetFromTargetKey(
  targetKey: string,
): FanslyPurchaseHistoryTarget | null {
  if (targetKey.startsWith("single:") && targetKey.length > "single:".length) {
    return {
      kind: "single",
      contentId: targetKey.slice("single:".length),
    };
  }
  if (targetKey.startsWith("bundle:") && targetKey.length > "bundle:".length) {
    return {
      kind: "bundle",
      contentId: targetKey.slice("bundle:".length),
    };
  }
  return null;
}

/**
 * Extends the transaction-batch contract check across checkpoint/capture and
 * source boundaries. A content id is global, so observing it in both request
 * namespaces is ambiguous regardless of which chunk found each occurrence.
 */
export function assertFanslyPurchaseHistoryTargetKindsConsistent(
  targets: readonly FanslyPurchaseHistoryTarget[],
  knownTargetKeys: Iterable<string> = [],
) {
  const knownKinds = new Map<
    string,
    Set<FanslyPurchaseHistoryTarget["kind"]>
  >();
  for (const targetKey of knownTargetKeys) {
    const target = purchaseHistoryTargetFromTargetKey(targetKey);
    if (!target) {
      continue;
    }
    const kinds = knownKinds.get(target.contentId) ?? new Set();
    kinds.add(target.kind);
    knownKinds.set(target.contentId, kinds);
  }

  const observedKinds = new Map<string, FanslyPurchaseHistoryTarget["kind"]>();
  const record = (target: FanslyPurchaseHistoryTarget) => {
    const existingKind = observedKinds.get(target.contentId);
    if (existingKind && existingKind !== target.kind) {
      throw new FanslyPurchaseHistoryContractError({
        code: "purchase_history_target_kind_conflict",
        message:
          `Fansly content ${target.contentId} appeared as both ${existingKind} and ${target.kind}; refusing to guess the order-history parameter`,
      });
    }
    const capturedKinds = knownKinds.get(target.contentId);
    if (
      capturedKinds &&
      capturedKinds.size === 1 &&
      !capturedKinds.has(target.kind)
    ) {
      const [capturedKind] = capturedKinds;
      throw new FanslyPurchaseHistoryContractError({
        code: "purchase_history_target_kind_conflict",
        message:
          `Fansly content ${target.contentId} appeared as both ${capturedKind} and ${target.kind}; refusing to guess the order-history parameter`,
      });
    }
    observedKinds.set(target.contentId, target.kind);
  };

  for (const target of targets) {
    record(target);
  }
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
 * Converts already-captured Fansly money facts into media-scoped discovery
 * targets. Duplicate sales of the same content collapse to one GET. The same
 * content id appearing in both media namespaces is contract drift: choosing a
 * request parameter would be a guess, so fail closed before provider egress.
 */
export function extractFanslyPurchaseHistoryTargetsFromTransactions(
  rows: readonly FanslyMessagePurchaseTargetSource[],
): FanslyPurchaseHistoryTarget[] {
  const targets = new Map<string, FanslyPurchaseHistoryTarget>();

  for (const row of rows) {
    const kind = purchaseHistoryTargetKindFromRawType(row.rawType);
    const contentId = typeof row.correlationId === "string"
      ? row.correlationId.trim()
      : "";
    if (!kind || !contentId) {
      continue;
    }

    const existing = targets.get(contentId);
    if (existing && existing.kind !== kind) {
      throw new FanslyPurchaseHistoryContractError({
        code: "purchase_history_target_kind_conflict",
        message:
          `Fansly content ${contentId} appeared as both ${existing.kind} and ${kind}; refusing to guess the order-history parameter`,
      });
    }
    if (!existing) {
      targets.set(contentId, { kind, contentId });
    }
  }

  return [...targets.values()];
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
): FanslyPurchaseHistoryCursorStateV4 | null {
  const state = asRecord(value);
  const version = asNumber(state?.version);
  if (version !== 2 && version !== 3 && version !== 4) {
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
      const rawBefore = version === 4 ? target?.before : null;
      const before = rawBefore === null ? null : asString(rawBefore);
      return (kind === "single" || kind === "bundle") && contentId &&
          (rawBefore === null || before !== null)
        ? [{ kind, contentId, before }]
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
    version: 4,
    transactionCursorId,
    rawPayloadCursorId,
    pendingTargets,
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

export function countFanslyPurchaseHistoryRows(payloadValue: unknown): number | null {
  return fanslyPurchaseHistoryRows(payloadValue)?.length ?? null;
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
  if (rawRows === null || rawRows.some((row) => asRecord(row) === null)) {
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

function blockedChainCapture(
  capture: FanslyPurchaseHistoryCaptureClassification,
  outcome: "cursor_repeated" | "cursor_conflict",
): FanslyPurchaseHistoryCaptureClassification {
  return {
    ...capture,
    validatedPage: false,
    terminal: false,
    blocked: true,
    outcome,
  };
}

function resolveFanslyPurchaseHistoryTargetChain(
  targetKey: string,
  captures: readonly FanslyPurchaseHistoryCaptureClassification[],
): FanslyPurchaseHistoryTargetChain {
  const target = purchaseHistoryTargetFromTargetKey(targetKey);
  if (!target) {
    throw new Error(`Invalid Fansly purchase-history target key ${targetKey}`);
  }
  const sorted = [...captures].sort((left, right) => (left.id ?? 0) - (right.id ?? 0));
  const firstCaptureId = sorted[0]?.id ?? null;
  const byCursor = new Map<string, FanslyPurchaseHistoryCaptureClassification[]>();
  for (const capture of sorted) {
    const key = capture.requestBefore ?? "";
    const pages = byCursor.get(key) ?? [];
    pages.push(capture);
    byCursor.set(key, pages);
  }

  const visited = new Set<string>();
  let before: string | null = null;
  let orderRows = 0;
  for (;;) {
    const cursorKey = before ?? "";
    const pages = byCursor.get(cursorKey);
    if (!pages || pages.length === 0) {
      return {
        target,
        targetKey,
        firstCaptureId,
        orderRows,
        requestCursors: [...visited].map((cursor) => cursor || null),
        status: "resumable",
        nextBefore: before,
        blockedCapture: null,
      };
    }

    const validPages = pages.filter((page) => !page.blocked);
    if (validPages.length === 0) {
      return {
        target,
        targetKey,
        firstCaptureId,
        orderRows,
        requestCursors: [...visited].map((cursor) => cursor || null),
        status: "blocked",
        nextBefore: before,
        blockedCapture: pages.at(-1)!,
      };
    }

    const semanticResults = new Set(validPages.map((page) =>
      page.terminal ? "terminal" : `next:${page.nextBefore ?? ""}`
    ));
    if (semanticResults.size > 1) {
      return {
        target,
        targetKey,
        firstCaptureId,
        orderRows,
        requestCursors: [...visited].map((cursor) => cursor || null),
        status: "blocked",
        nextBefore: before,
        blockedCapture: blockedChainCapture(validPages.at(-1)!, "cursor_conflict"),
      };
    }

    const page = validPages.at(-1)!;
    orderRows += page.orderRows ?? 0;
    visited.add(cursorKey);
    if (page.terminal) {
      return {
        target,
        targetKey,
        firstCaptureId,
        orderRows,
        requestCursors: [...visited].map((cursor) => cursor || null),
        status: "complete",
        nextBefore: null,
        blockedCapture: null,
      };
    }

    const nextBefore = page.nextBefore!;
    if (visited.has(nextBefore)) {
      return {
        target,
        targetKey,
        firstCaptureId,
        orderRows,
        requestCursors: [...visited].map((cursor) => cursor || null),
        status: "blocked",
        nextBefore,
        blockedCapture: blockedChainCapture(page, "cursor_repeated"),
      };
    }
    before = nextBefore;
  }
}

/**
 * Builds a contiguous page chain from `before=null` for every target. A target
 * is complete only when that chain reaches an empty or terminal-missing page;
 * otherwise it either exposes the next missing cursor or a durable blocker.
 */
export function classifyFanslyPurchaseHistoryCaptures(
  captures: readonly FanslyPurchaseHistoryCapture[],
): FanslyPurchaseHistoryCaptureIndex {
  const classified = captures.map(classifyFanslyPurchaseHistoryCapture);
  const capturedTargetKeys = new Set<string>();
  const capturedContentIds = new Set<string>();
  const validatedCompleteTargetKeys = new Set<string>();
  const validatedCompleteContentIds = new Set<string>();

  const capturesByTargetKey = new Map<string, FanslyPurchaseHistoryCaptureClassification[]>();
  for (const capture of classified) {
    capturedTargetKeys.add(capture.targetKey);
    capturedContentIds.add(capture.contentId);
    const targetCaptures = capturesByTargetKey.get(capture.targetKey) ?? [];
    targetCaptures.push(capture);
    capturesByTargetKey.set(capture.targetKey, targetCaptures);
  }

  const chains = [...capturesByTargetKey.entries()]
    .map(([targetKey, targetCaptures]) =>
      resolveFanslyPurchaseHistoryTargetChain(targetKey, targetCaptures)
    )
    .sort((left, right) =>
      (left.firstCaptureId ?? Number.MAX_SAFE_INTEGER) -
        (right.firstCaptureId ?? Number.MAX_SAFE_INTEGER)
    );

  // One Fansly content id cannot validly occupy both request namespaces. This
  // is contract drift even when the conflicting captures arrived in separate
  // runs, so turn every affected chain into a local blocker.
  const targetKeysByContentId = new Map<string, string[]>();
  for (const chain of chains) {
    const keys = targetKeysByContentId.get(chain.target.contentId) ?? [];
    keys.push(chain.targetKey);
    targetKeysByContentId.set(chain.target.contentId, keys);
  }
  for (const [contentId, targetKeys] of targetKeysByContentId) {
    if (targetKeys.length < 2) {
      continue;
    }
    for (const targetKey of targetKeys) {
      const chain = chains.find((candidate) => candidate.targetKey === targetKey)!;
      const representative = capturesByTargetKey.get(targetKey)!.at(-1)!;
      chain.status = "blocked";
      chain.nextBefore = null;
      chain.blockedCapture = blockedChainCapture(
        {
          ...representative,
          contentId,
        },
        "cursor_conflict",
      );
    }
  }

  for (const chain of chains) {
    if (chain.status === "complete") {
      validatedCompleteTargetKeys.add(chain.targetKey);
      validatedCompleteContentIds.add(chain.target.contentId);
    }
  }

  const blocked = chains.flatMap((chain) =>
    chain.status === "blocked" && chain.blockedCapture
      ? [chain.blockedCapture]
      : []
  );
  const resumableTargets = chains.flatMap<FanslyPurchaseHistoryPendingTarget>((chain) =>
    chain.status === "resumable"
      ? [{ ...chain.target, before: chain.nextBefore }]
      : []
  );

  return {
    captures: classified,
    capturedTargetKeys: [...capturedTargetKeys],
    capturedContentIds: [...capturedContentIds],
    validatedCompleteTargetKeys: [...validatedCompleteTargetKeys],
    validatedCompleteContentIds: [...validatedCompleteContentIds],
    resumableTargets,
    chains,
    blocked,
  };
}
