// G5 slice 3b — the erasure's CATALOG plane.
//
// The Stage 28.4 module has always reached exactly one copy of a captured body:
// the inline column. Slice 1 started writing a second copy into the
// content-addressed catalog and slice 2 made readers serve from it; slice 3c
// stops writing the inline copy at all and rewrites the heap. Between those two
// facts sits the reason this file exists: after 3c the catalog body is the ONLY
// body, so the erasure has to be able to reach it BEFORE the inline one can
// disappear. Landing it in the other order would leave a window in which an
// executed erasure quietly under-erases.
//
// WHAT IT DOES, in one sentence: it deletes every catalog body whose last
// envelope reference this same erasure just removed, and it counts (never
// touches) every catalog body a surviving envelope still needs.
//
// WHAT IT DELIBERATELY DOES NOT DO: rewrite a shared body into a
// subject-filtered copy. That was considered and rejected on two independent
// grounds, both of them already written down in this codebase before this slice
// existed:
//
//   1. BYSTANDER EXCLUSIVITY. The module's own recorded law is that an
//      observation is erased only when NO other fan's lineage references it,
//      "deleting a shared batch capture would orphan bystanders' lineage", and
//      shared survivors are counted and reported as residual risk. A shared
//      catalog BODY is that same object seen from the other side. Rewriting it
//      under one subject would destroy a bystander's captured bytes — the exact
//      act the inline plane refuses. services/payload-reader.ts states it
//      directly: "a shared body may not be rewritten under one envelope's
//      subject".
//   2. INLINE IS STILL THE AUTHORITY. Decision #217: the read seam's `serve`
//      mode "moves the byte source, never the truth". Every envelope that
//      references a body still carries that body inline today, so a filtered
//      catalog copy would make the two disagree — which is precisely the
//      condition the hourly parity verifier pages about (`content_mismatch`).
//      A slice that ships an alarm-triggering divergence by design is not a
//      slice, it is an incident with a decision number.
//
// So the catalog plane inherits the inline plane's verdicts rather than forming
// its own, and 0123's note — "a body may die only when the last surviving
// envelope reference is gone" — becomes executable here.
//
// ORDERING. The sweep runs in the SAME erasure run as the inline deletes, right
// after the delete transaction commits, so one erasure decision covers both
// planes from the operator's view and the reference counts it reads are the
// POST-delete truth. It cannot run inside that transaction: the deletes must be
// visible for "no surviving reference" to mean anything.
//
// RESUMABILITY. Every batch is its own transaction and every statement is
// set-based over the batch's candidate list. A crash mid-sweep leaves earlier
// batches committed and the rest untouched; re-running the erasure rescans,
// finds the objects that are still there, recomputes their references and
// continues. An object a previous run already deleted is simply absent from the
// scan — there is no "already deleted" error, because there is no per-object
// precondition to violate.

import {
  type CapturePayloadErasureDeletion,
  type CapturePayloadErasureMatch,
  type CapturePayloadErasureScopeInput,
  type CapturePayloadErasureSubject,
  type CapturePayloadRef,
  acquireErasureFenceExclusiveLocks,
  countCapturePayloadByteObjectsInErasureScope,
  deleteUnreferencedCapturePayloadObjects,
  scanCapturePayloadObjectsForErasureSubject,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";

type Db = Pick<AppContext, "db" | "logger">;

/**
 * Objects proved and deleted per transaction. Small on purpose: each batch
 * holds the erasure fence's exclusive locks over every page in scope for its
 * duration, and a break-glass act must not hold them for the length of a whole
 * catalog.
 */
export const CAPTURE_CATALOG_ERASURE_BATCH = 200;

export interface CapturePayloadCatalogWork {
  scope: CapturePayloadErasureScopeInput;
  /** Every catalog object this erasure has to answer for. */
  matches: CapturePayloadErasureMatch[];
}

export interface CapturePayloadCatalogSweepOutcome {
  examined: number;
  /** Objects whose last envelope reference was gone — body, location and
   *  catalog row deleted. */
  deleted: CapturePayloadErasureDeletion[];
  /** Objects a surviving envelope still references: a bystander's fact, kept
   *  and reported exactly like a shared observation. */
  retained: number;
  /** Objects a previous (crashed) run of this same erasure already took. */
  alreadyGone: number;
  deletedBytes: number;
}

/**
 * Which catalog objects are in scope for this erasure.
 *
 * FAN scope matches the subject inside the body, with the SAME literals the
 * inline matcher uses (one definition, `capturePayloadErasureSubject`), over
 * the one domain that may contain a fan (`fan_subject`), and it includes
 * objects with no platform account: unmapped capture is real, it can carry the
 * fan, and an unmapped body no envelope needs is an orphaned copy of a deleted
 * fact.
 *
 * PAGE/MODEL scope has no subject at all — the erasure removes the page's
 * capture wholesale — so every object scoped to those pages is a candidate,
 * across the two domains that hold captured platform material. `system` is in
 * neither list: it is the domain of auth-audit and operator-action capture, and
 * the erasure's own audit trail is deliberately unreachable by a re-run of
 * itself.
 */
export function capturePayloadCatalogScope(input: {
  scopeType: "fan" | "page" | "model";
  pageIds: readonly number[];
}): CapturePayloadErasureScopeInput {
  return input.scopeType === "fan"
    ? {
      platformAccountIds: input.pageIds,
      includeUnmappedAccounts: true,
      erasureDomains: ["fan_subject"],
    }
    : {
      platformAccountIds: input.pageIds,
      includeUnmappedAccounts: false,
      erasureDomains: ["fan_subject", "platform_account"],
    };
}

export async function buildCapturePayloadCatalogWork(
  app: Db,
  input: {
    scopeType: "fan" | "page" | "model";
    pageIds: readonly number[];
    subject: CapturePayloadErasureSubject | null;
  },
): Promise<CapturePayloadCatalogWork> {
  const scope = capturePayloadCatalogScope(input);

  // The subject scan reads JSON bodies as text. An `exact_bytes` object would
  // need a different predicate and no writer produces one yet (the webhook seam
  // that will is a later slice). Refuse loudly rather than silently
  // under-erase — the same stance as the unmapped-foreign-key guard.
  const byteObjects = await countCapturePayloadByteObjectsInErasureScope(app.db, scope);
  if (byteObjects > 0) {
    throw new Error(
      `${byteObjects} exact_bytes capture payload object(s) are in this erasure's scope and the `
      + "catalog subject scan only reads JSON bodies — extend the scan before erasing",
    );
  }

  return {
    scope,
    matches: await scanCapturePayloadObjectsForErasureSubject(app.db, {
      ...scope,
      subject: input.subject,
    }),
  };
}

/**
 * Delete every candidate object nothing references any more, in bounded
 * batches, each inside its own transaction under the erasure fence.
 *
 * The fence locks are the same ones the delete transaction takes: exclusive,
 * over every resolved page id, in sorted order (stable order prevents deadlocks
 * between two erasures). They serialize this sweep against the DM archive and
 * projection writers; they do NOT reach a concurrent CAPTURE, which takes no
 * fence lock at all.
 *
 * THE CAPTURE RACE IS HANDLED ONE LEVEL DOWN, and it is no longer a residual
 * (decision #222). `deleteUnreferencedCapturePayloadObjects` locks its candidate
 * objects `FOR UPDATE` before it proves anything, and the envelope writers hold
 * `FOR KEY SHARE` on the object until the insert that stamps the reference
 * commits — so the sweep either sees the reference and keeps the body, or the
 * writer finds the object gone and writes its body inline instead. The old note
 * here said the worst outcome was a dangling reference the parity verifier
 * reports; that was true under #215 and stopped being true under #220, when a
 * pointer-only row's reference became the only route to its body.
 */
export async function sweepCapturePayloadCatalog(
  app: Db,
  input: {
    scopeRef: string;
    pageIds: readonly number[];
    matches: readonly CapturePayloadErasureMatch[];
    batchSize?: number;
  },
): Promise<CapturePayloadCatalogSweepOutcome> {
  const batchSize = Math.max(1, input.batchSize ?? CAPTURE_CATALOG_ERASURE_BATCH);
  const outcome: CapturePayloadCatalogSweepOutcome = {
    examined: input.matches.length,
    deleted: [],
    retained: 0,
    alreadyGone: 0,
    deletedBytes: 0,
  };

  for (let offset = 0; offset < input.matches.length; offset += batchSize) {
    const batch: CapturePayloadRef[] = input.matches
      .slice(offset, offset + batchSize)
      .map((match) => ({ bucketMonth: match.bucketMonth, objectId: match.objectId }));

    const result = await app.db.transaction(async (tx) => {
      await acquireErasureFenceExclusiveLocks(tx as unknown as Db["db"], input.pageIds);
      return deleteUnreferencedCapturePayloadObjects(tx as unknown as Db["db"], batch);
    });

    outcome.deleted.push(...result.deleted);
    outcome.retained += result.retained.length;
    outcome.alreadyGone += result.alreadyGone.length;
    for (const deletion of result.deleted) {
      outcome.deletedBytes += deletion.logicalBytes;
    }
  }

  app.logger.info({
    scopeRef: input.scopeRef,
    examined: outcome.examined,
    deleted: outcome.deleted.length,
    retained: outcome.retained,
    alreadyGone: outcome.alreadyGone,
    deletedBytes: outcome.deletedBytes,
  }, "Erasure capture-catalog sweep complete");

  return outcome;
}

/** How many deleted-object identities the tombstone carries verbatim. Counts
 *  are always exact; the manifest is bounded so one erasure cannot write an
 *  unbounded jsonb document into erasure_log. */
export const CAPTURE_CATALOG_ERASURE_MANIFEST_LIMIT = 500;

/** The journal entry for the tombstone: exact counts plus a bounded manifest of
 *  WHICH bodies were destroyed (month, object id, content digest, size). */
export function capturePayloadCatalogJournal(outcome: CapturePayloadCatalogSweepOutcome) {
  const manifest = outcome.deleted.slice(0, CAPTURE_CATALOG_ERASURE_MANIFEST_LIMIT).map((entry) => ({
    bucketMonth: entry.bucketMonth,
    objectId: entry.objectId,
    contentSha256: entry.contentSha256,
    logicalBytes: entry.logicalBytes,
  }));
  return {
    capturePayloadObjectsExamined: outcome.examined,
    capturePayloadObjectsErased: outcome.deleted.length,
    capturePayloadObjectsKept: outcome.retained,
    capturePayloadObjectsAlreadyGone: outcome.alreadyGone,
    capturePayloadBytesErased: outcome.deletedBytes,
    capturePayloadObjectsErasedManifest: manifest,
    capturePayloadObjectsErasedManifestTruncated:
      outcome.deleted.length > CAPTURE_CATALOG_ERASURE_MANIFEST_LIMIT,
  };
}
