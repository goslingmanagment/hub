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
// WHERE A READ'S BYTES COME FROM
// ---------------------------------------------------------------------------
//
// The read mode setting (inline / shadow / serve) and its stepwise rollout are
// gone (2026-10-21): every process serves, which is what production ran since
// 2026-08. For one envelope:
//
//   * NO REFERENCE — the inline body, with no query. Rows captured before the
//     catalog existed, and any capture whose catalog write failed, look like
//     this. A row with neither an inline body nor a reference returns null as
//     it always did; migration 0128's CHECK makes that shape unwritable now.
//   * A REFERENCE AND AN INLINE BODY (dual-copy rows) — the catalog body. ANY
//     failure — object missing, body missing, wrong representation, codec
//     refusal, a dead connection — falls back to the inline body silently and
//     bumps a counter (`serveFellBack`).
//   * A REFERENCE AND NO INLINE BODY (pointer-only rows, every capture since
//     2026-08) — the catalog is the only copy and the authority of record. If
//     it cannot be read the seam RAISES `CapturePayloadUnavailableError`
//     instead of answering `null`, which is the word it reserves for "no body
//     was captured" (#223). These reads count as `servedNullInline`.
//
// THE READ PATH NEVER OWNS THE INCIDENT LATCH. The hourly verifier
// (services/capture-payload-parity.ts) stays the sole authority over the
// `capture_payload_parity` alarm; the read counters ride its telemetry line.
//
// COST: ONE catalog query per envelope that CARRIES a reference; an envelope
// with a null reference costs nothing. List readers resolve row by row, so a
// replay page of 200 referenced rows costs 200 extra queries.
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
  type CapturePayloadEnvelopeKind,
  type CapturePayloadRef,
  type Database,
  capturePayloadRefFromColumns,
  readEnvelopeCapturePayload,
  readEnvelopeCapturePayloadBatch,
  type EnvelopeCapturePayloadRead,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

/**
 * THE ONE FAILURE THIS SEAM CANNOT ABSORB: a row with no inline body whose
 * catalog copy could not be read.
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

/** Why a catalog body could not be used. The first three mirror the parity
 *  verifier's vocabulary on purpose — the two mechanisms must describe the same
 *  failure with the same word. */
export type CaptureCasReadMismatchReason =
  | "object_missing"
  | "body_missing"
  | "representation_mismatch"
  /** The catalog read itself threw (connection loss, anything unforeseen). */
  | "read_error";

export interface CaptureCasReadCounters {
  /** Dual-copy rows answered from the catalog body. */
  served: number;
  /** Dual-copy rows that fell back to the inline body. */
  serveFellBack: number;
  /** Pointer-only rows answered from the catalog (their only copy). */
  servedNullInline: number;
  /** The one genuinely bad outcome this seam can have: a row with no inline
   *  body whose catalog copy could not be read either. Since #223 the caller
   *  gets a `CapturePayloadUnavailableError`, never a null that reads as an
   *  absent fact. */
  nullInlineUnresolved: number;
}

const counters: CaptureCasReadCounters = {
  served: 0,
  serveFellBack: 0,
  servedNullInline: 0,
  nullInlineUnresolved: 0,
};

export function getCaptureCasReadCounters(): CaptureCasReadCounters {
  return { ...counters };
}

/** Test seam: reset the counters between cases. */
export function resetCaptureCasReadForTests(): void {
  counters.served = 0;
  counters.serveFellBack = 0;
  counters.servedNullInline = 0;
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

/** A row whose inline body is SQL NULL. `undefined` is folded in for the
 *  readers that omit the column entirely; both mean "this envelope has no
 *  inline bytes", and a JSON null body is stored as the jsonb scalar `null`,
 *  which node-postgres hands back as JS null too — indistinguishable here, and
 *  harmlessly so: for such a row the catalog copy IS `null` as well. */
function inlineAbsent(inline: unknown): boolean {
  return inline === null || inline === undefined;
}

/**
 * Resolve one envelope's payload (see the header for the three row shapes).
 *
 * THROWS EXACTLY ONE ERROR, AND ONLY FOR A ROW THAT HAS NOTHING TO FALL OPEN
 * TO: `CapturePayloadUnavailableError`, when a pointer-only row's single copy
 * cannot be read (#223, and the reasoning is on the class). For a row that
 * carries an inline body there is no failure path in which this function
 * throws.
 *
 * On key order and identity: a catalog answer is re-parsed from `jsonb`, so it
 * is a DIFFERENT object than the inline one. It is not a different VALUE: both
 * sides are stored as `jsonb`, which normalizes key order identically on both,
 * so even `JSON.stringify` over the two agrees (the rejournal path, which
 * re-hashes what it reads, depends on exactly that).
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
  // No reference: nothing to resolve. One null check and return — no query, no
  // allocation, no logger call.
  if (read.ref === null) {
    return read.inline;
  }
  const resolvable = read as CapturePayloadEnvelopeRead & { ref: CapturePayloadRef };

  // A pointer-only row: the catalog holds its only copy.
  if (inlineAbsent(read.inline)) {
    const stored = pointerRead ?? await loadCatalogBody(app.db, resolvable);
    if (stored.ok) {
      counters.servedNullInline += 1;
      return stored.json;
    }
    // There is no inline body to fall back TO. Still not an alarm (#217: the
    // read path owns no latch), and logged every time: a captured body is
    // currently unreachable. RAISED rather than returned (#223), because the
    // inline value here is `null`, and `null` is what this seam says for "no
    // body was captured".
    counters.nullInlineUnresolved += 1;
    const detail = {
      envelope: read.envelope,
      envelopeId: read.envelopeId,
      bucketMonth: resolvable.ref.bucketMonth,
      objectId: resolvable.ref.objectId,
      reason: stored.reason,
    };
    app.logger.warn(
      detail,
      "Capture payload has no inline body and its catalog copy could not be read",
    );
    throw new CapturePayloadUnavailableError(detail);
  }

  // A dual-copy row: the catalog body, falling open to the inline one.
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
 * Returns the SAME object when the seam resolved the same value (no reference,
 * or a fallback to the inline body), so the common path allocates nothing and
 * no field of an unfamiliar row shape can be lost to a spread.
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
 * path. The repository defers large bodies to the
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
