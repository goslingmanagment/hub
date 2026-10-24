import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import type { FanFactKind } from "./fan-card.ts";

// The facts lane of Chat Memory (0310, docs/plans/2026-10-24-chat-memory/week-2.md
// §3): which conversations are due, the run row written before the provider
// call with its reserved cost, the conversation's messages and facts it reads,
// and what it records. The lane itself is apps/runtime services/fan-facts.

export interface DueFanFactConversation {
  pageId: number;
  pageLabel: string;
  platform: string;
  conversationRef: string;
  fanId: number;
  fanRef: string;
  /** The newest message of the last run: the next run reads after it; null — never run. */
  watermark: Date | null;
}

/**
 * Conversations of the given pages that went quiet (no message for
 * `quietMinutes`) within the last `activeHours`, where the fan wrote after the
 * last run, and whose fan Hub knows — the most recently quiet first. A run in
 * any state is a watermark: a window once sent is never sent again.
 */
export async function listDueFanFactConversations(
  db: Database,
  input: { pageIds: readonly number[]; now: Date; quietMinutes: number; activeHours: number; limit: number },
): Promise<DueFanFactConversation[]> {
  if (input.pageIds.length === 0 || input.limit <= 0) return [];
  const now = input.now.toISOString();
  const result = await db.execute<{
    page_id: string | number; page_label: string; platform: string; conversation_ref: string;
    fan_id: string | number; fan_ref: string; watermark: Date | string | null;
  }>(sql`
    with recent as (
      select m.account_id as page_id, m.conversation_ref,
        max(m.occurred_at) as last_at,
        max(m.occurred_at) filter (where not m.is_sent_by_me) as last_fan_at
      from message_archive m
      where m.account_id = any(${sql.param(input.pageIds.map(String))}::bigint[])
        and m.occurred_at > ${now}::timestamptz - make_interval(hours => ${input.activeHours})
        and m.conversation_ref is not null and m.deleted_at is null
        and coalesce(m.message_type, 1) <> 2
      group by 1, 2
    ),
    marks as (
      select r.page_id, r.conversation_ref, max(r.through_message_at) as watermark
      from fan_fact_runs r
      where r.page_id = any(${sql.param(input.pageIds.map(String))}::bigint[])
      group by 1, 2
    ),
    due as (
      select r.*, k.watermark
      from recent r
      left join marks k on k.page_id = r.page_id and k.conversation_ref = r.conversation_ref
      where r.last_at < ${now}::timestamptz - make_interval(mins => ${input.quietMinutes})
        and r.last_fan_at is not null
        -- A watermark is a JS time (milliseconds); the archive keeps microseconds.
        and (k.watermark is null or date_trunc('milliseconds', r.last_fan_at) > k.watermark)
    )
    select d.page_id, p.label as page_label, p.platform, d.conversation_ref, f.id as fan_id, f.platform_user_id as fan_ref, d.watermark
    from due d
    join pages p on p.id = d.page_id
    join lateral (
      select coalesce(
        (select t.fan_id from page_dm_threads t
          where t.platform_account_id = d.page_id and t.platform_conversation_id = d.conversation_ref and t.fan_id is not null
          limit 1),
        (select ff.id from fans ff where p.platform = 'onlyfans' and ff.platform = p.platform and ff.platform_user_id = d.conversation_ref)
      ) as id
    ) x on x.id is not null
    join fans f on f.id = x.id
    order by d.last_at desc
    limit ${input.limit}`);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    pageLabel: row.page_label,
    platform: row.platform,
    conversationRef: row.conversation_ref,
    fanId: Number(row.fan_id),
    fanRef: row.fan_ref,
    watermark: row.watermark === null ? null : new Date(row.watermark),
  }));
}

export interface FanFactMessage {
  messageRef: string;
  at: Date;
  fromFan: boolean;
  text: string;
  withMedia: boolean;
  priceMills: number | null;
  tipMills: number;
}

/**
 * The messages a run reads, oldest first: after the watermark at most
 * `maxNew`, plus up to `contextBefore` older ones for context; with no
 * watermark the last `maxNew`. No mass messages, no deleted ones.
 */
export async function loadFanFactMessages(
  db: Database,
  input: { pageId: number; conversationRef: string; watermark: Date | null; maxNew: number; contextBefore: number },
): Promise<FanFactMessage[]> {
  type Row = {
    message_ref: string; occurred_at: Date | string; is_sent_by_me: boolean; text_plain: string;
    media: number; price_mills: string | number | null; tip_amount_mills: string | number;
  };
  const columns = sql`message_ref, occurred_at, is_sent_by_me, text_plain, jsonb_array_length(media_metadata) as media, price_mills, tip_amount_mills`;
  const base = sql`account_id = ${input.pageId} and conversation_ref = ${input.conversationRef}
    and deleted_at is null and coalesce(message_type, 1) <> 2 and occurred_at is not null`;
  const fresh = await db.execute<Row>(input.watermark === null
    ? sql`select ${columns} from message_archive where ${base} order by occurred_at desc, id desc limit ${input.maxNew}`
    : sql`select ${columns} from message_archive
        where ${base} and date_trunc('milliseconds', occurred_at) > ${input.watermark.toISOString()}::timestamptz
        order by occurred_at asc, id asc limit ${input.maxNew}`);
  const context = input.watermark === null || input.contextBefore <= 0 ? { rows: [] as Row[] } : await db.execute<Row>(sql`
    select ${columns} from message_archive
    where ${base} and date_trunc('milliseconds', occurred_at) <= ${input.watermark.toISOString()}::timestamptz
    order by occurred_at desc, id desc limit ${input.contextBefore}`);
  return [...context.rows, ...fresh.rows]
    .map((row) => ({
      messageRef: row.message_ref,
      at: new Date(row.occurred_at),
      fromFan: !row.is_sent_by_me,
      text: row.text_plain,
      withMedia: Number(row.media) > 0,
      priceMills: row.price_mills === null ? null : Number(row.price_mills),
      tipMills: Number(row.tip_amount_mills),
    }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

export interface ConversationFact {
  id: number;
  kind: FanFactKind;
  text: string;
  source: "ai" | "chatter";
}

/** The conversation's active facts, oldest first. */
export async function listConversationFacts(db: Database, input: { pageId: number; conversationRef: string }): Promise<ConversationFact[]> {
  const result = await db.execute<{ id: string | number; kind: FanFactKind; text: string; source: "ai" | "chatter" }>(sql`
    select id, kind, text, source from fan_facts
    where page_id = ${input.pageId} and conversation_ref = ${input.conversationRef} and state = 'active'
    order by id`);
  return result.rows.map((row) => ({ id: Number(row.id), kind: row.kind, text: row.text, source: row.source }));
}

/**
 * Writes the run row with its reserved cost, BEFORE the call, when the day's
 * spend (finished runs at their cost, unfinished ones at their reservation)
 * leaves room under `dailyCapMicroUsd`. Serialized by an advisory lock so two
 * workers cannot both take the last room. Null — the cap is reached.
 */
export async function reserveFanFactRun(
  db: Database,
  input: {
    pageId: number; conversationRef: string; fanId: number; model: string; promptVersion: number;
    throughMessageAt: Date; messagesRead: number; reserveMicroUsd: number; dailyCapMicroUsd: number; now: Date;
  },
): Promise<number | null> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('fan-facts-budget'))`);
    const spent = await tx.execute<{ spent: string | number }>(sql`
      select coalesce(sum(coalesce(cost_micro_usd, reserved_micro_usd)), 0) as spent
      from fan_fact_runs
      where started_at >= date_trunc('day', ${input.now.toISOString()}::timestamptz at time zone 'UTC') at time zone 'UTC'`);
    if (Number(spent.rows[0]!.spent) + input.reserveMicroUsd > input.dailyCapMicroUsd) return null;
    const inserted = await tx.execute<{ id: string | number }>(sql`
      insert into fan_fact_runs (page_id, conversation_ref, fan_id, model, prompt_version, through_message_at,
        messages_read, reserved_micro_usd, started_at)
      values (${input.pageId}, ${input.conversationRef}, ${input.fanId}, ${input.model}, ${input.promptVersion},
        ${input.throughMessageAt.toISOString()}::timestamptz, ${input.messagesRead}, ${input.reserveMicroUsd}, ${input.now.toISOString()}::timestamptz)
      returning id`);
    return Number(inserted.rows[0]!.id);
  });
}

/** Marks the run as possibly sent: a crash from here leaves it `outcome_unknown`, never retried. */
export async function markFanFactRunInFlight(db: Database, runId: number): Promise<void> {
  await db.execute(sql`update fan_fact_runs set state = 'outcome_unknown' where id = ${runId} and state = 'running'`);
}

export interface FanFactRunResult {
  add: ReadonlyArray<{ kind: FanFactKind; text: string; messageRef: string; messageAt: Date }>;
  /** Ids of AI facts of this conversation the run closes, with why. */
  close: ReadonlyArray<{ id: number; why: string }>;
}

/** Records a finished run: its facts, the facts it closes (only active AI facts of its conversation), its cost. */
export async function finishFanFactRun(
  db: Database,
  input: {
    runId: number; pageId: number; platform: string; conversationRef: string; fanId: number;
    state: "done" | "failed"; costMicroUsd: number; errorCode: string | null; result: FanFactRunResult | null;
  },
): Promise<{ added: number; closed: number }> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    let added = 0;
    let closed = 0;
    if (input.result !== null) {
      for (const fact of input.result.add) {
        await tx.execute(sql`
          insert into fan_facts (fan_id, page_id, platform, conversation_ref, kind, text, message_ref, message_at, source, run_id)
          values (${input.fanId}, ${input.pageId}, ${input.platform}, ${input.conversationRef}, ${fact.kind}, ${fact.text},
            ${fact.messageRef}, ${fact.messageAt.toISOString()}::timestamptz, 'ai', ${input.runId})`);
        added += 1;
      }
      for (const close of input.result.close) {
        const updated = await tx.execute(sql`
          update fan_facts set state = 'closed', changed_at = now(), change_note = ${close.why.slice(0, 300)}
          where id = ${close.id} and page_id = ${input.pageId} and conversation_ref = ${input.conversationRef}
            and state = 'active' and source = 'ai'`);
        closed += updated.rowCount ?? 0;
      }
    }
    await tx.execute(sql`
      update fan_fact_runs
      set state = ${input.state}, cost_micro_usd = ${input.costMicroUsd}, error_code = ${input.errorCode},
        facts_added = ${added}, facts_closed = ${closed}, finished_at = now()
      where id = ${input.runId}`);
    return { added, closed };
  });
}
