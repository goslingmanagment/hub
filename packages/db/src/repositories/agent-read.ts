import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import { agentDatasetSqlMapping } from "./agent-dataset-map.ts";
import {
  keysetOrderBy,
  keysetPredicate,
  renderInstant,
  renderNumeric,
  renderText,
  type KeysetBoundary,
  type KeysetDirection,
} from "./agent-keyset.ts";
import { witnessesFor, type PlaneReadWitness } from "./agent-read-witness.ts";

/**
 * Every read the Agent Read Plane performs, except the transcript union (its own
 * module) and the key/audit tables (slice 0a).
 *
 * THREE RULES THAT SHAPE EVERY QUERY HERE:
 *
 * 1. **The grant is intersected in SQL, never after the fetch.** Each function
 *    takes an already-resolved `pageIds` list and binds it into the statement. An
 *    EMPTY list means "no visible pages" and returns nothing — handing `[]` to a
 *    filter that reads it as "no filter" is exactly how a scope clamp becomes an
 *    unfiltered read.
 * 2. **A `read` verdict is minted here or nowhere.** Every function returns the
 *    `PlaneReadWitness` values for the statements it ACTUALLY executed, and the
 *    mint helpers are not exported from the package barrel. Review round 1 found
 *    four handlers claiming reads they never performed; this is the structural
 *    answer rather than a review checklist.
 * 3. **Every filter this layer accepts is applied.** A parameter that reaches a
 *    signature and not the WHERE clause is worse than an unsupported one: the
 *    response says "filtered" and returns everybody's rows.
 *
 * Keyset pagination is delegated to `agent-keyset.ts`, which exists so the ORDER
 * BY and the resume predicate cannot drift apart.
 */

/**
 * A statement hit its `statement_timeout`.
 *
 * Typed so callers can DEGRADE (a multi-source read reports a `sourceErrors` row)
 * or FAIL (a single-source read answers a retryable 503) instead of letting a
 * driver error escape as a generic 500 — which is what happened everywhere except
 * #8 in the first revision.
 */
export class AgentStatementTimeoutError extends Error {
  constructor(readonly source: string) {
    super(`agent read statement timed out (${source})`);
    this.name = "AgentStatementTimeoutError";
  }
}

/** Postgres reports a statement timeout as SQLSTATE 57014. */
export function isStatementTimeout(error: unknown): boolean {
  if (error instanceof AgentStatementTimeoutError) {
    return true;
  }
  for (let current: unknown = error, depth = 0; current != null && depth < 5; depth += 1) {
    if (typeof current === "object" && (current as { code?: unknown }).code === "57014") {
      return true;
    }
    current = (current as { cause?: unknown }).cause ?? null;
  }
  return false;
}

/**
 * Runs `body` inside a transaction with a local `statement_timeout`, and
 * translates a timeout into the typed error above.
 *
 * SET LOCAL is transaction-scoped, so the ceiling cannot leak onto the next
 * borrower of this pooled connection — a global SET would eventually apply a
 * five-second limit to the sync worker.
 */
export async function withAgentStatementTimeout<T>(
  db: Database,
  timeoutMs: number,
  body: (tx: Database) => Promise<T>,
  source = "agent_read",
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = ${sql.raw(String(Math.trunc(timeoutMs)))}`);
      return body(tx as unknown as Database);
    });
  } catch (error) {
    if (isStatementTimeout(error)) {
      // The driver's error embeds the statement AND its bound parameters; neither
      // may reach a response body (sink allowlist).
      throw new AgentStatementTimeoutError(source);
    }
    throw error;
  }
}

function pageIdList(pageIds: readonly number[]): SQL {
  return sql`(${sql.join(pageIds.map((id) => sql`${id}`), sql`, `)})`;
}

function textList(values: readonly string[]): SQL {
  return sql`(${sql.join(values.map((value) => sql`${value}`), sql`, `)})`;
}

function date(value: unknown): Date | null {
  return value == null ? null : new Date(value as string | Date);
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
 *  what an agent is allowed to know, and it is what lets #3/#4 answer
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
 * one traversal, and a resumed keyset would then walk a different table.
 */
export async function readArchiveGeneration(db: Database): Promise<number> {
  const result = await db.execute<{ generation: string }>(
    sql`select generation::text as generation from archive_generation where id = 1`,
  );
  return Number(result.rows[0]?.generation ?? 0);
}

/** `pg_trgm` is a MANUAL owner DBA step outside the migration chain, so its
 *  presence is detected at runtime and its absence downgrades the backend. */
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
 * is the difference between "no such fact" and "no journal for that month". The
 * name pattern is anchored so that a helper table like
 * `domain_events_smoke_checkpoint` cannot masquerade as a detached month.
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
      and (c.relname ~ '^observations_[0-9]{4}_[0-9]{2}$'
        or c.relname ~ '^domain_events_[0-9]{4}_[0-9]{2}$')
      and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)
    order by c.relname
  `);
  return {
    observationsFirstReceivedAt: date(floor.rows[0]?.first_received_at),
    detachedPartitions: detached.rows.map((row) => String(row.relname)),
  };
}

/**
 * When this store's record of ONE thread begins.
 *
 * Deliberately NOT limited to the requested window: a floor computed inside the
 * window would always equal the window, which is circular. This is a lower bound
 * on what we hold — "the archive for this thread starts here" — and never a claim
 * about what happened before it.
 */
export async function readAgentThreadArchiveFloor(
  db: Database,
  input: { pageId: number; conversationRef: string },
): Promise<Date | null> {
  const result = await db.execute<{ floor_at: Date | null }>(sql`
    select min(ma.occurred_at) as floor_at
    from message_archive ma
    where ma.account_id = ${input.pageId} and ma.conversation_ref = ${input.conversationRef}
  `);
  return date(result.rows[0]?.floor_at);
}

// ---------------------------------------------------------------------------
// Fan lookup shared by the person filters (#5, #7, #8)
// ---------------------------------------------------------------------------

/**
 * Resolves a `(platform, platformUserId)` pair to a fan id.
 *
 * Every operation that ACCEPTS a person filter routes through here, because review
 * round 1 found three that accepted the pair, never applied it, and still reported
 * the predicate as applied: the response claimed to be about one person while
 * returning everybody's rows.
 */
export async function findAgentFanId(
  db: Database,
  input: { platform: string; platformUserId: string },
): Promise<number | null> {
  const result = await db.execute<{ id: string }>(sql`
    select f.id
    from fans f
    where f.platform = ${input.platform} and f.platform_user_id = ${input.platformUserId}
    limit 1
  `);
  const row = result.rows[0];
  return row ? Number(row.id) : null;
}

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
 * This is the production lesson in code. `fansly.com/user438765948262952961` looks
 * like an id and IS a username; the fan's `platform_user_id` is a different number
 * entirely. A resolver that tried one key answered "no such fan" about a fan who
 * had paid $100.
 *
 * `includeAliases: false` genuinely removes the alias arms. It used to reach the
 * signature and not the SQL, so turning it off still resolved through history —
 * and the witnesses claimed the alias stores had been read either way.
 */
export async function resolveAgentFanCandidates(
  db: Database,
  input: {
    pageIds: readonly number[];
    platform: string | null;
    values: readonly string[];
    includeAliases: boolean;
    limit: number;
  },
): Promise<{ matches: AgentResolveMatch[]; witnesses: PlaneReadWitness[] }> {
  if (input.pageIds.length === 0 || input.values.length === 0) {
    return { matches: [], witnesses: [] };
  }
  const values = textList(input.values);
  const lowered = textList(input.values.map((value) => value.toLowerCase()));
  const platformFilter = input.platform == null
    ? sql`true`
    : sql`f.platform = ${input.platform}`;

  const aliasArms = input.includeAliases
    ? sql`
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
    `
    : sql``;

  const result = await db.execute<Record<string, unknown>>(sql`
    with visible_fans as (
      select distinct pf.fan_id
      from page_fans pf
      where pf.platform_account_id in ${pageIdList(input.pageIds)}
      union
      select distinct t.fan_id
      from page_dm_threads t
      where t.platform_account_id in ${pageIdList(input.pageIds)} and t.fan_id is not null
      union
      -- A fan the agency has only ever taken money from is still visible: the
      -- original incident was precisely a person whose message rows were absent
      -- and whose payment was not.
      select distinct tr.fan_id
      from transactions tr
      where tr.platform_account_id in ${pageIdList(input.pageIds)} and tr.fan_id is not null
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
      ${aliasArms}
      union all
      select f.id, f.platform::text, f.platform_user_id, f.username, f.display_name,
             f.created_at_external, f.deleted_detected_at,
             'displayName'::text, f.display_name, 4
      from fans f
      where lower(f.display_name) in ${lowered} and ${platformFilter}
    )
    -- Distinct on the MATCHED VALUE too: collapsing by (fan, kind) alone hid all
    -- but one alias when several of them matched.
    select distinct on (m.id, m.match_kind, m.matched_value)
           m.id, m.platform, m.platform_user_id, m.username, m.display_name,
           m.created_at_external, m.deleted_detected_at, m.match_kind, m.matched_value, m.rank
    from matched m
    join visible_fans v on v.fan_id = m.id
    order by m.id, m.match_kind, m.matched_value, m.rank
    limit ${input.limit}
  `);

  return {
    matches: result.rows.map((row) => ({
      fanId: Number(row.id),
      platform: String(row.platform),
      platformUserId: String(row.platform_user_id),
      username: row.username == null ? null : String(row.username),
      displayName: row.display_name == null ? null : String(row.display_name),
      matchKind: String(row.match_kind) as AgentResolveMatch["matchKind"],
      matchedValue: String(row.matched_value ?? ""),
      createdAtExternal: date(row.created_at_external),
      deletedDetectedAt: date(row.deleted_detected_at),
    })),
    witnesses: witnessesFor(
      input.includeAliases
        ? ["fans", "page_fans", "fan_username_aliases", "page_fan_aliases"]
        : ["fans", "page_fans"],
    ),
  };
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
): Promise<{ rows: AgentFanThreadRow[]; witnesses: PlaneReadWitness[] }> {
  if (input.pageIds.length === 0 || input.fanIds.length === 0) {
    return { rows: [], witnesses: [] };
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
  return {
    rows: result.rows.map((row) => ({
      fanId: Number(row.fan_id),
      pageId: Number(row.platform_account_id),
      pageLabel: String(row.label),
      platform: String(row.platform),
      conversationRef: String(row.platform_conversation_id),
      storedMessageCount: Number(row.stored_message_count ?? 0),
      coverageStatusRaw: String(row.coverage_status),
    })),
    witnesses: witnessesFor(["page_dm_threads"]),
  };
}

// ---------------------------------------------------------------------------
// #3 person — split so an ungranted section is never QUERIED, not merely hidden
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
): Promise<{ row: AgentPersonIdentityRow | null; witnesses: PlaneReadWitness[] }> {
  if (input.pageIds.length === 0) {
    return { row: null, witnesses: [] };
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
  return {
    row: row === undefined ? null : {
      fanId: Number(row.id),
      platform: String(row.platform),
      platformUserId: String(row.platform_user_id),
      username: row.username == null ? null : String(row.username),
      displayName: row.display_name == null ? null : String(row.display_name),
      createdAtExternal: date(row.created_at_external),
      firstSeenAt: date(row.first_seen_at),
      lastSeenAt: date(row.last_seen_at),
      deletedDetectedAt: date(row.deleted_detected_at),
    },
    witnesses: witnessesFor(["fans", "page_fans"]),
  };
}

export interface AgentPersonIdentityExtras {
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
}

export async function loadAgentPersonIdentityExtras(
  db: Database,
  input: { pageIds: readonly number[]; fanId: number },
): Promise<{ data: AgentPersonIdentityExtras; witnesses: PlaneReadWitness[] }> {
  const pages = pageIdList(input.pageIds);
  const [aliases, flags, memberships] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select 'username'::text as kind, u.username as value, u.first_seen_at, u.last_seen_at
      from fan_username_aliases u where u.fan_id = ${input.fanId}
      union all
      select 'alias'::text, a.alias, a.first_seen_at, a.last_seen_at
      from page_fan_aliases a
      where a.fan_id = ${input.fanId} and a.platform_account_id in ${pages}
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
      where fg.fan_id = ${input.fanId}
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
      where pf.fan_id = ${input.fanId} and pf.platform_account_id in ${pages}
      order by p.label asc
    `),
  ]);

  return {
    data: {
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
    },
    witnesses: witnessesFor([
      "fans",
      "page_fans",
      "fan_username_aliases",
      "page_fan_aliases",
      "fan_flags",
    ]),
  };
}

export interface AgentPersonMoney {
  lifetime: {
    grossMills: bigint;
    netMills: bigint;
    transactionCount: number;
    firstTransactionAt: Date | null;
    lastTransactionAt: Date | null;
  };
  byType: Array<{
    transactionType: string;
    transactionState: string;
    grossMills: bigint;
    netMills: bigint;
    transactionCount: number;
  }>;
}

/**
 * The money section. Called ONLY when the key holds `read:money` — the first
 * revision ran these queries unconditionally and then reported the planes as
 * `not_read`, which both paid for the work and mis-described the response.
 *
 * `byType` comes from `transactions`, NOT `fan_spend_daily`: the two disagree on
 * negations (a chargeback inactivates the original row in `transactions` while the
 * daily rollup keeps its own history), and the operation that must answer "what
 * did this person actually pay" reads the ledger of record.
 */
export async function loadAgentPersonMoney(
  db: Database,
  input: { pageIds: readonly number[]; fanId: number },
): Promise<{ data: AgentPersonMoney; witnesses: PlaneReadWitness[] }> {
  const pages = pageIdList(input.pageIds);
  const [lifetime, byType] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select coalesce(sum(tr.gross_amount_mills), 0)::text as gross_mills,
             coalesce(sum(tr.creator_net_amount_mills), 0)::text as net_mills,
             count(*)::text as transaction_count,
             min(tr.occurred_at) as first_transaction_at,
             max(tr.occurred_at) as last_transaction_at
      from transactions tr
      where tr.fan_id = ${input.fanId} and tr.platform_account_id in ${pages} and tr.is_active
    `),
    db.execute<Record<string, unknown>>(sql`
      select tr.canonical_type::text as transaction_type,
             tr.transaction_state::text as transaction_state,
             coalesce(sum(tr.gross_amount_mills), 0)::text as gross_mills,
             coalesce(sum(tr.creator_net_amount_mills), 0)::text as net_mills,
             count(*)::text as transaction_count
      from transactions tr
      where tr.fan_id = ${input.fanId} and tr.platform_account_id in ${pages} and tr.is_active
      group by 1, 2
      order by 1, 2
    `),
  ]);
  const row = lifetime.rows[0];
  return {
    data: {
      lifetime: {
        grossMills: BigInt(String(row?.gross_mills ?? "0")),
        netMills: BigInt(String(row?.net_mills ?? "0")),
        transactionCount: Number(row?.transaction_count ?? 0),
        firstTransactionAt: date(row?.first_transaction_at),
        lastTransactionAt: date(row?.last_transaction_at),
      },
      byType: byType.rows.map((entry) => ({
        transactionType: String(entry.transaction_type),
        transactionState: String(entry.transaction_state),
        grossMills: BigInt(String(entry.gross_mills ?? "0")),
        netMills: BigInt(String(entry.net_mills ?? "0")),
        transactionCount: Number(entry.transaction_count ?? 0),
      })),
    },
    witnesses: witnessesFor(["transactions"]),
  };
}

export interface AgentPersonSubscription {
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
}

export async function loadAgentPersonSubscriptions(
  db: Database,
  input: { pageIds: readonly number[]; fanId: number },
): Promise<{ rows: AgentPersonSubscription[]; witnesses: PlaneReadWitness[] }> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select p.label, s.platform_subscription_id, s.canonical_status, s.subscription_tier_name,
           s.price_mills::text as price_mills, s.renew_price_mills::text as renew_price_mills,
           s.auto_renew, s.billing_cycle_days, s.source_created_at, s.ends_at, s.is_current
    from page_subscriptions s
    join pages p on p.id = s.platform_account_id
    where s.fan_id = ${input.fanId} and s.platform_account_id in ${pageIdList(input.pageIds)}
    order by s.ends_at desc nulls last, s.id desc
    limit 200
  `);
  return {
    rows: result.rows.map((row) => ({
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
    witnesses: witnessesFor(["page_subscriptions"]),
  };
}

export interface AgentPersonCrm {
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

export async function loadAgentPersonCrm(
  db: Database,
  input: { pageIds: readonly number[]; fanId: number },
): Promise<{ data: AgentPersonCrm; witnesses: PlaneReadWitness[] }> {
  const pages = pageIdList(input.pageIds);
  const [notes, summaries] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select p.label, 'internal:' || n.id::text as note_ref, 'internal'::text as origin,
             n.body as note_text, n.created_at, n.created_at as updated_at
      from fan_notes n
      join pages p on p.id = n.platform_account_id
      where n.fan_id = ${input.fanId} and n.platform_account_id in ${pages}
      union all
      select p.label, 'external:' || e.id::text, 'external'::text,
             coalesce(e.body, ''), coalesce(e.created_at_external, e.first_seen_at),
             coalesce(e.updated_at_external, e.last_seen_at)
      from page_fan_external_notes e
      join pages p on p.id = e.platform_account_id
      where e.fan_id = ${input.fanId} and e.platform_account_id in ${pages}
      order by 5 desc nulls last
      limit 200
    `),
    db.execute<Record<string, unknown>>(sql`
      select p.label, 'summary:' || s.id::text as summary_ref, s.body as summary_text, s.created_at
      from fan_summaries s
      join pages p on p.id = s.platform_account_id
      where s.fan_id = ${input.fanId} and s.platform_account_id in ${pages}
      order by s.created_at desc
      limit 200
    `),
  ]);
  return {
    data: {
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
    },
    witnesses: witnessesFor(["fan_notes", "fan_summaries"]),
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
  sortValue: string;
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
 * The plane each lane physically reads. A lane that is not served builds no arm,
 * costs nothing and mints no witness — so `capture.planes` cannot claim it.
 *
 * EVERY arm below names its columns explicitly. In a UNION the FIRST arm supplies
 * the names, so relying on the messages arm to do it broke the moment a
 * capability gate dropped that lane and `follows` became first.
 */
const TIMELINE_LANE_PLANES: Readonly<Record<string, readonly string[]>> = {
  messages: ["message_archive"],
  money: ["transactions"],
  subscriptions: ["page_subscriptions"],
  follows: ["page_follows"],
  presence: ["page_fans"],
};

/**
 * The merged per-fan timeline.
 *
 * The MESSAGES lane carries metrics only — ref, direction, sender role, text
 * LENGTH, media and tip flags — and never the text itself: verbatim material stays
 * on the two operations R3 was accepted for.
 */
export async function listAgentTimeline(
  db: Database,
  input: {
    pageIds: readonly number[];
    fanId: number;
    from: Date;
    to: Date;
    lanes: readonly string[];
    sortDir: KeysetDirection;
    limit: number;
    after?: KeysetBoundary | undefined;
  },
): Promise<{ rows: AgentTimelineRow[]; witnesses: PlaneReadWitness[] }> {
  if (input.pageIds.length === 0 || input.lanes.length === 0) {
    return { rows: [], witnesses: [] };
  }
  const pages = pageIdList(input.pageIds);
  const wants = (lane: string) => input.lanes.includes(lane);
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
      select 'money'::text as lane,
             case when tr.canonical_type = 'tip' then 'tip.received'
                  when tr.transaction_state = 'pending' then 'transaction.pending'
                  else 'transaction.posted' end as kind,
             tr.occurred_at as occurred_at,
             'transaction:' || tr.id::text as stable_ref,
             p.label as page_label, p.platform::text as platform,
             null::text as conversation_ref, null::text as message_ref,
             tr.transaction_id as transaction_ref, null::text as subscription_ref,
             tr.gross_amount_mills as gross_mills,
             tr.creator_net_amount_mills as net_mills,
             tr.canonical_type::text as transaction_type,
             tr.transaction_state::text as transaction_state,
             tr.currency::text as currency,
             null::text as direction, null::text as sender_role,
             null::int as text_length, null::boolean as has_media, null::boolean as is_tip
      from transactions tr
      join pages p on p.id = tr.platform_account_id
      where tr.platform_account_id in ${pages} and tr.fan_id = ${input.fanId} and tr.is_active
        and tr.occurred_at >= ${input.from} and tr.occurred_at < ${input.to}
    `);
  }
  if (wants("subscriptions")) {
    arms.push(sql`
      select 'subscriptions'::text as lane,
             case when s.ends_at is not null and s.ends_at < now() then 'subscription.ended'
                  when s.is_current then 'subscription.renewed'
                  else 'subscription.started' end as kind,
             coalesce(s.source_created_at, s.last_seen_at) as occurred_at,
             'subscription:' || s.id::text as stable_ref,
             p.label as page_label, p.platform::text as platform,
             null::text as conversation_ref, null::text as message_ref,
             null::text as transaction_ref,
             s.platform_subscription_id as subscription_ref,
             s.price_mills as gross_mills, null::bigint as net_mills,
             null::text as transaction_type, null::text as transaction_state,
             null::text as currency,
             null::text as direction, null::text as sender_role,
             null::int as text_length, null::boolean as has_media, null::boolean as is_tip
      from page_subscriptions s
      join pages p on p.id = s.platform_account_id
      where s.platform_account_id in ${pages} and s.fan_id = ${input.fanId}
        and coalesce(s.source_created_at, s.last_seen_at) >= ${input.from}
        and coalesce(s.source_created_at, s.last_seen_at) < ${input.to}
    `);
  }
  if (wants("follows")) {
    arms.push(sql`
      select 'follows'::text as lane,
             case when fl.is_active then 'follow.started' else 'follow.ended' end as kind,
             fl.followed_at as occurred_at,
             'follow:' || fl.id::text as stable_ref,
             p.label as page_label, p.platform::text as platform,
             null::text as conversation_ref, null::text as message_ref,
             null::text as transaction_ref, null::text as subscription_ref,
             null::bigint as gross_mills, null::bigint as net_mills,
             null::text as transaction_type, null::text as transaction_state,
             null::text as currency,
             null::text as direction, null::text as sender_role,
             null::int as text_length, null::boolean as has_media, null::boolean as is_tip
      from page_follows fl
      join pages p on p.id = fl.platform_account_id
      where fl.platform_account_id in ${pages} and fl.fan_id = ${input.fanId}
        and fl.followed_at >= ${input.from} and fl.followed_at < ${input.to}
    `);
  }
  if (wants("presence")) {
    arms.push(sql`
      select 'presence'::text as lane, 'presence.online'::text as kind,
             pf.external_presence_at as occurred_at,
             'presence:' || pf.id::text as stable_ref,
             p.label as page_label, p.platform::text as platform,
             null::text as conversation_ref, null::text as message_ref,
             null::text as transaction_ref, null::text as subscription_ref,
             null::bigint as gross_mills, null::bigint as net_mills,
             null::text as transaction_type, null::text as transaction_state,
             null::text as currency,
             null::text as direction, null::text as sender_role,
             null::int as text_length, null::boolean as has_media, null::boolean as is_tip
      from page_fans pf
      join pages p on p.id = pf.platform_account_id
      where pf.platform_account_id in ${pages} and pf.fan_id = ${input.fanId}
        and pf.external_presence_at is not null
        and pf.external_presence_at >= ${input.from} and pf.external_presence_at < ${input.to}
    `);
  }
  if (arms.length === 0) {
    return { rows: [], witnesses: [] };
  }

  const result = await db.execute<Record<string, unknown>>(sql`
    with u as (${sql.join(arms, sql` union all `)}),
    keyed as (
      select u.*,
             ${renderInstant(sql`u.occurred_at`)} as k_sort,
             u.stable_ref as k_key
      from u
      where u.occurred_at is not null
    )
    select keyed.lane, keyed.kind, keyed.occurred_at, keyed.stable_ref, keyed.k_sort,
           keyed.page_label, keyed.platform,
           keyed.conversation_ref, keyed.message_ref, keyed.transaction_ref,
           keyed.subscription_ref,
           keyed.gross_mills::text as gross_mills, keyed.net_mills::text as net_mills,
           keyed.transaction_type, keyed.transaction_state, keyed.currency,
           keyed.direction, keyed.sender_role, keyed.text_length, keyed.has_media, keyed.is_tip
    from keyed
    where ${keysetPredicate(input.sortDir, input.after)}
    ${keysetOrderBy(input.sortDir)}
    limit ${input.limit}
  `);

  return {
    rows: result.rows.map((row) => ({
      lane: String(row.lane),
      kind: String(row.kind),
      occurredAt: new Date(row.occurred_at as string | Date),
      stableRef: String(row.stable_ref),
      sortValue: String(row.k_sort),
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
    })),
    witnesses: witnessesFor(input.lanes.flatMap((lane) => TIMELINE_LANE_PLANES[lane] ?? [])),
  };
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
  /** Rendered by SQL, at SQL's precision. Never re-derived in JavaScript. */
  sortValue: string | null;
  keysetKey: string;
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
  sortDir: KeysetDirection;
  limit: number;
  after?: KeysetBoundary | undefined;
  /** Frozen membership bound: threads created after the traversal started are
   *  excluded, which is what makes `snapshotExhausted` mean something. */
  maxThreadId?: number | undefined;
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
  if (query.maxThreadId !== undefined) {
    clauses.push(sql`t.id <= ${query.maxThreadId}`);
  }
  return sql.join(clauses, sql` and `);
}

/** The rendered sort key — the SAME expression in the projection, the ORDER BY and
 *  the resume predicate. That identity is the whole point (agent-keyset.ts). */
function threadSortExpression(orderBy: AgentThreadsQuery["orderBy"]): SQL {
  switch (orderBy) {
    case "storedMessageCount":
      return renderNumeric(sql`t.stored_message_count`);
    case "pageLabel":
      return renderText(sql`p.label`);
    case "lastMessageAt":
      return renderInstant(sql`t.last_message_at`);
  }
}

export async function listAgentThreads(
  db: Database,
  query: AgentThreadsQuery,
): Promise<{ rows: AgentThreadRow[]; witnesses: PlaneReadWitness[] }> {
  if (query.pageIds.length === 0) {
    return { rows: [], witnesses: [] };
  }
  const result = await db.execute<Record<string, unknown>>(sql`
    with keyed as (
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
             fsl.creator_net_amount_mills::text as lifetime_spend_mills,
             ${threadSortExpression(query.orderBy)} as k_sort,
             ${renderNumeric(sql`t.id`)} as k_key
      from page_dm_threads t
      join pages p on p.id = t.platform_account_id
      left join page_dm_message_sync_health h on h.conversation_id = t.id
      left join fans f on f.id = t.fan_id
      left join fan_spend_lifetime fsl
        on fsl.fan_id = t.fan_id and fsl.platform_account_id = t.platform_account_id
      where ${threadsWhere(query)}
    )
    select * from keyed
    where ${keysetPredicate(query.sortDir, query.after)}
    ${keysetOrderBy(query.sortDir)}
    limit ${query.limit}
  `);

  return {
    rows: result.rows.map((row) => ({
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
      lastMessageAt: date(row.last_message_at),
      lastFanMessageAt: date(row.last_fan_message_at),
      lastModelMessageAt: date(row.last_model_message_at),
      storedMessageCount: Number(row.stored_message_count ?? 0),
      oldestStoredMessageRef: row.oldest_stored_message_id == null
        ? null
        : String(row.oldest_stored_message_id),
      newestStoredMessageRef: row.newest_stored_message_id == null
        ? null
        : String(row.newest_stored_message_id),
      coverageStatusRaw: String(row.coverage_status),
      lastMessageSyncAt: date(row.last_message_sync_at),
      quarantineUntil: date(row.quarantine_until),
      lifetimeSpendMills: row.lifetime_spend_mills == null
        ? null
        : BigInt(String(row.lifetime_spend_mills)),
      sortValue: row.k_sort == null ? null : String(row.k_sort),
      keysetKey: String(row.k_key),
    })),
    witnesses: witnessesFor(["page_dm_threads"]),
  };
}

/** The frozen upper bound for a threads traversal. */
export async function readAgentThreadsHighWater(
  db: Database,
  pageIds: readonly number[],
): Promise<number> {
  if (pageIds.length === 0) {
    return 0;
  }
  const result = await db.execute<{ max_id: string | null }>(sql`
    select max(t.id)::text as max_id
    from page_dm_threads t
    where t.platform_account_id in ${pageIdList(pageIds)}
  `);
  return Number(result.rows[0]?.max_id ?? 0);
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
 * (`snake_case` becomes `snake\_case`).
 *
 * The person filter carries the PLATFORM as well as the id. Native ids are
 * platform-scoped, so filtering on the id alone can match a different person who
 * happens to share the number on the other granted platform.
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
    person?: { platform: string; platformUserId: string } | undefined;
    direction?: "inbound" | "outbound" | "unknown" | undefined;
    senderRole?: string | undefined;
    includeSnippet: boolean;
    limit: number;
  },
): Promise<{ rows: AgentSearchRow[]; witnesses: PlaneReadWitness[] }> {
  if (input.pageIds.length === 0) {
    return { rows: [], witnesses: [] };
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
    clauses.push(sql`ma.conversation_ref in ${textList(input.conversationRefs)}`);
  }
  if (input.person !== undefined) {
    clauses.push(sql`ma.platform = ${input.person.platform}`);
    clauses.push(sql`ma.fan_native_id = ${input.person.platformUserId}`);
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

  return {
    rows: result.rows.map((row) => ({
      pageLabel: String(row.label),
      platform: String(row.platform),
      conversationRef: row.conversation_ref == null ? null : String(row.conversation_ref),
      messageRef: String(row.message_ref),
      occurredAt: date(row.occurred_at),
      senderRole: String(row.sender_role ?? "unknown"),
      isSentByMe: row.is_sent_by_me === true,
      rank: Math.max(0, Number(row.rank ?? 0)),
      snippet: row.snippet == null ? null : String(row.snippet),
    })),
    witnesses: witnessesFor(["message_archive"]),
  };
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
  /** Oldest row INSIDE the requested window; diagnostic only, never a floor. */
  observedRowFloor: Date | null;
  /** Oldest row at all: this scope's capture floor. */
  archiveFloor: Date | null;
  sortValue: string;
  keysetKey: string;
}

/** One row per (page, conversation) in scope: coverage is quantified per scope,
 *  because one thread's floor says nothing about another's. */
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
    after?: KeysetBoundary | undefined;
  },
): Promise<{ rows: AgentCoverageScopeRow[]; witnesses: PlaneReadWitness[] }> {
  if (input.pageIds.length === 0) {
    return { rows: [], witnesses: [] };
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

  const result = await db.execute<Record<string, unknown>>(sql`
    with keyed as (
      select t.platform_account_id, p.label, p.platform::text as platform,
             t.platform_conversation_id,
             coalesce(f.platform_user_id, t.partner_platform_user_id) as fan_platform_user_id,
             t.last_message_sync_at, h.quarantine_until, t.stored_message_count,
             floor.observed_row_floor, floor.archive_floor,
             ${renderText(sql`p.label`)} as k_sort,
             t.platform_conversation_id as k_key
      from page_dm_threads t
      join pages p on p.id = t.platform_account_id
      left join page_dm_message_sync_health h on h.conversation_id = t.id
      left join fans f on f.id = t.fan_id
      left join lateral (
        select min(ma.occurred_at) filter (
                 where ma.occurred_at >= ${input.from} and ma.occurred_at < ${input.to}
               ) as observed_row_floor,
               min(ma.occurred_at) as archive_floor
        from message_archive ma
        where ma.account_id = t.platform_account_id
          and ma.conversation_ref = t.platform_conversation_id
      ) floor on true
      where ${sql.join(clauses, sql` and `)}
    )
    select * from keyed
    where ${keysetPredicate("asc", input.after)}
    ${keysetOrderBy("asc")}
    limit ${input.limit}
  `);

  return {
    rows: result.rows.map((row) => ({
      pageId: Number(row.platform_account_id),
      pageLabel: String(row.label),
      platform: String(row.platform),
      conversationRef: String(row.platform_conversation_id),
      fanPlatformUserId: row.fan_platform_user_id == null
        ? null
        : String(row.fan_platform_user_id),
      lastMessageSyncAt: date(row.last_message_sync_at),
      quarantineUntil: date(row.quarantine_until),
      storedMessageCount: Number(row.stored_message_count ?? 0),
      observedRowFloor: date(row.observed_row_floor),
      archiveFloor: date(row.archive_floor),
      sortValue: String(row.k_sort),
      keysetKey: String(row.k_key),
    })),
    witnesses: witnessesFor(["page_dm_threads", "message_archive"]),
  };
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
  sortValue: string;
  keysetKey: string;
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
    sortDir: KeysetDirection;
    limit: number;
    after?: KeysetBoundary | undefined;
    maxObservationId?: number | undefined;
  },
): Promise<{ rows: AgentObservationRow[]; witnesses: PlaneReadWitness[] }> {
  if (input.pageIds.length === 0) {
    return { rows: [], witnesses: [] };
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
  if (input.maxObservationId !== undefined) {
    clauses.push(sql`o.id <= ${input.maxObservationId}`);
  }

  const result = await db.execute<Record<string, unknown>>(sql`
    with keyed as (
      select o.id::text as id, o.received_at, o.observed_at, o.source, o.producer,
             o.platform, p.label, o.native_account_ref, o.kind,
             octet_length(o.payload::text) as payload_bytes,
             encode(o.payload_hash, 'hex') as payload_sha256,
             o.parse_version,
             ${renderInstant(sql`o.received_at`)} as k_sort,
             ${renderNumeric(sql`o.id`)} as k_key
      from observations o
      left join pages p on p.id = o.account_id
      where ${sql.join(clauses, sql` and `)}
    )
    select * from keyed
    where ${keysetPredicate(input.sortDir, input.after)}
    ${keysetOrderBy(input.sortDir)}
    limit ${input.limit}
  `);

  return {
    rows: result.rows.map((row) => ({
      observationRef: Number(row.id),
      receivedAt: new Date(row.received_at as string | Date),
      observedAt: date(row.observed_at),
      source: String(row.source),
      producer: String(row.producer),
      platform: row.platform == null ? null : String(row.platform),
      pageLabel: row.label == null ? null : String(row.label),
      nativeAccountRef: row.native_account_ref == null ? null : String(row.native_account_ref),
      kind: String(row.kind),
      payloadBytes: Number(row.payload_bytes ?? 0),
      payloadSha256: String(row.payload_sha256 ?? ""),
      parseVersion: Number(row.parse_version ?? 0),
      sortValue: String(row.k_sort),
      keysetKey: String(row.k_key),
    })),
    witnesses: witnessesFor(["observations"]),
  };
}

export async function readAgentObservationsHighWater(
  db: Database,
  pageIds: readonly number[],
  window: { from: Date; to: Date },
): Promise<number> {
  if (pageIds.length === 0) {
    return 0;
  }
  const result = await db.execute<{ max_id: string | null }>(sql`
    select max(o.id)::text as max_id
    from observations o
    where o.account_id in ${pageIdList(pageIds)}
      and o.received_at >= ${window.from} and o.received_at < ${window.to}
  `);
  return Number(result.rows[0]?.max_id ?? 0);
}

export interface AgentObservationPayloadRow {
  observationRef: number;
  receivedAt: Date;
  source: string;
  kind: string;
  payloadSha256: string;
  payload: unknown;
}

/** #9b: one row by ref, WITH its body. Owner-session only — the caller decides
 *  whether the kind may be served at all, and the scrub runs before the wire. */
export async function findAgentObservationPayload(
  db: Database,
  observationRef: number,
): Promise<AgentObservationPayloadRow | null> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select o.id::text as id, o.received_at, o.source, o.kind,
           encode(o.payload_hash, 'hex') as payload_sha256, o.payload
    from observations o
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
    source: String(row.source),
    kind: String(row.kind),
    payloadSha256: String(row.payload_sha256 ?? ""),
    payload: row.payload ?? null,
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
  sortValue: string | null;
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
      return sql`${column}::text in ${textList(values.map((value) => String(value)))}`;
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

/** Renders a dataset column into the order-isomorphic text the keyset compares. */
function datasetSortExpression(column: string, kind: string): SQL {
  const expression = sql.raw(`src.${column}`);
  switch (kind) {
    case "timestamp":
      return renderInstant(expression);
    // A `date` field is projected as `YYYY-MM-DD` TEXT by the mapping, which is
    // already fixed-width and therefore already order-isomorphic; running it
    // through the instant renderer would ask `to_char` for a timezone on a string.
    case "date":
      return renderText(expression);
    case "int":
    case "mills":
      return renderNumeric(expression);
    default:
      return renderText(expression);
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
    /** Resolved sort column + its registry kind, already allowlist-checked. */
    sort: { column: string; kind: string; dir: KeysetDirection } | null;
    limit: number;
    after?: KeysetBoundary | undefined;
  },
): Promise<{ rows: AgentDatasetRowRaw[]; witnesses: PlaneReadWitness[] }> {
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

  const direction: KeysetDirection = input.sort?.dir ?? "desc";
  const sortExpression = input.sort === null
    ? renderInstant(windowColumn)
    : datasetSortExpression(input.sort.column, input.sort.kind);

  const projection = sql.join(
    Object.entries(mapping.fields).map(([wire, column]) =>
      sql`${sql.raw(`src.${column}`)} as ${sql.raw(`"${wire}"`)}`),
    sql`, `,
  );

  const result = await db.execute<Record<string, unknown>>(sql`
    with src as (${source}),
    keyed as (
      select src.k_key, src.k_occurred_at, src.k_fan, src.k_platform, ${projection},
             ${sortExpression} as k_sort
      from src
      where ${sql.join(clauses, sql` and `)}
    )
    select * from keyed
    where ${keysetPredicate(direction, input.after)}
    ${keysetOrderBy(direction)}
    limit ${input.limit}
  `);

  const wireFields = Object.keys(mapping.fields);
  return {
    rows: result.rows.map((row) => {
      const fields: Record<string, unknown> = {};
      for (const wire of wireFields) {
        fields[wire] = row[wire] ?? null;
      }
      return {
        key: String(row.k_key),
        occurredAt: date(row.k_occurred_at),
        fanPlatformUserId: row.k_fan == null ? null : String(row.k_fan),
        platform: row.k_platform == null ? null : String(row.k_platform),
        fields,
        sortValue: row.k_sort == null ? null : String(row.k_sort),
      };
    }),
    witnesses: witnessesFor(mapping.readPlanes),
  };
}
