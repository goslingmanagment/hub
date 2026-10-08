// G5 slice 3b — the CATALOG plane of the Stage 28.4 erasure, and the only
// sanctioned deleter a capture payload body will ever have.
//
// WHY THIS FILE EXISTS. Slice 1 started copying every pull-capture body into
// the content-addressed catalog and slice 2 made readers serve from it. The
// erasure module reaches the INLINE plane only: it deletes the envelopes whose
// `observations.payload` carries the subject. Nothing has ever reached the
// catalog copy of those same bytes. Slice 3c stops writing inline bodies and
// rewrites history — the moment that lands, an erased fan's material would
// survive in the catalog with no governed act able to touch it. This file is
// the act, landed BEFORE the inline body can disappear.
//
// THE LAW IT IMPLEMENTS, and it is not a new one. Both earlier slices wrote it
// down before there was code for it:
//
//   migration 0123: "no refcount / reverse index for erasure. Erasure over a
//   SHARED body (a body may die only when the last surviving envelope
//   reference is gone, and the erasure scan has to substring-match whole
//   bodies) is explicitly out of scope here."
//
//   services/payload-reader.ts: "a shared body may not be rewritten under one
//   envelope's subject".
//
// So the catalog plane mirrors the inline plane exactly, and it does so by
// INHERITING THE MODULE'S OBSERVATION-EXCLUSIVITY LAW rather than inventing a
// second one:
//
//   * A body every one of whose envelopes this erasure deleted has no
//     surviving fact behind it. It is a copy of something that no longer
//     exists, and it dies with them. THAT is the deletion in this file.
//   * A body still referenced by a SURVIVING envelope is a bystander's fact.
//     The erasure module already refuses to delete a shared observation
//     (deleting a shared batch capture would orphan bystanders' lineage) and
//     counts it as reported residual risk instead. A shared BODY is the same
//     object under a different name and gets the same answer: kept, counted,
//     reported. It is also not rewritten — a filtered copy would (a) destroy
//     the bystander's captured bytes and (b) make the catalog disagree with the
//     inline column that decision #217 keeps as the authority of record, which
//     is precisely what the parity verifier pages about.
//
// PROOF, NOT ASSUMPTION. "No surviving reference" is decided by an actual
// `not exists` against BOTH envelope tables in the same statement that selects
// the deletion set, in the same transaction as the deletes, under the erasure
// fence. Migration 0127 gives that probe its index; without it the check would
// be a sequential scan of the largest table in the system per object.
//
// An envelope that left the attached table still needs its body: a tiered or
// superseded observations partition parked in `tiered_pending_drop` /
// `capture_pending_drop` is probed in the same statement (a detached partition
// keeps its 0127 index), and a reference only the Parquet lake still holds is
// handed in by the caller, which alone can read the lake (arena R4 review).
//
// IDEMPOTENT BY CONSTRUCTION. Every statement here is set-based over a
// caller-supplied candidate list and joins the catalog, so an object a previous
// run already deleted simply is not in any result. A re-run after a crash finds
// the remaining objects and continues; there is no "already deleted" error to
// handle because there is no per-object precondition to violate.

import { type SQL, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import type { CapturePayloadErasureDomain } from "./capture-payloads.ts";
import type { CapturePayloadRef } from "./capture-payloads.ts";

/**
 * The subject literals a fan erasure matches a body by.
 *
 * ONE definition, used by BOTH planes: the erasure module's inline
 * `payloadMatchPredSql` builds its `payload::text like` / `payload::text ~`
 * predicate from this, and the catalog scan below builds the identical
 * predicate over `capture_json_hot_bodies.body::text`. Two planes that disagree
 * about what "this body contains the subject" means would erase two different
 * sets, and the difference would be invisible until it mattered.
 */
export interface CapturePayloadErasureSubject {
  ref: string;
  wsRefs?: readonly string[];
  /** `%"<ref>"%` — the quoted-JSON form, always present. */
  quotedLike: string;
  /** The bare-numeric form with boundaries; null when the ref is not numeric. */
  numericBoundaryRegex: string | null;
}

export function capturePayloadErasureSubject(fanRef: string): CapturePayloadErasureSubject {
  return {
    ref: fanRef,
    quotedLike: `%"${fanRef}"%`,
    numericBoundaryRegex: /^\d+$/.test(fanRef)
      ? `[:\\[,[:space:]]${fanRef}[,}\\]]`
      : null,
  };
}

/** One catalog object an erasure has to answer for. NO BODY: see the note on
 *  `scanCapturePayloadObjectsForErasureSubject`. */
export interface CapturePayloadErasureMatch extends CapturePayloadRef {
  platformAccountId: number | null;
  erasureDomain: CapturePayloadErasureDomain;
  accessClass: string;
  representation: string;
  logicalBytes: number;
  /** Hex sha256 of the canonical bytes — the object's content fingerprint, for
   *  the tombstone journal. */
  contentSha256: string;
}

export interface CapturePayloadErasureScopeInput {
  /** The erasure's RESOLVED page ids (never a mutable label). */
  platformAccountIds: readonly number[];
  /**
   * Also consider objects whose `platform_account_id` is null — capture that
   * arrived before the account was mappable. A fan erasure includes them: an
   * unmapped body can carry the fan, and if no envelope survives to need it,
   * it is an orphaned copy of a deleted fact. A page/model erasure does NOT:
   * a null-account object is not provably this page's.
   */
  includeUnmappedAccounts: boolean;
  /**
   * Which erasure domains this scope is allowed to reach. `system` is never in
   * the list: it is the domain of auth-audit and operator-action capture, and
   * the erasure module's own audit trail is deliberately unreachable by a
   * re-run of itself.
   */
  erasureDomains: readonly CapturePayloadErasureDomain[];
}

/** Objects examined per keyset page. */
export const CAPTURE_PAYLOAD_ERASURE_SCAN_PAGE = 500;

function accountPredicate(scope: CapturePayloadErasureScopeInput) {
  const ids = [...scope.platformAccountIds];
  const mapped = ids.length > 0
    ? sql`o.platform_account_id in ${ids}`
    : sql`false`;
  return scope.includeUnmappedAccounts
    ? sql`(${mapped} or o.platform_account_id is null)`
    : mapped;
}

function domainPredicate(scope: CapturePayloadErasureScopeInput) {
  const domains = [...scope.erasureDomains];
  if (domains.length === 0) {
    return sql`false`;
  }
  return sql`o.erasure_domain in ${domains}`;
}

/**
 * Every catalog object in scope whose JSON body contains the subject —
 * or, when there is no subject (a page/model erasure erases the page's
 * capture wholesale), every catalog object in scope.
 *
 * IT RETURNS NO BODY, and that is deliberate. `tests/capture-payload-barrel.
 * test.ts` pins that a bare `(bucket_month, object_id)` never buys a body off
 * the package barrel; an "erasure needs to see bodies" reader would hand back
 * exactly that, restricted_ai material included. The subject match is DECIDED
 * IN SQL, inside the database, by the same predicate the inline plane uses, so
 * the answer this function returns — WHICH objects contain the subject — is
 * everything the erasure module actually needs. It never needs the bytes,
 * because it never rewrites them (see the module note).
 *
 * BOUNDED: keyset-paged by the catalog's own primary key `(bucket_month,
 * object_id)`, so the scan is a forward index walk of fixed-size pages no
 * matter how large the catalog grows.
 */
export async function scanCapturePayloadObjectsForErasureSubject(
  db: Database,
  input: CapturePayloadErasureScopeInput & {
    subject: CapturePayloadErasureSubject | null;
    pageSize?: number;
    /** Hard ceiling on the objects returned; a break-glass run that would have
     *  to walk more than this needs an operator, not a bigger array. */
    maxObjects?: number;
  },
): Promise<CapturePayloadErasureMatch[]> {
  const pageSize = Math.max(1, input.pageSize ?? CAPTURE_PAYLOAD_ERASURE_SCAN_PAGE);
  const maxObjects = Math.max(1, input.maxObjects ?? 100_000);
  const subject = input.subject;
  const bodyPredicate: SQL = subject === null
    ? sql`true`
    : sql`exists (
        select 1 from capture_json_hot_bodies b
        where b.bucket_month = o.bucket_month and b.object_id = o.object_id
          and (
            b.body::text like ${subject.quotedLike}
            or (b.body->>'codec'='fansly.ws.frame.v1'
              and exists(select 1 from jsonb_array_elements_text(${JSON.stringify(subject.wsRefs ?? [subject.ref])}::jsonb) as ref(value)
                where fansly_ws_json_contains(b.body->'frame',ref.value)))
            ${subject.numericBoundaryRegex === null
              ? sql``
              : sql`or b.body::text ~ ${subject.numericBoundaryRegex}`}
          )
      )`;

  const found: CapturePayloadErasureMatch[] = [];
  let cursor: { bucketMonth: string; objectId: number } | null = null;

  for (;;) {
    // o.bucket_month / o.object_id QUALIFIED in the ORDER BY: a bare column
    // name resolves to the SELECT alias first — the trap that shipped twice.
    const keyset: SQL = cursor === null
      ? sql`true`
      : sql`(o.bucket_month, o.object_id) > (${cursor.bucketMonth}::date, ${cursor.objectId})`;
    const page = await db.execute<{
      bucket_month: string;
      object_id: string;
      platform_account_id: string | null;
      access_class: string;
      erasure_domain: string;
      representation: string;
      logical_bytes: string;
      content_sha256: string;
    }>(sql`
      select to_char(o.bucket_month, 'YYYY-MM-DD') as bucket_month,
             o.object_id::text as object_id,
             o.platform_account_id::text as platform_account_id,
             o.access_class,
             o.erasure_domain,
             o.representation,
             o.logical_bytes::text as logical_bytes,
             encode(o.content_sha256, 'hex') as content_sha256
      from capture_payload_objects o
      where ${accountPredicate(input)}
        and ${domainPredicate(input)}
        and ${keyset}
        and ${bodyPredicate}
      order by o.bucket_month asc, o.object_id asc
      limit ${pageSize}
    `);

    for (const row of page.rows) {
      found.push({
        bucketMonth: row.bucket_month,
        objectId: Number(row.object_id),
        platformAccountId: row.platform_account_id === null ? null : Number(row.platform_account_id),
        erasureDomain: row.erasure_domain as CapturePayloadErasureDomain,
        accessClass: row.access_class,
        representation: row.representation,
        logicalBytes: Number(row.logical_bytes),
        contentSha256: row.content_sha256,
      });
    }
    const last: { bucket_month: string; object_id: string } | undefined = page.rows.at(-1);
    if (last === undefined || page.rows.length < pageSize) {
      break;
    }
    if (found.length >= maxObjects) {
      throw new Error(
        `capture payload erasure scan exceeded ${maxObjects} objects in scope — refusing to `
        + `build an unbounded plan; narrow the scope or raise the ceiling deliberately`,
      );
    }
    cursor = { bucketMonth: last.bucket_month, objectId: Number(last.object_id) };
  }

  return found;
}

/**
 * How many `exact_bytes` objects sit in this erasure's scope.
 *
 * The scan above matches a subject inside a JSON body. An `exact_bytes` object
 * holds wire octets that `::text like` cannot be applied to with the same
 * meaning, so it would be scanned by a DIFFERENT predicate — and no writer
 * produces one today (the webhook seam that will is a later slice). Rather than
 * silently under-erasing on the day that writer lands, the erasure module asks
 * this question and FAILS LOUDLY on a non-zero answer, the same stance as its
 * unmapped-foreign-key guard.
 */
export async function countCapturePayloadByteObjectsInErasureScope(
  db: Database,
  input: CapturePayloadErasureScopeInput,
): Promise<number> {
  const rows = await db.execute<{ n: string }>(sql`
    select count(*)::text as n
    from capture_payload_objects o
    where ${accountPredicate(input)}
      and ${domainPredicate(input)}
      and o.representation = 'exact_bytes'
  `);
  return Number(rows.rows[0]?.n ?? 0);
}

export interface CapturePayloadErasureDeletion extends CapturePayloadRef {
  contentSha256: string;
  logicalBytes: number;
}

export interface CapturePayloadErasureSweepResult {
  /** Objects whose last envelope reference was gone: body, location and
   *  catalog row deleted. */
  deleted: CapturePayloadErasureDeletion[];
  /** Objects a SURVIVING envelope still references — a bystander's fact.
   *  Reported, never touched. */
  retained: CapturePayloadRef[];
  /** Candidates that were no longer in the catalog when the batch ran (a
   *  previous run of this same erasure already took them). */
  alreadyGone: CapturePayloadRef[];
}

function candidateValues(refs: readonly CapturePayloadRef[]) {
  return sql.join(
    refs.map((ref, index) =>
      index === 0
        ? sql`(${ref.bucketMonth}::date, ${ref.objectId}::bigint)`
        : sql`(${ref.bucketMonth}, ${ref.objectId})`
    ),
    sql`, `,
  );
}

/**
 * THE SANCTIONED DELETER (DP 7). Deletes the body, the location row and the
 * catalog row of every candidate object that NO envelope references any more —
 * and nothing else.
 *
 * Enumerated in `tests/retention-deleters.test.ts` with the Stage 28 erasure
 * module: owner-initiated, never scheduled, reachable only from
 * `apps/runtime/src/services/erasure/**`, tombstoned in `erasure_log`.
 *
 * The proof and the deletes share ONE transaction (the caller's), so nothing
 * commits between "no envelope needs this" and "it is gone". The deletes run in
 * FK order — bodies and location first, then the catalog row whose
 * `ON DELETE RESTRICT` children they are — because 0123 made a catalog row
 * structurally unable to take its body with it by accident.
 *
 * THE RACE THIS USED TO ACCEPT IS NOW CLOSED (decision #222). The note that
 * stood here said a capture landing DURING the sweep could dedup onto an object
 * this batch is deleting, and called the outcome "a dangling reference, never a
 * lost captured fact" on #215's premise that the envelope still carried its body
 * inline. #220 removed that premise for a pointer-only page WITHOUT revisiting
 * the acceptance: from that slice on, the same interleaving destroyed the only
 * copy of a captured body while its envelope pointed at the hole.
 *
 * The fix is a strict order between the two acts, and the FIRST statement below
 * is half of it:
 *
 *   1. This sweep takes `FOR UPDATE` on every candidate object BEFORE it asks
 *      whether anything references them.
 *   2. A writer stamping a reference onto an envelope holds `FOR KEY SHARE` on
 *      that same object row until its insert commits
 *      (`lockCapturePayloadRefAlive`, taken by insertObservation and
 *      insertRawPayload).
 *
 * The two locks conflict, so one of exactly two things happens. Either the
 * writer got there first — then step 1 WAITS for its commit, and the verdict
 * statement, which under READ COMMITTED takes a fresh snapshot after that wait,
 * SEES the new envelope and keeps the body. Or this sweep got there first —
 * then the writer's probe waits for our commit, finds the object gone, and
 * writes its envelope with no reference and its body inline. There is no third
 * outcome and no window between them, which is why the deletes below no longer
 * need a second confirmation pass: a delay narrows a race, and this one is not
 * narrowed but ordered.
 *
 * The lock statement and the verdict MUST stay two statements in this order. As
 * one statement the verdict would be computed from the snapshot the statement
 * started with — i.e. from before the lock wait — which is exactly the stale
 * proof the fix exists to remove.
 *
 * `options.lakeReferenced` names the candidates a surviving Parquet-lake row
 * still references (the caller reads the lake after its own rewrite); they are
 * retained like any other referenced object. Parked observations partitions are
 * probed here, in the verdict statement.
 */
export async function deleteUnreferencedCapturePayloadObjects(
  db: Database,
  refs: readonly CapturePayloadRef[],
  options?: { lakeReferenced?: readonly CapturePayloadRef[] },
): Promise<CapturePayloadErasureSweepResult> {
  if (refs.length === 0) {
    return { deleted: [], retained: [], alreadyGone: [] };
  }

  const lakeReferenced = new Set(
    (options?.lakeReferenced ?? []).map((ref) => `${ref.bucketMonth}:${ref.objectId}`),
  );
  // Tiered (`tiered_pending_drop`) and superseded (`capture_pending_drop`)
  // observations partitions: their rows are envelopes until the owner drops
  // the table, and a pointer-only row there has no body but the catalog's.
  const parked = await db.execute<{ ref: string }>(sql`
    select format('%I.%I', n.nspname, c.relname) as ref
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('tiered_pending_drop', 'capture_pending_drop')
      and c.relkind = 'r'
      and c.relname like 'observations\\_%'
    order by n.nspname, c.relname
  `);
  const parkedReferenced = parked.rows.map((row) => sql`
             or exists (select 1 from ${sql.raw(row.ref)} e
                        where e.payload_bucket_month = c.bucket_month
                          and e.payload_object_id = c.object_id)`);

  const candidates = candidateValues(refs);
  // STEP 1 (#222). Sorted by the catalog's own primary key, the same stable
  // order the fence locks use, so two erasures can never deadlock on it.
  // Candidates a previous run already deleted simply return no row.
  await db.execute(sql`
    select o.bucket_month, o.object_id
    from capture_payload_objects o
    where (o.bucket_month, o.object_id) in (values ${candidates})
    order by o.bucket_month asc, o.object_id asc
    for update
  `);
  const verdicts = await db.execute<{
    bucket_month: string;
    object_id: string;
    present: boolean;
    referenced: boolean;
    content_sha256: string | null;
    logical_bytes: string | null;
  }>(sql`
    with candidate (bucket_month, object_id) as (values ${candidates})
    select to_char(c.bucket_month, 'YYYY-MM-DD') as bucket_month,
           c.object_id::text as object_id,
           (o.object_id is not null) as present,
           (
             exists (select 1 from observations e
                     where e.payload_bucket_month = c.bucket_month
                       and e.payload_object_id = c.object_id)
             or exists (select 1 from sync_raw_payloads e
                        where e.payload_bucket_month = c.bucket_month
                          and e.payload_object_id = c.object_id)
             ${sql.join(parkedReferenced, sql``)}
           ) as referenced,
           encode(o.content_sha256, 'hex') as content_sha256,
           o.logical_bytes::text as logical_bytes
    from candidate c
    left join capture_payload_objects o
      on o.bucket_month = c.bucket_month and o.object_id = c.object_id
  `);

  const deleted: CapturePayloadErasureDeletion[] = [];
  const retained: CapturePayloadRef[] = [];
  const alreadyGone: CapturePayloadRef[] = [];
  for (const row of verdicts.rows) {
    const ref = { bucketMonth: row.bucket_month, objectId: Number(row.object_id) };
    if (!row.present) {
      alreadyGone.push(ref);
      continue;
    }
    if (row.referenced || lakeReferenced.has(`${ref.bucketMonth}:${ref.objectId}`)) {
      retained.push(ref);
      continue;
    }
    deleted.push({
      ...ref,
      contentSha256: row.content_sha256 ?? "",
      logicalBytes: Number(row.logical_bytes ?? 0),
    });
  }

  if (deleted.length === 0) {
    return { deleted, retained, alreadyGone };
  }

  const doomed = candidateValues(deleted);
  await db.execute(sql`
    with target (bucket_month, object_id) as (values ${doomed})
    delete from capture_json_hot_bodies b
    using target t
    where b.bucket_month = t.bucket_month and b.object_id = t.object_id
  `);
  await db.execute(sql`
    with target (bucket_month, object_id) as (values ${doomed})
    delete from capture_byte_hot_bodies b
    using target t
    where b.bucket_month = t.bucket_month and b.object_id = t.object_id
  `);
  await db.execute(sql`
    with target (bucket_month, object_id) as (values ${doomed})
    delete from capture_payload_locations l
    using target t
    where l.bucket_month = t.bucket_month and l.object_id = t.object_id
  `);
  await db.execute(sql`
    with target (bucket_month, object_id) as (values ${doomed})
    delete from capture_payload_objects o
    using target t
    where o.bucket_month = t.bucket_month and o.object_id = t.object_id
  `);

  return { deleted, retained, alreadyGone };
}
