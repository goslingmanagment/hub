type JsonRecord = Record<string, unknown>;

export type FanslyPurchaseHistoryTarget = {
  kind: "single" | "bundle";
  contentId: string;
};

export type FanslyPurchaseHistoryCursorState = {
  version: 2;
  rawPayloadCursorId: number;
  pendingTargets: FanslyPurchaseHistoryTarget[];
};

export const FANSLY_PURCHASE_HISTORY_RESULT_LIMIT = 100;

export type FanslyPurchaseHistoryCapture = {
  id: number | null;
  targetKey: string;
  statusCode: number | null;
  responsePayload: unknown;
};

export type FanslyPurchaseHistoryCaptureClassification =
  & FanslyPurchaseHistoryCapture
  & {
    contentId: string;
    captured: true;
    validatedComplete: boolean;
    blocked: boolean;
    orderRows: number | null;
    outcome:
      | "supported_shape"
      | "terminal_missing"
      | "contract_rejected"
      | "result_truncated"
      | "http_rejected";
  };

export type FanslyPurchaseHistoryCaptureIndex = {
  captures: FanslyPurchaseHistoryCaptureClassification[];
  capturedTargetKeys: string[];
  capturedContentIds: string[];
  validatedCompleteTargetKeys: string[];
  validatedCompleteContentIds: string[];
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
): FanslyPurchaseHistoryCursorState | null {
  const state = asRecord(value);
  if (asNumber(state?.version) !== 2) {
    return null;
  }
  const rawPayloadCursorId = asNumber(state?.rawPayloadCursorId);
  if (rawPayloadCursorId === null || rawPayloadCursorId < 0) {
    return null;
  }

  const rawPendingTargets = state?.pendingTargets;
  if (!Array.isArray(rawPendingTargets)) {
    return null;
  }
  const pendingTargets = rawPendingTargets.flatMap<FanslyPurchaseHistoryTarget>((item) => {
      const target = asRecord(item);
      const kind = target?.kind;
      const contentId = asString(target?.contentId);
      return (kind === "single" || kind === "bundle") && contentId
        ? [{ kind, contentId }]
        : [];
    });
  if (pendingTargets.length !== rawPendingTargets.length) {
    return null;
  }

  return {
    version: 2,
    rawPayloadCursorId,
    pendingTargets,
  };
}

export function countFanslyPurchaseHistoryRows(payloadValue: unknown): number | null {
  const payload = asRecord(payloadValue);
  if (!payload) {
    return null;
  }
  if (Array.isArray(payload.accountMediaOrderHistory)) {
    return payload.accountMediaOrderHistory.length;
  }
  if (Array.isArray(payload.accountMediaOrders)) {
    return payload.accountMediaOrders.length;
  }
  const aggregation = asRecord(payload.aggregationData);
  if (Array.isArray(aggregation?.accountMediaOrders)) {
    return aggregation.accountMediaOrders.length;
  }
  return null;
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
      validatedComplete: true,
      blocked: false,
      orderRows: 0,
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
      validatedComplete: false,
      blocked: true,
      orderRows: null,
      outcome: "http_rejected",
    };
  }

  const orderRows = countFanslyPurchaseHistoryRows(capture.responsePayload);
  if (orderRows === null) {
    return {
      ...capture,
      contentId,
      captured: true,
      validatedComplete: false,
      blocked: true,
      orderRows: null,
      outcome: "contract_rejected",
    };
  }
  if (orderRows >= FANSLY_PURCHASE_HISTORY_RESULT_LIMIT) {
    return {
      ...capture,
      contentId,
      captured: true,
      validatedComplete: false,
      blocked: true,
      orderRows,
      outcome: "result_truncated",
    };
  }

  return {
    ...capture,
    contentId,
    captured: true,
    validatedComplete: true,
    blocked: false,
    orderRows,
    outcome: "supported_shape",
  };
}

/**
 * Builds the local reconciliation view. Any capture suppresses egress, but a
 * target is complete only when at least one capture validates. Multiple raw
 * rows for the same content id are folded so an older rejected shape cannot
 * override a later locally-valid capture (or the reverse).
 */
export function classifyFanslyPurchaseHistoryCaptures(
  captures: readonly FanslyPurchaseHistoryCapture[],
): FanslyPurchaseHistoryCaptureIndex {
  const classified = captures.map(classifyFanslyPurchaseHistoryCapture);
  const capturedTargetKeys = new Set<string>();
  const capturedContentIds = new Set<string>();
  const validatedCompleteTargetKeys = new Set<string>();
  const validatedCompleteContentIds = new Set<string>();

  for (const capture of classified) {
    capturedTargetKeys.add(capture.targetKey);
    capturedContentIds.add(capture.contentId);
    if (capture.validatedComplete) {
      validatedCompleteTargetKeys.add(capture.targetKey);
      validatedCompleteContentIds.add(capture.contentId);
    }
  }

  const blockedByContentId = new Map<string, FanslyPurchaseHistoryCaptureClassification>();
  for (const capture of classified) {
    if (
      capture.blocked &&
      !validatedCompleteContentIds.has(capture.contentId)
    ) {
      blockedByContentId.set(capture.contentId, capture);
    }
  }

  return {
    captures: classified,
    capturedTargetKeys: [...capturedTargetKeys],
    capturedContentIds: [...capturedContentIds],
    validatedCompleteTargetKeys: [...validatedCompleteTargetKeys],
    validatedCompleteContentIds: [...validatedCompleteContentIds],
    blocked: [...blockedByContentId.values()],
  };
}
