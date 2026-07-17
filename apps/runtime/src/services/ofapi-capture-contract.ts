function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function itemId(value: unknown) {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export interface ParsedOfapiJsonBody {
  validJson: boolean;
  body: unknown;
  creditsUsed: number | null;
  balanceAfter: number | null;
}

export function parseOfapiJsonBytes(bytes: Buffer): ParsedOfapiJsonBody {
  if (bytes.length === 0) {
    return { validJson: true, body: null, creditsUsed: null, balanceAfter: null };
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    return { validJson: false, body: text, creditsUsed: null, balanceAfter: null };
  }
  try {
    const body = JSON.parse(text) as unknown;
    const root = asRecord(body);
    const meta = asRecord(root?._meta);
    const credits = asRecord(meta?._credits);
    return {
      validJson: true,
      body,
      creditsUsed: nonNegativeInteger(credits?.used),
      balanceAfter: nonNegativeInteger(credits?.balance),
    };
  } catch {
    return { validJson: false, body: text, creditsUsed: null, balanceAfter: null };
  }
}

export function capturePayloadResponse(payload: unknown): {
  status: number;
  headers: Record<string, string>;
  bodyBytes: Buffer;
} | null {
  const root = asRecord(payload);
  const response = asRecord(root?.response);
  const status = response?.status;
  const rawHeaders = asRecord(response?.headers);
  const body = response?.body;
  const encoding = response?.bodyEncoding;
  if (typeof status !== "number" || !Number.isInteger(status) || typeof body !== "string") {
    return null;
  }
  const headers = rawHeaders
    ? Object.fromEntries(
      Object.entries(rawHeaders).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string"),
    )
    : {};
  if (encoding === "utf8") {
    return { status, headers, bodyBytes: Buffer.from(body, "utf8") };
  }
  if (encoding === "base64" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)) {
    return { status, headers, bodyBytes: Buffer.from(body, "base64") };
  }
  return null;
}

export function capturePayloadBodyBytes(payload: unknown): Buffer | null {
  return capturePayloadResponse(payload)?.bodyBytes ?? null;
}

export type StrictOfapiMessagePage =
  | {
    accepted: true;
    rawCount: number;
    items: Record<string, unknown>[];
    boundaryDuplicateCount: number;
    boundarySemantics: "inclusive" | "exclusive" | null;
    nextCursor: string | null;
    hasNextPage: boolean;
  }
  | {
    accepted: false;
    rawCount: number;
    rejectedCount: number;
    reason: string;
  };

/**
 * The certificate boundary for List Messages. Only the production-proven
 * `{data: [...], _pagination: {next_page: string|null}}` shape is accepted.
 * Any valid-but-different JSON is captured and parked, never interpreted as
 * an empty terminal page.
 */
export function parseStrictOfapiMessagePage(
  body: unknown,
  input: {
    requiredBoundaryCursor: string | null;
    boundaryIsDuplicate: boolean;
    expectedBoundarySemantics?: "inclusive" | "exclusive" | null;
  },
): StrictOfapiMessagePage {
  const root = asRecord(body);
  if (!root || !Array.isArray(root.data)) {
    return { accepted: false, rawCount: 0, rejectedCount: 1, reason: "data_not_array" };
  }
  const pagination = asRecord(root._pagination);
  if (!pagination || !("next_page" in pagination)) {
    return {
      accepted: false,
      rawCount: root.data.length,
      rejectedCount: 1,
      reason: "pagination_missing",
    };
  }
  const nextPage = pagination.next_page;
  if (nextPage !== null && (typeof nextPage !== "string" || nextPage.length === 0)) {
    return {
      accepted: false,
      rawCount: root.data.length,
      rejectedCount: 1,
      reason: "next_page_invalid",
    };
  }

  const items: Record<string, unknown>[] = [];
  const seenIds = new Set<string>();
  const parsedIds: string[] = [];
  let boundaryDuplicateCount = 0;
  let rejectedCount = 0;
  let boundaryCount = 0;
  let previousCreatedAtMs: number | null = null;
  for (const [index, raw] of root.data.entries()) {
    const item = asRecord(raw);
    const id = itemId(item?.id);
    const createdAt = typeof item?.createdAt === "string"
      ? new Date(item.createdAt)
      : null;
    if (
      !item ||
      !id ||
      typeof item.isSentByMe !== "boolean" ||
      !createdAt ||
      Number.isNaN(createdAt.getTime())
    ) {
      rejectedCount += 1;
      continue;
    }
    if (seenIds.has(id)) {
      return {
        accepted: false,
        rawCount: root.data.length,
        rejectedCount: 1,
        reason: "message_id_duplicate",
      };
    }
    seenIds.add(id);
    parsedIds.push(id);
    const createdAtMs = createdAt.getTime();
    if (previousCreatedAtMs !== null && createdAtMs > previousCreatedAtMs) {
      return {
        accepted: false,
        rawCount: root.data.length,
        rejectedCount: 1,
        reason: "message_order_invalid",
      };
    }
    previousCreatedAtMs = createdAtMs;
    if (input.requiredBoundaryCursor !== null && id === input.requiredBoundaryCursor) {
      boundaryCount += 1;
      if (index !== 0) {
        return {
          accepted: false,
          rawCount: root.data.length,
          rejectedCount: 1,
          reason: "requested_boundary_not_first",
        };
      }
      if (input.boundaryIsDuplicate) {
        boundaryDuplicateCount += 1;
        continue;
      }
    }
    items.push(item);
  }
  if (rejectedCount > 0) {
    return {
      accepted: false,
      rawCount: root.data.length,
      rejectedCount,
      reason: "message_item_invalid",
    };
  }
  let boundarySemantics: "inclusive" | "exclusive" | null = null;
  if (input.requiredBoundaryCursor !== null) {
    boundarySemantics = boundaryCount === 1 ? "inclusive" : "exclusive";
    if (
      input.expectedBoundarySemantics != null &&
      input.expectedBoundarySemantics !== boundarySemantics
    ) {
      return {
        accepted: false,
        rawCount: root.data.length,
        rejectedCount: 1,
        reason: "cursor_semantics_changed",
      };
    }
    if (boundarySemantics === "exclusive" && parsedIds.length > 0) {
      const boundary = input.requiredBoundaryCursor;
      if (!/^\d+$/.test(boundary) || parsedIds.some((id) => !/^\d+$/.test(id))) {
        return {
          accepted: false,
          rawCount: root.data.length,
          rejectedCount: 1,
          reason: "exclusive_boundary_order_unverifiable",
        };
      }
      const boundaryId = BigInt(boundary);
      if (parsedIds.some((id) => BigInt(id) >= boundaryId)) {
        return {
          accepted: false,
          rawCount: root.data.length,
          rejectedCount: 1,
          reason: "exclusive_boundary_order_invalid",
        };
      }
    }
  }

  const hasNextPage = typeof nextPage === "string";
  const nextCursor = items.length > 0 ? itemId(items.at(-1)?.id) : null;
  if (hasNextPage && nextCursor === null) {
    return {
      accepted: false,
      rawCount: root.data.length,
      rejectedCount: 1,
      reason: "next_page_without_progress",
    };
  }
  return {
    accepted: true,
    rawCount: root.data.length,
    items,
    boundaryDuplicateCount,
    boundarySemantics,
    nextCursor,
    hasNextPage,
  };
}
