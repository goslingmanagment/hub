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

/**
 * The closed filter-operator vocabulary. The route schema and the kind-aware
 * validator below both derive from this value so an operator cannot be accepted
 * on the wire but forgotten by the semantic boundary (or vice versa).
 */
export const AGENT_DATASET_FILTER_OPS = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "is_null",
  "is_not_null",
] as const;

export type AgentDatasetFilterOperator = (typeof AGENT_DATASET_FILTER_OPS)[number];

/** Shared by the window contract and timestamp filter validation. */
export const AGENT_RFC3339_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

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
  /**
   * Money-bearing datasets additionally require the `read:money` capability.
   *
   * A dataset carrying ANY field of kind `mills` is money-bearing by definition
   * — pinned by test, because the appendix declared one such dataset otherwise
   * and that quietly put a fan's lifetime spend behind a read:datasets-only key.
   */
  readonly moneyBearing: boolean;
  /**
   * Datasets carrying operator- or fan-written FREE TEXT additionally require
   * `read:messages`.
   *
   * `fan_notes` selects the note body verbatim, which is the same disclosure
   * class as a transcript — and the person operation puts exactly that material
   * behind `read:messages`. Without this flag a `read:datasets`-only key read the
   * notes through the dataset route instead, so the capability was a door with a
   * window next to it. Declared here rather than as a list at the handler, and
   * pinned by test against the field map, so a future dataset that adds a text
   * body cannot inherit the narrower requirement.
   */
  readonly verbatimText: boolean;
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
    // MONEY-BEARING because of `lifetimeSpendMills`. The appendix's prose names
    // only subscriptions/transactions/fan_spend_daily as money-bearing while its
    // own catalog puts a mills field on THIS dataset; the two statements
    // contradict each other, and following the narrower one would hand a
    // read:datasets-only key a fan's lifetime spend without read:money.
    moneyBearing: true,
    verbatimText: false,
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
    verbatimText: false,
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
    verbatimText: false,
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
    verbatimText: false,
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
    verbatimText: false,
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
    verbatimText: false,
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
    verbatimText: false,
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
    verbatimText: false,
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
    verbatimText: true,
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
  posts: {
    moneyBearing: false,
    // Creator-written post copy is verbatim material. This deliberately reuses
    // the transcript disclosure class: a read:datasets-only key must not gain a
    // side door to content text.
    verbatimText: true,
    fields: {
      platform: "string",
      postRef: "string",
      postText: "string",
      publishedAt: "timestamp",
      firstObservedAt: "timestamp",
      lastObservedAt: "timestamp",
      attachmentCount: "int",
    },
    defaultSort: { field: "publishedAt", dir: "desc", nullsLast: false },
    stableKey: ["postId"],
  },
  sync_streams: {
    moneyBearing: false,
    verbatimText: false,
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

type AgentDatasetFilterKindRule = {
  /** Value-bearing operators; the two null predicates are valid for every kind. */
  readonly operators: readonly AgentDatasetFilterOperator[];
  readonly acceptsValue: (operator: AgentDatasetFilterOperator, value: unknown) => boolean;
};

const EQUALITY_AND_ORDER_OPERATORS = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
] as const satisfies readonly AgentDatasetFilterOperator[];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const instant = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

function isRfc3339Timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !AGENT_RFC3339_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  // Date.parse catches impossible dates/times that the deliberately readable
  // wire regex cannot (for example 2026-02-30 or an hour of 29).
  return isCalendarDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

/**
 * The semantic filter boundary, keyed by the registry's declared field kind.
 *
 * This is intentionally a small matrix, not a generic query language. Numeric
 * kinds require safe integers (money remains mills); booleans admit equality
 * only; timestamps/dates must be real wire values; and `in` stays limited to
 * textual values because the public scalar union has only `string[]` arrays.
 */
const FILTER_RULE_BY_KIND = {
  string: {
    operators: [...EQUALITY_AND_ORDER_OPERATORS, "in"],
    acceptsValue: (operator, value) => operator === "in"
      ? isStringArray(value)
      : typeof value === "string",
  },
  int: {
    operators: EQUALITY_AND_ORDER_OPERATORS,
    acceptsValue: (_operator, value) => typeof value === "number" && Number.isSafeInteger(value),
  },
  mills: {
    operators: EQUALITY_AND_ORDER_OPERATORS,
    acceptsValue: (_operator, value) => typeof value === "number" && Number.isSafeInteger(value),
  },
  bool: {
    operators: ["eq", "neq"],
    acceptsValue: (_operator, value) => typeof value === "boolean",
  },
  timestamp: {
    operators: EQUALITY_AND_ORDER_OPERATORS,
    acceptsValue: (_operator, value) => isRfc3339Timestamp(value),
  },
  date: {
    operators: [...EQUALITY_AND_ORDER_OPERATORS, "in"],
    acceptsValue: (operator, value) => operator === "in"
      ? isStringArray(value) && value.every(isCalendarDate)
      : isCalendarDate(value),
  },
  // There is no string-array field today and no array operator with honest SQL
  // semantics in v1. Null checks remain available without guessing one.
  string_array: {
    operators: [],
    acceptsValue: () => false,
  },
} as const satisfies Record<AgentDatasetFieldKind, AgentDatasetFilterKindRule>;

export type AgentDatasetFilterIssue =
  | { readonly code: "unknown_field" }
  | {
    readonly code: "operator_not_supported" | "value_type_mismatch";
    readonly kind: AgentDatasetFieldKind;
  };

/**
 * Validates a dataset filter after the path/body schemas but before SQL mapping.
 * The issue contains no caller value, so a 400 can be logged or returned without
 * echoing potentially sensitive filter material.
 */
export function agentDatasetFilterIssue(
  dataset: string,
  input: {
    readonly field: string;
    readonly op: AgentDatasetFilterOperator;
    readonly value?: unknown;
  },
): AgentDatasetFilterIssue | null {
  const definition = agentDatasetDefinition(dataset);
  const fields = definition?.fields as Record<string, AgentDatasetFieldKind> | undefined;
  const kind = fields !== undefined && Object.hasOwn(fields, input.field)
    ? fields[input.field]
    : undefined;
  if (kind === undefined) {
    return { code: "unknown_field" };
  }

  const carriesNoValue = input.op === "is_null" || input.op === "is_not_null";
  if (carriesNoValue) {
    return input.value === undefined ? null : { code: "value_type_mismatch", kind };
  }

  const rule: AgentDatasetFilterKindRule = FILTER_RULE_BY_KIND[kind];
  if (!rule.operators.includes(input.op)) {
    return { code: "operator_not_supported", kind };
  }
  return rule.acceptsValue(input.op, input.value)
    ? null
    : { code: "value_type_mismatch", kind };
}

/**
 * The capabilities a key must hold to query this dataset: `read:datasets` always,
 * plus `read:money` for a money-bearing one and `read:messages` for one that
 * serves free text. Derived from the declaration, so a dataset that gains a money
 * field or a text body cannot keep the narrower requirement.
 */
export function agentDatasetRequiredCapabilities(
  dataset: AgentDataset,
): readonly AgentCapability[] {
  const definition = AGENT_DATASETS[dataset];
  const capabilities: AgentCapability[] = ["read:datasets"];
  if (definition.moneyBearing) {
    capabilities.push("read:money");
  }
  if (definition.verbatimText) {
    capabilities.push("read:messages");
  }
  return capabilities;
}

/**
 * The naming convention the pin test enforces: a wire field whose name ends in
 * `Text` carries free-form content someone wrote.
 *
 * A convention rather than a per-field flag because the scalar KIND cannot tell
 * `noteText` from `username` — both are `string` — and the thing that must not
 * drift is "does this dataset hand over prose", which the field name already says.
 */
export function agentDatasetFieldIsVerbatimText(field: string): boolean {
  return /Text$/.test(field);
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
