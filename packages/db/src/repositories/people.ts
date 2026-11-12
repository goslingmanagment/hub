import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";

// The people registry (0384–0386; ecosystem plan 2026-11-12, package A): one
// record per person of the agency, with the logins and agent keys that are
// theirs, the pages they work, their schedule slots, their narrow rights,
// their pay terms by model and the agents' proposals about them. Raw SQL: the
// tables are defined by their migrations alone. Nothing here deletes a person,
// a term or a proposal; a link, a working page or a right is taken off by its
// owner's edit (audited by the service).

type Row = Record<string, unknown>;

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}
function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}
/** A `date` column as `YYYY-MM-DD` (the driver may hand a Date at local midnight or the text). */
function day(value: unknown): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}
function nullableDay(value: unknown): string | null {
  return value === null || value === undefined ? null : day(value);
}
function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
function ids(values: readonly number[]) {
  return sql`${sql.param(values.map(String))}::bigint[]`;
}

export type PersonRowKind = "human" | "agent" | "service";
export type PersonRowRole = "owner" | "team_lead" | "chatter" | "content_manager" | "contractor" | "agent" | "service";
export type PersonRowState = "invited" | "set_up" | "working" | "left";
export type PersonRowOrigin = "owner" | "import" | "proposal";

export interface PersonOnboardingStepRow {
  step: string;
  doneAt: string | null;
  note: string | null;
}
export interface PersonImportNoteRow {
  code: string;
  text: string;
  /** The owner's «Сверено» (ISO); absent or null — not yet. */
  settledAt?: string | null;
  settledByUserId?: number | null;
}

export interface PersonRow {
  id: number;
  code: string;
  displayName: string;
  kind: PersonRowKind;
  role: PersonRowRole;
  state: PersonRowState;
  leftOn: string | null;
  telegramUserId: number | null;
  telegramHandle: string | null;
  reportTag: string | null;
  onboarding: PersonOnboardingStepRow[];
  note: string | null;
  importNotes: PersonImportNoteRow[];
  origin: PersonRowOrigin;
  createdAt: Date;
  updatedAt: Date;
}

const PERSON_COLUMNS = sql`
  p.id, p.code, p.display_name, p.kind, p.role, p.state, p.left_on, p.telegram_user_id, p.telegram_handle, p.report_tag,
  p.onboarding, p.note, p.import_notes, p.origin, p.created_at, p.updated_at`;

function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }
  return [];
}

function personOf(row: Row): PersonRow {
  return {
    id: Number(row.id),
    code: String(row.code),
    displayName: String(row.display_name),
    kind: row.kind as PersonRowKind,
    role: row.role as PersonRowRole,
    state: row.state as PersonRowState,
    leftOn: nullableDay(row.left_on),
    telegramUserId: nullableNumber(row.telegram_user_id),
    telegramHandle: nullableText(row.telegram_handle),
    reportTag: nullableText(row.report_tag),
    onboarding: jsonArray<PersonOnboardingStepRow>(row.onboarding),
    note: nullableText(row.note),
    importNotes: jsonArray<PersonImportNoteRow>(row.import_notes),
    origin: row.origin as PersonRowOrigin,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

export async function listPersonRows(db: Database): Promise<PersonRow[]> {
  const result = await db.execute<Row>(sql`select ${PERSON_COLUMNS} from people p order by p.display_name, p.code`);
  return result.rows.map(personOf);
}

/** One person by code; `lock` takes the row for an edit (the order: people → its children). */
export async function findPersonRowByCode(db: Database, code: string, options: { lock?: boolean } = {}): Promise<PersonRow | null> {
  const result = await db.execute<Row>(sql`
    select ${PERSON_COLUMNS} from people p where p.code = ${code} ${options.lock ? sql`for update` : sql``}`);
  const row = result.rows[0];
  return row === undefined ? null : personOf(row);
}

export async function findPersonRowById(db: Database, id: number): Promise<PersonRow | null> {
  const result = await db.execute<Row>(sql`select ${PERSON_COLUMNS} from people p where p.id = ${id}`);
  const row = result.rows[0];
  return row === undefined ? null : personOf(row);
}

/**
 * Whether a Telegram account is the owner's own: a person of the registry whose role is owner, who has not left, holds
 * this Telegram id. No id asked, or an owner the registry gives no Telegram id — false: nothing is the owner's word
 * until the registry says whose account it is.
 */
export async function isOwnerTelegramUser(db: Database, telegramUserId: number): Promise<boolean> {
  if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) return false;
  const result = await db.execute<Row>(sql`
    select 1 from people where role = 'owner' and kind = 'human' and state <> 'left' and telegram_user_id = ${telegramUserId} limit 1`);
  return result.rows.length > 0;
}

/** The people any of whose parts changed at or after `since`: the record, a login's row, a key's revocation. */
export async function listPersonRowsChangedSince(db: Database, since: Date): Promise<PersonRow[]> {
  const result = await db.execute<Row>(sql`
    select ${PERSON_COLUMNS}
      from people p
     where p.updated_at >= ${since}
        or exists (select 1 from person_logins l join users u on u.id = l.user_id
                    where l.person_id = p.id and u.updated_at >= ${since})
        or exists (select 1 from person_agent_keys k join agent_keys a on a.id = k.agent_key_id
                    where k.person_id = p.id and a.revoked_at >= ${since})
     order by p.updated_at, p.id`);
  return result.rows.map(personOf);
}

export interface NewPersonRow {
  code: string;
  displayName: string;
  kind: PersonRowKind;
  role: PersonRowRole;
  state: PersonRowState;
  leftOn: string | null;
  telegramUserId: number | null;
  telegramHandle: string | null;
  reportTag: string | null;
  onboarding: PersonOnboardingStepRow[];
  note: string | null;
  importNotes: PersonImportNoteRow[];
  origin: PersonRowOrigin;
  createdByUserId: number | null;
}

export async function insertPersonRow(db: Database, input: NewPersonRow): Promise<PersonRow> {
  const result = await db.execute<Row>(sql`
    insert into people as p (code, display_name, kind, role, state, left_on, telegram_user_id, telegram_handle, report_tag,
                             onboarding, note, import_notes, origin, created_by_user_id)
    values (${input.code}, ${input.displayName}, ${input.kind}, ${input.role}, ${input.state}, ${input.leftOn}::date,
            ${input.telegramUserId}, ${input.telegramHandle}, ${input.reportTag}, ${JSON.stringify(input.onboarding)}::jsonb,
            ${input.note}, ${JSON.stringify(input.importNotes)}::jsonb, ${input.origin}, ${input.createdByUserId})
    returning ${PERSON_COLUMNS}`);
  return personOf(result.rows[0]!);
}

export type PersonRowPatch = Partial<Pick<NewPersonRow,
  "displayName" | "role" | "state" | "leftOn" | "telegramUserId" | "telegramHandle" | "reportTag" | "onboarding" | "note" | "importNotes">>;

/** Writes the given fields and moves `updated_at`; with no field it only moves `updated_at` (a child changed). */
export async function updatePersonRow(db: Database, id: number, patch: PersonRowPatch): Promise<PersonRow> {
  const sets: SQL[] = [sql`updated_at = now()`];
  if (patch.displayName !== undefined) sets.push(sql`display_name = ${patch.displayName}`);
  if (patch.role !== undefined) sets.push(sql`role = ${patch.role}`);
  if (patch.state !== undefined) sets.push(sql`state = ${patch.state}`);
  if (patch.leftOn !== undefined) sets.push(sql`left_on = ${patch.leftOn}::date`);
  if (patch.telegramUserId !== undefined) sets.push(sql`telegram_user_id = ${patch.telegramUserId}`);
  if (patch.telegramHandle !== undefined) sets.push(sql`telegram_handle = ${patch.telegramHandle}`);
  if (patch.reportTag !== undefined) sets.push(sql`report_tag = ${patch.reportTag}`);
  if (patch.onboarding !== undefined) sets.push(sql`onboarding = ${JSON.stringify(patch.onboarding)}::jsonb`);
  if (patch.note !== undefined) sets.push(sql`note = ${patch.note}`);
  if (patch.importNotes !== undefined) sets.push(sql`import_notes = ${JSON.stringify(patch.importNotes)}::jsonb`);
  const result = await db.execute<Row>(sql`
    update people as p set ${sql.join(sets, sql`, `)} where p.id = ${id} returning ${PERSON_COLUMNS}`);
  return personOf(result.rows[0]!);
}

// ── logins and keys ──────────────────────────────────────────────────────────

export interface PersonLoginRow {
  personId: number;
  userId: number;
  username: string;
  role: "owner" | "team_lead" | "chatter";
  hasPassword: boolean;
  disabledAt: Date | null;
  deletedAt: Date | null;
  updatedAt: Date;
  /** The latest use of the login: a device token's or a web session's, whichever is later; null — never. */
  lastSeenAt: Date | null;
}

/** A login's latest use: its device tokens' last use and its web sessions' last request (live or ended). */
const LAST_SEEN = sql`greatest(
  (select max(d.last_used_at) from device_tokens d where d.user_id = u.id),
  (select max(s.last_seen_at) from auth_sessions s where s.user_id = u.id)) as last_seen_at`;

function loginOf(row: Row): PersonLoginRow {
  return {
    personId: Number(row.person_id ?? 0),
    userId: Number(row.user_id),
    username: String(row.username),
    role: row.role as PersonLoginRow["role"],
    hasPassword: row.has_password === true,
    disabledAt: nullableDate(row.disabled_at),
    deletedAt: nullableDate(row.deleted_at),
    updatedAt: date(row.updated_at),
    lastSeenAt: nullableDate(row.last_seen_at),
  };
}

export async function listPersonLoginRows(db: Database, personIds?: readonly number[]): Promise<PersonLoginRow[]> {
  const where = personIds === undefined ? sql`` : sql`where l.person_id = any(${ids(personIds)})`;
  const result = await db.execute<Row>(sql`
    select l.person_id, u.id as user_id, u.username, u.role, (u.password_hash is not null) as has_password, u.disabled_at,
           u.deleted_at, u.updated_at, ${LAST_SEEN}
      from person_logins l join users u on u.id = l.user_id
      ${where}
     order by l.person_id, u.id`);
  return result.rows.map(loginOf);
}

/** Hub logins no person holds (person id 0). */
export async function listUnlinkedLoginRows(db: Database): Promise<PersonLoginRow[]> {
  const result = await db.execute<Row>(sql`
    select null::bigint as person_id, u.id as user_id, u.username, u.role, (u.password_hash is not null) as has_password,
           u.disabled_at, u.deleted_at, u.updated_at, ${LAST_SEEN}
      from users u
     where not exists (select 1 from person_logins l where l.user_id = u.id)
     order by u.id`);
  return result.rows.map(loginOf);
}

/** Every Hub login with its person (null — no person holds it) and the person's name: whose a share of a sale is. */
export async function listLoginPeople(db: Database): Promise<Array<{ userId: number; username: string; personId: number | null; displayName: string | null }>> {
  const result = await db.execute<Row>(sql`
    select u.id as user_id, u.username, l.person_id, p.display_name
      from users u
      left join person_logins l on l.user_id = u.id
      left join people p on p.id = l.person_id
     order by u.id`);
  return result.rows.map((row) => ({
    userId: Number(row.user_id),
    username: String(row.username),
    personId: nullableNumber(row.person_id),
    displayName: row.display_name === null || row.display_name === undefined ? null : String(row.display_name),
  }));
}

/** The person holding a login, if any. */
export async function findPersonIdOfLogin(db: Database, userId: number): Promise<number | null> {
  const result = await db.execute<Row>(sql`select person_id from person_logins where user_id = ${userId}`);
  return nullableNumber(result.rows[0]?.person_id);
}

export async function insertPersonLogin(db: Database, input: { personId: number; userId: number; linkedByUserId: number | null }) {
  await db.execute(sql`
    insert into person_logins (user_id, person_id, linked_by_user_id) values (${input.userId}, ${input.personId}, ${input.linkedByUserId})`);
}

export async function deletePersonLogin(db: Database, input: { personId: number; userId: number }): Promise<boolean> {
  const result = await db.execute(sql`delete from person_logins where person_id = ${input.personId} and user_id = ${input.userId}`);
  return (result.rowCount ?? 0) > 0;
}

export interface PersonAgentKeyRow {
  personId: number;
  agentKeyId: number;
  name: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export async function listPersonAgentKeyRows(db: Database, personIds?: readonly number[]): Promise<PersonAgentKeyRow[]> {
  const where = personIds === undefined ? sql`` : sql`where k.person_id = any(${ids(personIds)})`;
  const result = await db.execute<Row>(sql`
    select k.person_id, a.id as agent_key_id, a.name, a.expires_at, a.revoked_at
      from person_agent_keys k join agent_keys a on a.id = k.agent_key_id
      ${where}
     order by k.person_id, a.id`);
  return result.rows.map((row) => ({
    personId: Number(row.person_id),
    agentKeyId: Number(row.agent_key_id),
    name: String(row.name),
    expiresAt: date(row.expires_at),
    revokedAt: nullableDate(row.revoked_at),
  }));
}

export async function findPersonIdOfAgentKey(db: Database, agentKeyId: number): Promise<number | null> {
  const result = await db.execute<Row>(sql`select person_id from person_agent_keys where agent_key_id = ${agentKeyId}`);
  return nullableNumber(result.rows[0]?.person_id);
}

/**
 * An agent holds one live key at a time. The services (ledger, TaskIndex, ContentOps) learn from Hub only WHOSE a key
 * is (`agentKeyIntrospect` answers the agent) and give it that agent's rights: a second live key of the same agent,
 * however narrow in Hub, would carry them too. A key no agent holds (a reporter, a mirror) is answered inactive there.
 */
export class AgentHoldsLiveKeyError extends Error {
  constructor(readonly personId: number, readonly liveKeyName: string) {
    super(`The agent already holds a live key «${liveKeyName}»: revoke it first, or keep this key without an agent`);
    this.name = "AgentHoldsLiveKeyError";
  }
}

/**
 * Links a key to its agent: the one writer of `person_agent_keys`, whoever links (issuance, the person's card, the
 * CLI, an accepted proposal). Refused with AgentHoldsLiveKeyError while the agent holds another live key (not
 * revoked, not expired); the person's row is locked first, so two links at once cannot both pass.
 */
export async function insertPersonAgentKey(db: Database, input: { personId: number; agentKeyId: number; linkedByUserId: number | null }) {
  await db.execute(sql`select id from people where id = ${input.personId} for update`);
  const live = await db.execute<{ name: string }>(sql`
    select k.name from person_agent_keys pak join agent_keys k on k.id = pak.agent_key_id
     where pak.person_id = ${input.personId} and pak.agent_key_id <> ${input.agentKeyId}
       and k.revoked_at is null and k.expires_at > now()
     order by k.id limit 1`);
  const holding = live.rows[0];
  if (holding !== undefined) throw new AgentHoldsLiveKeyError(input.personId, holding.name);
  await db.execute(sql`
    insert into person_agent_keys (agent_key_id, person_id, linked_by_user_id)
    values (${input.agentKeyId}, ${input.personId}, ${input.linkedByUserId})`);
}

export async function deletePersonAgentKey(db: Database, input: { personId: number; agentKeyId: number }): Promise<boolean> {
  const result = await db.execute(sql`
    delete from person_agent_keys where person_id = ${input.personId} and agent_key_id = ${input.agentKeyId}`);
  return (result.rowCount ?? 0) > 0;
}

// ── working pages, schedule, rights ──────────────────────────────────────────

export interface PersonWorkingPageRow {
  personId: number;
  pageId: number;
  position: number;
  label: string;
  platform: "fansly" | "onlyfans" | "telegram";
  modelSlug: string;
  modelName: string;
}

export async function listPersonWorkingPageRows(db: Database, personIds?: readonly number[]): Promise<PersonWorkingPageRow[]> {
  const where = personIds === undefined ? sql`` : sql`where w.person_id = any(${ids(personIds)})`;
  const result = await db.execute<Row>(sql`
    select w.person_id, w.page_id, w.position, pg.label, pg.platform, m.slug as model_slug, m.name as model_name
      from person_working_pages w
      join pages pg on pg.id = w.page_id
      join models m on m.id = pg.model_id
      ${where}
     order by w.person_id, w.position`);
  return result.rows.map((row) => ({
    personId: Number(row.person_id),
    pageId: Number(row.page_id),
    position: Number(row.position),
    label: String(row.label),
    platform: row.platform as PersonWorkingPageRow["platform"],
    modelSlug: String(row.model_slug),
    modelName: String(row.model_name),
  }));
}

/** The person's working pages become exactly `pageIds`, in that order. */
export async function replacePersonWorkingPages(db: Database, personId: number, pageIds: readonly number[]) {
  await db.execute(sql`delete from person_working_pages where person_id = ${personId}`);
  if (pageIds.length === 0) return;
  await db.execute(sql`
    insert into person_working_pages (person_id, page_id, position)
    select ${personId}, page_id, (ordinality - 1)::smallint
      from unnest(${ids(pageIds)}) with ordinality as listed(page_id, ordinality)`);
}

export interface PersonScheduleSlotRow {
  id: number;
  personId: number;
  /** Null — every page of the person. */
  pageId: number | null;
  pageLabel: string | null;
  startMinute: number;
  endMinute: number;
  weekdays: string[] | null;
  validFrom: string | null;
  validTo: string | null;
}

function slotOf(row: Row): PersonScheduleSlotRow {
  return {
    id: Number(row.id),
    personId: Number(row.person_id),
    pageId: nullableNumber(row.page_id),
    pageLabel: nullableText(row.page_label),
    startMinute: Number(row.start_minute),
    endMinute: Number(row.end_minute),
    weekdays: Array.isArray(row.weekdays) ? (row.weekdays as string[]) : null,
    validFrom: nullableDay(row.valid_from),
    validTo: nullableDay(row.valid_to),
  };
}

const SLOT_COLUMNS = sql`
  s.id, s.person_id, s.page_id, (select pg.label from pages pg where pg.id = s.page_id) as page_label, s.start_minute,
  s.end_minute, s.weekdays, s.valid_from, s.valid_to`;

/** By person, then the line (every page first, then by page), oldest first: a slot with no known start comes first. */
export async function listPersonScheduleSlotRows(db: Database, personIds?: readonly number[]): Promise<PersonScheduleSlotRow[]> {
  const where = personIds === undefined ? sql`` : sql`where s.person_id = any(${ids(personIds)})`;
  const result = await db.execute<Row>(sql`
    select ${SLOT_COLUMNS}
      from person_schedule_slots s
      ${where}
     order by s.person_id, s.page_id nulls first, s.valid_from nulls first, s.id`);
  return result.rows.map(slotOf);
}

export async function insertPersonScheduleSlot(db: Database, input: {
  personId: number;
  pageId: number | null;
  startMinute: number;
  endMinute: number;
  weekdays: readonly string[] | null;
  validFrom: string | null;
  createdByUserId: number | null;
}): Promise<PersonScheduleSlotRow> {
  const weekdays = input.weekdays === null ? sql`null` : sql`${sql.param([...input.weekdays])}::text[]`;
  const result = await db.execute<Row>(sql`
    insert into person_schedule_slots as s (person_id, page_id, start_minute, end_minute, weekdays, valid_from, created_by_user_id)
    values (${input.personId}, ${input.pageId}, ${input.startMinute}, ${input.endMinute}, ${weekdays}, ${input.validFrom}::date,
            ${input.createdByUserId})
    returning ${SLOT_COLUMNS}`);
  return slotOf(result.rows[0]!);
}

/** Ends a slot on `validTo` (its last day). */
export async function endPersonScheduleSlot(db: Database, slotId: number, validTo: string) {
  await db.execute(sql`update person_schedule_slots set valid_to = ${validTo}::date where id = ${slotId}`);
}

/** Rewrites a slot in place (the same first day given again: a correction). */
export async function rewritePersonScheduleSlot(db: Database, slotId: number, input: {
  startMinute: number;
  endMinute: number;
  weekdays: readonly string[] | null;
}) {
  const weekdays = input.weekdays === null ? sql`null` : sql`${sql.param([...input.weekdays])}::text[]`;
  await db.execute(sql`
    update person_schedule_slots set start_minute = ${input.startMinute}, end_minute = ${input.endMinute}, weekdays = ${weekdays}
     where id = ${slotId}`);
}

export interface PersonRightRow {
  personId: number;
  right: "customs_lead" | "records_customs" | "submits_shift" | "sees_own_pay";
  grantedAt: Date;
}

export async function listPersonRightRows(db: Database, personIds?: readonly number[]): Promise<PersonRightRow[]> {
  const where = personIds === undefined ? sql`` : sql`where r.person_id = any(${ids(personIds)})`;
  const result = await db.execute<Row>(sql`
    select r.person_id, r."right", r.granted_at from person_rights r ${where} order by r.person_id, r."right"`);
  return result.rows.map((row) => ({
    personId: Number(row.person_id),
    right: row.right as PersonRightRow["right"],
    grantedAt: date(row.granted_at),
  }));
}

/**
 * The person a login is, for «Мои деньги» (ecosystem package H1): their code (the ledger's slug) and since when their
 * switch «видит свои деньги» is on (null — off). Null — the login is nobody's. Only the login's own person: a login
 * belongs to one person at most (person_logins' key is the user).
 */
export async function findOwnPayPerson(db: Database, userId: number): Promise<{ personId: number; code: string; seesOwnPaySince: Date | null } | null> {
  const result = await db.execute<Row>(sql`
    select p.id, p.code,
      (select r.granted_at from person_rights r where r.person_id = p.id and r."right" = 'sees_own_pay') as sees_since
    from person_logins l join people p on p.id = l.person_id
    where l.user_id = ${userId}`);
  const row = result.rows[0];
  if (!row) return null;
  return { personId: Number(row.id), code: String(row.code), seesOwnPaySince: nullableDate(row.sees_since) };
}

/** The person's rights become exactly `rights`; a right kept keeps its grant time. */
export async function replacePersonRights(db: Database, personId: number, rights: readonly string[], grantedByUserId: number | null) {
  await db.execute(sql`
    delete from person_rights where person_id = ${personId} and not ("right" = any(${sql.param([...rights])}::text[]))`);
  if (rights.length === 0) return;
  await db.execute(sql`
    insert into person_rights (person_id, "right", granted_by_user_id)
    select ${personId}, listed, ${grantedByUserId} from unnest(${sql.param([...rights])}::text[]) as listed
    on conflict (person_id, "right") do nothing`);
}

// ── pay terms (money: the owner's only) ──────────────────────────────────────

export interface PersonPayTermRow {
  id: number;
  personId: number;
  modelId: number;
  modelSlug: string;
  modelName: string;
  validFrom: string;
  shareBasisPoints: number;
  fixPerShiftMills: bigint;
  note: string | null;
  updatedAt: Date;
}

function termOf(row: Row): PersonPayTermRow {
  return {
    id: Number(row.id),
    personId: Number(row.person_id),
    modelId: Number(row.model_id),
    modelSlug: String(row.model_slug),
    modelName: String(row.model_name),
    validFrom: day(row.valid_from),
    shareBasisPoints: Number(row.share_basis_points),
    fixPerShiftMills: BigInt(String(row.fix_per_shift_mills)),
    note: nullableText(row.note),
    updatedAt: date(row.updated_at),
  };
}

/** By person, model and first day, oldest first. */
export async function listPersonPayTermRows(db: Database, personIds?: readonly number[]): Promise<PersonPayTermRow[]> {
  const where = personIds === undefined ? sql`` : sql`where t.person_id = any(${ids(personIds)})`;
  const result = await db.execute<Row>(sql`
    select t.id, t.person_id, t.model_id, m.slug as model_slug, m.name as model_name, t.valid_from, t.share_basis_points,
           t.fix_per_shift_mills::text as fix_per_shift_mills, t.note, t.updated_at
      from person_pay_terms t join models m on m.id = t.model_id
      ${where}
     order by t.person_id, m.sort_order, m.slug, t.valid_from`);
  return result.rows.map(termOf);
}

/** Sets the term of a person, model and first day; the same day again rewrites it. Returns the row before, if any. */
export async function upsertPersonPayTerm(db: Database, input: {
  personId: number;
  modelId: number;
  validFrom: string;
  shareBasisPoints: number;
  fixPerShiftMills: bigint;
  note: string | null;
  byUserId: number | null;
}): Promise<{ before: { shareBasisPoints: number; fixPerShiftMills: bigint; note: string | null } | null; id: number }> {
  const prior = await db.execute<Row>(sql`
    select id, share_basis_points, fix_per_shift_mills::text as fix_per_shift_mills, note
      from person_pay_terms
     where person_id = ${input.personId} and model_id = ${input.modelId} and valid_from = ${input.validFrom}::date
     for update`);
  const before = prior.rows[0];
  if (before !== undefined) {
    await db.execute(sql`
      update person_pay_terms
         set share_basis_points = ${input.shareBasisPoints}, fix_per_shift_mills = ${input.fixPerShiftMills.toString()}::bigint,
             note = ${input.note}, updated_at = now(), updated_by_user_id = ${input.byUserId}
       where id = ${Number(before.id)}`);
    return {
      id: Number(before.id),
      before: {
        shareBasisPoints: Number(before.share_basis_points),
        fixPerShiftMills: BigInt(String(before.fix_per_shift_mills)),
        note: nullableText(before.note),
      },
    };
  }
  const inserted = await db.execute<Row>(sql`
    insert into person_pay_terms (person_id, model_id, valid_from, share_basis_points, fix_per_shift_mills, note,
                                  created_by_user_id, updated_by_user_id)
    values (${input.personId}, ${input.modelId}, ${input.validFrom}::date, ${input.shareBasisPoints},
            ${input.fixPerShiftMills.toString()}::bigint, ${input.note}, ${input.byUserId}, ${input.byUserId})
    returning id`);
  return { id: Number(inserted.rows[0]!.id), before: null };
}

// ── proposals ────────────────────────────────────────────────────────────────

export type PersonProposalRowState = "open" | "accepted" | "rejected" | "withdrawn";

export interface PersonProposalRow {
  id: number;
  personId: number | null;
  /** The person's code now, or the proposed new code. */
  personCode: string;
  change: Record<string, unknown>;
  reason: string;
  requestedBy: string | null;
  sourceRef: string | null;
  agentKeyId: number;
  agentKeyName: string;
  state: PersonProposalRowState;
  createdAt: Date;
  decidedAt: Date | null;
  decidedByUserId: number | null;
  decisionNote: string | null;
}

const PROPOSAL_COLUMNS = sql`
  r.id, r.person_id, coalesce(p.code, r.proposed_code) as person_code, r.change, r.reason, r.requested_by, r.source_ref,
  r.agent_key_id, a.name as agent_key_name, r.state, r.created_at, r.decided_at, r.decided_by_user_id, r.decision_note`;

function proposalOf(row: Row): PersonProposalRow {
  const change = typeof row.change === "string" ? JSON.parse(row.change) as Record<string, unknown> : row.change as Record<string, unknown>;
  return {
    id: Number(row.id),
    personId: nullableNumber(row.person_id),
    personCode: String(row.person_code),
    change,
    reason: String(row.reason),
    requestedBy: nullableText(row.requested_by),
    sourceRef: nullableText(row.source_ref),
    agentKeyId: Number(row.agent_key_id),
    agentKeyName: String(row.agent_key_name),
    state: row.state as PersonProposalRowState,
    createdAt: date(row.created_at),
    decidedAt: nullableDate(row.decided_at),
    decidedByUserId: nullableNumber(row.decided_by_user_id),
    decisionNote: nullableText(row.decision_note),
  };
}

export async function insertPersonProposal(db: Database, input: {
  personId: number | null;
  proposedCode: string | null;
  change: Record<string, unknown>;
  reason: string;
  requestedBy: string | null;
  sourceRef: string | null;
  agentKeyId: number;
}): Promise<PersonProposalRow> {
  const inserted = await db.execute<Row>(sql`
    insert into person_proposals (person_id, proposed_code, change, reason, requested_by, source_ref, agent_key_id)
    values (${input.personId}, ${input.proposedCode}, ${JSON.stringify(input.change)}::jsonb, ${input.reason},
            ${input.requestedBy}, ${input.sourceRef}, ${input.agentKeyId})
    returning id`);
  return (await findPersonProposal(db, Number(inserted.rows[0]!.id)))!;
}

export async function findPersonProposal(db: Database, id: number, options: { lock?: boolean } = {}): Promise<PersonProposalRow | null> {
  const result = await db.execute<Row>(sql`
    select ${PROPOSAL_COLUMNS}
      from person_proposals r
      join agent_keys a on a.id = r.agent_key_id
      left join people p on p.id = r.person_id
     where r.id = ${id}
     ${options.lock ? sql`for update of r` : sql``}`);
  const row = result.rows[0];
  return row === undefined ? null : proposalOf(row);
}

/** Newest first. */
export async function listPersonProposalRows(db: Database, filter: {
  personId?: number;
  state?: PersonProposalRowState;
  agentKeyId?: number;
  /** Created or decided at or after. */
  since?: Date;
  limit?: number;
} = {}): Promise<PersonProposalRow[]> {
  const where: SQL[] = [sql`true`];
  if (filter.personId !== undefined) where.push(sql`r.person_id = ${filter.personId}`);
  if (filter.state !== undefined) where.push(sql`r.state = ${filter.state}`);
  if (filter.agentKeyId !== undefined) where.push(sql`r.agent_key_id = ${filter.agentKeyId}`);
  if (filter.since !== undefined) where.push(sql`(r.created_at >= ${filter.since} or r.decided_at >= ${filter.since})`);
  const result = await db.execute<Row>(sql`
    select ${PROPOSAL_COLUMNS}
      from person_proposals r
      join agent_keys a on a.id = r.agent_key_id
      left join people p on p.id = r.person_id
     where ${sql.join(where, sql` and `)}
     order by r.created_at desc, r.id desc
     limit ${filter.limit ?? 500}`);
  return result.rows.map(proposalOf);
}

export async function countOpenPersonProposals(db: Database): Promise<Map<number, number>> {
  const result = await db.execute<Row>(sql`
    select person_id, count(*)::int as n from person_proposals where state = 'open' and person_id is not null group by person_id`);
  return new Map(result.rows.map((row) => [Number(row.person_id), Number(row.n)]));
}

/** Decides an open proposal; false when it was not open. */
export async function decidePersonProposal(db: Database, input: {
  id: number;
  state: "accepted" | "rejected";
  decidedByUserId: number | null;
  note: string | null;
  /** A new person's id, once accepted. */
  personId?: number;
}): Promise<boolean> {
  const result = await db.execute(sql`
    update person_proposals
       set state = ${input.state}, decided_at = now(), decided_by_user_id = ${input.decidedByUserId}, decision_note = ${input.note}
           ${input.personId === undefined ? sql`` : sql`, person_id = ${input.personId}, proposed_code = null`}
     where id = ${input.id} and state = 'open'`);
  return (result.rowCount ?? 0) > 0;
}

// ── the catalogue the registry points at ─────────────────────────────────────

export interface PeopleCatalogPage {
  id: number;
  label: string;
  platform: "fansly" | "onlyfans" | "telegram";
  modelId: number;
  modelSlug: string;
}
export interface PeopleCatalogModel {
  id: number;
  slug: string;
  name: string;
}
export interface PeopleCatalogAgentKey {
  id: number;
  name: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export async function listPeopleCatalogPages(db: Database): Promise<PeopleCatalogPage[]> {
  const result = await db.execute<Row>(sql`
    select pg.id, pg.label, pg.platform, pg.model_id, m.slug as model_slug
      from pages pg join models m on m.id = pg.model_id
     where pg.status = 'active'
     order by pg.id`);
  return result.rows.map((row) => ({
    id: Number(row.id),
    label: String(row.label),
    platform: row.platform as PeopleCatalogPage["platform"],
    modelId: Number(row.model_id),
    modelSlug: String(row.model_slug),
  }));
}

export async function listPeopleCatalogModels(db: Database): Promise<PeopleCatalogModel[]> {
  const result = await db.execute<Row>(sql`select id, slug, name from models order by sort_order, slug`);
  return result.rows.map((row) => ({ id: Number(row.id), slug: String(row.slug), name: String(row.name) }));
}

export async function listPeopleCatalogAgentKeys(db: Database): Promise<PeopleCatalogAgentKey[]> {
  const result = await db.execute<Row>(sql`select id, name, expires_at, revoked_at from agent_keys order by id`);
  return result.rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    expiresAt: date(row.expires_at),
    revokedAt: nullableDate(row.revoked_at),
  }));
}

/** Every Hub login with its page access, for the import's comparison. */
export interface PeopleCatalogUser {
  id: number;
  username: string;
  role: "owner" | "team_lead" | "chatter";
  hasPassword: boolean;
  disabledAt: Date | null;
  deletedAt: Date | null;
  pageLabels: string[];
}

export async function listPeopleCatalogUsers(db: Database): Promise<PeopleCatalogUser[]> {
  const result = await db.execute<Row>(sql`
    select u.id, u.username, u.role, (u.password_hash is not null) as has_password, u.disabled_at, u.deleted_at,
           coalesce(array_agg(pg.label order by pg.label) filter (where pg.label is not null), '{}') as page_labels
      from users u
      left join user_page_assignments a on a.user_id = u.id
      left join pages pg on pg.id = a.platform_account_id
     group by u.id
     order by u.id`);
  return result.rows.map((row) => ({
    id: Number(row.id),
    username: String(row.username),
    role: row.role as PeopleCatalogUser["role"],
    hasPassword: row.has_password === true,
    disabledAt: nullableDate(row.disabled_at),
    deletedAt: nullableDate(row.deleted_at),
    pageLabels: Array.isArray(row.page_labels) ? (row.page_labels as string[]) : [],
  }));
}
