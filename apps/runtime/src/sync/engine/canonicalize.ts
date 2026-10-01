// Inline canonicalization of ONE observation inside the Fansly Sync Engine's
// apply transaction (design §3.7 tx 3, §3.11; capture map gap G3).
//
// The minutely driver (services/canonicalize-driver.ts) is untouched by this
// file: it keeps appending on its own pool handle and stamping separately, and
// it stays the backstop for anything this helper leaves unstamped. Both share
// the pure seam (services/canonicalize-drafts.ts), so an observation yields the
// same drafts whichever of them gets to it first, and the dedup keys make the
// second append a no-op either way.
//
// What differs is the transaction: every write here — partition gate, append,
// quarantine record, parse_version stamp — runs on the caller's `tx`, so the
// events commit (or roll back) together with the hot-table writes, the cursor
// and the attempt's `applied` mark. The append functions open a SAVEPOINT on a
// transaction handle; the `domain_event_seq` row lock they take is held until
// the caller commits, which is why the caller appends last (lock order §3.7).

import {
  appendDomainEvents,
  appendMixedDomainEvents,
  appendProjectionOnlyDomainEvents,
  assertDomainEventTargetMonthsAttached,
  type BlockedDomainEventTargetMonth,
  type Database,
  DomainEventTargetMonthsUnattachedError,
  listDetachedPartitionsHoldingAccount,
  listObservedPostRefsForCapture,
  markObservationParsed,
  recordObservationQuarantine,
} from "@agency_hub_core/db";

import type { CanonicalizerFamily } from "../../services/canonicalize/index.ts";
import type {
  CanonicalizableObservation,
  CanonicalEventDraft,
  CanonicalParseRejection,
} from "../../services/canonicalize/types.ts";
import { buildCanonicalDrafts, gateCanonicalObservation } from "../../services/canonicalize-drafts.ts";
import { MESSAGE_EVENT_TYPES } from "../../services/projections/message-archive.ts";

/** Two shapes only the driver appends: team-level export webhooks (one fact,
 * several accounts, each under its own fence) and the OFAPI post-like /
 * chat-queue material (fenced by its own material time). Neither is a Fansly
 * capture; refusing them keeps this helper one-account, one-append. */
const DRIVER_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "ofapi.post_like_observed",
  "ofapi.chat_queue_observed",
]);

export class DriverOnlyCanonicalizationError extends Error {
  constructor(observationId: number, shape: string) {
    super(`Observation ${observationId} (${shape}) is canonicalized by the minutely driver only`);
    this.name = "DriverOnlyCanonicalizationError";
  }
}

export interface InTransactionCanonicalizeContext {
  /** The page's own native account ref by page id: Fansly DM direction
   *  resolves against it (without it a DM page yields no events). The engine
   *  passes `new Map([[pageId, ownRef]])`. */
  nativeAccountRefByAccountId: ReadonlyMap<number, string | null>;
  /** The occurred_at window's upper edge; default: now. */
  now?: Date;
  /** Counts-only parser diagnostics, as the driver's. */
  diagnostics?: { record: (code: string) => void };
  /**
   * Drops a draft before the append — the apply's erasure fence (design §5.4
   * step 1: material of a fenced fan or chat never reaches the ledger). The
   * observation is still stamped: its remaining drafts are its whole outcome,
   * and a sweep must not append the dropped ones later.
   */
  excludeDraft?: (draft: CanonicalEventDraft) => boolean | Promise<boolean>;
}

interface AcceptedOutcome {
  /** Dedup keys of the appended-or-deduplicated drafts whose type the
   *  message archive consumes (excluded drafts never count). The caller reads
   *  the stored rows of these keys with `listDomainEventsByDedupKeys`. */
  messageDedupKeys: string[];
  /** Drafts `excludeDraft` dropped. */
  excluded: number;
}

export type InTransactionCanonicalizeResult =
  | (AcceptedOutcome & {
    /** Appended (or deduplicated) and parse_version stamped in `tx`. */
    outcome: "stamped";
    parseVersion: number;
    appended: number;
    deduped: number;
    /** The family's terminal quarantine code, recorded with the stamp. */
    quarantine: string | null;
  })
  | {
    /** The family's shape gate refused the payload: nothing written, the
     *  row stays unstamped for a future parser (the sweep reports it). */
    outcome: "rejected";
    rejection: CanonicalParseRejection;
  }
  | (AcceptedOutcome & {
    /** Drafts but no account: nothing written, unstamped. */
    outcome: "unmapped";
  })
  | (AcceptedOutcome & {
    /** A draft aims at a month with no attached domain_events partition
     *  (§3.2c(ii)): nothing written, unstamped until the recovery runs. */
    outcome: "partition_blocked";
    blocked: readonly BlockedDomainEventTargetMonth[];
  });

/**
 * Canonicalizes one observation in the caller's transaction:
 * shape gate → drafts (the shared pure seam) → partition gate → append by the
 * family's kind (projection-only / mixed / deliverable, with the driver's
 * checkpoint key `<source>:v<version>:checkpoint:<observationId>`) →
 * quarantine record or `parse_version` stamp. `observation.payload` must be
 * the resolved body (the engine passes the body it journaled).
 *
 * Safe to repeat: the dedup keys and the checkpoint key make a second run —
 * or the driver's run on the same observation — append nothing, and the
 * stamp only moves forward.
 */
export async function canonicalizeObservationInTransaction(
  tx: Database,
  family: CanonicalizerFamily,
  observation: CanonicalizableObservation,
  context: InTransactionCanonicalizeContext,
): Promise<InTransactionCanonicalizeResult> {
  if (observation.source === "webhook" && observation.kind.startsWith("data_exports.")) {
    throw new DriverOnlyCanonicalizationError(observation.id, observation.kind);
  }
  const shape = gateCanonicalObservation(family, observation);
  if (!shape.accepted) {
    context.diagnostics?.record(
      `canonicalize_rejected:${family.lane}:${shape.rejection.code ?? "unclassified"}`,
    );
    return { outcome: "rejected", rejection: shape.rejection };
  }
  let acceptedPostRefs: ReadonlySet<string> | undefined;
  if (family.replayContext === "accepted_posts") {
    // Same precondition as the driver's: the acceptance boundary is read from
    // the attached ledger, so a detached partition holding the page refuses.
    if (observation.accountId === null) throw new Error("OF post capture has no mapped page");
    if ((await listDetachedPartitionsHoldingAccount(tx, observation.accountId)).length > 0) {
      throw new Error("OF post replay requires the complete attached acceptance ledger");
    }
    acceptedPostRefs = new Set(await listObservedPostRefsForCapture(tx, observation.accountId, observation.id));
  }
  const { drafts, quarantine } = buildCanonicalDrafts(family, observation, {
    nativeAccountRefByAccountId: context.nativeAccountRefByAccountId,
    ...(context.diagnostics === undefined ? {} : { diagnostics: context.diagnostics }),
    ...(acceptedPostRefs === undefined ? {} : { acceptedPostRefs }),
    now: context.now ?? new Date(),
  }, shape);
  const driverOnly = drafts.find((draft) => DRIVER_ONLY_EVENT_TYPES.has(draft.type));
  if (driverOnly !== undefined) {
    throw new DriverOnlyCanonicalizationError(observation.id, driverOnly.type);
  }

  const kept: CanonicalEventDraft[] = [];
  for (const draft of drafts) {
    if (context.excludeDraft === undefined || !(await context.excludeDraft(draft))) {
      kept.push(draft);
    }
  }
  const accepted: AcceptedOutcome = {
    messageDedupKeys: [...new Set(kept
      .filter((draft) => MESSAGE_EVENT_TYPES.has(draft.type))
      .map((draft) => draft.dedupKey))],
    excluded: drafts.length - kept.length,
  };

  const accountId = observation.accountId;
  if (kept.length > 0 && accountId === null) {
    return { outcome: "unmapped", ...accepted };
  }

  let appended = 0;
  let deduped = 0;
  if (kept.length > 0 && accountId !== null) {
    const inputs = kept.map((draft) => ({ ...draft, observationId: observation.id }));
    try {
      // §3.2c(ii), BEFORE any write; the census is read on `tx`.
      await assertDomainEventTargetMonthsAttached(tx, inputs.map((input) => input.occurredAt));
    } catch (error) {
      if (error instanceof DomainEventTargetMonthsUnattachedError) {
        return { outcome: "partition_blocked", blocked: error.blocked, ...accepted };
      }
      throw error;
    }
    const checkpoint = {
      occurredAt: observation.receivedAt,
      observationId: observation.id,
      dedupKey: `${family.source}:v${family.version}:checkpoint:${observation.id}`,
    };
    const result = family.projectionOnly === true
      ? await appendProjectionOnlyDomainEvents(tx, accountId, inputs, checkpoint)
      : family.mixed === true
      ? await appendMixedDomainEvents(tx, accountId, inputs, checkpoint)
      : await appendDomainEvents(tx, accountId, inputs);
    appended = result.appended;
    deduped = result.deduped;
  }

  const stamp = {
    observationId: observation.id,
    receivedAt: observation.receivedAt,
    parseVersion: family.version,
  };
  if (quarantine !== null) {
    await recordObservationQuarantine(tx, {
      ...stamp,
      source: family.source,
      lane: family.lane,
      kind: observation.kind,
      reasonCode: quarantine.code,
    });
    context.diagnostics?.record(`canonicalize_quarantined:${family.lane}:${quarantine.code}`);
  }
  await markObservationParsed(tx, stamp);
  return {
    outcome: "stamped",
    parseVersion: family.version,
    appended,
    deduped,
    quarantine: quarantine?.code ?? null,
    ...accepted,
  };
}
