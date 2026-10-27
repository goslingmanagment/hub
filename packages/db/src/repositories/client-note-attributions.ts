import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Who wrote each Fansly note (note-attribution-v1, 0324): raw SQL over
// client_note_attributions, like the other client_* repositories. The route
// (apps/runtime services/client-note-attributions.ts) decides who may report
// and for which page, and journals each fact first; this file only records,
// first report wins.

/** The table's CHECK lists, mirrored. */
export const CLIENT_NOTE_ATTRIBUTION_STORED_SOURCES = ["fansly-extension"] as const;
export type ClientNoteAttributionStoredSource = (typeof CLIENT_NOTE_ATTRIBUTION_STORED_SOURCES)[number];
export const CLIENT_NOTE_ATTRIBUTION_STORED_NOTE_KINDS = ["note", "custom_name"] as const;
export type ClientNoteAttributionStoredNoteKind = (typeof CLIENT_NOTE_ATTRIBUTION_STORED_NOTE_KINDS)[number];
export const CLIENT_NOTE_ATTRIBUTION_STORED_ACTIONS = ["created", "edited", "deleted"] as const;
export type ClientNoteAttributionStoredAction = (typeof CLIENT_NOTE_ATTRIBUTION_STORED_ACTIONS)[number];
export const CLIENT_NOTE_ATTRIBUTION_STORED_ORIGINS = ["quick", "editor", "field", "fill", "undo", "list", "name"] as const;
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
