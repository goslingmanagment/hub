import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AGENT_CLAIM_FIELDS,
  AGENT_DATASETS,
  AGENT_DATASET_NAMES,
  AGENT_PLANE_COUNT,
  AGENT_PLANE_NAMES,
  AGENT_POST_READ_OPERATIONS,
  AGENT_PREDICATE_REGISTRY,
  agentBlockerEnum,
  agentCaptureFloorSchema,
  agentCaptureSchema,
  agentClaimFieldEnum,
  agentDatasetEnum,
  agentDatasetQueryBodySchema,
  agentDeliverySchema,
  agentPersonTimelineQuerySchema,
  agentPlaneNameEnum,
  agentRouteSchemas,
  agentSearchMessagesBodySchema,
  agentThreadMessagesQuerySchema,
  routeSchemas,
} from "@agency_hub_core/contracts";
import { AGENT_DATASET_SQL } from "@agency_hub_core/db";

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
  "agentSearchMessages",
  "agentCoverage",
  "agentObservations",
  "agentObservationPayload",
  "agentDatasetQuery",
] as const;

describe("agent read plane: the operation surface", () => {
  it("lands exactly the eleven routes of operations 1-10 (9 splits into 9a/9b)", () => {
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
    expect(byKind["owner-session"]).toEqual(["agentObservationPayload"]);
    expect((byKind.agentKey ?? []).sort()).toEqual(
      AGENT_OPERATIONS.filter((key) => key !== "agentObservationPayload").sort(),
    );
  });

  it("page scope is declared on exactly the two operations whose path carries :pageLabel", () => {
    const pageScoped = Object.entries(agentRouteSchemas)
      .filter(([, schema]) => (schema as { auth: { scope?: string } }).auth.scope === "page")
      .map(([key]) => key)
      .sort();
    expect(pageScoped).toEqual(["agentDatasetQuery", "agentThreadMessages"]);
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
    for (const key of AGENT_OPERATIONS) {
      const schema = agentRouteSchemas[key] as { body?: unknown };
      const isPost = (AGENT_POST_READ_OPERATIONS as readonly string[]).includes(key);
      expect(Boolean(schema.body)).toBe(isPost);
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
    for (const key of ["agentThreadMessages", "agentDatasetQuery"] as const) {
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

  it("a dataset cursor refuses re-sent filters and sorts", () => {
    expect(agentDatasetQueryBodySchema.safeParse({
      cursor: "abc123",
      filters: [{ field: "grossMills", op: "gte", value: 1000 }],
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
    expect(agentDatasetEnum.options).not.toContain("purchase_history");
    expect(agentDatasetEnum.options).not.toContain("fan_earnings");
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

  it("a money-bearing dataset is exactly one carrying a mills field", () => {
    for (const dataset of AGENT_DATASET_NAMES) {
      const definition = AGENT_DATASETS[dataset];
      const carriesMills = Object.values(definition.fields).includes("mills");
      expect(definition.moneyBearing, dataset).toBe(carriesMills);
    }
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
