import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Who wrote each fan note (note-attribution-v1, 0324; OnlyFans since 0327): raw
// SQL over client_note_attributions, like the other client_* repositories. The
// routes (apps/runtime services/client-note-attributions.ts) decide who may
// report or read and for which page, and journal each fact first; this file
// records, first report wins, and reads a fan's notes back.

/** The table's CHECK lists, mirrored. */
export const CLIENT_NOTE_ATTRIBUTION_STORED_SOURCES = ["fansly-extension", "chatspace-extension"] as const;
export type ClientNoteAttributionStoredSource = (typeof CLIENT_NOTE_ATTRIBUTION_STORED_SOURCES)[number];
export const CLIENT_NOTE_ATTRIBUTION_STORED_NOTE_KINDS = ["note", "custom_name"] as const;
export type ClientNoteAttributionStoredNoteKind = (typeof CLIENT_NOTE_ATTRIBUTION_STORED_NOTE_KINDS)[number];
export const CLIENT_NOTE_ATTRIBUTION_STORED_ACTIONS = ["created", "edited", "deleted"] as const;
export type ClientNoteAttributionStoredAction = (typeof CLIENT_NOTE_ATTRIBUTION_STORED_ACTIONS)[number];
export const CLIENT_NOTE_ATTRIBUTION_STORED_ORIGINS = ["quick", "editor", "field", "fill", "undo", "list", "name", "transfer"] as const;
export type ClientNoteAttributionStoredOrigin = (typeof CLIENT_NOTE_ATTRIBUTION_STORED_ORIGINS)[number];

export interface ClientNoteAttributionFactInput {
  /** The client's id of the write (a uuid). */
  eventId: string;
  fanRef: string;
  noteRef: string;
  noteKind: ClientNoteAttributionStoredNoteKind;
  action: ClientNoteAttributionStoredAction;
  /** Null from a client that does not say, or a value the hub does not know. */
  origin: ClientNoteAttributionStoredOrigin | null;
  /** Questionnaire labels the write changed; null — none named. */
  fields: readonly string[] | null;
  observedAt: Date;
  /** The fact's row in `observations`, journaled before this one. */
  observationId: number;
}

export interface ClientNoteAttributionInput {
  platform: string;
  pageId: number;
  /** The hub's user of the token that reported, never a client's field. */
  userId: number;
  source: ClientNoteAttributionStoredSource;
  clientVersion: string | null;
  facts: readonly ClientNoteAttributionFactInput[];
}

/**
 * - `recorded`: this report wrote the row.
 * - `duplicate`: the event was there already, with this user, note and action: a repeat.
 * - `conflict`: the event was there already, with another user, note or action. Nothing changed.
 */
export type ClientNoteAttributionRecordOutcome = "recorded" | "duplicate" | "conflict";

export interface ClientNoteAttributionRecordResult {
  eventId: string;
  outcome: ClientNoteAttributionRecordOutcome;
}

/**
 * Records one batch of facts of one page under one user, in one transaction,
 * and answers each fact in the order given. An event id named twice in the
 * batch is recorded once: its first fact is the report.
 */
export async function recordClientNoteAttributions(
  db: Database,
  input: ClientNoteAttributionInput,
): Promise<ClientNoteAttributionRecordResult[]> {
  if (input.facts.length === 0) return [];
  const keyOf = (eventId: string) => eventId.toLowerCase();
  const first = new Map<string, ClientNoteAttributionFactInput>();
  for (const fact of input.facts) {
    if (!first.has(keyOf(fact.eventId))) first.set(keyOf(fact.eventId), fact);
  }
  const unique = [...first.values()];

  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const inserted = await tx.execute<{ event_id: string }>(sql`
      insert into client_note_attributions (
        platform, page_id, event_id, fan_ref, note_ref, note_kind, action, origin, fields,
        user_id, source, observed_at, client_version, observation_id
      )
      select ${input.platform}, ${input.pageId}, f.event_id, f.fan_ref, f.note_ref, f.note_kind, f.action, f.origin,
        case when f.fields is null then null else (select array_agg(e.v order by e.n) from jsonb_array_elements_text(f.fields) with ordinality as e(v, n)) end,
        ${input.userId}, ${input.source}, f.observed_at, ${input.clientVersion}, f.observation_id
      from unnest(
        ${sql.param(unique.map((fact) => keyOf(fact.eventId)))}::uuid[],
        ${sql.param(unique.map((fact) => fact.fanRef))}::text[],
        ${sql.param(unique.map((fact) => fact.noteRef))}::text[],
        ${sql.param(unique.map((fact) => fact.noteKind))}::text[],
        ${sql.param(unique.map((fact) => fact.action))}::text[],
        ${sql.param(unique.map((fact) => fact.origin))}::text[],
        ${sql.param(unique.map((fact) => (fact.fields === null ? null : JSON.stringify(fact.fields))))}::jsonb[],
        ${sql.param(unique.map((fact) => fact.observedAt.toISOString()))}::timestamptz[],
        ${sql.param(unique.map((fact) => String(fact.observationId)))}::bigint[]
      ) with ordinality as f(event_id, fan_ref, note_ref, note_kind, action, origin, fields, observed_at, observation_id, ord)
      order by f.ord
      on conflict (platform, page_id, event_id) do nothing
      returning event_id::text`);
    const written = new Set(inserted.rows.map((row) => row.event_id));

    const stored = await tx.execute<{ event_id: string; user_id: string | number; fan_ref: string; note_ref: string; note_kind: string; action: string }>(sql`
      select event_id::text, user_id, fan_ref, note_ref, note_kind, action
      from client_note_attributions
      where platform = ${input.platform} and page_id = ${input.pageId}
        and event_id = any(${sql.param(unique.map((fact) => keyOf(fact.eventId)))}::uuid[])`);
    const rows = new Map(stored.rows.map((row) => [row.event_id, row]));

    const answered = new Set<string>();
    return input.facts.map((fact): ClientNoteAttributionRecordResult => {
      const key = keyOf(fact.eventId);
      const firstTime = !answered.has(key);
      answered.add(key);
      if (firstTime && written.has(key)) return { eventId: fact.eventId, outcome: "recorded" };
      const row = rows.get(key);
      const same = row !== undefined
        && Number(row.user_id) === input.userId
        && row.fan_ref === fact.fanRef
        && row.note_ref === fact.noteRef
        && row.note_kind === fact.noteKind
        && row.action === fact.action;
      return { eventId: fact.eventId, outcome: same ? "duplicate" : "conflict" };
    });
  });
}

export interface ClientNoteAttributionWho {
  userId: number;
  username: string;
  observedAt: Date;
}

export interface ClientFanNoteAttributionRow {
  noteRef: string;
  noteKind: ClientNoteAttributionStoredNoteKind;
  /** The note's earliest `created` fact; null when the hub never heard of it. */
  created: ClientNoteAttributionWho | null;
  /** The note's latest `edited` fact; null when none. */
  edited: ClientNoteAttributionWho | null;
  /** When the note's latest fact was observed. */
  lastAt: Date;
}

/**
 * One fan's notes of a page with who created each and who edited it last, the
 * latest fact first, at most `limit`. A note whose latest fact is `deleted` is
 * left out. Ties of `observed_at` fall to the later report.
 */
export async function listClientFanNoteAttributions(
  db: Database,
  input: { pageId: number; fanRef: string; limit: number },
): Promise<ClientFanNoteAttributionRow[]> {
  const result = await db.execute<{
    note_ref: string; note_kind: string; last_at: Date | string;
    created_user_id: string | number | null; created_username: string | null; created_at: Date | string | null;
    edited_user_id: string | number | null; edited_username: string | null; edited_at: Date | string | null;
  }>(sql`
    with facts as (
      select a.note_ref, a.note_kind, a.action, a.user_id, a.observed_at, a.recorded_at
      from client_note_attributions a
      where a.page_id = ${input.pageId} and a.fan_ref = ${input.fanRef}
    ),
    latest as (
      select distinct on (note_ref) note_ref, note_kind, action, observed_at as last_at
      from facts
      order by note_ref, observed_at desc, recorded_at desc
    )
    select l.note_ref, l.note_kind, l.last_at,
      c.user_id as created_user_id, cu.username as created_username, c.observed_at as created_at,
      e.user_id as edited_user_id, eu.username as edited_username, e.observed_at as edited_at
    from latest l
    left join lateral (
      select f.user_id, f.observed_at from facts f
      where f.note_ref = l.note_ref and f.action = 'created'
      order by f.observed_at, f.recorded_at limit 1
    ) c on true
    left join users cu on cu.id = c.user_id
    left join lateral (
      select f.user_id, f.observed_at from facts f
      where f.note_ref = l.note_ref and f.action = 'edited'
      order by f.observed_at desc, f.recorded_at desc limit 1
    ) e on true
    left join users eu on eu.id = e.user_id
    where l.action <> 'deleted'
    order by l.last_at desc, l.note_ref desc
    limit ${input.limit}`);
  const whoOf = (userId: string | number | null, username: string | null, at: Date | string | null): ClientNoteAttributionWho | null =>
    userId === null || username === null || at === null ? null : { userId: Number(userId), username, observedAt: new Date(at) };
  return result.rows.map((row) => ({
    noteRef: row.note_ref,
    noteKind: row.note_kind as ClientNoteAttributionStoredNoteKind,
    created: whoOf(row.created_user_id, row.created_username, row.created_at),
    edited: whoOf(row.edited_user_id, row.edited_username, row.edited_at),
    lastAt: new Date(row.last_at),
  }));
}
