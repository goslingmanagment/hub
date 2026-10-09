import {
  countFanslyPublicLookupDemand,
  enqueueFanslyPublicLookupDeletedMarks,
  FANSLY_PUBLIC_LOOKUP_RECHECK_AFTER_MS,
  insertAuditEvent,
  pickFanslyPublicLookupBatch,
  readFanslyPublicLookupClocks,
  readFanslyPublicLookupProgress,
  readFanslyPublicLookupState,
  resumeFanslyPublicLookup,
  type Database,
  type FanslyPublicLookupCandidate,
  type FanslyPublicLookupDemand,
  type FanslyPublicLookupState,
} from "@agency_hub_core/db";
import { FANSLY_PUBLIC_ACCOUNT_LOOKUP_MAX_IDS } from "@agency_hub_core/fansly";
import type { AppConfig } from "@agency_hub_core/shared";

import { loadEffectiveConfig } from "../services/effective-config.ts";
import { describeFanslyPublicEgress, type FanslyPublicEgressView } from "../services/egress/fansly-public.ts";
import { applyLiveConfigPatches } from "../services/live-config.ts";
import type { SyncLogger } from "./engine/commit.ts";
import {
  PUBLIC_LOOKUP_DAY_BUDGET,
  PUBLIC_LOOKUP_IN_FLIGHT_BOUND_MS,
  publicLookupIncidents,
  publicLookupNextSendAt,
  type PublicLookupIncidents,
  type PublicLookupWaitReason,
} from "./fansly/public-lookup.ts";

// The owner's levers and views of the session-less public account reader
// (arena "vanished chat" R5, plan §7; the reader is fansly/public-lookup.ts):
//   pnpm cli sync public-lookup status | queue            read-only
//   pnpm cli sync public-lookup enable | disable --note   the live switch (audited as admin.config_update)
//   pnpm cli sync public-lookup resume --note             after a stop (audited; resolves the incident)
//   pnpm cli sync public-lookup recheck-marks --note      Р2 (а): enqueue the legacy deleted marks, once (audited)
// None of them sends a request to Fansly: the reader asks in its own pace.

export const SYNC_PUBLIC_LOOKUP_RESUME_AUDIT_EVENT = "admin.fansly_public_lookup_resume";
export const SYNC_PUBLIC_LOOKUP_RECHECK_AUDIT_EVENT = "admin.fansly_public_lookup_recheck_marks";

/** The owner's levers' errors (an expected refusal, printed as is). */
export class SyncPublicLookupLeverError extends Error {
  override name = "SyncPublicLookupLeverError";
}

type OwnerContext = { db: Database; config: AppConfig; rawConfig: AppConfig };

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function stateView(state: FanslyPublicLookupState) {
  return {
    stopped: state.stoppedAt !== null,
    stoppedAt: iso(state.stoppedAt),
    stopReason: state.stopReason,
    stopHttpStatus: state.stopHttpStatus,
    stopDetail: state.stopDetail,
    stopFirstBatch: state.stopFirstBatch,
    /** When the owner's incident for the stop was confirmed open (null while
     *  the reader still retries it). */
    stopIncidentAt: iso(state.stopIncidentAt),
    retryNotBefore: iso(state.retryNotBefore),
    /** An attempt admitted and not settled yet: nothing is sent until the
     *  reader settles it from its journal. */
    pendingSince: iso(state.pendingSince),
    firstAnswerAt: iso(state.firstAnswerAt),
    lastAnswerAt: iso(state.lastAnswerAt),
    resumedAt: iso(state.resumedAt),
  };
}

export interface SyncPublicLookupStatus {
  enabled: boolean;
  batchSize: number;
  egress: FanslyPublicEgressView;
  state: ReturnType<typeof stateView>;
  budget: {
    sentLastDay: number;
    dayBudget: number;
    lastSentAt: string | null;
    /** The earliest the next request may go (the jitter not counted), and what
     *  holds it; null `why`: now, if there is demand. */
    nextSendAt: string;
    holdsBy: PublicLookupWaitReason | null;
  };
  demand: { total: number; byDemand: Record<FanslyPublicLookupDemand, number> };
  progress: Awaited<ReturnType<typeof readFanslyPublicLookupProgress>>;
  /** What the reader does on its next pass, in words. */
  next: string;
}

function batchSizeOf(config: AppConfig): number {
  const size = Math.trunc(config.fanslyPublicLookupBatchSize ?? FANSLY_PUBLIC_ACCOUNT_LOOKUP_MAX_IDS);
  return Math.min(Math.max(size, 1), FANSLY_PUBLIC_ACCOUNT_LOOKUP_MAX_IDS);
}

/** `sync public-lookup status`: the switch, the egress, the stop, the budget,
 *  the demand and the re-check's progress. Read-only. */
export async function readSyncPublicLookupStatus(ctx: OwnerContext, input: { now?: Date } = {}): Promise<SyncPublicLookupStatus> {
  const now = input.now ?? new Date();
  const effective = await loadEffectiveConfig(ctx.db, ctx.rawConfig);
  const state = await readFanslyPublicLookupState(ctx.db);
  const egress = await describeFanslyPublicEgress(ctx);
  const clocks = await readFanslyPublicLookupClocks(ctx.db, { now, inFlightBoundMs: PUBLIC_LOOKUP_IN_FLIGHT_BOUND_MS });
  const next = publicLookupNextSendAt({
    now,
    clocks,
    settingMs: effective.fanslyDefaultDelayMs,
    u: 0,
    retryNotBefore: state.retryNotBefore,
  });
  const recheckBefore = new Date(now.getTime() - FANSLY_PUBLIC_LOOKUP_RECHECK_AFTER_MS);
  const demand = await countFanslyPublicLookupDemand(ctx.db, { recheckBefore });
  const progress = await readFanslyPublicLookupProgress(ctx.db);
  const enabled = effective.fanslyPublicLookupEnabled === true;
  const batch = batchSizeOf(effective);
  const words = (() => {
    if (!enabled) return "nothing: the reader is off (fanslyPublicLookupEnabled)";
    if (state.stoppedAt !== null) return `nothing: stopped (${state.stopReason ?? "?"}) until the owner resumes it`;
    if (state.pendingToken !== null) {
      return `settle the attempt admitted at ${iso(state.pendingSince)} from its journal, without a request`;
    }
    if (!egress.configured) return "nothing: no proxy of its own (sync public-lookup proxy set)";
    if (egress.sharedWithPages.length > 0) return `nothing: its proxy is a page's (${egress.sharedWithPages.join(", ")})`;
    if (demand.total === 0) return "nothing: no fan needs a check";
    return next.why === null
      ? `one request of up to ${batch} ids, now`
      : `one request of up to ${batch} ids at ${next.at.toISOString()} (held by ${next.why})`;
  })();
  return {
    enabled,
    batchSize: batchSizeOf(effective),
    egress,
    state: stateView(state),
    budget: {
      sentLastDay: clocks.sentLastDay,
      dayBudget: PUBLIC_LOOKUP_DAY_BUDGET,
      lastSentAt: iso(clocks.lastSentAt),
      nextSendAt: next.at.toISOString(),
      holdsBy: next.why,
    },
    demand,
    progress,
    next: words,
  };
}

/** `sync public-lookup queue`: the fans the next requests would ask about, in
 *  order, and why. Read-only. */
export async function readSyncPublicLookupQueue(
  ctx: OwnerContext,
  input: { limit: number; now?: Date },
): Promise<FanslyPublicLookupCandidate[]> {
  const now = input.now ?? new Date();
  return pickFanslyPublicLookupBatch(ctx.db, {
    limit: input.limit,
    recheckBefore: new Date(now.getTime() - FANSLY_PUBLIC_LOOKUP_RECHECK_AFTER_MS),
  });
}

/** `sync public-lookup enable | disable`: the live switch, through the
 *  console's own write path and audit (`admin.config_update`, source cli). */
export async function setSyncPublicLookupEnabled(
  ctx: Pick<OwnerContext, "db">,
  input: { enabled: boolean; note: string },
): Promise<{ version: number }> {
  const [result] = await applyLiveConfigPatches(ctx, {
    patches: [{ key: "fanslyPublicLookupEnabled", value: input.enabled }],
    note: `[cli] sync public-lookup ${input.enabled ? "enable" : "disable"}: ${input.note}`,
    actor: { userId: null, audit: { source: "cli", actorUserId: null } },
  });
  return { version: result!.version };
}

/**
 * `sync public-lookup resume`: clear the reader's stop (audited, one
 * transaction), then resolve its incident. A Retry-After still ahead stays:
 * the reader waits for it. Refused when the reader is not stopped.
 */
export async function resumeSyncPublicLookup(
  ctx: Pick<OwnerContext, "db"> & { logger: SyncLogger },
  input: { note: string; actor: string; at?: Date; incidents?: PublicLookupIncidents },
): Promise<{ resumed: ReturnType<typeof stateView>; retryNotBefore: string | null }> {
  const at = input.at ?? new Date();
  const before = await ctx.db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const stopped = await resumeFanslyPublicLookup(txDb, { at });
    if (stopped === null) return null;
    await insertAuditEvent(txDb, {
      source: "cli",
      eventType: SYNC_PUBLIC_LOOKUP_RESUME_AUDIT_EVENT,
      metadata: {
        actor: input.actor,
        note: input.note,
        stopReason: stopped.stopReason,
        stopHttpStatus: stopped.stopHttpStatus,
        stoppedAt: iso(stopped.stoppedAt),
        retryNotBefore: iso(stopped.retryNotBefore),
      },
    });
    return stopped;
  });
  if (before === null) {
    throw new SyncPublicLookupLeverError("the public account reader is not stopped: nothing to resume");
  }
  await (input.incidents ?? publicLookupIncidents(ctx)).resolve({ at });
  return {
    resumed: stateView(before),
    retryNotBefore: before.retryNotBefore !== null && before.retryNotBefore > at ? before.retryNotBefore.toISOString() : null,
  };
}

/**
 * `sync public-lookup recheck-marks` (owner decision Р2 (а)): every Fansly fan
 * carrying the legacy deleted mark joins the reader's queue — it only
 * enqueues (audited, counts only: no fan id outlives an erasure in the audit
 * log). The reader asks in its own pace; a found account loses the mark, a
 * missing one keeps it.
 */
export async function recheckSyncPublicLookupMarks(
  ctx: OwnerContext,
  input: { note: string; actor: string; at?: Date },
): Promise<{ enqueued: number; marks: number; alreadyPending: number; requests: number; batchSize: number }> {
  const at = input.at ?? new Date();
  const batchSize = batchSizeOf(await loadEffectiveConfig(ctx.db, ctx.rawConfig));
  return ctx.db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const result = await enqueueFanslyPublicLookupDeletedMarks(txDb, { at });
    await insertAuditEvent(txDb, {
      source: "cli",
      eventType: SYNC_PUBLIC_LOOKUP_RECHECK_AUDIT_EVENT,
      metadata: { actor: input.actor, note: input.note, ...result },
    });
    // The requests the queue costs at the current batch size.
    return { ...result, batchSize, requests: Math.ceil((result.enqueued + result.alreadyPending) / batchSize) };
  });
}
