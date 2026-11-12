import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Проверки (ecosystem plan §6, package K): what the people checks read — the
// registry, the logins and their tokens, the agent keys, access and the
// extension's activity — in a handful of reads over small tables. Read only.
// Nothing here reads a pay term's numbers: the checks ask only whether a
// person has a term in force.

type Row = Record<string, unknown>;

const date = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
const nullableDate = (value: unknown): Date | null => (value === null || value === undefined ? null : date(value));

// ── What the people checks read ─────────────────────────────────────────────

export interface PeopleCheckPerson {
  id: number;
  code: string;
  displayName: string;
  kind: "human" | "agent" | "service";
  role: string;
  state: "invited" | "set_up" | "working" | "left";
  leftOn: string | null;
}

export interface PeopleCheckLogin {
  userId: number;
  username: string;
  role: string;
  /** Its person; null — no person holds it. */
  personId: number | null;
  /** Neither disabled nor deleted. */
  living: boolean;
  /** Device tokens not revoked and not expired. */
  liveDeviceTokens: number;
}

export interface PeopleCheckAgentKey {
  id: number;
  name: string;
  personId: number | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface PeopleCheckPage {
  id: number;
  label: string;
  platform: string;
}

export interface PeopleCheckSnapshot {
  people: PeopleCheckPerson[];
  logins: PeopleCheckLogin[];
  agentKeys: PeopleCheckAgentKey[];
  pages: PeopleCheckPage[];
  /** person id → the pages they work, in order. */
  workingPages: Map<number, number[]>;
  /** user id → the pages the login may open. */
  access: Map<number, number[]>;
  /** The people with a pay term in force on `today` (a term's numbers are never read). */
  withPayTerms: Set<number>;
  /** `${userId}:${pageId}` → the last minute the login acted on the page since `idleSince`. */
  lastInput: Map<string, Date>;
  /** The first minute the extension's activity is known at all; null — none. */
  activitySince: Date | null;
}

function groupIds(rows: ReadonlyArray<{ owner: unknown; item: unknown }>): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const row of rows) {
    const owner = Number(row.owner);
    const list = out.get(owner) ?? [];
    list.push(Number(row.item));
    out.set(owner, list);
  }
  return out;
}

/** Everything the people checks need, in a handful of reads over small tables. */
export async function readPeopleCheckSnapshot(db: Database, input: { today: string; idleSince: Date; now: Date }): Promise<PeopleCheckSnapshot> {
  const now = input.now.toISOString();
  const [people, logins, keys, pages, working, access, terms, inputs, since] = await Promise.all([
    db.execute<Row>(sql`select id, code, display_name, kind, role, state, left_on::text as left_on from people order by id`),
    db.execute<Row>(sql`
      select u.id, u.username, u.role, l.person_id, (u.disabled_at is null and u.deleted_at is null) as living,
             (select count(*) from device_tokens t
               where t.user_id = u.id and t.revoked_at is null and t.expires_at > ${now}::timestamptz) as live_tokens
        from users u left join person_logins l on l.user_id = u.id
       order by u.id`),
    db.execute<Row>(sql`
      select a.id, a.name, k.person_id, a.expires_at, a.revoked_at
        from agent_keys a left join person_agent_keys k on k.agent_key_id = a.id
       order by a.id`),
    db.execute<Row>(sql`select id, label, platform from pages order by id`),
    db.execute<Row>(sql`select person_id as owner, page_id as item from person_working_pages order by person_id, position`),
    db.execute<Row>(sql`select user_id as owner, platform_account_id as item from user_page_assignments order by user_id, platform_account_id`),
    db.execute<Row>(sql`select distinct person_id from person_pay_terms where valid_from <= ${input.today}::date`),
    db.execute<Row>(sql`
      select user_id, page_id, max(minute) as last_input from chatter_activity_minutes
       where input and minute >= ${input.idleSince.toISOString()}::timestamptz
       group by user_id, page_id`),
    db.execute<Row>(sql`select min(minute) as since from chatter_activity_minutes`),
  ]);
  return {
    people: people.rows.map((row) => ({
      id: Number(row.id),
      code: String(row.code),
      displayName: String(row.display_name),
      kind: row.kind as PeopleCheckPerson["kind"],
      role: String(row.role),
      state: row.state as PeopleCheckPerson["state"],
      leftOn: row.left_on === null || row.left_on === undefined ? null : String(row.left_on).slice(0, 10),
    })),
    logins: logins.rows.map((row) => ({
      userId: Number(row.id),
      username: String(row.username),
      role: String(row.role),
      personId: row.person_id === null || row.person_id === undefined ? null : Number(row.person_id),
      living: row.living === true,
      liveDeviceTokens: Number(row.live_tokens ?? 0),
    })),
    agentKeys: keys.rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      personId: row.person_id === null || row.person_id === undefined ? null : Number(row.person_id),
      expiresAt: date(row.expires_at),
      revokedAt: nullableDate(row.revoked_at),
    })),
    pages: pages.rows.map((row) => ({ id: Number(row.id), label: String(row.label), platform: String(row.platform) })),
    workingPages: groupIds(working.rows as Array<{ owner: unknown; item: unknown }>),
    access: groupIds(access.rows as Array<{ owner: unknown; item: unknown }>),
    withPayTerms: new Set(terms.rows.map((row) => Number(row.person_id))),
    lastInput: new Map(inputs.rows.map((row) => [`${Number(row.user_id)}:${Number(row.page_id)}`, date(row.last_input)])),
    activitySince: nullableDate(since.rows[0]?.since ?? null),
  };
}
