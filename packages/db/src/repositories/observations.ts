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
    // concurrent duplicate's claim is never touched), then fail loudly.
    // Inside a caller transaction this is redundant but harmless — the
    // rollback removes both anyway.
    await db.execute(sql`
      delete from observation_keys
      where source = ${input.source}
        and idempotency_key = ${input.idempotencyKey}
        and observation_id = ${observationId}
    `);
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
