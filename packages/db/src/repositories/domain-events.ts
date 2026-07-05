// Domain events ledger (kernel Stage 8). The canonical, queryable vocabulary
// derived from the Stage 7 observations journal — append-only, per-account
// gapless ordering, cross-producer dedup. The append protocol (spec §3):
// take the per-account counter row FOR UPDATE for the whole batch, then per
// event pre-allocate the identity id, claim (account_id, dedup_key) in the
// unpartitioned companion via ON CONFLICT DO NOTHING, and only then write the
// event row with OVERRIDING SYSTEM VALUE and the next sequence number. A lost
// claim is the dedup signal — the sequence does not advance, so account_seq
// stays gapless by construction under any job/worker concurrency.

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

export interface DomainEventInput {
  type: string;
  occurredAt: Date;
  /** Platform-native fan id — never fans.id (identity refactors must not invalidate the ledger). */
  fanIdentityRef?: string | null;
  conversationRef?: string | null;
  messageRef?: string | null;
  transactionRef?: string | null;
  data: unknown;
  schemaVersion: number;
  observationId: number;
  dedupKey: string;
}

export interface AppendDomainEventsResult {
  appended: number;
  deduped: number;
  /** The account's high-water sequence after this batch. */
  highWater: number;
}

/**
 * Appends a batch of canonical events for ONE account. Self-transactional:
 * the counter-row lock spans the whole batch, so concurrent appenders for the
 * same account serialize here and account_seq comes out gapless 1..K.
 */
export async function appendDomainEvents(
  db: Database,
  accountId: number,
  events: readonly DomainEventInput[],
): Promise<AppendDomainEventsResult> {
  if (events.length === 0) {
    const highWater = await getAccountHighWater(db, accountId);
    return { appended: 0, deduped: 0, highWater };
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into domain_event_seq (account_id) values (${accountId})
      on conflict (account_id) do nothing
    `);
    const locked = await tx.execute<{ next_seq: string }>(sql`
      select next_seq::text from domain_event_seq
      where account_id = ${accountId}
      for update
    `);
    let nextSeq = Number(locked.rows[0]!.next_seq);
    let appended = 0;
    let deduped = 0;

    for (const event of events) {
      const allocated = await tx.execute<{ id: string }>(sql`
        select nextval(pg_get_serial_sequence('domain_events', 'id'))::text as id
      `);
      const eventId = Number(allocated.rows[0]!.id);

      const claimed = await tx.execute(sql`
        insert into domain_event_keys (account_id, dedup_key, event_id, occurred_at)
        values (${accountId}, ${event.dedupKey}, ${eventId}, ${event.occurredAt})
        on conflict (account_id, dedup_key) do nothing
        returning event_id
      `);
      if (claimed.rows.length === 0) {
        deduped += 1;
        continue;
      }

      await tx.execute(sql`
        insert into domain_events (
          id, account_id, account_seq, type, occurred_at, fan_identity_ref,
          conversation_ref, message_ref, transaction_ref, data, schema_version,
          observation_id, dedup_key
        ) overriding system value values (
          ${eventId},
          ${accountId},
          ${nextSeq},
          ${event.type},
          ${event.occurredAt},
          ${event.fanIdentityRef ?? null},
          ${event.conversationRef ?? null},
          ${event.messageRef ?? null},
          ${event.transactionRef ?? null},
          ${JSON.stringify(event.data)}::jsonb,
          ${event.schemaVersion},
          ${event.observationId},
          ${event.dedupKey}
        )
      `);
      nextSeq += 1;
      appended += 1;
    }

    if (appended > 0) {
      await tx.execute(sql`
        update domain_event_seq set next_seq = ${nextSeq}
        where account_id = ${accountId}
      `);
    }

    return { appended, deduped, highWater: nextSeq - 1 };
  });
}

/** The account's highest assigned account_seq (0 when no events yet). */
export async function getAccountHighWater(db: Database, accountId: number): Promise<number> {
  const result = await db.execute<{ next_seq: string }>(sql`
    select next_seq::text from domain_event_seq where account_id = ${accountId}
  `);
  const row = result.rows[0];
  return row ? Number(row.next_seq) - 1 : 0;
}

export interface DomainEventRow {
  id: number;
  accountId: number;
  accountSeq: number;
  type: string;
  occurredAt: Date;
  fanIdentityRef: string | null;
  conversationRef: string | null;
  messageRef: string | null;
  transactionRef: string | null;
  data: unknown;
  schemaVersion: number;
  observationId: number;
  dedupKey: string;
  createdAt: Date;
}

function mapEventRow(row: Record<string, unknown>): DomainEventRow {
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    accountSeq: Number(row.account_seq),
    type: String(row.type),
    occurredAt: new Date(row.occurred_at as string | Date),
    fanIdentityRef: (row.fan_identity_ref as string | null) ?? null,
    conversationRef: (row.conversation_ref as string | null) ?? null,
    messageRef: (row.message_ref as string | null) ?? null,
    transactionRef: (row.transaction_ref as string | null) ?? null,
    data: row.data,
    schemaVersion: Number(row.schema_version),
    observationId: Number(row.observation_id),
    dedupKey: String(row.dedup_key),
    createdAt: new Date(row.created_at as string | Date),
  };
}

/** Ordered per-account read: events with account_seq > afterSeq. */
export async function listEventsSince(
  db: Database,
  input: { accountId: number; afterSeq: number; limit?: number },
): Promise<DomainEventRow[]> {
  const limit = input.limit ?? 500;
  // NB: ORDER BY must use the QUALIFIED column — a bare account_seq would
  // resolve to the ::text output alias and sort lexicographically (1,10,11,…,2).
  const result = await db.execute<Record<string, unknown>>(sql`
    select de.id::text as id, de.account_id, de.account_seq::text as account_seq, de.type,
           de.occurred_at, de.fan_identity_ref, de.conversation_ref, de.message_ref,
           de.transaction_ref, de.data, de.schema_version, de.observation_id::text as observation_id,
           de.dedup_key, de.created_at
    from domain_events de
    where de.account_id = ${input.accountId} and de.account_seq > ${input.afterSeq}
    order by de.account_seq asc
    limit ${limit}
  `);
  return result.rows.map(mapEventRow);
}

export interface ReplayObservationRow {
  id: number;
  source: string;
  producer: string;
  platform: string | null;
  accountId: number | null;
  nativeAccountRef: string | null;
  kind: string;
  payload: unknown;
  observedAt: Date | null;
  receivedAt: Date;
  parseVersion: number;
}

/**
 * Observations awaiting (re-)canonicalization: parse_version below the
 * caller's current version, optionally narrowed by kind/account/received
 * window. Keyset-paged by id — the minutely sweep and the replay CLI are the
 * same executor over this listing.
 */
export async function listObservationsForReplay(
  db: Database,
  input: {
    belowParseVersion: number;
    source?: string;
    kinds?: readonly string[];
    accountId?: number | null;
    from?: Date | null;
    to?: Date | null;
    afterId?: number | null;
    limit?: number;
  },
): Promise<ReplayObservationRow[]> {
  const limit = input.limit ?? 200;
  const conditions = [sql`o.parse_version < ${input.belowParseVersion}`];
  if (input.source !== undefined) {
    conditions.push(sql`o.source = ${input.source}`);
  }
  if (input.kinds !== undefined && input.kinds.length > 0) {
    conditions.push(sql`o.kind in (${sql.join(input.kinds.map((kind) => sql`${kind}`), sql`, `)})`);
  }
  if (input.accountId != null) {
    conditions.push(sql`o.account_id = ${input.accountId}`);
  }
  if (input.from) {
    conditions.push(sql`o.received_at >= ${input.from}`);
  }
  if (input.to) {
    conditions.push(sql`o.received_at < ${input.to}`);
  }
  if (input.afterId != null) {
    conditions.push(sql`o.id > ${input.afterId}`);
  }

  const result = await db.execute<Record<string, unknown>>(sql`
    select o.id::text as id, o.source, o.producer, o.platform, o.account_id,
           o.native_account_ref, o.kind, o.payload, o.observed_at,
           o.received_at, o.parse_version
    from observations o
    where ${sql.join(conditions, sql` and `)}
    order by o.id asc
    limit ${limit}
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    source: String(row.source),
    producer: String(row.producer),
    platform: (row.platform as string | null) ?? null,
    accountId: row.account_id == null ? null : Number(row.account_id),
    nativeAccountRef: (row.native_account_ref as string | null) ?? null,
    kind: String(row.kind),
    payload: row.payload,
    observedAt: row.observed_at == null ? null : new Date(row.observed_at as string | Date),
    receivedAt: new Date(row.received_at as string | Date),
    parseVersion: Number(row.parse_version),
  }));
}

/**
 * Stamps an observation as consumed by canonicalizer version N. Forward-only:
 * a concurrent higher-version stamp is never regressed.
 */
export async function markObservationParsed(
  db: Database,
  input: { observationId: number; receivedAt: Date; parseVersion: number },
): Promise<void> {
  await db.execute(sql`
    update observations set parse_version = ${input.parseVersion}
    where id = ${input.observationId}
      and received_at = ${input.receivedAt}
      and parse_version < ${input.parseVersion}
  `);
}

function partitionName(year: number, month: number) {
  return `domain_events_${year}_${String(month).padStart(2, "0")}`;
}

function monthStart(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const zero = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
}

/** Same contract as ensureObservationPartitions, for the events ledger. */
export async function ensureDomainEventPartitions(
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
      create table if not exists "${name}" partition of "domain_events"
      for values from ('${monthStart(year, month)}') to ('${monthStart(next.year, next.month)}')
    `));
    ensured.push(name);
  }
  return ensured;
}

/** Partition lead beyond the current month — the pre-create job's floor signal. */
export async function getDomainEventPartitionLeadMonths(
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
