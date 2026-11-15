import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";

/**
 * Teams (0415): a team is a model. The facts every team decision is computed from, read whole (the agency is a few
 * dozen people and pages): who works which model's pages (`person_working_pages`), the live team records
 * (`team_roles`), which person each login is, which model each page is of. The rules live in the runtime's
 * `services/teams.ts`; this file only reads and writes.
 */

type Row = Record<string, unknown>;

export type TeamRoleKind = "lead" | "customs" | "view";
export const TEAM_ROLE_KINDS: readonly TeamRoleKind[] = ["lead", "customs", "view"];

export interface TeamRoleRow {
  id: number;
  personId: number;
  modelId: number;
  kind: TeamRoleKind;
  grantedByUserId: number | null;
  grantedAt: Date;
}

export interface TeamFacts {
  /** Every page: its model and realm. */
  pages: Array<{ pageId: number; modelId: number; test: boolean; label?: string }>;
  /** Every model: its realm. */
  models: Array<{ modelId: number; slug: string; name: string; test: boolean }>;
  /** A person's working pages (not access): the teams they are in. Only people who have not left. */
  working: Array<{ personId: number; pageId: number }>;
  /** Live team records of people who have not left. */
  roles: TeamRoleRow[];
  /**
   * Which person each living login is (not disabled or deleted), the login's role (a content manager's:
   * `content_manager`), and whether it LEADS (`signedInLoginSql`: signed in) — who the person is follows every living
   * login; who leads, decides or takes a step follows the signed-in ones only (`loginOfPerson`, leaders.ts).
   */
  logins: Array<{ userId: number; personId: number; role?: string; signedIn?: boolean }>;
  /** The people (not left): name, realm and the registry's role (a content manager works pages and is not the chat team). */
  people: Array<{ personId: number; name: string; test: boolean; role: string }>;
}

function roleOf(row: Row): TeamRoleRow {
  return {
    id: Number(row.id),
    personId: Number(row.person_id),
    modelId: Number(row.model_id),
    kind: row.kind as TeamRoleKind,
    grantedByUserId: row.granted_by_user_id === null || row.granted_by_user_id === undefined ? null : Number(row.granted_by_user_id),
    grantedAt: row.granted_at instanceof Date ? row.granted_at : new Date(String(row.granted_at)),
  };
}

/**
 * A login that LEADS: it has signed in (its password is set: the invitation was opened) and still may (not disabled or
 * deleted). THE rule of «who may lead a model, decide, take a step», for the facts below and for the matters' SQL
 * (`personLeadsSql`): a person invited and not signed in yet leads nothing — their matters and steps stay with whoever
 * had them (the owner; the customs lead for the shooting) until they can answer.
 */
export function signedInLoginSql(user: SQL = sql`u`): SQL {
  return sql`(${user}.password_hash is not null and ${user}.disabled_at is null and ${user}.deleted_at is null)`;
}

/** True for a person who has a login that leads (`signedInLoginSql`). */
export function personLeadsSql(personId: SQL): SQL {
  return sql`exists (select 1 from person_logins lead_pl join users lead_u on lead_u.id = lead_pl.user_id
    where lead_pl.person_id = ${personId} and ${signedInLoginSql(sql`lead_u`)})`;
}

export async function loadTeamFacts(db: Database): Promise<TeamFacts> {
  const [pages, models, working, roles, logins, people] = await Promise.all([
    db.execute<Row>(sql`select p.id, p.model_id, p.label, m.is_test from pages p join models m on m.id = p.model_id`),
    db.execute<Row>(sql`select id, slug, name, is_test from models`),
    db.execute<Row>(sql`
      select w.person_id, w.page_id from person_working_pages w join people p on p.id = w.person_id where p.state <> 'left'`),
    db.execute<Row>(sql`
      select t.id, t.person_id, t.model_id, t.kind, t.granted_by_user_id, t.granted_at
        from team_roles t join people p on p.id = t.person_id
       where t.revoked_at is null and p.state <> 'left'
       order by t.granted_at, t.id`),
    db.execute<Row>(sql`
      select l.user_id, l.person_id, u.role, ${signedInLoginSql()} as signed_in from person_logins l join users u on u.id = l.user_id
       where u.disabled_at is null and u.deleted_at is null`),
    db.execute<Row>(sql`select id, display_name, is_test, role from people where state <> 'left'`),
  ]);
  return {
    pages: pages.rows.map((row) => ({ pageId: Number(row.id), modelId: Number(row.model_id), test: row.is_test === true, label: String(row.label) })),
    models: models.rows.map((row) => ({ modelId: Number(row.id), slug: String(row.slug), name: String(row.name ?? row.slug), test: row.is_test === true })),
    working: working.rows.map((row) => ({ personId: Number(row.person_id), pageId: Number(row.page_id) })),
    roles: roles.rows.map(roleOf),
    logins: logins.rows.map((row) => ({ userId: Number(row.user_id), personId: Number(row.person_id), role: String(row.role), signedIn: row.signed_in === true })),
    people: people.rows.map((row) => ({ personId: Number(row.id), name: String(row.display_name ?? ""), test: row.is_test === true, role: String(row.role ?? "") })),
  };
}

/** Grants a record; an existing live one stays as it is (its grant time kept). Returns whether a row was added. */
export async function grantTeamRole(
  db: Database,
  input: { personId: number; modelId: number; kind: TeamRoleKind; grantedByUserId: number | null },
): Promise<boolean> {
  const result = await db.execute<Row>(sql`
    insert into team_roles (person_id, model_id, kind, granted_by_user_id)
    values (${input.personId}, ${input.modelId}, ${input.kind}, ${input.grantedByUserId})
    on conflict (person_id, model_id, kind) where revoked_at is null do nothing
    returning id`);
  return result.rows.length > 0;
}

/** Takes a live record back (never deletes it). Returns whether one was live. */
export async function revokeTeamRole(
  db: Database,
  input: { personId: number; modelId: number; kind: TeamRoleKind; revokedByUserId: number | null },
): Promise<boolean> {
  const result = await db.execute<Row>(sql`
    update team_roles set revoked_at = now(), revoked_by_user_id = ${input.revokedByUserId}
     where person_id = ${input.personId} and model_id = ${input.modelId} and kind = ${input.kind} and revoked_at is null
    returning id`);
  return result.rows.length > 0;
}

/**
 * The mirror of the person right «ведёт кастомы» (`customs_lead`): held — a customs record on every model of the
 * person's realm; not held — none live. Called by the one writer of rights (`replacePersonRights`).
 */
export async function mirrorCustomsLeadRight(db: Database, personId: number, held: boolean, byUserId: number | null) {
  if (held) {
    await db.execute(sql`
      insert into team_roles (person_id, model_id, kind, granted_by_user_id)
      select ${personId}, m.id, 'customs', ${byUserId}
        from models m join people p on p.id = ${personId} and m.is_test = p.is_test
      on conflict (person_id, model_id, kind) where revoked_at is null do nothing`);
  } else {
    await db.execute(sql`
      update team_roles set revoked_at = now(), revoked_by_user_id = ${byUserId}
       where person_id = ${personId} and kind = 'customs' and revoked_at is null`);
  }
}

export interface ReviewNoteRow {
  id: number;
  shiftId: number;
  chatterUserId: number;
  chatKey: string | null;
  authorUserId: number;
  authorName: string;
  text: string;
  createdAt: Date;
}

export async function listReviewNotes(db: Database, shiftIds: readonly number[]): Promise<ReviewNoteRow[]> {
  if (shiftIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select n.id, n.shift_id, n.chatter_user_id, n.chat_key, n.author_user_id, n.text, n.created_at,
           coalesce(p.display_name, u.username) as author_name
      from review_notes n
      join users u on u.id = n.author_user_id
      left join person_logins l on l.user_id = n.author_user_id
      left join people p on p.id = l.person_id
     where n.shift_id = any(${sql.param(shiftIds.map(String))}::bigint[])
     order by n.created_at, n.id`);
  return result.rows.map((row) => ({
    id: Number(row.id),
    shiftId: Number(row.shift_id),
    chatterUserId: Number(row.chatter_user_id),
    chatKey: row.chat_key === null ? null : String(row.chat_key),
    authorUserId: Number(row.author_user_id),
    authorName: String(row.author_name ?? ""),
    text: String(row.text),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  }));
}

export async function insertReviewNote(
  db: Database,
  input: { shiftId: number; chatterUserId: number; chatKey: string | null; authorUserId: number; text: string },
): Promise<number> {
  const result = await db.execute<Row>(sql`
    insert into review_notes (shift_id, chatter_user_id, chat_key, author_user_id, text)
    values (${input.shiftId}, ${input.chatterUserId}, ${input.chatKey}, ${input.authorUserId}, ${input.text})
    returning id`);
  return Number(result.rows[0]!.id);
}

/** A shift's id, its person's login and pages, by a moment inside it (the review's `userId` + `at`). */
export async function findShiftAt(db: Database, userId: number, at: Date): Promise<{ shiftId: number; pageIds: number[] } | null> {
  const result = await db.execute<Row>(sql`
    select s.id, coalesce((select array_agg(p.id) from pages p where p.label in (select e->>'pageLabel' from jsonb_array_elements(s.pages) e)), '{}') as page_ids
      from shifts s
     where s.user_id = ${userId} and s.merged_into is null and s.started_at <= ${at.toISOString()}::timestamptz
       and s.ended_at >= ${at.toISOString()}::timestamptz
     order by s.started_at desc limit 1`);
  const row = result.rows[0];
  if (!row) return null;
  return { shiftId: Number(row.id), pageIds: ((row.page_ids ?? []) as unknown[]).map(Number) };
}

/** The codes of some people. */
export async function listPersonCodes(db: Database, personIds: readonly number[]): Promise<Map<number, string>> {
  if (personIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`select id, code from people where id = any(${sql.param(personIds.map(String))}::bigint[])`);
  return new Map(result.rows.map((row) => [Number(row.id), String(row.code)]));
}
