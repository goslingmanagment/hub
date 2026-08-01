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

const INTERACTIVE_LIST_ENVELOPES = new Map<string, "array" | "list" | "either">([
  ["ofapi_gateway_chats", "array"],
  ["ofapi_gateway_chat_messages", "array"],
  ["ofapi_gateway_chat_media", "list"],
  // Both variants are already accepted by the legacy clients for these
  // surfaces, so capture-first must not narrow that compatibility during
  // rollout.
  ["ofapi_gateway_transactions", "either"],
  ["ofapi_gateway_fans_all", "either"],
  ["ofapi_gateway_fans_active", "either"],
  ["ofapi_gateway_user_lists", "either"],
  ["ofapi_gateway_user_list_users", "list"],
  ["ofapi_gateway_vault_media", "list"],
  ["ofapi_gateway_vault_lists", "list"],
]);

const INTERACTIVE_SINGLE_ITEM_OPERATIONS = new Set([
  "ofapi_gateway_chat_message",
  "ofapi_gateway_user",
  "ofapi_gateway_vault_media_item",
]);

/**
 * Checks only the stable top-level wire family consumed by the desktop. A
 * list operation accepts both `{data: [...]}` and `{data: {list: [...]}}` only
 * where both variants are already supported by the legacy client. Deep item
 * validation stays with each consumer so additive field drift cannot fail
 * every interactive read.
 *
 * Unknown operations fail closed. Adding a gateway surface therefore also
 * requires choosing its response family instead of silently returning to
 * syntax-only validation.
 */
export function validateOfapiInteractiveResponseShape(
  operation: string,
  body: unknown,
): boolean {
  const listEnvelope = INTERACTIVE_LIST_ENVELOPES.get(operation);
  if (listEnvelope) {
    const root = asRecord(body);
    if (!root) return false;
    const hasArray = Array.isArray(root.data);
    const hasList = Array.isArray(asRecord(root.data)?.list);
    if (listEnvelope === "array") return hasArray;
    if (listEnvelope === "list") return hasList;
    return hasArray || hasList;
  }

  if (INTERACTIVE_SINGLE_ITEM_OPERATIONS.has(operation)) {
    const data = asRecord(asRecord(body)?.data);
    return data !== null && itemId(data.id) !== null;
  }

  if (operation === "ofapi_gateway_users_list") {
    const data = asRecord(asRecord(body)?.data);
    return data !== null && Object.values(data).every((value) => {
      const user = asRecord(value);
      return user !== null && itemId(user.id) !== null;
    });
  }

  if (operation === "ofapi_gateway_upload_status") {
    const status = asRecord(body)?.status;
    return typeof status === "string" && status.length > 0;
  }

  return false;
}

export interface ParsedOfapiJsonBody {
  validJson: boolean;
  body: unknown;
  creditsUsed: number | null;
  balanceAfter: number | null;
}

export function parseOfapiJsonBytes(bytes: Buffer): ParsedOfapiJsonBody {
  if (bytes.length === 0) {
    return { validJson: false, body: "", creditsUsed: null, balanceAfter: null };
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

export type StrictOfapiPostPage =
  | {
    accepted: true;
    rawCount: number;
    items: Record<string, unknown>[];
    acceptedItems: Record<string, unknown>[];
    boundaryDuplicateCount: number;
    explicitlyIrrelevantCount: number;
    headPostId: string | null;
    tailPostId: string | null;
    stopReached: boolean;
    hasNextPage: boolean;
  }
  | {
    accepted: false;
    rawCount: number;
    rejectedCount: number;
    reason: string;
  };

/**
 * Strict background-capture contract for GET /api/{account}/posts.
 *
 * The vendored OFAPI OpenAPI snapshot specifies `{data: {list, hasMore}}`
 * with offset pagination. Valid-but-different JSON is captured and parked,
 * never interpreted as an empty page. Adjacent requests deliberately overlap
 * by one post id so offset movement cannot silently create a gap while new
 * posts are being published.
 */
export function parseStrictOfapiPostPage(
  body: unknown,
  input: {
    requiredOverlapId?: string | null;
    stopAtPostId?: string | null;
  } = {},
): StrictOfapiPostPage {
  const root = asRecord(body);
  const data = asRecord(root?.data);
  if (!root || !data || !Array.isArray(data.list)) {
    return { accepted: false, rawCount: 0, rejectedCount: 1, reason: "data_list_missing" };
  }
  if (typeof data.hasMore !== "boolean") {
    return {
      accepted: false,
      rawCount: data.list.length,
      rejectedCount: 1,
      reason: "has_more_missing",
    };
  }
  for (const marker of ["headMarker", "tailMarker"] as const) {
    const value = data[marker];
    if (value !== undefined && value !== null && typeof value !== "string") {
      return {
        accepted: false,
        rawCount: data.list.length,
        rejectedCount: 1,
        reason: `${marker}_invalid`,
      };
    }
  }

  const items: Record<string, unknown>[] = [];
  const ids: string[] = [];
  const seenIds = new Set<string>();
  let previousPublishedAtMs: number | null = null;
  for (const raw of data.list) {
    const item = asRecord(raw);
    const id = itemId(item?.id);
    const postedAt = typeof item?.postedAt === "string"
      ? new Date(item.postedAt)
      : null;
    const rawTextValid = item?.rawText === undefined || item.rawText === null ||
      typeof item.rawText === "string";
    const textValid = item?.text === undefined || item.text === null ||
      typeof item.text === "string";
    if (
      !item ||
      !id ||
      !postedAt ||
      Number.isNaN(postedAt.getTime()) ||
      !rawTextValid ||
      !textValid
    ) {
      return {
        accepted: false,
        rawCount: data.list.length,
        rejectedCount: 1,
        reason: "post_item_invalid",
      };
    }
    if (seenIds.has(id)) {
      return {
        accepted: false,
        rawCount: data.list.length,
        rejectedCount: 1,
        reason: "post_id_duplicate",
      };
    }
    const publishedAtMs = postedAt.getTime();
    if (previousPublishedAtMs !== null && publishedAtMs > previousPublishedAtMs) {
      return {
        accepted: false,
        rawCount: data.list.length,
        rejectedCount: 1,
        reason: "post_order_invalid",
      };
    }
    previousPublishedAtMs = publishedAtMs;
    seenIds.add(id);
    ids.push(id);
    items.push(item);
  }

  const requiredOverlapId = input.requiredOverlapId ?? null;
  const overlapIndex = requiredOverlapId === null ? -1 : ids.indexOf(requiredOverlapId);
  if (requiredOverlapId !== null && overlapIndex < 0) {
    return {
      accepted: false,
      rawCount: items.length,
      rejectedCount: 1,
      reason: "page_overlap_missing",
    };
  }
  const stopAtPostId = input.stopAtPostId ?? null;
  const stopIndex = stopAtPostId === null ? -1 : ids.indexOf(stopAtPostId);
  const stopReached = stopIndex >= 0;

  const boundaryIndices = new Set<number>();
  if (overlapIndex >= 0) boundaryIndices.add(overlapIndex);
  if (stopIndex >= 0) boundaryIndices.add(stopIndex);
  const acceptedItems = items.filter((_item, index) =>
    !boundaryIndices.has(index) && (stopIndex < 0 || index < stopIndex)
  );
  const boundaryDuplicateCount = boundaryIndices.size;
  const explicitlyIrrelevantCount = stopIndex < 0
    ? 0
    : items.filter((_item, index) => index > stopIndex && !boundaryIndices.has(index)).length;

  if (data.hasMore && !stopReached && items.length < 2) {
    return {
      accepted: false,
      rawCount: items.length,
      rejectedCount: 1,
      reason: "has_more_without_overlap_progress",
    };
  }

  return {
    accepted: true,
    rawCount: items.length,
    items,
    acceptedItems,
    boundaryDuplicateCount,
    explicitlyIrrelevantCount,
    headPostId: ids[0] ?? null,
    tailPostId: ids.at(-1) ?? null,
    stopReached,
    hasNextPage: data.hasMore,
  };
}

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
