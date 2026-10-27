import { describe, expect, it } from "vitest";

import {
  AGENT_DATASETS,
  AGENT_DATASET_NAMES,
  agentDatasetFieldIsVerbatimText,
  agentDatasetRequiredCapabilities,
  agentPersonQuerySchema,
  agentPersonTimelineQuerySchema,
  agentRouteSchemas,
} from "@agency_hub_core/contracts";

// Agent Read Plane slice A, contract gates. Every assertion here corresponds to a
// property the design pays for elsewhere: the vocabulary is DERIVED (so a drift
// is a compile error, not a lying response), the envelope is on EVERY 200 with no
// exemption list, and the B2 window/cursor law is the one that made a cursor
// spendable at all.

const AGENT_OPERATIONS = [
  "agentCapabilities",
  "agentResolve",
  "agentPerson",
  "agentPersonTimeline",
  "agentThreads",
  "agentThreadMessages",
  // Whether Fansly stopped serving one chat to its page (arena "vanished
  // chat", plan §5): page-scoped like #6, database only.
  "agentThreadAvailability",
  "agentSearchMessages",
  "agentCoverage",
  "agentObservations",
  "agentObservationPayload",
  "agentDatasetQuery",
  // Slice C — the hydration family. #11/#12 are agentKey, #13 and the owner
  // approval queue are owner-session.
  "agentHydrationRequestCreate",
  "agentHydrationRequestGet",
  "agentHydrationRequestDecide",
  "agentHydrationRequestList",
  // The Fansly Sync Engine's history requests (design §7.4): all four agentKey;
  // the owner's half lives in routes-sync.ts, outside this plane.
  "agentHistoryRequestCreate",
  "agentHistoryRequestGet",
  "agentHistoryRequestCancel",
  "agentHistoryRequestList",
  // The engine's status and "why waiting" (design §7.4): agentKey reads of the
  // engine's own queue; the owner's twins live in routes-sync.ts.
  "agentSyncStatus",
  "agentSyncWhy",
  // The fans of a page's audience who paid the model's other pages:
  // page-scoped, money-bearing (read:datasets + read:money).
  "agentCrossSpenders",
] as const;

describe("agent read plane: the operation surface", () => {
  it("declares agentKey everywhere except the owner-session payload operation", () => {
    const byKind: Record<string, string[]> = {};
    for (const [key, schema] of Object.entries(agentRouteSchemas)) {
      const kind = (schema as { auth: { kind: string } }).auth.kind;
      (byKind[kind] ??= []).push(key);
    }
    expect((byKind["owner-session"] ?? []).sort()).toEqual([
      "agentHydrationRequestDecide",
      "agentHydrationRequestList",
      "agentObservationPayload",
    ]);
    const ownerSession = new Set([
      "agentHydrationRequestDecide",
      "agentHydrationRequestList",
      "agentObservationPayload",
    ]);
    expect((byKind.agentKey ?? []).sort()).toEqual(
      AGENT_OPERATIONS.filter((key) => !ownerSession.has(key)).sort(),
    );
  });

  it("page scope is declared on exactly the operations whose path carries :pageLabel", () => {
    const pageScoped = Object.entries(agentRouteSchemas)
      .filter(([, schema]) => (schema as { auth: { scope?: string } }).auth.scope === "page")
      .map(([key]) => key)
      .sort();
    expect(pageScoped).toEqual([
      "agentCrossSpenders",
      "agentDatasetQuery",
      "agentHistoryRequestCreate",
      "agentHydrationRequestCreate",
      "agentSyncWhy",
      "agentThreadAvailability",
      "agentThreadMessages",
    ]);
  });
});

describe("agent read plane: the B2 window/cursor law", () => {
  it("routes fan-written post-tip notes only through the gated dataset", () => {
    expect(agentPersonQuerySchema.safeParse({
      claimFields: ["postTipMessageText"],
      claimTargets: "all_in_scope",
    }).success).toBe(false);
    expect(agentPersonTimelineQuerySchema.safeParse({
      from: "2026-01-08T00:00:00Z",
      to: "2026-01-20T00:00:00Z",
      claimFields: ["postTipMessageText"],
      claimTargets: "all_in_scope",
    }).success).toBe(false);
    expect(agentPersonQuerySchema.safeParse({
      claimFields: ["tipMessageText"],
      claimTargets: "all_in_scope",
    }).success).toBe(false);
    expect(agentPersonTimelineQuerySchema.safeParse({
      from: "2026-01-08T00:00:00Z",
      to: "2026-01-20T00:00:00Z",
      claimFields: ["tipMessageText"],
      claimTargets: "all_in_scope",
    }).success).toBe(false);

    expect(agentPersonQuerySchema.safeParse({
      claimFields: ["postTipPostRef", "postTipGoalRef", "postTipAmountMills"],
      claimTargets: "all_in_scope",
    }).success).toBe(true);
  });
});

describe("agent read plane: dataset registry <-> SQL mapping, both directions", () => {
  it("the scope-pairing rule: a purchase-disclosing dataset needs BOTH capabilities", () => {
    // A row saying "this fan bought offer 3 of message X" discloses a
    // conversation as much as a payment, so `read:money` alone must not reach
    // it. The flag is declared, not inferred: no field name or scalar kind can
    // tell `salesCount` on a message offer (a purchase) from `salesCount` on a
    // catalogue item (an inventory statistic).
    const disclosing = AGENT_DATASET_NAMES
      .filter((dataset) => AGENT_DATASETS[dataset].disclosesPurchase)
      .sort();
    expect(disclosing).toEqual(["message_media_sales", "notifications"]);
    expect(agentDatasetRequiredCapabilities("message_media_sales"))
      .toEqual(["read:datasets", "read:money", "read:messages"]);
    expect(agentDatasetRequiredCapabilities("notifications"))
      .toEqual(["read:datasets", "read:messages"]);
    for (const dataset of AGENT_DATASET_NAMES) {
      const definition = AGENT_DATASETS[dataset];
      const needsMessages = definition.verbatimText || definition.disclosesPurchase;
      expect(
        agentDatasetRequiredCapabilities(dataset).includes("read:messages"),
        dataset,
      ).toBe(needsMessages);
    }
    // The catalogue's own sale counts are NOT a purchase disclosure: no fan
    // appears on a `media_stats` row, and neither does a payout.
    expect(AGENT_DATASETS.media_stats.disclosesPurchase).toBe(false);
    expect(AGENT_DATASETS.payouts.disclosesPurchase).toBe(false);
    expect(agentDatasetRequiredCapabilities("payouts"))
      .toEqual(["read:datasets", "read:money"]);
  });

  it("a money-bearing dataset is exactly one carrying a mills field", () => {
    for (const dataset of AGENT_DATASET_NAMES) {
      const definition = AGENT_DATASETS[dataset];
      const carriesMills = Object.values(definition.fields).includes("mills");
      expect(definition.moneyBearing, dataset).toBe(carriesMills);
    }
  });

  it("a dataset serving free text is exactly one requiring read:messages", () => {
    // `fan_notes` selects the note body verbatim — the same material #3 puts
    // behind `read:messages`. Without this rule a `read:datasets`-only key read
    // the notes through the dataset route instead, so the capability on #3 was a
    // door with an open window beside it. Derived from the FIELD MAP so a future
    // dataset that grows a text body cannot inherit the narrower requirement.
    for (const dataset of AGENT_DATASET_NAMES) {
      const definition = AGENT_DATASETS[dataset];
      const carriesText = Object.keys(definition.fields).some(agentDatasetFieldIsVerbatimText);
      expect(definition.verbatimText, dataset).toBe(carriesText);
      // `read:messages` is now reachable by TWO independent routes — free text
      // and the purchase-disclosure pairing rule — so the assertion names both
      // rather than pretending text is the only one.
      expect(agentDatasetRequiredCapabilities(dataset).includes("read:messages"), dataset)
        .toBe(carriesText || definition.disclosesPurchase);
    }
    expect(agentDatasetRequiredCapabilities("fan_notes")).toContain("read:messages");
    expect(agentDatasetRequiredCapabilities("posts")).toEqual(["read:datasets", "read:messages"]);
    expect(agentDatasetRequiredCapabilities("post_monetization"))
      .toEqual(["read:datasets", "read:money", "read:messages"]);
    expect(agentDatasetRequiredCapabilities("post_tips"))
      .toEqual(["read:datasets", "read:money", "read:messages"]);
    expect(agentDatasetRequiredCapabilities("tip_transactions"))
      .toEqual(["read:datasets", "read:money", "read:messages"]);
    expect(agentDatasetRequiredCapabilities("tip_goals"))
      .toEqual(["read:datasets", "read:money", "read:messages"]);
    expect(agentDatasetRequiredCapabilities("dm_threads")).not.toContain("read:messages");
  });
});
