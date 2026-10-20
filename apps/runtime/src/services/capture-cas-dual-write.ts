// G5 slice 1 — the content-addressed capture write.
//
// WHAT IT DOES. For every pull capture the response body is stored once in the
// content-addressed catalog (migration 0123), and the two envelopes that are
// about to be written — the `sync_raw_payloads` row and its `observations` row
// — carry a composite reference to that object and NO inline body
// (pointer-only). The per-page canaries that rolled this out
// (`capture_cas_dual_write_pages`, `capture_cas_pointer_only_pages`) are gone
// (2026-10-21): production ran both at `*` since 2026-08, and that is now the
// only behavior. If the catalog write fails, the capture writes its inline
// bodies exactly as before the slice (capture-first, below).
//
// THE STRUCTURE, and why it is neither "same transaction" nor "post-commit".
// The CAS write runs in its OWN transaction, BEFORE the two inline inserts, and
// its result is handed to them as an ordinary column value:
//
//     [ tx: catalog row + body + location ]  →  insertRawPayload(ref)
//                                            →  insertObservation(ref)
//
// Three properties fall out of that ordering, and each one is the reason for
// it:
//
//   1. CAPTURE-FIRST SURVIVES ABSOLUTELY (DP 7). Everything CAS can do wrong —
//      a codec refusal, a jsonb the catalog rejects, a missing partition, a
//      dead connection — happens before the inline write and is swallowed here.
//      The capture then proceeds byte-identically to the pre-slice code with
//      null references. Putting the CAS work in the SAME transaction as the
//      inline insert would have inverted this: a failed statement aborts the
//      whole PostgreSQL transaction (25P02), so no `try`/`catch` around the CAS
//      branch could have saved the capture. That is not a risk worth any amount
//      of referential tidiness.
//   2. NO SECOND ROW VERSION. Writing the reference as part of the INSERT costs
//      nothing. Doing it post-commit would mean an UPDATE on `observations` and
//      `sync_raw_payloads` — the two largest tables here — minting a second
//      heap tuple and its WAL for every capture. The project this slice belongs
//      to exists to REMOVE physical duplication; paying for a fresh row version
//      per capture to record a deduplication would be self-defeating.
//   3. THE ONLY COST OF THE ORDERING IS AN ORPHAN. If the capture fails after
//      the CAS commit, a catalog object survives with no envelope pointing at
//      it. That is harmless and cheap: the parity verifier only ever examines
//      rows that HAVE references, no reader can reach an unreferenced object,
//      and the next identical capture dedups straight onto it. §7 of the
//      architecture doc puts the object in Tx A ahead of the envelope for the
//      same reason.
//
// ONE `captureInstant` fixes the month bucket for BOTH bodies (§7 step 1), so a
// raw envelope and its observation can never straddle a UTC month boundary and
// end up addressing two different objects.
//
// POINTER-ONLY IS DECIDED ONLY ON SUCCESS. `pointerOnly` is set on the success
// return of putCaptureCasPayloads, where both references exist; every failure
// path returns NO_REFS, so a codec refusal or a dead connection still writes
// the inline body it always did. The worst case is BOTH copies, never none.
//
// SCOPE OF THE MATERIAL. This seam carries pull capture only: provider
// responses for DMs, transactions, fans and posts. Every one of them is
// ordinary, fan-bearing platform capture, so the lane is `platform_capture`
// (access_class `ordinary_capture`, erasure_domain `fan_subject`). RESTRICTED
// AI MATERIAL NEVER REACHES HERE — prompts and completions are written
// by the AI gateway into `ai_generation_content`, not through
// persistRawPayload — and it must never be added to this seam: it would then
// share an identity scope with ordinary capture and a coalesce could hand a
// restricted body to an ordinary reader. A future restricted writer gets its
// own seam and the `ai_generation` lane, which is a different access_class and
// therefore a structurally different object.

import {
  CapturePayloadCodecError,
  type CapturePayloadRef,
  type Database,
  putPayloadObject,
} from "@agency_hub_core/db";

export interface CaptureCasDualWriteCounters {
  /** Captures where a CAS write was attempted. */
  attempted: number;
  /** Attempts that produced at least one NEW catalog object. */
  stored: number;
  /** Attempts where every body was already in the catalog (the dedup working). */
  deduped: number;
  /** Attempts refused by the frozen codec (an unencodable payload). The
   *  capture still succeeded; only the catalog copy was skipped. */
  codecRefused: number;
  /** Attempts that failed for any other reason (jsonb rejection, missing
   *  partition, connection loss). Same outcome: capture intact, refs null. */
  failed: number;
  /** Attempts that stored a catalog copy, so the two inline bodies were left
   *  SQL NULL. Equal to `stored + deduped` — never `codecRefused` or `failed`,
   *  which have no reference to point at and therefore write inline. */
  pointerOnly: number;
  /**
   * Envelope inserts whose catalog object was ALREADY GONE when
   * the insert took its liveness lock — an erasure sweep took it in the gap
   * between the CAS commit and the insert. The envelope was then written with no
   * reference and WITH its inline body, so nothing was lost; this is the count
   * of how often the race that used to lose a fact actually fires.
   *
   * Expected to be zero outside an erasure window. A non-zero value while no
   * erasure has run is the signal that something ELSE is deleting catalog rows.
   */
  refVanished: number;
}

const counters: CaptureCasDualWriteCounters = {
  attempted: 0,
  stored: 0,
  deduped: 0,
  codecRefused: 0,
  failed: 0,
  pointerOnly: 0,
  refVanished: 0,
};

export function getCaptureCasDualWriteCounters(): CaptureCasDualWriteCounters {
  return { ...counters };
}

/**
 * Called by the capture seam when an envelope insert reported
 * that the catalog object its reference addressed was gone — the repositories
 * decide (they hold the lock), this only counts.
 *
 * It owns NO alarm, the same rule the read seam follows under #217: a
 * traffic-driven path cannot promise a clean pass. The durable consequence, if
 * there ever is one, is a dangling reference, and the hourly parity job's
 * `dangling_reference` census is what pages for that.
 */
export function noteCaptureCasRefVanished(count = 1): void {
  counters.refVanished += count;
}

/** Test seam: reset the counters between cases. */
export function resetCaptureCasDualWriteForTests(): void {
  counters.attempted = 0;
  counters.stored = 0;
  counters.deduped = 0;
  counters.codecRefused = 0;
  counters.failed = 0;
  counters.pointerOnly = 0;
  counters.refVanished = 0;
}

export interface CaptureCasPayloadRefs {
  raw: CapturePayloadRef | null;
  observation: CapturePayloadRef | null;
  /**
   * May the caller SKIP the inline bodies for this capture? True only on the
   * success return below, where both references above are non-null. Every
   * failure path returns NO_REFS, whose flag is false: no ref, no permission,
   * inline body written exactly as before the slice.
   */
  pointerOnly: boolean;
}

const NO_REFS: CaptureCasPayloadRefs = { raw: null, observation: null, pointerOnly: false };

type TransactionalDatabase = Database & {
  transaction?: (
    callback: (tx: unknown) => Promise<CaptureCasPayloadRefs>,
  ) => Promise<CaptureCasPayloadRefs>;
};

/**
 * One transaction around the whole CAS write, so a crash between the catalog
 * row and its body can never leave an object whose content cannot be proven.
 *
 * When the handle is already a transaction, drizzle's `.transaction` opens a
 * SAVEPOINT — which is what we want there too: a CAS failure then rolls back to
 * the savepoint and leaves the caller's transaction usable, instead of poisoning
 * it. A stub handle with no `.transaction` (unit tests) runs inline.
 */
async function withCasTransaction(
  db: Database,
  run: (tx: Database) => Promise<CaptureCasPayloadRefs>,
): Promise<CaptureCasPayloadRefs> {
  const transaction = (db as TransactionalDatabase).transaction;
  if (typeof transaction !== "function") {
    return run(db);
  }
  return transaction.call(db, (tx) => run(tx as Database));
}

export interface PutCaptureCasPayloadsInput {
  /** platform_accounts.id — the object's scope. */
  pageId: number;
  /** §7 step 1: fixed ONCE by the caller, before anything else. */
  captureInstant: Date;
  /** Exactly the value the raw envelope stores inline. */
  responsePayload: unknown;
  /** Exactly the value the observation stores inline — usually the same object
   *  reference as `responsePayload`, occasionally a quarantine envelope. */
  observationPayload: unknown;
}

/**
 * Store both bodies in the catalog and return the references the inline inserts
 * should carry. NEVER THROWS: every failure path returns null references, which
 * is a legal, unremarkable state.
 */
export async function putCaptureCasPayloads(
  db: Database,
  input: PutCaptureCasPayloadsInput,
): Promise<CaptureCasPayloadRefs> {
  counters.attempted += 1;
  try {
    return await withCasTransaction(db, async (tx) => {
      const raw = await putPayloadObject(tx, {
        representation: "canonical_json",
        json: input.responsePayload,
        captureInstant: input.captureInstant,
        lane: "platform_capture",
        platformAccountId: input.pageId,
      });
      // Reference equality, not a content compare: on the ordinary path the
      // observation journals the very same object the raw envelope stores, so
      // one put covers both. A quarantine envelope is a different object and
      // gets its own put — which the catalog will still collapse onto the same
      // row if the content happens to match.
      const observation = input.observationPayload === input.responsePayload
        ? raw
        : await putPayloadObject(tx, {
          representation: "canonical_json",
          json: input.observationPayload,
          captureInstant: input.captureInstant,
          lane: "platform_capture",
          platformAccountId: input.pageId,
        });

      if (raw.created || observation.created) {
        counters.stored += 1;
      } else {
        counters.deduped += 1;
      }

      // The pointer-only decision is made HERE and nowhere else: at this point
      // both bodies are proven on disk in the catalog, inside a transaction that
      // has done its work, so "the inline copy may be skipped" is a statement
      // about a fact.
      counters.pointerOnly += 1;

      return {
        raw: { bucketMonth: raw.bucketMonth, objectId: raw.objectId },
        observation: { bucketMonth: observation.bucketMonth, objectId: observation.objectId },
        pointerOnly: true,
      };
    });
  } catch (error) {
    // Capture-first is law. The inline write has not happened yet and MUST
    // happen exactly as it would have without this slice, so nothing here
    // rethrows and nothing here logs at error level: a payload the frozen codec
    // cannot encode is a known, expected outcome (lone surrogates, NUL escapes,
    // a runtime wrapper that is not plain JSON), not an incident.
    if (error instanceof CapturePayloadCodecError) {
      counters.codecRefused += 1;
    } else {
      counters.failed += 1;
    }
    return NO_REFS;
  }
}
