import { normalizeOfapiMarketingAnalytics, normalizeOfapiMarketingResource } from "./ofapi-marketing-normalization.ts";
import { isOfapiProviderLinkOrigin, OFAPI_DEFAULT_BASE_URL } from "./ofapi.ts";
import { createHash } from "node:crypto";
import {
  findOfapiReadDefinition,
  isOfapiUserListRef,
  validateOfapiReadQuery,
  type OfapiReadDefinition,
} from "@agency_hub_core/shared";
import { ofapiDollarValueToMillsString } from "./ofapi-message-material.ts";

export function ofapiReadRecord(
  value: unknown,
): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function id(value: unknown): string | null {
  return typeof value === "string" && value.length > 0
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
const SAFE_PROFILE_FIELDS = new Set([
  "id",
  "name",
  "username",
  "avatar",
  "header",
  "about",
  "isVerified",
  "postsCount",
  "photosCount",
  "videosCount",
  "audiosCount",
  "mediasCount",
  "subscribersCount",
  "subscribesCount",
  "favoritedCount",
  "canReceiveChatMessage",
  "isBlocked",
  "isRestricted",
]);
export function safeOfapiReadBody(operation: string, body: unknown): unknown {
  if (operation !== "ofapi_read_me") return body;
  const root = ofapiReadRecord(body),
    data = ofapiReadRecord(root?.data);
  return {
    data: data
      ? Object.fromEntries(
          Object.entries(data).filter(([key]) => SAFE_PROFILE_FIELDS.has(key)),
        )
      : null,
  };
}
export function ofapiReadItems(
  def: OfapiReadDefinition,
  body: unknown,
): unknown[] | null {
  const root = ofapiReadRecord(body);
  if (!root) return null;
  const data = root.data;
  if (def.id === "smart_link_tags") return Array.isArray(root.tags) ? root.tags : null;
  if (/^(tracking|trial)_link_tags$/.test(def.id)) return Array.isArray(ofapiReadRecord(data)?.tags) ? ofapiReadRecord(data)!.tags as unknown[] : null;
  if (def.shape === "object") return ofapiReadRecord(data) ? [data] : null;
  if (def.shape === "array" || def.shape === "strings")
    return Array.isArray(data) ? data : null;
  const items = ofapiReadRecord(data)?.[def.shape];
  return Array.isArray(items) ? items : null;
}
export function validateOfapiCatalogResponse(
  operation: string,
  body: unknown,
): boolean | null {
  const def = findOfapiReadDefinition(operation);
  if (!def) return null;
  const items = ofapiReadItems(def, body);
  if (def.category === "smart_links" || def.category === "tracking_links") {
    try { normalizeOfapiMarketingRead(def, body); } catch { return false; }
  }
  return (
    items !== null &&
    items.every((item) => {
      if (def.id.startsWith("user_list")) {
        const row = ofapiReadRecord(item),
          nativeId = id(row?.id);
        return (
          nativeId !== null &&
          (["user_lists", "user_list"].includes(def.id)
            ? isOfapiUserListRef(nativeId)
            : /^[1-9][0-9]*$/.test(nativeId))
        );
      }
      return def.shape === "strings"
        ? typeof item === "string"
        : ofapiReadRecord(item) !== null &&
            (!Object.hasOwn(ofapiReadRecord(item)!, "id") ||
              id(ofapiReadRecord(item)!.id) !== null);
    })
  );
}
export interface OfapiReadCoverage {
  state: "complete" | "partial" | "unknown";
  reason: string | null;
  indexComplete: boolean | null;
  omitted: number | null;
  nextQuery: Record<string, string> | null;
}
/** Continuation evidence wins over row count. Untrusted links never become arbitrary egress. */
export function ofapiReadCoverage(
  def: OfapiReadDefinition,
  body: unknown,
  pathname: string,
  query: Record<string, string>,
): OfapiReadCoverage {
  const root = ofapiReadRecord(body),
    data = ofapiReadRecord(root?.data),
    source = ofapiReadRecord(data?._source) ?? ofapiReadRecord(root?._source);
  const indexComplete = bool(source?.is_complete),
    omitted =
      typeof source?.omitted_from_page === "number"
        ? source.omitted_from_page
        : null;
  const result: OfapiReadCoverage = {
    state: "unknown",
    reason: "continuation_unspecified",
    indexComplete,
    omitted,
    nextQuery: null,
  };
  const pagination = ofapiReadRecord(root?._pagination),
    hasNext = Object.hasOwn(pagination ?? {}, "next_page"),
    next = pagination?.next_page;
  if (data?.isAvailable === false || data?.hasStats === false) {
    result.reason =
      data.isAvailable === false ? "provider_unavailable" : "provider_no_stats";
    return result;
  }
  const hasMore = bool(data?.hasMore),
    items = ofapiReadItems(def, body) ?? [];
  const partial = () => {
    if (indexComplete === false || (omitted ?? 0) > 0) {
      result.state = "partial";
      result.reason = "provider_index_incomplete";
    }
    return result;
  };
  if (hasNext && typeof next === "string" && next.length > 0) {
    try {
      const url = new URL(next, `${OFAPI_DEFAULT_BASE_URL}/`);
      if (
        !isOfapiProviderLinkOrigin(url, new URL(OFAPI_DEFAULT_BASE_URL)) ||
        url.pathname !== `/api${pathname}` ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error("foreign continuation");
      const raw = Object.fromEntries(url.searchParams);
      if ([...url.searchParams.keys()].length !== Object.keys(raw).length)
        throw new Error("duplicate continuation");
      const candidate = validateOfapiReadQuery(def, { ...query, ...raw });
      // A continuation may move only its cursor. It cannot change a user selection/window start.
      const cursor =
        def.pagination === "offset"
          ? "offset"
          : def.pagination === "date"
            ? "endDate"
            : def.pagination;
      if (cursor === "none") throw new Error("unsupported continuation");
      for (const key of new Set([
        ...Object.keys(query),
        ...Object.keys(candidate),
      ]))
        if (key !== cursor && candidate[key] !== query[key])
          throw new Error("changed selection");
      if (
        candidate[cursor] === query[cursor] ||
        candidate[cursor] === undefined
      )
        throw new Error("non-advancing continuation");
      if (
        cursor === "offset" &&
        Number(candidate.offset) <= Number(query.offset ?? 0)
      )
        throw new Error("offset regression");
      if (
        cursor === "endDate" &&
        query.endDate &&
        Date.parse(candidate.endDate!) >= Date.parse(query.endDate)
      )
        throw new Error("date regression");
      result.nextQuery = candidate;
      result.state = "partial";
      result.reason = "next_page";
      return partial();
    } catch {
      result.state = "partial";
      result.reason = "invalid_provider_continuation";
      return partial();
    }
  }
  if ((hasNext && next === null) || hasMore === false) {
    result.state = "complete";
    result.reason = null;
    return partial();
  }
  if (hasMore === true) {
    let value: string | null = null;
    let cursor: string = def.pagination;
    if (def.pagination === "offset") {
      cursor = "offset";
      value =
        id(data?.nextOffset) ??
        String(Number(query.offset ?? 0) + Number(query.limit ?? 10));
      if (Number(value) <= Number(query.offset ?? 0)) value = null;
    }
    if (def.pagination === "marker") value = id(data?.marker);
    if (def.pagination === "from_id")
      value = id(ofapiReadRecord(items.at(-1))?.id);
    if (value !== null && value !== query[cursor]) {
      result.nextQuery = { ...query, [cursor]: value };
      result.reason = "has_more";
    } else result.reason = "continuation_unavailable";
    result.state = "partial";
    return partial();
  }
  if (def.pagination === "none") {
    result.state = def.granularity === "ranking" ? "partial" : "complete";
    result.reason = def.granularity === "ranking" ? "bounded_ranking" : null;
  }
  if (def.scope === "smart_link" && def.pagination === "offset") {
    const count = Array.isArray(data?.rows) ? data.rows.length : items.length;
    if (count >= Number(query.limit ?? 50)) {
      result.state = "partial"; result.reason = "bounded_offset_scan";
      result.nextQuery = { ...query, offset: String(Number(query.offset ?? 0) + count) };
    }
  }
  // Payout request examples carry a response marker but document only offset. Do not invent EOF.
  return partial();
}
function metricValue(key: string, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => metricValue(key, item));
  const row = ofapiReadRecord(value);
  if (row)
    return Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, metricValue(k, v)]),
    );
  if (
    /price|amount|earnings?|revenue|payoutAvailable|payoutPending|purchasedSumm|tipSum|totalSpent|spending/i.test(
      key,
    )
  ) {
    try {
      const mills = ofapiDollarValueToMillsString(value);
      return mills === null
        ? { unit: "unknown", value }
        : { unit: "mills", value: mills };
    } catch {
      return { unit: "unknown", value };
    }
  }
  return value;
}
function scalarMetrics(
  value: unknown,
  path = "",
  depth = 0,
): Array<{
  path: string;
  unit: string;
  value: string;
  valueMills: string | null;
}> {
  if (depth > 12 || value === null || typeof value === "boolean") return [];
  const row = ofapiReadRecord(value);
  if (row?.unit === "mills" && typeof row.value === "string")
    return [{ path, unit: "mills", value: row.value, valueMills: row.value }];
  if (typeof value === "number" && Number.isFinite(value))
    return [
      { path, unit: "provider_number", value: String(value), valueMills: null },
    ];
  if (Array.isArray(value))
    return value.flatMap((v, i) =>
      scalarMetrics(v, `${path}[${i}]`, depth + 1),
    );
  if (row)
    return Object.entries(row).flatMap(([k, v]) =>
      scalarMetrics(v, path ? `${path}.${k}` : k, depth + 1),
    );
  return [];
}
export function normalizeOfapiMarketingRead(def: OfapiReadDefinition, body: unknown) {
  const items = ofapiReadItems(def, body);
  if (!items) throw new Error("Marketing response contract rejected");
  if (def.id.endsWith("_tags")) return items.map(raw => { if (typeof raw !== "string") throw new Error("Invalid marketing tag"); return { nativeId: raw, tag: raw }; });
  const resourceKind = def.id === "smart_links" || def.id === "smart_link" ? "smart_link" : def.id === "smart_link_pixels" ? "pixel"
    : /^(stored_)?(shared_)?tracking_links$|^tracking_link$/.test(def.id) ? "tracking" : /^(stored_)?(shared_)?trial_links$|^trial_link$/.test(def.id) ? "trial" : null;
  if (resourceKind) return items.map(raw => {
    const row = ofapiReadRecord(raw); if (!row) throw new Error("Invalid marketing resource");
    const { pageId: _pageId, observedAt: _observedAt, ...resource } = normalizeOfapiMarketingResource({ kind: resourceKind, pageId: null, observedAt: new Date(0), row });
    return { nativeId: resource.id, resource };
  });
  return normalizeOfapiMarketingAnalytics(def.operation, body).map((metric, i) => ({ nativeId: metric.nativeId ?? String(i), metric }));
}
export function validateOfapiMarketingAccount(def: OfapiReadDefinition, body: unknown, accountId: string) {
  if (!["smart_links", "smart_link"].includes(def.id)) return true;
  return (ofapiReadItems(def, body) ?? []).every(item => ofapiReadRecord(ofapiReadRecord(item)?.account)?.id === accountId);
}
/** Typed CRM/content fields are deliberately independent of the vendor's private profile fields. */
export function normalizeOfapiRead(
  def: OfapiReadDefinition,
  body: unknown,
  pathname?: string,
) {
  if (def.category === "smart_links" || def.category === "tracking_links") return normalizeOfapiMarketingRead(def, body);
  const clean = safeOfapiReadBody(def.operation, body),
    items = ofapiReadItems(def, clean);
  if (!items || !validateOfapiCatalogResponse(def.operation, clean))
    throw new Error("OFAPI read response contract rejected");
  return items.map((raw, index) => {
    if (typeof raw === "string")
      return { nativeId: raw, kind: def.id, text: raw };
    const row = ofapiReadRecord(raw)!,
      user = ofapiReadRecord(row.user) ?? ofapiReadRecord(row.author) ?? row;
    const nativeId =
      id(row.id) ??
      id(row.invoiceId) ??
      id(row.messageId) ??
      createHash("sha256").update(JSON.stringify(row)).digest("hex");
    const subscription =
      ofapiReadRecord(row.subscribedOnData) ??
      ofapiReadRecord(row.subscribedByData);
    const profile =
      def.id === "fans_latest" || (def.category === "profile_notifications" &&
      !def.id.startsWith("notification") &&
      !def.id.startsWith("giphy") &&
      !["user_lists", "user_list"].includes(def.id));
    return {
      nativeId,
      kind: def.id,
      position: index,
      ...(["user_lists", "user_list"].includes(def.id)
        ? {
            listId: id(row.id),
            listType: text(row.type),
            listName: text(row.name),
            usersCount:
              typeof row.usersCount === "number" ? row.usersCount : null,
            postsCount:
              typeof row.postsCount === "number" ? row.postsCount : null,
            isPinnedToChat: bool(row.isPinnedToChat),
            isPinnedToFeed: bool(row.isPinnedToFeed),
            canManageUsers: bool(row.canManageUsers),
            previewUsers: Array.isArray(row.users)
              ? row.users.map((value) => {
                  const u = ofapiReadRecord(value);
                  return {
                    fanId: id(u?.id),
                    name: text(u?.name),
                    username: text(u?.username),
                  };
                })
              : [],
            membershipCoverage: "preview_only",
          }
        : {}),
      ...(["user_list_users", "user_list_pinned_users"].includes(def.id)
        ? {
            listId: pathname?.split("/")[3] ?? null,
            membershipScope:
              def.id === "user_list_pinned_users" ? "pinned_only" : "members",
            membershipObserved: true,
            listStates: Array.isArray(row.listsStates)
              ? row.listsStates.map((value) => {
                  const list = ofapiReadRecord(value);
                  return {
                    listId: id(list?.id),
                    name: text(list?.name),
                    hasUser: bool(list?.hasUser),
                    canAddUser: bool(list?.canAddUser),
                    cannotAddUserReason: text(list?.cannotAddUserReason),
                  };
                })
              : [],
          }
        : {}),
      fanId: profile
        ? id(user.id)
        : (id(ofapiReadRecord(row.author)?.id) ??
          id(ofapiReadRecord(row.user)?.id)),
      username: text(user.username),
      name: text(user.name),
      text: text(row.text) ?? text(row.title),
      occurredAt:
        text(row.postedAt) ??
        text(row.createdAt) ??
        text(row.subscribeDate) ??
        text(row.date),
      subscriptionExpiresAt:
        text(row.subscribedOnExpireDate) ??
        text(subscription?.expiredAt) ??
        text(row.expireDate),
      contactability:
        row.isBlocked === true
          ? "blocked"
          : row.isRestricted === true
            ? "restricted"
            : row.canReceiveChatMessage === true
              ? "contactable"
              : row.canReceiveChatMessage === false
                ? "unavailable"
                : "unknown",
      priorSpendMills: ofapiDollarValueToMillsString(
        row.totalSpent ?? ofapiReadRecord(row.subscribedOnData)?.totalSumm,
      ),
      lastReplyAt: text(row.lastReplyAt),
      media: Array.isArray(row.media)
        ? row.media.map((item) => {
            const m = ofapiReadRecord(item);
            return {
              id: id(m?.id),
              type: text(m?.type),
              canView: bool(m?.canView),
            };
          })
        : [],
      // Inline replies are retained when the vendor includes them. There is no documented GET replies operation.
      replies: Array.isArray(row.replies)
        ? row.replies.map((item) => {
            const r = ofapiReadRecord(item);
            return {
              id: id(r?.id),
              text: text(r?.text),
              authorId: id(ofapiReadRecord(r?.author)?.id),
              postedAt: text(r?.postedAt),
            };
          })
        : [],
      attributes: metricValue("", row),
      metrics: scalarMetrics(metricValue("", row)),
    };
  });
}
