import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The first messages a persona's Hi starts from (0320, owner 2026-10-25). A
// text is never edited or deleted: the owner switches it off and adds
// another, so the counts below stay with the words they counted.

export type AiPersonaOpenerAudience = "any" | "bare";

export interface AiPersonaOpenerHours {
  /** [from, to) in `timeZone`, across midnight when from > to. */
  from: number;
  to: number;
  /** IANA zone. */
  timeZone: string;
}

export interface AiPersonaOpener {
  id: number;
  personaKey: string;
  body: string;
  audience: AiPersonaOpenerAudience;
  /** null: any time. */
  hours: AiPersonaOpenerHours | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

type OpenerDbRow = {
  id: bigint;
  persona_key: string;
  body: string;
  audience: string;
  local_from_hour: number | null;
  local_to_hour: number | null;
  local_time_zone: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

const OPENER_COLUMNS = sql`id, persona_key, body, audience, local_from_hour, local_to_hour, local_time_zone,
  enabled, created_at, updated_at`;

function openerRow(row: OpenerDbRow): AiPersonaOpener {
  return {
    id: Number(row.id),
    personaKey: row.persona_key,
    body: row.body,
    audience: row.audience === "bare" ? "bare" : "any",
    hours: row.local_from_hour === null || row.local_to_hour === null || row.local_time_zone === null
      ? null
      : { from: row.local_from_hour, to: row.local_to_hour, timeZone: row.local_time_zone },
    enabled: row.enabled,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** A persona's openers, oldest first; `enabledOnly` for the draw. */
export async function listAiPersonaOpeners(
  db: Database,
  personaKey: string,
  options: { enabledOnly?: boolean } = {},
): Promise<AiPersonaOpener[]> {
  const result = await db.execute<OpenerDbRow>(sql`
    select ${OPENER_COLUMNS} from ai_persona_openers
    where persona_key = ${personaKey} ${options.enabledOnly === true ? sql`and enabled` : sql``}
    order by id`);
  return result.rows.map(openerRow);
}

export async function createAiPersonaOpener(
  db: Database,
  input: {
    personaKey: string;
    body: string;
    audience: AiPersonaOpenerAudience;
    hours: AiPersonaOpenerHours | null;
  },
): Promise<AiPersonaOpener> {
  const result = await db.execute<OpenerDbRow>(sql`
    insert into ai_persona_openers (persona_key, body, audience, local_from_hour, local_to_hour, local_time_zone)
    values (${input.personaKey}, ${input.body}, ${input.audience},
      ${input.hours?.from ?? null}, ${input.hours?.to ?? null}, ${input.hours?.timeZone ?? null})
    returning ${OPENER_COLUMNS}`);
  const row = result.rows[0];
  if (!row) {
    throw new Error("ai_persona_openers insert returned no row");
  }
  return openerRow(row);
}

/** Switch one opener on or off; null when the persona has no such opener. */
export async function setAiPersonaOpenerEnabled(
  db: Database,
  input: { personaKey: string; id: number; enabled: boolean },
): Promise<AiPersonaOpener | null> {
  const result = await db.execute<OpenerDbRow>(sql`
    update ai_persona_openers set enabled = ${input.enabled}, updated_at = now()
    where id = ${input.id} and persona_key = ${input.personaKey}
    returning ${OPENER_COLUMNS}`);
  const row = result.rows[0];
  return row ? openerRow(row) : null;
}

/** What the generation's record says the fan was when Hi drew (features: greetingFanKind). */
export type AiPersonaOpenerFanKind = "bare" | "default" | "named" | "unknown";

/** How the fans a set of greetings went to answered. A greeting counts toward
 * an outcome only once its window has passed: 72 hours for the answers, 14
 * days for the money. */
export interface AiPersonaOpenerOutcome {
  openerId: number;
  fan: AiPersonaOpenerFanKind;
  /** Greetings the chatters sent. */
  sent: number;
  /** Of them, sent with a text other than the generation's. */
  edited: number;
  /** Sent at least 72 hours ago. */
  matured: number;
  /** Of `matured`: the fan wrote back within 72 hours. */
  replied: number;
  /** Of `matured`: the fan wrote, the page answered, the fan wrote again, all within 72 hours. */
  talked: number;
  /** Sent at least 14 days ago. */
  maturedPaid: number;
  /** Of `maturedPaid`: the fan paid the page within 14 days. */
  paid: number;
}

const FAN_KINDS: ReadonlySet<string> = new Set(["bare", "default", "named", "unknown"]);

type OutcomeDbRow = {
  opener_id: bigint;
  fan: string | null;
  sent: bigint;
  edited: bigint;
  matured: bigint;
  replied: bigint;
  talked: bigint;
  matured_paid: bigint;
  paid: bigint;
};

/**
 * Every greeting a chatter sent that Hi started from one of the persona's
 * openers: the opener of the variant sent (client_greetings.variant, 0 for a
 * one-message Hi), by what the fan was. The answers are the fan's messages in
 * the generation's conversation (message_archive); the money is any active
 * transaction of the fan on that page.
 */
export async function listAiPersonaOpenerOutcomes(
  db: Database,
  input: { personaKey: string; now: Date },
): Promise<AiPersonaOpenerOutcome[]> {
  const repliesBy = new Date(input.now.getTime() - 72 * 3_600_000).toISOString();
  const moneyBy = new Date(input.now.getTime() - 14 * 86_400_000).toISOString();
  const result = await db.execute<OutcomeDbRow>(sql`
    with drawn as (
      select cg.page_id, cg.fan_ref, cg.confirmed_at, cg.first_message_ref, p.platform,
             c.conversation_ref, c.completion,
             (c.params->'contextManifest'->'greetingOpeners'->'ids'->>(coalesce(cg.variant, 0)::int))::bigint as opener_id,
             c.params->'contextManifest'->'greetingOpeners'->>'fan' as fan,
             jsonb_array_length(c.params->'contextManifest'->'greetingOpeners'->'ids') as variants
      from client_greetings cg
      join ai_generation_content c on c.generation_ref = cg.generation_ref
      join pages p on p.id = cg.page_id
      where c.feature = 'hi-greeting'
        and c.params->'contextManifest'->'greetingOpeners'->>'personaKey' = ${input.personaKey}
    ),
    outcome as (
      select d.opener_id, d.fan, d.confirmed_at,
             d.variants = 1 and position('[NEXT]' in d.completion) = 0
               and sent.text_plain is not null and btrim(sent.text_plain) <> btrim(d.completion) as edited,
             first_fan.at is not null as replied,
             again.at is not null as talked,
             paid.at is not null as paid
      from drawn d
      left join lateral (
        select m.text_plain from message_archive m
        where m.account_id = d.page_id and m.platform = d.platform and m.message_ref = d.first_message_ref
      ) sent on true
      left join lateral (
        select min(m.occurred_at) as at from message_archive m
        where m.account_id = d.page_id and m.conversation_ref = d.conversation_ref and not m.is_sent_by_me
          and m.occurred_at > d.confirmed_at and m.occurred_at <= d.confirmed_at + interval '72 hours'
      ) first_fan on true
      left join lateral (
        select min(m.occurred_at) as at from message_archive m
        where first_fan.at is not null
          and m.account_id = d.page_id and m.conversation_ref = d.conversation_ref and m.is_sent_by_me
          and m.occurred_at > first_fan.at and m.occurred_at <= d.confirmed_at + interval '72 hours'
      ) answer on true
      left join lateral (
        select min(m.occurred_at) as at from message_archive m
        where answer.at is not null
          and m.account_id = d.page_id and m.conversation_ref = d.conversation_ref and not m.is_sent_by_me
          and m.occurred_at > answer.at and m.occurred_at <= d.confirmed_at + interval '72 hours'
      ) again on true
      left join lateral (
        select min(t.occurred_at) as at
        from fans f join transactions t on t.fan_id = f.id
        where f.platform = d.platform and f.platform_user_id = d.fan_ref
          and t.platform_account_id = d.page_id and t.is_active and t.gross_amount_mills > 0
          and t.occurred_at > d.confirmed_at and t.occurred_at <= d.confirmed_at + interval '14 days'
      ) paid on true
      where d.opener_id is not null
    )
    select opener_id, fan,
           count(*) as sent,
           count(*) filter (where edited) as edited,
           count(*) filter (where confirmed_at <= ${repliesBy}::timestamptz) as matured,
           count(*) filter (where confirmed_at <= ${repliesBy}::timestamptz and replied) as replied,
           count(*) filter (where confirmed_at <= ${repliesBy}::timestamptz and talked) as talked,
           count(*) filter (where confirmed_at <= ${moneyBy}::timestamptz) as matured_paid,
           count(*) filter (where confirmed_at <= ${moneyBy}::timestamptz and paid) as paid
    from outcome
    group by opener_id, fan
    order by opener_id, fan`);
  return result.rows.map((row) => ({
    openerId: Number(row.opener_id),
    fan: row.fan !== null && FAN_KINDS.has(row.fan) ? row.fan as AiPersonaOpenerFanKind : "unknown",
    sent: Number(row.sent),
    edited: Number(row.edited),
    matured: Number(row.matured),
    replied: Number(row.replied),
    talked: Number(row.talked),
    maturedPaid: Number(row.matured_paid),
    paid: Number(row.paid),
  }));
}
