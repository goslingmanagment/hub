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

/**
 * Finds PPV content ids from a captured Fansly /message page. The endpoint
 * contract is media-scoped: accountMediaId/accountMediaBundleId is required;
 * accountIds is only an optional buyer filter. We therefore walk observed PPV
 * media, never the cartesian product of every fan and every media item.
 */
export function extractFanslyPurchaseHistoryTargets(
  payloads: readonly unknown[],
): FanslyPurchaseHistoryTarget[] {
  const targets = new Map<string, FanslyPurchaseHistoryTarget>();

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
          ? { kind: "single" as const, contentId: mediaId }
          : null;
      if (target) {
        targets.set(fanslyPurchaseHistoryTargetKey(target), target);
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
        targets.set(fanslyPurchaseHistoryTargetKey(target), target);
      }
    }
  }

  return [...targets.values()].sort((left, right) =>
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
