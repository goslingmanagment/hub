import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  decideOutreachSend,
  type OutreachSendDecision,
  type OutreachSendRequest,
  type OutreachSendState,
  type OutreachSendWrite,
} from "./client-outreach-rules.ts";

// «Рассылки» kept by Hub (0346, docs/plans/2026-11-01-outreach-store/spec.md):
// raw SQL over client_outreaches / client_outreach_fans. A save upserts the
// outreach under its row lock and changes only the fans whose send was never
// claimed; a send runs in one transaction under
// pg_advisory_xact_lock('outreach-fan:<page>:<fan>') and the pure
// decideOutreachSend (client-outreach-rules.ts); the reads answer the
// outreach with its people, what came of its sends (the fan queues' counting:
// listFanQueueResults in fan-queues.ts), the archive's candidates for an
// uncertain send, and the page's touches of the last hours. Nothing here
// talks to a platform.

const toDate = (value: Date | string | null): Date | null => (value === null ? null : new Date(value));
const ts = (date: Date) => sql`${date.toISOString()}::timestamptz`;
const json = (value: Record<string, unknown> | null) => sql`${value === null ? null : JSON.stringify(value)}::jsonb`;
const texts = (values: ReadonlyArray<string | null>) => sql`${sql.param([...values])}::text[]`;
const bigints = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;
const flags = (values: readonly boolean[]) => sql`${sql.param(values.map((value) => (value ? "t" : "f")))}::boolean[]`;

/** A person of the team as the dashboard names them. */
export interface ClientOutreachPersonRow {
  userId: number;
  name: string;
}

export interface ClientOutreachRow {
  id: string;
  pageId: number;
  author: ClientOutreachPersonRow;
  createdAt: Date;
  updatedBy: ClientOutreachPersonRow;
  updatedAt: Date;
  text: string;
  withMedia: boolean;
  settings: Record<string, unknown>;
  order: string[];
}

export interface ClientOutreachSendRow {
  /** As stored: a `sending` past its ticket is still `sending` here (outreachSendViewState reads it). */
  state: OutreachSendState;
  attemptId: string;
  by: ClientOutreachPersonRow;
  clickedAt: Date;
  ticketUntil: Date | null;
  sentAt: Date | null;
  platformMessageId: string | null;
  failureCode: string | null;
  resolvedBy: string | null;
  text: string;
  media: Record<string, unknown> | null;
}

export interface ClientOutreachFanRow {
  fanRef: string;
  fanId: number;
  version: string | null;
  basis: string | null;
  generationRef: string | null;
  versionAt: Date | null;
  edit: string | null;
  editedBy: ClientOutreachPersonRow | null;
  editedAt: Date | null;
  send: ClientOutreachSendRow | null;
}

const person = (id: string | number | null, name: string | null): ClientOutreachPersonRow | null =>
  id === null ? null : { userId: Number(id), name: name ?? "" };

// ── fans of the page ───────────────────────────────────────────────────────

/** The page's fans by their platform id (Hub knows them on the page: a `page_fans` row). */
export async function resolveClientOutreachFans(
  db: Database,
  input: { pageId: number; platform: string; refs: readonly string[] },
): Promise<Map<string, number>> {
  if (input.refs.length === 0) return new Map();
  const result = await db.execute<{ ref: string; fan_id: string | number }>(sql`
    select f.platform_user_id as ref, f.id as fan_id
    from fans f
    join page_fans pf on pf.fan_id = f.id and pf.platform_account_id = ${input.pageId}
    where f.platform = ${input.platform} and f.platform_user_id = any(${texts([...new Set(input.refs)])})`);
  return new Map(result.rows.map((row) => [row.ref, Number(row.fan_id)]));
}

// ── the outreach ───────────────────────────────────────────────────────────

type OutreachDbRow = {
  id: string; page_id: string | number; author_user_id: string | number; author_name: string; created_at: Date | string;
  updated_by_user_id: string | number; updated_by_name: string; updated_at: Date | string; text: string; with_media: boolean;
  settings: Record<string, unknown> | null; fan_order: string[] | null;
};

const OUTREACH_COLUMNS = sql`
  o.id::text as id, o.page_id, o.author_user_id, au.username as author_name, o.created_at, o.updated_by_user_id,
  uu.username as updated_by_name, o.updated_at, o.text, o.with_media, o.settings, o.fan_order`;
const OUTREACH_FROM = sql`
  from client_outreaches o
  join users au on au.id = o.author_user_id
  join users uu on uu.id = o.updated_by_user_id`;

function outreachOf(row: OutreachDbRow): ClientOutreachRow {
  return {
    id: row.id,
    pageId: Number(row.page_id),
    author: person(row.author_user_id, row.author_name)!,
    createdAt: new Date(row.created_at),
    updatedBy: person(row.updated_by_user_id, row.updated_by_name)!,
    updatedAt: new Date(row.updated_at),
    text: row.text,
    withMedia: row.with_media,
    settings: row.settings ?? {},
    order: row.fan_order ?? [],
  };
}

/** The outreach with this id, whichever page it is of; null — none. */
export async function readClientOutreachRow(db: Database, outreachId: string): Promise<ClientOutreachRow | null> {
  const result = await db.execute<OutreachDbRow>(sql`select ${OUTREACH_COLUMNS} ${OUTREACH_FROM} where o.id = ${outreachId}::uuid`);
  return result.rows[0] === undefined ? null : outreachOf(result.rows[0]);
}

type FanDbRow = {
  fan_ref: string; fan_id: string | number; version: string | null; basis: string | null; generation_ref: string | null;
  version_at: Date | string | null; edit: string | null; edited_by_user_id: string | number | null; edited_by_name: string | null;
  edited_at: Date | string | null; send_state: string | null; attempt_id: string | null; sender_user_id: string | number | null;
  sender_name: string | null; clicked_at: Date | string | null; ticket_until: Date | string | null; sent_at: Date | string | null;
  platform_message_id: string | null; failure_code: string | null; resolved_by: string | null; sent_text: string | null;
  sent_media: Record<string, unknown> | null;
};

function fanOf(row: FanDbRow): ClientOutreachFanRow {
  const send: ClientOutreachSendRow | null = row.send_state === null ? null : {
    state: row.send_state as OutreachSendState,
    attemptId: row.attempt_id!,
    by: person(row.sender_user_id, row.sender_name)!,
    clickedAt: new Date(row.clicked_at!),
    ticketUntil: toDate(row.ticket_until),
    sentAt: toDate(row.sent_at),
    platformMessageId: row.platform_message_id,
    failureCode: row.failure_code,
    resolvedBy: row.resolved_by,
    text: row.sent_text ?? "",
    media: row.sent_media,
  };
  return {
    fanRef: row.fan_ref,
    fanId: Number(row.fan_id),
    version: row.version,
    basis: row.basis,
    generationRef: row.generation_ref,
    versionAt: toDate(row.version_at),
    edit: row.edit,
    editedBy: person(row.edited_by_user_id, row.edited_by_name),
    editedAt: toDate(row.edited_at),
    send,
  };
}

/** The outreach's fans (every row: a version, the person's words or a send), or the one named. */
export async function listClientOutreachFanRows(
  db: Database,
  input: { outreachId: string; fanRef?: string },
): Promise<ClientOutreachFanRow[]> {
  const result = await db.execute<FanDbRow>(sql`
    select f.fan_ref, f.fan_id, f.version, f.basis, f.generation_ref, f.version_at, f.edit, f.edited_by_user_id,
      eu.username as edited_by_name, f.edited_at, f.send_state, f.attempt_id::text as attempt_id, f.sender_user_id,
      su.username as sender_name, f.clicked_at, f.ticket_until, f.sent_at, f.platform_message_id, f.failure_code,
      f.resolved_by, f.sent_text, f.sent_media
    from client_outreach_fans f
    left join users eu on eu.id = f.edited_by_user_id
    left join users su on su.id = f.sender_user_id
    where f.outreach_id = ${input.outreachId}::uuid ${input.fanRef === undefined ? sql`` : sql`and f.fan_ref = ${input.fanRef}`}
    order by f.fan_ref`);
  return result.rows.map(fanOf);
}

/** One fan's change in a save, the fan resolved on the page. An absent field is left as it is. */
export interface ClientOutreachFanChangeInput {
  fanRef: string;
  fanId: number;
  /** Fix's version; null — let go. A version comes with its basis (and the generation that wrote it). */
  version?: { text: string; basis: string; generationRef: string | null } | null;
  /** The person's own words; null — back to Fix's version. */
  edit?: string | null;
}

export type ClientOutreachSaveResult =
  | { ok: true; created: boolean; kept: string[] }
  /** The id is another page's outreach. */
  | { ok: false };

/**
 * Creates the outreach (the first save of its id, the caller its author) or changes it, in one transaction under the
 * outreach's row lock. Each field given is the latest word. A fan's version and words change only while the fan's
 * send was never claimed (or failed, proven): the others come back in `kept`. A fan left with nothing (no version,
 * no words, no send) leaves the outreach.
 */
export async function saveClientOutreach(
  db: Database,
  input: {
    outreachId: string; pageId: number; userId: number; now: Date; createdAt: Date;
    text?: string; withMedia?: boolean; settings?: Record<string, unknown>; order?: readonly string[];
    fans: readonly ClientOutreachFanChangeInput[];
  },
): Promise<ClientOutreachSaveResult> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const now = ts(input.now);
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into client_outreaches (id, page_id, author_user_id, created_at, updated_by_user_id, updated_at, text, with_media,
        settings, fan_order)
      values (${input.outreachId}::uuid, ${input.pageId}, ${input.userId}, ${ts(input.createdAt)}, ${input.userId}, ${now},
        ${input.text ?? ""}, ${input.withMedia ?? false}, ${json(input.settings ?? {})}, ${texts(input.order ?? [])})
      on conflict (id) do nothing
      returning id::text as id`);
    const created = inserted.rows.length > 0;
    const locked = await tx.execute<{ page_id: string | number }>(sql`
      select page_id from client_outreaches where id = ${input.outreachId}::uuid for update`);
    if (locked.rows[0] === undefined || Number(locked.rows[0].page_id) !== input.pageId) return { ok: false };
    if (!created) {
      const sets: SQL[] = [sql`updated_at = ${now}`, sql`updated_by_user_id = ${input.userId}`];
      if (input.text !== undefined) sets.push(sql`text = ${input.text}`);
      if (input.withMedia !== undefined) sets.push(sql`with_media = ${input.withMedia}`);
      if (input.settings !== undefined) sets.push(sql`settings = ${json(input.settings)}`);
      if (input.order !== undefined) sets.push(sql`fan_order = ${texts(input.order)}`);
      await tx.execute(sql`update client_outreaches set ${sql.join(sets, sql`, `)} where id = ${input.outreachId}::uuid`);
    }
    if (input.fans.length === 0) return { ok: true, created, kept: [] };

    const fans = input.fans;
    await tx.execute(sql`
      insert into client_outreach_fans (outreach_id, fan_ref, page_id, fan_id, created_at, updated_at)
      select ${input.outreachId}::uuid, x.fan_ref, ${input.pageId}, x.fan_id, ${now}, ${now}
      from unnest(${texts(fans.map((fan) => fan.fanRef))}, ${bigints(fans.map((fan) => fan.fanId))}) as x(fan_ref, fan_id)
      on conflict (outreach_id, fan_ref) do nothing`);
    const versionSet = fans.map((fan) => fan.version !== undefined);
    const version = fans.map((fan) => fan.version?.text ?? null);
    const basis = fans.map((fan) => fan.version?.basis ?? null);
    const generation = fans.map((fan) => fan.version?.generationRef ?? null);
    const editSet = fans.map((fan) => fan.edit !== undefined);
    const edit = fans.map((fan) => fan.edit ?? null);
    // Only a fan whose send was never claimed, or failed (proven), takes the change: the row lock re-reads the state.
    const changed = await tx.execute<{ fan_ref: string }>(sql`
      update client_outreach_fans f set
        version = case when x.v_set then x.v else f.version end,
        basis = case when x.v_set then x.b else f.basis end,
        generation_ref = case when x.v_set then x.g else f.generation_ref end,
        version_at = case when x.v_set then (case when x.v is null then null else ${now} end) else f.version_at end,
        edit = case when x.e_set then x.e else f.edit end,
        edited_by_user_id = case when x.e_set then (case when x.e is null then null else ${input.userId}::bigint end) else f.edited_by_user_id end,
        edited_at = case when x.e_set then (case when x.e is null then null else ${now} end) else f.edited_at end,
        updated_at = ${now}
      from unnest(${texts(fans.map((fan) => fan.fanRef))}, ${flags(versionSet)}, ${texts(version)}, ${texts(basis)},
        ${texts(generation)}, ${flags(editSet)}, ${texts(edit)}) as x(fan_ref, v_set, v, b, g, e_set, e)
      where f.outreach_id = ${input.outreachId}::uuid and f.fan_ref = x.fan_ref
        and (f.send_state is null or f.send_state = 'failed')
      returning f.fan_ref`);
    const took = new Set(changed.rows.map((row) => row.fan_ref));
    await tx.execute(sql`
      delete from client_outreach_fans
      where outreach_id = ${input.outreachId}::uuid and fan_ref = any(${texts(fans.map((fan) => fan.fanRef))})
        and send_state is null and version is null and edit is null`);
    return { ok: true, created, kept: fans.map((fan) => fan.fanRef).filter((ref) => !took.has(ref)) };
  });
}

/** Outreaches of the page untouched since `before` go (the lazy end of OUTREACH_KEEP_DAYS); their fans with them. */
export async function deleteStaleClientOutreaches(db: Database, input: { pageId: number; before: Date }): Promise<number> {
  const result = await db.execute<{ n: string | number }>(sql`
    with gone as (
      delete from client_outreaches where page_id = ${input.pageId} and updated_at <= ${ts(input.before)}
      returning 1
    )
    select count(*) as n from gone`);
  return Number(result.rows[0]?.n ?? 0);
}

// ── the send ───────────────────────────────────────────────────────────────

async function lockFan(db: Database, pageId: number, fanRef: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`outreach-fan:${pageId}:${fanRef}`}, 0))`);
}

export type ClientOutreachSendResult =
  | { ok: true; outcome: OutreachSendDecision["outcome"]; fan: ClientOutreachFanRow | null }
  /** The outreach is gone, or another page's. */
  | { ok: false };

/**
 * One send action on one fan of one outreach, in one transaction: the fan's advisory lock (every action on the fan of
 * the page, whatever the outreach, waits for it), the outreach's row lock (its last change is stamped in the same
 * order a save takes it), the journal (`journal`, every action but a claim, before anything is decided), the
 * snapshot, the pure decision, its writes. Answers the fan as it stands after.
 */
export async function applyClientOutreachSend(
  db: Database,
  input: { outreachId: string; pageId: number; fanRef: string; fanId: number; now: Date; request: OutreachSendRequest },
  options: { journal?: (tx: Database) => Promise<number | null> } = {},
): Promise<ClientOutreachSendResult> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const { outreachId, pageId, fanRef, now, request } = input;
    await lockFan(tx, pageId, fanRef);
    const outreach = await tx.execute<{ page_id: string | number }>(sql`
      select page_id from client_outreaches where id = ${outreachId}::uuid for update`);
    if (outreach.rows[0] === undefined || Number(outreach.rows[0].page_id) !== pageId) return { ok: false };
    const observationId = request.action === "claim" || options.journal === undefined ? null : await options.journal(tx);
    const own = await tx.execute<{
      send_state: string | null; attempt_id: string | null; sender_user_id: string | number | null; clicked_at: Date | string | null;
      ticket_until: Date | string | null;
    }>(sql`
      select send_state, attempt_id::text as attempt_id, sender_user_id, clicked_at, ticket_until
      from client_outreach_fans where outreach_id = ${outreachId}::uuid and fan_ref = ${fanRef}`);
    const others = await tx.execute<{ outreach_id: string; ticket_until: Date | string | null }>(sql`
      select outreach_id::text as outreach_id, ticket_until from client_outreach_fans
      where page_id = ${pageId} and fan_ref = ${fanRef} and send_state = 'sending' and outreach_id <> ${outreachId}::uuid`);
    const row = own.rows[0];
    const decision = decideOutreachSend({
      now,
      send: row === undefined || row.send_state === null ? null : {
        state: row.send_state as OutreachSendState,
        attemptId: row.attempt_id!.toLowerCase(),
        senderUserId: Number(row.sender_user_id),
        clickedAt: new Date(row.clicked_at!),
        ticketUntil: toDate(row.ticket_until),
      },
      othersSending: others.rows.map((other) => ({ outreachId: other.outreach_id, ticketUntil: toDate(other.ticket_until) })),
    }, request);
    if (decision.writes.length > 0) {
      await tx.execute(sql`
        update client_outreaches set updated_at = ${ts(now)}, updated_by_user_id = ${request.userId} where id = ${outreachId}::uuid`);
      for (const write of decision.writes) await applyWrite(tx, input, write, observationId);
    }
    const [fan] = await listClientOutreachFanRows(tx, { outreachId, fanRef });
    return { ok: true, outcome: decision.outcome, fan: fan ?? null };
  });
}

async function applyWrite(
  tx: Database,
  input: { outreachId: string; pageId: number; fanRef: string; fanId: number; now: Date },
  write: OutreachSendWrite,
  observationId: number | null,
): Promise<void> {
  const now = ts(input.now);
  const id = sql`${input.outreachId}::uuid`;
  const where = sql`where outreach_id = ${id} and fan_ref = ${input.fanRef}`;
  switch (write.kind) {
    case "settle_other":
      await tx.execute(sql`
        update client_outreach_fans set send_state = 'uncertain', ticket_until = null, updated_at = ${now}
        where outreach_id = ${write.outreachId}::uuid and fan_ref = ${input.fanRef} and send_state = 'sending'`);
      return;
    case "claim":
    case "record": {
      const state = write.kind === "claim" ? "sending" : write.state;
      const ticket = write.kind === "claim" ? write.ticketUntil : null;
      const sentAt = write.kind === "claim" ? null : write.sentAt;
      const message = write.kind === "claim" ? null : write.platformMessageId;
      await tx.execute(sql`
        insert into client_outreach_fans (outreach_id, fan_ref, page_id, fan_id, send_state, attempt_id, sender_user_id, clicked_at,
          ticket_until, sent_at, platform_message_id, failure_code, resolved_by, sent_text, sent_media, observation_id, created_at, updated_at)
        values (${id}, ${input.fanRef}, ${input.pageId}, ${input.fanId}, ${state}, ${write.attemptId}::uuid, ${write.userId},
          ${ts(write.clickedAt)}, ${ticket === null ? null : ticket.toISOString()}::timestamptz,
          ${sentAt === null ? null : sentAt.toISOString()}::timestamptz, ${message}, null, null, ${write.text}, ${json(write.media)},
          ${observationId}, ${now}, ${now})
        on conflict (outreach_id, fan_ref) do update set
          send_state = excluded.send_state, attempt_id = excluded.attempt_id, sender_user_id = excluded.sender_user_id,
          clicked_at = excluded.clicked_at, ticket_until = excluded.ticket_until, sent_at = excluded.sent_at,
          platform_message_id = excluded.platform_message_id, failure_code = null, resolved_by = null,
          sent_text = excluded.sent_text, sent_media = excluded.sent_media, observation_id = excluded.observation_id,
          updated_at = excluded.updated_at`);
      return;
    }
    case "sent":
      await tx.execute(sql`
        update client_outreach_fans set send_state = 'sent', ticket_until = null, sent_at = ${ts(write.sentAt)},
          platform_message_id = coalesce(${write.platformMessageId}, platform_message_id), failure_code = null, resolved_by = null,
          observation_id = ${observationId}, updated_at = ${now}
        ${where}`);
      return;
    case "failed":
      await tx.execute(sql`
        update client_outreach_fans set send_state = 'failed', ticket_until = null, sent_at = null, failure_code = ${write.code},
          resolved_by = null, observation_id = ${observationId}, updated_at = ${now}
        ${where}`);
      return;
    case "uncertain":
      await tx.execute(sql`
        update client_outreach_fans set send_state = 'uncertain', ticket_until = null, observation_id = ${observationId},
          updated_at = ${now}
        ${where}`);
      return;
  }
}

// ── the archive's proof of an uncertain send ───────────────────────────────

/**
 * The fan's chats with the page as the archive keys them, as a subquery of conversation refs: on Fansly a chat is a
 * group with an id of its own, named by the page's threads of the fan (`page_dm_threads`); on OnlyFans the chat id is
 * the fan id (its thread names it too). Correlated on the fan, so the archive's (account, conversation, time) index
 * serves each fan.
 */
function fanChatRefs(input: { pageId: number; platform: string }, fanId: SQL, fanRef: SQL): SQL {
  return sql`(
    select t.platform_conversation_id from page_dm_threads t where t.platform_account_id = ${input.pageId} and t.fan_id = ${fanId}
    ${input.platform === "onlyfans" ? sql`union all select ${fanRef}` : sql``}
  )`;
}

export interface ClientOutreachArchiveMessage {
  fanRef: string;
  messageRef: string;
  at: Date;
  text: string;
}

/**
 * The page's own messages in each fan's chats written within the fan's window, the earliest first: the candidates
 * that may prove an uncertain send went (pickOutreachEvidence decides). A message that already proves another send
 * of the fan on the page is none.
 */
export async function listClientOutreachArchiveMessages(
  db: Database,
  input: { pageId: number; platform: string; sends: ReadonlyArray<{ fanRef: string; fanId: number; from: Date; to: Date }> },
): Promise<ClientOutreachArchiveMessage[]> {
  if (input.sends.length === 0) return [];
  const sends = input.sends;
  const result = await db.execute<{ fan_ref: string; message_ref: string; occurred_at: Date | string; text_plain: string }>(sql`
    with s as (
      select * from unnest(${texts(sends.map((one) => one.fanRef))}, ${bigints(sends.map((one) => one.fanId))},
        ${sql.param(sends.map((one) => one.from.toISOString()))}::timestamptz[],
        ${sql.param(sends.map((one) => one.to.toISOString()))}::timestamptz[]) as x(fan_ref, fan_id, t0, t1)
    )
    select s.fan_ref, m.message_ref, m.occurred_at, m.text_plain
    from s
    join message_archive m on m.account_id = ${input.pageId}
      and m.conversation_ref in ${fanChatRefs(input, sql`s.fan_id`, sql`s.fan_ref`)}
    where m.is_sent_by_me and m.occurred_at >= s.t0 and m.occurred_at <= s.t1
      and not exists (
        select 1 from client_outreach_fans o
        where o.page_id = ${input.pageId} and o.fan_ref = s.fan_ref and o.platform_message_id = m.message_ref
      )
    order by s.fan_ref, m.occurred_at
    limit 2000`);
  return result.rows.map((row) => ({
    fanRef: row.fan_ref, messageRef: row.message_ref, at: new Date(row.occurred_at), text: row.text_plain,
  }));
}

/**
 * Settles one uncertain send as sent by the archive's message, under the fan's lock: only the same attempt, and only
 * while it still reads uncertain (a report that landed first wins). Returns whether it did.
 */
export async function settleClientOutreachSendByArchive(
  db: Database,
  input: { outreachId: string; pageId: number; fanRef: string; attemptId: string; sentAt: Date; platformMessageId: string; now: Date },
): Promise<boolean> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    await lockFan(tx, input.pageId, input.fanRef);
    const result = await tx.execute(sql`
      update client_outreach_fans set send_state = 'sent', ticket_until = null, sent_at = ${ts(input.sentAt)},
        platform_message_id = ${input.platformMessageId}, failure_code = null, resolved_by = 'archive', updated_at = ${ts(input.now)}
      where outreach_id = ${input.outreachId}::uuid and fan_ref = ${input.fanRef} and attempt_id = ${input.attemptId}::uuid
        and (send_state = 'uncertain' or (send_state = 'sending' and ticket_until <= ${ts(input.now)}))
        -- One message proves one send: another outreach's read may have settled its send by it meanwhile (the
        -- candidates were picked before this lock).
        and not exists (
          select 1 from client_outreach_fans o
          where o.page_id = ${input.pageId} and o.fan_ref = ${input.fanRef} and o.platform_message_id = ${input.platformMessageId}
        )
      returning 1`);
    return result.rows.length > 0;
  });
}

// ── what came of the sends ─────────────────────────────────────────────────

/** The fan's message that counts as an answer, and the money that counts as bought (listFanQueueResults' rules). */
const REPLIED_HOURS = 72;
const BOUGHT_DAYS = 7;
const BOUGHT_TRANSACTIONS = sql`
  t.is_active and t.gross_amount_mills > 0 and t.canonical_type not in ('chargeback', 'refund', 'payout_reversal')`;

export interface ClientOutreachOutcomeRow {
  replied: { at: Date; text: string | null } | null;
  bought: { mills: number; at: Date } | null;
}

/**
 * What came of each sent fan of the outreach (or the one named): the fan's first message within 72 hours after the
 * send (in any of his chats with the page), and his money within 7 days after it — the sum and the first payment,
 * counted as fan queue results count them (gross > 0, no chargeback, refund or reversal).
 */
export async function listClientOutreachOutcomes(
  db: Database,
  input: { outreachId: string; pageId: number; platform: string; fanRef?: string },
): Promise<Map<string, ClientOutreachOutcomeRow>> {
  const page = input.pageId;
  const result = await db.execute<{
    fan_ref: string; replied_at: Date | string | null; replied_text: string | null; bought_mills: string | number | null;
    bought_at: Date | string | null;
  }>(sql`
    with s as (
      select f.fan_ref, f.fan_id, f.sent_at from client_outreach_fans f
      where f.outreach_id = ${input.outreachId}::uuid and f.send_state = 'sent'
        ${input.fanRef === undefined ? sql`` : sql`and f.fan_ref = ${input.fanRef}`}
    )
    select s.fan_ref, r.at as replied_at, r.text as replied_text, b.mills as bought_mills, b.at as bought_at
    from s
    left join lateral (
      select m.occurred_at as at, m.text_plain as text
      from message_archive m
      where m.account_id = ${page} and m.conversation_ref in ${fanChatRefs(input, sql`s.fan_id`, sql`s.fan_ref`)}
        and not m.is_sent_by_me
        and m.occurred_at > s.sent_at and m.occurred_at <= s.sent_at + make_interval(hours => ${REPLIED_HOURS})
      order by m.occurred_at
      limit 1
    ) r on true
    left join lateral (
      select sum(t.gross_amount_mills) as mills, min(t.occurred_at) as at
      from transactions t
      where t.platform_account_id = ${page} and t.fan_id = s.fan_id and ${BOUGHT_TRANSACTIONS}
        and t.occurred_at > s.sent_at and t.occurred_at <= s.sent_at + make_interval(days => ${BOUGHT_DAYS})
    ) b on true`);
  const out = new Map<string, ClientOutreachOutcomeRow>();
  for (const row of result.rows) {
    out.set(row.fan_ref, {
      replied: row.replied_at === null ? null : { at: new Date(row.replied_at), text: row.replied_text },
      bought: row.bought_at === null || row.bought_mills === null ? null : { mills: Number(row.bought_mills), at: new Date(row.bought_at) },
    });
  }
  return out;
}

export interface ClientOutreachSummaryRow {
  id: string;
  author: ClientOutreachPersonRow;
  createdAt: Date;
  updatedBy: ClientOutreachPersonRow;
  updatedAt: Date;
  /** The common text, its first 300 characters. */
  text: string;
  withMedia: boolean;
  fans: number;
  written: number;
  sent: number;
  uncertain: number;
  sending: number;
  failed: number;
  replied: number;
  bought: number;
  boughtMills: number;
  lastSentAt: Date | null;
}

/**
 * The page's outreaches changed since `since`, newest change first, at most `limit`, each with its counts in one
 * query: fans in its order, fans written, sends by state (a claim past its ticket counted uncertain), and of the sent
 * ones, those who answered within 72 hours and those who paid within 7 days with the sum.
 */
export async function listClientOutreachSummaries(
  db: Database,
  input: { pageId: number; platform: string; now: Date; since: Date; limit: number },
): Promise<ClientOutreachSummaryRow[]> {
  const page = input.pageId;
  const now = ts(input.now);
  const result = await db.execute<{
    id: string; author_user_id: string | number; author_name: string; created_at: Date | string; updated_by_user_id: string | number;
    updated_by_name: string; updated_at: Date | string; text: string; with_media: boolean; fans: string | number;
    written: string | number | null; sent: string | number | null; uncertain: string | number | null; sending: string | number | null;
    failed: string | number | null; replied: string | number | null; bought: string | number | null; bought_mills: string | number | null;
    last_sent_at: Date | string | null;
  }>(sql`
    with picked as (
      select o.id, o.author_user_id, o.created_at, o.updated_by_user_id, o.updated_at, left(o.text, 300) as text, o.with_media,
        cardinality(o.fan_order) as fans
      from client_outreaches o
      where o.page_id = ${page} and o.updated_at > ${ts(input.since)}
      order by o.updated_at desc, o.id
      limit ${input.limit}
    ),
    f as (
      select f.outreach_id, f.fan_ref, f.fan_id, (f.version is not null or f.edit is not null) as written,
        case when f.send_state = 'sending' and f.ticket_until <= ${now} then 'uncertain' else f.send_state end as state,
        f.sent_at, f.clicked_at
      from client_outreach_fans f
      join picked p on p.id = f.outreach_id
    ),
    judged as (
      select f.outreach_id,
        exists (
          select 1 from message_archive m
          where m.account_id = ${page} and m.conversation_ref in ${fanChatRefs(input, sql`f.fan_id`, sql`f.fan_ref`)}
            and not m.is_sent_by_me
            and m.occurred_at > f.sent_at and m.occurred_at <= f.sent_at + make_interval(hours => ${REPLIED_HOURS})
        ) as replied,
        (
          select sum(t.gross_amount_mills) from transactions t
          where t.platform_account_id = ${page} and t.fan_id = f.fan_id and ${BOUGHT_TRANSACTIONS}
            and t.occurred_at > f.sent_at and t.occurred_at <= f.sent_at + make_interval(days => ${BOUGHT_DAYS})
        ) as bought_mills
      from f
      where f.state = 'sent'
    ),
    counts as (
      select f.outreach_id,
        count(*) filter (where f.written) as written,
        count(*) filter (where f.state = 'sent') as sent,
        count(*) filter (where f.state = 'uncertain') as uncertain,
        count(*) filter (where f.state = 'sending') as sending,
        count(*) filter (where f.state = 'failed') as failed,
        max(case when f.state = 'sent' then f.sent_at when f.state in ('uncertain', 'sending') then f.clicked_at end) as last_sent_at
      from f
      group by f.outreach_id
    ),
    outcomes as (
      select j.outreach_id, count(*) filter (where j.replied) as replied, count(*) filter (where j.bought_mills > 0) as bought,
        coalesce(sum(j.bought_mills), 0) as bought_mills
      from judged j
      group by j.outreach_id
    )
    select p.id::text as id, p.author_user_id, au.username as author_name, p.created_at, p.updated_by_user_id,
      uu.username as updated_by_name, p.updated_at, p.text, p.with_media, p.fans, c.written, c.sent, c.uncertain, c.sending,
      c.failed, oc.replied, oc.bought, oc.bought_mills, c.last_sent_at
    from picked p
    join users au on au.id = p.author_user_id
    join users uu on uu.id = p.updated_by_user_id
    left join counts c on c.outreach_id = p.id
    left join outcomes oc on oc.outreach_id = p.id
    order by p.updated_at desc, p.id`);
  const n = (value: string | number | null) => Number(value ?? 0);
  return result.rows.map((row) => ({
    id: row.id,
    author: person(row.author_user_id, row.author_name)!,
    createdAt: new Date(row.created_at),
    updatedBy: person(row.updated_by_user_id, row.updated_by_name)!,
    updatedAt: new Date(row.updated_at),
    text: row.text,
    withMedia: row.with_media,
    fans: n(row.fans),
    written: n(row.written),
    sent: n(row.sent),
    uncertain: n(row.uncertain),
    sending: n(row.sending),
    failed: n(row.failed),
    replied: n(row.replied),
    bought: n(row.bought),
    boughtMills: n(row.bought_mills),
    lastSentAt: toDate(row.last_sent_at),
  }));
}

// ── touches ────────────────────────────────────────────────────────────────

export interface ClientOutreachTouchRow {
  fanRef: string;
  at: Date;
  kind: "outreach" | "queue" | "online";
  by: ClientOutreachPersonRow | null;
  outreachId: string | null;
}

/**
 * The page's fans written to since `since` by an outreach (went, may have, or on its way: the send's moment, else its
 * click), a fan queue (sent) or «Онлайн» (sent): the latest touch of each fan, newest first, at most `limit`.
 */
export async function listClientOutreachTouches(
  db: Database,
  input: { pageId: number; since: Date; limit: number },
): Promise<ClientOutreachTouchRow[]> {
  const page = input.pageId;
  const since = ts(input.since);
  const result = await db.execute<{
    fan_ref: string; at: Date | string; kind: string; user_id: string | number | null; username: string | null; outreach_id: string | null;
  }>(sql`
    with touches as (
      -- A send's moment is at most 30 minutes after its click (the archive's window), so the click bounds the scan.
      select f.fan_ref, coalesce(f.sent_at, f.clicked_at) as at, 'outreach' as kind, f.sender_user_id as user_id,
        f.outreach_id::text as outreach_id
      from client_outreach_fans f
      where f.page_id = ${page} and f.send_state in ('sending', 'sent', 'uncertain')
        and f.clicked_at > ${since} - interval '30 minutes' and coalesce(f.sent_at, f.clicked_at) > ${since}
      union all
      select i.fan_ref, i.done_at, 'queue', i.done_by_user_id, null
      from fan_queue_items i
      where i.page_id = ${page} and i.state = 'sent' and i.done_at > ${since}
      union all
      select a.fan_ref, a.attempted_at, 'online', a.user_id, null
      from online_attempts a
      where a.page_id = ${page} and a.action = 'sent' and a.attempted_at > ${since}
    ),
    latest as (
      select distinct on (t.fan_ref) t.* from touches t order by t.fan_ref, t.at desc, t.kind
    )
    select l.fan_ref, l.at, l.kind, l.user_id, u.username, l.outreach_id
    from latest l
    left join users u on u.id = l.user_id
    order by l.at desc, l.fan_ref
    limit ${input.limit}`);
  return result.rows.map((row) => ({
    fanRef: row.fan_ref,
    at: new Date(row.at),
    kind: row.kind === "queue" ? "queue" : row.kind === "online" ? "online" : "outreach",
    by: row.user_id === null || row.username === null ? null : { userId: Number(row.user_id), name: row.username },
    outreachId: row.outreach_id,
  }));
}
