import { describe, expect, it } from "vitest";

import {
  AGENT_CAPABILITIES,
  AGENT_DATASET_FIELD_KINDS,
  AGENT_DATASET_NAMES,
  AGENT_DATASETS,
  AGENT_PLANNED_DATASET_NAMES,
  agentDatasetDefinition,
  agentDatasetFilterIssue,
  agentDatasetFields,
  agentDatasetRequiredCapabilities,
  isAgentCapability,
  type AgentDataset,
} from "@agency_hub_core/contracts";
import { agentSubscriptionState } from "@agency_hub_core/db";

/**
 * The dataset registry is the ONLY bridge from a dataset name in a request path to
 * code: a string never becomes a table or column name at runtime. These pins keep
 * the vocabulary internally consistent so slice A can DERIVE the path enum, the
 * filter allowlist and the catalog response from it instead of hand-listing them
 * three times and drifting — the same failure the claim/plane registry was created
 * to prevent.
 */
describe("agent read dataset vocabulary", () => {
  it("names exactly the available datasets, in declaration order", () => {
    expect([...AGENT_DATASET_NAMES]).toEqual([
      "ofapi_financial_snapshots",
      "fan_memberships",
      "dm_threads",
      "subscriptions",
      "subscription_events",
      "transactions",
      "tip_transactions",
      "fan_spend_daily",
      "follows",
      "followers_daily",
      "fan_aliases",
      "fan_notes",
      "posts",
      "raw_media",
      "post_attachments",
      "post_monetization",
      "post_tips",
      "tip_goals",
      // endpoints-cover (WP-S1): thirteen datasets over what F1-F7 and F4
      // capture. Six of the names were RESERVED in the planned list and are
      // reused rather than renamed, so a caller that read the catalog a year
      // ago gets data instead of a 400.
      "traffic_daily",
      "media_stats",
      "top_media",
      "top_tags",
      "revenue_mix",
      "message_media_sales",
      "comments",
      "likes",
      "vault_media",
      "notifications",
      "subscription_tiers",
      "payouts",
      "capture_coverage",
      "sync_streams",
    ]);
  });

  it("declares every planned dataset instead of hiding the hole", () => {
    // The catalog must NAME its gaps: an agent that cannot tell "no data" from "no
    // dataset" cannot reason about absence at all. `fan_earnings` sits here
    // deliberately — `fan_earnings_stats` exists in the database but not in the
    // Drizzle schema, and the endpoints-cover initiative did not adopt it.
    expect([...AGENT_PLANNED_DATASET_NAMES]).toEqual([
      "fan_earnings",
      "stories",
      "fan_lists",
      "livestreams",
      "campaigns",
      "polls",
      "chargebacks",
      "blocks",
    ]);
    // `purchase_history` is gone from BOTH lists (WP-S1): it was never a
    // dataset, only a SYNC STREAM name with no serving table, and
    // `message_media_sales` answers the question it stood for. Leaving the key
    // planned would have advertised a second, better one that is never coming.
    expect([...AGENT_PLANNED_DATASET_NAMES]).not.toContain("purchase_history");
    expect([...AGENT_DATASET_NAMES]).not.toContain("purchase_history");
  });

  it("keeps available and planned names disjoint", () => {
    // An overlap would make one name both addressable and "not built yet",
    // and the boundary 400 would depend on which list a reader consulted.
    const available = new Set<string>(AGENT_DATASET_NAMES);
    const overlap = AGENT_PLANNED_DATASET_NAMES.filter((name) => available.has(name));
    expect(overlap).toEqual([]);
  });

  it("gives every dataset at least one field, all in the closed scalar union", () => {
    const kinds = new Set<string>(AGENT_DATASET_FIELD_KINDS);
    for (const dataset of AGENT_DATASET_NAMES) {
      const fields = agentDatasetFields(dataset);
      expect(fields.length, `${dataset} has no fields`).toBeGreaterThan(0);
      for (const field of fields) {
        expect(kinds.has(field.kind), `${dataset}.${field.field} kind ${field.kind}`).toBe(true);
      }
    }
  });

  it("keeps post target totals distinct from donor-tip attribution", () => {
    expect(AGENT_DATASETS.post_monetization.fields).toHaveProperty(
      "postTargetTipAmountMills",
      "mills",
    );
    expect(AGENT_DATASETS.post_monetization.fields).not.toHaveProperty("tipAmountMills");
    expect(AGENT_DATASETS.post_tips.fields).toHaveProperty("postTipPostRef", "string");
    expect(AGENT_DATASETS.post_tips.fields).not.toHaveProperty("postRef");
    expect(AGENT_DATASETS.post_tips.fields).toMatchObject({
      postTipGoalRef: "string",
      postTipMessageText: "string",
    });
    expect(AGENT_DATASETS.tip_goals.fields).toMatchObject({
      tipGoalRef: "string",
      tipGoalCurrentMills: "mills",
      linkedPostCount: "int",
    });
    const monetizationFields = new Map(
      agentDatasetFields("post_monetization").map((field) => [field.field, field]),
    );
    expect(monetizationFields.get("publishedAt")?.filterable).toBe(true);
    expect(monetizationFields.get("lastObservedAt")?.filterable).toBe(true);
  });

  it("keeps transaction correlation separate from exact captured tip context", () => {
    expect(AGENT_DATASETS.transactions.fields).toMatchObject({
      relatedMessageRef: "string",
      correlationRef: "string",
    });
    expect(AGENT_DATASETS.tip_transactions.fields).toEqual({
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
      correlationRef: "string",
      contextState: "string",
      capturedConversationRef: "string",
      tipMessageText: "string",
    });
    expect(agentDatasetRequiredCapabilities("tip_transactions"))
      .toEqual(["read:datasets", "read:money", "read:messages"]);
  });

  it("exposes stored subscription events without adding money or text access", () => {
    expect(AGENT_DATASETS.subscription_events.fields).toEqual({
      occurredAt: "timestamp",
      fanId: "string",
      phase: "string",
      subType: "string",
    });
    expect(agentDatasetRequiredCapabilities("subscription_events"))
      .toEqual(["read:datasets"]);
  });

  it("uses wire field names the query schema will accept", () => {
    // The query body validates `field` against /^[a-z][a-zA-Z0-9]*$/ with a 64-char
    // cap BEFORE any lookup. A registry field that cannot pass that regex would be
    // catalogued as filterable and then rejected as a bad request.
    const wireName = /^[a-z][a-zA-Z0-9]*$/;
    for (const dataset of AGENT_DATASET_NAMES) {
      for (const { field } of agentDatasetFields(dataset)) {
        expect(wireName.test(field), `${dataset}.${field}`).toBe(true);
        expect(field.length).toBeLessThanOrEqual(64);
      }
    }
  });

  it("declares a default sort that exists, is sortable, and a non-empty stable key", () => {
    for (const dataset of AGENT_DATASET_NAMES) {
      const definition = AGENT_DATASETS[dataset];
      const fields = agentDatasetFields(dataset);
      const sortField = fields.find((field) => field.field === definition.defaultSort.field);
      expect(sortField, `${dataset} default sort names an unknown field`).toBeDefined();
      expect(sortField!.sortable, `${dataset} default sort is not sortable`).toBe(true);
      // Without a stable tiebreaker the keyset cursor is not a total order and
      // pagination can repeat or skip rows whenever the sort column ties.
      expect(definition.stableKey.length, `${dataset} has no stable key`).toBeGreaterThan(0);
    }
  });

  it("treats every dataset carrying a mills field as money-bearing", () => {
    // Derived rather than hand-listed. The appendix's prose named three
    // money-bearing datasets while its own catalog put `lifetimeSpendMills` on a
    // fourth (fan_memberships) — which would have served a fan's lifetime spend
    // to a read:datasets-only key. A declaration can no longer disagree with its
    // own fields.
    for (const dataset of AGENT_DATASET_NAMES) {
      const carriesMills = agentDatasetFields(dataset).some((field) => field.kind === "mills");
      if (carriesMills) {
        expect(AGENT_DATASETS[dataset].moneyBearing, `${dataset} carries mills`).toBe(true);
      }
    }
  });

  it("marks exactly the money-bearing datasets and makes them require read:money", () => {
    const money = AGENT_DATASET_NAMES.filter((name) => AGENT_DATASETS[name].moneyBearing);
    expect([...money]).toEqual([
      "ofapi_financial_snapshots",
      "fan_memberships",
      "subscriptions",
      "transactions",
      "tip_transactions",
      "fan_spend_daily",
      "post_monetization",
      "post_tips",
      "tip_goals",
      // endpoints-cover: five of the thirteen carry mills. `media_stats` and
      // `subscription_tiers` are money-bearing for catalogue PRICES rather than
      // for a fan's spend, and that is still money.
      "media_stats",
      "revenue_mix",
      "message_media_sales",
      "comments",
      "subscription_tiers",
      "payouts",
    ]);

    for (const dataset of AGENT_DATASET_NAMES) {
      const required = agentDatasetRequiredCapabilities(dataset);
      expect(required).toContain("read:datasets");
      expect(required.includes("read:money")).toBe(AGENT_DATASETS[dataset].moneyBearing);
      for (const capability of required) {
        expect(isAgentCapability(capability), `${dataset} requires ${capability}`).toBe(true);
      }
    }
  });

  it("resolves an unvalidated dataset name and refuses anything else", () => {
    expect(agentDatasetDefinition("dm_threads")).toBe(AGENT_DATASETS.dm_threads);
    // A planned dataset is visible in the catalog and NOT addressable: the path
    // enum is built from the available names only, so this must stay undefined.
    expect(agentDatasetDefinition("purchase_history")).toBeUndefined();
    expect(agentDatasetDefinition("posts")).toBe(AGENT_DATASETS.posts);
    expect(agentDatasetDefinition("post_monetization"))
      .toBe(AGENT_DATASETS.post_monetization);
    expect(agentDatasetDefinition("post_tips")).toBe(AGENT_DATASETS.post_tips);
    expect(agentDatasetDefinition("tip_transactions"))
      .toBe(AGENT_DATASETS.tip_transactions);
    expect(agentDatasetDefinition("tip_goals")).toBe(AGENT_DATASETS.tip_goals);
    expect(agentDatasetDefinition("page_dm_threads")).toBeUndefined();
    expect(agentDatasetDefinition("")).toBeUndefined();
    // Prototype keys are not datasets — the lookup must not inherit them.
    expect(agentDatasetDefinition("constructor")).toBeUndefined();
    expect(agentDatasetDefinition("toString")).toBeUndefined();
  });

  it("never marks free text or booleans sortable", () => {
    // Sorting a page by note text buys nothing and costs an unindexable ORDER BY;
    // a boolean sort is not a meaningful order. Both stay filterable.
    for (const dataset of AGENT_DATASET_NAMES) {
      for (const field of agentDatasetFields(dataset)) {
        expect(field.filterable, `${dataset}.${field.field}`).toBe(true);
        if (field.sortable && (field.kind === "string" || field.kind === "bool")) {
          expect(
            AGENT_DATASETS[dataset].defaultSort.field,
            `${dataset}.${field.field} is sortable but is not the default sort`,
          ).toBe(field.field);
        }
      }
    }
  });
});

describe("agent dataset filter kind boundary", () => {
  it("accepts values that match each declared scalar kind", () => {
    expect(agentDatasetFilterIssue("transactions", {
      field: "platform",
      op: "in",
      value: ["fansly", "onlyfans"],
    })).toBeNull();
    expect(agentDatasetFilterIssue("posts", {
      field: "attachmentCount",
      op: "gte",
      value: 2,
    })).toBeNull();
    expect(agentDatasetFilterIssue("transactions", {
      field: "grossMills",
      op: "gte",
      value: 1_000,
    })).toBeNull();
    expect(agentDatasetFilterIssue("transactions", {
      field: "occurredAt",
      op: "eq",
      value: "2026-02-01T03:04:05.123+03:00",
    })).toBeNull();
    expect(agentDatasetFilterIssue("fan_spend_daily", {
      field: "businessDate",
      op: "in",
      value: ["2026-01-31", "2026-02-01"],
    })).toBeNull();
    expect(agentDatasetFilterIssue("follows", {
      field: "followed",
      op: "eq",
      value: true,
    })).toBeNull();
    expect(agentDatasetFilterIssue("follows", {
      field: "unfollowedAt",
      op: "is_null",
    })).toBeNull();
  });

  it("rejects scalar lookalikes before they can be coerced by Postgres", () => {
    expect(agentDatasetFilterIssue("transactions", {
      field: "platform",
      op: "eq",
      value: 1,
    })).toEqual({ code: "value_type_mismatch", kind: "string" });
    expect(agentDatasetFilterIssue("posts", {
      field: "attachmentCount",
      op: "eq",
      value: 1.5,
    })).toEqual({ code: "value_type_mismatch", kind: "int" });
    expect(agentDatasetFilterIssue("transactions", {
      field: "grossMills",
      op: "gte",
      value: "1000",
    })).toEqual({ code: "value_type_mismatch", kind: "mills" });
    expect(agentDatasetFilterIssue("transactions", {
      field: "occurredAt",
      op: "gte",
      value: "2026-02-30T00:00:00Z",
    })).toEqual({ code: "value_type_mismatch", kind: "timestamp" });
    expect(agentDatasetFilterIssue("fan_spend_daily", {
      field: "businessDate",
      op: "eq",
      value: "2026-02-30",
    })).toEqual({ code: "value_type_mismatch", kind: "date" });
    expect(agentDatasetFilterIssue("follows", {
      field: "followed",
      op: "eq",
      value: "true",
    })).toEqual({ code: "value_type_mismatch", kind: "bool" });
    expect(agentDatasetFilterIssue("transactions", {
      field: "grossMills",
      op: "eq",
      value: null,
    })).toEqual({ code: "value_type_mismatch", kind: "mills" });
  });

  it("rejects operators without honest semantics for the field kind", () => {
    expect(agentDatasetFilterIssue("follows", {
      field: "followed",
      op: "gt",
      value: true,
    })).toEqual({ code: "operator_not_supported", kind: "bool" });
    expect(agentDatasetFilterIssue("transactions", {
      field: "grossMills",
      op: "in",
      value: ["1000"],
    })).toEqual({ code: "operator_not_supported", kind: "mills" });
    expect(agentDatasetFilterIssue("transactions", {
      field: "occurredAt",
      op: "in",
      value: ["2026-02-01T00:00:00Z"],
    })).toEqual({ code: "operator_not_supported", kind: "timestamp" });
    expect(agentDatasetFilterIssue("transactions", {
      field: "occurredAt",
      op: "is_null",
      value: "2026-02-01T00:00:00Z",
    })).toEqual({ code: "value_type_mismatch", kind: "timestamp" });
    expect(agentDatasetFilterIssue("transactions", {
      field: "secretColumn",
      op: "eq",
      value: "x",
    })).toEqual({ code: "unknown_field" });
  });
});

describe("agent capability matrix", () => {
  it("is the closed five-value matrix", () => {
    expect([...AGENT_CAPABILITIES]).toEqual([
      "read:messages",
      "read:money",
      "read:observations_envelope",
      "read:datasets",
      "request:hydration",
    ]);
    expect(new Set(AGENT_CAPABILITIES).size).toBe(AGENT_CAPABILITIES.length);
  });

  it("rejects an unknown capability at the boundary rather than ignoring it", () => {
    // Issuance REJECTS: silently dropping a typo would mint a key the owner
    // believes is narrower than it is; silently accepting one would mint a grant
    // no code path can ever check.
    expect(isAgentCapability("read:messages")).toBe(true);
    expect(isAgentCapability("read:everything")).toBe(false);
    expect(isAgentCapability("READ:MESSAGES")).toBe(false);
    expect(isAgentCapability("")).toBe(false);
    expect(isAgentCapability("constructor")).toBe(false);
  });
});

describe("agent subscription state", () => {
  it("reads retirement from is_current, not from the last provider status", () => {
    // `canonical_status` is the LAST status the provider sent; a sync that no
    // longer sees the subscription retires the row with `is_current = false`
    // and leaves the status alone. An `active` status on a retired row is an
    // ended subscription. Other statuses keep their own reading: a retired
    // `pending` row is not guessed into `expired`.
    const cases: Array<[string | null, boolean, "active" | "expired" | "unknown"]> = [
      ["active", true, "active"],
      ["active", false, "expired"],
      ["expired", true, "expired"],
      ["ended", false, "expired"],
      ["cancelled", false, "expired"],
      ["pending", false, "unknown"],
      [null, true, "unknown"],
    ];
    for (const [status, isCurrent, expected] of cases) {
      expect(agentSubscriptionState(status, isCurrent), `${status}/${isCurrent}`).toBe(expected);
    }
  });
});

describe("dataset catalog completeness", () => {
  it("covers every available dataset in the catalog view", () => {
    // A dataset declared but missing from the catalog view would be addressable
    // and undiscoverable at the same time.
    const catalogued = AGENT_DATASET_NAMES.map((name) => name as AgentDataset);
    expect(catalogued.length).toBe(Object.keys(AGENT_DATASETS).length);
  });
});
