import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AGENT_CLAIM_FIELDS,
  AGENT_DATASETS,
  AGENT_DATASET_NAMES,
  AGENT_PLANNED_DATASET_NAMES,
  AGENT_PLANE_COUNT,
  AGENT_PLANE_NAMES,
  AGENT_POST_MUTATION_OPERATIONS,
  AGENT_POST_READ_OPERATIONS,
  AGENT_PREDICATE_REGISTRY,
  agentBlockerEnum,
  agentCaptureFloorSchema,
  agentCaptureSchema,
  agentClaimFieldEnum,
  agentDatasetEnum,
  agentDatasetFieldIsVerbatimText,
  agentDatasetFields,
  agentDatasetQueryBodySchema,
  agentDatasetRequiredCapabilities,
  agentDeliverySchema,
  agentPersonQuerySchema,
  agentPersonTimelineQuerySchema,
  agentPlaneNameEnum,
  agentRouteSchemas,
  agentSearchMessagesBodySchema,
  agentThreadMessagesQuerySchema,
  routeSchemas,
} from "@agency_hub_core/contracts";
import { AGENT_DATASET_SQL, CLIENT_AUDIENCE_NEW_IGNORED_SUB_TYPES } from "@agency_hub_core/db";

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
] as const;

describe("agent read plane: the operation surface", () => {
  it("lands exactly the routes of operations 1-13 (9 splits into 9a/9b, plus the owner queue) and the history requests", () => {
    expect(Object.keys(agentRouteSchemas).sort()).toEqual([...AGENT_OPERATIONS].sort());
    for (const key of AGENT_OPERATIONS) {
      expect(routeSchemas).toHaveProperty(key);
    }
  });

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
      "agentDatasetQuery",
      "agentHistoryRequestCreate",
      "agentHydrationRequestCreate",
      "agentSyncWhy",
      "agentThreadAvailability",
      "agentThreadMessages",
    ]);
  });

  it("POST-as-read is exactly the reviewed allowlist of three", () => {
    // A POST that is really a read must be a DELIBERATE exception: search takes
    // POST so the query text never lands in an access log, and the other two take
    // typed bodies. Anything else on the plane is a GET.
    expect([...AGENT_POST_READ_OPERATIONS]).toEqual([
      "agentResolve",
      "agentSearchMessages",
      "agentDatasetQuery",
    ]);
    // The plane's MUTATIONS are enumerated separately (§17.15.4) — a body is
    // allowed on a read POST from the allowlist, or on one of these, and
    // nowhere else. History cancel carries a body (an optional reason) for
    // exactly this reason.
    expect([...AGENT_POST_MUTATION_OPERATIONS]).toEqual([
      "agentHydrationRequestCreate",
      "agentHydrationRequestDecide",
      "agentHistoryRequestCreate",
      "agentHistoryRequestCancel",
    ]);
    for (const key of AGENT_OPERATIONS) {
      const schema = agentRouteSchemas[key] as { body?: unknown };
      const takesBody = (AGENT_POST_READ_OPERATIONS as readonly string[]).includes(key)
        || (AGENT_POST_MUTATION_OPERATIONS as readonly string[]).includes(key);
      expect(Boolean(schema.body)).toBe(takesBody);
    }
  });

  it("neither globally addressable person operation declares a 404", () => {
    // Not an omission: a static 404 on a globally keyed fan would collapse
    // "no such fan" into "the fan is on a page outside your grant", which is the
    // exact confusion the plane exists to remove.
    for (const key of ["agentPerson", "agentPersonTimeline"] as const) {
      const responses = (agentRouteSchemas[key] as { response: Record<string, unknown> }).response;
      expect(Object.keys(responses)).not.toContain("404");
    }
    // The path-addressed ones DO declare it.
    for (const key of [
      "agentThreadMessages",
      "agentThreadAvailability",
      "agentDatasetQuery",
      "agentHistoryRequestCreate",
      "agentHistoryRequestGet",
      "agentHistoryRequestCancel",
      "agentSyncWhy",
    ] as const) {
      const responses = (agentRouteSchemas[key] as { response: Record<string, unknown> }).response;
      expect(Object.keys(responses)).toContain("404");
    }
  });

  it("no operation declares a 500", () => {
    for (const key of AGENT_OPERATIONS) {
      const responses = (agentRouteSchemas[key] as { response: Record<string, unknown> }).response;
      expect(Object.keys(responses)).not.toContain("500");
    }
  });

  it("every 200 carries delivery + capture + conclusion, with no exemption list", () => {
    for (const key of AGENT_OPERATIONS) {
      const responses = (agentRouteSchemas[key] as {
        response: Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
      }).response;
      const ok = responses["200"];
      expect(ok, key).toBeDefined();
      // The cheapest total check: an object missing any of the three cannot parse.
      expect(ok?.safeParse({}).success, key).toBe(false);
    }
  });
});

describe("agent read plane: the vocabulary is derived, never restated", () => {
  it("plane, claim-field and dataset enums come from the registries", () => {
    expect(agentPlaneNameEnum.options).toEqual([...AGENT_PLANE_NAMES]);
    expect(agentClaimFieldEnum.options).toEqual([...AGENT_CLAIM_FIELDS]);
    expect(agentDatasetEnum.options).toEqual([...AGENT_DATASET_NAMES]);
  });

  it("capture.planes is pinned to the registry's own count", () => {
    const planes = AGENT_PLANE_NAMES.map((plane) => ({
      plane,
      state: "not_applicable" as const,
      reason: "not_a_source_for_this_claim" as const,
    }));
    const base = {
      planes,
      observedRowFloor: null,
      gaps: [],
      sourceErrors: [],
      scopeNarrowing: { keyGrantExcludedPages: 0, totalPagesForQuery: 3 },
      scopeFieldStates: {},
    };
    expect(agentCaptureSchema.safeParse(base).success).toBe(true);
    // One plane short is inexpressible: the anti-omission law is literal.
    expect(agentCaptureSchema.safeParse({ ...base, planes: planes.slice(1) }).success).toBe(false);
    expect(planes).toHaveLength(AGENT_PLANE_COUNT);
  });

  it("the R-008 traversal blocker is in the blocker enum", () => {
    expect(agentBlockerEnum.options).toContain("mutable_sort_key_traversal");
    expect(agentBlockerEnum.options).toContain("read_only_mode");
  });

  it("an unproven Vault inventory is sayable on the wire", () => {
    // #247. Without it, a consumer of `vault_media` reading `missingSince` as an
    // absence claim had nothing in the response to warn them that the inventory
    // itself had never been walked to completion.
    expect(agentBlockerEnum.options).toContain("vault_inventory_unproven");
  });

  it("the absence-proof machinery is GONE from the wire", () => {
    // Owner ruling 2026-08-01. It was unreachable on every real route and its
    // supporting reads were the slowest queries in the slice, so it was removed
    // rather than left as a field that is structurally always false.
    for (const removed of [
      "capture_basis_none",
      "capture_basis_store_derived",
      "capture_ceiling_unknown",
      "window_after_capture_ceiling",
      "gap_detection_head_only",
      "proof_missing",
      "proof_revoked",
      "proof_classification_not_continuous",
      "proof_head_stale",
      "no_proof_lane_for_claim",
      "parse_debt_nonzero",
      "rejected_nonzero",
      "serving_high_water_unsatisfied",
    ]) {
      expect(agentBlockerEnum.options, removed).not.toContain(removed);
    }
    // The part that answers the original question SURVIVES.
    expect(agentBlockerEnum.options).toContain("window_before_capture_floor");
    expect(agentBlockerEnum.options).toContain("capture_floor_unknown");
    expect(agentCaptureFloorSchema.shape.kind.options).toEqual(["oldest_stored_row", "unknown"]);
  });

  it("delivery carries the mutable-sort-key caveat vehicle", () => {
    const parsed = agentDeliverySchema.safeParse({
      returned: 0,
      matchedInScope: { value: 0, exact: true, countBasis: "post_dedup" },
      cappedBy: null,
      nextCursor: null,
      snapshotExhausted: true,
      caveats: ["mutable_sort_key"],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("agent read plane: the B2 window/cursor law", () => {
  const windowed = [
    ["agentPersonTimeline", agentPersonTimelineQuerySchema],
    ["agentThreadMessages", agentThreadMessagesQuerySchema],
  ] as const;

  it("a cursor alone is accepted (the pre-B2 shape made it unspendable)", () => {
    for (const [name, schema] of windowed) {
      const parsed = schema.safeParse({ cursor: "abc123" });
      expect(parsed.success, name).toBe(true);
    }
  });

  it("a window alone is accepted", () => {
    for (const [name, schema] of windowed) {
      const parsed = schema.safeParse({
        from: "2026-01-08T00:00:00Z",
        to: "2026-01-20T00:00:00Z",
      });
      expect(parsed.success, name).toBe(true);
    }
  });

  it("neither is refused: there is NO default window anywhere on the plane", () => {
    // A silent "last 90 days" would reproduce the original failure literally:
    // asked about January, answered about the last quarter, answered nothing.
    for (const [name, schema] of windowed) {
      expect(schema.safeParse({}).success, name).toBe(false);
    }
  });

  it("a cursor together with a window is refused", () => {
    for (const [name, schema] of windowed) {
      const parsed = schema.safeParse({
        cursor: "abc123",
        from: "2026-01-08T00:00:00Z",
        to: "2026-01-20T00:00:00Z",
      });
      expect(parsed.success, name).toBe(false);
    }
  });

  it("an inverted window is refused", () => {
    const parsed = agentThreadMessagesQuerySchema.safeParse({
      from: "2026-01-20T00:00:00Z",
      to: "2026-01-08T00:00:00Z",
    });
    expect(parsed.success).toBe(false);
  });

  it("search takes no cursor at all and requires its window flatly", () => {
    expect(agentSearchMessagesBodySchema.safeParse({ q: "custom" }).success).toBe(false);
    expect(agentSearchMessagesBodySchema.safeParse({
      q: "custom",
      from: "2026-01-08T00:00:00Z",
      to: "2026-01-20T00:00:00Z",
    }).success).toBe(true);
    expect(Object.keys(agentSearchMessagesBodySchema.shape)).not.toContain("cursor");
  });

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

  it("a dataset cursor refuses re-sent filters and sorts", () => {
    expect(agentDatasetQueryBodySchema.safeParse({
      cursor: "abc123",
      filters: [{ field: "grossMills", op: "gte", value: 1000 }],
    }).success).toBe(false);
  });

  it("dataset cursor v1 refuses a compound sort it cannot preserve", () => {
    expect(agentDatasetQueryBodySchema.safeParse({
      from: "2026-01-08T00:00:00Z",
      to: "2026-01-20T00:00:00Z",
      sort: [
        { field: "occurredAt", dir: "desc" },
        { field: "grossMills", dir: "desc" },
      ],
    }).success).toBe(false);
  });

  it("dataset summary mode is terminal and has no row ordering", () => {
    const window = { from: "2026-01-08T00:00:00Z", to: "2026-01-20T00:00:00Z" };
    expect(agentDatasetQueryBodySchema.safeParse({ ...window, summary: true }).success).toBe(true);
    expect(agentDatasetQueryBodySchema.safeParse({
      cursor: "abc123",
      summary: true,
    }).success).toBe(false);
    expect(agentDatasetQueryBodySchema.safeParse({
      ...window,
      summary: true,
      sort: [{ field: "grossMills", dir: "desc" }],
    }).success).toBe(false);
  });

  it("dataset filter operators enforce their own arity", () => {
    const window = { from: "2026-01-08T00:00:00Z", to: "2026-01-20T00:00:00Z" };
    expect(agentDatasetQueryBodySchema.safeParse({
      ...window,
      filters: [{ field: "grossMills", op: "is_null", value: 1 }],
    }).success).toBe(false);
    expect(agentDatasetQueryBodySchema.safeParse({
      ...window,
      filters: [{ field: "grossMills", op: "gte" }],
    }).success).toBe(false);
    expect(agentDatasetQueryBodySchema.safeParse({
      ...window,
      filters: [{ field: "platform", op: "in", value: "fansly" }],
    }).success).toBe(false);
    expect(agentDatasetQueryBodySchema.safeParse({
      ...window,
      filters: [{ field: "platform", op: "in", value: ["fansly"] }],
    }).success).toBe(true);
  });

  it("only AVAILABLE datasets are addressable; planned ones are a boundary 400", () => {
    expect(agentDatasetEnum.options).not.toContain("fan_earnings");
    expect(agentDatasetEnum.options).toContain("posts");
    expect(agentDatasetEnum.options).toContain("post_monetization");
    expect(agentDatasetEnum.options).toContain("post_tips");
    expect(agentDatasetEnum.options).toContain("tip_transactions");
    expect(agentDatasetEnum.options).toContain("tip_goals");
  });

  it("WP-S1 consumed its reserved keys and superseded purchase_history", () => {
    // The six reserved names are now ADDRESSABLE rather than planned: a caller
    // that read the catalog a year ago and wrote `--dataset comments` gets data
    // instead of a 400, which is the whole reason the keys were reserved.
    for (const promoted of [
      "comments",
      "likes",
      "vault_media",
      "notifications",
      "subscription_tiers",
      "payouts",
    ] as const) {
      expect(agentDatasetEnum.options, promoted).toContain(promoted);
      expect(AGENT_PLANNED_DATASET_NAMES, promoted).not.toContain(promoted);
    }
    // `purchase_history` was never a dataset — it is a SYNC STREAM name with no
    // serving table. It is gone from BOTH lists: `message_media_sales` answers
    // the question it stood for, and leaving the stale key beside its real
    // answer would have advertised a second, better one that is never coming.
    expect(agentDatasetEnum.options).not.toContain("purchase_history");
    expect(AGENT_PLANNED_DATASET_NAMES).not.toContain("purchase_history");
    expect(agentDatasetEnum.options).toContain("message_media_sales");
    // `fan_earnings` stays planned, untouched by this initiative.
    expect(AGENT_PLANNED_DATASET_NAMES).toContain("fan_earnings");
  });
});

describe("agent read plane: dataset registry <-> SQL mapping, both directions", () => {
  it("every declared field has a mapping and every mapping has a declaration", () => {
    for (const dataset of AGENT_DATASET_NAMES) {
      const declared = Object.keys(AGENT_DATASETS[dataset].fields).sort();
      const mapping = AGENT_DATASET_SQL[dataset];
      expect(mapping, `${dataset} has no SQL mapping`).toBeDefined();
      const mapped = Object.keys(mapping!.fields).sort();
      // A declared field with no mapping would 500 at query time; a mapped column
      // with no declaration would serve data the catalog never advertised.
      expect(mapped, dataset).toEqual(declared);
    }
  });

  it("the SQL mapping declares no dataset the registry does not", () => {
    expect(Object.keys(AGENT_DATASET_SQL).sort()).toEqual([...AGENT_DATASET_NAMES].sort());
  });

  it("keeps post monetization windowed by publication while both timestamps stay queryable", () => {
    const mapping = AGENT_DATASET_SQL.post_monetization!;
    expect(mapping.windowColumn).toBe("k_occurred_at");
    expect(mapping.source)
      .toContain("cp.published_at        as k_occurred_at");
    const fields = new Map(agentDatasetFields("post_monetization").map((field) => [
      field.field,
      field,
    ]));
    expect(fields.get("publishedAt")?.filterable).toBe(true);
    expect(fields.get("lastObservedAt")?.filterable).toBe(true);
  });

  it("subscription events leave out what is no subscription, by the hub's one list of such subTypes", () => {
    // The client's "new subscribers" list and this dataset must not disagree on
    // whether a top-fan award is a subscription, so the dataset's SQL is built
    // from the list the client list reads. Eligibility keeps the award out of
    // rows without taking it out of the capture floor.
    const mapping = AGENT_DATASET_SQL.subscription_events!;
    expect(mapping.eligibilityColumn).toBe("k_eligible");
    expect(mapping.source).toContain("as k_eligible");
    expect(CLIENT_AUDIENCE_NEW_IGNORED_SUB_TYPES).toContain("customer_award_for_model_top");
    for (const subType of CLIENT_AUDIENCE_NEW_IGNORED_SUB_TYPES) {
      expect(mapping.source, subType).toContain(`'${subType}'`);
    }
  });

  it("every mapped column is exposed by its own source projection", () => {
    for (const dataset of AGENT_DATASET_NAMES) {
      const mapping = AGENT_DATASET_SQL[dataset]!;
      for (const column of Object.values(mapping.fields)) {
        expect(mapping.source, `${dataset}.${column}`).toContain(column);
      }
      // Every declared read plane is a real registry plane: a dataset that claims
      // to read a store nobody has heard of would put an unknown name into
      // `capture.planes`.
      for (const plane of mapping.readPlanes) {
        expect(AGENT_PLANE_NAMES, `${dataset} -> ${plane}`).toContain(plane);
      }
      for (const internal of ["k_page_id", "k_platform", "k_key", "k_occurred_at", "k_fan"]) {
        expect(mapping.source, `${dataset}.${internal}`).toContain(internal);
      }
    }
  });

  it("every endpoints-cover dataset declares a NON-EMPTY plane set and a floor", () => {
    // `readPlanes: []` is legal — `sync_streams` uses it honestly, because no
    // claim class answers for sync state — and it is FORBIDDEN for these:
    // silently, it disables the capture-floor epistemics, and an empty result
    // with no floor is the "asked about January, got nothing, concluded nothing
    // happened" failure the whole plane exists to prevent.
    const s1Datasets = [
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
    ] as const;
    for (const dataset of s1Datasets) {
      const mapping = AGENT_DATASET_SQL[dataset];
      expect(mapping, dataset).toBeDefined();
      expect(mapping!.readPlanes.length, dataset).toBeGreaterThan(0);
      expect(mapping!.captureFloorPlane, dataset).toBeDefined();
      // A floor may only be claimed for a plane the dataset actually reads.
      expect(mapping!.readPlanes, dataset).toContain(mapping!.captureFloorPlane);
    }
    // And `sync_streams` keeps its honest emptiness — this test must never be
    // "made to pass" by giving it a plane it does not read.
    expect(AGENT_DATASET_SQL.sync_streams!.readPlanes).toEqual([]);
  });

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

describe("agent read plane: the predicate registry is complete", () => {
  it("every predicate names at least one operation that can apply it", () => {
    const known = new Set<string>(AGENT_OPERATIONS);
    for (const entry of AGENT_PREDICATE_REGISTRY) {
      expect(entry.appliesTo.length, entry.predicate).toBeGreaterThan(0);
      for (const operation of entry.appliesTo) {
        expect(known.has(operation), `${entry.predicate} -> ${operation}`).toBe(true);
      }
    }
  });

  it("predicate names are unique", () => {
    const names = AGENT_PREDICATE_REGISTRY.map((entry) => entry.predicate);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("agent read plane: the blockers have exactly one writer", () => {
  it("no runtime file outside epistemics.ts names a blocker value", () => {
    // `conclusion.blockers` is how an agent learns why an answer is narrower than
    // its question. A second writer would eventually disagree with the first, and
    // a missing blocker reads as "nothing limited this" — which is the failure the
    // whole envelope exists to prevent.
    const root = fileURLToPath(new URL("../apps/runtime/src", import.meta.url));
    const allowed = "modules/agent-read/epistemics.ts";
    const offenders: string[] = [];
    for (const file of listTypeScriptFiles(root)) {
      const relative = file.slice(root.length + 1);
      if (relative === allowed) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      for (const blocker of agentBlockerEnum.options) {
        if (source.includes(`"${blocker}"`)) {
          offenders.push(`${relative}: ${blocker}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the removed field survives only as the note explaining its removal", () => {
    const root = fileURLToPath(new URL("../apps/runtime/src", import.meta.url));
    const hits = listTypeScriptFiles(root)
      .filter((file) => readFileSync(file, "utf8").includes("absenceProvable"))
      .map((file) => file.slice(root.length + 1));
    // Only the epistemics header, which records WHY it is gone. A reader who
    // greps for the field must land on that explanation, not on a live writer.
    expect(hits).toEqual(["modules/agent-read/epistemics.ts"]);
  });
});

function listTypeScriptFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTypeScriptFiles(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}
