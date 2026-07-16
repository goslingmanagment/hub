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

export interface AppendedDomainEventOutcome {
  dedupKey: string;
  /** The event id this key resolves to: the freshly appended event, or the
   * EXISTING claim's event on dedupe (Wave 2: the corrections reconciler
   * links supersedesEventId / emitted_event_id through this). */
  eventId: number;
  appended: boolean;
}

export interface AppendDomainEventsResult {
  appended: number;
  deduped: number;
  /** The account's high-water sequence after this batch. */
  highWater: number;
  /** Per-event outcome in input order (additive, Wave 2). */
  events: AppendedDomainEventOutcome[];
}

export interface ProjectionCheckpointInput {
  occurredAt: Date;
  observationId: number;
  dedupKey: string;
  data?: Record<string, unknown>;
}

const PROJECTION_ONLY_DOMAIN_EVENT_TYPES = new Set([
  "message.material_observed",
  "capture.coverage_observed",
]);

export function isProjectionOnlyDomainEventType(type: string) {
  return PROJECTION_ONLY_DOMAIN_EVENT_TYPES.has(type);
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
  return appendDomainEventsBatch(db, accountId, events, null);
}

/**
 * Appends projection-only material and, in the SAME account-seq transaction,
 * one visible checkpoint covering exactly the rows that were newly appended.
 * A client can skip the hidden range without mistaking a real ledger hole for
 * projection traffic. Replays that dedupe the whole batch append nothing.
 */
export async function appendProjectionOnlyDomainEvents(
  db: Database,
  accountId: number,
  events: readonly DomainEventInput[],
  checkpoint: ProjectionCheckpointInput,
): Promise<AppendDomainEventsResult> {
  if (events.some((event) => !isProjectionOnlyDomainEventType(event.type))) {
    throw new Error("Projection-only append received a deliverable domain event");
  }
  return appendDomainEventsBatch(db, accountId, events, checkpoint);
}

/** Same append protocol when the caller already owns the surrounding DB
 * transaction. Used when a projection-only fact must commit atomically with
 * the state transition that authorizes it. */
export async function appendProjectionOnlyDomainEventsInTransaction(
  db: Database,
  accountId: number,
  events: readonly DomainEventInput[],
  checkpoint: ProjectionCheckpointInput,
): Promise<AppendDomainEventsResult> {
  if (events.some((event) => !isProjectionOnlyDomainEventType(event.type))) {
    throw new Error("Projection-only append received a deliverable domain event");
  }
  return appendDomainEventsBatchInTransaction(db, accountId, events, checkpoint);
}

async function appendDomainEventsBatch(
  db: Database,
  accountId: number,
  events: readonly DomainEventInput[],
  checkpoint: ProjectionCheckpointInput | null,
): Promise<AppendDomainEventsResult> {
  if (events.length === 0) {
    const highWater = await getAccountHighWater(db, accountId);
    return { appended: 0, deduped: 0, highWater, events: [] };
  }

  return db.transaction(async (tx) =>
    appendDomainEventsBatchInTransaction(tx as unknown as Database, accountId, events, checkpoint)
  );
}

async function appendDomainEventsBatchInTransaction(
  db: Database,
  accountId: number,
  events: readonly DomainEventInput[],
  checkpoint: ProjectionCheckpointInput | null,
): Promise<AppendDomainEventsResult> {
  await db.execute(sql`
    insert into domain_event_seq (account_id) values (${accountId})
    on conflict (account_id) do nothing
  `);
  const locked = await db.execute<{ next_seq: string }>(sql`
    select next_seq::text from domain_event_seq
    where account_id = ${accountId}
    for update
  `);
  let nextSeq = Number(locked.rows[0]!.next_seq);
  let appended = 0;
  let deduped = 0;
  const outcomes: AppendedDomainEventOutcome[] = [];

  const appendOne = async (event: DomainEventInput) => {
    const allocated = await db.execute<{ id: string }>(sql`
      select nextval(pg_get_serial_sequence('domain_events', 'id'))::text as id
    `);
    const eventId = Number(allocated.rows[0]!.id);

    const claimed = await db.execute(sql`
      insert into domain_event_keys (account_id, dedup_key, event_id, occurred_at)
      values (${accountId}, ${event.dedupKey}, ${eventId}, ${event.occurredAt})
      on conflict (account_id, dedup_key) do nothing
      returning event_id
    `);
    if (claimed.rows.length === 0) {
      deduped += 1;
      // Surface the EXISTING claim's event id — the dedup outcome is a
      // resolution, not a black hole (Wave 2 linkage).
      const existing = await db.execute<{ event_id: string }>(sql`
        select event_id::text from domain_event_keys
        where account_id = ${accountId} and dedup_key = ${event.dedupKey}
      `);
      outcomes.push({
        dedupKey: event.dedupKey,
        eventId: Number(existing.rows[0]!.event_id),
        appended: false,
      });
      return false;
    }
    outcomes.push({ dedupKey: event.dedupKey, eventId, appended: true });

    await db.execute(sql`
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
    return true;
  };

  for (const event of events) {
    await appendOne(event);
  }

  const hiddenAppended = appended;
  if (checkpoint !== null && hiddenAppended > 0) {
    const checkpointAppended = await appendOne({
      type: "stream.projection_checkpoint",
      occurredAt: checkpoint.occurredAt,
      data: {
        ...(checkpoint.data ?? {}),
        hiddenCount: hiddenAppended,
      },
      schemaVersion: 1,
      observationId: checkpoint.observationId,
      dedupKey: checkpoint.dedupKey,
    });
    if (!checkpointAppended) {
      throw new Error("Projection checkpoint was already claimed for newly appended material");
    }
  }

  if (appended > 0) {
    await db.execute(sql`
      update domain_event_seq set next_seq = ${nextSeq}
      where account_id = ${accountId}
    `);
    // Stage 21 fan-out: one wake-up per (account, batch), fired on COMMIT.
    // The payload is advisory — the hub drains forward from its own
    // watermark, never builds frames from notifications.
    await db.execute(sql`
      select pg_notify(${DOMAIN_EVENTS_APPENDED_CHANNEL}, ${`${accountId}:${nextSeq - 1}`})
    `);
  }

  return { appended, deduped, highWater: nextSeq - 1, events: outcomes };
}

/** LISTEN/NOTIFY channel for domain-event appends (kernel Stage 21). */
export const DOMAIN_EVENTS_APPENDED_CHANNEL = "domain_events_appended";

/** Every account's high-water sequence (next_seq - 1), the v2 "now" cursor source. */
export async function listDomainEventHighWaters(db: Database): Promise<Map<number, number>> {
  const result = await db.execute<{ account_id: number; high: string }>(sql`
    select account_id, (next_seq - 1)::text as high from domain_event_seq
  `);
  const map = new Map<number, number>();
  for (const row of result.rows) {
    map.set(Number(row.account_id), Number(row.high));
  }
  return map;
}

export interface DomainEventAccountBounds {
  accountId: number;
  /** Lowest retained account_seq (null when the account has no retained rows). */
  oldestRetainedSeq: number | null;
  /** High-water from the gapless counter (authoritative even with zero rows). */
  currentSeq: number;
}

/**
 * Retention bounds per account for the v2 gap rule: a resume watermark below
 * `oldestRetainedSeq - 1` cannot be replayed (rows pruned — real after
 * Stage 28's tiering), and one ahead of `currentSeq` never existed.
 */
export async function listDomainEventAccountBounds(
  db: Database,
  accountIds: readonly number[],
): Promise<Map<number, DomainEventAccountBounds>> {
  const bounds = new Map<number, DomainEventAccountBounds>();
  if (accountIds.length === 0) {
    return bounds;
  }
  const result = await db.execute<Record<string, unknown>>(sql`
    select s.account_id,
           (s.next_seq - 1)::text as current_seq,
           min(de.account_seq)::text as oldest_retained
    from domain_event_seq s
    left join domain_events de on de.account_id = s.account_id
    where s.account_id in (${sql.join(accountIds.map((id) => sql`${id}`), sql`, `)})
    group by s.account_id, s.next_seq
  `);
  for (const row of result.rows) {
    bounds.set(Number(row.account_id), {
      accountId: Number(row.account_id),
      oldestRetainedSeq: row.oldest_retained == null ? null : Number(row.oldest_retained),
      currentSeq: Number(row.current_seq),
    });
  }
  // Accounts with no counter row yet: zero events, currentSeq 0.
  for (const accountId of accountIds) {
    if (!bounds.has(accountId)) {
      bounds.set(accountId, { accountId, oldestRetainedSeq: null, currentSeq: 0 });
    }
  }
  return bounds;
}

/** Accounts whose requested gapless replay interval contains an internal hot-
 * ledger hole. `min(account_seq)` only detects a removed prefix; Stage 28
 * detaches partitions by occurred_at, so a backfilled old event can disappear
 * between two retained sequence numbers. */
export async function listDomainEventReplayContinuityGaps(
  db: Database,
  intervals: ReadonlyArray<{
    accountId: number;
    afterSeq: number;
    throughSeq: number;
  }>,
): Promise<Set<number>> {
  if (intervals.length === 0) {
    return new Set();
  }
  const requestedRows = sql.join(
    intervals.map((interval) => sql`(
      ${interval.accountId}::bigint,
      ${interval.afterSeq}::bigint,
      ${interval.throughSeq}::bigint
    )`),
    sql`, `,
  );
  const result = await db.execute<{ account_id: string | number }>(sql`
    with requested(account_id, after_seq, through_seq) as (
      values ${requestedRows}
    )
    select requested.account_id
    from requested
    left join domain_events event
      on event.account_id = requested.account_id
     and event.account_seq > requested.after_seq
     and event.account_seq <= requested.through_seq
    group by requested.account_id, requested.after_seq, requested.through_seq
    having count(distinct event.account_seq)::bigint
      <> greatest(requested.through_seq - requested.after_seq, 0)
  `);
  return new Set(result.rows.map((row) => Number(row.account_id)));
}

/**
 * Returns the last sequence that can be replayed contiguously from each
 * interval's `afterSeq`. This lets the stream drain a retained prefix before
 * it asks the client to snapshot an erased hole. In particular, an event that
 * the durable-state snapshot cannot replace must be delivered before a later
 * hole is crossed.
 */
export async function listDomainEventContiguousReplayEnds(
  db: Database,
  intervals: ReadonlyArray<{
    accountId: number;
    afterSeq: number;
    throughSeq: number;
  }>,
  options?: { excludeProjectionOnly?: boolean },
): Promise<Map<number, number>> {
  if (intervals.length === 0) {
    return new Map();
  }
  const requestedRows = sql.join(
    intervals.map((interval) => sql`(
      ${interval.accountId}::bigint,
      ${interval.afterSeq}::bigint,
      ${interval.throughSeq}::bigint
    )`),
    sql`, `,
  );
  if (options?.excludeProjectionOnly === true) {
    const classified = await db.execute<{
      account_id: string | number;
      contiguous_through: string | number;
    }>(sql`
      with requested(account_id, after_seq, through_seq) as (
        values ${requestedRows}
      ), normalized as (
        select account_id,
               least(after_seq, through_seq) as base_seq,
               through_seq
        from requested
      ), visible as (
        select normalized.account_id,
               normalized.base_seq,
               normalized.through_seq,
               event.account_seq,
               event.type,
               event.data,
               lag(event.account_seq, 1, normalized.base_seq) over (
                 partition by normalized.account_id
                 order by event.account_seq
               ) as previous_seq
        from normalized
        join domain_events event
          on event.account_id = normalized.account_id
         and event.account_seq > normalized.base_seq
         and event.account_seq <= normalized.through_seq
         and event.type not in ('message.material_observed', 'capture.coverage_observed')
      ), classified as (
        select *,
               case
                 when type = 'stream.projection_checkpoint' then
                   coalesce(data->>'hiddenCount', '') ~ '^[0-9]+$'
                   and (data->>'hiddenCount')::bigint = account_seq - previous_seq - 1
                 else account_seq = previous_seq + 1
               end as edge_valid
        from visible
      ), summary as (
        select account_id,
               min(previous_seq) filter (where not edge_valid) as before_first_gap,
               max(account_seq) as last_visible
        from classified
        group by account_id
      )
      select normalized.account_id,
             greatest(
               normalized.base_seq,
               least(
                 normalized.through_seq,
                 coalesce(
                   summary.before_first_gap,
                   summary.last_visible,
                   normalized.base_seq
                 )
               )
             )::text as contiguous_through
      from normalized
      left join summary using (account_id)
    `);
    return new Map(classified.rows.map((row) => [
      Number(row.account_id),
      Number(row.contiguous_through),
    ]));
  }

  const result = await db.execute<{
    account_id: string | number;
    contiguous_through: string | number;
  }>(sql`
    with requested(account_id, after_seq, through_seq) as (
      values ${requestedRows}
    ), normalized as (
      select account_id,
             least(after_seq, through_seq) as base_seq,
             through_seq
      from requested
    ), indexed as (
      select normalized.account_id,
             normalized.base_seq,
             event.account_seq,
             row_number() over (
               partition by normalized.account_id
               order by event.account_seq
             ) as ordinal
      from normalized
      join domain_events event
        on event.account_id = normalized.account_id
       and event.account_seq > normalized.base_seq
       and event.account_seq <= normalized.through_seq
    ), retained as (
      select account_id,
             count(*)::bigint as retained_count,
             min(base_seq + ordinal - 1) filter (
               where account_seq <> base_seq + ordinal
             ) as before_first_gap
      from indexed
      group by account_id
    )
    select normalized.account_id,
           greatest(
             normalized.base_seq,
             least(
               normalized.through_seq,
               coalesce(
                 retained.before_first_gap,
                 normalized.base_seq + coalesce(retained.retained_count, 0)
               )
             )
           )::text as contiguous_through
    from normalized
    left join retained using (account_id)
  `);

  return new Map(result.rows.map((row) => [
    Number(row.account_id),
    Number(row.contiguous_through),
  ]));
}

/**
 * Computes the minimum cursor a state-snapshot recovery may install to get
 * past a missing run that starts immediately after the rejected source
 * cursor. A fan erasure can remove a row from the middle (or tail) of an
 * otherwise gapless account ledger while `domain_event_seq` deliberately
 * retains its high-water.
 *
 * This deliberately does not jump over a retained prefix before a later hole:
 * that prefix may contain an event that the durable-state snapshot cannot
 * replace. The stream drains such a prefix first and closes; the next recovery
 * request then names the cursor immediately before the hole.
 *
 * `afterSeq` is defensively clamped to `throughSeq` so this repository cannot
 * manufacture a future watermark. The route separately treats an ahead-of-
 * head source as untrusted and passes zero. Accounts whose next row is retained
 * simply return the clamped cursor; the ordinary snapshot barrier decides how
 * far they may advance.
 */
export async function listDomainEventSnapshotRecoveryFloors(
  db: Database,
  intervals: ReadonlyArray<{
    accountId: number;
    afterSeq: number;
    throughSeq: number;
  }>,
): Promise<Map<number, number>> {
  if (intervals.length === 0) {
    return new Map();
  }
  const requestedRows = sql.join(
    intervals.map((interval) => sql`(
      ${interval.accountId}::bigint,
      ${interval.afterSeq}::bigint,
      ${interval.throughSeq}::bigint
    )`),
    sql`, `,
  );
  const result = await db.execute<{
    account_id: string | number;
    recovery_floor: string | number;
  }>(sql`
    with requested(account_id, after_seq, through_seq) as (
      values ${requestedRows}
    ), normalized as (
      select account_id,
             least(after_seq, through_seq) as base_seq,
             through_seq
      from requested
    ), retained as (
      select normalized.account_id,
             min(event.account_seq) as first_retained_seq
      from normalized
      left join domain_events event
        on event.account_id = normalized.account_id
       and event.account_seq > normalized.base_seq
       and event.account_seq <= normalized.through_seq
      group by normalized.account_id
    )
    select normalized.account_id,
           case
             when normalized.through_seq <= normalized.base_seq
               then normalized.base_seq
             when retained.first_retained_seq is null
               then normalized.through_seq
             when retained.first_retained_seq > normalized.base_seq + 1
               then retained.first_retained_seq - 1
             else normalized.base_seq
           end::text as recovery_floor
    from normalized
    join retained using (account_id)
  `);

  return new Map(result.rows.map((row) => [
    Number(row.account_id),
    Number(row.recovery_floor),
  ]));
}

export interface DomainEventErasureEpoch {
  /** Highest started non-dry-run erasure. Zero before the first execution. */
  epoch: number;
  /** True while an execution died or is still running before completion. */
  incomplete: boolean;
}

/**
 * Global erasure generation used by the legacy v2 snapshot-recovery cursor.
 * executeErasure commits its log row before deleting state or ledger rows, so
 * any erasure that can change a recovery proof first changes this value. Dry
 * runs are excluded because they mutate neither plane.
 */
export async function getDomainEventErasureEpoch(
  db: Database,
): Promise<DomainEventErasureEpoch> {
  const result = await db.execute<{
    epoch: string | number;
    incomplete: boolean;
  }>(sql`
    select coalesce(max(id), 0)::text as epoch,
           coalesce(bool_or(resolution_kind is null and completed_at is null), false) as incomplete
    from erasure_log
    where dry_run = false
  `);
  return {
    epoch: Number(result.rows[0]?.epoch ?? 0),
    incomplete: result.rows[0]?.incomplete === true,
  };
}

/**
 * Counts retained rows in immutable recovery intervals. Since account_seq is
 * append-only and never backfilled, a changed count for `(base, target]`
 * proves that erasure or retention changed the gap topology after snapshot
 * minting. Rows appended above target do not affect the proof.
 */
export async function listDomainEventRecoveryRetainedCounts(
  db: Database,
  intervals: ReadonlyArray<{
    accountId: number;
    baseSeq: number;
    targetSeq: number;
  }>,
): Promise<Map<number, number>> {
  if (intervals.length === 0) {
    return new Map();
  }
  const requestedRows = sql.join(
    intervals.map((interval) => sql`(
      ${interval.accountId}::bigint,
      ${interval.baseSeq}::bigint,
      ${interval.targetSeq}::bigint
    )`),
    sql`, `,
  );
  const result = await db.execute<{
    account_id: string | number;
    retained_count: string | number;
  }>(sql`
    with requested(account_id, base_seq, target_seq) as (
      values ${requestedRows}
    )
    select requested.account_id,
           count(event.account_seq)::text as retained_count
    from requested
    left join domain_events event
      on event.account_id = requested.account_id
     and event.account_seq > requested.base_seq
     and event.account_seq <= requested.target_seq
    group by requested.account_id
  `);
  return new Map(result.rows.map((row) => [
    Number(row.account_id),
    Number(row.retained_count),
  ]));
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
  input: {
    accountId: number;
    afterSeq: number;
    /** Inclusive replay ceiling captured after the live subscription. */
    throughSeq?: number;
    limit?: number;
    excludeProjectionOnly?: boolean;
  },
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
    where de.account_id = ${input.accountId}
      and de.account_seq > ${input.afterSeq}
      ${input.throughSeq === undefined ? sql`` : sql`and de.account_seq <= ${input.throughSeq}`}
      ${input.excludeProjectionOnly === true
        ? sql`and de.type not in ('message.material_observed', 'capture.coverage_observed')`
        : sql``}
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

/** Same contract as ensureObservationPartitions, for the events ledger
 * (incl. the 0082 pre-create horizon — see PARTITION_PRECREATE_HORIZON_YEAR
 * in observations.ts: [2031-01-01, MAXVALUE) belongs to the catch-all). */
export async function ensureDomainEventPartitions(
  db: Database,
  input?: { monthsAhead?: number; now?: Date },
): Promise<string[]> {
  const monthsAhead = input?.monthsAhead ?? 3;
  const now = input?.now ?? new Date();
  const ensured: string[] = [];
  for (let delta = 0; delta <= monthsAhead; delta += 1) {
    const { year, month } = addMonths(now.getUTCFullYear(), now.getUTCMonth() + 1, delta);
    if (year >= 2031) {
      break;
    }
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
