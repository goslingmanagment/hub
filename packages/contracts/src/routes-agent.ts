/**
 * Agent Read Plane — the wire contracts of operations #1..#10.
 *
 * WHY A SEPARATE MODULE: `routes.ts` is 178 operations of dashboard/client
 * surface; the plane is one coherent contract with its own envelope law, its own
 * principal and its own vocabulary, and mixing it in would bury both. `routes.ts`
 * spreads `agentRouteSchemas` into `routeSchemas`, so registration, the auth
 * declaration test and the OpenAPI generator see one flat registry as before.
 *
 * THE LAW THIS FILE ENCODES (design spec §5, appendix §17):
 *
 * Every 200 carries three INDEPENDENT axes plus a conclusion:
 *   - `delivery` — a property of the RESPONSE (how much came back, what capped it);
 *   - `capture`  — a property of the WORLD, computed from {key scope, source,
 *                  requested window} and NOTHING else (invariant 7: the same
 *                  request with and without result filters must serialize a
 *                  byte-identical `capture`);
 *   - `fieldStates`/`provenance` — per record, and `capture.scopeFieldStates`
 *                  BEFORE any row is fetched, so an empty result cannot prove a
 *                  field was absent;
 *   - `conclusion.absenceProvable` — the ONE field an agent may read as "this did
 *                  not happen", and it is false unless every listed condition
 *                  holds. `absenceProvable === (blockers.length === 0)`.
 *
 * Vocabulary is DERIVED, never restated: plane names, claim fields, capabilities
 * and dataset names come from `agent-read-registry.ts`,
 * `agent-read-capabilities.ts` and `agent-read-datasets.ts`. A drift becomes a
 * compile error instead of a lie in a response body.
 *
 * ZOD v4 TRAP (documented in routes.ts:387-391, restated by appendix §17.0.3):
 * `.merge()/.pick()/.omit()/.partial()` SILENTLY DROP `superRefine`. So: base
 * field schemas carry no refinements, cross-field rules are plain helpers
 * returning issues, and each composite applies them in ONE terminal
 * `.superRefine()` after all `{...X.shape}` spreads. A schema that already has a
 * `.superRefine()` is never composed further.
 */

import { agentExportPolicyValues } from "@agency_hub_core/shared";
import { z } from "zod";

import {
  AGENT_CLAIM_FIELDS,
  AGENT_PLANE_COUNT,
  AGENT_PLANE_NAMES,
} from "./agent-read-registry.ts";
import { AGENT_CAPABILITIES } from "./agent-read-capabilities.ts";
import {
  AGENT_DATASET_FIELD_KINDS,
  AGENT_DATASET_NAMES,
  AGENT_PLANNED_DATASET_NAMES,
} from "./agent-read-datasets.ts";
import {
  errorResponseSchema,
  fanLookupParamsSchema,
  fanSearchMatchKindEnum,
  mills,
  pageParamsSchema,
  paginationQuerySchema,
  platformEnum,
  queryBooleanSchema,
  sortDirEnum,
  transactionStateEnum,
  transactionTypeEnum,
} from "./primitives.ts";

// ---------------------------------------------------------------------------
// §17.0.1 — plane primitives
// ---------------------------------------------------------------------------

/**
 * The house `isoTimestamp` is a bare `z.string()` and validates nothing. The
 * plane's timestamps decide window membership and capture floors, so they are
 * checked. `z.iso.datetime()` is deliberately NOT used: there are zero `z.iso.`
 * precedents in this repository and the OpenAPI generator's behaviour on it is
 * unverified; a regex gives the same guarantee on proven house mechanics.
 */
export const agentIsoTimestamp = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/,
  "RFC 3339 timestamp with explicit offset",
);
export const agentSha256Hex = z.string().length(64).regex(/^[0-9a-f]{64}$/);
export const agentCursorString = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/);
/**
 * The closed scalar union a dataset row may carry. Not arbitrary JSON:
 * `components.schemas` is empty in the generated document (every schema inlines),
 * so a recursive `z.lazy` value would expand forever.
 */
export const agentScalar = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);

// ---------------------------------------------------------------------------
// §17.0.3 — cross-field rule helpers (never `.superRefine` on a base schema)
// ---------------------------------------------------------------------------

export interface AgentIssue {
  path: PropertyKey[];
  message: string;
}

interface AgentRefinementCtx {
  addIssue: (issue: { code: "custom"; path: PropertyKey[]; message: string }) => void;
}

function addAgentIssues(issues: AgentIssue[], ctx: AgentRefinementCtx): void {
  for (const issue of issues) {
    ctx.addIssue({ code: "custom", ...issue });
  }
}

/**
 * `[from, to)` must be a real interval. Both bounds are OPTIONAL on every paged
 * operation: a cursor CARRIES the window, and re-sending it alongside is refused
 * (see `agentWindowCursorIssues`). This is the B2 law — an earlier revision made
 * `from`/`to` required next to a cursor, which made the cursor unspendable.
 */
function agentWindowIssues(
  value: { from?: string | undefined; to?: string | undefined },
  prefix: PropertyKey[] = [],
): AgentIssue[] {
  if (value.from === undefined || value.to === undefined) {
    return [];
  }
  return Date.parse(value.from) < Date.parse(value.to)
    ? []
    : [{ path: [...prefix, "to"], message: "`from` must be strictly before `to`" }];
}

/**
 * A cursor pins the whole scope; a request may carry the cursor OR the window,
 * never both, and must carry one of them wherever the window is epistemically
 * load-bearing (§17.0.13: no operation ever substitutes a silent default window
 * — "asked about January, got last quarter, got nothing" is the original bug).
 */
function agentWindowCursorIssues(value: {
  from?: string | undefined;
  to?: string | undefined;
  cursor?: string | undefined;
}): AgentIssue[] {
  const issues: AgentIssue[] = [];
  if (value.cursor !== undefined && (value.from !== undefined || value.to !== undefined)) {
    issues.push({ path: ["cursor"], message: "cursor pins the scope; do not resend `from`/`to`" });
  }
  if (value.cursor === undefined && (value.from === undefined || value.to === undefined)) {
    issues.push({
      path: ["from"],
      message: "`from` and `to` are required unless a cursor is supplied",
    });
  }
  return issues;
}

/** A claim is a declaration: both halves or neither. */
function agentClaimQueryIssues(value: {
  claimFields?: string[] | undefined;
  claimTargets?: "all_in_scope" | undefined;
}): AgentIssue[] {
  return (value.claimFields === undefined) === (value.claimTargets === undefined)
    ? []
    : [{
      path: ["claimFields"],
      message: "`claimFields` and `claimTargets` must be supplied together",
    }];
}

function agentPairIssues(
  left: unknown,
  right: unknown,
  path: PropertyKey[],
  message: string,
): AgentIssue[] {
  return (left === undefined) !== (right === undefined) ? [{ path, message }] : [];
}

// ---------------------------------------------------------------------------
// Derived vocabularies. Hand-listing ANY of these is the drift the registry
// modules exist to prevent.
// ---------------------------------------------------------------------------

export const agentCapabilityEnum = z.enum(AGENT_CAPABILITIES);
export const agentPlaneNameEnum = z.enum(AGENT_PLANE_NAMES);
export const agentClaimFieldEnum = z.enum(AGENT_CLAIM_FIELDS);
export const agentDatasetEnum = z.enum(AGENT_DATASET_NAMES);
export const agentPlannedDatasetEnum = z.enum(AGENT_PLANNED_DATASET_NAMES);
export const agentDatasetFieldKindEnum = z.enum(AGENT_DATASET_FIELD_KINDS);

// ---------------------------------------------------------------------------
// §17.0.7 — axis A, delivery
// ---------------------------------------------------------------------------

export const agentCountSchema = z.object({
  value: z.number().int().nonnegative(),
  /** false when the count hit the `count(*) from (<dedup> limit 5001)` probe. */
  exact: z.boolean(),
  /** A literal, not an enum: §5.1 requires counting AFTER dedup, always. */
  countBasis: z.literal("post_dedup"),
}).strict();

/**
 * Delivery caveats. Distinct from `capture`: these say something about how THIS
 * response was assembled, never about the world.
 *
 * `mutable_sort_key`: `occurred_at` / `last_message_at` are updated in place by
 * the sync writers, so a keyset traversal can in principle skip a row that moved
 * between pages. Within ONE request the read is MVCC-consistent and a caveat is
 * enough; a response that CONSUMED a cursor is not, and takes the
 * `mutable_sort_key_traversal` BLOCKER instead (arbitration R-008).
 */
export const agentDeliveryCaveatEnum = z.enum(["mutable_sort_key"]);

export const agentDeliverySchema = z.object({
  /** The number of RECORDS in this response. Not an HTTP status. */
  returned: z.number().int().nonnegative(),
  matchedInScope: agentCountSchema,
  cappedBy: z.enum(["limit", "snapshot", "budget"]).nullable(),
  nextCursor: agentCursorString.nullable(),
  /** The frozen membership snapshot is exhausted. Says NOTHING about history. */
  snapshotExhausted: z.boolean(),
  caveats: z.array(agentDeliveryCaveatEnum),
}).strict();

// ---------------------------------------------------------------------------
// §17.0.8 — axis B, capture
// ---------------------------------------------------------------------------

export const agentPlaneStateEnum = z.enum(["read", "not_applicable", "not_read", "not_indexed"]);

export const agentPlaneReasonEnum = z.enum([
  "not_a_source_for_this_claim",
  "not_queried_by_this_operation",
  "onlyfans_only",
  "fansly_only",
  "capability_not_granted",
  "plane_disabled_by_config",
  "not_indexed_for_text_search",
  "journal_starts_after_window",
  "partition_detached",
  "outside_sql_retention",
  "source_timeout",
]);

export const agentCaptureBasisEnum = z.enum(["cryptographic_proof", "store_derived", "none"]);

export const agentCaptureFloorSchema = z.object({
  at: agentIsoTimestamp.nullable(),
  /**
   * Exactly two derivations. `first_observed_capture` is deliberately absent: it
   * resurrects the forbidden "floor = the oldest row that came back", which is
   * how an empty window became a proof of absence.
   */
  kind: z.enum(["proof_oldest_message", "unknown"]),
}).strict();

export const agentCaptureCeilingSchema = z.object({
  at: agentIsoTimestamp.nullable(),
  kind: z.enum(["last_successful_pull", "proof_frozen_head", "no_lane"]),
  laneCadenceSeconds: z.number().int().positive().nullable(),
  breakerOpen: z.boolean(),
}).strict();

export const agentProofSchema = z.object({
  classification: z.enum(["continuous_history", "verified_unavailable", "explicit_open_debt"]),
  source: z.enum(["pagination_exhausted", "export_artifact", "harvest_import"]),
  frozenHeadRef: z.string().min(1),
  currentHeadRef: z.string().min(1).nullable(),
  frozenHeadMatchesCurrentHead: z.boolean(),
  oldestMessageRef: z.string().min(1).nullable(),
  targetHash: agentSha256Hex,
  pageChainHash: agentSha256Hex,
  proofObservationRef: z.number().int().positive().nullable(),
  sourceAccountSeq: z.number().int().nonnegative().nullable(),
  revokedAt: agentIsoTimestamp.nullable(),
}).strict();

const agentPlaneReadSchema = z.object({
  plane: agentPlaneNameEnum,
  state: z.literal("read"),
  basis: agentCaptureBasisEnum,
  captureFloor: agentCaptureFloorSchema,
  captureCeiling: agentCaptureCeilingSchema,
  proof: agentProofSchema.nullable(),
  parseDebt: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  servingHighWaterSatisfied: z.boolean(),
}).strict();

const agentPlaneUnavailableSchema = z.object({
  plane: agentPlaneNameEnum,
  state: z.enum(["not_applicable", "not_read", "not_indexed"]),
  reason: agentPlaneReasonEnum,
}).strict();

/** A union, not a flat object: "not read, but here is its capture floor" must be
 *  inexpressible, because a floor on an unread plane is a fabricated floor. */
export const agentPlaneSchema = z.union([agentPlaneReadSchema, agentPlaneUnavailableSchema]);

export const agentRemedyReasonEnum = z.enum([
  "no_remedy_exists",
  "capture_lane_unimplemented",
  "journal_before_capture_start",
  "partition_detached",
  "hydration_mode_off",
  "capability_not_granted",
  "discarded_at_capture",
  "projection_missing",
]);

export const agentRemedySchema = z.union([
  z.object({ kind: z.literal("none"), reason: agentRemedyReasonEnum }).strict(),
  z.object({
    kind: z.literal("local_replay"),
    costClass: z.literal("free"),
    admissible: z.boolean(),
    reason: agentRemedyReasonEnum.nullable(),
  }).strict(),
  z.object({
    kind: z.literal("hydration_request"),
    costClass: z.enum(["vendor_paid_low", "vendor_paid_high"]),
    admissible: z.boolean(),
    reason: agentRemedyReasonEnum.nullable(),
  }).strict(),
  z.object({
    kind: z.literal("recapture"),
    costClass: z.enum(["free", "vendor_paid_low", "vendor_paid_high"]),
    admissible: z.boolean(),
    reason: agentRemedyReasonEnum.nullable(),
  }).strict(),
]);

export const agentGapSchema = z.object({
  kind: z.enum([
    "before_capture_floor",
    "after_capture_ceiling",
    "internal_capture_gap",
    "proof_open_debt",
    "parse_debt",
    "rejected_rows",
    "partition_detached",
    "source_error",
  ]),
  from: agentIsoTimestamp.nullable(),
  to: agentIsoTimestamp.nullable(),
  plane: agentPlaneNameEnum,
  remedy: agentRemedySchema,
}).strict();

export const agentSourceErrorSchema = z.object({
  source: z.union([
    agentPlaneNameEnum,
    z.enum(["ofapi_certified_history", "ofapi_message_coverage"]),
  ]),
  /** A CLOSED enum: §12 forbids the query text and its parameters in a response
   *  body (sink allowlist). A free string here would be a hole in that ban. */
  code: z.enum([
    "statement_timeout",
    "archive_rebuilding",
    "plane_disabled",
    "partition_detached",
    "row_budget_exhausted",
    "certified_history_miss",
  ]),
  excludedFromCounts: z.literal(true),
}).strict();

export const agentScopeNarrowingSchema = z.object({
  /** Describes the grant scope of the REQUEST, never the page a particular fan
   *  was found on — so a hidden fan and a nonexistent one stay indistinguishable. */
  keyGrantExcludedPages: z.number().int().nonnegative(),
  totalPagesForQuery: z.number().int().nonnegative(),
}).strict();

// ---------------------------------------------------------------------------
// §17.0.9 — axis C, field observability
// ---------------------------------------------------------------------------

export const agentFieldStateEnum = z.enum([
  "present",
  "observed_empty",
  "captured_unparsed",
  "not_captured",
  "source_did_not_provide",
  "discarded_at_capture",
  "unknown",
]);

export const agentFieldStateSchema = z.object({
  state: agentFieldStateEnum,
  remedy: agentRemedySchema,
}).strict();

export const agentIngestPathEnum = z.enum([
  "fansly_pull",
  "ofapi_webhook",
  "ofapi_rest_pull",
  "ofapi_material_capture",
  "desktop_harvest",
  "readthrough",
  "command_result",
  "operator",
  "export_import",
  "legacy_seed",
  "hot_projection",
  "unknown",
]);

export const agentProvenanceSchema = z.object({
  /** A SET: canonicalization collapses producers onto one key, and the
   *  `not_captured` verdict is the INTERSECTION of the paths' capabilities, not
   *  the last writer's. */
  ingestPaths: z.array(agentIngestPathEnum).min(1),
  convergence: z.enum(["final", "converging", "no_material_lane"]),
  /** nullable: hot/backfill/legacy-seed rows carry no lineage. */
  observationRef: z.number().int().positive().nullable(),
}).strict();

/** Declared by the CLAIMANT, on the wire, from a closed enum — an open
 *  `string[]` would turn an agent's typo into a silent unprovable answer. */
export const agentClaimSchema = z.object({
  fields: z.array(agentClaimFieldEnum).min(1).max(64),
  targets: z.literal("all_in_scope"),
}).strict();

/**
 * GET encoding of a claim. The SDK serializes only flat query values and arrays,
 * and Fastify is not configured for nested query parsing, so on GET the claim
 * splits into two flat fields.
 */
export const agentClaimQuerySchema = z.object({
  claimFields: z.preprocess(
    (value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]),
    z.array(agentClaimFieldEnum).min(1).max(64).optional(),
  ),
  claimTargets: z.literal("all_in_scope").optional(),
});

export const agentCaptureSchema = z.object({
  /** ALL plane names, exactly once each. The anti-omission law is literal: a
   *  silently missing plane is forbidden, so it is not expressible. */
  planes: z.array(agentPlaneSchema).length(AGENT_PLANE_COUNT),
  /** `head_only` FORCES `absenceProvable:false`: a lane that stalled for three
   *  days mid-window leaves no row in any named table, so `gaps` would be empty
   *  and the emptiness would read as proof. */
  gapDetection: z.enum(["head_only", "verified"]),
  /** THE MINIMUM OF THE RETURNED ROWS. Not a capture floor; referring to it as
   *  one is forbidden. Diagnostic only. */
  observedRowFloor: agentIsoTimestamp.nullable(),
  gaps: z.array(agentGapSchema),
  sourceErrors: z.array(agentSourceErrorSchema),
  scopeNarrowing: agentScopeNarrowingSchema,
  /** Computed BEFORE any row is fetched, from the platform capability table x
   *  the capture paths covering the window. Must cover every declared claim
   *  field and every applied predicate's field even when `items` is empty. */
  scopeFieldStates: z.partialRecord(agentClaimFieldEnum, agentFieldStateSchema),
}).strict().superRefine((value, ctx) => addAgentIssues(agentPlanesIssues(value), ctx));

function agentPlanesIssues(value: { planes: Array<{ plane: string }> }): AgentIssue[] {
  const expected = new Set<string>(agentPlaneNameEnum.options);
  const seen = new Set<string>();
  const issues: AgentIssue[] = [];
  for (const [index, plane] of value.planes.entries()) {
    if (seen.has(plane.plane)) {
      issues.push({
        path: ["planes", index, "plane"],
        message: "each capture plane must appear exactly once",
      });
    }
    seen.add(plane.plane);
    expected.delete(plane.plane);
  }
  if (expected.size > 0) {
    issues.push({
      path: ["planes"],
      message: `missing capture planes: ${[...expected].join(",")}`,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// §17.0.10 — the conclusion
// ---------------------------------------------------------------------------

export const agentBlockerEnum = z.enum([
  "claim_not_declared",
  "claim_field_unobservable",
  /** The R4 ramp: `agentReadPlaneMode = read_only`. */
  "read_only_mode",
  "delivery_not_exhausted",
  "capture_basis_none",
  "capture_basis_store_derived",
  "capture_floor_unknown",
  "window_before_capture_floor",
  "capture_ceiling_unknown",
  "window_after_capture_ceiling",
  "gaps_present",
  "gap_detection_head_only",
  "proof_missing",
  "proof_revoked",
  "proof_classification_not_continuous",
  "proof_head_stale",
  /** There is no proof lane for this claim class at all (money, today). */
  "no_proof_lane_for_claim",
  "parse_debt_nonzero",
  "rejected_nonzero",
  "serving_high_water_unsatisfied",
  "source_errors_present",
  "key_grant_narrowed_scope",
  "plane_not_read",
  "plane_not_indexed",
  "field_state_insufficient",
  /** R-008: this response consumed a cursor, so its traversal crossed pages of a
   *  mutable sort key and absence is not provable across that boundary. */
  "mutable_sort_key_traversal",
]);

export const agentConclusionSchema = z.object({
  absenceProvable: z.boolean(),
  blockers: z.array(agentBlockerEnum),
}).strict();

// ---------------------------------------------------------------------------
// §17.0.6 — the envelope refinement shared by every 200
// ---------------------------------------------------------------------------

function agentEvidenceIssues(
  value: {
    delivery: z.infer<typeof agentDeliverySchema>;
    conclusion: z.infer<typeof agentConclusionSchema>;
  },
  actualReturned: number,
): AgentIssue[] {
  const issues: AgentIssue[] = [];
  if (value.delivery.returned !== actualReturned) {
    issues.push({
      path: ["delivery", "returned"],
      message: "`returned` must equal the number of returned records",
    });
  }
  if (value.delivery.snapshotExhausted && value.delivery.nextCursor !== null) {
    issues.push({
      path: ["delivery", "nextCursor"],
      message: "an exhausted snapshot cannot have a next cursor",
    });
  }
  if (value.delivery.nextCursor !== null && value.delivery.cappedBy === null) {
    issues.push({
      path: ["delivery", "cappedBy"],
      message: "a resumable response must say what capped it",
    });
  }
  if (value.conclusion.absenceProvable !== (value.conclusion.blockers.length === 0)) {
    issues.push({
      path: ["conclusion", "absenceProvable"],
      message: "`absenceProvable` iff `blockers` is empty",
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// §17.14 — the predicate registry
// ---------------------------------------------------------------------------

/**
 * Invariant 3: every APPLIED and every UNAPPLIED predicate is named, with a
 * reason. A flat array of applied names cannot express "not applied" versus "not
 * requested", and the difference is the whole point.
 */
export const agentPredicateSchema = z.object({
  name: z.string().min(1).max(64),
  requested: z.boolean(),
  applied: z.boolean(),
  reason: z.enum([
    "applied",
    "not_requested",
    /** hot rows carry no price/media/is_opened columns. */
    "unsupported_for_plane",
    "capability_not_granted",
    "source_failed",
    "not_indexed",
  ]),
}).strict();

/**
 * The declared universe of predicates, served whole by operation #1. A test diffs
 * this registry against the list every operation emits: a predicate an operation
 * reports but the registry does not declare is a failure.
 */
export const AGENT_PREDICATE_REGISTRY = [
  { predicate: "window", appliesTo: ["agentPersonTimeline", "agentThreadMessages", "agentSearchMessages", "agentCoverage", "agentObservations", "agentDatasetQuery"], description: "half-open [from, to) over the record's own event time" },
  { predicate: "platform", appliesTo: ["agentThreads", "agentSearchMessages", "agentCoverage", "agentObservations"], description: "restrict to one platform" },
  { predicate: "pageLabel", appliesTo: ["agentPerson", "agentPersonTimeline", "agentThreads", "agentSearchMessages", "agentCoverage", "agentObservations"], description: "restrict to one granted page" },
  { predicate: "person", appliesTo: ["agentThreads", "agentSearchMessages", "agentCoverage"], description: "restrict to one (platform, platformUserId) fan" },
  { predicate: "conversationRef", appliesTo: ["agentSearchMessages", "agentCoverage"], description: "restrict to named conversations" },
  { predicate: "lanes", appliesTo: ["agentPersonTimeline"], description: "restrict the merged timeline to named lanes" },
  { predicate: "coverageStatus", appliesTo: ["agentThreads"], description: "raw page_dm_threads.message_coverage_status equality" },
  { predicate: "quarantined", appliesTo: ["agentThreads"], description: "thread is inside its sync-health quarantine window" },
  { predicate: "hasMessagesSince", appliesTo: ["agentThreads"], description: "last_message_at at or after the given instant" },
  { predicate: "minStoredMessages", appliesTo: ["agentThreads"], description: "stored_message_count at or above the given floor" },
  { predicate: "direction", appliesTo: ["agentThreadMessages", "agentSearchMessages"], description: "inbound/outbound/unknown relative to the page" },
  { predicate: "senderRole", appliesTo: ["agentThreadMessages", "agentSearchMessages"], description: "fan/model/system/unknown author" },
  { predicate: "hasMedia", appliesTo: ["agentThreadMessages"], description: "the row carries at least one media metadata entry" },
  { predicate: "hasPrice", appliesTo: ["agentThreadMessages"], description: "the row carries a non-null price" },
  { predicate: "isTip", appliesTo: ["agentThreadMessages"], description: "the row is a tip" },
  { predicate: "includeDeleted", appliesTo: ["agentThreadMessages"], description: "tombstoned rows are returned (default true: a deletion is a fact)" },
  { predicate: "textSearch", appliesTo: ["agentSearchMessages"], description: "websearch_to_tsquery('simple') over message_archive.text_plain" },
  { predicate: "source", appliesTo: ["agentObservations"], description: "observation source equality" },
  { predicate: "kind", appliesTo: ["agentObservations"], description: "observation kind equality" },
  { predicate: "producer", appliesTo: ["agentObservations"], description: "observation producer equality" },
  { predicate: "parseVersion", appliesTo: ["agentObservations"], description: "observation parse_version equality" },
  { predicate: "datasetFilter", appliesTo: ["agentDatasetQuery"], description: "one registry-resolved field/op/value triple" },
] as const;

export const agentPredicateCatalogSchema = z.object({
  predicate: z.string().min(1).max(64),
  appliesTo: z.array(z.string().min(1).max(64)),
  description: z.string().max(300),
}).strict();

// ---------------------------------------------------------------------------
// Shared enums used by more than one operation
// ---------------------------------------------------------------------------

export const agentTransactionTypeEnum = transactionTypeEnum;
export const agentTransactionStateEnum = transactionStateEnum;
/** DERIVED from `page_subscriptions.canonical_status`, never the raw column. */
export const agentSubscriptionStateEnum = z.enum(["active", "expired", "unknown"]);
export const agentCoverageStatusEnum = z.enum(["pending_backfill", "partial_window", "complete"]);
export const agentSenderRoleEnum = z.enum(["fan", "model", "system", "unknown"]);
export const agentMessageDirectionEnum = z.enum(["inbound", "outbound", "unknown"]);
export const agentMessageStateEnum = z.enum(["materialized", "deleted", "content_pending"]);
export const agentMembershipStateEnum = z.enum(["active", "inactive", "unknown"]);

/**
 * `exportPolicy` on the OFAPI cold-archive status response (spec 11 staging).
 *
 * The literal widened to this enum in slice A so the fleet can re-vendor while
 * the SERVED value stays `no_raw_transcript_export_endpoint_yet`; the value flip
 * is a separate, later config change. Doing both at once breaks every client
 * whose vendored runtime schema still carries the old `z.literal`.
 */
export const agentExportPolicyEnum = z.enum(agentExportPolicyValues);

/** = `syncStreamEnum` (schema.ts), exactly eleven. */
export const agentSyncStreamEnum = z.enum([
  "light",
  "fan_identities",
  "followers",
  "transactions",
  "top_spenders",
  "subscribers",
  "dm_conversations",
  "dm_messages",
  "followers_reconcile",
  "fan_earnings",
  "purchase_history",
]);

/** = CHECK `observations_source_check`, exactly seven. */
export const agentObservationSourceEnum = z.enum([
  "webhook",
  "pull",
  "client_capture",
  "readthrough",
  "command_result",
  "operator",
  "ofapi_capture",
]);

// ---------------------------------------------------------------------------
// #1 agentCapabilities — GET /api/v1/agent/capabilities
// ---------------------------------------------------------------------------

export const agentPlatformCapabilitiesSchema = z.object({
  platform: platformEnum,
  conversationIdSemantics: z.enum(["equals_fan_id", "separate_thread_id"]),
  hasCoverageProofs: z.boolean(),
  /** The platform's CEILING of capability — the actual state inside a scope is
   *  `capture.scopeFieldStates`. Seven values, not a boolean. */
  capturesMediaMetadata: agentFieldStateEnum,
  capturesMessagePrice: agentFieldStateEnum,
  capturesPurchaseState: agentFieldStateEnum,
  depthCap: z.object({
    default: z.number().int().positive(),
    lifetimeSpender: z.number().int().positive(),
  }).strict().nullable(),
  /** null = the lane is inapplicable or retired (OF `dm_messages` is force-paused). */
  streamCadenceSeconds: z.partialRecord(
    agentSyncStreamEnum,
    z.number().int().positive().nullable(),
  ),
}).strict();

export const agentDatasetCatalogEntrySchema = z.object({
  dataset: z.union([agentDatasetEnum, agentPlannedDatasetEnum]),
  availability: z.enum(["available", "planned"]),
  platforms: z.array(platformEnum),
  moneyBearing: z.boolean(),
  requiredCapabilities: z.array(agentCapabilityEnum),
  /** The catalog NAMES its holes rather than hiding them. */
  captureState: agentFieldStateEnum,
  fields: z.array(z.object({
    field: z.string().min(1).max(64).regex(/^[a-z][a-zA-Z0-9]*$/),
    type: agentDatasetFieldKindEnum,
    filterable: z.boolean(),
    sortable: z.boolean(),
  }).strict()),
  defaultSort: z.string().nullable(),
}).strict();

export const agentCapabilitiesResponseSchema = z.object({
  contract: z.object({
    contractHash: agentSha256Hex,
    planeMode: z.enum(["off", "read_only", "full"]),
    searchBackend: z.enum(["off", "fts", "fts_trgm"]),
    hydrationMode: z.enum(["off", "request_only", "dispatch"]),
    observationsEnabled: z.boolean(),
    fanslyReplayMode: z.enum(["off", "shadow", "on"]),
    archiveGeneration: z.number().int().nonnegative(),
  }).strict(),
  key: z.object({
    keyId: z.number().int().positive(),
    keyPrefix: z.string(),
    capabilities: z.array(z.object({
      capability: agentCapabilityEnum,
      granted: z.boolean(),
    }).strict()),
    expiresAt: agentIsoTimestamp,
  }).strict(),
  budgets: z.object({
    timezone: z.literal("UTC"),
    resetsAt: agentIsoTimestamp,
    requestsUsed: z.number().int().nonnegative(),
    requestsRemaining: z.number().int().nonnegative(),
    rowsUsed: z.number().int().nonnegative(),
    rowsRemaining: z.number().int().nonnegative(),
    concurrentInUse: z.number().int().nonnegative(),
    concurrentLimit: z.literal(2),
  }).strict(),
  limits: z.object({
    paginationDefault: z.literal(50),
    paginationMax: z.literal(200),
    transcriptPerMinute: z.literal(60),
    searchPerMinute: z.literal(20),
    datasetPerMinute: z.literal(20),
    searchResultMax: z.literal(100),
    countProbeMax: z.literal(5001),
    observationPayloadPerSession: z.literal(25),
  }).strict(),
  grant: z.object({
    pages: z.array(z.object({
      pageLabel: z.string(),
      platform: platformEnum,
      modelSlug: z.string(),
      modelName: z.string(),
    }).strict()),
    /** Total pages in this deployment. The difference from `pages.length` is
     *  EXACTLY what §5.6 permits an agent to know, and it is what makes #3/#4
     *  able to answer 200-with-empty instead of a 404 oracle. */
    totalPages: z.number().int().nonnegative(),
  }).strict(),
  platforms: z.array(agentPlatformCapabilitiesSchema).length(2),
  planes: z.array(z.object({
    plane: agentPlaneNameEnum,
    enabled: z.boolean(),
    textSearchIndexed: z.boolean(),
  }).strict()).length(AGENT_PLANE_COUNT),
  datasets: z.array(agentDatasetCatalogEntrySchema),
  /** Invariant 3: the registry is served whole, so a caller can tell an
   *  unapplied predicate from an unknown one. */
  predicates: z.array(agentPredicateCatalogSchema),
  claimFields: z.array(agentClaimFieldEnum),
  delivery: agentDeliverySchema,
  capture: agentCaptureSchema,
  conclusion: agentConclusionSchema,
}).strict().superRefine((value, ctx) =>
  addAgentIssues(agentEvidenceIssues(value, value.grant.pages.length), ctx));

// ---------------------------------------------------------------------------
// #2 agentResolve — POST /api/v1/agent/resolve
// ---------------------------------------------------------------------------

const agentResolveInputSchema = z.object({
  raw: z.string().min(1).max(300),
  /** `auto` and `url` do NOT require the caller to know which key it holds —
   *  that ignorance is exactly what produced the false "no such fan" in Gate R1. */
  hint: z.enum(["auto", "url", "platformUserId", "username", "alias", "displayName"])
    .default("auto"),
}).strict();

export const agentResolveBodySchema = z.object({
  platform: platformEnum.optional(),
  inputs: z.array(agentResolveInputSchema).min(1).max(50),
  includeAliases: z.boolean().default(true),
  includeThreads: z.boolean().default(true),
  claim: agentClaimSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  const issues: AgentIssue[] = [];
  value.inputs.forEach((input, index) => {
    const key = `${input.hint} ${input.raw.trim().toLowerCase()}`;
    if (seen.has(key)) {
      issues.push({ path: ["inputs", index, "raw"], message: "duplicate input" });
    }
    seen.add(key);
  });
  addAgentIssues(issues, ctx);
});

export const agentResolveCandidateSchema = z.object({
  platform: platformEnum,
  platformUserId: z.string().min(1).max(500),
  username: z.string().max(500).nullable(),
  displayName: z.string().max(500).nullable(),
  /** The house enum: username and platform_user_id are DIFFERENT keys, which is
   *  the lesson Gate R1 paid for. */
  matchKind: fanSearchMatchKindEnum,
  matchedValue: z.string().min(1).max(500),
  confidence: z.enum(["exact", "alias_historical", "normalized", "ambiguous"]),
  createdAtExternal: agentIsoTimestamp.nullable(),
  deletedDetectedAt: agentIsoTimestamp.nullable(),
  pages: z.array(z.object({
    pageLabel: z.string(),
    platform: platformEnum,
    conversationRef: z.string().nullable(),
    storedMessageCount: z.number().int().nonnegative().nullable(),
    /** The RAW column value. `complete` does NOT mean complete. */
    messageCoverageStatusRaw: agentCoverageStatusEnum.nullable(),
  }).strict()),
  fieldStates: z.partialRecord(agentClaimFieldEnum, agentFieldStateSchema),
  provenance: agentProvenanceSchema,
}).strict();

export const agentResolveResponseSchema = z.object({
  items: z.array(z.object({
    input: z.object({ raw: z.string(), hint: z.string() }).strict(),
    /** Exactly which forms were tried, in order (invariant 3). */
    normalized: z.array(z.string()).min(1),
    candidates: z.array(agentResolveCandidateSchema).max(20),
    candidatesCapped: z.boolean(),
  }).strict()),
  delivery: agentDeliverySchema,
  capture: agentCaptureSchema,
  conclusion: agentConclusionSchema,
}).strict().superRefine((value, ctx) =>
  addAgentIssues(agentEvidenceIssues(value, value.items.length), ctx));

// ---------------------------------------------------------------------------
// #3 agentPerson — GET /api/v1/agent/people/:platform/:platformUserId
// ---------------------------------------------------------------------------

export const agentPersonQuerySchema = z.object({
  ...agentClaimQuerySchema.shape,
  pageLabel: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => addAgentIssues(agentClaimQueryIssues(value), ctx));

export const agentPersonResponseSchema = z.object({
  /** null = no row in the VISIBLE scope. It does NOT mean the fan does not exist,
   *  and `capture.scopeNarrowing` is mandatory precisely so the difference shows. */
  identity: z.object({
    platform: platformEnum,
    platformUserId: z.string(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
    aliases: z.array(z.object({
      kind: fanSearchMatchKindEnum,
      value: z.string(),
      firstSeenAt: agentIsoTimestamp.nullable(),
      lastSeenAt: agentIsoTimestamp.nullable(),
    }).strict()),
    createdAtExternal: agentIsoTimestamp.nullable(),
    firstSeenAt: agentIsoTimestamp.nullable(),
    lastSeenAt: agentIsoTimestamp.nullable(),
    deletedDetectedAt: agentIsoTimestamp.nullable(),
    flags: z.array(z.object({
      pageLabel: z.string(),
      flag: z.string().min(1).max(200),
      value: z.boolean(),
      updatedAt: agentIsoTimestamp,
    }).strict()),
  }).strict().nullable(),
  memberships: z.array(z.object({
    pageLabel: z.string(),
    platform: platformEnum,
    membershipState: agentMembershipStateEnum,
    isFollower: z.boolean(),
    followerSince: agentIsoTimestamp.nullable(),
    isSubscriber: z.boolean(),
    subscriberSince: agentIsoTimestamp.nullable(),
    subscriptionExpiresAt: agentIsoTimestamp.nullable(),
    autoRenew: z.boolean().nullable(),
    autoRenewOffDetectedAt: agentIsoTimestamp.nullable(),
    lifetimeSpendMills: mills.nullable(),
    lastTransactionAt: agentIsoTimestamp.nullable(),
    pageAlias: z.string().nullable(),
  }).strict()),
  threads: z.array(agentThreadSummarySchema()),
  money: z.object({
    lifetime: z.object({
      grossMills: mills,
      netMills: mills,
      transactionCount: z.number().int().nonnegative(),
      firstTransactionAt: agentIsoTimestamp.nullable(),
      lastTransactionAt: agentIsoTimestamp.nullable(),
    }).strict(),
    byType: z.array(z.object({
      transactionType: agentTransactionTypeEnum,
      transactionState: agentTransactionStateEnum,
      grossMills: mills,
      netMills: mills,
      transactionCount: z.number().int().nonnegative(),
    }).strict()),
  }).strict(),
  subscriptions: z.array(z.object({
    pageLabel: z.string(),
    subscriptionRef: z.string(),
    subscriptionState: agentSubscriptionStateEnum,
    subscriptionTierName: z.string().nullable(),
    subscriptionPriceMills: mills.nullable(),
    renewPriceMills: mills.nullable(),
    autoRenew: z.boolean().nullable(),
    billingCycleDays: z.number().int().nullable(),
    startedAt: agentIsoTimestamp.nullable(),
    subscriptionExpiresAt: agentIsoTimestamp.nullable(),
    isCurrent: z.boolean(),
  }).strict()),
  /** OPEN 9, CLOSED: notes and summaries ARE included. This is not a new class of
   *  disclosure — `pageFanDetail` already returns them to any principal with page
   *  access; withholding them here would only cost a round trip. */
  crm: z.object({
    notes: z.array(z.object({
      pageLabel: z.string(),
      noteRef: z.string(),
      origin: z.enum(["internal", "external"]),
      noteText: z.string(),
      createdAt: agentIsoTimestamp.nullable(),
      updatedAt: agentIsoTimestamp.nullable(),
    }).strict()).max(200),
    summaries: z.array(z.object({
      pageLabel: z.string(),
      summaryRef: z.string(),
      summaryText: z.string(),
      createdAt: agentIsoTimestamp.nullable(),
    }).strict()).max(200),
  }).strict(),
  fieldStates: z.partialRecord(agentClaimFieldEnum, agentFieldStateSchema),
  provenance: agentProvenanceSchema,
  delivery: agentDeliverySchema,
  capture: agentCaptureSchema,
  conclusion: agentConclusionSchema,
}).strict().superRefine((value, ctx) =>
  addAgentIssues(agentEvidenceIssues(value, value.identity === null ? 0 : 1), ctx));

// ---------------------------------------------------------------------------
// #4 agentPersonTimeline
// ---------------------------------------------------------------------------

export const agentTimelineLaneEnum = z.enum([
  "messages",
  "money",
  "subscriptions",
  "follows",
  "presence",
]);

/** `message.ppv_unlocked` is ABSENT and that is normative: it canonicalizes but
 *  projects into nothing, and lives only in `domain_events`, which the plane may
 *  not read. There is nowhere to serve it from. */
export const agentTimelineKindEnum = z.enum([
  "message.received",
  "message.sent",
  "message.deleted",
  "transaction.posted",
  "transaction.pending",
  "tip.received",
  "subscription.started",
  "subscription.renewed",
  "subscription.ended",
  "follow.started",
  "follow.ended",
  "presence.online",
  "presence.offline",
]);

export const agentPersonTimelineQuerySchema = z.object({
  from: agentIsoTimestamp.optional(),
  to: agentIsoTimestamp.optional(),
  lanes: z.preprocess(
    (value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]),
    z.array(agentTimelineLaneEnum).min(1).max(5).optional(),
  ),
  pageLabel: z.string().min(1).optional(),
  sortDir: sortDirEnum.default("desc"),
  limit: paginationQuerySchema.shape.limit,
  cursor: agentCursorString.optional(),
  ...agentClaimQuerySchema.shape,
}).strict().superRefine((value, ctx) =>
  addAgentIssues([
    ...agentWindowIssues(value),
    ...agentClaimQueryIssues(value),
    ...agentWindowCursorIssues(value),
  ], ctx));

export const agentTimelineItemSchema = z.object({
  lane: agentTimelineLaneEnum,
  kind: agentTimelineKindEnum,
  occurredAt: agentIsoTimestamp,
  stableRef: z.string().min(1).max(700),
  pageLabel: z.string(),
  platform: platformEnum,
  conversationRef: z.string().nullable(),
  messageRef: z.string().nullable(),
  transactionRef: z.string().nullable(),
  subscriptionRef: z.string().nullable(),
  grossMills: mills.nullable(),
  netMills: mills.nullable(),
  transactionType: agentTransactionTypeEnum.nullable(),
  transactionState: agentTransactionStateEnum.nullable(),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/).nullable(),
  /** For `lane:"messages"`: METRICS ONLY, never text. Verbatim material stays on
   *  #6 and #7, so the cross-page reader of unredacted transcripts that R3
   *  accepted remains two operations wide, not four. */
  direction: z.enum(["inbound", "outbound", "system", "unknown"]).nullable(),
  senderRole: agentSenderRoleEnum.nullable(),
  textLength: z.number().int().nonnegative().nullable(),
  hasMedia: z.boolean().nullable(),
  isTip: z.boolean().nullable(),
  fieldStates: z.partialRecord(agentClaimFieldEnum, agentFieldStateSchema),
  provenance: agentProvenanceSchema,
}).strict();

export const agentPersonTimelineResponseSchema = z.object({
  window: z.object({ from: agentIsoTimestamp, to: agentIsoTimestamp }).strict(),
  lanesRequested: z.array(agentTimelineLaneEnum),
  lanesServed: z.array(agentTimelineLaneEnum),
  items: z.array(agentTimelineItemSchema).max(200),
  predicates: z.array(agentPredicateSchema),
  delivery: agentDeliverySchema,
  capture: agentCaptureSchema,
  conclusion: agentConclusionSchema,
}).strict().superRefine((value, ctx) =>
  addAgentIssues(agentEvidenceIssues(value, value.items.length), ctx));

// ---------------------------------------------------------------------------
// #5 agentThreads
// ---------------------------------------------------------------------------

export const agentThreadsQuerySchema = z.object({
  platform: platformEnum.optional(),
  pageLabel: z.string().min(1).optional(),
  personPlatform: platformEnum.optional(),
  personPlatformUserId: z.string().min(1).max(500).optional(),
  coverageStatus: agentCoverageStatusEnum.optional(),
  quarantined: queryBooleanSchema.optional(),
  hasMessagesSince: agentIsoTimestamp.optional(),
  minStoredMessages: z.coerce.number().int().min(0).max(100_000).optional(),
  orderBy: z.enum(["lastMessageAt", "storedMessageCount", "pageLabel"]).default("lastMessageAt"),
  sortDir: sortDirEnum.default("desc"),
  limit: paginationQuerySchema.shape.limit,
  cursor: agentCursorString.optional(),
  ...agentClaimQuerySchema.shape,
}).strict().superRefine((value, ctx) =>
  addAgentIssues([
    ...agentClaimQueryIssues(value),
    ...agentPairIssues(
      value.personPlatform,
      value.personPlatformUserId,
      ["personPlatform"],
      "personPlatform and personPlatformUserId are an atomic pair",
    ),
    // #5 is a CURRENT-inventory operation: §17.0.13 gives it no window at all,
    // so only the "do not resend scope with a cursor" half of the B2 law applies.
    ...(value.cursor !== undefined && value.pageLabel !== undefined
      ? [{ path: ["cursor"] as PropertyKey[], message: "cursor pins the scope; do not resend filters" }]
      : []),
  ], ctx));

/**
 * Declared as a factory because #3 embeds it and Zod object identity inside a
 * `.strict()` parent is otherwise shared across two response schemas — the
 * generator inlines every schema, so sharing the instance is fine, but the
 * function keeps the two uses independently evolvable without a `.merge()`
 * (which would drop refinements).
 */
function agentThreadSummarySchema() {
  return z.object({
    pageLabel: z.string(),
    platform: platformEnum,
    conversationRef: z.string().min(1).max(500),
    fanPlatformUserId: z.string().max(500).nullable(),
    fanUsername: z.string().max(500).nullable(),
    fanDisplayName: z.string().max(500).nullable(),
    isVisible: z.boolean(),
    unreadCount: z.number().int().nonnegative().nullable(),
    lastMessageAt: agentIsoTimestamp.nullable(),
    lastFanMessageAt: agentIsoTimestamp.nullable(),
    lastModelMessageAt: agentIsoTimestamp.nullable(),
    storedMessageCount: z.number().int().nonnegative(),
    oldestStoredMessageRef: z.string().nullable(),
    newestStoredMessageRef: z.string().nullable(),
    /** CAREFUL: the raw column. `complete` does NOT mean complete — both
     *  platforms set it on merely intersecting an already-stored message. Of
     *  27 198 Fansly threads marked `complete`, 10 531 hold 1-5 messages and 4
     *  hold none. The `Raw` suffix is there for that reason. */
    messageCoverageStatusRaw: agentCoverageStatusEnum,
    lastMessageSyncAt: agentIsoTimestamp.nullable(),
    breakerOpen: z.boolean(),
    quarantineUntil: agentIsoTimestamp.nullable(),
    basis: agentCaptureBasisEnum,
    captureFloor: agentCaptureFloorSchema,
    captureCeiling: agentCaptureCeilingSchema,
    /** Computed with the SAME predicate #6 will apply, so an overview never
     *  promises rows the detail call will not return. */
    transcriptWillReturnRows: z.boolean(),
    hydrationRemedy: agentRemedySchema,
    /** 200 / 1000 on Fansly; null on OnlyFans. */
    retentionLimit: z.number().int().positive().nullable(),
    fieldStates: z.partialRecord(agentClaimFieldEnum, agentFieldStateSchema),
    provenance: agentProvenanceSchema,
  }).strict();
}

export const agentThreadsResponseSchema = z.object({
  items: z.array(agentThreadSummarySchema()).max(200),
  predicates: z.array(agentPredicateSchema),
  delivery: agentDeliverySchema,
  capture: agentCaptureSchema,
  conclusion: agentConclusionSchema,
}).strict().superRefine((value, ctx) =>
  addAgentIssues(agentEvidenceIssues(value, value.items.length), ctx));

// ---------------------------------------------------------------------------
// #6 agentThreadMessages
// ---------------------------------------------------------------------------

export const agentPageConversationParamsSchema = z.object({
  ...pageParamsSchema.shape,
  conversationRef: z.string().min(1).max(500),
}).strict();

export const agentThreadMessagesQuerySchema = z.object({
  from: agentIsoTimestamp.optional(),
  to: agentIsoTimestamp.optional(),
  direction: agentMessageDirectionEnum.optional(),
  senderRole: agentSenderRoleEnum.optional(),
  hasMedia: queryBooleanSchema.optional(),
  hasPrice: queryBooleanSchema.optional(),
  isTip: queryBooleanSchema.optional(),
  /** DEFAULT true: a deleted message is a fact of the investigation, not litter. */
  includeDeleted: queryBooleanSchema.default(true),
  sortDir: sortDirEnum.default("asc"),
  limit: paginationQuerySchema.shape.limit,
  cursor: agentCursorString.optional(),
  ...agentClaimQuerySchema.shape,
}).strict().superRefine((value, ctx) =>
  addAgentIssues([
    ...agentWindowIssues(value),
    ...agentClaimQueryIssues(value),
    ...agentWindowCursorIssues(value),
  ], ctx));

export const agentMessageMediaSchema = z.object({
  /** Stable metadata, NEVER a URL and never bytes
   *  (`mediaPolicy: "stable_metadata_only_no_signed_urls"`). */
  mediaRef: z.string().nullable(),
  mediaType: z.string().nullable(),
  mimeType: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationSeconds: z.number().nonnegative().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  isLocked: z.boolean().nullable(),
}).strict();

export const agentMessageSchema = z.object({
  pageLabel: z.string(),
  platform: platformEnum,
  conversationRef: z.string().min(1).max(500),
  messageRef: z.string().min(1).max(500),
  /** The vendor id is an unbounded bigint, so it is ALWAYS a string. A message
   *  whose ref is not numeric is never silently dropped here. */
  nativeMessageRef: z.string().nullable(),
  fanPlatformUserId: z.string().max(500).nullable(),
  senderPlatformUserId: z.string().max(500).nullable(),
  senderRole: agentSenderRoleEnum,
  direction: agentMessageDirectionEnum,
  isSentByMe: z.boolean(),
  occurredAt: agentIsoTimestamp.nullable(),
  state: agentMessageStateEnum,
  textPlain: z.string().nullable(),
  textHtml: z.string().nullable(),
  priceMills: mills.nullable(),
  isOpened: z.boolean().nullable(),
  isNew: z.boolean().nullable(),
  isTip: z.boolean().nullable(),
  tipAmountMills: mills.nullable(),
  tipTextPlain: z.string().nullable(),
  inReplyToRef: z.string().max(500).nullable(),
  replyMetadata: z.record(z.string(), agentScalar).nullable(),
  mediaMetadata: z.array(agentMessageMediaSchema),
  mediaCount: z.number().int().nonnegative().nullable(),
  originClass: z.string().nullable(),
  materialObservedAt: agentIsoTimestamp.nullable(),
  vendorChangedAt: agentIsoTimestamp.nullable(),
  sourceAccountSeq: z.number().int().nonnegative().nullable(),
  servingContractVersion: z.number().int().nonnegative(),
  backfillSource: z.string().nullable(),
  contentPending: z.boolean().nullable(),
  deletedAt: agentIsoTimestamp.nullable(),
  sourcePlane: agentPlaneNameEnum,
  fieldStates: z.partialRecord(agentClaimFieldEnum, agentFieldStateSchema),
  provenance: agentProvenanceSchema,
}).strict();

export const agentThreadMessagesResponseSchema = z.object({
  scope: z.object({
    pageLabel: z.string(),
    platform: platformEnum,
    conversationRef: z.string(),
    fanPlatformUserId: z.string().nullable(),
  }).strict(),
  window: z.object({ from: agentIsoTimestamp, to: agentIsoTimestamp }).strict(),
  items: z.array(agentMessageSchema).max(200),
  predicates: z.array(agentPredicateSchema),
  delivery: agentDeliverySchema,
  capture: agentCaptureSchema,
  conclusion: agentConclusionSchema,
}).strict().superRefine((value, ctx) =>
  addAgentIssues(agentEvidenceIssues(value, value.items.length), ctx));

// ---------------------------------------------------------------------------
// #7 agentSearchMessages
// ---------------------------------------------------------------------------

export const agentSearchMessagesBodySchema = z.object({
  q: z.string().min(2).max(200),
  from: agentIsoTimestamp.optional(),
  to: agentIsoTimestamp.optional(),
  platform: platformEnum.optional(),
  pageLabels: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
  person: z.object({
    platform: platformEnum,
    platformUserId: z.string().min(1).max(500),
  }).strict().optional(),
  conversationRefs: z.array(z.string().min(1).max(500)).max(50).optional(),
  direction: agentMessageDirectionEnum.optional(),
  senderRole: agentSenderRoleEnum.optional(),
  /** OPT-IN and off by default: this is the SECOND place verbatim material
   *  reaches an agent, so it needs the same `read:messages` capability as #6 and
   *  every call is audited with `verbatim_text: true` (owner ruling R-005). */
  includeSnippet: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(50),
  claim: agentClaimSchema.optional(),
}).strict().superRefine((value, ctx) =>
  addAgentIssues([
    ...agentWindowIssues(value),
    // #7 takes NO cursor (bound, do not paginate), so the window is flatly
    // required — there is no cursor that could be carrying it.
    ...(value.from === undefined || value.to === undefined
      ? [{ path: ["from"] as PropertyKey[], message: "`from` and `to` are required" }]
      : []),
  ], ctx));

export const agentSearchCaveatEnum = z.enum([
  /** Media-only messages have empty text, and in a customs audit the DELIVERY IS
   *  the media. Always true. */
  "text_search_misses_media_only_messages",
  /** The `simple` configuration does not stem and the corpus is Russian:
   *  "заплатил" will not find "заплатили". Always true. */
  "text_search_is_exact_form_only",
  "text_search_covers_message_archive_only",
  "trgm_extension_absent",
  "scope_narrowed_by_key_grant",
  "result_capped_at_limit",
]);

export const agentSearchLocatorSchema = z.object({
  pageLabel: z.string(),
  platform: platformEnum,
  conversationRef: z.string().nullable(),
  messageRef: z.string().min(1).max(500),
  occurredAt: agentIsoTimestamp.nullable(),
  senderRole: agentSenderRoleEnum,
  direction: agentMessageDirectionEnum,
  isSentByMe: z.boolean(),
  rank: z.number().finite().nonnegative(),
  /** Only when `includeSnippet` is true. A FLAT window of +/-120 characters
   *  around the first match, no `ts_headline`. Still requires `read:messages`. */
  snippet: z.string().max(300).nullable(),
  fieldStates: z.partialRecord(agentClaimFieldEnum, agentFieldStateSchema),
  provenance: agentProvenanceSchema,
}).strict();

export const agentSearchMessagesResponseSchema = z.object({
  backend: z.enum(["fts", "fts_trgm"]),
  /** MANDATORY and never empty: the first two caveats are always true (§6). */
  caveats: z.array(agentSearchCaveatEnum).min(2),
  items: z.array(agentSearchLocatorSchema).max(100),
  predicates: z.array(agentPredicateSchema),
  delivery: agentDeliverySchema,
  capture: agentCaptureSchema,
  conclusion: agentConclusionSchema,
}).strict().superRefine((value, ctx) =>
  addAgentIssues(agentEvidenceIssues(value, value.items.length), ctx));

// ---------------------------------------------------------------------------
// #8 agentCoverage
// ---------------------------------------------------------------------------

export const agentCoverageQuerySchema = z.object({
  from: agentIsoTimestamp.optional(),
  to: agentIsoTimestamp.optional(),
  platform: platformEnum.optional(),
  pageLabel: z.string().min(1).optional(),
  personPlatform: platformEnum.optional(),
  personPlatformUserId: z.string().min(1).max(500).optional(),
  conversationRef: z.string().min(1).max(500).optional(),
  limit: paginationQuerySchema.shape.limit,
  cursor: agentCursorString.optional(),
  ...agentClaimQuerySchema.shape,
}).strict().superRefine((value, ctx) =>
  addAgentIssues([
    ...agentWindowIssues(value),
    ...agentClaimQueryIssues(value),
    ...agentWindowCursorIssues(value),
    ...agentPairIssues(
      value.personPlatform,
      value.personPlatformUserId,
      ["personPlatform"],
      "personPlatform and personPlatformUserId are an atomic pair",
    ),
    ...(value.conversationRef !== undefined && value.pageLabel === undefined && value.cursor === undefined
      ? [{ path: ["pageLabel"] as PropertyKey[], message: "conversationRef requires pageLabel" }]
      : []),
  ], ctx));

/** Proof is quantified over EVERY page and conversation in scope: one proof on
 *  one thread grants no conclusion about ten. */
export const agentCoverageItemSchema = z.object({
  pageLabel: z.string(),
  platform: platformEnum,
  conversationRef: z.string().nullable(),
  fanPlatformUserId: z.string().nullable(),
  planes: z.array(agentPlaneSchema).length(AGENT_PLANE_COUNT),
  gapDetection: z.enum(["head_only", "verified"]),
  observedRowFloor: agentIsoTimestamp.nullable(),
  gaps: z.array(agentGapSchema),
  windowCovered: z.boolean(),
  fieldStates: z.partialRecord(agentClaimFieldEnum, agentFieldStateSchema),
  blockers: z.array(agentBlockerEnum),
}).strict().superRefine((value, ctx) => addAgentIssues(agentPlanesIssues(value), ctx));

export const agentCoverageResponseSchema = z.object({
  window: z.object({ from: agentIsoTimestamp, to: agentIsoTimestamp }).strict(),
  items: z.array(agentCoverageItemSchema).max(200),
  /** Journal-wide facts no per-thread item can carry. */
  journalFloor: z.object({
    /** Before this instant there is no verbatim journal and no replay can make
     *  one. On production it is 2026-07-05. */
    observationsFirstReceivedAt: agentIsoTimestamp.nullable(),
    detachedPartitions: z.array(z.string().min(1).max(64)),
  }).strict(),
  delivery: agentDeliverySchema,
  capture: agentCaptureSchema,
  conclusion: agentConclusionSchema,
}).strict().superRefine((value, ctx) =>
  addAgentIssues(agentEvidenceIssues(value, value.items.length), ctx));

// ---------------------------------------------------------------------------
// #9a agentObservations
// ---------------------------------------------------------------------------

export const agentObservationsQuerySchema = z.object({
  from: agentIsoTimestamp.optional(),
  to: agentIsoTimestamp.optional(),
  platform: platformEnum.optional(),
  pageLabel: z.string().min(1).max(200).optional(),
  source: agentObservationSourceEnum.optional(),
  /** Ingest accepts an OPEN kind, so this filter must too. */
  kind: z.string().min(1).max(200).optional(),
  producer: z.string().min(1).max(200).optional(),
  parseVersion: z.coerce.number().int().nonnegative().optional(),
  sortDir: sortDirEnum.default("desc"),
  limit: paginationQuerySchema.shape.limit,
  cursor: agentCursorString.optional(),
}).strict().superRefine((value, ctx) =>
  addAgentIssues([...agentWindowIssues(value), ...agentWindowCursorIssues(value)], ctx));

/** `payload` and `idempotencyKey` are ABSENT from this schema, not forbidden by a
 *  refinement: with `.strict()` an "envelope with a body" is inexpressible. */
export const agentObservationEnvelopeSchema = z.object({
  observationRef: z.number().int().positive(),
  receivedAt: agentIsoTimestamp,
  observedAt: agentIsoTimestamp.nullable(),
  source: agentObservationSourceEnum,
  producer: z.string().min(1).max(200),
  platform: platformEnum.nullable(),
  pageLabel: z.string().nullable(),
  nativeAccountRef: z.string().max(500).nullable(),
  kind: z.string().min(1).max(200),
  payloadBytes: z.number().int().nonnegative(),
  payloadSha256: agentSha256Hex,
  parseVersion: z.number().int().nonnegative(),
  canonicalized: z.boolean(),
  domainEventCount: z.number().int().nonnegative(),
  /** Whether this kind is allowlisted on 9b. NOT a promise of access: 9b still
   *  requires an owner session. */
  payloadAvailable: z.boolean(),
}).strict();

export const agentObservationsResponseSchema = z.object({
  window: z.object({ from: agentIsoTimestamp, to: agentIsoTimestamp }).strict(),
  items: z.array(agentObservationEnvelopeSchema).max(200),
  delivery: agentDeliverySchema,
  capture: agentCaptureSchema,
  conclusion: agentConclusionSchema,
}).strict().superRefine((value, ctx) =>
  addAgentIssues(agentEvidenceIssues(value, value.items.length), ctx));

// ---------------------------------------------------------------------------
// #9b agentObservationPayload — owner-session only
// ---------------------------------------------------------------------------

export const agentObservationParamsSchema = z.object({
  observationRef: z.coerce.number().int().positive(),
}).strict();

export const agentObservationPayloadQuerySchema = z.object({
  /** Goes into the audit row. R3's acceptance rests on it. */
  reason: z.string().min(1).max(500),
}).strict();

export const agentObservationWithheldReasonEnum = z.enum([
  "kind_not_allowlisted",
  "restricted_class",
  "partition_detached",
  "session_payload_budget_exhausted",
]);

export const agentObservationPayloadResponseSchema = z.object({
  observationRef: z.number().int().positive(),
  kind: z.string(),
  source: agentObservationSourceEnum,
  receivedAt: agentIsoTimestamp,
  payloadSha256: agentSha256Hex,
  /** null when the kind is not allowlisted: the ROW exists, the body does not.
   *  Absence never encodes a decision (invariant 4). */
  payload: z.record(z.string(), z.unknown()).nullable(),
  withheldReason: agentObservationWithheldReasonEnum.nullable(),
  scrubbed: z.object({
    signedUrlsRemoved: z.number().int().nonnegative(),
    secretsRedacted: z.number().int().nonnegative(),
    pathsRemoved: z.array(z.string().min(1).max(200)),
  }).strict(),
  auditRef: z.number().int().positive(),
  sessionPayloadReadsRemaining: z.number().int().nonnegative(),
  delivery: agentDeliverySchema,
  capture: agentCaptureSchema,
  conclusion: agentConclusionSchema,
}).strict().superRefine((value, ctx) =>
  addAgentIssues(agentEvidenceIssues(value, value.payload === null ? 0 : 1), ctx));

// ---------------------------------------------------------------------------
// #10 agentDatasetQuery
// ---------------------------------------------------------------------------

/** A CLOSED enum of the AVAILABLE datasets only: an unknown or merely PLANNED
 *  name is a static 400 from the boundary, before any SQL. Planned datasets are
 *  visible in the #1 catalog and not addressable here. */
export const agentPageDatasetParamsSchema = z.object({
  ...pageParamsSchema.shape,
  dataset: agentDatasetEnum,
}).strict();

/** `contains` and `between` are excluded on purpose: `contains` is an
 *  unindexable ILIKE (the trap §6 exists to avoid), and `between` is `gte`+`lte`. */
export const agentDatasetFilterOpEnum = z.enum([
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "is_null",
  "is_not_null",
]);

export const agentDatasetQueryBodySchema = z.object({
  from: agentIsoTimestamp.optional(),
  to: agentIsoTimestamp.optional(),
  filters: z.array(z.object({
    field: z.string().min(1).max(64).regex(/^[a-z][a-zA-Z0-9]*$/),
    op: agentDatasetFilterOpEnum,
    value: agentScalar.optional(),
  }).strict()).max(10).default([]),
  sort: z.array(z.object({
    field: z.string().min(1).max(64).regex(/^[a-z][a-zA-Z0-9]*$/),
    dir: sortDirEnum,
  }).strict()).max(2).default([]),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: agentCursorString.optional(),
  claim: agentClaimSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const issues = [...agentWindowIssues(value), ...agentWindowCursorIssues(value)];
  value.filters.forEach((filter, index) => {
    const needsNoValue = filter.op === "is_null" || filter.op === "is_not_null";
    if (needsNoValue && filter.value !== undefined) {
      issues.push({
        path: ["filters", index, "value"],
        message: `${filter.op} must not carry a value`,
      });
    }
    if (!needsNoValue && filter.value === undefined) {
      issues.push({ path: ["filters", index, "value"], message: `${filter.op} requires a value` });
    }
    if (filter.op === "in" && !Array.isArray(filter.value)) {
      issues.push({
        path: ["filters", index, "value"],
        message: "`in` requires an array value",
      });
    }
    if (filter.op !== "in" && Array.isArray(filter.value)) {
      issues.push({ path: ["filters", index, "value"], message: "an array value requires `in`" });
    }
  });
  if (value.cursor !== undefined && (value.filters.length > 0 || value.sort.length > 0)) {
    issues.push({ path: ["cursor"], message: "cursor pins the query; do not resend filters/sort" });
  }
  addAgentIssues(issues, ctx);
});

export const agentDatasetRowSchema = z.object({
  datasetRef: agentDatasetEnum,
  /** The row's stable key inside the dataset; also the keyset cursor component. */
  key: z.string().min(1).max(500),
  occurredAt: agentIsoTimestamp.nullable(),
  fanPlatformUserId: z.string().max(500).nullable(),
  /** A FLAT map into the closed scalar union. Nested structure is a registry
   *  limitation, stated rather than worked around. */
  fields: z.record(z.string().min(1).max(64), agentScalar),
  fieldStates: z.partialRecord(agentClaimFieldEnum, agentFieldStateSchema),
  provenance: agentProvenanceSchema,
}).strict();

export const agentDatasetQueryResponseSchema = z.object({
  datasetRef: agentDatasetEnum,
  pageLabel: z.string(),
  platform: platformEnum,
  window: z.object({ from: agentIsoTimestamp, to: agentIsoTimestamp }).strict(),
  items: z.array(agentDatasetRowSchema).max(200),
  predicates: z.array(agentPredicateSchema),
  delivery: agentDeliverySchema,
  capture: agentCaptureSchema,
  conclusion: agentConclusionSchema,
}).strict().superRefine((value, ctx) => {
  const issues = agentEvidenceIssues(value, value.items.length);
  value.items.forEach((item, index) => {
    if (item.datasetRef !== value.datasetRef) {
      issues.push({
        path: ["items", index, "datasetRef"],
        message: "every item must belong to the response dataset",
      });
    }
  });
  addAgentIssues(issues, ctx);
});

// ---------------------------------------------------------------------------
// The route registry. `routes.ts` spreads this into `routeSchemas`.
// ---------------------------------------------------------------------------

/**
 * POST-as-read: the explicit, reviewed allowlist (§4). These three are idempotent
 * and local; search is POST so the query text never reaches an access log. Every
 * other agentKey route is a GET, and a test pins exactly that.
 */
export const AGENT_POST_READ_OPERATIONS = [
  "agentResolve",
  "agentSearchMessages",
  "agentDatasetQuery",
] as const;

export const agentRouteSchemas = {
  agentCapabilities: {
    auth: { kind: "agentKey" },
    tags: ["agent"],
    summary: "Agent read plane: deployment capabilities, key grant, budgets, dataset catalog",
    response: {
      200: agentCapabilitiesResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      429: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  agentResolve: {
    auth: { kind: "agentKey" },
    tags: ["agent"],
    summary: "Resolve URLs, slugs, usernames and native ids to fan identities (tries every key)",
    body: agentResolveBodySchema,
    response: {
      200: agentResolveResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      429: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  agentPerson: {
    auth: { kind: "agentKey" },
    tags: ["agent"],
    // NO 404 BY CONTRACT (§5.6): a globally addressable fan answers 200 with
    // empty data plus scopeNarrowing, because a static 404 would collapse "no
    // such fan" into "the fan is on a page outside this key's grant" — the exact
    // mistake this plane exists to prevent. Do not "fix" it as a bug.
    summary:
      "One fan across every granted page: identity, memberships, threads, money, subscriptions."
      + " Never 404s: an out-of-grant fan answers 200-empty with scopeNarrowing (spec 5.6)",
    params: fanLookupParamsSchema,
    querystring: agentPersonQuerySchema,
    response: {
      200: agentPersonResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      429: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  agentPersonTimeline: {
    auth: { kind: "agentKey" },
    tags: ["agent"],
    summary:
      "Merged per-fan timeline across lanes (money, subscriptions, follows, message refs)."
      + " Never 404s: an out-of-grant fan answers 200-empty with scopeNarrowing (spec 5.6)",
    params: fanLookupParamsSchema,
    querystring: agentPersonTimelineQuerySchema,
    response: {
      200: agentPersonTimelineResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      429: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  agentThreads: {
    auth: { kind: "agentKey" },
    tags: ["agent"],
    summary: "Cross-page DM thread inventory with per-thread capture bounds",
    querystring: agentThreadsQuerySchema,
    response: {
      200: agentThreadsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      429: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  agentThreadMessages: {
    auth: { kind: "agentKey", scope: "page" },
    tags: ["agent"],
    summary: "Full-fidelity transcript for one thread, with capture bounds and per-row field states",
    params: agentPageConversationParamsSchema,
    querystring: agentThreadMessagesQuerySchema,
    response: {
      200: agentThreadMessagesResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      429: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  agentSearchMessages: {
    auth: { kind: "agentKey" },
    tags: ["agent"],
    summary: "Bounded full-text search over the message archive (Postgres FTS, no cursor)",
    body: agentSearchMessagesBodySchema,
    response: {
      200: agentSearchMessagesResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      429: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  agentCoverage: {
    auth: { kind: "agentKey" },
    tags: ["agent"],
    summary: "Capture-axis probe: what was ever captured for this scope and window",
    querystring: agentCoverageQuerySchema,
    response: {
      200: agentCoverageResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      429: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  agentObservations: {
    auth: { kind: "agentKey" },
    tags: ["agent"],
    summary: "Capture-journal envelopes (kind, source, timing, sizes, links) without payload bodies",
    querystring: agentObservationsQuerySchema,
    response: {
      200: agentObservationsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      429: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  agentObservationPayload: {
    auth: { kind: "owner-session" },
    tags: ["agent"],
    summary: "Owner-only verbatim observation payload (allowlisted kinds, scrubbed, audited)",
    params: agentObservationParamsSchema,
    querystring: agentObservationPayloadQuerySchema,
    response: {
      200: agentObservationPayloadResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      429: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  agentDatasetQuery: {
    auth: { kind: "agentKey", scope: "page" },
    tags: ["agent"],
    summary: "Typed query over one registered dataset for one page",
    params: agentPageDatasetParamsSchema,
    body: agentDatasetQueryBodySchema,
    response: {
      200: agentDatasetQueryResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      429: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
} as const;

export type AgentDelivery = z.infer<typeof agentDeliverySchema>;
export type AgentCapture = z.infer<typeof agentCaptureSchema>;
export type AgentConclusion = z.infer<typeof agentConclusionSchema>;
export type AgentPlane = z.infer<typeof agentPlaneSchema>;
export type AgentPlaneReason = z.infer<typeof agentPlaneReasonEnum>;
export type AgentBlocker = z.infer<typeof agentBlockerEnum>;
export type AgentGap = z.infer<typeof agentGapSchema>;
export type AgentRemedy = z.infer<typeof agentRemedySchema>;
export type AgentSourceError = z.infer<typeof agentSourceErrorSchema>;
export type AgentFieldState = z.infer<typeof agentFieldStateSchema>;
export type AgentFieldStateName = z.infer<typeof agentFieldStateEnum>;
export type AgentProvenance = z.infer<typeof agentProvenanceSchema>;
export type AgentPredicate = z.infer<typeof agentPredicateSchema>;
export type AgentCaptureFloor = z.infer<typeof agentCaptureFloorSchema>;
export type AgentCaptureCeiling = z.infer<typeof agentCaptureCeilingSchema>;
export type AgentCaptureBasis = z.infer<typeof agentCaptureBasisEnum>;
export type AgentProof = z.infer<typeof agentProofSchema>;
export type AgentScopeNarrowing = z.infer<typeof agentScopeNarrowingSchema>;
export type AgentClaimQuery = z.infer<typeof agentClaimQuerySchema>;
export type AgentIngestPath = z.infer<typeof agentIngestPathEnum>;
export type AgentThreadSummary = z.infer<ReturnType<typeof agentThreadSummarySchema>>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type AgentTimelineItem = z.infer<typeof agentTimelineItemSchema>;
export type AgentTimelineLane = z.infer<typeof agentTimelineLaneEnum>;
export type AgentCoverageItem = z.infer<typeof agentCoverageItemSchema>;
export type AgentObservationEnvelope = z.infer<typeof agentObservationEnvelopeSchema>;
export type AgentDatasetRow = z.infer<typeof agentDatasetRowSchema>;
export type AgentDatasetFilterOp = z.infer<typeof agentDatasetFilterOpEnum>;
export type AgentSearchCaveat = z.infer<typeof agentSearchCaveatEnum>;
export type AgentSearchLocator = z.infer<typeof agentSearchLocatorSchema>;
export type AgentCapabilitiesResponse = z.infer<typeof agentCapabilitiesResponseSchema>;
export type AgentPersonResponse = z.infer<typeof agentPersonResponseSchema>;
export type AgentResolveResponse = z.infer<typeof agentResolveResponseSchema>;
export type AgentPersonTimelineResponse = z.infer<typeof agentPersonTimelineResponseSchema>;
export type AgentThreadsResponse = z.infer<typeof agentThreadsResponseSchema>;
export type AgentThreadMessagesResponse = z.infer<typeof agentThreadMessagesResponseSchema>;
export type AgentSearchMessagesResponse = z.infer<typeof agentSearchMessagesResponseSchema>;
export type AgentCoverageResponse = z.infer<typeof agentCoverageResponseSchema>;
export type AgentObservationsResponse = z.infer<typeof agentObservationsResponseSchema>;
export type AgentObservationPayloadResponse = z.infer<typeof agentObservationPayloadResponseSchema>;
export type AgentDatasetQueryResponse = z.infer<typeof agentDatasetQueryResponseSchema>;
export type AgentPersonQuery = z.infer<typeof agentPersonQuerySchema>;
export type AgentPersonTimelineQuery = z.infer<typeof agentPersonTimelineQuerySchema>;
export type AgentThreadsQueryInput = z.infer<typeof agentThreadsQuerySchema>;
export type AgentThreadMessagesQuery = z.infer<typeof agentThreadMessagesQuerySchema>;
export type AgentCoverageQuery = z.infer<typeof agentCoverageQuerySchema>;
export type AgentObservationsQuery = z.infer<typeof agentObservationsQuerySchema>;
export type AgentResolveBody = z.infer<typeof agentResolveBodySchema>;
export type AgentSearchMessagesBody = z.infer<typeof agentSearchMessagesBodySchema>;
export type AgentDatasetQueryBody = z.infer<typeof agentDatasetQueryBodySchema>;
