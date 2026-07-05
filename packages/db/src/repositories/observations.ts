// Observations journal (kernel Stage 7). Append-only capture spine — inserts
// only, no update/delete surface by design. The insert protocol (spec §3,
// decision #64): pre-allocate the identity id, claim (source, idempotency_key)
// in the unpartitioned companion via ON CONFLICT DO NOTHING, and only then
// write the journal row with OVERRIDING SYSTEM VALUE. A lost claim is the
// duplicate signal — no journal write, no rollback, composable inside a
// caller's transaction (the webhook receiver runs this inside its own tx).
// Identity-sequence gaps from duplicates are harmless.

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import type { ObservationSource } from "../schema.ts";

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
}

export type ObservationInsertResult =
  | { inserted: true; observationId: number }
  | { inserted: false; observationId: number };

export async function insertObservation(
  db: Database,
  input: ObservationInsertInput,
): Promise<ObservationInsertResult> {
  const allocated = await db.execute<{ id: string }>(sql`
    select nextval(pg_get_serial_sequence('observations', 'id'))::text as id
  `);
  const observationId = Number(allocated.rows[0]!.id);
  // Stamped once here so the key row and the journal row always agree —
  // the key's received_at is how lookups reach the right partition, and the
  // caller may or may not have wrapped us in a transaction.
  const receivedAt = input.receivedAt ?? new Date();

  const claimed = await db.execute<{ observation_id: string }>(sql`
    insert into observation_keys (source, idempotency_key, observation_id, received_at)
    values (${input.source}, ${input.idempotencyKey}, ${observationId}, ${receivedAt})
    on conflict (source, idempotency_key) do nothing
    returning observation_id::text
  `);

  if (claimed.rows.length === 0) {
    const existing = await db.execute<{ observation_id: string }>(sql`
      select observation_id::text
      from observation_keys
      where source = ${input.source} and idempotency_key = ${input.idempotencyKey}
    `);
    return { inserted: false, observationId: Number(existing.rows[0]!.observation_id) };
  }

  try {
    await db.execute(sql`
      insert into observations (
        id, source, producer, platform, account_id, native_account_ref, kind,
        payload, payload_hash, idempotency_key, observed_at, received_at,
        actor_principal_id
      ) overriding system value values (
        ${observationId},
        ${input.source},
        ${input.producer},
        ${input.platform ?? null},
        ${input.accountId ?? null},
        ${input.nativeAccountRef ?? null},
        ${input.kind},
        ${JSON.stringify(input.payload)}::jsonb,
        ${input.payloadHash},
        ${input.idempotencyKey},
        ${input.observedAt ?? null},
        ${receivedAt},
        ${input.actorPrincipalId ?? null}
      )
    `);
  } catch (error) {
    // If the journal insert fails (e.g. missing partition) while running in
    // autocommit, the key claim above has already committed — an orphaned
    // claim would make the producer's retry look like a duplicate and lose
    // the fact. Release exactly OUR claim (scoped by observation_id, so a
    // concurrent duplicate's claim is never touched), then fail loudly with
    // the ORIGINAL error. Inside a caller transaction the delete itself fails
    // ("transaction is aborted") — swallowed: the caller's rollback removes
    // the claim there anyway.
    try {
      await db.execute(sql`
        delete from observation_keys
        where source = ${input.source}
          and idempotency_key = ${input.idempotencyKey}
          and observation_id = ${observationId}
      `);
    } catch {
      // Aborted-transaction path; the rollback owns cleanup.
    }
    throw error;
  }

  return { inserted: true, observationId };
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
 * Stage 12 reconciliation: kernel-side count for one machine + harvest kind.
 * The harvest payload carries machineId top-level (spec §2), and the lane
 * stamps producer='desktop-harvest@<version>'.
 */
export async function countHarvestObservations(
  db: Database,
  input: { machineId: string; kind: string },
): Promise<number> {
  const result = await db.execute<{ n: string }>(sql`
    select count(*)::text as n
    from observations
    where producer like 'desktop-harvest@%'
      and kind = ${input.kind}
      and payload->>'machineId' = ${input.machineId}
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
export async function listHarvestTransactionResidue(
  db: Database,
  input: { machineId: string; limit: number },
): Promise<{ total: number; sample: HarvestTransactionResidueRow[] }> {
  const residueWhere = sql`
    o.kind = 'harvest.fan_transactions'
      and o.producer like 'desktop-harvest@%'
      and o.payload->>'machineId' = ${input.machineId}
      and not exists (
        select 1 from transactions t
        where t.platform_account_id = o.account_id
          and t.transaction_id = o.payload->'row'->>'tx_id'
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
           o.payload->'row'->>'tx_id' as tx_id,
           o.payload->'row'->>'amount' as amount,
           o.payload->'row'->>'created_at' as created_at
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
): Promise<Map<number, { kind: string; source: string; payload: unknown }>> {
  if (ids.length === 0) {
    return new Map();
  }
  const result = await db.execute<{ id: string; kind: string; source: string; payload: unknown }>(sql`
    select id::text as id, kind, source, payload
    from observations
    where id = any(${sql.raw(`array[${ids.map((id) => Number(id)).join(",")}]::bigint[]`)})
  `);
  const map = new Map<number, { kind: string; source: string; payload: unknown }>();
  for (const row of result.rows) {
    map.set(Number(row.id), { kind: row.kind, source: row.source, payload: row.payload });
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

/**
 * Pre-creates monthly partitions from the current month through
 * `monthsAhead` months out. Idempotent (IF NOT EXISTS). Returns the names it
 * ensured, newest last.
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
