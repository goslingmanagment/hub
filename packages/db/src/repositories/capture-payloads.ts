// Content-addressed capture payload store (G5 slice 0 — foundation).
//
// This is the write side of migration 0123's object model. NOTHING in
// production calls it yet: the slice exists so the dual-write slice is a pure
// call-site change against a repository that has already been proven by tests.
//
// The protocol implemented here is §7 of
// investigations/storage-compaction-architecture-2026-08-11.md, steps 1–2 plus
// the collision-safe upsert, with the adversarial-verification corrections:
//
//   1. ONE `captureInstant` fixes the month bucket before anything else, so a
//      raw envelope and its observation cannot land in different months across
//      a UTC boundary. The same instant becomes `first_seen_at`.
//   2. The security/erasure scope is decided by a NAMED capture-time classifier
//      (`classifyCapturePayloadScope`) — never inferred later from the body.
//   3. Versioned canonical bytes and their sha256 come from the frozen codec.
//   4. The digest only NARROWS the candidate set. Every candidate's stored body
//      is fetched and compared in full; a differing body under the same digest
//      takes the next `collision_ordinal` and keeps its own body row. The
//      capture is never rolled back and never coalesced onto a lookalike.
//
// MONTH SCOPE: a closed capture month is ref-closed. The same content captured
// in a new month is a NEW object — by design, so every cold segment is
// self-contained (§6.2).
//
// OUT OF SCOPE HERE (later slices): reference columns on the envelope tables
// (slice 1, migration 0124) and any backfill.
//
// THE ERASURE INTERPLAY LANDED in G5 slice 3b and lives NEXT DOOR, in
// capture-payload-erasure.ts: the whole-body subject scan, the surviving-
// reference proof, and the one sanctioned deleter of a capture body. It is a
// separate file precisely so this one — the write path — issues no SQL
// deletion at all and stays out of tests/retention-deleters.test.ts.

import { is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";

import {
  type CapturePayloadRepresentation,
  canonicalizeCaptureJson,
  capturePayloadCodecVersionFor,
  digestCapturePayload,
} from "../capture-payload-codec.ts";
import type { Database } from "../client.ts";

/**
 * Who may read a body. Enumerated in exactly two places — here and migration
 * 0123's CHECK constraint — and the two must agree.
 *
 * - `ordinary_capture` — platform capture material (webhook bodies, pull
 *   responses, command results). The ordinary envelope-authorized read path.
 * - `restricted_ai` — the Stage 29 restricted class: verbatim prompts and
 *   completions, owner-only routes. Its own class SO THAT IT CAN NEVER SHARE A
 *   BODY ROW WITH ORDINARY CAPTURE, no matter how identical the bytes are. A
 *   coalesce here would hand restricted material to an ordinary reader.
 * - `operator_audit` — auth/authorization audit capture: principal-bearing,
 *   typically with no platform account at all.
 */
export const CAPTURE_PAYLOAD_ACCESS_CLASSES = [
  "ordinary_capture",
  "restricted_ai",
  "operator_audit",
] as const;
export type CapturePayloadAccessClass = (typeof CAPTURE_PAYLOAD_ACCESS_CLASSES)[number];

/**
 * Which erasure sweep is allowed to rewrite a body later.
 *
 * - `fan_subject` — may contain fan-subject material (DMs, transactions, fan
 *   profiles, AI transcripts); a fan erasure must be able to reach it.
 * - `platform_account` — account/page-level state with no fan subject inside.
 * - `system` — no subject at all; no subject erasure may rewrite it.
 */
export const CAPTURE_PAYLOAD_ERASURE_DOMAINS = [
  "fan_subject",
  "platform_account",
  "system",
] as const;
export type CapturePayloadErasureDomain = (typeof CAPTURE_PAYLOAD_ERASURE_DOMAINS)[number];

export const CAPTURE_PAYLOAD_STORAGE_TIERS = ["hot", "cold"] as const;
export type CapturePayloadStorageTier = (typeof CAPTURE_PAYLOAD_STORAGE_TIERS)[number];

/**
 * The capture lane a payload arrived through. This — not the body, not the
 * table it will be referenced from — is what the classifier reads, because the
 * scope has to be decided at capture time and stay stable forever after.
 */
export const CAPTURE_PAYLOAD_LANES = [
  "platform_capture",
  "platform_account_state",
  "ai_generation",
  "auth_audit",
  "operator_action",
] as const;
export type CapturePayloadLane = (typeof CAPTURE_PAYLOAD_LANES)[number];

export interface CapturePayloadScope {
  accessClass: CapturePayloadAccessClass;
  erasureDomain: CapturePayloadErasureDomain;
  platformAccountId: number | null;
}

const LANE_SCOPE: Record<
  CapturePayloadLane,
  { accessClass: CapturePayloadAccessClass; erasureDomain: CapturePayloadErasureDomain }
> = {
  // Wire capture from a platform: DMs, transactions, fan profiles. Fan-bearing.
  platform_capture: { accessClass: "ordinary_capture", erasureDomain: "fan_subject" },
  // Page/account-level state (settings, account metadata) — no fan subject.
  platform_account_state: { accessClass: "ordinary_capture", erasureDomain: "platform_account" },
  // Stage 29 verbatim prompt/completion material: restricted, and fan-bearing
  // because prompts embed transcripts.
  ai_generation: { accessClass: "restricted_ai", erasureDomain: "fan_subject" },
  // Authentication/authorization audit capture: a principal, never a fan.
  auth_audit: { accessClass: "operator_audit", erasureDomain: "system" },
  // Operator-initiated capture (CLI, console actions).
  operator_action: { accessClass: "ordinary_capture", erasureDomain: "system" },
};

/**
 * The capture-time scope classifier. Named and exported on purpose: "why were
 * these two payloads allowed to share a body row" must be answerable by
 * pointing at one function and one table, never reconstructed from a call site.
 *
 * `platformAccountId` is allowed to be null and STAYS null — the catalog's
 * uniqueness is NULLS NOT DISTINCT precisely so that unmapped capture (ingest
 * before the account is known, auth audit) dedups like everything else instead
 * of degenerating into one object per row.
 */
export function classifyCapturePayloadScope(input: {
  lane: CapturePayloadLane;
  platformAccountId?: number | null;
}): CapturePayloadScope {
  const lane = LANE_SCOPE[input.lane];
  if (!lane) {
    throw new Error(`unknown capture payload lane "${input.lane}"`);
  }
  return {
    accessClass: lane.accessClass,
    erasureDomain: lane.erasureDomain,
    platformAccountId: input.platformAccountId ?? null,
  };
}

/**
 * The month bucket, in UTC, as the `YYYY-MM-01` text the `date` column stores.
 * Text on purpose: node-postgres parses a `date` into a LOCAL-midnight Date,
 * which would shift the month for anyone west of UTC.
 */
export function capturePayloadBucketMonth(captureInstant: Date): string {
  const time = captureInstant.getTime();
  if (Number.isNaN(time)) {
    throw new Error("capture instant is not a valid Date");
  }
  const month = String(captureInstant.getUTCMonth() + 1).padStart(2, "0");
  return `${captureInstant.getUTCFullYear()}-${month}-01`;
}

/**
 * The four partitioned relations of the catalog, and the order they must be
 * created in (bodies and locations carry an FK to the identity table).
 */
const CAPTURE_CATALOG_PARTITIONED_TABLES = [
  "capture_payload_objects",
  "capture_json_hot_bodies",
  "capture_byte_hot_bodies",
  "capture_payload_locations",
] as const;

/**
 * Pre-create every catalog partition for one `YYYY-MM-01` bucket month.
 *
 * WHY THIS EXISTS (G5 slice 3c-2). Migration 0123 created 2026-08 … 2027-02
 * plus the 2031+ catch-all, because those are the months the WRITER would ever
 * see: a live capture buckets by `now()`. The historical rewrite buckets by each
 * row's OWN capture instant, so it addresses months that are in the PAST —
 * production data starts in 2026-07, a month 0123 never created. A write into an
 * uncovered range fails loudly with 23514, which is exactly the behaviour 0123
 * wanted for a live writer ("a write into an uncreated month must fail loudly,
 * never land somewhere else") and exactly the wrong behaviour for a backfill
 * that knows in advance which month it is filling.
 *
 * Idempotent (`if not exists`) and shaped like `ensureObservationPartitions`,
 * the other pre-creation helper in this package. It is DDL and takes brief
 * ACCESS EXCLUSIVE locks on the four parents — which is why it is called once
 * per month per run, from the backfill's own loop, and never per row.
 *
 * It creates ONLY monthly ranges below the 2031 catch-all bound: inside that
 * range a monthly CREATE would fail on overlap, and above it the catch-all is
 * already the right answer.
 */
export async function ensureCapturePayloadCatalogPartitions(
  db: Database,
  bucketMonth: string,
): Promise<string[]> {
  const match = /^(\d{4})-(\d{2})-01$/.exec(bucketMonth);
  if (match === null) {
    throw new Error(`bucket month must be YYYY-MM-01 (got: ${bucketMonth})`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`bucket month is not a real month: ${bucketMonth}`);
  }
  // 0123's `*_future` partition owns [2031-01-01, MAXVALUE); a monthly CREATE
  // inside it would fail on overlap, and it already covers the range.
  if (year >= 2031) {
    return [];
  }
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const to = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
  const suffix = `${year}_${String(month).padStart(2, "0")}`;

  const created: string[] = [];
  for (const table of CAPTURE_CATALOG_PARTITIONED_TABLES) {
    const name = `${table}_${suffix}`;
    await db.execute(sql.raw(`
      create table if not exists "${name}" partition of "${table}"
      for values from ('${bucketMonth}') to ('${to}')
    `));
    created.push(name);
  }
  return created;
}

export type PutPayloadObjectContent =
  | { representation: "canonical_json"; json: unknown }
  | { representation: "exact_bytes"; canonicalBytes: Buffer };

export type PutPayloadObjectInput = PutPayloadObjectContent & {
  /** §7 step 1: the ONE instant that fixes the month bucket for this capture. */
  captureInstant: Date;
  lane: CapturePayloadLane;
  platformAccountId?: number | null;
  /** Wire content type, kept as provenance for exact-byte bodies. */
  contentType?: string | null;
};

export interface CapturePayloadRef {
  bucketMonth: string;
  objectId: number;
}

export interface PutPayloadObjectResult extends CapturePayloadRef {
  accessClass: CapturePayloadAccessClass;
  erasureDomain: CapturePayloadErasureDomain;
  representation: CapturePayloadRepresentation;
  codecVersion: number;
  contentSha256: Buffer;
  collisionOrdinal: number;
  logicalBytes: number;
  /** false = this content was already stored in this month and scope. */
  created: boolean;
}

export interface CapturePayloadObjectRow extends CapturePayloadRef {
  platformAccountId: number | null;
  accessClass: CapturePayloadAccessClass;
  erasureDomain: CapturePayloadErasureDomain;
  representation: CapturePayloadRepresentation;
  codecVersion: number;
  contentSha256: Buffer;
  collisionOrdinal: number;
  logicalBytes: number;
  contentType: string | null;
  firstSeenAt: Date;
  storageTier: CapturePayloadStorageTier | null;
}

export type CapturePayloadBody =
  | { representation: "canonical_json"; json: unknown }
  | { representation: "exact_bytes"; bytes: Buffer };

/**
 * How many times the identity probe may lose a race before we give up. Losing
 * once is normal under concurrency (two writers, same content, same instant);
 * losing this many times in a row is not a race, it is a bug, and it must
 * surface rather than spin.
 */
const MAX_IDENTITY_ATTEMPTS = 8;

/**
 * Stores one payload and returns the object it is addressed by, deduping onto
 * an existing object only when the FULL content matches.
 *
 * All statements run in ONE transaction. A caller that already holds a
 * transaction composes into it (the insertObservation pattern): their
 * transaction is the atomicity boundary and no nested savepoint is opened.
 * A bare-pool handle gets its own BEGIN…COMMIT on one checked-out connection —
 * without it, a crash between the catalog row and its body row would leave an
 * object whose content can never be proven, and the next writer of the same
 * digest would (correctly, but wastefully and forever) allocate a new ordinal.
 */
export async function putPayloadObject(
  db: Database,
  input: PutPayloadObjectInput,
): Promise<PutPayloadObjectResult> {
  const prepared = prepareCapturePayload(input);

  const transaction = (
    db as Database & {
      transaction?: (
        callback: (tx: unknown) => Promise<PutPayloadObjectResult>,
      ) => Promise<PutPayloadObjectResult>;
    }
  ).transaction;

  // Already inside a caller's transaction (or a unit-test stub with no database
  // behind it): run inline, they own the boundary.
  if (is(db, PgTransaction) || typeof transaction !== "function") {
    return settlePayloadObject(db, prepared);
  }

  return transaction.call(db, (tx) => settlePayloadObject(tx as Database, prepared));
}

interface PreparedCapturePayload {
  bucketMonth: string;
  scope: CapturePayloadScope;
  representation: CapturePayloadRepresentation;
  codecVersion: number;
  canonicalBytes: Buffer;
  contentSha256: Buffer;
  logicalBytes: number;
  contentType: string | null;
  firstSeenAt: Date;
}

/** §7 steps 1–2: fix the instant and the scope, then canonicalize and digest. */
function prepareCapturePayload(input: PutPayloadObjectInput): PreparedCapturePayload {
  const bucketMonth = capturePayloadBucketMonth(input.captureInstant);
  const scope = classifyCapturePayloadScope({
    lane: input.lane,
    platformAccountId: input.platformAccountId ?? null,
  });
  const representation = input.representation;
  const codecVersion = capturePayloadCodecVersionFor(representation);
  const canonicalBytes = representation === "canonical_json"
    ? canonicalizeCaptureJson(input.json)
    : input.canonicalBytes;
  if (!Buffer.isBuffer(canonicalBytes)) {
    throw new Error("exact_bytes payloads must supply canonicalBytes as a Buffer");
  }

  return {
    bucketMonth,
    scope,
    representation,
    codecVersion,
    canonicalBytes,
    contentSha256: digestCapturePayload({ representation, codecVersion, canonicalBytes }),
    logicalBytes: canonicalBytes.length,
    contentType: input.contentType ?? null,
    firstSeenAt: input.captureInstant,
  };
}

async function settlePayloadObject(
  db: Database,
  prepared: PreparedCapturePayload,
): Promise<PutPayloadObjectResult> {
  for (let attempt = 0; attempt < MAX_IDENTITY_ATTEMPTS; attempt += 1) {
    const candidates = await listIdentityCandidates(db, prepared);

    for (const candidate of candidates) {
      if (await bodyMatches(db, prepared, candidate.objectId)) {
        return result(prepared, candidate.objectId, candidate.collisionOrdinal, false);
      }
    }

    // No stored body proved equal. Either this content is new (no candidates)
    // or a real digest collision (candidates exist, none matched) — both take
    // the next ordinal. Coalescing on a hash match alone is exactly the bug
    // this loop exists to prevent.
    //
    // THE COLLISION ALARM IS WIRED, AND IT IS NOT HERE (G5 slice 3b). A
    // non-empty candidate set at this point IS a sha256 collision inside one
    // scope+month, and the owner is paged for it — by the hourly parity job
    // (apps/runtime/src/services/capture-payload-parity.ts), under the
    // `capture_payload_parity` kind with the `sha256_collision` subKey.
    //
    // Nothing pages from HERE, on purpose. This is the hottest write path in
    // the system and decision #217 settled the rule the other way round for the
    // read seam: a traffic-driven path cannot promise a clean pass, cannot
    // bound its paging rate, and racing a scheduled job for the same latch is
    // how a latch ends up half-owned. What this path owes the alarm is
    // EVIDENCE, and it already writes it: the row below carries
    // `collision_ordinal > 0` forever, which is a stronger record than any
    // process counter — it survives a restart, a rollback of the canary, and
    // the process that observed it.
    const lastCandidate = candidates.at(-1);
    const nextOrdinal = lastCandidate === undefined ? 0 : lastCandidate.collisionOrdinal + 1;

    const objectId = await insertObject(db, prepared, nextOrdinal);
    if (objectId === null) {
      // Another writer took this ordinal while we were comparing. Re-read: the
      // winner's body may well be ours, in which case the next pass dedups.
      continue;
    }

    await insertBody(db, prepared, objectId);
    await insertLocation(db, prepared, objectId);
    return result(prepared, objectId, nextOrdinal, true);
  }

  throw new Error(
    `capture payload identity did not settle after ${MAX_IDENTITY_ATTEMPTS} attempts ` +
      `(bucket ${prepared.bucketMonth}, digest ${prepared.contentSha256.toString("hex")})`,
  );
}

function result(
  prepared: PreparedCapturePayload,
  objectId: number,
  collisionOrdinal: number,
  created: boolean,
): PutPayloadObjectResult {
  return {
    bucketMonth: prepared.bucketMonth,
    objectId,
    accessClass: prepared.scope.accessClass,
    erasureDomain: prepared.scope.erasureDomain,
    representation: prepared.representation,
    codecVersion: prepared.codecVersion,
    contentSha256: prepared.contentSha256,
    collisionOrdinal,
    logicalBytes: prepared.logicalBytes,
    created,
  };
}

/**
 * `platform_account_id IS NOT DISTINCT FROM $n` would be correct but is not an
 * indexable qual; splitting the predicate keeps the identity unique index
 * usable for both the mapped and the unmapped case.
 */
function accountPredicate(platformAccountId: number | null) {
  return platformAccountId === null
    ? sql`o.platform_account_id is null`
    : sql`o.platform_account_id = ${platformAccountId}`;
}

async function listIdentityCandidates(
  db: Database,
  prepared: PreparedCapturePayload,
): Promise<Array<{ objectId: number; collisionOrdinal: number }>> {
  // o.collision_ordinal QUALIFIED: a bare ORDER BY resolves to the SELECT
  // alias first — the trap that shipped twice in this codebase.
  const rows = await db.execute<{ object_id: string; collision_ordinal: number }>(sql`
    select o.object_id::text as object_id, o.collision_ordinal
    from capture_payload_objects o
    where o.bucket_month = ${prepared.bucketMonth}::date
      and ${accountPredicate(prepared.scope.platformAccountId)}
      and o.access_class = ${prepared.scope.accessClass}
      and o.erasure_domain = ${prepared.scope.erasureDomain}
      and o.representation = ${prepared.representation}
      and o.codec_version = ${prepared.codecVersion}
      and o.content_sha256 = ${prepared.contentSha256}
      and o.logical_bytes = ${prepared.logicalBytes}
    order by o.collision_ordinal asc
  `);
  return rows.rows.map((row) => ({
    objectId: Number(row.object_id),
    collisionOrdinal: Number(row.collision_ordinal),
  }));
}

/**
 * Full-content equality, never hash equality. A missing body row is NOT a
 * match: without the body we cannot prove equality, and the safe direction is
 * always "allocate a new ordinal", never "assume it was the same".
 */
async function bodyMatches(
  db: Database,
  prepared: PreparedCapturePayload,
  objectId: number,
): Promise<boolean> {
  const stored = await loadBodyRow(db, prepared.representation, {
    bucketMonth: prepared.bucketMonth,
    objectId,
  });
  if (stored === null) {
    return false;
  }
  if (stored.representation === "exact_bytes") {
    return Buffer.compare(stored.bytes, prepared.canonicalBytes) === 0;
  }
  // Re-canonicalize what Postgres gave back and compare the full octets: jsonb
  // does not preserve key order or insignificant whitespace, so only the codec
  // can decide equality.
  return Buffer.compare(canonicalizeCaptureJson(stored.json), prepared.canonicalBytes) === 0;
}

async function insertObject(
  db: Database,
  prepared: PreparedCapturePayload,
  collisionOrdinal: number,
): Promise<number | null> {
  const inserted = await db.execute<{ object_id: string }>(sql`
    insert into capture_payload_objects (
      bucket_month, platform_account_id, access_class, erasure_domain,
      representation, codec_version, content_sha256, collision_ordinal,
      logical_bytes, content_type, first_seen_at
    ) values (
      ${prepared.bucketMonth}::date,
      ${prepared.scope.platformAccountId},
      ${prepared.scope.accessClass},
      ${prepared.scope.erasureDomain},
      ${prepared.representation},
      ${prepared.codecVersion},
      ${prepared.contentSha256},
      ${collisionOrdinal},
      ${prepared.logicalBytes},
      ${prepared.contentType},
      ${prepared.firstSeenAt}
    )
    on conflict (
      bucket_month, platform_account_id, access_class, erasure_domain,
      representation, codec_version, content_sha256, logical_bytes,
      collision_ordinal
    ) do nothing
    returning object_id::text as object_id
  `);
  const row = inserted.rows[0];
  return row === undefined ? null : Number(row.object_id);
}

async function insertBody(
  db: Database,
  prepared: PreparedCapturePayload,
  objectId: number,
): Promise<void> {
  if (prepared.representation === "exact_bytes") {
    await db.execute(sql`
      insert into capture_byte_hot_bodies (bucket_month, object_id, body)
      values (${prepared.bucketMonth}::date, ${objectId}, ${prepared.canonicalBytes})
    `);
    return;
  }
  await db.execute(sql`
    insert into capture_json_hot_bodies (bucket_month, object_id, body)
    values (${prepared.bucketMonth}::date, ${objectId}, ${prepared.canonicalBytes.toString("utf8")}::jsonb)
  `);
}

async function insertLocation(
  db: Database,
  prepared: PreparedCapturePayload,
  objectId: number,
): Promise<void> {
  await db.execute(sql`
    insert into capture_payload_locations (bucket_month, object_id, storage_tier)
    values (${prepared.bucketMonth}::date, ${objectId}, 'hot')
  `);
}

/**
 * PROVE — AND HOLD — that a catalog object is still alive, for the rest of the
 * caller's transaction. The other half of the protocol in
 * `deleteUnreferencedCapturePayloadObjects`, and the reason a stamped reference
 * can no longer outlive the object it addresses (decision #222).
 *
 * THE HOLE THIS CLOSES. Between the CAS transaction committing (which is where
 * `putPayloadObject` hands back a reference — often to an object it DEDUPED
 * onto, so that transaction wrote nothing at all) and the envelope insert that
 * stamps that reference, the object is referenced by nobody. An erasure sweep
 * running in that gap proves "no envelope references this" — correctly, at that
 * instant — and deletes the body. The envelope then lands carrying a reference
 * to a row that is gone. Under #215 that was a dangling reference and no worse,
 * because the envelope still carried the body inline; #220 removed that premise
 * for a pointer-only page and turned the same race into a LOST CAPTURED FACT.
 *
 * WHY A ROW LOCK, AND WHY THIS ONE. `FOR KEY SHARE` is precisely the lock a
 * FOREIGN KEY would take on the parent row, taken by hand, at the one moment it
 * is needed. #215 rejected the FK itself and every word of that rejection still
 * holds — an FK taxes the hottest write path with index maintenance, locks the
 * catalog's future partition maintenance, and would have to validate all of
 * history. NONE of that is true of this: no DDL, no index (the catalog's own
 * primary key serves the probe), no history to validate, and it costs exactly
 * one uncontended row lock, only on captures that actually carry a reference.
 * It conflicts with `FOR UPDATE` and with DELETE and with nothing else, so two
 * concurrent captures deduping onto the same body never wait on each other.
 *
 * IT MUST RUN IN THE SAME TRANSACTION AS THE ENVELOPE INSERT — a transaction-
 * scoped lock released before the insert would prove nothing about the moment
 * the row becomes visible. Both writers (`insertObservation`, `insertRawPayload`)
 * arrange exactly that.
 *
 * FALSE means the object is GONE and the caller must write the envelope with NO
 * reference and WITH its inline body. That is not a failure path to be retried:
 * it is the pre-G5 state of a capture, reached deliberately, and it keeps
 * #220's law ("the worst case is both copies, never none") true through an
 * erasure.
 */
export async function lockCapturePayloadRefAlive(
  db: Database,
  ref: CapturePayloadRef,
): Promise<boolean> {
  const rows = await db.execute<{ object_id: string }>(sql`
    select o.object_id::text as object_id
    from capture_payload_objects o
    where o.bucket_month = ${ref.bucketMonth}::date
      and o.object_id = ${ref.objectId}
    for key share
  `);
  return rows.rows.length > 0;
}

/** The catalog row for one object, with its current physical tier. */
export async function getPayloadObject(
  db: Database,
  ref: CapturePayloadRef,
): Promise<CapturePayloadObjectRow | null> {
  const rows = await db.execute<{
    bucket_month: string;
    object_id: string;
    platform_account_id: string | null;
    access_class: string;
    erasure_domain: string;
    representation: string;
    codec_version: number;
    content_sha256: Buffer;
    collision_ordinal: number;
    logical_bytes: string;
    content_type: string | null;
    first_seen_at: Date | string;
    storage_tier: string | null;
  }>(sql`
    select to_char(o.bucket_month, 'YYYY-MM-DD') as bucket_month,
           o.object_id::text as object_id,
           o.platform_account_id::text as platform_account_id,
           o.access_class, o.erasure_domain, o.representation, o.codec_version,
           o.content_sha256, o.collision_ordinal,
           o.logical_bytes::text as logical_bytes,
           o.content_type, o.first_seen_at,
           l.storage_tier
    from capture_payload_objects o
    left join capture_payload_locations l
      on l.bucket_month = o.bucket_month and l.object_id = o.object_id
    where o.bucket_month = ${ref.bucketMonth}::date and o.object_id = ${ref.objectId}
  `);
  const row = rows.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    bucketMonth: row.bucket_month,
    objectId: Number(row.object_id),
    platformAccountId: row.platform_account_id === null ? null : Number(row.platform_account_id),
    accessClass: row.access_class as CapturePayloadAccessClass,
    erasureDomain: row.erasure_domain as CapturePayloadErasureDomain,
    representation: row.representation as CapturePayloadRepresentation,
    codecVersion: Number(row.codec_version),
    contentSha256: row.content_sha256,
    collisionOrdinal: Number(row.collision_ordinal),
    logicalBytes: Number(row.logical_bytes),
    contentType: row.content_type,
    firstSeenAt: new Date(row.first_seen_at),
    storageTier: row.storage_tier === null ? null : (row.storage_tier as CapturePayloadStorageTier),
  };
}

/**
 * The body for one object. Reads the catalog first so the representation comes
 * from the object's own identity, not from the caller's guess about which hot
 * table to look in.
 *
 * DELIBERATELY NOT ON THE PACKAGE BARREL (pinned by
 * tests/capture-payload-barrel.test.ts). A bare (bucket_month, object_id) is an
 * address, not an authorization: one object can be shared by many envelopes and
 * a restricted_ai body is addressed exactly like an ordinary one. Bodies are
 * reached through the envelope seam
 * (apps/runtime/src/services/payload-reader.ts), so when the pointer slice
 * wires that seam it must call this from inside packages/db — a new runtime
 * caller of this function is the bug the pin exists to catch.
 */
export async function loadPayloadBody(
  db: Database,
  ref: CapturePayloadRef,
): Promise<CapturePayloadBody | null> {
  const object = await getPayloadObject(db, ref);
  if (object === null) {
    return null;
  }
  return loadBodyRow(db, object.representation, ref);
}

/**
 * Rebuild an envelope's composite reference from its two nullable columns.
 *
 * Migration 0124's CHECK makes a half-set pair impossible in the database, so
 * the `||` here is not a real case being handled — it is the fail-open reading
 * of a state that cannot occur: an unresolvable address is treated as NO
 * address, which sends the reader to the inline authority.
 *
 * The month arrives as `YYYY-MM-DD` text (`to_char`), never as a parsed Date:
 * node-postgres turns a `date` into LOCAL midnight, which shifts the month for
 * anyone west of UTC — the same trap `capturePayloadBucketMonth` avoids on the
 * write side.
 */
export function capturePayloadRefFromColumns(
  bucketMonth: string | null | undefined,
  objectId: string | number | null | undefined,
): CapturePayloadRef | null {
  if (bucketMonth == null || objectId == null) {
    return null;
  }
  return { bucketMonth, objectId: Number(objectId) };
}

/**
 * Which envelope class a reference was read off. G5 slice 2.
 *
 * This is not decoration: it decides the representation the reference is
 * ALLOWED to resolve to. Both of today's envelopes store their inline body in a
 * `jsonb` column, so a reference from one of them to an `exact_bytes` object
 * means the two content planes have been crossed and the reference is
 * meaningless — the same verdict the parity verifier calls
 * `representation_mismatch`. The webhook envelopes of a later slice keep their
 * wire octets and will map to `exact_bytes` here.
 */
export const CAPTURE_PAYLOAD_ENVELOPE_KINDS = ["observation", "raw_payload"] as const;
export type CapturePayloadEnvelopeKind = (typeof CAPTURE_PAYLOAD_ENVELOPE_KINDS)[number];

const ENVELOPE_REPRESENTATION: Record<CapturePayloadEnvelopeKind, CapturePayloadRepresentation> = {
  observation: "canonical_json",
  raw_payload: "canonical_json",
};

export type EnvelopeCapturePayloadRead =
  | { status: "loaded"; json: unknown }
  /** The reference points at a catalog row that does not exist. */
  | { status: "object_missing" }
  /** The catalog row exists but its body row does not. */
  | { status: "body_missing" }
  /** The object's representation is not the one this envelope class stores. */
  | { status: "representation_mismatch"; representation: CapturePayloadRepresentation };

/**
 * The catalog body an ENVELOPE points at — the one body read the runtime seam
 * (apps/runtime/src/services/payload-reader.ts) is allowed to make.
 *
 * ON THE BARREL, unlike `loadPayloadBody`, and the difference is the whole
 * point of the pin in tests/capture-payload-barrel.test.ts: this function
 * cannot be called without naming the envelope class the reference came off,
 * and it refuses to hand back a body whose representation that envelope class
 * does not store. A bare `(bucket_month, object_id)` therefore still buys
 * nothing — you must also be able to say which envelope carried it, and the
 * only way a caller gets one honestly is by having read that envelope's row.
 *
 * ONE round trip, not the two `loadPayloadBody` takes. The identity row and
 * both hot body tables are joined in a single statement because this runs per
 * envelope on read paths that resolve row by row; halving the round trips is
 * the difference between a bounded cost and a visible one. Body PRESENCE is
 * decided by the joined key, never by the body being SQL NULL — a stored jsonb
 * body may legitimately BE the JSON value `null`, and reading that as "missing"
 * would turn a faithfully stored fact into a phantom parity failure.
 */
export async function readEnvelopeCapturePayload(
  db: Database,
  input: { envelope: CapturePayloadEnvelopeKind; ref: CapturePayloadRef },
): Promise<EnvelopeCapturePayloadRead> {
  const rows = await db.execute<{
    representation: string;
    has_json: boolean;
    json_body: unknown;
    has_bytes: boolean;
  }>(sql`
    select o.representation,
           (jb.object_id is not null) as has_json,
           jb.body as json_body,
           (bb.object_id is not null) as has_bytes
    from capture_payload_objects o
    left join capture_json_hot_bodies jb
      on jb.bucket_month = o.bucket_month and jb.object_id = o.object_id
    left join capture_byte_hot_bodies bb
      on bb.bucket_month = o.bucket_month and bb.object_id = o.object_id
    where o.bucket_month = ${input.ref.bucketMonth}::date
      and o.object_id = ${input.ref.objectId}
  `);
  const row = rows.rows[0];
  if (row === undefined) {
    return { status: "object_missing" };
  }

  const representation = row.representation as CapturePayloadRepresentation;
  if (representation !== ENVELOPE_REPRESENTATION[input.envelope]) {
    return { status: "representation_mismatch", representation };
  }
  if (!row.has_json) {
    return { status: "body_missing" };
  }
  return { status: "loaded", json: row.json_body };
}

export type EnvelopeCapturePayloadBatchRead = EnvelopeCapturePayloadRead
  /** A large body uses the ordinary single-envelope read, limiting the
   * amount retained by a batch without treating it as missing or unreadable. */
  | { status: "deferred" };

/** The same envelope/representation boundary as the single reader, for at
 * most eight references read off an authorized page. Each result corresponds
 * to its input position (including duplicate refs). Large bodies are deferred
 * to the single reader: at most eight 512 KiB logical JSON bodies are returned
 * together. This is a fresh lookup, not a cache or a liveness promise. */
export async function readEnvelopeCapturePayloadBatch(
  db: Database,
  input: { envelope: CapturePayloadEnvelopeKind; refs: readonly CapturePayloadRef[] },
): Promise<EnvelopeCapturePayloadBatchRead[]> {
  if (input.refs.length === 0) return [];
  if (input.refs.length > 8) throw new RangeError("Capture payload batches contain at most eight envelopes");
  const values = sql.join(input.refs.map((ref, position) => sql`(
    ${position}::integer, ${ref.bucketMonth}::date, ${ref.objectId}::bigint
  )`), sql`, `);
  const result = await db.execute<{
    representation: string | null;
    has_json: boolean;
    json_body: unknown;
    deferred: boolean;
  }>(sql`
    select body.representation, body.has_json, body.json_body, body.deferred
    from (values ${values}) requested(position, bucket_month, object_id)
    left join lateral (
      select o.representation, (jb.object_id is not null) as has_json,
             case when o.logical_bytes <= 524288 then jb.body else null end as json_body,
             (o.logical_bytes > 524288) as deferred
      from capture_payload_objects o
      left join capture_json_hot_bodies jb
        on jb.bucket_month = o.bucket_month and jb.object_id = o.object_id
      where o.bucket_month = requested.bucket_month and o.object_id = requested.object_id
      limit 1
    ) body on true
    order by requested.position
  `);
  if (result.rows.length !== input.refs.length) throw new Error("Capture payload batch lost an envelope result");
  return result.rows.map(row => {
    if (row.representation === null) return { status: "object_missing" };
    const representation = row.representation as CapturePayloadRepresentation;
    if (representation !== ENVELOPE_REPRESENTATION[input.envelope]) {
      return { status: "representation_mismatch", representation };
    }
    // Presence is the joined key, not JSON null or the deferred projection.
    if (!row.has_json) return { status: "body_missing" };
    if (row.deferred) return { status: "deferred" };
    return { status: "loaded", json: row.json_body };
  });
}

async function loadBodyRow(
  db: Database,
  representation: CapturePayloadRepresentation,
  ref: CapturePayloadRef,
): Promise<CapturePayloadBody | null> {
  if (representation === "exact_bytes") {
    const rows = await db.execute<{ body: Buffer }>(sql`
      select b.body
      from capture_byte_hot_bodies b
      where b.bucket_month = ${ref.bucketMonth}::date and b.object_id = ${ref.objectId}
    `);
    const row = rows.rows[0];
    return row === undefined ? null : { representation: "exact_bytes", bytes: row.body };
  }

  const rows = await db.execute<{ body: unknown }>(sql`
    select b.body
    from capture_json_hot_bodies b
    where b.bucket_month = ${ref.bucketMonth}::date and b.object_id = ${ref.objectId}
  `);
  const row = rows.rows[0];
  return row === undefined ? null : { representation: "canonical_json", json: row.body };
}
