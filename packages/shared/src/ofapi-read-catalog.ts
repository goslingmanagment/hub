import type { OfapiCollectionCategory } from "./ofapi-collection-registry.ts";
export type OfapiReadShape =
  | "list"
  | "users"
  | "items"
  | "array"
  | "object"
  | "strings";
export interface OfapiReadDefinition {
  id: string;
  operation: string;
  path: string;
  category: OfapiCollectionCategory;
  shape: OfapiReadShape;
  pagination: "offset" | "marker" | "from_id" | "date" | "none";
  query: Record<string, string>;
  required?: string[];
  detail: boolean;
  defaultCollect: boolean;
  granularity: "entity" | "ranking" | "window" | "snapshot";
}
const page = { limit: "int:1:50", offset: "int:0:1000000" };
const dates = { start_date: "date", end_date: "date" };
const camelDates = { startDate: "date", endDate: "date" };
const text = "text";
const definitions: Array<Omit<OfapiReadDefinition, "operation">> = [];
function read(
  id: string,
  path: string,
  category: OfapiCollectionCategory,
  shape: OfapiReadShape,
  pagination: OfapiReadDefinition["pagination"],
  query: Record<string, string> = {},
  options: Partial<OfapiReadDefinition> = {},
) {
  definitions.push({
    id,
    path,
    category,
    shape,
    pagination,
    query,
    detail: path.includes(":"),
    defaultCollect: false,
    granularity: "entity",
    ...options,
  });
}
read(
  "profile_visitors",
  "statistics/reach/profile-visitors",
  "visitors",
  "object",
  "none",
  { ...dates, type: "enum:total|users|guests", filter: "enum:chart" },
  { required: ["start_date", "end_date"], granularity: "window" },
);
read(
  "me",
  "me",
  "profile_notifications",
  "object",
  "none",
  {},
  { defaultCollect: true },
);
for (const kind of ["blocked", "restricted"])
  read(
    `users_${kind}`,
    `users/${kind}`,
    "profile_notifications",
    "list",
    "offset",
    { ...page, query: text },
  );
read(
  "fans_expired",
  "fans/expired",
  "profile_notifications",
  "list",
  "offset",
  {
    ...page,
    limit: "int:1:20",
    type: "enum:active|expired|all",
    query: text,
    "filter[online]": "enum:0|1",
    "filter[total_spent]": text,
    "filter[tips]": text,
    "filter[duration]": text,
    "filter[max_total_spent]": "int:0:1000000000",
  },
  { defaultCollect: true },
);
read("fans_latest", "fans/latest", "profile_notifications", "users", "offset", {
  ...page,
  ...dates,
  type: "enum:total|renew|new",
});
read(
  "fans_top",
  "fans/top",
  "profile_notifications",
  "users",
  "none",
  { ...dates, by: "enum:total|subscribes|tips|messages|post|streams" },
  { granularity: "ranking" },
);
read(
  "subscriptions_history",
  "fans/:id/subscriptions-history",
  "profile_notifications",
  "list",
  "none",
);
for (const kind of ["all", "active", "expired"])
  read(
    `following_${kind}`,
    `following/${kind}`,
    "profile_notifications",
    "list",
    "offset",
    {
      ...page,
      query: text,
      "filter[online]": "enum:0|1",
      "filter[paid]": "enum:0|1",
    },
  );
read(
  "notifications",
  "notifications",
  "profile_notifications",
  "list",
  "from_id",
  {
    limit: "int:1:50",
    type: "enum:all|subscriptions|onlyfans|purchases|tips|tags|comments|mentions|likes|promotions",
    from_id: "id",
    skip_users: "enum:all|none",
  },
  { defaultCollect: true },
);
read(
  "notification_counts",
  "notifications/counts",
  "profile_notifications",
  "object",
  "none",
  {},
  { defaultCollect: true, granularity: "snapshot" },
);
read(
  "notification_tabs",
  "notifications/tabs-order",
  "profile_notifications",
  "strings",
  "none",
);
read(
  "notification_search",
  "notifications/search-users",
  "profile_notifications",
  "array",
  "none",
  { query: text },
  { required: ["query"] },
);
read(
  "giphy_trending",
  "giphy/trending",
  "profile_notifications",
  "array",
  "none",
  page,
  { granularity: "ranking" },
);
read(
  "giphy_search",
  "giphy/search",
  "profile_notifications",
  "array",
  "none",
  { ...page, q: text },
  { required: ["q"], granularity: "ranking" },
);
read(
  "posts",
  "posts",
  "posts_comments",
  "list",
  "offset",
  {
    ...page,
    query: text,
    order: "enum:publish_date|favorites_count|tips_summ",
    sort: "enum:asc|desc",
    pinned: "bool",
    counters: "bool",
    minimumPublishDate: "date",
  },
  { defaultCollect: true },
);
read("post_labels", "posts/labels", "posts_comments", "list", "offset", page, {
  defaultCollect: true,
});
read("post", "posts/:id", "posts_comments", "object", "none");
read(
  "post_stats",
  "posts/:id/stats",
  "posts_comments",
  "object",
  "none",
  { with_historical_data: "bool" },
  { granularity: "snapshot" },
);
read(
  "post_comments",
  "posts/:id/comments",
  "posts_comments",
  "list",
  "offset",
  { ...page, sort: "enum:asc|desc" },
);
read(
  "stories",
  "stories",
  "content_history",
  "array",
  "none",
  {},
  { defaultCollect: true },
);
read(
  "stories_archive",
  "stories/archive",
  "content_history",
  "list",
  "marker",
  { limit: "int:1:50", marker: text },
  { defaultCollect: true },
);
read(
  "highlights",
  "stories/highlights",
  "content_history",
  "list",
  "offset",
  page,
  { defaultCollect: true },
);
read(
  "highlight",
  "stories/highlights/:id",
  "content_history",
  "object",
  "none",
);
read("story", "stories/:id", "content_history", "object", "none");
read(
  "story_stats",
  "stories/:id/stats",
  "content_history",
  "object",
  "none",
  {},
  { granularity: "snapshot" },
);
read(
  "story_viewers",
  "stories/:id/viewers",
  "content_history",
  "list",
  "offset",
  page,
);
read(
  "mass_queue",
  "mass-messaging",
  "content_history",
  "array",
  "none",
  {},
  { defaultCollect: true },
);
read(
  "mass_overview",
  "mass-messaging/overview",
  "content_history",
  "items",
  "date",
  { ...camelDates, limit: "int:1:50", query: text },
);
read("mass_item", "mass-messaging/:id", "content_history", "object", "none");
for (const [id, path] of [
  ["mass", "mass-messages"],
  ["direct", "direct-messages"],
]) {
  read(
    `engagement_${id}`,
    `engagement/messages/${path}`,
    "content_history",
    "items",
    id === "mass" ? "date" : "offset",
    { ...camelDates, ...page, query: text },
  );
  read(
    `engagement_${id}_chart`,
    `engagement/messages/${path}/chart`,
    "content_history",
    "object",
    "none",
    { ...camelDates, withTotal: "bool" },
    { granularity: "window" },
  );
}
read(
  "engagement_top",
  "engagement/messages/top-message",
  "content_history",
  "object",
  "none",
  camelDates,
  { granularity: "ranking" },
);
read(
  "message_buyers",
  "engagement/messages/:id/buyers",
  "content_history",
  "list",
  "offset",
  { ...page, skip_users_dups: "enum:0|1", skip_users: text },
);
read(
  "payout_balances",
  "payouts/balances",
  "balances",
  "object",
  "none",
  {},
  { defaultCollect: true, granularity: "snapshot" },
);
read(
  "payout_requests",
  "payouts/payout-requests",
  "balances",
  "list",
  "offset",
  page,
);
read(
  "payout_earnings",
  "payouts/earning-statistics",
  "balances",
  "list",
  "none",
  camelDates,
  { granularity: "window" },
);
read(
  "statistics_overview",
  "statistics/overview",
  "balances",
  "object",
  "none",
  { ...dates, type: "enum:fans|visitors|posts|messages" },
  { defaultCollect: true, granularity: "window" },
);
read(
  "subscriber_statistics",
  "subscribers/statistics",
  "balances",
  "object",
  "none",
  { ...dates, type: "enum:total|renew|new" },
  { defaultCollect: true, granularity: "window" },
);
// S6/S7 reference reads are explicit, paid lookups; no background default.
const releaseFormQuery = { ...page, filter: "enum:all|pending", sort: "enum:date|name", sortDirection: "enum:desc|asc", name: text };
read("release_forms", "release-forms", "vault_catalog", "items", "offset", releaseFormQuery);
read("taggable_users", "release-forms/taggable-users", "vault_catalog", "items", "offset", releaseFormQuery);
read("giphy_trending", "giphy/trending", "profile_notifications", "array", "offset", page);
read("giphy_search", "giphy/search", "profile_notifications", "array", "offset", { ...page, q: text }, { required: ["q"] });
/** A closed GET catalog. No arbitrary vendor path or persistent following sort is accepted. */
export const OFAPI_READ_CATALOG: readonly OfapiReadDefinition[] =
  definitions.map((row) => ({ ...row, operation: `ofapi_read_${row.id}` }));
export function findOfapiReadDefinition(operation: string) {
  return OFAPI_READ_CATALOG.find((row) => row.operation === operation);
}
export function validateOfapiReadQuery(
  def: OfapiReadDefinition,
  raw: Record<string, unknown>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (
      (typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean") ||
      !def.query[name]
    )
      throw new Error(`Unsupported query ${name}`);
    const v = String(value),
      rule = def.query[name]!;
    if (rule.startsWith("int:")) {
      const [, min, max] = rule.split(":");
      if (
        !/^\d+$/.test(v) ||
        !Number.isSafeInteger(Number(v)) ||
        Number(v) < Number(min) ||
        Number(v) > Number(max)
      )
        throw new Error(`Invalid integer ${name}`);
    }
    if (rule.startsWith("enum:") && !rule.slice(5).split("|").includes(v))
      throw new Error(`Invalid value ${name}`);
    if (rule === "bool" && !["true", "false", "1", "0"].includes(v))
      throw new Error(`Invalid boolean ${name}`);
    if (
      rule === "date" &&
      (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(v) || !Number.isFinite(Date.parse(v)))
    )
      throw new Error(`Invalid date ${name}`);
    if (rule === "id" && !/^\d+$/.test(v))
      throw new Error(`Invalid id ${name}`);
    if (v.length < 1 || v.length > 500)
      throw new Error(`Invalid length ${name}`);
    result[name] = v;
  }
  for (const key of def.required ?? [])
    if (!result[key]) throw new Error(`Missing ${key}`);
  for (const [start, end] of [
    ["start_date", "end_date"],
    ["startDate", "endDate"],
  ])
    if (
      Boolean(result[start!]) !== Boolean(result[end!]) ||
      (result[start!] &&
        Date.parse(result[start!]!) >= Date.parse(result[end!]!))
    )
      throw new Error("Invalid paired date window");
  if (result["filter[max_total_spent]"] && result["filter[online]"])
    throw new Error("Spend index and online filters cannot be combined");
  return result;
}
export function resolveOfapiCatalogPath(
  path: string,
  raw: Record<string, unknown>,
) {
  const segments = path.replace(/^\/+|\/+$/g, "").split("/");
  const accountId = segments.shift();
  if (!accountId || !/^acct_[A-Za-z0-9]+$/.test(accountId)) return null;
  // Literal paths win over ids (archive/highlights/overview/labels).
  for (const def of [...OFAPI_READ_CATALOG].sort(
    (a, b) => Number(a.detail) - Number(b.detail),
  )) {
    const pieces = def.path.split("/");
    if (
      pieces.length !== segments.length ||
      !pieces.every((v, i) =>
        v === ":id" ? /^\d+$/.test(segments[i]!) : v === segments[i],
      )
    )
      continue;
    return {
      definition: def,
      accountId,
      pathname: `/${accountId}/${segments.join("/")}`,
      query: validateOfapiReadQuery(def, raw),
    };
  }
  return null;
}
