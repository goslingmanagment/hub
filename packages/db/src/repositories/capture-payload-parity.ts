// G5 slice 1 — the integrity censuses of the content-addressed capture catalog.
//
// Two counts the hourly parity job runs over durable rows: sha256 collisions in
// the catalog, and envelope references that point at a catalog row that is not
// there. (The sampled inline-vs-catalog comparison that once lived here is gone:
// no writer stores both an inline body and a catalog reference on one row any
// more, so it had nothing left to compare — 0 rows in every hourly pass.)
//
// IT NEVER REPAIRS, NEVER DELETES, NEVER TOUCHES INLINE DATA.

import { type SQL, sql } from "drizzle-orm";

import type { Database } from "../client.ts";

export type CapturePayloadParityEnvelope = "observation" | "raw_payload";

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
 * COST. 0123 left the catalog with only the PK and the identity UNIQUE, so this
 * count was a sequential scan of every partition. By 2026-11 the catalog held
 * 1.5 M rows (235 MB): each hourly run read all of it, mostly from outside
 * shared_buffers, to find 0 rows — 427 ms and 11.5 % of all Postgres block
 * reads. 0356 adds the partial index `capture_payload_objects_collision_idx`
 * (`where collision_ordinal > 0`), which holds only the rows this count looks
 * for. The planner uses it only when the query's WHERE implies the index
 * predicate, so keep the literal `> 0` here: a bound parameter would not match
 * it in a generic plan.
 */
export async function countCapturePayloadCollisions(db: Database): Promise<number> {
  const rows = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from capture_payload_objects o where o.collision_ordinal > 0
  `);
  return Number(rows.rows[0]?.n ?? 0);
}

/** How many recent envelope rows per table the dangling-reference census
 *  walks. It detoasts nothing — see the census note. */
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

// Each census counts in SQL and returns ONE row when nothing dangles: the
// catalog is probed through its primary key `(bucket_month, object_id)` once per
// referenced row. The scalar subquery with `limit 1` is what keeps the planner
// from flattening the probe back into a hash join against a seq scan of every
// `capture_payload_objects` partition (it misjudges how many recent rows carry a
// reference). `referenced` and `dangling` repeat on every row; sample columns are
// null on the single row of a clean pass. Which dangling rows are sampled was
// never ordered and is not now.
const danglingRefCensusOver = (recent: SQL) => sql`
  with recent as (${recent}),
  judged as materialized (
    select r.envelope_id, r.bucket_month, r.object_id,
           (select true from capture_payload_objects c
             where c.bucket_month = r.bucket_month and c.object_id = r.object_id
             limit 1) is null as dangling
      from recent r
     where r.object_id is not null
  )
  select (select count(*) from judged)::int as referenced,
         (select count(*) from judged where dangling)::int as dangling,
         s.envelope_id::text as envelope_id,
         to_char(s.bucket_month, 'YYYY-MM-DD') as bucket_month,
         s.object_id::text as object_id
    from (select 1) one
    left join lateral (
      select * from judged where dangling limit ${CAPTURE_PAYLOAD_DANGLING_REF_SAMPLE_LIMIT}
    ) s on true
`;

const DANGLING_REF_CENSUS_TABLES = [
  {
    envelope: "observation" as const,
    // `observations` is partitioned; `o.id` is the leading column of the
    // composite primary key, so this is a MergeAppend of backward index scans.
    sql: (scanLimit: number) => danglingRefCensusOver(sql`
        select o.id as envelope_id,
               o.payload_bucket_month as bucket_month,
               o.payload_object_id as object_id
        from observations o
        order by o.id desc
        limit ${scanLimit}
    `),
  },
  {
    envelope: "raw_payload" as const,
    sql: (scanLimit: number) => danglingRefCensusOver(sql`
        select rp.id as envelope_id,
               rp.payload_bucket_month as bucket_month,
               rp.payload_object_id as object_id
        from sync_raw_payloads rp
        order by rp.id desc
        limit ${scanLimit}
    `),
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
 * recent `scanLimit` rows of each table in primary-key order — a backward
 * index scan; the join detoasts nothing and reads no body. A dangling
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
      referenced: number;
      dangling: number;
      envelope_id: string | null;
      bucket_month: string;
      object_id: string;
    }>(table.sql(scanLimit));
    const counts = rows.rows[0];
    census.referenced += Number(counts?.referenced ?? 0);
    census.dangling += Number(counts?.dangling ?? 0);
    for (const row of rows.rows) {
      // The single row of a clean pass carries no sample.
      if (row.envelope_id === null) {
        continue;
      }
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
