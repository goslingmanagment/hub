// E5 / A22 re-journal (W8, decision #133) — one-shot, append-only repair for
// the pre-f8c4409 observation idempotency collision. Multi-fetch sync chunks
// journaled every fetch under ONE chunk-constant key
// (`pageId:stream:syncRunId:requestSeq`), so every observation after the
// first was silently swallowed by the (source, idempotency_key) claim —
// ~40k pull observations in the 2026-07-05..07-07 window. The RAW FETCHES
// all survive in sync_raw_payloads; this campaign re-journals the missing
// observations from them VERBATIM, under a new producer tag
// (`rejournal:a22`, provenance) and per-raw-row idempotency keys
// (`rejournal:a22:<rawPayloadId>` — deterministic, so re-runs are no-ops).
// Downstream, the canonicalize sweep picks the rows up at parse_version 0;
// domain_event_keys dedup makes any re-canonicalization of already-seen
// facts a no-op. Nothing is ever updated or deleted.

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { capturePayloadRefFromColumns, insertObservation, type Database } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { resolveCapturePayload } from "./payload-reader.ts";

export const REJOURNAL_PRODUCER = "rejournal:a22";

/** The prod collision window (Stage-0 census, 2026-07-11): the buggy key
 * shipped 2026-07-05T01:50Z and the fixed key (`….fetchSeq`) deployed
 * 2026-07-07T18:00Z. */
export const E5_COLLISION_WINDOW = {
  from: new Date("2026-07-05T01:50:00Z"),
  to: new Date("2026-07-07T18:00:00Z"),
} as const;

export interface RejournalStreamCounts {
  /** Raw fetches in collision-candidate groups (multi-fetch chunks). */
  rawFetches: number;
  /** Observations already journaled under the original (old or new) keys. */
  observed: number;
  /** Raw fetches with no observation — the swallowed facts. */
  missing: number;
  /** Written this run (0 under --dry-run). */
  rejournaled: number;
  /** Missing rows an earlier campaign run already re-journaled. */
  alreadyRejournaled: number;
}

export interface RejournalResult {
  dryRun: boolean;
  window: { from: string; to: string };
  groupsScanned: number;
  perStream: Record<string, RejournalStreamCounts>;
  totals: RejournalStreamCounts;
}

interface CollisionGroup {
  pageId: number;
  platform: "fansly" | "onlyfans";
  stream: string;
  syncRunId: number;
  requestSeq: number;
  rawIds: number[];
}

function emptyCounts(): RejournalStreamCounts {
  return { rawFetches: 0, observed: 0, missing: 0, rejournaled: 0, alreadyRejournaled: 0 };
}

async function listCollisionGroups(
  db: Database,
  window: { from: Date; to: Date },
): Promise<CollisionGroup[]> {
  // Only executor-context rows (stream/run/seq present) used the colliding
  // key shape; `failed` payloads journal under a different key family
  // (`pageId:<endpoint>:failed:…`) and are out of this campaign's scope.
  // Single-fetch groups cannot have collided (the first insert always won).
  const result = await db.execute<{
    page_id: string;
    platform: string;
    stream: string;
    sync_run_id: string;
    request_seq: string;
    raw_ids: number[] | string[];
  }>(sql`
    select r.page_id::text as page_id,
           p.platform,
           r.stream::text as stream,
           r.sync_run_id::text as sync_run_id,
           r.request_seq::text as request_seq,
           array_agg(r.id order by r.id) as raw_ids
    from sync_raw_payloads r
    join pages p on p.id = r.page_id
    where r.captured_at >= ${window.from}
      and r.captured_at < ${window.to}
      and r.stream is not null
      and r.sync_run_id is not null
      and r.request_seq is not null
      and r.payload_kind <> 'failed'
    group by r.page_id, p.platform, r.stream, r.sync_run_id, r.request_seq
    having count(*) > 1
    order by r.page_id, r.sync_run_id, r.request_seq
  `);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    platform: row.platform as "fansly" | "onlyfans",
    stream: row.stream,
    syncRunId: Number(row.sync_run_id),
    requestSeq: Number(row.request_seq),
    rawIds: row.raw_ids.map((id) => Number(id)),
  }));
}

/** Observations already journaled for the chunk: the old chunk-constant key
 * (exactly `pageId:stream:runId:requestSeq`) or the fixed per-fetch keys
 * (`….requestSeq.fetchSeq`). starts_with, not LIKE — stream names contain
 * `_`, which LIKE would treat as a wildcard. */
async function countOriginalObservations(db: Database, group: CollisionGroup): Promise<number> {
  const oldKey = `${group.pageId}:${group.stream}:${group.syncRunId}:${group.requestSeq}`;
  const result = await db.execute<{ n: string }>(sql`
    select count(*)::text as n
    from observation_keys
    where source = 'pull'
      and (idempotency_key = ${oldKey} or starts_with(idempotency_key, ${`${oldKey}.`}))
  `);
  return Number(result.rows[0]?.n ?? 0);
}

async function rejournalKeyExists(db: Database, key: string): Promise<boolean> {
  const result = await db.execute<{ one: number }>(sql`
    select 1 as one from observation_keys
    where source = 'pull' and idempotency_key = ${key}
    limit 1
  `);
  return result.rows.length > 0;
}

export async function runObservationsRejournal(
  app: Pick<AppContext, "db" | "logger">,
  options: { dryRun: boolean; from?: Date; to?: Date },
): Promise<RejournalResult> {
  const window = {
    from: options.from ?? E5_COLLISION_WINDOW.from,
    to: options.to ?? E5_COLLISION_WINDOW.to,
  };
  const groups = await listCollisionGroups(app.db, window);

  const perStream: Record<string, RejournalStreamCounts> = {};
  const totals = emptyCounts();
  const tally = (stream: string) => (perStream[stream] ??= emptyCounts());

  for (const group of groups) {
    const counts = tally(group.stream);
    counts.rawFetches += group.rawIds.length;
    totals.rawFetches += group.rawIds.length;

    const observed = Math.min(
      await countOriginalObservations(app.db, group),
      group.rawIds.length,
    );
    counts.observed += observed;
    totals.observed += observed;
    if (observed >= group.rawIds.length) {
      continue;
    }

    // persistRawPayload ran insertRawPayload + insertObservation back-to-back
    // per fetch, so raw-id order IS journal order: the first `observed`
    // fetches of the chunk own the surviving observation(s); everything after
    // them was swallowed.
    const missingRawIds = group.rawIds.slice(observed);
    counts.missing += missingRawIds.length;
    totals.missing += missingRawIds.length;

    for (const rawId of missingRawIds) {
      const key = `${REJOURNAL_PRODUCER}:${rawId}`;
      if (options.dryRun) {
        if (await rejournalKeyExists(app.db, key)) {
          counts.alreadyRejournaled += 1;
          totals.alreadyRejournaled += 1;
        }
        continue;
      }

      const raw = await app.db.execute<{
        endpoint: string;
        response_payload: unknown;
        payload_bucket_month: string | null;
        payload_object_id: string | null;
      }>(sql`
        select endpoint, response_payload,
               to_char(payload_bucket_month, 'YYYY-MM-DD') as payload_bucket_month,
               payload_object_id::text as payload_object_id
        from sync_raw_payloads where id = ${rawId}
      `);
      const rawRow = raw.rows[0];
      if (!rawRow) {
        // Unreachable by construction (ids came from the census moments ago);
        // fail loudly rather than silently under-repair.
        throw new Error(`sync_raw_payloads row ${rawId} vanished mid-campaign`);
      }
      // G5 slice 2: the raw body comes through the read seam. This is the one
      // migrated site that RE-HASHES what it reads (the new observation needs
      // its own payload_hash), so it is also the site that proves the modes
      // agree: both the inline column and the catalog body are stored as
      // `jsonb`, which normalizes key order identically, so JSON.stringify over
      // either produces the same string and the same hash.
      //
      // #223: AN UNAVAILABLE BODY ABORTS THE CAMPAIGN, and it does so by simply
      // being allowed to throw. This is the worst place in the system to paper
      // over an unreadable body: the insert below is keyed by
      // `rejournal:a22:<rawId>`, a DETERMINISTIC key, so an observation written
      // with `payload = null` and `payload_hash = sha256("null")` is counted as
      // a successful repair AND blocks the correct one forever — every later
      // run finds the key and reports `alreadyRejournaled`. A campaign that
      // stops halfway is trivially resumable; a campaign that "succeeded" with
      // an empty body is not repairable at all.
      const payload = await resolveCapturePayload(app, {
        envelope: "raw_payload",
        envelopeId: rawId,
        inline: rawRow.response_payload ?? null,
        ref: capturePayloadRefFromColumns(rawRow.payload_bucket_month, rawRow.payload_object_id),
      }) ?? null;
      const result = await insertObservation(app.db, {
        source: "pull",
        producer: REJOURNAL_PRODUCER,
        platform: group.platform,
        accountId: group.pageId,
        kind: rawRow.endpoint,
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
        idempotencyKey: key,
      });
      if (result.inserted) {
        counts.rejournaled += 1;
        totals.rejournaled += 1;
      } else {
        counts.alreadyRejournaled += 1;
        totals.alreadyRejournaled += 1;
      }
    }
  }

  return {
    dryRun: options.dryRun,
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    groupsScanned: groups.length,
    perStream,
    totals,
  };
}
