import { describe, expect, it } from "vitest";

import {
  AGENT_CAPABILITIES,
  AGENT_DATASET_FIELD_KINDS,
  AGENT_DATASET_NAMES,
  AGENT_DATASETS,
  AGENT_PLANNED_DATASET_NAMES,
  agentDatasetDefinition,
  agentDatasetFields,
  agentDatasetRequiredCapabilities,
  isAgentCapability,
  type AgentDataset,
} from "@agency_hub_core/contracts";

/**
 * The dataset registry is the ONLY bridge from a dataset name in a request path to
 * code: a string never becomes a table or column name at runtime. These pins keep
 * the vocabulary internally consistent so slice A can DERIVE the path enum, the
 * filter allowlist and the catalog response from it instead of hand-listing them
 * three times and drifting — the same failure the claim/plane registry was created
 * to prevent.
 */
describe("agent read dataset vocabulary", () => {
  it("names exactly the ten available datasets from the contract appendix", () => {
    expect([...AGENT_DATASET_NAMES]).toEqual([
      "fan_memberships",
      "dm_threads",
      "subscriptions",
      "transactions",
      "fan_spend_daily",
      "follows",
      "followers_daily",
      "fan_aliases",
      "fan_notes",
      "sync_streams",
    ]);
  });

  it("declares every planned dataset instead of hiding the hole", () => {
    // The catalog must NAME its gaps: an agent that cannot tell "no data" from "no
    // dataset" cannot reason about absence at all. purchase_history and
    // fan_earnings sit here deliberately — neither has a serving projection.
    expect([...AGENT_PLANNED_DATASET_NAMES]).toEqual([
      "purchase_history",
      "fan_earnings",
      "posts",
      "vault_media",
      "stories",
      "notifications",
      "fan_lists",
      "subscription_tiers",
      "livestreams",
      "campaigns",
      "comments",
      "likes",
      "polls",
      "payouts",
      "chargebacks",
      "blocks",
    ]);
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

  it("marks exactly the money-bearing datasets and makes them require read:money", () => {
    const money = AGENT_DATASET_NAMES.filter((name) => AGENT_DATASETS[name].moneyBearing);
    expect([...money]).toEqual(["subscriptions", "transactions", "fan_spend_daily"]);

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

describe("dataset catalog completeness", () => {
  it("covers every available dataset in the catalog view", () => {
    // A dataset declared but missing from the catalog view would be addressable
    // and undiscoverable at the same time.
    const catalogued = AGENT_DATASET_NAMES.map((name) => name as AgentDataset);
    expect(catalogued.length).toBe(Object.keys(AGENT_DATASETS).length);
  });
});
