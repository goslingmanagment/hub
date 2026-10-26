import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { acquireErasureFenceSharedLock } from "./erasure-fence.ts";
import type { FanFactKind } from "./fan-card.ts";

// The facts lane of Chat Memory (0313, docs/plans/2026-10-24-chat-memory/week-2.md
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

/** After a run the provider refused (an HTTP answer: nothing ran) or that had no proxy, its conversation waits this long. */
export const FAN_FACT_TRANSIENT_RETRY_MINUTES = 30;

/** A run that never reached the model: refused by the provider, or no proxy. Nothing ran, nothing was billed. */
const TRANSIENT_FAILURE = (run: string) => sql.raw(
  `(${run}.state = 'failed' and (${run}.error_code = 'proxy_missing' or ${run}.error_code ~ '^http_(408|409|429|5[0-9][0-9])$'))`,
);

/**
 * Conversations of the given pages that went quiet (no message for
 * `quietMinutes`) and where, within the last `activeHours`, the fan wrote
 * after the last run — or the model did while the conversation holds an open
 * promise (it may be kept now, however long the fan has been silent) — and
 * whose fan Hub knows, the most recently quiet first. A run is a watermark: a
 * window once sent is never sent again — except a run that never reached the
 * model, which only pauses its conversation for FAN_FACT_TRANSIENT_RETRY_MINUTES;
 * the retry reads its window again as new lines, even when the fan wrote since.
 * A conversation with an open rebuild waits for it.
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
        and r.rebuild_id is null and not ${TRANSIENT_FAILURE("r")}
      group by 1, 2
    ),
    due as (
      select r.*, k.watermark
      from recent r
      left join marks k on k.page_id = r.page_id and k.conversation_ref = r.conversation_ref
      where r.last_at < ${now}::timestamptz - make_interval(mins => ${input.quietMinutes})
        -- A watermark is a JS time (milliseconds); the archive keeps microseconds.
        and (
          (r.last_fan_at is not null and (k.watermark is null or date_trunc('milliseconds', r.last_fan_at) > k.watermark))
          or (
            (k.watermark is null or date_trunc('milliseconds', r.last_at) > k.watermark)
            and exists (
              select 1 from fan_facts ff
              where ff.page_id = r.page_id and ff.conversation_ref = r.conversation_ref
                and ff.state = 'active' and ff.kind = 'promise'
            )
          )
        )
        and not exists (
          select 1 from fan_fact_runs c
          where c.page_id = r.page_id and c.conversation_ref = r.conversation_ref and c.rebuild_id is null and ${TRANSIENT_FAILURE("c")}
            and c.started_at >= ${now}::timestamptz - make_interval(mins => ${FAN_FACT_TRANSIENT_RETRY_MINUTES})
        )
        -- A conversation being rebuilt is the rebuild's until it is done.
        and not exists (
          select 1 from fan_fact_rebuild_conversations b
          where b.page_id = r.page_id and b.conversation_ref = r.conversation_ref and b.state in ('pending', 'running')
        )
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
  /** Read by an earlier run: shown for context, never a fact's source again. */
  context: boolean;
  at: Date;
  fromFan: boolean;
  text: string;
  withMedia: boolean;
  priceMills: number | null;
  tipMills: number;
  /** The describer's notes of the fan's own media in this message (ai_media_descriptions, described only). */
  mediaNotes?: readonly string[];
}

/**
 * The messages a run reads, oldest first: after the watermark at most
 * `maxNew` (none past `until`, when given), plus up to `contextBefore` older
 * ones for context; with no watermark the last `maxNew`. No mass messages, no
 * deleted ones. A fan's media carries what the describer already wrote of it.
 */
export async function loadFanFactMessages(
  db: Database,
  input: { pageId: number; conversationRef: string; watermark: Date | null; maxNew: number; contextBefore: number; until?: Date },
): Promise<FanFactMessage[]> {
  type Row = {
    message_ref: string; occurred_at: Date | string; is_sent_by_me: boolean; text_plain: string;
    media: number; price_mills: string | number | null; tip_amount_mills: string | number; media_notes: string[] | null;
  };
  const columns = sql`message_ref, occurred_at, is_sent_by_me, text_plain, jsonb_array_length(media_metadata) as media, price_mills, tip_amount_mills,
    case when is_sent_by_me then null else (
      select array_agg(distinct d.description) from ai_media_description_links l
      join ai_media_descriptions d on d.id = l.description_id
      where l.page_id = message_archive.account_id and l.conversation_ref = message_archive.conversation_ref
        and l.message_ref = message_archive.message_ref and l.sender_role = 'fan'
        and d.status = 'described' and d.description is not null
    ) end as media_notes`;
  const base = sql`account_id = ${input.pageId} and conversation_ref = ${input.conversationRef}
    and deleted_at is null and coalesce(message_type, 1) <> 2 and occurred_at is not null`;
  const until = input.until === undefined
    ? sql``
    : sql` and date_trunc('milliseconds', occurred_at) <= ${input.until.toISOString()}::timestamptz`;
  const fresh = await db.execute<Row>(input.watermark === null
    ? sql`select ${columns} from message_archive where ${base}${until} order by occurred_at desc, id desc limit ${input.maxNew}`
    : sql`select ${columns} from message_archive
        where ${base}${until} and date_trunc('milliseconds', occurred_at) > ${input.watermark.toISOString()}::timestamptz
        order by occurred_at asc, id asc limit ${input.maxNew}`);
  const context = input.watermark === null || input.contextBefore <= 0 ? { rows: [] as Row[] } : await db.execute<Row>(sql`
    select ${columns} from message_archive
    where ${base} and date_trunc('milliseconds', occurred_at) <= ${input.watermark.toISOString()}::timestamptz
    order by occurred_at desc, id desc limit ${input.contextBefore}`);
  return [...context.rows.map((row) => ({ row, context: true })), ...fresh.rows.map((row) => ({ row, context: false }))]
    .map(({ row, context: read }) => ({
      messageRef: row.message_ref,
      context: read,
      at: new Date(row.occurred_at),
      fromFan: !row.is_sent_by_me,
      text: row.text_plain,
      withMedia: Number(row.media) > 0,
      priceMills: row.price_mills === null ? null : Number(row.price_mills),
      tipMills: Number(row.tip_amount_mills),
      mediaNotes: row.media_notes ?? [],
    }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

export interface ConversationFact {
  id: number;
  kind: FanFactKind;
  text: string;
  source: "ai" | "chatter";
}

export interface RemovedConversationFact {
  kind: FanFactKind;
  text: string;
  messageRef: string;
  /** deleted or corrected — a chatter's word against it; closed — the lane's own (done or no longer true). */
  state: "deleted" | "corrected" | "closed";
}

/** The conversation's facts a chatter deleted or corrected, or the lane closed: never recorded again. */
export async function listRemovedConversationFacts(
  db: Database,
  input: { pageId: number; conversationRef: string },
): Promise<RemovedConversationFact[]> {
  const result = await db.execute<{ kind: FanFactKind; text: string; message_ref: string; state: RemovedConversationFact["state"] }>(sql`
    select kind, text, message_ref, state from fan_facts
    where page_id = ${input.pageId} and conversation_ref = ${input.conversationRef} and state in ('deleted', 'corrected', 'closed')
    order by id`);
  return result.rows.map((row) => ({ kind: row.kind, text: row.text, messageRef: row.message_ref, state: row.state }));
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
 * Writes the run row with its reserved cost, BEFORE the call, when the spend
 * so far (finished runs at their cost, unfinished ones at their reservation)
 * leaves room: a live run under `dailyCapMicroUsd` of the UTC day's live runs,
 * a rebuild's run under the rebuild's whole budget. Serialized by an advisory
 * lock so two workers cannot both take the last room. Null — no room. The
 * first window of a rebuild's conversation supersedes its AI facts (open and
 * closed — kept, never shown or read again) with the reservation: no room, and
 * the old memory stays.
 */
export async function reserveFanFactRun(
  db: Database,
  input: {
    pageId: number; conversationRef: string; fanId: number; model: string; promptVersion: number;
    throughMessageAt: Date; messagesRead: number; reserveMicroUsd: number; dailyCapMicroUsd: number; now: Date;
    rebuild?: { id: number; supersede: boolean };
  },
): Promise<number | null> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('fan-facts-budget'))`);
    const rebuildId = input.rebuild?.id ?? null;
    const spent = await tx.execute<{ spent: string | number; cap: string | number }>(rebuildId === null
      ? sql`
        select coalesce(sum(coalesce(cost_micro_usd, reserved_micro_usd)), 0) as spent, ${input.dailyCapMicroUsd}::bigint as cap
        from fan_fact_runs
        where rebuild_id is null
          and started_at >= date_trunc('day', ${input.now.toISOString()}::timestamptz at time zone 'UTC') at time zone 'UTC'`
      : sql`
        select coalesce((select sum(coalesce(cost_micro_usd, reserved_micro_usd)) from fan_fact_runs where rebuild_id = ${rebuildId}), 0) as spent,
          b.budget_micro_usd as cap
        from fan_fact_rebuilds b where b.id = ${rebuildId}`);
    const row = spent.rows[0];
    if (row === undefined || Number(row.spent) + input.reserveMicroUsd > Number(row.cap)) return null;
    const inserted = await tx.execute<{ id: string | number }>(sql`
      insert into fan_fact_runs (page_id, conversation_ref, fan_id, model, prompt_version, through_message_at,
        messages_read, reserved_micro_usd, started_at, rebuild_id)
      values (${input.pageId}, ${input.conversationRef}, ${input.fanId}, ${input.model}, ${input.promptVersion},
        ${input.throughMessageAt.toISOString()}::timestamptz, ${input.messagesRead}, ${input.reserveMicroUsd}, ${input.now.toISOString()}::timestamptz,
        ${rebuildId})
      returning id`);
    if (input.rebuild?.supersede === true) {
      await tx.execute(sql`
        update fan_facts set state = 'superseded', changed_at = ${input.now.toISOString()}::timestamptz,
          change_note = ${`rebuild #${input.rebuild.id}`}
        where page_id = ${input.pageId} and conversation_ref = ${input.conversationRef}
          and source = 'ai' and state in ('active', 'closed')`);
    }
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
    /** Written in the same transaction, only while the run (and so the fan) is still there. */
    alsoWrite?: (tx: Database) => Promise<void>;
  },
): Promise<{ added: number; closed: number; recorded: boolean }> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    let added = 0;
    let closed = 0;
    // The erasure fence first: an erasure deletes the fan's call records and only later the fan, in one
    // transaction under its exclusive fence; a record committed in between would outlive both. Shared, we
    // either commit before the erasure starts (and it deletes what we wrote) or wait it out (and see its deletes).
    await acquireErasureFenceSharedLock(tx, input.pageId);
    // Then the run: a fan erased during the call took the run with him (cascade), and
    // then nothing of the call is written — not its facts, not its record (the lane checks `recorded`).
    const run = await tx.execute(sql`select 1 from fan_fact_runs where id = ${input.runId} for update`);
    if (run.rows.length === 0) return { added: 0, closed: 0, recorded: false };
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
    await input.alsoWrite?.(tx);
    return { added, closed, recorded: true };
  });
}

// ── rebuilds (0322) ─────────────────────────────────────────────────────────
// The owner asks to read conversations again from their first message with the
// current prompt; the lane walks them window by window within a total budget.

/** The conversation's messages the lane may read: no mass messages, no deleted ones. */
const READABLE = (alias: string) => sql.raw(
  `${alias}.deleted_at is null and coalesce(${alias}.message_type, 1) <> 2 and ${alias}.occurred_at is not null`,
);

export interface FanFactRebuildRequest {
  id: number;
  conversations: number;
  messages: number;
}

/**
 * Asks a rebuild of every conversation of the pages that a live run read and
 * no open rebuild holds, the longest history first. The conversations wait
 * (`pending`) until the lane takes them; the live lane leaves them alone
 * meanwhile.
 */
export async function createFanFactRebuild(
  db: Database,
  input: { pageIds: readonly number[]; promptVersion: number; budgetMicroUsd: number; note: string | null },
): Promise<FanFactRebuildRequest> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    // The live lane's budget lock also orders this against a rebuild starting elsewhere.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('fan-facts-budget'))`);
    const created = await tx.execute<{ id: string | number }>(sql`
      insert into fan_fact_rebuilds (prompt_version, budget_micro_usd, note)
      values (${input.promptVersion}, ${input.budgetMicroUsd}, ${input.note}) returning id`);
    const id = Number(created.rows[0]!.id);
    if (input.pageIds.length === 0) return { id, conversations: 0, messages: 0 };
    const inserted = await tx.execute<{ conversations: string | number; messages: string | number | null }>(sql`
      with conv as (
        select r.page_id, r.conversation_ref, (array_agg(r.fan_id order by r.id desc))[1] as fan_id
        from fan_fact_runs r
        where r.page_id = any(${sql.param(input.pageIds.map(String))}::bigint[])
          and r.rebuild_id is null and not ${TRANSIENT_FAILURE("r")}
        group by 1, 2
      ),
      sized as (
        select c.*, (
          select count(*) from message_archive m
          where m.account_id = c.page_id and m.conversation_ref = c.conversation_ref and ${READABLE("m")}
        ) as messages
        from conv c
        where not exists (
          select 1 from fan_fact_rebuild_conversations o
          where o.page_id = c.page_id and o.conversation_ref = c.conversation_ref and o.state in ('pending', 'running')
        )
      ),
      added as (
        insert into fan_fact_rebuild_conversations (rebuild_id, page_id, conversation_ref, fan_id, position)
        select ${id}, page_id, conversation_ref, fan_id, row_number() over (order by messages desc, page_id, conversation_ref)
        from sized
        returning page_id, conversation_ref
      )
      select count(*) as conversations, sum(s.messages) as messages
      from added a join sized s on s.page_id = a.page_id and s.conversation_ref = a.conversation_ref`);
    const row = inserted.rows[0]!;
    return { id, conversations: Number(row.conversations), messages: Number(row.messages ?? 0) };
  });
}

export interface FanFactRebuildStep {
  rebuildId: number;
  pageId: number;
  pageLabel: string;
  platform: string;
  conversationRef: string;
  fanId: number;
  fanRef: string;
  state: "pending" | "running";
  /** Where the live lane had read when the conversation's rebuild started: it reads up to here. Null while pending. */
  throughMessageAt: Date | null;
  /** The newest message the rebuild's runs read; null — none yet. */
  progress: Date | null;
}

/**
 * The open conversations of rebuilds, the running ones first, then the
 * pending in their order — not one whose last run never reached the model
 * within FAN_FACT_TRANSIENT_RETRY_MINUTES (it is read again after).
 */
export async function listFanFactRebuildSteps(
  db: Database,
  input: { now: Date; limit: number },
): Promise<FanFactRebuildStep[]> {
  if (input.limit <= 0) return [];
  const result = await db.execute<{
    rebuild_id: string | number; page_id: string | number; page_label: string; platform: string; conversation_ref: string;
    fan_id: string | number; fan_ref: string; state: "pending" | "running";
    through_message_at: Date | string | null; progress: Date | string | null;
  }>(sql`
    select b.rebuild_id, b.page_id, p.label as page_label, p.platform, b.conversation_ref, b.fan_id,
      f.platform_user_id as fan_ref, b.state, b.through_message_at,
      (select max(r.through_message_at) from fan_fact_runs r
        where r.rebuild_id = b.rebuild_id and r.page_id = b.page_id and r.conversation_ref = b.conversation_ref
          and not ${TRANSIENT_FAILURE("r")}) as progress
    from fan_fact_rebuild_conversations b
    join pages p on p.id = b.page_id
    join fans f on f.id = b.fan_id
    where b.state in ('pending', 'running')
      and not exists (
        select 1 from fan_fact_runs c
        where c.rebuild_id = b.rebuild_id and c.page_id = b.page_id and c.conversation_ref = b.conversation_ref
          and ${TRANSIENT_FAILURE("c")}
          and c.started_at >= ${input.now.toISOString()}::timestamptz - make_interval(mins => ${FAN_FACT_TRANSIENT_RETRY_MINUTES})
      )
    order by (b.state = 'running') desc, b.rebuild_id, b.position
    limit ${input.limit}`);
  return result.rows.map((row) => ({
    rebuildId: Number(row.rebuild_id),
    pageId: Number(row.page_id),
    pageLabel: row.page_label,
    platform: row.platform,
    conversationRef: row.conversation_ref,
    fanId: Number(row.fan_id),
    fanRef: row.fan_ref,
    state: row.state,
    throughMessageAt: row.through_message_at === null ? null : new Date(row.through_message_at),
    progress: row.progress === null ? null : new Date(row.progress),
  }));
}

/**
 * Starts a pending conversation of a rebuild: it reads up to where the live
 * lane had read (its AI facts go with its first window, reserveFanFactRun).
 * Null — it is not pending any more, or the live lane never reached the model
 * there (then it is done).
 */
export async function startFanFactRebuildConversation(
  db: Database,
  input: { rebuildId: number; pageId: number; conversationRef: string; now: Date },
): Promise<Date | null> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const key = sql`rebuild_id = ${input.rebuildId} and page_id = ${input.pageId} and conversation_ref = ${input.conversationRef}`;
    const locked = await tx.execute<{ state: string }>(sql`select state from fan_fact_rebuild_conversations where ${key} for update`);
    if (locked.rows[0]?.state !== "pending") return null;
    const read = await tx.execute<{ through: Date | string | null }>(sql`
      select max(r.through_message_at) as through from fan_fact_runs r
      where r.page_id = ${input.pageId} and r.conversation_ref = ${input.conversationRef}
        and r.rebuild_id is null and not ${TRANSIENT_FAILURE("r")}`);
    const through = read.rows[0]?.through ?? null;
    if (through === null) {
      await tx.execute(sql`update fan_fact_rebuild_conversations set state = 'done', finished_at = ${input.now.toISOString()}::timestamptz where ${key}`);
      return null;
    }
    await tx.execute(sql`
      update fan_fact_rebuild_conversations
      set state = 'running', through_message_at = ${new Date(through).toISOString()}::timestamptz, started_at = ${input.now.toISOString()}::timestamptz
      where ${key}`);
    return new Date(through);
  });
}

/** A conversation of a rebuild read to its end: the live lane takes it back. */
export async function finishFanFactRebuildConversation(
  db: Database,
  input: { rebuildId: number; pageId: number; conversationRef: string; now: Date },
): Promise<void> {
  await db.execute(sql`
    update fan_fact_rebuild_conversations set state = 'done', finished_at = ${input.now.toISOString()}::timestamptz
    where rebuild_id = ${input.rebuildId} and page_id = ${input.pageId} and conversation_ref = ${input.conversationRef}
      and state in ('pending', 'running')`);
}

/** Stops a rebuild: its open conversations go back to the live lane as they are. The number stopped. */
export async function stopFanFactRebuild(db: Database, input: { rebuildId: number; now: Date }): Promise<number> {
  const updated = await db.execute(sql`
    update fan_fact_rebuild_conversations set state = 'stopped', finished_at = ${input.now.toISOString()}::timestamptz
    where rebuild_id = ${input.rebuildId} and state in ('pending', 'running')`);
  return updated.rowCount ?? 0;
}

export interface FanFactRebuildStatus {
  id: number;
  requestedAt: Date;
  promptVersion: number;
  budgetMicroUsd: number;
  spentMicroUsd: number;
  runs: number;
  factsAdded: number;
  conversations: Record<"pending" | "running" | "done" | "stopped", number>;
}

/** Every rebuild, the newest first: its conversations by state and what its runs spent and wrote. */
export async function listFanFactRebuilds(db: Database): Promise<FanFactRebuildStatus[]> {
  const result = await db.execute<{
    id: string | number; requested_at: Date | string; prompt_version: number; budget_micro_usd: string | number;
    spent: string | number; runs: string | number; facts_added: string | number;
    pending: string | number; running: string | number; done: string | number; stopped: string | number;
  }>(sql`
    select b.id, b.requested_at, b.prompt_version, b.budget_micro_usd,
      coalesce(r.spent, 0) as spent, coalesce(r.runs, 0) as runs, coalesce(r.facts_added, 0) as facts_added,
      coalesce(c.pending, 0) as pending, coalesce(c.running, 0) as running, coalesce(c.done, 0) as done, coalesce(c.stopped, 0) as stopped
    from fan_fact_rebuilds b
    left join lateral (
      select sum(coalesce(cost_micro_usd, reserved_micro_usd)) as spent, count(*) as runs, sum(coalesce(facts_added, 0)) as facts_added
      from fan_fact_runs where rebuild_id = b.id
    ) r on true
    left join lateral (
      select count(*) filter (where state = 'pending') as pending, count(*) filter (where state = 'running') as running,
        count(*) filter (where state = 'done') as done, count(*) filter (where state = 'stopped') as stopped
      from fan_fact_rebuild_conversations where rebuild_id = b.id
    ) c on true
    order by b.id desc`);
  return result.rows.map((row) => ({
    id: Number(row.id),
    requestedAt: new Date(row.requested_at),
    promptVersion: row.prompt_version,
    budgetMicroUsd: Number(row.budget_micro_usd),
    spentMicroUsd: Number(row.spent),
    runs: Number(row.runs),
    factsAdded: Number(row.facts_added),
    conversations: { pending: Number(row.pending), running: Number(row.running), done: Number(row.done), stopped: Number(row.stopped) },
  }));
}
