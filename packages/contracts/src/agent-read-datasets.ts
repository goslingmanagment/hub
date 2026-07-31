/**
 * Agent Read Plane — the dataset vocabulary.
 *
 * WHY THIS FILE EXISTS: the dataset name in `POST /agent/pages/:pageLabel/
 * datasets/:dataset/query` is the one open-looking segment of the whole plane, and
 * the registry is the ONLY bridge from that name to code. A string never becomes a
 * table or column name at runtime: the name resolves here, and a field outside the
 * dataset's allowlist is a static 400 BEFORE any SQL. Declaring the vocabulary once
 * (here) and deriving the enums, the catalog response and the filter allowlists from
 * it is the same anti-drift law the claim/plane registry states in its own header.
 *
 * SCOPE: names, field maps, scalar kinds, deterministic sort keys. The SQL mapping
 * (dataset -> table, field -> expression) lands in slice A together with the
 * operation, WITH a mandatory two-way test: every available dataset's declared
 * fields are exactly covered by the runtime mapping, and vice versa. `platforms`
 * and `captureState` — the two remaining catalog-response columns — are runtime
 * facts about a deployment rather than vocabulary, and join in the same slice.
 *
 * Source: the contract appendix §17 dataset catalog (names, fields, default sorts,
 * stable keys and the money-bearing set are copied from it verbatim; the scalar
 * kinds are the appendix's own closed union). Architecture reference:
 * `investigations/agent-read-api-design-2026-07-31.md` §10.
 */

import { type AgentCapability } from "./agent-read-capabilities.ts";

/**
 * The closed scalar union a dataset row may carry. There is no nested structure
 * and no free JSON: `components.schemas` is empty in the generated OpenAPI (every
 * schema inlines), so a recursive JSON value expands forever. A dataset that needs
 * structure needs a real operation instead.
 */
export const AGENT_DATASET_FIELD_KINDS = [
  "string",
  "int",
  /** Integer mills (1 mill = $0.001) — never a float, never dollars. */
  "mills",
  "bool",
  "timestamp",
  "date",
  "string_array",
] as const;

export type AgentDatasetFieldKind = (typeof AGENT_DATASET_FIELD_KINDS)[number];

/** Kinds that admit a deterministic ORDER BY. See `agentDatasetFieldSortable`. */
const ORDERED_FIELD_KINDS: ReadonlySet<AgentDatasetFieldKind> = new Set<AgentDatasetFieldKind>([
  "int",
  "mills",
  "timestamp",
  "date",
]);

export type AgentDatasetSort = {
  readonly field: string;
  readonly dir: "asc" | "desc";
  /** NULLS LAST on a nullable sort column, so a row with no value never leads. */
  readonly nullsLast: boolean;
};

export type AgentDatasetDefinition = {
  /** Money-bearing datasets additionally require the `read:money` capability. */
  readonly moneyBearing: boolean;
  /** Wire field -> scalar kind. This map IS the filter/sort allowlist. */
  readonly fields: Readonly<Record<string, AgentDatasetFieldKind>>;
  readonly defaultSort: AgentDatasetSort;
  /**
   * Physical row identifier(s) completing the keyset cursor `{sortValue,
   * stableKey}`. These are NOT wire fields and are never returned or filtered on;
   * they exist so pagination is total-ordered even when the sort column ties.
   * Resolved to real columns by the slice-A mapping.
   */
  readonly stableKey: readonly string[];
};

/**
 * Datasets addressable TODAY. The path enum is built from exactly these keys, so a
 * planned dataset is caught by Zod at the boundary as a static 400 — visible in the
 * catalog, not addressable in the query.
 */
export const AGENT_DATASETS = {
  fan_memberships: {
    moneyBearing: false,
    fields: {
      platform: "string",
      platformUserId: "string",
      username: "string",
      displayName: "string",
      membershipState: "string",
      firstSeenAt: "timestamp",
      lastSeenAt: "timestamp",
      lifetimeSpendMills: "mills",
    },
    defaultSort: { field: "lastSeenAt", dir: "desc", nullsLast: false },
    stableKey: ["fanId"],
  },
  dm_threads: {
    moneyBearing: false,
    fields: {
      platform: "string",
      platformUserId: "string",
      conversationRef: "string",
      lastMessageAt: "timestamp",
      messageCount: "int",
      unreadCount: "int",
      coverageStatus: "string",
    },
    defaultSort: { field: "lastMessageAt", dir: "desc", nullsLast: true },
    stableKey: ["threadId"],
  },
  subscriptions: {
    moneyBearing: true,
    fields: {
      platform: "string",
      platformUserId: "string",
      subscriptionRef: "string",
      subscriptionState: "string",
      startedAt: "timestamp",
      expiresAt: "timestamp",
      priceMills: "mills",
      currency: "string",
    },
    defaultSort: { field: "expiresAt", dir: "desc", nullsLast: true },
    stableKey: ["subscriptionId"],
  },
  transactions: {
    moneyBearing: true,
    fields: {
      platform: "string",
      platformUserId: "string",
      transactionRef: "string",
      transactionType: "string",
      transactionState: "string",
      occurredAt: "timestamp",
      grossMills: "mills",
      netMills: "mills",
      feeMills: "mills",
      currency: "string",
      relatedMessageRef: "string",
    },
    defaultSort: { field: "occurredAt", dir: "desc", nullsLast: false },
    stableKey: ["transactionId"],
  },
  fan_spend_daily: {
    moneyBearing: true,
    fields: {
      platform: "string",
      platformUserId: "string",
      businessDate: "date",
      grossMills: "mills",
      netMills: "mills",
      transactionCount: "int",
      currency: "string",
    },
    defaultSort: { field: "businessDate", dir: "desc", nullsLast: false },
    stableKey: ["fanId", "canonicalType", "transactionState"],
  },
  follows: {
    moneyBearing: false,
    fields: {
      platform: "string",
      platformUserId: "string",
      followed: "bool",
      followedAt: "timestamp",
      unfollowedAt: "timestamp",
    },
    defaultSort: { field: "followedAt", dir: "desc", nullsLast: true },
    stableKey: ["followId"],
  },
  followers_daily: {
    moneyBearing: false,
    fields: {
      platform: "string",
      businessDate: "date",
      followersCount: "int",
    },
    defaultSort: { field: "businessDate", dir: "desc", nullsLast: false },
    stableKey: ["pageId"],
  },
  fan_aliases: {
    moneyBearing: false,
    fields: {
      platform: "string",
      platformUserId: "string",
      aliasKind: "string",
      aliasValue: "string",
      firstSeenAt: "timestamp",
      lastSeenAt: "timestamp",
    },
    defaultSort: { field: "lastSeenAt", dir: "desc", nullsLast: true },
    stableKey: ["aliasId"],
  },
  fan_notes: {
    moneyBearing: false,
    fields: {
      platform: "string",
      platformUserId: "string",
      noteRef: "string",
      noteText: "string",
      createdAt: "timestamp",
      updatedAt: "timestamp",
    },
    defaultSort: { field: "createdAt", dir: "desc", nullsLast: false },
    stableKey: ["noteId"],
  },
  sync_streams: {
    moneyBearing: false,
    fields: {
      stream: "string",
      syncStatus: "string",
      cursorAt: "timestamp",
      succeededAt: "timestamp",
      failedAt: "timestamp",
      consecutiveFailures: "int",
    },
    defaultSort: { field: "stream", dir: "asc", nullsLast: false },
    stableKey: ["pageId", "stream"],
  },
} as const satisfies Record<string, AgentDatasetDefinition>;

export type AgentDataset = keyof typeof AGENT_DATASETS;

/**
 * Datasets the catalog must NAME rather than hide. The plane's whole premise is
 * that an absent answer is distinguishable from an absent capability, so a hole in
 * the data is declared, not omitted.
 *
 * `purchase_history` and `fan_earnings` were DEMOTED from available while the
 * contract was being written: `purchase_history` is a sync-stream name with no
 * serving table at all (its canonicalization produces `message.ppv_unlocked`, which
 * projects into nothing and lives only in `domain_events`, which the read plane may
 * not read), and `fan_earnings_stats` exists in the database (migration 0061) but
 * not in the Drizzle schema and is read only by raw SQL.
 */
export const AGENT_PLANNED_DATASETS = {
  purchase_history: {},
  fan_earnings: {},
  posts: {},
  vault_media: {},
  stories: {},
  notifications: {},
  fan_lists: {},
  subscription_tiers: {},
  livestreams: {},
  campaigns: {},
  comments: {},
  likes: {},
  polls: {},
  payouts: {},
  chargebacks: {},
  blocks: {},
} as const;

export type AgentPlannedDataset = keyof typeof AGENT_PLANNED_DATASETS;

/** Derived. Anything that needs "which datasets are addressable" reads THIS. */
export const AGENT_DATASET_NAMES = Object.keys(AGENT_DATASETS) as readonly AgentDataset[];

/** Derived. The catalog lists these with `availability: "planned"`. */
export const AGENT_PLANNED_DATASET_NAMES = Object.keys(
  AGENT_PLANNED_DATASETS,
) as readonly AgentPlannedDataset[];

/**
 * Boundary lookup for an UNVALIDATED dataset name (it arrives in a path).
 *
 * Backed by a Map, not by object indexing: a plain object would answer
 * `"constructor"` or `"toString"` with an inherited function, and a truthy answer
 * to a prototype key is exactly how an allowlist stops being one.
 */
const DEFINITION_BY_NAME: ReadonlyMap<string, AgentDatasetDefinition> = new Map(
  Object.entries(AGENT_DATASETS as Record<string, AgentDatasetDefinition>),
);

export function agentDatasetDefinition(dataset: string): AgentDatasetDefinition | undefined {
  return DEFINITION_BY_NAME.get(dataset);
}

/**
 * The capabilities a key must hold to query this dataset: `read:datasets` always,
 * plus `read:money` for a money-bearing one. Derived from the declaration so a
 * dataset that turns money-bearing cannot keep the narrower requirement.
 */
export function agentDatasetRequiredCapabilities(
  dataset: AgentDataset,
): readonly AgentCapability[] {
  return AGENT_DATASETS[dataset].moneyBearing
    ? ["read:datasets", "read:money"]
    : ["read:datasets"];
}

/** Every declared field of a dataset is filterable — the map IS the allowlist. */
export function agentDatasetFieldFilterable(): boolean {
  return true;
}

/**
 * Sortable = the kind admits a deterministic order (numbers, money, instants,
 * dates), OR the field is this dataset's default sort. Free text and booleans are
 * deliberately excluded: sorting a page of transcripts by note text buys nothing
 * and costs an unindexable ORDER BY.
 */
export function agentDatasetFieldSortable(dataset: AgentDataset, field: string): boolean {
  const definition: AgentDatasetDefinition = AGENT_DATASETS[dataset];
  const fields = definition.fields as Record<string, AgentDatasetFieldKind>;
  // `Object.hasOwn` for the same reason the lookup above uses a Map: a prototype
  // key must not resolve to a real field.
  if (!Object.hasOwn(fields, field)) {
    return false;
  }
  const kind = fields[field];
  if (kind === undefined) {
    return false;
  }
  return ORDERED_FIELD_KINDS.has(kind) || definition.defaultSort.field === field;
}

export type AgentDatasetFieldView = {
  readonly field: string;
  readonly kind: AgentDatasetFieldKind;
  readonly filterable: boolean;
  readonly sortable: boolean;
};

/** The catalog view of a dataset's fields, in declaration order. */
export function agentDatasetFields(dataset: AgentDataset): readonly AgentDatasetFieldView[] {
  const definition = AGENT_DATASETS[dataset];
  return Object.entries(definition.fields as Record<string, AgentDatasetFieldKind>).map(
    ([field, kind]) => ({
      field,
      kind,
      filterable: agentDatasetFieldFilterable(),
      sortable: agentDatasetFieldSortable(dataset, field),
    }),
  );
}
