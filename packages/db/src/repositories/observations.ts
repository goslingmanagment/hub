// Observations journal (kernel Stage 7). Append-only capture spine — inserts
// only, no update/delete surface by design. The insert protocol (spec §3,
// decision #64): pre-allocate the identity id, claim (source, idempotency_key)
// in the unpartitioned companion via ON CONFLICT DO NOTHING, and only then
// write the journal row with OVERRIDING SYSTEM VALUE. A lost claim is the
// duplicate signal. Identity-sequence gaps from duplicates are harmless.
//
// The claim and the journal write are ONE transaction (DP 7). Split across two
// autocommit statements — which is what every bare-pool producer used to do —
// a crash in between left the key claimed with no journal row, and since every
// retry reads that claim as "already journaled, skip", the captured fact was
// lost permanently and silently. Callers that already hold a transaction
// (the webhook receiver, the OFAPI capture writers) compose as before: their
// transaction is the atomicity boundary and no nested savepoint is opened.

import { is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";

import { deriveObservationQueryableFields } from "../capture-queryable-fields.ts";
import type { Database } from "../client.ts";
import type { ObservationSource } from "../schema.ts";
import {
  type CapturePayloadRef,
  capturePayloadRefFromColumns,
  lockCapturePayloadRefAlive,
} from "./capture-payloads.ts";

export interface ObservationInsertInput {
  source: ObservationSource;
  producer: string;
  platform?: string | null;
  accountId?: number | null;
  nativeAccountRef?: string | null;
  kind: string;
  payload: unknown;
  /** sha256 of the raw payload bytes the producer received. */
  payloadHash: Buffer;
  idempotencyKey: string;
  /** When the fact happened at the source, if the producer knows it. */
  observedAt?: Date | null;
  actorPrincipalId?: number | null;
  /**
   * Arrival-time override. Defaults to the transaction timestamp; producers
   * never set this — it exists for tests (missing-partition drill) and the
   * later bounded backfill stages, which must date rows honestly.
   */
  receivedAt?: Date;
  /**
   * G5 slice 1: the composite reference into the content-addressed payload
   * catalog, when the capture seam already stored this body there. Written with
   * the row rather than UPDATEd onto it afterwards — an UPDATE on this table
   * would mint a second row version (WAL + heap bloat) on the largest fact
   * store in the system for a column nothing reads yet.
   *
   * `payload` above remains the AUTHORITY. Null means "no catalog copy", which
   * is the normal state and must stay a legal state forever: a caller whose CAS
   * write failed still journals its fact.
   *
   * G5 slice 3c-1 added the other direction: when `omitInlinePayload` below is
   * set, this reference is what the row's body IS, and the inline column is
   * left SQL NULL. The two columns are therefore jointly non-null — enforced by
   * the table CHECK added in 0128 — and never both absent.
   *
   * On the DUPLICATE path (the idempotency claim was already taken) this is
   * ignored, because no row is written — and the pre-existing row must keep its
   * own references. Stamping it with ours would assert that its inline payload
   * equals the body we just stored, which nothing has proven.
   *
   * DECISION #222: a reference is stamped only if the object it addresses is
   * still there, proved under a `FOR KEY SHARE` lock held until this insert
   * commits. If an erasure took the object in the meantime the reference is
   * DROPPED, the inline body is written instead, and the result reports
   * `payloadRefVanished`. A caller therefore cannot mint a dangling reference
   * here even by handing over a stale one.
   */
  payloadRef?: { bucketMonth: string; objectId: number } | null;
  /**
   * G5 slice 3c-1: write the journal row WITHOUT its inline body, because
   * `payloadRef` above already addresses that body in the content-addressed
   * catalog. Ignored — and that is a guarantee, not an accident — unless
   * `payloadRef` is set: the caller's flag can only ever REMOVE the second copy
   * of a body the catalog already holds, never the only copy of one.
   *
   * Everything the row derives from the payload is derived from the OBJECT
   * passed in above, not from the column: `payloadHash` is computed by the
   * producer before this call, and the typed queryable columns (slice 3a) are
   * derived below from `input.payload`. So a pointer-only row is identical to a
   * dual-written one in every column except the body itself.
   */
  omitInlinePayload?: boolean;
}

export type ObservationInsertResult =
  /** receivedAt is the journal row's received_at — on the duplicate path it
   * is the EXISTING key's received_at (partition-exact), so an immediate
   * projector can stamp with the (id, received_at) pair, never new Date().
   *
   * `payloadRefVanished` (decision #222) is true when a `payloadRef` was
   * supplied and the catalog object it addressed was GONE by the time this row
   * was written — an erasure sweep took it in the gap between the CAS commit
   * and this insert. The row was then written with NO reference and WITH its
   * inline body, so the fact is intact; the flag exists so the capture seam can
   * count how often the race actually happens. */
  | { inserted: true; observationId: number; receivedAt: Date; payloadRefVanished: boolean }
  | { inserted: false; observationId: number; receivedAt: Date; payloadRefVanished: boolean };

export async function insertObservation(
  db: Database,
  input: ObservationInsertInput,
): Promise<ObservationInsertResult> {
  // Outside the transaction on purpose: sequences are non-transactional, so
  // allocating here keeps the write transaction to two statements.
  const allocated = await db.execute<{ id: string }>(sql`
    select nextval(pg_get_serial_sequence('observations', 'id'))::text as id
  `);
  const observationId = Number(allocated.rows[0]!.id);
  // Stamped once here so the key row and the journal row always agree —
  // the key's received_at is how lookups reach the right partition.
  const receivedAt = input.receivedAt ?? new Date();

  const transaction = (
    db as Database & {
      transaction?: (
        callback: (tx: unknown) => Promise<ObservationInsertResult>,
      ) => Promise<ObservationInsertResult>;
    }
  ).transaction;

  // Already inside a caller's transaction: it owns the atomicity boundary
  // (and a nested savepoint would only add round trips). A handle with no
  // .transaction is a unit-test stub with no database behind it.
  if (is(db, PgTransaction) || typeof transaction !== "function") {
    return claimAndJournal(db, input, observationId, receivedAt);
  }

  // Bare-pool handle (every sync/webhook/capture producer in production):
  // BEGIN … claim … journal … COMMIT on ONE checked-out connection.
  return transaction.call(
    db,
    (tx) => claimAndJournal(tx as Database, input, observationId, receivedAt),
  );
}

async function claimAndJournal(
  db: Database,
  input: ObservationInsertInput,
  observationId: number,
  receivedAt: Date,
): Promise<ObservationInsertResult> {
  const claimed = await db.execute<{ observation_id: string }>(sql`
    insert into observation_keys (source, idempotency_key, observation_id, received_at)
    values (${input.source}, ${input.idempotencyKey}, ${observationId}, ${receivedAt})
    on conflict (source, idempotency_key) do nothing
    returning observation_id::text
  `);

  if (claimed.rows.length === 0) {
    const existing = await db.execute<{ observation_id: string; received_at: Date | string }>(sql`
      select observation_id::text, received_at
      from observation_keys
      where source = ${input.source} and idempotency_key = ${input.idempotencyKey}
    `);
    return {
      inserted: false,
      observationId: Number(existing.rows[0]!.observation_id),
      receivedAt: new Date(existing.rows[0]!.received_at),
      // No row is written on this path, so no reference is stamped and there is
      // nothing for the liveness lock below to prove.
      payloadRefVanished: false,
    };
  }

  // No cleanup path guards this insert any more: a failure (missing
  // partition, dead connection, crash) rolls back the claim with it — either
  // our own transaction's ROLLBACK, the caller's, or the server's when a
  // connection dies mid-transaction. The previous compensating DELETE could
  // only ever run when the process survived the error, which is exactly the
  // case the rollback now covers.
  // G5 slice 3a: the queryable fields, derived from the SAME object that is
  // about to become the inline `payload` and written INSIDE this insert. Not a
  // follow-up UPDATE — that would mint a second row version per capture on the
  // largest table in the system — and not derived at the producer, so a column
  // can never disagree with the body it was read off.
  const queryable = deriveObservationQueryableFields(input);
  // G5 slice 3c-1: the inline body is skipped only when a catalog reference is
  // going into the same row. The `payloadRef` conjunct is the invariant, not a
  // defensive nicety — it is what makes the table CHECK (0128: payload IS NOT
  // NULL OR payload_object_id IS NOT NULL) unreachable from this writer, and it
  // is why a caller that gets its own flag wrong loses nothing but disk. Note
  // the ORDER: `queryable` above is already derived from `input.payload`, so the
  // typed columns of slice 3a are computed from the object BEFORE any decision
  // about where that object's bytes are stored.
  //
  // G5 review fix (decision #222). The reference is stamped only while a
  // `FOR KEY SHARE` lock on the catalog row is HELD — taken here, released when
  // this transaction commits, which is the same instant this row becomes
  // visible. An erasure sweep that wants to delete that object has to take
  // `FOR UPDATE` on it first, so the two acts are now strictly ordered: either
  // the sweep waits for this insert and then SEES the reference (and keeps the
  // body), or it went first and this probe finds the object gone.
  //
  // Gone means the reference is dropped and the INLINE body is written instead
  // — the pre-G5 shape of a capture, which is always legal and always readable.
  // A pointer-only caller does not get to skip a body that no longer has a
  // catalog copy to point at.
  const payloadRef = input.payloadRef ?? null;
  const payloadRefVanished = payloadRef !== null
    && !(await lockCapturePayloadRefAlive(db, payloadRef));
  const liveRef = payloadRefVanished ? null : payloadRef;
  const omitInlinePayload = input.omitInlinePayload === true && liveRef !== null;
  await db.execute(sql`
    insert into observations (
      id, source, producer, platform, account_id, native_account_ref, kind,
      payload, payload_hash, idempotency_key, observed_at, received_at,
      actor_principal_id, payload_bucket_month, payload_object_id,
      harvest_machine_id, harvest_tx_id, harvest_tx_amount, harvest_tx_created_at
    ) overriding system value values (
      ${observationId},
      ${input.source},
      ${input.producer},
      ${input.platform ?? null},
      ${input.accountId ?? null},
      ${input.nativeAccountRef ?? null},
      ${input.kind},
      ${omitInlinePayload ? null : JSON.stringify(input.payload)}::jsonb,
      ${input.payloadHash},
      ${input.idempotencyKey},
      ${input.observedAt ?? null},
      ${receivedAt},
      ${input.actorPrincipalId ?? null},
      ${liveRef?.bucketMonth ?? null}::date,
      ${liveRef?.objectId ?? null},
      ${queryable.harvestMachineId},
      ${queryable.harvestTxId},
      ${queryable.harvestTxAmount},
      ${queryable.harvestTxCreatedAt}
    )
  `);

  return { inserted: true, observationId, receivedAt, payloadRefVanished };
}

/** Sequential batch insert; observations are small and producers batch lightly. */
export async function insertObservations(
  db: Database,
  inputs: readonly ObservationInsertInput[],
): Promise<ObservationInsertResult[]> {
  const results: ObservationInsertResult[] = [];
  for (const input of inputs) {
    results.push(await insertObservation(db, input));
  }
  return results;
}

/**
 * Staged-rollout compatibility for harvest rows written before machine-stable
 * idempotency keys. Old rows used <principal>:<clientEventId>; new rows use
 * <machine>:<clientEventId>. The expression index in migration 0090 keeps this
 * lookup bounded without rewriting or deleting immutable captured facts.
 */
// G5 slice 3a (§6.4): the machineId now has a typed column
// (`harvest_machine_id`, migration 0125) written at capture time, so this
// predicate no longer depends on the inline body for rows written since.
//
// TWO ARMS, NOT A `coalesce`. This is the ONE migrated predicate that is
// index-backed (0096's expression index), and `coalesce(harvest_machine_id,
// payload->>'machineId') = $1` is not indexable — it would turn a bounded probe
// into a scan of the largest table in the system. The arms below are disjoint by
// construction and each has its own partial index over the same predicate
// (0126's typed twin, 0096's expression original), so the planner builds a
// BitmapOr of two index scans. `tests/capture-queryable-columns.integration.
// test.ts` pins the plan.
export async function hasHarvestObservationClientEvent(
  db: Database,
  input: { machineId: string; clientEventId: string },
): Promise<boolean> {
  const existing = await db.execute<{ found: number }>(sql`
    select 1 as found
    from observations
    where source = 'client_capture'
      and producer like 'desktop-harvest@%'
      and kind like 'harvest.%'
      and split_part(idempotency_key, ':', 2) = ${input.clientEventId}
      and (
        harvest_machine_id = ${input.machineId}
        -- CAS-INLINE-FALLBACK: rows captured before 0125 carry a null typed
        -- column; the historical rewrite populates them, and then this arm and
        -- 0096's index go away together.
        or (harvest_machine_id is null and payload->>'machineId' = ${input.machineId})
      )
    limit 1
  `);
  return existing.rows.length > 0;
}

/**
 * Stage 12 reconciliation: kernel-side count for one machine + harvest kind.
 * The harvest payload carries machineId top-level (spec §2), and the lane
 * stamps producer='desktop-harvest@<version>'.
 */
// G5 slice 3a (§6.4): reads the typed column, falls back to the inline body.
//
// A plain `coalesce` is right HERE and wrong in the lookup above, because this
// predicate has no index to defeat: 0096's partial index requires
// `source = 'client_capture'`, which this query does not constrain, so the
// planner can never prove the index predicate and this count has always been a
// scan. Keeping the shape simple is the only thing left to optimize for.
export async function countHarvestObservations(
  db: Database,
  input: { machineId: string; kind: string },
): Promise<number> {
  const result = await db.execute<{ n: string }>(sql`
    select count(*)::text as n
    from observations
    where producer like 'desktop-harvest@%'
      and kind = ${input.kind}
      -- CAS-INLINE-FALLBACK: drop the coalesce once the historical rewrite has
      -- populated harvest_machine_id for every pre-0125 row.
      and coalesce(harvest_machine_id, payload->>'machineId') = ${input.machineId}
  `);
  return Number(result.rows[0]?.n ?? 0);
}

export interface HarvestTransactionResidueRow {
  observationId: number;
  accountId: number | null;
  txId: string | null;
  amount: string | null;
  createdAt: string | null;
}

/**
 * Stage 12 residue: harvested fan_transactions with NO counterpart in the
 * transactions TRUTH table (matched on the shared OFAPI id space). Report-only
 * by design — nothing here is ever ingested into money truth. NULL-account
 * rows (unmappable OFAPI account) always count as residue.
 */
// G5 slice 3a (§6.4): all four extractions now read their typed column
// (migration 0125) and fall back to the inline body for pre-slice rows. Same
// `coalesce` reasoning as countHarvestObservations — this predicate has never
// been index-backed (0096's partial index needs a `source` clause this query
// does not have), so there is no plan to protect, only shape to keep readable.
export async function listHarvestTransactionResidue(
  db: Database,
  input: { machineId: string; limit: number },
): Promise<{ total: number; sample: HarvestTransactionResidueRow[] }> {
  // CAS-INLINE-FALLBACK: each coalesce's second argument goes once the
  // historical rewrite has populated these columns for every pre-0125 row.
  const txId = sql`coalesce(o.harvest_tx_id, o.payload->'row'->>'tx_id')`;
  const residueWhere = sql`
    o.kind = 'harvest.fan_transactions'
      and o.producer like 'desktop-harvest@%'
      and coalesce(o.harvest_machine_id, o.payload->>'machineId') = ${input.machineId}
      and not exists (
        select 1 from transactions t
        where t.platform_account_id = o.account_id
          and t.transaction_id = ${txId}
      )
  `;
  const counted = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from observations o where ${residueWhere}
  `);
  const sample = await db.execute<{
    id: string;
    account_id: string | null;
    tx_id: string | null;
    amount: string | null;
    created_at: string | null;
  }>(sql`
    select o.id::text as id, o.account_id::text as account_id,
           ${txId} as tx_id,
           coalesce(o.harvest_tx_amount, o.payload->'row'->>'amount') as amount,
           coalesce(o.harvest_tx_created_at, o.payload->'row'->>'created_at') as created_at
    from observations o
    where ${residueWhere}
    order by o.id
    limit ${Math.max(1, input.limit)}
  `);
  return {
    total: Number(counted.rows[0]?.n ?? 0),
    sample: sample.rows.map((row) => ({
      observationId: Number(row.id),
      accountId: row.account_id === null ? null : Number(row.account_id),
      txId: row.tx_id,
      amount: row.amount,
      createdAt: row.created_at,
    })),
  };
}

export async function findObservationByKey(
  db: Database,
  source: ObservationSource,
  idempotencyKey: string,
) {
  const result = await db.execute<{
    id: string;
    source: string;
    producer: string;
    kind: string;
    received_at: Date;
  }>(sql`
    select o.id::text as id, o.source, o.producer, o.kind, o.received_at
    from observation_keys k
    join observations o on o.id = k.observation_id and o.received_at = k.received_at
    where k.source = ${source} and k.idempotency_key = ${idempotencyKey}
  `);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    source: row.source,
    producer: row.producer,
    kind: row.kind,
    receivedAt: new Date(row.received_at),
  };
}

export interface ObservationEnvelopeRow {
  kind: string;
  source: string;
  payload: unknown;
  /** G5 slice 2: the catalog reference this envelope carries, or null. The
   *  caller resolves it through apps/runtime/src/services/payload-reader.ts. */
  payloadRef: CapturePayloadRef | null;
}

/**
 * Envelope fetch for serve-time frame enrichment (kernel Stage 24): the v2
 * event stream attaches the source observation's verbatim payload to
 * message frames so projection-grade clients (the desktop) can ingest
 * without a read-gateway round trip. Partition-spanning id lookup — fine at
 * stream-batch sizes (each partition satisfies it from the PK index).
 */
export async function findObservationEnvelopesByIds(
  db: Database,
  ids: readonly number[],
): Promise<Map<number, ObservationEnvelopeRow>> {
  if (ids.length === 0) {
    return new Map();
  }
  // G5 slice 2: the two reference columns ride along so the caller can route
  // the body through the read seam. They cost two small scalars per row and
  // are null for everything captured outside the dual-write canary.
  const result = await db.execute<{
    id: string;
    kind: string;
    source: string;
    payload: unknown;
    payload_bucket_month: string | null;
    payload_object_id: string | null;
  }>(sql`
    select id::text as id, kind, source, payload,
           to_char(payload_bucket_month, 'YYYY-MM-DD') as payload_bucket_month,
           payload_object_id::text as payload_object_id
    from observations
    where id = any(${sql.raw(`array[${ids.map((id) => Number(id)).join(",")}]::bigint[]`)})
  `);
  const map = new Map<number, ObservationEnvelopeRow>();
  for (const row of result.rows) {
    map.set(Number(row.id), {
      kind: row.kind,
      source: row.source,
      payload: row.payload,
      payloadRef: capturePayloadRefFromColumns(row.payload_bucket_month, row.payload_object_id),
    });
  }
  return map;
}

function partitionName(year: number, month: number) {
  return `observations_${year}_${String(month).padStart(2, "0")}`;
}

function monthStart(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const zero = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
}

/** Exclusive upper bound for monthly pre-creation: migration 0082's
 * `*_future` catch-alls own [2031-01-01, MAXVALUE) — a monthly CREATE inside
 * that range would fail on overlap. The shrinking monthly lead pages the
 * owner through the observations_partitions incident before 2031 arrives
 * (the designed hand-off; see 0082). */
export const PARTITION_PRECREATE_HORIZON_YEAR = 2031;

function beyondPrecreateHorizon(year: number, month: number) {
  return year * 12 + (month - 1) >= PARTITION_PRECREATE_HORIZON_YEAR * 12;
}

/**
 * Pre-creates monthly partitions from the current month through
 * `monthsAhead` months out (stopping at the 0082 catch-all bound).
 * Idempotent (IF NOT EXISTS). Returns the names it ensured, newest last.
 */
export async function ensureObservationPartitions(
  db: Database,
  input?: { monthsAhead?: number; now?: Date },
): Promise<string[]> {
  const monthsAhead = input?.monthsAhead ?? 3;
  const now = input?.now ?? new Date();
  const ensured: string[] = [];
  for (let delta = 0; delta <= monthsAhead; delta += 1) {
    const { year, month } = addMonths(now.getUTCFullYear(), now.getUTCMonth() + 1, delta);
    if (beyondPrecreateHorizon(year, month)) {
      break;
    }
    const next = addMonths(year, month, 1);
    const name = partitionName(year, month);
    await db.execute(sql.raw(`
      create table if not exists "${name}" partition of "observations"
      for values from ('${monthStart(year, month)}') to ('${monthStart(next.year, next.month)}')
    `));
    ensured.push(name);
  }
  return ensured;
}

/**
 * How many full months of partition lead exist beyond the current month —
 * the pre-create job pages the owner when this drops below its floor.
 */
export async function getObservationPartitionLeadMonths(
  db: Database,
  now = new Date(),
): Promise<number> {
  let lead = 0;
  for (let delta = 1; delta <= 12; delta += 1) {
    const { year, month } = addMonths(now.getUTCFullYear(), now.getUTCMonth() + 1, delta);
    const exists = await db.execute<{ found: string | null }>(sql`
      select to_regclass(${`public.${partitionName(year, month)}`})::text as found
    `);
    if (exists.rows[0]?.found == null) {
      break;
    }
    lead += 1;
  }
  return lead;
}

// Stage 29: the acceptance projection walks desktop.ai_acceptance
// observations by id — a plain keyset listing, no parse_version coupling
// (the client-capture family stamps those; this side-table feed keeps its
// own watermark).
export interface ObservationByKindRow {
  id: number;
  payload: unknown;
  actorPrincipalId: number | null;
  observedAt: Date | null;
  receivedAt: Date;
  /** G5 slice 2: the catalog reference this envelope carries, or null. */
  payloadRef: CapturePayloadRef | null;
}

export async function listObservationsByKindAfterId(
  db: Database,
  input: { kind: string; afterId: number; limit?: number },
): Promise<ObservationByKindRow[]> {
  // o.id QUALIFIED on purpose: a bare `order by id` resolves to the ::text
  // output alias and sorts lexicographically ('10' < '5') — the recorded
  // Stage 8 trap, re-caught here by the Stage 31 idempotency test.
  const result = await db.execute<Record<string, unknown>>(sql`
    select o.id::text as id, o.payload, o.actor_principal_id, o.observed_at, o.received_at,
           to_char(o.payload_bucket_month, 'YYYY-MM-DD') as payload_bucket_month,
           o.payload_object_id::text as payload_object_id
    from observations o
    where o.kind = ${input.kind} and o.id > ${input.afterId}
    order by o.id asc
    limit ${input.limit ?? 500}
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    payload: row.payload,
    actorPrincipalId: row.actor_principal_id == null ? null : Number(row.actor_principal_id),
    observedAt: row.observed_at == null ? null : new Date(row.observed_at as string | Date),
    receivedAt: new Date(row.received_at as string | Date),
    payloadRef: capturePayloadRefFromColumns(
      row.payload_bucket_month as string | null,
      row.payload_object_id as string | null,
    ),
  }));
}
