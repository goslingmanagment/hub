// The payload read seam (G5 slices 0 and 2 — §6.3–§6.5 and §7 of
// investigations/storage-compaction-architecture-2026-08-11.md).
//
// THE CONTRACT, and it is the whole point of the module:
//
//   * Reads are ENVELOPE-AUTHORIZED. A caller names an observation or a raw
//     capture row — something it already has the right to see — and gets that
//     envelope's body. There is deliberately NO exported "load object id N"
//     entry point: an arbitrary object-id lookup is not a service API, because
//     one payload object may be shared by several envelopes and the object id
//     carries none of the authorization the envelope carries. The lookup by
//     (bucket_month, object_id) stays inside packages/db, reachable only
//     through `readEnvelopeCapturePayload`, which cannot be called without
//     naming the envelope class the reference was read off.
//   * Principal checks stay where they already are — at the route/CLI boundary
//     that decided this caller may read this envelope. The seam does not
//     re-derive authorization from the body it is about to return.
//   * Hot and cold must give ONE contract. Nothing above this module may learn
//     where a payload physically lives; that is the invariant the later cold
//     tier depends on.
//
// ---------------------------------------------------------------------------
// SLICE 2: THE THREE MODES, and the law that survives all of them
// ---------------------------------------------------------------------------
//
// `captureCasReadMode` (published to this process by the runtime heartbeat)
// decides where a read's bytes come from:
//
//   inline  — the inline columns, exactly as every reader did before slice 2.
//             ZERO extra queries, zero extra work: the mode check is one
//             process-local variable read and the function returns.
//   shadow  — callers still receive the INLINE bytes. Additionally, for an
//             envelope that carries a catalog reference, the catalog copy is
//             read and compared OCTET FOR OCTET against the inline body, and
//             the verdict is counted (and logged once per disagreement). This
//             is the hourly parity job made continuous and per-read, and it is
//             structurally incapable of changing a caller's result.
//   serve   — the catalog canonical body becomes the value callers receive.
//             ANY failure — object missing, body missing, wrong
//             representation, codec refusal, a dead connection — falls back to
//             the inline body silently and bumps a counter.
//
// FAIL OPEN TO INLINE, ALWAYS — WHEN THERE IS AN INLINE BODY TO FAIL OPEN TO.
// For a row that carries one, there is no mode and no failure path in which
// this seam throws, returns null where a body existed, or returns anything
// other than the inline body when it cannot prove a catalog body. (For a row
// that does NOT carry one — slice 3c-1 below — there is nothing to fail open to
// and the seam raises `CapturePayloadUnavailableError` instead of answering
// `null`, which is the sentence it reserves for "no body was captured": see
// #223 on that class.) For such a row the inline column remains the AUTHORITY
// OF RECORD in every mode, and
// `serve` moves only the byte source, never the truth. That asymmetry is why
// the upward transition is stepwise (see validateCaptureCasReadModeTransition):
// shadow must have proven equality on live traffic before serve is reachable.
//
// ---------------------------------------------------------------------------
// SLICE 3c-1: THE ROW WITH ONLY ONE COPY, and why the mode stops applying to it
// ---------------------------------------------------------------------------
//
// `capture_cas_pointer_only_pages` lets new captures on a listed page skip the
// inline write once the catalog copy is already on disk. Such a row's body
// exists in exactly one place, so:
//
//   * A NULL INLINE BODY RESOLVES FROM THE CATALOG IN EVERY MODE, `inline`
//     included. The mode is a PREFERENCE between two copies; it was never a
//     statement about what is reachable. Making reachability depend on it would
//     mean that rolling `capture_cas_read_mode` back to `inline` — the
//     designed-in escape hatch of the previous slice, the thing an operator
//     reaches for when something looks wrong — silently blanked every
//     pointer-only row in the system. The safety valve must not be the demolition
//     charge.
//   * FOR THAT ROW THE CATALOG IS THE AUTHORITY OF RECORD. There is no second
//     copy to be authoritative, and no comparison that could be run. `shadow`
//     therefore SKIPS such rows and counts them (`shadowSkippedNullInline`)
//     rather than scoring them as matched, and the hourly parity verifier does
//     the same with its own `skippedNullInline` count: "nothing to compare" is
//     not evidence of agreement, exactly as "nothing measured" has never been
//     evidence of a clean pass in this subsystem.
//   * THE FORCED READS ARE COUNTED SEPARATELY (`servedNullInline`) from the
//     preference-driven ones (`served`), because only the latter go away if the
//     mode is rolled back.
//   * A row with a NULL inline body AND no reference is a legacy shape that
//     returns null as it always did; migration 0128's CHECK makes it
//     unrepresentable for anything written since.
//
// THE READ PATH NEVER OWNS THE INCIDENT LATCH. A shadow mismatch counts and
// logs; it does NOT open or resolve the `capture_payload_parity` incident. The
// hourly verifier (services/capture-payload-parity.ts) stays the sole authority
// over that alarm's lifecycle, because an alarm needs an owner that runs on a
// known schedule, sees a bounded sample, and can say "measured and clean". A
// hot read path can do none of those: it fires at traffic's whim, so it can
// neither guarantee a clean pass (nothing to resolve the latch with during a
// quiet hour) nor bound how often it would re-page. Worse, a latch owned by two
// writers races — the verifier resolving what a concurrent read just opened.
// The read counters ride the verifier's telemetry line instead, so one log line
// still tells the whole story.
//
// COST, and what bounds it. shadow and serve each cost ONE catalog query per
// envelope that CARRIES a reference; an envelope with a null reference costs
// nothing in any mode. References exist only for pages in the slice-1
// dual-write canary, so the canary bounds the read cost too — the two ramps are
// deliberately coupled. List readers resolve row by row (no batch loader in
// this slice), so a replay page of 200 referenced rows costs 200 extra queries;
// that is the number the mode's costWarning quotes.
// Canonical webhook binding waits group up to eight pointer-only envelopes
// proven unable to append under the current binding map; mapped/export rows
// retain the single-row path. Bodies above 512 KiB logical JSON and
// all inline/dual-copy envelopes retain the single-row path. No body or failure
// result is retained across pages/runs, and parity counters keep per-row meaning.
//
// THE OTHER KIND OF READ, and where it went. Sites where Postgres digs INSIDE
// the body and returns a FIELD have no body for this seam to route, and they
// break the moment the inline column stops being written. G5 SLICE 3A
// (migrations 0125/0126) moved every one of them onto narrow typed columns
// populated at write time — the harvest lookups and the transaction-residue
// extraction in repositories/observations.ts, the `{tips}` narrowing in
// repositories/transaction-tip-contexts.ts, the agent plane's `payload_bytes`
// (now the catalog's own `logical_bytes` when a reference exists), and the
// coverage-revoke idempotency proof (which reads through
// `readEnvelopeCapturePayload` instead, being already inside packages/db). Each
// keeps an inline arm for pre-slice rows, marked `// CAS-INLINE-FALLBACK:` so
// the removal slice can grep them; the historical rewrite populates the columns
// as it walks the heap and only then may the arms go.
//
// STILL NOT MIGRATED, on purpose:
//   * apps/runtime/src/services/erasure/** — `payload::text like` subject
//     matching (services/erasure/index.ts payloadMatchPredSql). Subject
//     matching reads the WHOLE body as text and cannot be projected into a
//     column, so this seam can never route it. G5 SLICE 3B gave it the other
//     half instead: the catalog now has its own subject scan and its own
//     governed deleter (services/erasure/capture-catalog.ts), built on the
//     answer §6.1's refcount note implies — a shared body may NOT be rewritten
//     under one envelope's subject, so a body dies only when the last envelope
//     that referenced it is gone, and a body a bystander still needs is kept
//     and reported. The inline arm above stays because the inline column is
//     still the authority; it is the historical rewrite (slice 3c) that
//     finally takes it away, and that slice is now unblocked.
//
// ---------------------------------------------------------------------------
// THE CALL-SITE REGISTRY, and what each site does with an UNAVAILABLE body
// ---------------------------------------------------------------------------
//
// #217 migrated these sites and never wrote them down, which is why the null
// hazard #223 fixes went a whole slice without a per-site review. The list is
// here now, and the column that matters is the last one: a body that could not
// be read must never be recorded as an empty, parsed or absent fact.
//
//   propagate — the site's own failure handling already leaves the row for the
//               next pass (a per-row catch that counts `errored` and does NOT
//               stamp, a job that retries, a chunk that fails).
//   catch     — the site would otherwise settle something durable, so it
//               catches, counts, and moves on WITHOUT settling.
//   surface   — an API path: an explicit error to the caller.
//
//   modules/agent-read/handlers-journal.ts        surface (503, #223)
//   services/canonicalize-driver.ts               catch → skippedUnavailable
//   services/ofapi-capture-transport.ts           catch → unavailable
//   services/ofapi-capture-materialization.ts     propagate (per-row catch)
//   services/ofapi-dm-readthrough.ts              propagate (per-row catch)
//   services/ofapi-capture-jobs.ts                propagate (leased job retries)
//   services/projections/ai-acceptance.ts         propagate (watermark unmoved)
//   services/fansly-1970-repair.ts                propagate (per-row catch)
//   services/domain-events-enrich.ts              propagate (caller serves a
//                                                 thin frame and logs — the
//                                                 events module's own policy)
//   services/sync/executor-handlers.ts (×2)       propagate (chunk fails; the
//                                                 raw-payload cursor is NOT
//                                                 advanced past unread pages)
//   services/observations-rejournal.ts            propagate (the campaign
//                                                 ABORTS rather than insert an
//                                                 empty observation under a
//                                                 deterministic key)
//   services/observations-account-me-rejournal.ts catch → unavailableBody
//                                                 (the capture is skipped, never
//                                                 journaled empty; a re-run
//                                                 resumes)
//   sync/fansly/lib/chain-rebuild.ts              catch → body_unavailable
//                                                 (the journal page folds
//                                                 nothing and is counted; never
//                                                 read as an empty page, which
//                                                 would prove an end)
//
// One more site reads bodies without this seam, inside packages/db, and #223
// gave it the same law by hand: repositories/ofapi-message-coverage.ts, whose
// idempotency proof used to read an unavailable body as somebody else's proof.

import { sql } from "drizzle-orm";

import {
  CapturePayloadCodecError,
  type CapturePayloadEnvelopeKind,
  type CapturePayloadRef,
  type Database,
  canonicalizeCaptureJson,
  capturePayloadRefFromColumns,
  readEnvelopeCapturePayload,
  readEnvelopeCapturePayloadBatch,
  type EnvelopeCapturePayloadRead,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

export type CaptureCasReadMode = "inline" | "shadow" | "serve";

/**
 * THE ONE FAILURE THIS SEAM CANNOT ABSORB: a row with no inline body whose
 * catalog copy could not be read (decision #223).
 *
 * Every other failure here falls open to the inline column, which is why this
 * module could promise its callers it never throws. #220 broke the premise that
 * promise rested on — a pointer-only row has NO inline column to fall open to —
 * and until #223 the seam answered such a failure with the inline value it was
 * holding, which for that row is `null`. Callers cannot tell that `null` apart
 * from "this envelope captured no body", and they did not: the canonicalizers
 * produced zero events and the driver stamped `parse_version` forward, which
 * deletes the observation from every future replay as surely as a DROP would;
 * the re-journal hashed `null`, inserted it under a DETERMINISTIC idempotency
 * key and made the empty row permanent; the materializer and the readthrough
 * sweep stamped their own versions; the agent plane told the owner the payload
 * was withheld for its restriction class. A transient catalog blip — a dropped
 * connection, a partition not yet attached — became a permanent silently-empty
 * fact.
 *
 * SO THE ONE UNREPRESENTABLE ANSWER IS RAISED, NOT RETURNED. A sentinel value
 * would have to be checked, and the whole finding is that nobody checked. An
 * exception is the only shape whose DEFAULT behaviour at an unaudited call site
 * is loud: the batch fails, the job retries, the row stays unstamped. Every
 * migrated read site was audited for #223 and each one either propagates this
 * (its own failure handling already leaves the row for the next pass), catches
 * it to count and skip WITHOUT stamping, or maps it to an explicit 503.
 *
 * IT IS TRANSIENT AND MUST BE READ THAT WAY. Unparseable is permanent — a body
 * the parser will never understand. Unavailable is a body that is very probably
 * fine and momentarily out of reach, so no counter, no verdict and no version
 * stamp may treat the two as the same thing.
 */
export class CapturePayloadUnavailableError extends Error {
  override readonly name = "CapturePayloadUnavailableError";

  constructor(
    readonly detail: {
      envelope: CapturePayloadEnvelopeKind;
      envelopeId: number;
      bucketMonth: string;
      objectId: number;
      reason: CaptureCasReadMismatchReason;
      readMode: CaptureCasReadMode;
    },
  ) {
    super(
      `capture payload for ${detail.envelope} ${detail.envelopeId} is unavailable: it has no `
        + `inline body and its catalog copy (${detail.bucketMonth}/${detail.objectId}) could not `
        + `be read (${detail.reason})`,
    );
  }
}

/** Narrowing helper for the call sites that must handle the transient case
 *  themselves. `instanceof` across a bundling boundary is the usual hazard;
 *  the name check makes this total. */
export function isCapturePayloadUnavailable(
  error: unknown,
): error is CapturePayloadUnavailableError {
  return error instanceof CapturePayloadUnavailableError
    || (error instanceof Error && error.name === "CapturePayloadUnavailableError");
}

/**
 * The mode, as published to this process.
 *
 * Not read from the database at a read site, for the same reason the dual-write
 * gate is not (capture-cas-dual-write.ts): a config read per resolved payload
 * would be a new query on paths that resolve hundreds of rows at a time, paid
 * whether the mode is on or off, and "inline costs nothing" is the property
 * that makes this slice safe to deploy. The runtime heartbeat already loads the
 * effective config once a minute in every process, so the mode rides along for
 * free and a flip lands within one heartbeat interval.
 */
let readMode: CaptureCasReadMode = "inline";

/** Called by the runtime heartbeat with the effective config value. */
export function publishCaptureCasReadMode(mode: string | undefined): void {
  readMode = mode === "shadow" || mode === "serve" ? mode : "inline";
}

/** The mode this process is currently acting on. Exported for telemetry and
 *  tests. */
export function getCaptureCasReadMode(): CaptureCasReadMode {
  return readMode;
}

/** Why a catalog body could not be used. The first four mirror the parity
 *  verifier's vocabulary on purpose — the two mechanisms must describe the same
 *  failure with the same word — plus the two a per-read path can hit that a
 *  scheduled batch job reports differently. */
export type CaptureCasReadMismatchReason =
  | "object_missing"
  | "body_missing"
  | "representation_mismatch"
  | "content_mismatch"
  | "inline_uncanonicalizable"
  /** The catalog read itself threw (connection loss, a canonicalize refusal on
   *  the stored side, anything unforeseen). Never reaches the caller. */
  | "read_error";

export interface CaptureCasReadCounters {
  /** shadow: envelopes with a reference that were compared. */
  shadowChecked: number;
  /** shadow: comparisons where the catalog copy is octet-identical. */
  shadowMatched: number;
  /** shadow: comparisons that disagreed OR could not be completed. */
  shadowMismatched: number;
  /** serve: reads answered from the catalog body. */
  served: number;
  /** serve: reads that fell back to the inline body. */
  serveFellBack: number;
  /**
   * G5 slice 3c-1: reads answered from the catalog because the row HAS no
   * inline body (pointer-only), in whatever mode. Kept apart from `served` on
   * purpose — `served` counts a PREFERENCE the owner can roll back, this counts
   * a NECESSITY that a rollback cannot touch, and reading them as one number
   * would make a `serve → inline` rollback look like it had freed the system
   * from the catalog when it had not.
   */
  servedNullInline: number;
  /** shadow: null-inline rows, which have nothing to compare against. Counted
   *  instead of being folded into shadowMatched — see resolveCapturePayload. */
  shadowSkippedNullInline: number;
  /** The one genuinely bad outcome this seam can have: a row with no inline
   *  body whose catalog copy could not be read either. Since #223 the caller
   *  gets a `CapturePayloadUnavailableError`, never a null that reads as an
   *  absent fact. */
  nullInlineUnresolved: number;
}

const counters: CaptureCasReadCounters = {
  shadowChecked: 0,
  shadowMatched: 0,
  shadowMismatched: 0,
  served: 0,
  serveFellBack: 0,
  servedNullInline: 0,
  shadowSkippedNullInline: 0,
  nullInlineUnresolved: 0,
};

export function getCaptureCasReadCounters(): CaptureCasReadCounters {
  return { ...counters };
}

/** Test seam: reset the published mode and the counters between cases. */
export function resetCaptureCasReadForTests(mode?: CaptureCasReadMode): void {
  readMode = mode ?? "inline";
  counters.shadowChecked = 0;
  counters.shadowMatched = 0;
  counters.shadowMismatched = 0;
  counters.served = 0;
  counters.serveFellBack = 0;
  counters.servedNullInline = 0;
  counters.shadowSkippedNullInline = 0;
  counters.nullInlineUnresolved = 0;
}

/** One envelope's inline body and the catalog reference it carries (null for
 *  every row captured outside the dual-write canary, i.e. almost all of
 *  history). */
export interface CapturePayloadEnvelopeRead {
  envelope: CapturePayloadEnvelopeKind;
  /** The envelope row's own id — telemetry only; it never addresses a body. */
  envelopeId: number;
  inline: unknown;
  ref: CapturePayloadRef | null;
}

type SeamContext = Pick<AppContext, "db" | "logger">;

type CatalogRead =
  | { ok: true; json: unknown }
  | { ok: false; reason: CaptureCasReadMismatchReason };

function catalogReadResult(result: EnvelopeCapturePayloadRead): CatalogRead {
  switch (result.status) {
    case "loaded": return { ok: true, json: result.json };
    case "object_missing": return { ok: false, reason: "object_missing" };
    case "body_missing": return { ok: false, reason: "body_missing" };
    default: return { ok: false, reason: "representation_mismatch" };
  }
}

/** The single catalog read, with every throw already absorbed. Nothing above
 *  this function may fail because of the catalog. */
async function loadCatalogBody(
  db: Database,
  read: CapturePayloadEnvelopeRead & { ref: CapturePayloadRef },
): Promise<CatalogRead> {
  try {
    const result = await readEnvelopeCapturePayload(db, {
      envelope: read.envelope,
      ref: read.ref,
    });
    return catalogReadResult(result);
  } catch {
    return { ok: false, reason: "read_error" };
  }
}

/**
 * Octet-for-octet comparison through the frozen codec — never a digest
 * comparison, and never `===` on the parsed values. `jsonb` preserves neither
 * key order nor insignificant whitespace, so only the codec can decide whether
 * two stored bodies are the same content; and comparing digests would let a
 * (vanishingly unlikely, but the whole store is built to survive it) collision
 * pronounce two different bodies equal.
 */
async function compareShadow(
  db: Database,
  read: CapturePayloadEnvelopeRead & { ref: CapturePayloadRef },
): Promise<CaptureCasReadMismatchReason | null> {
  const stored = await loadCatalogBody(db, read);
  if (!stored.ok) {
    return stored.reason;
  }

  let inlineBytes: Buffer;
  try {
    inlineBytes = canonicalizeCaptureJson(read.inline);
  } catch (error) {
    return error instanceof CapturePayloadCodecError ? "inline_uncanonicalizable" : "read_error";
  }

  let storedBytes: Buffer;
  try {
    storedBytes = canonicalizeCaptureJson(stored.json);
  } catch {
    // The stored side failing the codec it was written by is not a codec
    // verdict about the inline fact; it is the catalog copy being unusable.
    return "read_error";
  }

  return Buffer.compare(storedBytes, inlineBytes) === 0 ? null : "content_mismatch";
}

/** A row whose inline body is SQL NULL. `undefined` is folded in for the
 *  readers that omit the column entirely; both mean "this envelope has no
 *  inline bytes", and a JSON null body is stored as the jsonb scalar `null`,
 *  which node-postgres hands back as JS null too — indistinguishable here, and
 *  harmlessly so: for such a row the catalog copy IS `null` as well. */
function inlineAbsent(inline: unknown): boolean {
  return inline === null || inline === undefined;
}

/**
 * Resolve one envelope's payload under the current read mode.
 *
 * Returns the inline body unless the mode is `serve` AND a catalog body was
 * proven readable — OR the row has NO inline body, which is answered from the
 * catalog in every mode (see below).
 *
 * THROWS EXACTLY ONE ERROR, AND ONLY FOR A ROW THAT HAS NOTHING TO FALL OPEN
 * TO: `CapturePayloadUnavailableError`, when a pointer-only row's single copy
 * cannot be read (#223, and the reasoning is on the class). For a row that
 * carries an inline body there is still no mode and no failure path in which
 * this function throws.
 *
 * On key order and identity: in `serve` the returned value is the catalog
 * body, re-parsed from `jsonb`, so it is a DIFFERENT object than the inline
 * one. It is not a different VALUE: both sides are stored as `jsonb`, which
 * normalizes key order identically on both, so even `JSON.stringify` over the
 * two agrees (the rejournal path, which re-hashes what it reads, depends on
 * exactly that and is pinned by a test).
 */
export async function resolveCapturePayload(
  app: SeamContext,
  read: CapturePayloadEnvelopeRead,
): Promise<unknown> {
  return resolveCapturePayloadRead(app, read);
}

async function resolveCapturePayloadRead(
  app: SeamContext,
  read: CapturePayloadEnvelopeRead,
  pointerRead?: CatalogRead,
): Promise<unknown> {
  const mode = readMode;
  // No reference: there is nothing to resolve in any mode, and this is still
  // almost every row in the system. One null check and return — no query, no
  // allocation, no logger call. A row with neither an inline body nor a
  // reference returns null exactly as it did before this slice; migration 0128's
  // CHECK makes that state unreachable for anything written since.
  if (read.ref === null) {
    return read.inline;
  }
  const resolvable = read as CapturePayloadEnvelopeRead & { ref: CapturePayloadRef };

  // ---------------------------------------------------------------------
  // G5 slice 3c-1 — THE NULL-INLINE LAW, and it sits ABOVE the mode switch.
  // ---------------------------------------------------------------------
  // A pointer-only row has no inline bytes at all: its body exists only in the
  // catalog. Resolving it must therefore NOT depend on `capture_cas_read_mode`,
  // because that setting's whole purpose is to be rolled back freely — and a
  // rollback to `inline` that blanked every pointer-only row would turn the
  // slice-2 safety valve into the most destructive lever in the system.
  //
  // So the mode governs the byte-source PREFERENCE for a row that has two
  // copies. It does not govern REACHABILITY for a row that has one. In `inline`
  // and in `shadow` alike, a null-inline row is served from the catalog, and
  // shadow additionally skips its comparison (comparing a body against nothing
  // has no verdict; counting it as `shadowMatched` would manufacture evidence
  // of parity out of a row that cannot demonstrate any).
  if (inlineAbsent(read.inline)) {
    if (mode === "shadow") {
      counters.shadowSkippedNullInline += 1;
    }
    const stored = pointerRead ?? await loadCatalogBody(app.db, resolvable);
    if (stored.ok) {
      counters.servedNullInline += 1;
      return stored.json;
    }
    // The one place in this seam where falling back to inline is not a safe
    // outcome — there is no inline body to fall back TO. Still not an alarm
    // (#217: the read path owns no latch), and still logged every time, unlike
    // a `serve` fallback: this says a captured body is currently unreachable,
    // which is a different sentence from "the fast path was unavailable".
    //
    // #223: and it is RAISED rather than returned, because returning the inline
    // value here returns `null`, and `null` is what this seam says for "no body
    // was captured". Handing the same answer to two opposite questions is how a
    // dropped connection became a permanently empty observation.
    counters.nullInlineUnresolved += 1;
    const detail = {
      envelope: read.envelope,
      envelopeId: read.envelopeId,
      bucketMonth: resolvable.ref.bucketMonth,
      objectId: resolvable.ref.objectId,
      reason: stored.reason,
      readMode: mode,
    };
    app.logger.warn(
      detail,
      "Capture payload has no inline body and its catalog copy could not be read",
    );
    throw new CapturePayloadUnavailableError(detail);
  }

  if (mode === "inline") {
    return read.inline;
  }

  if (mode === "shadow") {
    counters.shadowChecked += 1;
    let reason: CaptureCasReadMismatchReason | null;
    try {
      reason = await compareShadow(app.db, resolvable);
    } catch {
      // compareShadow already absorbs the known failures; this is the belt on
      // top of the braces, because a shadow read that throws would take down a
      // caller that was never supposed to notice shadow exists at all.
      reason = "read_error";
    }
    if (reason === null) {
      counters.shadowMatched += 1;
    } else {
      counters.shadowMismatched += 1;
      // ONE bounded line per disagreement: what disagreed and where, never the
      // body (an observation payload is fan material and this is a log).
      app.logger.warn({
        envelope: read.envelope,
        envelopeId: read.envelopeId,
        bucketMonth: resolvable.ref.bucketMonth,
        objectId: resolvable.ref.objectId,
        reason,
      }, "Capture payload shadow read disagrees with the inline fact");
    }
    // Unconditionally the inline body. Shadow cannot change an answer.
    return read.inline;
  }

  const stored = await loadCatalogBody(app.db, resolvable);
  if (stored.ok) {
    counters.served += 1;
    return stored.json;
  }
  // Silent by design: a fallback is a normal, safe outcome, not an incident,
  // and a per-read error log on a degraded catalog would drown the log before
  // anyone read it. The counter rides the hourly parity telemetry line.
  counters.serveFellBack += 1;
  return read.inline;
}

/**
 * The row form of {@link resolveCapturePayload}, for the many read sites that
 * hold a row carrying both the inline body and its reference.
 *
 * Returns the SAME object when the seam resolved the same value (mode `inline`,
 * or no reference, or a `serve` fallback), so the common path allocates
 * nothing and no field of an unfamiliar row shape can be lost to a spread.
 */
export async function resolveCapturePayloadRow<
  T extends { payload: unknown; payloadRef: CapturePayloadRef | null },
>(
  app: SeamContext,
  envelope: CapturePayloadEnvelopeKind,
  envelopeId: number,
  row: T,
): Promise<T> {
  const payload = await resolveCapturePayload(app, {
    envelope,
    envelopeId,
    inline: row.payload,
    ref: row.payloadRef,
  });
  return payload === row.payload ? row : { ...row, payload };
}

/** A page-scoped resolver for sequential replay. The caller supplies only
 * envelopes safe to prefetch; rows outside that set keep individual reads.
 * Pointer-only rows are read
 * in groups of at most eight; inline and dual-copy rows keep their ordinary
 * path, including shadow parity. The repository defers large bodies to the
 * single read. Results live only until their row is visited, never across a
 * page/run, so repaired references, bodies and availability are read afresh.
 * A failed batch falls back to per-row reads and their existing fault handling. */
export function createCapturePayloadRowResolver<
  T extends { id: number; payload: unknown; payloadRef: CapturePayloadRef | null },
>(app: SeamContext, envelope: CapturePayloadEnvelopeKind, rows: readonly T[]): (row: T) => Promise<T> {
  const positions = new Map(rows.map((row, index) => [row, index]));
  let batchStart = -1;
  let batchEnd = -1;
  let reads: Array<{ ref: CapturePayloadRef; read: CatalogRead } | undefined> = [];
  return async row => {
    const position = positions.get(row);
    if (position === undefined || row.payloadRef === null || !inlineAbsent(row.payload)) {
      return resolveCapturePayloadRow(app, envelope, row.id, row);
    }
    if (position < batchStart || position >= batchEnd) {
      batchStart = position;
      batchEnd = Math.min(rows.length, position + 8);
      reads = [];
      const candidates = rows.slice(batchStart, batchEnd).flatMap((candidate, offset) =>
        candidate.payloadRef !== null && inlineAbsent(candidate.payload)
          ? [{ offset, ref: { ...candidate.payloadRef } }]
          : []);
      if (candidates.length > 1) {
        try {
          const results = await readEnvelopeCapturePayloadBatch(app.db, {
            envelope, refs: candidates.map(entry => entry.ref),
          });
          for (const [index, result] of results.entries()) {
            if (result.status !== "deferred") reads[candidates[index]!.offset] = {
              ref: candidates[index]!.ref, read: catalogReadResult(result),
            };
          }
        } catch {
          // The normal per-envelope seam owns retryable read failures and
          // null-inline counters. One batch failure must not reject eight rows.
          reads = [];
        }
      }
    }
    const prefetched = reads[position - batchStart];
    const ref = row.payloadRef;
    const pointerRead = prefetched !== undefined && ref !== null
      && prefetched.ref.bucketMonth === ref.bucketMonth
      && prefetched.ref.objectId === ref.objectId ? prefetched.read : undefined;
    reads[position - batchStart] = undefined;
    const payload = await resolveCapturePayloadRead(app, {
      envelope, envelopeId: row.id, inline: row.payload, ref,
    }, pointerRead);
    return payload === row.payload ? row : { ...row, payload };
  };
}

export interface ObservationPayloadRead {
  observationId: number;
  /** The journal row's own received_at — a caller that needs a second,
   *  partition-exact read should use this pair rather than new Date(). */
  receivedAt: Date;
  source: string;
  kind: string;
  /** sha256 of the raw bytes the producer received, as captured. */
  payloadSha256: string;
  payload: unknown;
  /** The catalog reference this envelope carries, or null. */
  payloadRef: CapturePayloadRef | null;
}

/**
 * One observation's verbatim captured body, by observation id.
 *
 * Partition-spanning by construction (the caller has only the id). Each
 * partition satisfies it from its PK index; callers that already hold the
 * envelope's received_at should keep using the partition-exact repository
 * readers until a later slice unifies them here.
 */
export async function loadObservationPayload(
  app: SeamContext,
  observationId: number,
): Promise<ObservationPayloadRead | null> {
  const rows = await app.db.execute<{
    id: string;
    received_at: Date | string;
    source: string;
    kind: string;
    payload_sha256: string;
    payload: unknown;
    payload_bucket_month: string | null;
    payload_object_id: string | null;
  }>(sql`
    select o.id::text as id, o.received_at, o.source, o.kind,
           encode(o.payload_hash, 'hex') as payload_sha256, o.payload,
           to_char(o.payload_bucket_month, 'YYYY-MM-DD') as payload_bucket_month,
           o.payload_object_id::text as payload_object_id
    from observations o
    where o.id = ${observationId}
    limit 1
  `);
  const row = rows.rows[0];
  if (row === undefined) {
    return null;
  }
  const read: ObservationPayloadRead = {
    observationId: Number(row.id),
    receivedAt: new Date(row.received_at),
    source: row.source,
    kind: row.kind,
    payloadSha256: row.payload_sha256,
    payload: row.payload,
    payloadRef: capturePayloadRefFromColumns(row.payload_bucket_month, row.payload_object_id),
  };
  return resolveCapturePayloadRow(app, "observation", read.observationId, read);
}

export interface RawCaptureBodyRead {
  rawPayloadId: number;
  endpoint: string;
  payloadKind: string;
  capturedAt: Date;
  /** jsonb today; the union widens to Buffer when exact-byte bodies land. */
  payload: unknown;
  payloadRef: CapturePayloadRef | null;
}

/**
 * One raw capture envelope's body, by sync_raw_payloads primary key.
 *
 * `sync_raw_payloads` is unpartitioned and its body column is
 * `response_payload` (jsonb) — see migration 0000; no later migration changed
 * its columns.
 */
export async function loadRawCaptureBody(
  app: SeamContext,
  rawPayloadId: number,
): Promise<RawCaptureBodyRead | null> {
  const rows = await app.db.execute<{
    id: string;
    endpoint: string;
    payload_kind: string;
    captured_at: Date | string;
    response_payload: unknown;
    payload_bucket_month: string | null;
    payload_object_id: string | null;
  }>(sql`
    select rp.id::text as id, rp.endpoint, rp.payload_kind, rp.captured_at,
           rp.response_payload,
           to_char(rp.payload_bucket_month, 'YYYY-MM-DD') as payload_bucket_month,
           rp.payload_object_id::text as payload_object_id
    from sync_raw_payloads rp
    where rp.id = ${rawPayloadId}
    limit 1
  `);
  const row = rows.rows[0];
  if (row === undefined) {
    return null;
  }
  const read: RawCaptureBodyRead = {
    rawPayloadId: Number(row.id),
    endpoint: row.endpoint,
    payloadKind: row.payload_kind,
    capturedAt: new Date(row.captured_at),
    payload: row.response_payload,
    payloadRef: capturePayloadRefFromColumns(row.payload_bucket_month, row.payload_object_id),
  };
  return resolveCapturePayloadRow(app, "raw_payload", read.rawPayloadId, read);
}
