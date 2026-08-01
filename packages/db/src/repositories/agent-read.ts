import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import { agentDatasetSqlMapping } from "./agent-dataset-map.ts";
import { mintPlaneReadWitness, storeDerivedWitness, type PlaneReadWitness } from "./agent-read-witness.ts";

/**
 * Every read the Agent Read Plane performs, except the transcript union (its own
 * module) and the key/audit tables (slice 0a).
 *
 * TWO RULES THAT SHAPE EVERY QUERY HERE:
 *
 * 1. **The grant is intersected in SQL, never after the fetch.** Each function
 *    takes an already-resolved `pageIds` list and binds it into the statement.
 *    An EMPTY list means "no visible pages" and must return nothing — every query
 *    therefore short-circuits on it rather than handing an empty array to a
 *    filter that would read it as "no filter at all".
 * 2. **A `read` verdict is minted here or nowhere.** Functions that consult a
 *    capture plane return `PlaneReadWitness` values alongside their rows, and the
 *    witness constructor is not exported from the package barrel. A handler can
 *    therefore never claim it read a plane it did not.
 *
 * `statement_timeout` is applied per statement through `withAgentStatementTimeout`
 * so a pathological scan degrades into a named source error instead of holding a
 * connection.
 */

/**
 * Runs `body` inside a transaction with a local `statement_timeout`.
 *
 * SET LOCAL is transaction-scoped, so the ceiling cannot leak onto the next
 * borrower of this pooled connection — a global SET would eventually apply a
 * five-second limit to the sync worker.
 */
export async function withAgentStatementTimeout<T>(
  db: Database,
  timeoutMs: number,
  body: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = ${sql.raw(String(Math.trunc(timeoutMs)))}`);
    return body(tx as unknown as Database);
  });
}

/** Postgres reports a statement timeout as SQLSTATE 57014. */
export function isStatementTimeout(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current != null && depth < 5; depth += 1) {
    if (typeof current === "object" && (current as { code?: unknown }).code === "57014") {
      return true;
    }
    current = (current as { cause?: unknown }).cause ?? null;
  }
  return false;
}

function pageIdList(pageIds: readonly number[]): SQL {
  return sql`(${sql.join(pageIds.map((id) => sql`${id}`), sql`, `)})`;
}

// ---------------------------------------------------------------------------
// Deployment facts
// ---------------------------------------------------------------------------

export interface AgentGrantPage {
  id: number;
  pageLabel: string;
  platform: string;
  modelSlug: string;
  modelName: string;
}

export async function listAgentGrantPages(
  db: Database,
  pageIds: readonly number[],
): Promise<AgentGrantPage[]> {
  if (pageIds.length === 0) {
    return [];
  }
  const result = await db.execute<Record<string, unknown>>(sql`
    select p.id, p.label, p.platform::text as platform, m.slug, m.name
    from pages p
    join models m on m.id = p.model_id
    where p.id in ${pageIdList(pageIds)} and p.deleted_at is null
    order by p.label asc
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    pageLabel: String(row.label),
    platform: String(row.platform),
    modelSlug: String(row.slug),
    modelName: String(row.name),
  }));
}

/** Total live pages in the deployment. The DIFFERENCE from a grant is exactly
 *  what §5.6 lets an agent know, and it is what allows #3/#4 to answer
 *  200-with-empty instead of becoming an existence oracle. */
export async function countAgentVisiblePages(db: Database): Promise<number> {
  const result = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from pages where deleted_at is null`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * The monotonic archive generation. A cursor minted under a different generation
 * is refused: the rebuild swap can rename `message_archive` between two pages of
 * one traversal, and a resumed keyset would then skip rows and report a FALSE
 * `snapshotExhausted` — "I read everything" when it read a different table.
 */
export async function readArchiveGeneration(db: Database): Promise<number> {
  const result = await db.execute<{ generation: string }>(
    sql`select generation::text as generation from archive_generation where id = 1`,
  );
  return Number(result.rows[0]?.generation ?? 0);
}

/** `pg_trgm` is a MANUAL owner DBA step outside the migration chain, so its
 *  presence is detected at runtime and its absence downgrades the backend rather
 *  than breaking the operation. */
export async function detectPgTrgmExtension(db: Database): Promise<boolean> {
  const result = await db.execute<{ present: boolean }>(
    sql`select exists(select 1 from pg_extension where extname = 'pg_trgm') as present`,
  );
  return result.rows[0]?.present === true;
}

export interface AgentJournalFloor {
  observationsFirstReceivedAt: Date | null;
  detachedPartitions: string[];
}

/**
 * Journal-wide facts no per-thread row can carry: when the verbatim journal
 * begins, and which monthly partitions are currently detached.
 *
 * A window earlier than the journal floor is EMPTY BY CONSTRUCTION, and saying so
 * is the difference between "no such fact" and "no journal for that month".
 */
export async function readAgentJournalFloor(db: Database): Promise<AgentJournalFloor> {
  const floor = await db.execute<{ first_received_at: Date | null }>(
    sql`select min(received_at) as first_received_at from observations`,
  );
  const detached = await db.execute<{ relname: string }>(sql`
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and (c.relname like 'observations\\_%' or c.relname like 'domain\\_events\\_%')
      and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)
    order by c.relname
  `);
  const first = floor.rows[0]?.first_received_at ?? null;
  return {
    observationsFirstReceivedAt: first === null ? null : new Date(first),
    detachedPartitions: detached.rows.map((row) => String(row.relname)),
  };
}

// ---------------------------------------------------------------------------
// Capture bounds
// ---------------------------------------------------------------------------

export interface AgentLaneCeiling {
  pageId: number;
  succeededAt: Date | null;
  cadenceSeconds: number;
  status: string;
}

/** The lane ceiling: when this page's stream last completed, and how often it
 *  runs. Without it a caller gets "I read the whole window" for a window whose
 *  fresh half was never pulled — Fansly `dm_messages` runs every 24 hours. */
export async function readAgentLaneCeilings(
  db: Database,
  pageIds: readonly number[],
  stream: string,
): Promise<AgentLaneCeiling[]> {
  if (pageIds.length === 0) {
    return [];
  }
  const result = await db.execute<Record<string, unknown>>(sql`
    select ss.page_id, ss.succeeded_at, ss.cadence_seconds, ss.status::text as status
    from page_sync_states ss
    where ss.page_id in ${pageIdList(pageIds)} and ss.stream = ${stream}::sync_stream
  `);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    succeededAt: row.succeeded_at == null ? null : new Date(row.succeeded_at as string | Date),
    cadenceSeconds: Number(row.cadence_seconds ?? 0),
    status: String(row.status),
  }));
}

export interface AgentCoverageProofRow {
  pageId: number;
  chatId: string;
  classification: string;
  source: string;
  frozenHeadId: string;
  oldestMessageId: string | null;
  oldestMessageOccurredAt: Date | null;
  currentHeadRef: string | null;
  targetHash: string;
  pageChainHash: string;
  parseDebt: number;
  rejectedCount: number;
  requiredServingHighWater: number;
  servingHighWater: number;
  proofObservationId: number;
  sourceAccountSeq: number;
  revokedAt: Date | null;
}

/**
 * The OnlyFans coverage proofs for a scope.
 *
 * The coverage tables carry IDS, not timestamps, so the floor is resolved by
 * joining `oldest_message_id` back to the archive row's `occurred_at`. Without a
 * proof there is no floor at all: the store-derived `complete` flag is set merely
 * on intersecting an already-stored message, and 10 531 Fansly threads marked
 * `complete` hold five messages or fewer.
 */
export async function readAgentCoverageProofs(
  db: Database,
  pageIds: readonly number[],
  conversationRefs: readonly string[] | null,
): Promise<AgentCoverageProofRow[]> {
  if (pageIds.length === 0) {
    return [];
  }
  const chatFilter = conversationRefs === null || conversationRefs.length === 0
    ? sql`true`
    : sql`cov.chat_id in (${sql.join(conversationRefs.map((ref) => sql`${ref}`), sql`, `)})`;
  const result = await db.execute<Record<string, unknown>>(sql`
    select cov.page_id,
           cov.chat_id,
           cov.classification,
           cov.source,
           cov.frozen_head_id,
           cov.oldest_message_id,
           oldest.occurred_at as oldest_occurred_at,
           t.newest_stored_message_id as current_head_ref,
           cov.target_hash,
           cov.page_chain_hash,
           cov.parse_debt,
           cov.rejected_count,
           cov.required_serving_high_water::text as required_serving_high_water,
           coalesce(hw.serving_high_water, 0)::text as serving_high_water,
           cov.proof_observation_id::text as proof_observation_id,
           cov.source_account_seq::text as source_account_seq,
           cov.revoked_at
    from ofapi_message_coverage cov
    left join message_archive oldest
      on oldest.account_id = cov.page_id
     and oldest.conversation_ref = cov.chat_id
     and oldest.message_ref = cov.oldest_message_id
    left join page_dm_threads t
      on t.platform_account_id = cov.page_id
     and t.platform_conversation_id = cov.chat_id
    left join lateral (
      select max(ma.source_account_seq) as serving_high_water
      from message_archive ma
      where ma.account_id = cov.page_id and ma.conversation_ref = cov.chat_id
    ) hw on true
    where cov.page_id in ${pageIdList(pageIds)} and ${chatFilter}
  `);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    chatId: String(row.chat_id),
    classification: String(row.classification),
    source: String(row.source),
    frozenHeadId: String(row.frozen_head_id),
    oldestMessageId: row.oldest_message_id == null ? null : String(row.oldest_message_id),
    oldestMessageOccurredAt: row.oldest_occurred_at == null
      ? null
      : new Date(row.oldest_occurred_at as string | Date),
    currentHeadRef: row.current_head_ref == null ? null : String(row.current_head_ref),
    targetHash: String(row.target_hash),
    pageChainHash: String(row.page_chain_hash),
    parseDebt: Number(row.parse_debt ?? 0),
    rejectedCount: Number(row.rejected_count ?? 0),
    requiredServingHighWater: Number(row.required_serving_high_water ?? 0),
    servingHighWater: Number(row.serving_high_water ?? 0),
    proofObservationId: Number(row.proof_observation_id ?? 0),
    sourceAccountSeq: Number(row.source_account_seq ?? 0),
    revokedAt: row.revoked_at == null ? null : new Date(row.revoked_at as string | Date),
  }));
}

/**
 * Turns a coverage row into a `cryptographic_proof` witness for `message_archive`.
 *
 * This is the ONLY path to `basis: "cryptographic_proof"` in the system, and it
 * exists only for OnlyFans — `ofapi_message_coverage` is OF-only by schema. That
 * is why no Fansly response can ever answer `absenceProvable: true`.
 */
export function proofWitness(row: AgentCoverageProofRow, plane: string): PlaneReadWitness {
  return mintPlaneReadWitness({
    plane,
    basis: "cryptographic_proof",
    captureFloor: {
      at: row.oldestMessageOccurredAt?.toISOString() ?? null,
      kind: row.oldestMessageOccurredAt === null ? "unknown" : "proof_oldest_message",
    },
    captureCeiling: {
      at: null,
      kind: "proof_frozen_head",
      laneCadenceSeconds: null,
      breakerOpen: false,
    },
    proof: {
      classification: row.classification === "continuous_history"
        || row.classification === "verified_unavailable"
        || row.classification === "explicit_open_debt"
        ? row.classification
        : "explicit_open_debt",
      source: row.source === "pagination_exhausted"
        || row.source === "export_artifact"
        || row.source === "harvest_import"
        ? row.source
        : "pagination_exhausted",
      frozenHeadRef: row.frozenHeadId,
      currentHeadRef: row.currentHeadRef,
      frozenHeadMatchesCurrentHead: row.currentHeadRef !== null
        && row.currentHeadRef === row.frozenHeadId,
      oldestMessageRef: row.oldestMessageId,
      targetHash: row.targetHash,
      pageChainHash: row.pageChainHash,
      proofObservationRef: row.proofObservationId > 0 ? row.proofObservationId : null,
      sourceAccountSeq: row.sourceAccountSeq,
      revokedAt: row.revokedAt?.toISOString() ?? null,
    },
    parseDebt: row.parseDebt,
    rejected: row.rejectedCount,
    servingHighWaterSatisfied: row.servingHighWater >= row.requiredServingHighWater,
  });
}

export { storeDerivedWitness };

// ---------------------------------------------------------------------------
// #2 resolve
// ---------------------------------------------------------------------------

export interface AgentResolveMatch {
  fanId: number;
  platform: string;
  platformUserId: string;
  username: string | null;
  displayName: string | null;
  matchKind: "platformUserId" | "username" | "alias" | "displayName";
  matchedValue: string;
  createdAtExternal: Date | null;
  deletedDetectedAt: Date | null;
}

/**
 * Tries EVERY key for one candidate string: the native id, the current username,
 * both alias stores, and the display name.
 *
 * This is the Gate R1 lesson in code. `fansly.com/user438765948262952961` looks
 * like an id and IS a username; the fan's `platform_user_id` is a different
 * number entirely. A resolver that tried one key answered "no such fan" about a
 * fan who had paid $100.
 */
export async function resolveAgentFanCandidates(
  db: Database,
  input: {
    pageIds: readonly number[];
    platform: string | null;
    values: readonly string[];
    limit: number;
  },
): Promise<AgentResolveMatch[]> {
  if (input.pageIds.length === 0 || input.values.length === 0) {
    return [];
  }
  const values = sql`(${sql.join(input.values.map((value) => sql`${value}`), sql`, `)})`;
  const lowered = sql`(${sql.join(input.values.map((value) => sql`${value.toLowerCase()}`), sql`, `)})`;
  // `input.platform` is a VALUE bound into the statement, never a branch on a
  // platform literal: absent means "try both", present means "restrict to this
  // one". Written as a nullish check so the platform-branch ratchet stays honest
  // about where real platform logic lives.
  const platformFilter = input.platform == null
    ? sql`true`
    : sql`f.platform = ${input.platform}`;

  const result = await db.execute<Record<string, unknown>>(sql`
    with visible_fans as (
      select distinct pf.fan_id
      from page_fans pf
      where pf.platform_account_id in ${pageIdList(input.pageIds)}
      union
      select distinct t.fan_id
      from page_dm_threads t
      where t.platform_account_id in ${pageIdList(input.pageIds)} and t.fan_id is not null
    ),
    matched as (
      select f.id, f.platform::text as platform, f.platform_user_id, f.username, f.display_name,
             f.created_at_external, f.deleted_detected_at,
             'platformUserId'::text as match_kind, f.platform_user_id as matched_value, 0 as rank
      from fans f
      where f.platform_user_id in ${values} and ${platformFilter}
      union all
      select f.id, f.platform::text, f.platform_user_id, f.username, f.display_name,
             f.created_at_external, f.deleted_detected_at,
             'username'::text, f.username, 1
      from fans f
      where lower(f.username) in ${lowered} and ${platformFilter}
      union all
      select f.id, f.platform::text, f.platform_user_id, f.username, f.display_name,
             f.created_at_external, f.deleted_detected_at,
             'alias'::text, u.username, 2
      from fan_username_aliases u
      join fans f on f.id = u.fan_id
      where lower(u.username) in ${lowered} and ${platformFilter}
      union all
      select f.id, f.platform::text, f.platform_user_id, f.username, f.display_name,
             f.created_at_external, f.deleted_detected_at,
             'alias'::text, a.alias, 3
      from page_fan_aliases a
      join fans f on f.id = a.fan_id
      where lower(a.alias) in ${lowered}
        and a.platform_account_id in ${pageIdList(input.pageIds)}
        and ${platformFilter}
      union all
      select f.id, f.platform::text, f.platform_user_id, f.username, f.display_name,
             f.created_at_external, f.deleted_detected_at,
             'displayName'::text, f.display_name, 4
      from fans f
      where lower(f.display_name) in ${lowered} and ${platformFilter}
    )
    select distinct on (m.id, m.match_kind)
           m.id, m.platform, m.platform_user_id, m.username, m.display_name,
           m.created_at_external, m.deleted_detected_at, m.match_kind, m.matched_value, m.rank
    from matched m
    join visible_fans v on v.fan_id = m.id
    order by m.id, m.match_kind, m.rank
    limit ${input.limit}
  `);

  return result.rows.map((row) => ({
    fanId: Number(row.id),
    platform: String(row.platform),
    platformUserId: String(row.platform_user_id),
    username: row.username == null ? null : String(row.username),
    displayName: row.display_name == null ? null : String(row.display_name),
    matchKind: String(row.match_kind) as AgentResolveMatch["matchKind"],
    matchedValue: String(row.matched_value ?? ""),
    createdAtExternal: row.created_at_external == null
      ? null
      : new Date(row.created_at_external as string | Date),
    deletedDetectedAt: row.deleted_detected_at == null
      ? null
      : new Date(row.deleted_detected_at as string | Date),
  }));
}

export interface AgentFanThreadRow {
  fanId: number;
  pageId: number;
  pageLabel: string;
  platform: string;
  conversationRef: string;
  storedMessageCount: number;
  coverageStatusRaw: string;
}

export async function listAgentFanThreads(
  db: Database,
  input: { pageIds: readonly number[]; fanIds: readonly number[] },
): Promise<AgentFanThreadRow[]> {
  if (input.pageIds.length === 0 || input.fanIds.length === 0) {
    return [];
  }
  const fanIds = sql`(${sql.join(input.fanIds.map((id) => sql`${id}`), sql`, `)})`;
  const result = await db.execute<Record<string, unknown>>(sql`
    select t.fan_id, t.platform_account_id, p.label, p.platform::text as platform,
           t.platform_conversation_id, t.stored_message_count,
           t.message_coverage_status::text as coverage_status
    from page_dm_threads t
    join pages p on p.id = t.platform_account_id
    where t.platform_account_id in ${pageIdList(input.pageIds)}
      and t.fan_id in ${fanIds}
    order by t.last_message_at desc nulls last, t.id desc
    limit 200
  `);
  return result.rows.map((row) => ({
    fanId: Number(row.fan_id),
    pageId: Number(row.platform_account_id),
    pageLabel: String(row.label),
    platform: String(row.platform),
    conversationRef: String(row.platform_conversation_id),
    storedMessageCount: Number(row.stored_message_count ?? 0),
    coverageStatusRaw: String(row.coverage_status),
  }));
}

// ---------------------------------------------------------------------------
// #3 person
// ---------------------------------------------------------------------------

export interface AgentPersonIdentityRow {
  fanId: number;
  platform: string;
  platformUserId: string;
  username: string | null;
  displayName: string | null;
  createdAtExternal: Date | null;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  deletedDetectedAt: Date | null;
}

export async function findAgentPersonIdentity(
  db: Database,
  input: { pageIds: readonly number[]; platform: string; platformUserId: string },
): Promise<AgentPersonIdentityRow | null> {
  if (input.pageIds.length === 0) {
    return null;
  }
  // The fan must be visible on a GRANTED page. A fan row alone is not visibility:
  // it is global, and returning it for a key granted none of that fan's pages
  // would leak the existence of a page the key may not see.
  const result = await db.execute<Record<string, unknown>>(sql`
    select f.id, f.platform::text as platform, f.platform_user_id, f.username, f.display_name,
           f.created_at_external, f.first_seen_at, f.last_seen_at, f.deleted_detected_at
    from fans f
    where f.platform = ${input.platform}
      and f.platform_user_id = ${input.platformUserId}
      and (
        exists (select 1 from page_fans pf
                where pf.fan_id = f.id and pf.platform_account_id in ${pageIdList(input.pageIds)})
        or exists (select 1 from page_dm_threads t
                   where t.fan_id = f.id and t.platform_account_id in ${pageIdList(input.pageIds)})
        or exists (select 1 from transactions tr
                   where tr.fan_id = f.id and tr.platform_account_id in ${pageIdList(input.pageIds)})
      )
    limit 1
  `);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    fanId: Number(row.id),
    platform: String(row.platform),
    platformUserId: String(row.platform_user_id),
    username: row.username == null ? null : String(row.username),
    displayName: row.display_name == null ? null : String(row.display_name),
    createdAtExternal: row.created_at_external == null
      ? null
      : new Date(row.created_at_external as string | Date),
    firstSeenAt: row.first_seen_at == null ? null : new Date(row.first_seen_at as string | Date),
    lastSeenAt: row.last_seen_at == null ? null : new Date(row.last_seen_at as string | Date),
    deletedDetectedAt: row.deleted_detected_at == null
      ? null
      : new Date(row.deleted_detected_at as string | Date),
  };
}

export interface AgentPersonBundle {
  aliases: Array<{ kind: string; value: string; firstSeenAt: Date | null; lastSeenAt: Date | null }>;
  flags: Array<{ pageLabel: string; flag: string; updatedAt: Date }>;
  memberships: Array<{
    pageLabel: string;
    platform: string;
    isFollower: boolean;
    followerSince: Date | null;
    isSubscriber: boolean;
    subscriberSince: Date | null;
    subscriptionExpiresAt: Date | null;
    autoRenew: boolean | null;
    autoRenewOffDetectedAt: Date | null;
    lifetimeSpendMills: bigint | null;
    lastTransactionAt: Date | null;
    pageAlias: string | null;
  }>;
  subscriptions: Array<{
    pageLabel: string;
    subscriptionRef: string;
    canonicalStatus: string;
    tierName: string | null;
    priceMills: bigint | null;
    renewPriceMills: bigint | null;
    autoRenew: boolean | null;
    billingCycleDays: number | null;
    startedAt: Date | null;
    endsAt: Date | null;
    isCurrent: boolean;
  }>;
  moneyLifetime: {
    grossMills: bigint;
    netMills: bigint;
    transactionCount: number;
    firstTransactionAt: Date | null;
    lastTransactionAt: Date | null;
  };
  moneyByType: Array<{
    transactionType: string;
    transactionState: string;
    grossMills: bigint;
    netMills: bigint;
    transactionCount: number;
  }>;
  notes: Array<{
    pageLabel: string;
    noteRef: string;
    origin: "internal" | "external";
    noteText: string;
    createdAt: Date | null;
    updatedAt: Date | null;
  }>;
  summaries: Array<{
    pageLabel: string;
    summaryRef: string;
    summaryText: string;
    createdAt: Date | null;
  }>;
}

/**
 * Everything #3 serves for one fan, in one round of statements.
 *
 * `money.byType` comes from `transactions`, NOT from `fan_spend_daily`: the two
 * disagree on negations (a chargeback inactivates the original row in
 * `transactions` while the daily rollup keeps its own history), and the operation
 * that must answer "what did this person actually pay" reads the ledger of record.
 * The rollup remains available as an evidentiary plane and as dataset #10.
 */
export async function loadAgentPersonBundle(
  db: Database,
  input: { pageIds: readonly number[]; fanId: number },
): Promise<AgentPersonBundle> {
  const pages = pageIdList(input.pageIds);
  const fanId = input.fanId;

  const [aliases, flags, memberships, subscriptions, lifetime, byType, notes, summaries] =
    await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        select 'username'::text as kind, u.username as value, u.first_seen_at, u.last_seen_at
        from fan_username_aliases u where u.fan_id = ${fanId}
        union all
        select 'alias'::text, a.alias, a.first_seen_at, a.last_seen_at
        from page_fan_aliases a
        where a.fan_id = ${fanId} and a.platform_account_id in ${pages}
        order by 4 desc nulls last
        limit 200
      `),
      db.execute<Record<string, unknown>>(sql`
        select p.label, fg.flag::text as flag, fg.created_at
        from fan_flags fg
        cross join lateral (
          select pf.platform_account_id from page_fans pf
          where pf.fan_id = fg.fan_id and pf.platform_account_id in ${pages}
          limit 1
        ) scoped
        join pages p on p.id = scoped.platform_account_id
        where fg.fan_id = ${fanId}
        order by fg.created_at desc
        limit 100
      `),
      db.execute<Record<string, unknown>>(sql`
        select p.label, p.platform::text as platform, pf.is_follower, pf.follower_since,
               pf.is_subscriber, pf.subscriber_since, pf.subscription_expires_at,
               pf.auto_renew, pf.auto_renew_off_detected_at,
               pf.total_creator_net_mills::text as lifetime_spend_mills,
               pf.last_transaction_at, pf.page_alias
        from page_fans pf
        join pages p on p.id = pf.platform_account_id
        where pf.fan_id = ${fanId} and pf.platform_account_id in ${pages}
        order by p.label asc
      `),
      db.execute<Record<string, unknown>>(sql`
        select p.label, s.platform_subscription_id, s.canonical_status, s.subscription_tier_name,
               s.price_mills::text as price_mills, s.renew_price_mills::text as renew_price_mills,
               s.auto_renew, s.billing_cycle_days, s.source_created_at, s.ends_at, s.is_current
        from page_subscriptions s
        join pages p on p.id = s.platform_account_id
        where s.fan_id = ${fanId} and s.platform_account_id in ${pages}
        order by s.ends_at desc nulls last, s.id desc
        limit 200
      `),
      db.execute<Record<string, unknown>>(sql`
        select coalesce(sum(tr.gross_amount_mills), 0)::text as gross_mills,
               coalesce(sum(tr.creator_net_amount_mills), 0)::text as net_mills,
               count(*)::text as transaction_count,
               min(tr.occurred_at) as first_transaction_at,
               max(tr.occurred_at) as last_transaction_at
        from transactions tr
        where tr.fan_id = ${fanId} and tr.platform_account_id in ${pages} and tr.is_active
      `),
      db.execute<Record<string, unknown>>(sql`
        select tr.canonical_type::text as transaction_type,
               tr.transaction_state::text as transaction_state,
               coalesce(sum(tr.gross_amount_mills), 0)::text as gross_mills,
               coalesce(sum(tr.creator_net_amount_mills), 0)::text as net_mills,
               count(*)::text as transaction_count
        from transactions tr
        where tr.fan_id = ${fanId} and tr.platform_account_id in ${pages} and tr.is_active
        group by 1, 2
        order by 1, 2
      `),
      db.execute<Record<string, unknown>>(sql`
        select p.label, 'internal:' || n.id::text as note_ref, 'internal'::text as origin,
               n.body as note_text, n.created_at, n.created_at as updated_at
        from fan_notes n
        join pages p on p.id = n.platform_account_id
        where n.fan_id = ${fanId} and n.platform_account_id in ${pages}
        union all
        select p.label, 'external:' || e.id::text, 'external'::text,
               coalesce(e.body, ''), coalesce(e.created_at_external, e.first_seen_at),
               coalesce(e.updated_at_external, e.last_seen_at)
        from page_fan_external_notes e
        join pages p on p.id = e.platform_account_id
        where e.fan_id = ${fanId} and e.platform_account_id in ${pages}
        order by 5 desc nulls last
        limit 200
      `),
      db.execute<Record<string, unknown>>(sql`
        select p.label, 'summary:' || s.id::text as summary_ref, s.body as summary_text, s.created_at
        from fan_summaries s
        join pages p on p.id = s.platform_account_id
        where s.fan_id = ${fanId} and s.platform_account_id in ${pages}
        order by s.created_at desc
        limit 200
      `),
    ]);

  const date = (value: unknown): Date | null =>
    value == null ? null : new Date(value as string | Date);

  const lifetimeRow = lifetime.rows[0];
  return {
    aliases: aliases.rows.map((row) => ({
      kind: String(row.kind),
      value: String(row.value ?? ""),
      firstSeenAt: date(row.first_seen_at),
      lastSeenAt: date(row.last_seen_at),
    })),
    flags: flags.rows.map((row) => ({
      pageLabel: String(row.label),
      flag: String(row.flag),
      updatedAt: date(row.created_at) ?? new Date(0),
    })),
    memberships: memberships.rows.map((row) => ({
      pageLabel: String(row.label),
      platform: String(row.platform),
      isFollower: row.is_follower === true,
      followerSince: date(row.follower_since),
      isSubscriber: row.is_subscriber === true,
      subscriberSince: date(row.subscriber_since),
      subscriptionExpiresAt: date(row.subscription_expires_at),
      autoRenew: row.auto_renew == null ? null : row.auto_renew === true,
      autoRenewOffDetectedAt: date(row.auto_renew_off_detected_at),
      lifetimeSpendMills: row.lifetime_spend_mills == null
        ? null
        : BigInt(String(row.lifetime_spend_mills)),
      lastTransactionAt: date(row.last_transaction_at),
      pageAlias: row.page_alias == null ? null : String(row.page_alias),
    })),
    subscriptions: subscriptions.rows.map((row) => ({
      pageLabel: String(row.label),
      subscriptionRef: String(row.platform_subscription_id),
      canonicalStatus: String(row.canonical_status),
      tierName: row.subscription_tier_name == null ? null : String(row.subscription_tier_name),
      priceMills: row.price_mills == null ? null : BigInt(String(row.price_mills)),
      renewPriceMills: row.renew_price_mills == null
        ? null
        : BigInt(String(row.renew_price_mills)),
      autoRenew: row.auto_renew == null ? null : row.auto_renew === true,
      billingCycleDays: row.billing_cycle_days == null ? null : Number(row.billing_cycle_days),
      startedAt: date(row.source_created_at),
      endsAt: date(row.ends_at),
      isCurrent: row.is_current === true,
    })),
    moneyLifetime: {
      grossMills: BigInt(String(lifetimeRow?.gross_mills ?? "0")),
      netMills: BigInt(String(lifetimeRow?.net_mills ?? "0")),
      transactionCount: Number(lifetimeRow?.transaction_count ?? 0),
      firstTransactionAt: date(lifetimeRow?.first_transaction_at),
      lastTransactionAt: date(lifetimeRow?.last_transaction_at),
    },
    moneyByType: byType.rows.map((row) => ({
      transactionType: String(row.transaction_type),
      transactionState: String(row.transaction_state),
      grossMills: BigInt(String(row.gross_mills ?? "0")),
      netMills: BigInt(String(row.net_mills ?? "0")),
      transactionCount: Number(row.transaction_count ?? 0),
    })),
    notes: notes.rows.map((row) => ({
      pageLabel: String(row.label),
      noteRef: String(row.note_ref),
      origin: String(row.origin) === "external" ? "external" : "internal",
      noteText: String(row.note_text ?? ""),
      createdAt: date(row.created_at),
      updatedAt: date(row.updated_at),
    })),
    summaries: summaries.rows.map((row) => ({
      pageLabel: String(row.label),
      summaryRef: String(row.summary_ref),
      summaryText: String(row.summary_text ?? ""),
      createdAt: date(row.created_at),
    })),
  };
}

// ---------------------------------------------------------------------------
// #4 timeline
// ---------------------------------------------------------------------------

export interface AgentTimelineRow {
  lane: string;
  kind: string;
  occurredAt: Date;
  stableRef: string;
  pageLabel: string;
  platform: string;
  conversationRef: string | null;
  messageRef: string | null;
  transactionRef: string | null;
  subscriptionRef: string | null;
  grossMills: bigint | null;
  netMills: bigint | null;
  transactionType: string | null;
  transactionState: string | null;
  currency: string | null;
  direction: string | null;
  senderRole: string | null;
  textLength: number | null;
  hasMedia: boolean | null;
  isTip: boolean | null;
}

/**
 * The merged per-fan timeline.
 *
 * The MESSAGES lane carries metrics only — ref, direction, sender role, text
 * LENGTH, media and tip flags — and never the text itself: verbatim material
 * stays on the two operations R3 was accepted for.
 *
 * Lanes are unioned in one statement so the keyset stays one-dimensional over
 * `(occurred_at, stable_ref)`.
 */
export async function listAgentTimeline(
  db: Database,
  input: {
    pageIds: readonly number[];
    fanId: number;
    from: Date;
    to: Date;
    lanes: readonly string[];
    sortDir: "asc" | "desc";
    limit: number;
    after?: { occurredAt: string; stableRef: string } | undefined;
  },
): Promise<AgentTimelineRow[]> {
  if (input.pageIds.length === 0 || input.lanes.length === 0) {
    return [];
  }
  const pages = pageIdList(input.pageIds);
  const wants = (lane: string) => input.lanes.includes(lane);
  const descending = input.sortDir === "desc";
  const after = input.after;
  const keyset = after === undefined
    ? sql`true`
    : descending
      ? sql`(u.occurred_at < ${after.occurredAt}::timestamptz
             or (u.occurred_at = ${after.occurredAt}::timestamptz and u.stable_ref < ${after.stableRef}))`
      : sql`(u.occurred_at > ${after.occurredAt}::timestamptz
             or (u.occurred_at = ${after.occurredAt}::timestamptz and u.stable_ref > ${after.stableRef}))`;

  const arms: SQL[] = [];
  if (wants("messages")) {
    arms.push(sql`
      select 'messages'::text as lane,
             case when ma.deleted_at is not null then 'message.deleted'
                  when ma.is_sent_by_me then 'message.sent'
                  else 'message.received' end as kind,
             ma.occurred_at as occurred_at,
             'message:' || ma.account_id::text || ':' || ma.message_ref as stable_ref,
             p.label as page_label, p.platform::text as platform,
             ma.conversation_ref, ma.message_ref,
             null::text as transaction_ref, null::text as subscription_ref,
             null::bigint as gross_mills, null::bigint as net_mills,
             null::text as transaction_type, null::text as transaction_state,
             null::text as currency,
             case when ma.is_sent_by_me then 'outbound'
                  when ma.sender_role = 'system' then 'system'
                  when ma.sender_role = 'unknown' then 'unknown'
                  else 'inbound' end as direction,
             ma.sender_role::text as sender_role,
             length(ma.text_plain) as text_length,
             (jsonb_array_length(coalesce(ma.media_metadata, '[]'::jsonb)) > 0) as has_media,
             ma.is_tip
      from message_archive ma
      join pages p on p.id = ma.account_id
      join fans f on f.platform_user_id = ma.fan_native_id and f.platform::text = ma.platform
      where ma.account_id in ${pages} and f.id = ${input.fanId}
        and ma.occurred_at >= ${input.from} and ma.occurred_at < ${input.to}
    `);
  }
  if (wants("money")) {
    arms.push(sql`
      select 'money'::text,
             case when tr.canonical_type = 'tip' then 'tip.received'
                  when tr.transaction_state = 'pending' then 'transaction.pending'
                  else 'transaction.posted' end,
             tr.occurred_at,
             'transaction:' || tr.id::text,
             p.label, p.platform::text,
             null::text, null::text,
             tr.transaction_id, null::text,
             tr.gross_amount_mills, tr.creator_net_amount_mills,
             tr.canonical_type::text, tr.transaction_state::text,
             tr.currency::text,
             null::text, null::text, null::int, null::boolean, null::boolean
      from transactions tr
      join pages p on p.id = tr.platform_account_id
      where tr.platform_account_id in ${pages} and tr.fan_id = ${input.fanId} and tr.is_active
        and tr.occurred_at >= ${input.from} and tr.occurred_at < ${input.to}
    `);
  }
  if (wants("subscriptions")) {
    arms.push(sql`
      select 'subscriptions'::text,
             case when s.ends_at is not null and s.ends_at < now() then 'subscription.ended'
                  when s.is_current then 'subscription.renewed'
                  else 'subscription.started' end,
             coalesce(s.source_created_at, s.last_seen_at),
             'subscription:' || s.id::text,
             p.label, p.platform::text,
             null::text, null::text,
             null::text, s.platform_subscription_id,
             s.price_mills, null::bigint,
             null::text, null::text, null::text,
             null::text, null::text, null::int, null::boolean, null::boolean
      from page_subscriptions s
      join pages p on p.id = s.platform_account_id
      where s.platform_account_id in ${pages} and s.fan_id = ${input.fanId}
        and coalesce(s.source_created_at, s.last_seen_at) >= ${input.from}
        and coalesce(s.source_created_at, s.last_seen_at) < ${input.to}
    `);
  }
  if (wants("follows")) {
    arms.push(sql`
      select 'follows'::text,
             case when fl.is_active then 'follow.started' else 'follow.ended' end,
             fl.followed_at,
             'follow:' || fl.id::text,
             p.label, p.platform::text,
             null::text, null::text, null::text, null::text,
             null::bigint, null::bigint, null::text, null::text, null::text,
             null::text, null::text, null::int, null::boolean, null::boolean
      from page_follows fl
      join pages p on p.id = fl.platform_account_id
      where fl.platform_account_id in ${pages} and fl.fan_id = ${input.fanId}
        and fl.followed_at >= ${input.from} and fl.followed_at < ${input.to}
    `);
  }
  if (wants("presence")) {
    arms.push(sql`
      select 'presence'::text, 'presence.online'::text,
             pf.external_presence_at,
             'presence:' || pf.id::text,
             p.label, p.platform::text,
             null::text, null::text, null::text, null::text,
             null::bigint, null::bigint, null::text, null::text, null::text,
             null::text, null::text, null::int, null::boolean, null::boolean
      from page_fans pf
      join pages p on p.id = pf.platform_account_id
      where pf.platform_account_id in ${pages} and pf.fan_id = ${input.fanId}
        and pf.external_presence_at is not null
        and pf.external_presence_at >= ${input.from} and pf.external_presence_at < ${input.to}
    `);
  }
  if (arms.length === 0) {
    return [];
  }

  const order = descending
    ? sql`order by u.occurred_at desc, u.stable_ref desc`
    : sql`order by u.occurred_at asc, u.stable_ref asc`;

  const result = await db.execute<Record<string, unknown>>(sql`
    with u as (${sql.join(arms, sql` union all `)})
    select u.lane, u.kind, u.occurred_at, u.stable_ref, u.page_label, u.platform,
           u.conversation_ref, u.message_ref, u.transaction_ref, u.subscription_ref,
           u.gross_mills::text as gross_mills, u.net_mills::text as net_mills,
           u.transaction_type, u.transaction_state, u.currency,
           u.direction, u.sender_role, u.text_length, u.has_media, u.is_tip
    from u
    where u.occurred_at is not null and ${keyset}
    ${order}
    limit ${input.limit}
  `);

  return result.rows.map((row) => ({
    lane: String(row.lane),
    kind: String(row.kind),
    occurredAt: new Date(row.occurred_at as string | Date),
    stableRef: String(row.stable_ref),
    pageLabel: String(row.page_label),
    platform: String(row.platform),
    conversationRef: row.conversation_ref == null ? null : String(row.conversation_ref),
    messageRef: row.message_ref == null ? null : String(row.message_ref),
    transactionRef: row.transaction_ref == null ? null : String(row.transaction_ref),
    subscriptionRef: row.subscription_ref == null ? null : String(row.subscription_ref),
    grossMills: row.gross_mills == null ? null : BigInt(String(row.gross_mills)),
    netMills: row.net_mills == null ? null : BigInt(String(row.net_mills)),
    transactionType: row.transaction_type == null ? null : String(row.transaction_type),
    transactionState: row.transaction_state == null ? null : String(row.transaction_state),
    currency: row.currency == null ? null : String(row.currency),
    direction: row.direction == null ? null : String(row.direction),
    senderRole: row.sender_role == null ? null : String(row.sender_role),
    textLength: row.text_length == null ? null : Number(row.text_length),
    hasMedia: row.has_media == null ? null : row.has_media === true,
    isTip: row.is_tip == null ? null : row.is_tip === true,
  }));
}

// ---------------------------------------------------------------------------
// #5 threads
// ---------------------------------------------------------------------------

export interface AgentThreadRow {
  threadId: number;
  pageId: number;
  pageLabel: string;
  platform: string;
  conversationRef: string;
  fanPlatformUserId: string | null;
  fanUsername: string | null;
  fanDisplayName: string | null;
  isVisible: boolean;
  unreadCount: number | null;
  lastMessageAt: Date | null;
  lastFanMessageAt: Date | null;
  lastModelMessageAt: Date | null;
  storedMessageCount: number;
  oldestStoredMessageRef: string | null;
  newestStoredMessageRef: string | null;
  coverageStatusRaw: string;
  lastMessageSyncAt: Date | null;
  quarantineUntil: Date | null;
  lifetimeSpendMills: bigint | null;
}

export interface AgentThreadsQuery {
  pageIds: readonly number[];
  platform?: string | undefined;
  fanId?: number | undefined;
  coverageStatus?: string | undefined;
  quarantined?: boolean | undefined;
  hasMessagesSince?: Date | undefined;
  minStoredMessages?: number | undefined;
  orderBy: "lastMessageAt" | "storedMessageCount" | "pageLabel";
  sortDir: "asc" | "desc";
  limit: number;
  after?: { sortValue: string | null; threadId: number } | undefined;
}

function threadsWhere(query: AgentThreadsQuery): SQL {
  const clauses: SQL[] = [sql`t.platform_account_id in ${pageIdList(query.pageIds)}`];
  if (query.platform !== undefined) {
    clauses.push(sql`p.platform = ${query.platform}`);
  }
  if (query.fanId !== undefined) {
    clauses.push(sql`t.fan_id = ${query.fanId}`);
  }
  if (query.coverageStatus !== undefined) {
    clauses.push(sql`t.message_coverage_status::text = ${query.coverageStatus}`);
  }
  if (query.quarantined !== undefined) {
    clauses.push(query.quarantined
      ? sql`(h.quarantine_until is not null and h.quarantine_until > now())`
      : sql`(h.quarantine_until is null or h.quarantine_until <= now())`);
  }
  if (query.hasMessagesSince !== undefined) {
    clauses.push(sql`t.last_message_at >= ${query.hasMessagesSince}`);
  }
  if (query.minStoredMessages !== undefined) {
    clauses.push(sql`t.stored_message_count >= ${query.minStoredMessages}`);
  }
  return sql.join(clauses, sql` and `);
}

export async function listAgentThreads(
  db: Database,
  query: AgentThreadsQuery,
): Promise<AgentThreadRow[]> {
  if (query.pageIds.length === 0) {
    return [];
  }
  const descending = query.sortDir === "desc";
  const sortColumn = query.orderBy === "storedMessageCount"
    ? sql`t.stored_message_count::text`
    : query.orderBy === "pageLabel"
      ? sql`p.label`
      : sql`to_char(t.last_message_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.USZ')`;

  const after = query.after;
  const keyset = after === undefined
    ? sql`true`
    : after.sortValue === null
      ? (descending
        ? sql`(${sortColumn} is null and t.id < ${after.threadId})`
        : sql`(${sortColumn} is not null or t.id > ${after.threadId})`)
      : (descending
        ? sql`(${sortColumn} < ${after.sortValue}
               or (${sortColumn} = ${after.sortValue} and t.id < ${after.threadId})
               or ${sortColumn} is null)`
        : sql`(${sortColumn} > ${after.sortValue}
               or (${sortColumn} = ${after.sortValue} and t.id > ${after.threadId})))`);

  const order = descending
    ? sql`order by ${sortColumn} desc nulls last, t.id desc`
    : sql`order by ${sortColumn} asc nulls last, t.id asc`;

  const result = await db.execute<Record<string, unknown>>(sql`
    select t.id, t.platform_account_id, p.label, p.platform::text as platform,
           t.platform_conversation_id,
           coalesce(f.platform_user_id, t.partner_platform_user_id) as fan_platform_user_id,
           coalesce(f.username, t.partner_username) as fan_username,
           coalesce(f.display_name, t.partner_display_name) as fan_display_name,
           t.is_visible, t.unread_count, t.last_message_at, t.last_fan_message_at,
           t.last_model_message_at, t.stored_message_count,
           t.oldest_stored_message_id, t.newest_stored_message_id,
           t.message_coverage_status::text as coverage_status, t.last_message_sync_at,
           h.quarantine_until,
           fsl.creator_net_amount_mills::text as lifetime_spend_mills
    from page_dm_threads t
    join pages p on p.id = t.platform_account_id
    left join page_dm_message_sync_health h on h.conversation_id = t.id
    left join fans f on f.id = t.fan_id
    left join fan_spend_lifetime fsl
      on fsl.fan_id = t.fan_id and fsl.platform_account_id = t.platform_account_id
    where ${threadsWhere(query)} and ${keyset}
    ${order}
    limit ${query.limit}
  `);

  return result.rows.map((row) => ({
    threadId: Number(row.id),
    pageId: Number(row.platform_account_id),
    pageLabel: String(row.label),
    platform: String(row.platform),
    conversationRef: String(row.platform_conversation_id),
    fanPlatformUserId: row.fan_platform_user_id == null
      ? null
      : String(row.fan_platform_user_id),
    fanUsername: row.fan_username == null ? null : String(row.fan_username),
    fanDisplayName: row.fan_display_name == null ? null : String(row.fan_display_name),
    isVisible: row.is_visible === true,
    unreadCount: row.unread_count == null ? null : Number(row.unread_count),
    lastMessageAt: row.last_message_at == null
      ? null
      : new Date(row.last_message_at as string | Date),
    lastFanMessageAt: row.last_fan_message_at == null
      ? null
      : new Date(row.last_fan_message_at as string | Date),
    lastModelMessageAt: row.last_model_message_at == null
      ? null
      : new Date(row.last_model_message_at as string | Date),
    storedMessageCount: Number(row.stored_message_count ?? 0),
    oldestStoredMessageRef: row.oldest_stored_message_id == null
      ? null
      : String(row.oldest_stored_message_id),
    newestStoredMessageRef: row.newest_stored_message_id == null
      ? null
      : String(row.newest_stored_message_id),
    coverageStatusRaw: String(row.coverage_status),
    lastMessageSyncAt: row.last_message_sync_at == null
      ? null
      : new Date(row.last_message_sync_at as string | Date),
    quarantineUntil: row.quarantine_until == null
      ? null
      : new Date(row.quarantine_until as string | Date),
    lifetimeSpendMills: row.lifetime_spend_mills == null
      ? null
      : BigInt(String(row.lifetime_spend_mills)),
  }));
}

export async function countAgentThreads(
  db: Database,
  query: AgentThreadsQuery,
  probeMax: number,
): Promise<{ value: number; exact: boolean }> {
  if (query.pageIds.length === 0) {
    return { value: 0, exact: true };
  }
  const result = await db.execute<{ count: string }>(sql`
    select count(*)::text as count from (
      select t.id
      from page_dm_threads t
      join pages p on p.id = t.platform_account_id
      left join page_dm_message_sync_health h on h.conversation_id = t.id
      where ${threadsWhere(query)}
      limit ${probeMax + 1}
    ) probe
  `);
  const value = Number(result.rows[0]?.count ?? 0);
  return value > probeMax ? { value: probeMax + 1, exact: false } : { value, exact: true };
}

// ---------------------------------------------------------------------------
// #7 search
// ---------------------------------------------------------------------------

export interface AgentSearchRow {
  pageLabel: string;
  platform: string;
  conversationRef: string | null;
  messageRef: string;
  occurredAt: Date | null;
  senderRole: string;
  isSentByMe: boolean;
  rank: number;
  snippet: string | null;
}

/**
 * Bounded full-text search over `message_archive.text_plain`.
 *
 * It activates the GIN index that has existed since migration 0059 and was never
 * used: `to_tsvector('simple', text_plain) @@ websearch_to_tsquery('simple', $q)`.
 *
 * `escapeLikePattern` is deliberately NOT applied: it escapes `\ % _` for LIKE,
 * which is meaningless to the tsquery parser and actively corrupts input
 * (`snake_case` becomes `snake\_case`). The unescaped-ILIKE bug lives where the
 * ILIKE lives, not here.
 *
 * The snippet is a FLAT +/-120 character window around the first match, computed
 * in SQL without `ts_headline`: headline generation reads and re-parses the whole
 * document per row, which is exactly the cost this bounded operation refuses.
 */
export async function searchAgentArchive(
  db: Database,
  input: {
    pageIds: readonly number[];
    query: string;
    from: Date;
    to: Date;
    platform?: string | undefined;
    conversationRefs?: readonly string[] | undefined;
    fanNativeId?: string | undefined;
    direction?: "inbound" | "outbound" | "unknown" | undefined;
    senderRole?: string | undefined;
    includeSnippet: boolean;
    limit: number;
  },
): Promise<AgentSearchRow[]> {
  if (input.pageIds.length === 0) {
    return [];
  }
  const clauses: SQL[] = [
    sql`ma.account_id in ${pageIdList(input.pageIds)}`,
    sql`ma.occurred_at >= ${input.from}`,
    sql`ma.occurred_at < ${input.to}`,
    sql`to_tsvector('simple', ma.text_plain) @@ websearch_to_tsquery('simple', ${input.query})`,
  ];
  if (input.platform !== undefined) {
    clauses.push(sql`ma.platform = ${input.platform}`);
  }
  if (input.conversationRefs !== undefined && input.conversationRefs.length > 0) {
    clauses.push(sql`ma.conversation_ref in (${sql.join(
      input.conversationRefs.map((ref) => sql`${ref}`),
      sql`, `,
    )})`);
  }
  if (input.fanNativeId !== undefined) {
    clauses.push(sql`ma.fan_native_id = ${input.fanNativeId}`);
  }
  if (input.senderRole !== undefined) {
    clauses.push(sql`ma.sender_role = ${input.senderRole}`);
  }
  if (input.direction === "outbound") {
    clauses.push(sql`ma.is_sent_by_me`);
  } else if (input.direction === "inbound") {
    clauses.push(sql`not ma.is_sent_by_me and ma.sender_role <> 'system'`);
  } else if (input.direction === "unknown") {
    clauses.push(sql`ma.sender_role = 'unknown'`);
  }

  const snippet = input.includeSnippet
    ? sql`substring(ma.text_plain from greatest(1, coalesce(nullif(position(lower(${input.query}) in lower(ma.text_plain)), 0), 1) - 120) for 300)`
    : sql`null::text`;

  const result = await db.execute<Record<string, unknown>>(sql`
    select p.label, ma.platform, ma.conversation_ref, ma.message_ref, ma.occurred_at,
           ma.sender_role, ma.is_sent_by_me,
           ts_rank(to_tsvector('simple', ma.text_plain),
                   websearch_to_tsquery('simple', ${input.query}))::float8 as rank,
           ${snippet} as snippet
    from message_archive ma
    join pages p on p.id = ma.account_id
    where ${sql.join(clauses, sql` and `)}
    order by rank desc, ma.occurred_at desc nulls last, ma.message_ref desc
    limit ${input.limit}
  `);

  return result.rows.map((row) => ({
    pageLabel: String(row.label),
    platform: String(row.platform),
    conversationRef: row.conversation_ref == null ? null : String(row.conversation_ref),
    messageRef: String(row.message_ref),
    occurredAt: row.occurred_at == null ? null : new Date(row.occurred_at as string | Date),
    senderRole: String(row.sender_role ?? "unknown"),
    isSentByMe: row.is_sent_by_me === true,
    rank: Math.max(0, Number(row.rank ?? 0)),
    snippet: row.snippet == null ? null : String(row.snippet),
  }));
}

// ---------------------------------------------------------------------------
// #8 coverage
// ---------------------------------------------------------------------------

export interface AgentCoverageScopeRow {
  pageId: number;
  pageLabel: string;
  platform: string;
  conversationRef: string;
  fanPlatformUserId: string | null;
  lastMessageSyncAt: Date | null;
  quarantineUntil: Date | null;
  storedMessageCount: number;
  observedRowFloor: Date | null;
}

/** One row per (page, conversation) in scope: a proof over one thread grants no
 *  conclusion about ten, so the probe is quantified per scope. */
export async function listAgentCoverageScopes(
  db: Database,
  input: {
    pageIds: readonly number[];
    platform?: string | undefined;
    fanId?: number | undefined;
    conversationRef?: string | undefined;
    from: Date;
    to: Date;
    limit: number;
    after?: { pageLabel: string; conversationRef: string } | undefined;
  },
): Promise<AgentCoverageScopeRow[]> {
  if (input.pageIds.length === 0) {
    return [];
  }
  const clauses: SQL[] = [sql`t.platform_account_id in ${pageIdList(input.pageIds)}`];
  if (input.platform !== undefined) {
    clauses.push(sql`p.platform = ${input.platform}`);
  }
  if (input.fanId !== undefined) {
    clauses.push(sql`t.fan_id = ${input.fanId}`);
  }
  if (input.conversationRef !== undefined) {
    clauses.push(sql`t.platform_conversation_id = ${input.conversationRef}`);
  }
  const after = input.after;
  if (after !== undefined) {
    clauses.push(sql`(p.label, t.platform_conversation_id) > (${after.pageLabel}, ${after.conversationRef})`);
  }

  const result = await db.execute<Record<string, unknown>>(sql`
    select t.platform_account_id, p.label, p.platform::text as platform,
           t.platform_conversation_id,
           coalesce(f.platform_user_id, t.partner_platform_user_id) as fan_platform_user_id,
           t.last_message_sync_at, h.quarantine_until, t.stored_message_count,
           floor.observed_row_floor
    from page_dm_threads t
    join pages p on p.id = t.platform_account_id
    left join page_dm_message_sync_health h on h.conversation_id = t.id
    left join fans f on f.id = t.fan_id
    left join lateral (
      select min(ma.occurred_at) as observed_row_floor
      from message_archive ma
      where ma.account_id = t.platform_account_id
        and ma.conversation_ref = t.platform_conversation_id
        and ma.occurred_at >= ${input.from} and ma.occurred_at < ${input.to}
    ) floor on true
    where ${sql.join(clauses, sql` and `)}
    order by p.label asc, t.platform_conversation_id asc
    limit ${input.limit}
  `);

  return result.rows.map((row) => ({
    pageId: Number(row.platform_account_id),
    pageLabel: String(row.label),
    platform: String(row.platform),
    conversationRef: String(row.platform_conversation_id),
    fanPlatformUserId: row.fan_platform_user_id == null
      ? null
      : String(row.fan_platform_user_id),
    lastMessageSyncAt: row.last_message_sync_at == null
      ? null
      : new Date(row.last_message_sync_at as string | Date),
    quarantineUntil: row.quarantine_until == null
      ? null
      : new Date(row.quarantine_until as string | Date),
    storedMessageCount: Number(row.stored_message_count ?? 0),
    observedRowFloor: row.observed_row_floor == null
      ? null
      : new Date(row.observed_row_floor as string | Date),
  }));
}

// ---------------------------------------------------------------------------
// #9a / #9b observations
// ---------------------------------------------------------------------------

export interface AgentObservationRow {
  observationRef: number;
  receivedAt: Date;
  observedAt: Date | null;
  source: string;
  producer: string;
  platform: string | null;
  pageLabel: string | null;
  nativeAccountRef: string | null;
  kind: string;
  payloadBytes: number;
  payloadSha256: string;
  parseVersion: number;
  domainEventCount: number;
}

export async function listAgentObservations(
  db: Database,
  input: {
    pageIds: readonly number[];
    from: Date;
    to: Date;
    platform?: string | undefined;
    pageLabel?: string | undefined;
    source?: string | undefined;
    kind?: string | undefined;
    producer?: string | undefined;
    parseVersion?: number | undefined;
    sortDir: "asc" | "desc";
    limit: number;
    after?: { receivedAt: string; observationRef: number } | undefined;
  },
): Promise<AgentObservationRow[]> {
  if (input.pageIds.length === 0) {
    return [];
  }
  const clauses: SQL[] = [
    // A journal row with NO account is deployment-wide (a webhook before page
    // resolution); it stays invisible to a scoped key rather than leaking.
    sql`o.account_id in ${pageIdList(input.pageIds)}`,
    sql`o.received_at >= ${input.from}`,
    sql`o.received_at < ${input.to}`,
  ];
  if (input.platform !== undefined) {
    clauses.push(sql`o.platform = ${input.platform}`);
  }
  if (input.pageLabel !== undefined) {
    clauses.push(sql`p.label = ${input.pageLabel}`);
  }
  if (input.source !== undefined) {
    clauses.push(sql`o.source = ${input.source}`);
  }
  if (input.kind !== undefined) {
    clauses.push(sql`o.kind = ${input.kind}`);
  }
  if (input.producer !== undefined) {
    clauses.push(sql`o.producer = ${input.producer}`);
  }
  if (input.parseVersion !== undefined) {
    clauses.push(sql`o.parse_version = ${input.parseVersion}`);
  }
  const after = input.after;
  const descending = input.sortDir === "desc";
  if (after !== undefined) {
    clauses.push(descending
      ? sql`(o.received_at, o.id) < (${after.receivedAt}::timestamptz, ${after.observationRef})`
      : sql`(o.received_at, o.id) > (${after.receivedAt}::timestamptz, ${after.observationRef})`);
  }
  const order = descending
    ? sql`order by o.received_at desc, o.id desc`
    : sql`order by o.received_at asc, o.id asc`;

  const result = await db.execute<Record<string, unknown>>(sql`
    select o.id::text as id, o.received_at, o.observed_at, o.source, o.producer,
           o.platform, p.label, o.native_account_ref, o.kind,
           octet_length(o.payload::text) as payload_bytes,
           encode(o.payload_hash, 'hex') as payload_sha256,
           o.parse_version,
           coalesce(de.event_count, 0)::text as domain_event_count
    from observations o
    left join pages p on p.id = o.account_id
    left join lateral (
      select count(*) as event_count from domain_events d where d.observation_id = o.id
    ) de on true
    where ${sql.join(clauses, sql` and `)}
    ${order}
    limit ${input.limit}
  `);

  return result.rows.map((row) => ({
    observationRef: Number(row.id),
    receivedAt: new Date(row.received_at as string | Date),
    observedAt: row.observed_at == null ? null : new Date(row.observed_at as string | Date),
    source: String(row.source),
    producer: String(row.producer),
    platform: row.platform == null ? null : String(row.platform),
    pageLabel: row.label == null ? null : String(row.label),
    nativeAccountRef: row.native_account_ref == null ? null : String(row.native_account_ref),
    kind: String(row.kind),
    payloadBytes: Number(row.payload_bytes ?? 0),
    payloadSha256: String(row.payload_sha256 ?? ""),
    parseVersion: Number(row.parse_version ?? 0),
    domainEventCount: Number(row.domain_event_count ?? 0),
  }));
}

export interface AgentObservationPayloadRow extends AgentObservationRow {
  payload: Record<string, unknown> | null;
}

/** #9b: one row by ref, WITH its body. Owner-session only — the caller decides
 *  whether the kind may be served at all, and the scrub runs before the wire. */
export async function findAgentObservationPayload(
  db: Database,
  observationRef: number,
): Promise<AgentObservationPayloadRow | null> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select o.id::text as id, o.received_at, o.observed_at, o.source, o.producer,
           o.platform, p.label, o.native_account_ref, o.kind,
           octet_length(o.payload::text) as payload_bytes,
           encode(o.payload_hash, 'hex') as payload_sha256,
           o.parse_version, o.payload,
           0::text as domain_event_count
    from observations o
    left join pages p on p.id = o.account_id
    where o.id = ${observationRef}
    limit 1
  `);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    observationRef: Number(row.id),
    receivedAt: new Date(row.received_at as string | Date),
    observedAt: row.observed_at == null ? null : new Date(row.observed_at as string | Date),
    source: String(row.source),
    producer: String(row.producer),
    platform: row.platform == null ? null : String(row.platform),
    pageLabel: row.label == null ? null : String(row.label),
    nativeAccountRef: row.native_account_ref == null ? null : String(row.native_account_ref),
    kind: String(row.kind),
    payloadBytes: Number(row.payload_bytes ?? 0),
    payloadSha256: String(row.payload_sha256 ?? ""),
    parseVersion: Number(row.parse_version ?? 0),
    domainEventCount: 0,
    payload: (row.payload as Record<string, unknown> | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// #10 datasets
// ---------------------------------------------------------------------------

export interface AgentDatasetFilter {
  /** ALREADY resolved against the contracts registry; this is a code constant. */
  column: string;
  op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "in" | "is_null" | "is_not_null";
  value: string | number | boolean | null | string[] | undefined;
}

export interface AgentDatasetRowRaw {
  key: string;
  occurredAt: Date | null;
  fanPlatformUserId: string | null;
  platform: string | null;
  fields: Record<string, unknown>;
}

function datasetFilterSql(filter: AgentDatasetFilter): SQL {
  // `sql.raw` is safe here and ONLY here: `column` came from the registry's own
  // constant table after the request's field name was validated against the
  // dataset allowlist. The VALUE is always a bound parameter.
  const column = sql.raw(`src.${filter.column}`);
  switch (filter.op) {
    case "is_null":
      return sql`${column} is null`;
    case "is_not_null":
      return sql`${column} is not null`;
    case "in": {
      const values = Array.isArray(filter.value) ? filter.value : [];
      if (values.length === 0) {
        return sql`false`;
      }
      return sql`${column}::text in (${sql.join(values.map((v) => sql`${String(v)}`), sql`, `)})`;
    }
    case "eq":
      return sql`${column}::text = ${String(filter.value)}`;
    case "neq":
      return sql`${column}::text is distinct from ${String(filter.value)}`;
    case "lt":
      return sql`${column} < ${filter.value}`;
    case "lte":
      return sql`${column} <= ${filter.value}`;
    case "gt":
      return sql`${column} > ${filter.value}`;
    case "gte":
      return sql`${column} >= ${filter.value}`;
  }
}

export async function queryAgentDataset(
  db: Database,
  input: {
    dataset: string;
    pageId: number;
    from: Date;
    to: Date;
    filters: readonly AgentDatasetFilter[];
    /** Resolved sort columns, already registry-checked. */
    sort: ReadonlyArray<{ column: string; dir: "asc" | "desc" }>;
    limit: number;
    after?: { sortValue: string | null; key: string } | undefined;
  },
): Promise<AgentDatasetRowRaw[]> {
  const mapping = agentDatasetSqlMapping(input.dataset);
  if (!mapping) {
    throw new Error(`unmapped agent dataset: ${input.dataset}`);
  }
  const source = sql.raw(mapping.source);
  const windowColumn = sql.raw(`src.${mapping.windowColumn}`);

  const clauses: SQL[] = [
    sql`src.k_page_id = ${input.pageId}`,
    sql`(${windowColumn} is null or (${windowColumn} >= ${input.from} and ${windowColumn} < ${input.to}))`,
  ];
  for (const filter of input.filters) {
    clauses.push(datasetFilterSql(filter));
  }

  const primary = input.sort[0];
  const sortColumn = primary === undefined
    ? windowColumn
    : sql.raw(`src.${primary.column}`);
  const descending = (primary?.dir ?? "desc") === "desc";
  const after = input.after;
  if (after !== undefined) {
    clauses.push(after.sortValue === null
      ? (descending
        ? sql`(${sortColumn} is null and src.k_key < ${after.key})`
        : sql`(${sortColumn} is not null or src.k_key > ${after.key})`)
      : (descending
        ? sql`(${sortColumn}::text < ${after.sortValue}
               or (${sortColumn}::text = ${after.sortValue} and src.k_key < ${after.key})
               or ${sortColumn} is null)`
        : sql`(${sortColumn}::text > ${after.sortValue}
               or (${sortColumn}::text = ${after.sortValue} and src.k_key > ${after.key}))`));
  }

  const order = descending
    ? sql`order by ${sortColumn} desc nulls last, src.k_key desc`
    : sql`order by ${sortColumn} asc nulls last, src.k_key asc`;

  const projection = sql.join(
    Object.entries(mapping.fields).map(([wire, column]) =>
      sql`${sql.raw(`src.${column}`)} as ${sql.raw(`"${wire}"`)}`),
    sql`, `,
  );

  const result = await db.execute<Record<string, unknown>>(sql`
    with src as (${source})
    select src.k_key, src.k_occurred_at, src.k_fan, src.k_platform, ${projection}
    from src
    where ${sql.join(clauses, sql` and `)}
    ${order}
    limit ${input.limit}
  `);

  const wireFields = Object.keys(mapping.fields);
  return result.rows.map((row) => {
    const fields: Record<string, unknown> = {};
    for (const wire of wireFields) {
      fields[wire] = row[wire] ?? null;
    }
    return {
      key: String(row.k_key),
      occurredAt: row.k_occurred_at == null
        ? null
        : new Date(row.k_occurred_at as string | Date),
      fanPlatformUserId: row.k_fan == null ? null : String(row.k_fan),
      platform: row.k_platform == null ? null : String(row.k_platform),
      fields,
    };
  });
}
