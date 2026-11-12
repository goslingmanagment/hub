import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Agents as participants (ecosystem plan §3.3, package M1): whose each agent
// key is, its last call, «who is this key» for other services, and the reads
// the agents' scripts did over `ssh … psql` (the fan watch, the report check),
// plus the two facts «Разбор смены» lacked for the shift audit (new followers,
// the chatter's AI by feature). Read-only, raw SQL: the people tables are
// defined by their migrations alone.

type Row = Record<string, unknown>;

function ids(values: readonly number[]) {
  return sql`${sql.param(values.map(String))}::bigint[]`;
}
function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : new Date(value as string | Date);
}

// ── keys ────────────────────────────────────────────────────────────────────

export interface AgentKeyPersonRow {
  agentKeyId: number;
  personId: number;
  code: string;
  displayName: string;
  state: "invited" | "set_up" | "working" | "left";
}

/** The agent person of every key that has one, by the key's id. */
export async function listAgentKeyPeople(db: Database): Promise<Map<number, AgentKeyPersonRow>> {
  const result = await db.execute<Row>(sql`
    select k.agent_key_id, p.id as person_id, p.code, p.display_name, p.state
      from person_agent_keys k join people p on p.id = k.person_id`);
  return new Map(result.rows.map((row) => [Number(row.agent_key_id), {
    agentKeyId: Number(row.agent_key_id),
    personId: Number(row.person_id),
    code: String(row.code),
    displayName: String(row.display_name),
    state: row.state as AgentKeyPersonRow["state"],
  }]));
}

/** The agent person of one key; null — none. */
export async function findAgentKeyPerson(db: Database, agentKeyId: number): Promise<AgentKeyPersonRow | null> {
  const result = await db.execute<Row>(sql`
    select k.agent_key_id, p.id as person_id, p.code, p.display_name, p.state
      from person_agent_keys k join people p on p.id = k.person_id
     where k.agent_key_id = ${agentKeyId}`);
  const row = result.rows[0];
  return row === undefined ? null : {
    agentKeyId: Number(row.agent_key_id),
    personId: Number(row.person_id),
    code: String(row.code),
    displayName: String(row.display_name),
    state: row.state as AgentKeyPersonRow["state"],
  };
}

/** Each key's newest audited call (agent_read_audit_key_last_idx: one index probe per key). */
export async function listAgentKeyLastCalls(
  db: Database,
  agentKeyIds: readonly number[],
): Promise<Map<number, { at: Date; operation: string }>> {
  if (agentKeyIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select k.id as agent_key_id, last.operation, last.occurred_at
      from unnest(${ids(agentKeyIds)}) as k(id)
      cross join lateral (
        select a.operation, a.occurred_at from agent_read_audit a
         where a.agent_key_id = k.id
         order by a.id desc
         limit 1
      ) last`);
  return new Map(result.rows.map((row) => [Number(row.agent_key_id), {
    at: new Date(row.occurred_at as string | Date),
    operation: String(row.operation),
  }]));
}

export interface AgentKeyIntrospectionRow {
  agentKeyId: number;
  expiresAt: Date;
  revokedAt: Date | null;
  /** Null — no agent holds the key. */
  person: { code: string; displayName: string; kind: string; state: string } | null;
}

/** A key by its digest with its agent person, for `agentKeyIntrospect`. Never returns the digest or the prefix. */
export async function findAgentKeyIntrospection(db: Database, keyDigest: string): Promise<AgentKeyIntrospectionRow | null> {
  const result = await db.execute<Row>(sql`
    select a.id, a.expires_at, a.revoked_at, p.code, p.display_name, p.kind, p.state
      from agent_keys a
      left join person_agent_keys k on k.agent_key_id = a.id
      left join people p on p.id = k.person_id
     where a.key_digest = ${keyDigest}
     limit 1`);
  const row = result.rows[0];
  if (!row) return null;
  return {
    agentKeyId: Number(row.id),
    expiresAt: new Date(row.expires_at as string | Date),
    revokedAt: nullableDate(row.revoked_at),
    person: row.code === null || row.code === undefined ? null : {
      code: String(row.code), displayName: String(row.display_name), kind: String(row.kind), state: String(row.state),
    },
  };
}

/** The logins of a person, by the person's code (empty — no such person, or none of theirs). */
export async function listLoginIdsOfPerson(db: Database, code: string): Promise<number[]> {
  const result = await db.execute<Row>(sql`
    select l.user_id from person_logins l join people p on p.id = l.person_id where p.code = ${code} order by l.user_id`);
  return result.rows.map((row) => Number(row.user_id));
}

// ── «Разбор смены»: what the shift audit read and the review lacked ─────────

export interface ShiftFollowRow {
  pageId: number;
  fanId: number;
  fanRef: string | null;
  username: string | null;
  /** The fan's chat on the page, when Hub knows one. */
  conv: string | null;
  at: Date;
  /** Fansly: a follow; OnlyFans: the fan's first subscription to the page. */
  kind: "follow" | "subscription";
}

/**
 * The new followers of the pages in [from, to): on Fansly a follow, on
 * OnlyFans a fan's FIRST subscription to the page (the shift audit's rule),
 * with the fan's chat. Oldest first.
 */
export async function listShiftFollows(
  db: Database,
  input: { pageIds: readonly number[]; from: Date; to: Date },
): Promise<ShiftFollowRow[]> {
  if (input.pageIds.length === 0) return [];
  const from = sql`${input.from.toISOString()}::timestamptz`;
  const to = sql`${input.to.toISOString()}::timestamptz`;
  const result = await db.execute<Row>(sql`
    with follows as (
      select pf.platform_account_id as page_id, pf.fan_id, pf.followed_at as at, 'follow' as kind
        from page_follows pf join pages p on p.id = pf.platform_account_id and p.platform = 'fansly'
       where pf.platform_account_id = any(${ids(input.pageIds)}) and pf.followed_at >= ${from} and pf.followed_at < ${to}
      union all
      select ps.platform_account_id, ps.fan_id, ps.source_created_at, 'subscription'
        from page_subscriptions ps join pages p on p.id = ps.platform_account_id and p.platform = 'onlyfans'
       where ps.platform_account_id = any(${ids(input.pageIds)}) and ps.source_created_at >= ${from} and ps.source_created_at < ${to}
         and not exists (select 1 from page_subscriptions q where q.platform_account_id = ps.platform_account_id
           and q.fan_id = ps.fan_id and q.source_created_at < ps.source_created_at)
    )
    select f.page_id, f.fan_id, fa.platform_user_id as fan_ref, fa.username, f.at, f.kind,
      (select th.platform_conversation_id from page_dm_threads th
        where th.platform_account_id = f.page_id and (th.fan_id = f.fan_id or th.partner_platform_user_id = fa.platform_user_id)
        order by (th.fan_id = f.fan_id) desc, th.last_message_at desc nulls last limit 1) as conv
      from follows f join fans fa on fa.id = f.fan_id
     order by f.at, f.page_id, f.fan_id`);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    fanId: Number(row.fan_id),
    fanRef: row.fan_ref === null ? null : String(row.fan_ref),
    username: row.username === null ? null : String(row.username),
    conv: row.conv === null ? null : String(row.conv),
    at: new Date(row.at as string | Date),
    kind: row.kind === "subscription" ? "subscription" : "follow",
  }));
}

/** The person's AI events on the pages in [from, to), by page and feature (`ai_usage_events`, the shift audit's «ИИ»). */
export async function listShiftAiUse(
  db: Database,
  input: { userId: number; pageIds: readonly number[]; from: Date; to: Date },
): Promise<Array<{ pageId: number; feature: string; count: number }>> {
  if (input.pageIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select e.page_id, e.feature::text as feature, count(*)::int as n
      from ai_usage_events e
     where e.user_id = ${input.userId} and e.page_id = any(${ids(input.pageIds)})
       and e.completed_at >= ${input.from.toISOString()}::timestamptz and e.completed_at < ${input.to.toISOString()}::timestamptz
     group by 1, 2
     order by 1, 2`);
  return result.rows.map((row) => ({ pageId: Number(row.page_id), feature: String(row.feature), count: Number(row.n) }));
}

// ── the fan watch ───────────────────────────────────────────────────────────

export interface FanWatchRow {
  /** The fan's chats on the page matched by the username (0 — none: the watch is wrong). */
  chats: number;
  /** The fan's messages after `since` that reached the archive after `archivedAfter`, oldest first. */
  messages: Array<{ ref: string; at: Date; archivedAt: Date; text: string; media: boolean; tipMills: number | null }>;
  /** The page's newest message in those chats, any time; null — none. */
  pageLastAt: Date | null;
}

/**
 * What the fan watch read over psql (work/watch-fan/watch.py): the chats of a
 * page whose partner is `username` (case does not matter), the fan's messages
 * there since `since` that the archive took after `archivedAfter`, and when the
 * page last wrote there. Deleted messages are left out.
 */
export async function readFanWatch(
  db: Database,
  input: { pageId: number; username: string; since: Date; archivedAfter: Date; limit: number },
): Promise<FanWatchRow> {
  const result = await db.execute<Row>(sql`
    with th as (
      select platform_account_id, platform_conversation_id from page_dm_threads
       where platform_account_id = ${input.pageId} and lower(partner_username) = lower(${input.username})
    ),
    fan as (
      select ma.message_ref, ma.occurred_at, ma.archived_at, left(coalesce(ma.text_plain, ''), 2000) as text,
        coalesce(jsonb_typeof(ma.media_metadata) = 'array' and jsonb_array_length(ma.media_metadata) > 0, false) as media,
        case when ma.is_tip and ma.tip_amount_mills > 0 then ma.tip_amount_mills end as tip_mills
        from message_archive ma join th on th.platform_account_id = ma.account_id and th.platform_conversation_id = ma.conversation_ref
       where ma.account_id = ${input.pageId} and ma.sender_role = 'fan' and ma.deleted_at is null
         and ma.archived_at > ${input.archivedAfter.toISOString()}::timestamptz
         and ma.occurred_at > ${input.since.toISOString()}::timestamptz
       order by ma.occurred_at, ma.id
       limit ${input.limit}
    )
    select (select count(*)::int from th) as chats,
      coalesce((select json_agg(json_build_object('ref', message_ref, 'at', occurred_at, 'archived', archived_at, 'text', text,
        'media', media, 'tip', tip_mills) order by occurred_at) from fan), '[]'::json) as messages,
      (select max(ma.occurred_at) from message_archive ma join th
          on th.platform_account_id = ma.account_id and th.platform_conversation_id = ma.conversation_ref
        where ma.account_id = ${input.pageId} and ma.sender_role <> 'fan' and ma.deleted_at is null) as page_last_at`);
  const row = result.rows[0] ?? {};
  const messages = (row.messages as Array<{ ref: string; at: string; archived: string; text: string; media: boolean; tip: number | string | null }>) ?? [];
  return {
    chats: Number(row.chats ?? 0),
    messages: messages.map((message) => ({
      ref: String(message.ref),
      at: new Date(message.at),
      archivedAt: new Date(message.archived),
      text: message.text,
      media: message.media === true,
      tipMills: message.tip === null ? null : Number(message.tip),
    })),
    pageLastAt: nullableDate(row.page_last_at),
  };
}

// ── the report check ────────────────────────────────────────────────────────

/** Hub's transaction ids of platform transaction refs on a page (unknown refs are left out). */
export async function findTransactionIdsByPlatformRef(
  db: Database,
  refs: ReadonlyArray<{ pageId: number; transactionRef: string }>,
): Promise<Map<string, number>> {
  if (refs.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select r.page_id, r.ref, t.id
      from unnest(${ids(refs.map((one) => one.pageId))}, ${sql.param(refs.map((one) => one.transactionRef))}::text[]) as r(page_id, ref)
      join transactions t on t.platform_account_id = r.page_id and t.transaction_id = r.ref`);
  return new Map(result.rows.map((row) => [`${Number(row.page_id)}:${String(row.ref)}`, Number(row.id)]));
}

export interface SaleContextRow {
  transactionId: number;
  pageId: number;
  platformTransactionRef: string;
  kind: string;
  occurredAt: Date;
  grossMills: number;
  netMills: number;
  fanRef: string | null;
  /** The fan's name in the page's chat, else Hub's fan record. */
  fanUsername: string | null;
  /** Everyone who wrote to the fan on the page in the 7 days before the sale, most messages first (with an author). */
  writers7d: Array<{ userId: number; username: string; messages: number }>;
  /** Who last wrote to the fan on the page in the 60 days before it, and when. */
  lastWriter60d: { userId: number; username: string; at: Date } | null;
}

/**
 * What the report check read over psql (skills/shift-sales-report/report_check.py,
 * `enrich`, `fan_names`) for each sale: the fan's name, who wrote to the fan in
 * the 7 days before, and who last wrote in the 60 days before. Authors are
 * `client_send_attributions`; the bought PPV is `listSaleFacts`'s, its text
 * `listPageMessageTexts`.
 */
export async function listSaleContext(
  db: Database,
  input: { transactionIds: readonly number[] },
): Promise<SaleContextRow[]> {
  if (input.transactionIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    with sales as (
      select t.id, t.platform_account_id as page_id, p.platform, t.transaction_id as ref, t.canonical_type::text as kind, t.occurred_at,
        t.gross_amount_mills as gross, t.creator_net_amount_mills as net, f.platform_user_id as fan_ref, f.username as fan_username, t.fan_id
        from transactions t
        join pages p on p.id = t.platform_account_id
        left join fans f on f.id = t.fan_id
       where t.id = any(${ids(input.transactionIds)})
    )
    select s.id, s.page_id, s.ref, s.kind, s.occurred_at, s.gross, s.net, s.fan_ref,
      coalesce((select th.partner_username from page_dm_threads th
        where th.platform_account_id = s.page_id and (th.fan_id = s.fan_id or th.partner_platform_user_id = s.fan_ref)
          and th.partner_username is not null
        order by th.last_message_at desc nulls last limit 1), s.fan_username) as fan_name,
      (select json_agg(json_build_object('user_id', w.user_id, 'username', w.username, 'messages', w.messages) order by w.messages desc, w.username)
        from (
          select x.user_id, u.username, count(*)::int as messages
            from client_send_attributions x join users u on u.id = x.user_id
           where x.page_id = s.page_id and x.fan_ref = s.fan_ref
             and x.observed_at > s.occurred_at - interval '7 days' and x.observed_at <= s.occurred_at
           group by 1, 2) w) as writers,
      (select json_build_object('user_id', x.user_id, 'username', u.username, 'at', x.observed_at)
         from client_send_attributions x join users u on u.id = x.user_id
        where x.page_id = s.page_id and x.fan_ref = s.fan_ref
          and x.observed_at > s.occurred_at - interval '60 days' and x.observed_at <= s.occurred_at
        order by x.observed_at desc limit 1) as last_writer
      from sales s
     order by s.occurred_at, s.id`);
  return result.rows.map((row) => {
    const writers = (row.writers as Array<{ user_id: number | string; username: string; messages: number }> | null) ?? [];
    const last = row.last_writer as { user_id: number | string; username: string; at: string } | null;
    return {
      transactionId: Number(row.id),
      pageId: Number(row.page_id),
      platformTransactionRef: String(row.ref),
      kind: String(row.kind),
      occurredAt: new Date(row.occurred_at as string | Date),
      grossMills: Number(row.gross ?? 0),
      netMills: Number(row.net ?? 0),
      fanRef: row.fan_ref === null ? null : String(row.fan_ref),
      fanUsername: row.fan_name === null ? null : String(row.fan_name),
      writers7d: writers.map((writer) => ({ userId: Number(writer.user_id), username: writer.username, messages: Number(writer.messages) })),
      lastWriter60d: last === null ? null : { userId: Number(last.user_id), username: last.username, at: new Date(last.at) },
    };
  });
}

/** The archive's text of page messages by their platform ids (at most 2,000 characters each), by `<pageId>:<ref>`. */
export async function listPageMessageTexts(
  db: Database,
  messages: ReadonlyArray<{ pageId: number; ref: string }>,
): Promise<Map<string, string>> {
  if (messages.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select x.page_id, x.ref, left(m.text_plain, 2000) as text
      from unnest(${ids(messages.map((one) => one.pageId))}, ${sql.param(messages.map((one) => one.ref))}::text[]) as x(page_id, ref)
      join message_archive m on m.account_id = x.page_id and m.message_ref = x.ref
     where m.text_plain is not null`);
  return new Map(result.rows.map((row) => [`${Number(row.page_id)}:${String(row.ref)}`, String(row.text)]));
}
