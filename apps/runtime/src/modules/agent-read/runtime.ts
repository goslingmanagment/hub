import type { Buffer } from "node:buffer";

import {
  AGENT_CLAIM_CLASSES,
  agentClaimFieldClass,
  agentClassPlanes,
  type AgentCapability,
  type AgentDelivery,
  type AgentFieldState,
  type AgentFieldStateName,
  type AgentPredicate,
  type AgentScopeNarrowing,
} from "@agency_hub_core/contracts";
import {
  bumpAgentKeyUsage,
  countAgentVisiblePages,
  insertAgentReadAudit,
  listAgentGrantPages,
  readArchiveGeneration,
  type AgentGrantPage,
  type Database,
} from "@agency_hub_core/db";
import type { AppConfig, Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../../services/effective-config.ts";
import type { AgentAuthPrincipal } from "../../services/auth.ts";
import { agentScopeFor } from "../../api/request-auth.ts";
import { AGENT_CONCURRENCY_LIMIT, acquireAgentSlot, assertWithinAgentBudget, releaseAgentSlot } from "./budget.ts";
import type { AgentCursorSigning } from "./cursors.ts";
import { AgentCapabilityMissingError, AgentPlaneDisabledError } from "./errors.ts";
import type { AgentPlaneMode } from "./epistemics.ts";

/**
 * The per-request scaffolding every agent operation shares: the ramp check, the
 * capability check, the concurrency slot, the atomic budget reservation, the page
 * grant, the cursor signing ring, and the audit row.
 *
 * ORDER MATTERS and is the reviewed one:
 *   plane mode -> capability -> concurrency slot -> budget reservation -> work.
 * A request refused for being disabled must not consume budget; a request refused
 * for budget must not have taken a slot it never releases.
 */

/** The count probe's ceiling: 0..5000 is exact, 5001 means "at least 5001". */
export const AGENT_COUNT_PROBE_MAX = 5001;

export const AGENT_TIMEOUT_MS = {
  /** inventory / search / control */
  short: 5_000,
  /** transcript / timeline / datasets */
  long: 10_000,
} as const;

/**
 * The platform capability table (spec §3). DATA, not branches. Every asymmetry
 * between the two platforms is declared HERE and looked up; a comparison against
 * a platform literal in a handler would both spend the platform-branch ratchet
 * and hide the asymmetry this table exists to publish.
 */
export const AGENT_PLATFORM_CAPABILITIES: Readonly<Record<Platform, {
  conversationIdSemantics: "equals_fan_id" | "separate_thread_id";
  hasCoverageProofs: boolean;
  capturesMediaMetadata: AgentFieldStateName;
  capturesMessagePrice: AgentFieldStateName;
  capturesPurchaseState: AgentFieldStateName;
  depthCap: { default: number; lifetimeSpender: number } | null;
  dmMessagesCadenceSeconds: number | null;
}>> = {
  fansly: {
    conversationIdSemantics: "separate_thread_id",
    hasCoverageProofs: false,
    // The raw message carries `attachments` and the page carries `accountMedia`,
    // and the whole page is journaled before parsing: the fact IS captured, it is
    // simply not parsed. Reporting "structurally absent" would stop an
    // investigation exactly where the data is.
    capturesMediaMetadata: "captured_unparsed",
    capturesMessagePrice: "not_captured",
    // `message.ppv_unlocked` canonicalizes and projects into nothing.
    capturesPurchaseState: "captured_unparsed",
    depthCap: { default: 200, lifetimeSpender: 1000 },
    dmMessagesCadenceSeconds: 86_400,
  },
  onlyfans: {
    conversationIdSemantics: "equals_fan_id",
    hasCoverageProofs: true,
    capturesMediaMetadata: "present",
    capturesMessagePrice: "present",
    capturesPurchaseState: "present",
    depthCap: null,
    // The lane is retired: migration 0097 force-pauses it.
    dmMessagesCadenceSeconds: null,
  },
};

/**
 * How informative a field state is. Merging two platforms takes the WEAKEST, the
 * same direction as invariant 6's "merged confidence is the MAX of the floors":
 * a scope is only as observable as its least observable member.
 */
const FIELD_STATE_STRENGTH: Readonly<Record<AgentFieldStateName, number>> = {
  present: 6,
  observed_empty: 5,
  captured_unparsed: 4,
  discarded_at_capture: 3,
  source_did_not_provide: 2,
  not_captured: 1,
  unknown: 0,
};

const NO_REMEDY: AgentFieldState = { state: "unknown", remedy: { kind: "none", reason: "no_remedy_exists" } };

function fieldStateFor(field: string, platform: Platform): AgentFieldState {
  const capabilities = AGENT_PLATFORM_CAPABILITIES[platform];
  if (field === "mediaMetadata") {
    return capabilities.capturesMediaMetadata === "captured_unparsed"
      ? { state: "captured_unparsed", remedy: { kind: "local_replay", costClass: "free", admissible: true, reason: null } }
      : { state: "present", remedy: { kind: "none", reason: "no_remedy_exists" } };
  }
  if (field === "priceMills") {
    return capabilities.capturesMessagePrice === "not_captured"
      ? { state: "not_captured", remedy: { kind: "none", reason: "no_remedy_exists" } }
      : { state: "present", remedy: { kind: "none", reason: "no_remedy_exists" } };
  }
  if (field === "purchaseState") {
    return capabilities.capturesPurchaseState === "captured_unparsed"
      ? { state: "captured_unparsed", remedy: { kind: "local_replay", costClass: "free", admissible: true, reason: "projection_missing" } }
      : { state: "present", remedy: { kind: "none", reason: "no_remedy_exists" } };
  }
  // A field whose class has no authoritative store cannot be observed at all.
  return agentClaimFieldClass(field) === undefined
    ? NO_REMEDY
    : { state: "present", remedy: { kind: "none", reason: "no_remedy_exists" } };
}

/**
 * `capture.scopeFieldStates` — computed from the platform capability table and
 * the capture paths covering the window, BEFORE any row is fetched.
 *
 * This is the fix for the subtlest failure in the whole design: hanging field
 * states on RETURNED RECORDS made the "every field of the conclusion is
 * observable" conjunct vacuously true on an EMPTY result, so `hasMedia=true`
 * returning zero rows would have proven that no media existed.
 */
export function computeScopeFieldStates(input: {
  fields: readonly string[];
  platforms: readonly Platform[];
  /** Fields whose class the key holds no capability for. */
  ungrantedFields?: readonly string[];
}): Record<string, AgentFieldState> {
  const ungranted = new Set(input.ungrantedFields ?? []);
  const states: Record<string, AgentFieldState> = {};
  const platforms = input.platforms.length > 0
    ? input.platforms
    : (Object.keys(AGENT_PLATFORM_CAPABILITIES) as Platform[]);

  for (const field of input.fields) {
    if (ungranted.has(field)) {
      states[field] = { state: "unknown", remedy: { kind: "none", reason: "capability_not_granted" } };
      continue;
    }
    let weakest: AgentFieldState | null = null;
    for (const platform of platforms) {
      const candidate = fieldStateFor(field, platform);
      if (
        weakest === null
        || FIELD_STATE_STRENGTH[candidate.state] < FIELD_STATE_STRENGTH[weakest.state]
      ) {
        weakest = candidate;
      }
    }
    states[field] = weakest ?? NO_REMEDY;
  }
  return states;
}

/**
 * The planes an operation consults for a claim: what it physically reads, UNION
 * the planes of the declared claim's classes.
 *
 * The union rather than the intersection, deliberately. A required plane the
 * operation does not read must still appear IN the set as `not_read`, because
 * that is exactly the fact that blocks the conclusion; intersecting it away would
 * quietly remove the blocker. Evidentiary planes in the set that were not read
 * are reported and do NOT block — that split is the registry's law, and it is
 * what stopped a money question from being refused because five MESSAGE planes
 * were unread.
 *
 * With no claim the set is simply what the operation reads; the conclusion is
 * `false` with `claim_not_declared` either way, but the planes stay honest.
 */
export function operationPlanesFor(
  physicallyRead: readonly string[],
  claimFields: readonly string[] | null,
): string[] {
  const planes = new Set<string>(physicallyRead);
  for (const field of claimFields ?? []) {
    const claimClass = agentClaimFieldClass(field);
    if (claimClass === undefined) {
      continue;
    }
    const classPlanes = agentClassPlanes(claimClass);
    for (const plane of [...classPlanes.required, ...classPlanes.evidentiary]) {
      planes.add(plane);
    }
  }
  return [...planes];
}

/**
 * Whether a proof lane exists for this claim at all.
 *
 * Only message claims on OnlyFans have one (`ofapi_message_coverage` is OF-only
 * by schema). For money the answer is a flat no, and saying so by name is the
 * difference between an honest "we cannot prove this" and a misleading list of
 * unread message planes.
 */
export function hasProofLaneForClaim(
  claimFields: readonly string[] | null,
  platforms: readonly Platform[],
): boolean {
  if (claimFields === null || claimFields.length === 0) {
    return false;
  }
  const classes = new Set(claimFields.map((field) => agentClaimFieldClass(field)));
  if (classes.size !== 1 || !classes.has("messages")) {
    return false;
  }
  return platforms.length > 0 && platforms.every((platform) =>
    AGENT_PLATFORM_CAPABILITIES[platform].hasCoverageProofs);
}

/** Every claim field of a class, for building `scopeFieldStates` per section. */
export function claimFieldsOfClass(claimClass: keyof typeof AGENT_CLAIM_CLASSES): string[] {
  return Object.keys(AGENT_CLAIM_CLASSES[claimClass].fields);
}

// ---------------------------------------------------------------------------
// Per-request lifecycle
// ---------------------------------------------------------------------------

export interface AgentRequestOptions {
  operation: string;
  /** Capabilities the operation REQUIRES; a missing one is a 403. */
  requiredCapabilities?: readonly AgentCapability[];
  /** Extra flag the operation is gated by, beyond the plane mode. */
  extraGate?: { enabled: boolean; reason: string } | undefined;
}

export interface AgentRequestScope {
  principal: AgentAuthPrincipal;
  config: AppConfig;
  planeMode: AgentPlaneMode;
  db: Database;
  /** The key's grant, resolved. NEVER `undefined` — that value means "everything". */
  pageIds: number[];
  pages: AgentGrantPage[];
  totalPages: number;
  archiveGeneration: number;
  signing: AgentCursorSigning;
  scopeNarrowing: AgentScopeNarrowing;
  has(capability: AgentCapability): boolean;
  /** Settles the row budget and releases the concurrency slot. Always called. */
  finish(rowsReturned: number): Promise<void>;
}

function cursorSigning(appContext: AppContext): AgentCursorSigning {
  // The cursor MAC reuses the deployment's encryption key ring: it is already
  // versioned, already rotated by the owner, and already required to be present.
  // A second secret would be a second thing to forget to rotate.
  const keysByVersion = new Map<number, Buffer>();
  for (const [version, key] of appContext.config.encryptionKeysByVersion) {
    keysByVersion.set(version, key);
  }
  return {
    key: appContext.config.encryptionKey,
    keyVersion: appContext.config.encryptionKeyVersion,
    keysByVersion,
  };
}

/**
 * Opens an agent request. Throws before doing any work when the plane is off, a
 * capability is missing, the key is at its concurrency ceiling, or the daily
 * budget is spent.
 */
export async function beginAgentRequest(
  appContext: AppContext,
  principal: AgentAuthPrincipal,
  options: AgentRequestOptions,
  requestedPageIds?: readonly number[],
): Promise<AgentRequestScope> {
  const db = appContext.db;
  const config = await loadEffectiveConfig(db, appContext.config);
  const planeMode: AgentPlaneMode = config.agentReadPlaneMode ?? "off";
  if (planeMode === "off") {
    throw new AgentPlaneDisabledError();
  }
  if (options.extraGate && !options.extraGate.enabled) {
    throw new AgentPlaneDisabledError(options.extraGate.reason);
  }

  const granted = new Set(principal.capabilities);
  for (const capability of options.requiredCapabilities ?? []) {
    if (!granted.has(capability)) {
      throw new AgentCapabilityMissingError(capability);
    }
  }

  acquireAgentSlot(principal.agentKeyId);
  let settled = false;
  try {
    const usage = await bumpAgentKeyUsage(db, { agentKeyId: principal.agentKeyId, requests: 1 });
    assertWithinAgentBudget(usage);

    const pageIds = agentScopeFor(principal, requestedPageIds);
    const [pages, totalPages, archiveGeneration] = await Promise.all([
      listAgentGrantPages(db, pageIds),
      countAgentVisiblePages(db),
      readArchiveGeneration(db),
    ]);

    return {
      principal,
      config,
      planeMode,
      db,
      pageIds,
      pages,
      totalPages,
      archiveGeneration,
      signing: cursorSigning(appContext),
      scopeNarrowing: {
        // Mandatory on every cross-page answer: a key granted 8 of 11 pages
        // silently narrows the result, and without this number an agent would
        // report "this fan never paid" about a payment on an invisible page.
        keyGrantExcludedPages: Math.max(0, totalPages - pages.length),
        totalPagesForQuery: totalPages,
      },
      has: (capability) => granted.has(capability),
      async finish(rowsReturned: number) {
        if (settled) {
          return;
        }
        settled = true;
        try {
          if (rowsReturned > 0) {
            await bumpAgentKeyUsage(db, {
              agentKeyId: principal.agentKeyId,
              rows: rowsReturned,
            });
          }
        } finally {
          releaseAgentSlot(principal.agentKeyId);
        }
      },
    };
  } catch (error) {
    releaseAgentSlot(principal.agentKeyId);
    throw error;
  }
}

/** Concurrency ceiling, re-exported so #1 can report it without importing budget. */
export { AGENT_CONCURRENCY_LIMIT };

/** Builds the delivery block. `returned` is the RECORD count of this response. */
export function buildDelivery(input: {
  returned: number;
  matched: { value: number; exact: boolean };
  cappedBy: "limit" | "snapshot" | "budget" | null;
  nextCursor: string | null;
  snapshotExhausted: boolean;
  caveats: Array<"mutable_sort_key">;
}): AgentDelivery {
  return {
    returned: input.returned,
    matchedInScope: {
      value: input.matched.value,
      exact: input.matched.exact,
      countBasis: "post_dedup",
    },
    cappedBy: input.cappedBy,
    nextCursor: input.nextCursor,
    snapshotExhausted: input.snapshotExhausted,
    caveats: input.caveats,
  };
}

/** The degenerate delivery of a control/singleton operation. */
export function singletonDelivery(returned: number): AgentDelivery {
  return buildDelivery({
    returned,
    matched: { value: returned, exact: true },
    cappedBy: null,
    nextCursor: null,
    snapshotExhausted: true,
    caveats: [],
  });
}

/**
 * Invariant 3: name every predicate the operation KNOWS ABOUT, applied or not,
 * with a reason. A flat list of applied names cannot distinguish "not applied"
 * from "not requested", and that difference is the point.
 */
export function buildPredicates(
  entries: ReadonlyArray<{
    name: string;
    requested: boolean;
    applied?: boolean;
    reason?: AgentPredicate["reason"];
  }>,
): AgentPredicate[] {
  return entries.map((entry) => {
    const applied = entry.applied ?? entry.requested;
    return {
      name: entry.name,
      requested: entry.requested,
      applied,
      reason: entry.reason ?? (applied ? "applied" : "not_requested"),
    };
  });
}

/** ISO-8601 with the explicit offset the plane's timestamp primitive requires. */
export function isoOrNull(value: Date | null | undefined): string | null {
  return value == null ? null : value.toISOString();
}

export function iso(value: Date): string {
  return value.toISOString();
}

/** The audit row for an operation that served verbatim material or a payload. */
export async function writeAgentAudit(
  db: Database,
  input: {
    agentKeyId?: number | null;
    sessionUserId?: number | null;
    operation: string;
    pageIds: number[];
    verbatimText: boolean;
    requestSummary?: Record<string, unknown>;
  },
): Promise<number> {
  const row = await insertAgentReadAudit(db, input);
  return row.id;
}
