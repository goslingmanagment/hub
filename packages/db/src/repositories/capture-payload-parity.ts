// G5 slice 1 — the dual-write parity verifier.
//
// The dual-write slice writes each captured body TWICE: inline (the authority,
// observations.payload / sync_raw_payloads.response_payload) and once more into
// the content-addressed catalog, with the envelope carrying a composite
// reference to it. This module is the proof that the second copy is faithful —
// and it is the ONLY thing in the slice that reads the catalog.
//
// House style is the G2.2 dual proof (apps/runtime/src/services/sync/
// dm-sweep-dual-proof.ts): write both, compare the FULL content, report bounded
// counts plus a capped sample, and never let a digest pronounce two things
// equal on its own. The digests below travel in the report because they are a
// good fingerprint for a telemetry line; the verdict is decided by
// Buffer.compare over the whole canonical body.
//
// WHAT IT CANNOT PROVE, since G5 slice 3c-1. A row written pointer-only has no
// inline body, so this job has nothing to compare its catalog copy against; it
// counts such rows as `skippedNullInline` and compares the rest. As a page
// ramps, its `checked` therefore falls toward zero — by construction, not by
// failure — and the latch neither opens nor resolves off a sample of zero, the
// same asymmetry the canary-off skip already encodes. The proof that a catalog
// body is faithful is spent BEFORE the inline copy goes away: the slice-2 shadow
// window and this job's own history over the same page, which is exactly why the
// pointer-only flag is gated behind them.
//
// IT NEVER REPAIRS, NEVER DELETES, NEVER TOUCHES INLINE DATA. A mismatch is
// evidence for the owner, not something for a background job to "fix" — a job
// that rewrites a captured fact to agree with a copy of itself is exactly the
// failure mode DP 7 exists to make impossible.
//
// It lives in packages/db because the body reader (`loadPayloadBody`) is
// deliberately off the package barrel: an object id is an address, not an
// authorization, so runtime callers reach bodies only through an envelope. Here
// the envelope IS the row being verified, and the read never leaves this
// package — the parity REPORT crosses the boundary, never a body.
//
// COST: the candidate scan is bounded to the most recent `scanLimit` rows of
// each table in primary-key order, so it is a backward index scan of a fixed
// size no matter how large the tables get, and it needs no index on the
// (deliberately unindexed) reference columns. Rows whose reference is null —
// i.e. everything outside the canary — are filtered after that bounded scan,
// so a page that is not in the canary costs nothing but the scan.

import { sql } from "drizzle-orm";

import {
  CapturePayloadCodecError,
  type CapturePayloadRepresentation,
  canonicalizeCaptureJson,
  capturePayloadCodecVersionFor,
  digestCapturePayload,
} from "../capture-payload-codec.ts";
import type { Database } from "../client.ts";
import { getPayloadObject, loadPayloadBody } from "./capture-payloads.ts";

/** Rows compared per pass, split across the two envelope tables. */
export const CAPTURE_PAYLOAD_PARITY_DEFAULT_LIMIT = 50;
/** How far back the bounded candidate scan reaches, per table. */
export const CAPTURE_PAYLOAD_PARITY_DEFAULT_SCAN_LIMIT = 2000;
/** Mismatch details are capped — an anomaly payload stays bounded even when
 *  every sampled row disagrees. */
export const CAPTURE_PAYLOAD_PARITY_SAMPLE_LIMIT = 3;

export type CapturePayloadParityEnvelope = "observation" | "raw_payload";

export type CapturePayloadParityReason =
  /** The reference points at a catalog row that does not exist. */
  | "object_missing"
  /** The catalog row exists but its body row does not. */
  | "body_missing"
  /** The stored object is exact_bytes; an inline jsonb column cannot be it. */
  | "representation_mismatch"
  /** The inline column is not canonicalizable — it cannot be compared at all. */
  | "inline_uncanonicalizable"
  /** Both bodies read fine and their canonical octets differ. THE one that
   *  means the dual write is lying. */
  | "content_mismatch";

export interface CapturePayloadParityMismatch {
  envelope: CapturePayloadParityEnvelope;
  envelopeId: number;
  bucketMonth: string;
  objectId: number;
  reason: CapturePayloadParityReason;
  /** Hex sha256 of each side's canonical bytes; null when that side could not
   *  be canonicalized at all. Reporting only — see the module note. */
  inlineDigest: string | null;
  storedDigest: string | null;
}

export interface CapturePayloadParityReport {
  /** Envelopes actually COMPARED — never a count of candidates. */
  checked: number;
  matched: number;
  mismatched: number;
  /**
   * G5 slice 3c-1: sampled envelopes that carry a reference and NO inline body
   * (written pointer-only). There is nothing to compare them against, so they
   * are neither checked nor matched — counting them as matched would report
   * parity that was never measured, and the whole value of this job is that its
   * "matched" means two copies were read and found identical. They are reported
   * so the owner can see the sample shrinking as a page ramps, instead of
   * watching `checked` fall toward zero with no explanation.
   */
  skippedNullInline: number;
  /** Bounded to CAPTURE_PAYLOAD_PARITY_SAMPLE_LIMIT. */
  mismatches: CapturePayloadParityMismatch[];
}

interface EnvelopeRow {
  envelope: CapturePayloadParityEnvelope;
  envelopeId: number;
  bucketMonth: string;
  objectId: number;
  inline: unknown;
}

type RawEnvelopeRow = {
  envelope_id: string;
  bucket_month: string;
  object_id: string;
  inline: unknown;
};

function toEnvelopeRows(
  envelope: CapturePayloadParityEnvelope,
  rows: readonly RawEnvelopeRow[],
): EnvelopeRow[] {
  return rows.map((row) => ({
    envelope,
    envelopeId: Number(row.envelope_id),
    bucketMonth: row.bucket_month,
    objectId: Number(row.object_id),
    inline: row.inline,
  }));
}

/**
 * Recent observations that carry a catalog reference.
 *
 * The CTE scans by `o.id` DESC (the leading column of the composite primary
 * key, so a MergeAppend of backward index scans over the partitions) and stops
 * at `scanLimit`; the payload is joined back ONLY for the rows that survive the
 * reference filter, so the bounded scan never detoasts a body it will not
 * compare. Every ORDER BY column is qualified — a bare name would resolve to a
 * SELECT alias, the trap that shipped twice here.
 */
async function listObservationCandidates(
  db: Database,
  input: { limit: number; scanLimit: number },
): Promise<EnvelopeRow[]> {
  const rows = await db.execute<RawEnvelopeRow>(sql`
    with recent as (
      select o.id as observation_id,
             o.received_at as received_at,
             o.payload_bucket_month as bucket_month,
             o.payload_object_id as object_id
      from observations o
      order by o.id desc
      limit ${input.scanLimit}
    )
    select r.observation_id::text as envelope_id,
           to_char(r.bucket_month, 'YYYY-MM-DD') as bucket_month,
           r.object_id::text as object_id,
           o.payload as inline
    from recent r
    join observations o
      on o.id = r.observation_id and o.received_at = r.received_at
    where r.object_id is not null
    order by r.observation_id desc
    limit ${input.limit}
  `);
  return toEnvelopeRows("observation", rows.rows);
}

/** The same bounded shape over the unpartitioned raw capture table. */
async function listRawPayloadCandidates(
  db: Database,
  input: { limit: number; scanLimit: number },
): Promise<EnvelopeRow[]> {
  const rows = await db.execute<RawEnvelopeRow>(sql`
    with recent as (
      select rp.id as raw_payload_id,
             rp.payload_bucket_month as bucket_month,
             rp.payload_object_id as object_id
      from sync_raw_payloads rp
      order by rp.id desc
      limit ${input.scanLimit}
    )
    select r.raw_payload_id::text as envelope_id,
           to_char(r.bucket_month, 'YYYY-MM-DD') as bucket_month,
           r.object_id::text as object_id,
           rp.response_payload as inline
    from recent r
    join sync_raw_payloads rp on rp.id = r.raw_payload_id
    where r.object_id is not null
    order by r.raw_payload_id desc
    limit ${input.limit}
  `);
  return toEnvelopeRows("raw_payload", rows.rows);
}

function digestOf(representation: CapturePayloadRepresentation, canonicalBytes: Buffer) {
  return digestCapturePayload({
    representation,
    codecVersion: capturePayloadCodecVersionFor(representation),
    canonicalBytes,
  }).toString("hex");
}

function mismatch(
  row: EnvelopeRow,
  reason: CapturePayloadParityReason,
  digests?: { inline?: string | null; stored?: string | null },
): CapturePayloadParityMismatch {
  return {
    envelope: row.envelope,
    envelopeId: row.envelopeId,
    bucketMonth: row.bucketMonth,
    objectId: row.objectId,
    reason,
    inlineDigest: digests?.inline ?? null,
    storedDigest: digests?.stored ?? null,
  };
}

/**
 * Compare ONE envelope's inline body against the catalog copy it points at.
 *
 * Returns null when they are equal. Equality is decided by comparing the full
 * canonical octets of both sides, never by the digests — jsonb preserves
 * neither key order nor insignificant whitespace, so only the frozen codec can
 * say whether two stored bodies are the same content.
 */
async function compareEnvelope(
  db: Database,
  row: EnvelopeRow,
): Promise<CapturePayloadParityMismatch | null> {
  const ref = { bucketMonth: row.bucketMonth, objectId: row.objectId };
  const stored = await loadPayloadBody(db, ref);
  if (stored === null) {
    // Only on the failure path (expected: zero rows) do we pay a second catalog
    // read, to say WHICH half is missing.
    const object = await getPayloadObject(db, ref);
    return mismatch(row, object === null ? "object_missing" : "body_missing");
  }

  let inlineBytes: Buffer;
  try {
    inlineBytes = canonicalizeCaptureJson(row.inline);
  } catch (error) {
    if (!(error instanceof CapturePayloadCodecError)) {
      throw error;
    }
    return mismatch(row, "inline_uncanonicalizable", {
      stored: stored.representation === "canonical_json"
        ? digestOf("canonical_json", canonicalizeCaptureJson(stored.json))
        : digestOf("exact_bytes", stored.bytes),
    });
  }

  if (stored.representation !== "canonical_json") {
    // No pull-capture writer produces exact_bytes in this slice; a reference
    // from a jsonb envelope to a byte body means the two planes have been
    // crossed and the reference is meaningless.
    return mismatch(row, "representation_mismatch", {
      inline: digestOf("canonical_json", inlineBytes),
      stored: digestOf("exact_bytes", stored.bytes),
    });
  }

  const storedBytes = canonicalizeCaptureJson(stored.json);
  if (Buffer.compare(storedBytes, inlineBytes) === 0) {
    return null;
  }
  return mismatch(row, "content_mismatch", {
    inline: digestOf("canonical_json", inlineBytes),
    stored: digestOf("canonical_json", storedBytes),
  });
}

/**
 * How many catalog objects carry a non-zero `collision_ordinal`.
 *
 * A non-zero ordinal is the durable record of a sha256 collision INSIDE one
 * (month, scope, digest, length) group: `settlePayloadObject` compared the full
 * stored body against the incoming one, proved they differ, and — rather than
 * coalescing on a hash match or rolling the capture back — gave the new content
 * its own ordinal and its own body row. The capture is intact; the fact that a
 * digest stopped being unique is an integrity event the owner must see.
 *
 * COST, and why there is no index. This is a count over the CATALOG, not over a
 * body table: one row per distinct body per month per scope, small by
 * construction and kept small on purpose (0123 gives it the PK and the identity
 * UNIQUE, nothing else). An hourly sequential scan of it is cheaper than the
 * partial index that would have to be created on every monthly partition and
 * then justified forever after. If the catalog ever grows to where this shows
 * up in the hourly job's timing, the index is a one-line migration — and by
 * then there will be a query plan to earn it, which is the same rule 0124
 * applied to the envelope reference columns.
 */
export async function countCapturePayloadCollisions(db: Database): Promise<number> {
  const rows = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from capture_payload_objects o where o.collision_ordinal > 0
  `);
  return Number(rows.rows[0]?.n ?? 0);
}

/** How many recent envelope rows per table the dangling-reference census
 *  walks. Two orders of magnitude wider than the parity sample's scan because
 *  it detoasts nothing — see the census note. */
export const CAPTURE_PAYLOAD_DANGLING_REF_DEFAULT_SCAN_LIMIT = 50_000;
/** Dangling references reported verbatim; the count is always exact. */
export const CAPTURE_PAYLOAD_DANGLING_REF_SAMPLE_LIMIT = 3;

export interface CapturePayloadDanglingRef {
  envelope: CapturePayloadParityEnvelope;
  envelopeId: number;
  bucketMonth: string;
  objectId: number;
}

export interface CapturePayloadDanglingRefCensus {
  /** Envelopes examined that CARRY a reference (both tables together). */
  referenced: number;
  /** Of those, references whose catalog row is not there. */
  dangling: number;
  /** Bounded to CAPTURE_PAYLOAD_DANGLING_REF_SAMPLE_LIMIT. */
  samples: CapturePayloadDanglingRef[];
  /** The window each table was walked over, so a zero can be read honestly. */
  scanLimit: number;
}

const DANGLING_REF_CENSUS_TABLES = [
  {
    envelope: "observation" as const,
    // `observations` is partitioned; `o.id` is the leading column of the
    // composite primary key, so this is a MergeAppend of backward index scans.
    sql: (scanLimit: number) => sql`
      with recent as (
        select o.id as envelope_id,
               o.payload_bucket_month as bucket_month,
               o.payload_object_id as object_id
        from observations o
        order by o.id desc
        limit ${scanLimit}
      )
      select 'observation' as envelope,
             r.envelope_id::text as envelope_id,
             to_char(r.bucket_month, 'YYYY-MM-DD') as bucket_month,
             r.object_id::text as object_id,
             (c.object_id is null) as dangling
      from recent r
      left join capture_payload_objects c
        on c.bucket_month = r.bucket_month and c.object_id = r.object_id
      where r.object_id is not null
    `,
  },
  {
    envelope: "raw_payload" as const,
    sql: (scanLimit: number) => sql`
      with recent as (
        select rp.id as envelope_id,
               rp.payload_bucket_month as bucket_month,
               rp.payload_object_id as object_id
        from sync_raw_payloads rp
        order by rp.id desc
        limit ${scanLimit}
      )
      select 'raw_payload' as envelope,
             r.envelope_id::text as envelope_id,
             to_char(r.bucket_month, 'YYYY-MM-DD') as bucket_month,
             r.object_id::text as object_id,
             (c.object_id is null) as dangling
      from recent r
      left join capture_payload_objects c
        on c.bucket_month = r.bucket_month and c.object_id = r.object_id
      where r.object_id is not null
    `,
  },
];

/**
 * How many envelope references point at a catalog row that is not there.
 *
 * THIS IS THE CHECK THE DELIBERATELY-ABSENT FOREIGN KEY (#215) DOES NOT MAKE,
 * standing rather than one-shot: `countCaptureRewriteDanglingRefs` asks the same
 * question over one rewrite scope, once, from a CLI an owner is watching. This
 * one runs every hour, unattended, over both envelope tables, and it exists
 * because a dangling reference stopped being a cosmetic defect the day #220 let
 * a row have no inline body: for such a row the reference IS the fact, and a
 * reference into a hole is a captured fact that cannot be read.
 *
 * BOUNDED, AND THE BOUND IS PART OF THE ANSWER. A total anti-join over
 * `observations` is minutes of index-only scan on a fleet-wide pointer-only
 * production, which is not an hourly cost. The census instead walks the most
 * recent `scanLimit` rows of each table in primary-key order — the same
 * backward-index-scan discipline `verifyCapturePayloadParity` uses, at a much
 * wider limit because this join detoasts nothing and reads no body. A dangling
 * reference can only be MINTED at the head of these tables (by the #222 race,
 * now closed, or by a bug in a writer), so the head is exactly where an hourly
 * check should look; the total sweep over history belongs to
 * `capture:verify-backfill`, which already does it per scope. `scanLimit`
 * travels in the report so "zero" is never read as more than it is.
 */
export async function censusCapturePayloadDanglingRefs(
  db: Database,
  input?: { scanLimit?: number },
): Promise<CapturePayloadDanglingRefCensus> {
  const scanLimit = Math.max(1, input?.scanLimit ?? CAPTURE_PAYLOAD_DANGLING_REF_DEFAULT_SCAN_LIMIT);
  const census: CapturePayloadDanglingRefCensus = {
    referenced: 0,
    dangling: 0,
    samples: [],
    scanLimit,
  };

  for (const table of DANGLING_REF_CENSUS_TABLES) {
    const rows = await db.execute<{
      envelope_id: string;
      bucket_month: string;
      object_id: string;
      dangling: boolean;
    }>(table.sql(scanLimit));
    for (const row of rows.rows) {
      census.referenced += 1;
      if (!row.dangling) {
        continue;
      }
      census.dangling += 1;
      if (census.samples.length < CAPTURE_PAYLOAD_DANGLING_REF_SAMPLE_LIMIT) {
        census.samples.push({
          envelope: table.envelope,
          envelopeId: Number(row.envelope_id),
          bucketMonth: row.bucket_month,
          objectId: Number(row.object_id),
        });
      }
    }
  }

  return census;
}

/**
 * Verify a bounded sample of dual-written envelopes against their catalog
 * copies. Read-only end to end.
 *
 * `limit` is split evenly across the two envelope tables so neither can starve
 * the other out of the sample.
 */
export async function verifyCapturePayloadParity(
  db: Database,
  input?: { limit?: number; scanLimit?: number },
): Promise<CapturePayloadParityReport> {
  const limit = Math.max(2, input?.limit ?? CAPTURE_PAYLOAD_PARITY_DEFAULT_LIMIT);
  const scanLimit = Math.max(1, input?.scanLimit ?? CAPTURE_PAYLOAD_PARITY_DEFAULT_SCAN_LIMIT);
  const perTable = Math.max(1, Math.floor(limit / 2));

  const candidates = [
    ...await listObservationCandidates(db, { limit: perTable, scanLimit }),
    ...await listRawPayloadCandidates(db, { limit: perTable, scanLimit }),
  ];

  const mismatches: CapturePayloadParityMismatch[] = [];
  let matched = 0;
  let mismatched = 0;
  let skippedNullInline = 0;
  for (const row of candidates) {
    // G5 slice 3c-1: a pointer-only envelope has no inline body, so there is no
    // second reading of this fact for the catalog copy to agree or disagree
    // with. Skipped BEFORE compareEnvelope rather than handled inside it: the
    // whole function is a comparison, and a comparison with one operand is not
    // a verdict of any kind — least of all "matched".
    if (row.inline === null || row.inline === undefined) {
      skippedNullInline += 1;
      continue;
    }
    const verdict = await compareEnvelope(db, row);
    if (verdict === null) {
      matched += 1;
      continue;
    }
    mismatched += 1;
    if (mismatches.length < CAPTURE_PAYLOAD_PARITY_SAMPLE_LIMIT) {
      mismatches.push(verdict);
    }
  }

  return {
    checked: candidates.length - skippedNullInline,
    matched,
    mismatched,
    skippedNullInline,
    mismatches,
  };
}
