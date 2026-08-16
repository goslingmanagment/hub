// G5 slice 1 — the content-addressed capture dual write, behind a default-off
// bounded canary.
//
// WHAT IT DOES. For a pull capture on a page named in
// `capture_cas_dual_write_pages`, the response body is also stored once in the
// content-addressed catalog (migration 0123) and the two envelopes that are
// about to be written — the `sync_raw_payloads` row and its `observations` row
// — carry a composite reference to that object. Nothing reads those references
// to serve a payload; the inline columns remain the authority for every reader
// in the system.
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
// SCOPE OF THE MATERIAL. This seam carries pull capture only: provider
// responses for DMs, transactions, fans and posts. Every one of them is
// ordinary, fan-bearing platform capture, so the lane is `platform_capture`
// (access_class `ordinary_capture`, erasure_domain `fan_subject`). RESTRICTED
// AI MATERIAL NEVER REACHES HERE — Stage 29 prompts and completions are written
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

/**
 * The canary gate, as published to this process.
 *
 * Not read from the database at the capture seam on purpose: a per-capture (or
 * even per-chunk) config read would be a new query on the hottest write path in
 * the system, paid whether the flag is on or off, and "off costs nothing" is
 * the property that makes a default-off slice safe to deploy. The value is
 * pushed here by the runtime heartbeat, which ALREADY loads the effective
 * config once a minute in every process (services/runtime-heartbeat.ts), so the
 * slice adds no query at all. The price is that a flip takes effect within one
 * heartbeat interval instead of instantly — the right trade for a canary whose
 * ramp is measured in days.
 */
let dualWritePagesCsv = "";

/** Called by the runtime heartbeat with the effective config value. */
export function publishCaptureCasDualWritePages(csv: string | undefined): void {
  dualWritePagesCsv = csv ?? "";
}

/** The value this process is currently acting on. Exported for telemetry and
 *  tests; the parity verifier uses it to decide whether there is anything to
 *  verify at all. */
export function getCaptureCasDualWritePages(): string {
  return dualWritePagesCsv;
}

/**
 * Is this page in the canary?
 *
 * FAILS CLOSED: empty (or all-whitespace) means NO pages — the same direction
 * as voiceNotesPageAllowlist and the OPPOSITE of fanslyNewStreamAllowlist,
 * where empty means every page. The difference is deliberate and it is the
 * whole safety property of this slice: an unset setting must never be read as
 * "dual-write the entire fleet".
 *
 * `*` means every page. Entries are trimmed, so " 12 , 34 " is the same list as
 * "12,34"; entries that are not a page id simply never match, because a
 * non-numeric entry cannot be a `platform_accounts.id` and guessing at what an
 * operator meant is not a safety behavior.
 */
export function captureCasDualWriteAllowed(
  allowlistCsv: string | undefined,
  pageId: number,
): boolean {
  const entries = (allowlistCsv ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return false;
  }
  if (entries.includes("*")) {
    return true;
  }
  return entries.includes(String(pageId));
}

export interface CaptureCasDualWriteCounters {
  /** Captures where the gate matched and a CAS write was attempted. */
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
}

const counters: CaptureCasDualWriteCounters = {
  attempted: 0,
  stored: 0,
  deduped: 0,
  codecRefused: 0,
  failed: 0,
};

export function getCaptureCasDualWriteCounters(): CaptureCasDualWriteCounters {
  return { ...counters };
}

/** Test seam: reset the published gate and the counters between cases. */
export function resetCaptureCasDualWriteForTests(csv?: string): void {
  dualWritePagesCsv = csv ?? "";
  counters.attempted = 0;
  counters.stored = 0;
  counters.deduped = 0;
  counters.codecRefused = 0;
  counters.failed = 0;
}

export interface CaptureCasPayloadRefs {
  raw: CapturePayloadRef | null;
  observation: CapturePayloadRef | null;
}

const NO_REFS: CaptureCasPayloadRefs = { raw: null, observation: null };

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
  /** platform_accounts.id — the canary's unit and the object's scope. */
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
  if (!captureCasDualWriteAllowed(dualWritePagesCsv, input.pageId)) {
    return NO_REFS;
  }

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

      return {
        raw: { bucketMonth: raw.bucketMonth, objectId: raw.objectId },
        observation: { bucketMonth: observation.bucketMonth, objectId: observation.objectId },
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
