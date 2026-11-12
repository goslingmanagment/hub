import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";

// Дела (0382, ecosystem plan package D): what waits for a person, one row per
// reason key, and the history of objects. Opening a key that is open updates
// the same matter; closing is idempotent; a closed key that comes back reopens
// its row — the latch of notification_incidents, under the same kind of
// advisory lock per key. Every transition leaves an object event in the same
// transaction. Raw SQL: the tables are the migration's alone.

export const MATTER_SOURCES = ["server", "agent", "ledger", "contentops", "person"] as const;
export type MatterSource = (typeof MATTER_SOURCES)[number];
export const MATTER_CLOSE_HOWS = ["resolved", "withdrawn", "cause_gone"] as const;
export type MatterCloseHow = (typeof MATTER_CLOSE_HOWS)[number];
export const MATTER_DOORS = ["extension", "workboard", "telegram", "api", "system"] as const;
export type MatterDoor = (typeof MATTER_DOORS)[number];
export const MATTER_OWNER_ROLES = ["owner", "team_lead", "chatter"] as const;
export type MatterOwnerRole = (typeof MATTER_OWNER_ROLES)[number];

/**
 * Whom a matter waits for: a Hub user, or a role. When the people registry
 * lands, a user leads to its person (`users.person_id`): a person's matters are
 * those of any of their users, and these rows stay as they are.
 */
export type MatterOwner = { userId: number } | { role: MatterOwnerRole };

export interface MatterRow {
  id: number;
  key: string;
  kind: string;
  source: MatterSource;
  state: "open" | "closed";
  closedHow: MatterCloseHow | null;
  title: string;
  object: { type: string; id: string } | null;
  pageIds: number[];
  owner: MatterOwner;
  watcherUserIds: number[];
  money: boolean;
  evidence: Record<string, unknown>;
  link: string | null;
  openedAt: Date;
  lastSeenAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

export interface MatterOpenInput {
  key: string;
  kind: string;
  source: MatterSource;
  title: string;
  object: { type: string; id: string } | null;
  pageIds: readonly number[];
  owner: MatterOwner;
  watcherUserIds?: readonly number[];
  money: boolean;
  evidence: Record<string, unknown>;
  link: string | null;
}

/** Who moved a matter and through which door; no user and no key — the system. */
export interface MatterActor {
  door: MatterDoor;
  userId?: number | null;
  agentKeyId?: number | null;
  onBehalfOfUserId?: number | null;
}

export type MatterOpenTransition = "opened" | "reopened" | "updated" | "unchanged";
export type MatterCloseTransition = "closed" | "unchanged" | "absent";

/** The key is held by another writer: one writer per matter (a mirror's kind is the server's, an agent's the agent's). */
export class MatterWriterConflictError extends Error {
  constructor(readonly key: string, readonly heldBy: MatterSource) {
    super(`Matter "${key}" is written by ${heldBy}`);
    this.name = "MatterWriterConflictError";
  }
}

/** Who reads matters: the owner reads every one; anyone else their own (a team lead also their role's, on their pages), never one with money. */
export interface MatterViewer {
  userId: number;
  role: MatterOwnerRole;
  /** The pages the person reaches (a team lead's role matters are cut to them). */
  pageIds: readonly number[];
}

const LOCK_SEED = 551_830_417;

type MatterDbRow = {
  id: string | number | bigint;
  reason_key: string;
  kind: string;
  source: MatterSource;
  state: "open" | "closed";
  closed_how: MatterCloseHow | null;
  title: string;
  object_type: string | null;
  object_id: string | null;
  page_ids: Array<string | number | bigint> | null;
  owner_user_id: string | number | bigint | null;
  owner_role: MatterOwnerRole | null;
  watcher_user_ids: Array<string | number | bigint> | null;
  money: boolean;
  evidence: Record<string, unknown> | null;
  link: string | null;
  opened_at: Date | string;
  last_seen_at: Date | string;
  updated_at: Date | string;
  closed_at: Date | string | null;
};

const COLUMN_NAMES = [
  "id", "reason_key", "kind", "source", "state", "closed_how", "title", "object_type", "object_id", "page_ids", "owner_user_id",
  "owner_role", "watcher_user_ids", "money", "evidence", "link", "opened_at", "last_seen_at", "updated_at", "closed_at",
] as const;
const COLUMNS = sql.raw(COLUMN_NAMES.join(", "));
/** The same, of `matters m`. */
const M_COLUMNS = sql.raw(COLUMN_NAMES.map((name) => `m.${name}`).join(", "));

const numbers = (values: Array<string | number | bigint> | null) => (values ?? []).map((value) => Number(value));
const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;

function matterOf(row: MatterDbRow): MatterRow {
  return {
    id: Number(row.id),
    key: row.reason_key,
    kind: row.kind,
    source: row.source,
    state: row.state,
    closedHow: row.closed_how,
    title: row.title,
    object: row.object_type === null || row.object_id === null ? null : { type: row.object_type, id: row.object_id },
    pageIds: numbers(row.page_ids),
    owner: row.owner_user_id !== null ? { userId: Number(row.owner_user_id) } : { role: row.owner_role ?? "owner" },
    watcherUserIds: numbers(row.watcher_user_ids),
    money: row.money,
    evidence: row.evidence ?? {},
    link: row.link,
    openedAt: new Date(row.opened_at),
    lastSeenAt: new Date(row.last_seen_at),
    updatedAt: new Date(row.updated_at),
    closedAt: row.closed_at === null ? null : new Date(row.closed_at),
  };
}

/** JSON with every object's keys in order: two evidences are the same when these are. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const sameList = (left: readonly number[], right: readonly number[]) =>
  left.length === right.length && [...left].sort((a, b) => a - b).every((value, index) => value === [...right].sort((a, b) => a - b)[index]);

/** What of a matter the finding changes: the names of the fields, for its history (none — the same finding). */
export function matterChanges(existing: MatterRow, input: MatterOpenInput): string[] {
  const changed: string[] = [];
  if (existing.title !== input.title) changed.push("title");
  if (stableJson(existing.object) !== stableJson(input.object)) changed.push("object");
  if (!sameList(existing.pageIds, input.pageIds)) changed.push("pages");
  if (stableJson(existing.owner) !== stableJson(input.owner)) changed.push("owner");
  if (!sameList(existing.watcherUserIds, input.watcherUserIds ?? [])) changed.push("watchers");
  if (existing.money !== input.money) changed.push("money");
  if (stableJson(existing.evidence) !== stableJson(input.evidence)) changed.push("evidence");
  if (existing.link !== input.link) changed.push("link");
  return changed;
}

function ownerColumns(owner: MatterOwner): { userId: number | null; role: MatterOwnerRole | null } {
  return "userId" in owner ? { userId: owner.userId, role: null } : { userId: null, role: owner.role };
}

async function lockKey(db: Database, key: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, ${LOCK_SEED}))`);
}

async function lockedMatter(db: Database, key: string): Promise<MatterRow | null> {
  const found = await db.execute<MatterDbRow>(sql`select ${COLUMNS} from matters where reason_key = ${key} for update`);
  return found.rows[0] ? matterOf(found.rows[0]) : null;
}

async function insertEvent(
  db: Database,
  input: { objectType: string; objectId: string; event: string; actor: MatterActor; changes: Record<string, unknown>; at: Date },
): Promise<number> {
  const result = await db.execute<{ id: string | number | bigint }>(sql`
    insert into object_events (object_type, object_id, event, actor_user_id, actor_agent_key_id, on_behalf_of_user_id, door, changes, created_at)
    values (${input.objectType}, ${input.objectId}, ${input.event}, ${input.actor.userId ?? null}, ${input.actor.agentKeyId ?? null},
      ${input.actor.onBehalfOfUserId ?? null}, ${input.actor.door}, ${JSON.stringify(input.changes)}::jsonb, ${input.at.toISOString()}::timestamptz)
    returning id`);
  return Number(result.rows[0]!.id);
}

const matterEvent = (db: Database, matter: MatterRow, event: string, actor: MatterActor, changes: Record<string, unknown>, at: Date) =>
  insertEvent(db, { objectType: "matter", objectId: String(matter.id), event, actor, changes, at });

/**
 * Opens the matter of `key`, or updates the open one (its last confirmation
 * always; its fields when the finding changed), or reopens the closed one.
 * Refuses a key another writer holds (`MatterWriterConflictError`).
 */
export async function openMatter(
  db: Database,
  input: MatterOpenInput,
  actor: MatterActor,
  now: Date = new Date(),
): Promise<{ matter: MatterRow; transition: MatterOpenTransition }> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockKey(txDb, input.key);
    const existing = await lockedMatter(txDb, input.key);
    const owner = ownerColumns(input.owner);
    const at = now.toISOString();
    const fields = sql`title = ${input.title}, object_type = ${input.object?.type ?? null}, object_id = ${input.object?.id ?? null},
      page_ids = ${ids(input.pageIds)}, owner_user_id = ${owner.userId}, owner_role = ${owner.role},
      watcher_user_ids = ${ids(input.watcherUserIds ?? [])}, money = ${input.money}, evidence = ${JSON.stringify(input.evidence)}::jsonb,
      link = ${input.link}`;

    if (existing === null) {
      const inserted = await txDb.execute<MatterDbRow>(sql`
        insert into matters (reason_key, kind, source, title, object_type, object_id, page_ids, owner_user_id, owner_role,
          watcher_user_ids, money, evidence, link, opened_at, last_seen_at, updated_at)
        values (${input.key}, ${input.kind}, ${input.source}, ${input.title}, ${input.object?.type ?? null}, ${input.object?.id ?? null},
          ${ids(input.pageIds)}, ${owner.userId}, ${owner.role}, ${ids(input.watcherUserIds ?? [])}, ${input.money},
          ${JSON.stringify(input.evidence)}::jsonb, ${input.link}, ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz)
        returning ${COLUMNS}`);
      const matter = matterOf(inserted.rows[0]!);
      await matterEvent(txDb, matter, "matter.opened", actor, {
        kind: matter.kind, source: matter.source, owner: matter.owner, pageIds: matter.pageIds, object: matter.object, money: matter.money,
      }, now);
      return { matter, transition: "opened" as const };
    }

    if (existing.source !== input.source) throw new MatterWriterConflictError(input.key, existing.source);
    const changed = matterChanges(existing, input);

    if (existing.state === "closed") {
      const reopened = await txDb.execute<MatterDbRow>(sql`
        update matters set state = 'open', closed_how = null, closed_at = null, ${fields},
          opened_at = ${at}::timestamptz, last_seen_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
        where id = ${existing.id} returning ${COLUMNS}`);
      const matter = matterOf(reopened.rows[0]!);
      await matterEvent(txDb, matter, "matter.reopened", actor, { fields: changed }, now);
      return { matter, transition: "reopened" as const };
    }

    if (changed.length === 0) {
      const touched = await txDb.execute<MatterDbRow>(sql`
        update matters set last_seen_at = greatest(last_seen_at, ${at}::timestamptz) where id = ${existing.id} returning ${COLUMNS}`);
      return { matter: matterOf(touched.rows[0]!), transition: "unchanged" as const };
    }

    const updated = await txDb.execute<MatterDbRow>(sql`
      update matters set ${fields}, last_seen_at = greatest(last_seen_at, ${at}::timestamptz), updated_at = ${at}::timestamptz
      where id = ${existing.id} returning ${COLUMNS}`);
    const matter = matterOf(updated.rows[0]!);
    await matterEvent(txDb, matter, "matter.updated", actor, { fields: changed }, now);
    return { matter, transition: "updated" as const };
  });
}

/**
 * Closes the matter of `key`. A closed one stays as it was (`unchanged`); a key
 * never opened is `absent`. With `writer`, a matter another writer holds is
 * refused (`MatterWriterConflictError`).
 */
export async function closeMatter(
  db: Database,
  input: { key: string; how: MatterCloseHow; note?: string | null; writer?: MatterSource },
  actor: MatterActor,
  now: Date = new Date(),
): Promise<{ matter: MatterRow | null; transition: MatterCloseTransition }> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockKey(txDb, input.key);
    const existing = await lockedMatter(txDb, input.key);
    if (existing === null) return { matter: null, transition: "absent" as const };
    if (input.writer !== undefined && existing.source !== input.writer) throw new MatterWriterConflictError(input.key, existing.source);
    if (existing.state === "closed") return { matter: existing, transition: "unchanged" as const };
    const at = now.toISOString();
    const closed = await txDb.execute<MatterDbRow>(sql`
      update matters set state = 'closed', closed_how = ${input.how}, closed_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
      where id = ${existing.id} returning ${COLUMNS}`);
    const matter = matterOf(closed.rows[0]!);
    await matterEvent(txDb, matter, "matter.closed", actor, {
      how: input.how, ...(input.note ? { note: input.note } : {}),
    }, now);
    return { matter, transition: "closed" as const };
  });
}

/** A comment on the matter of `key`, in its history; null — no such matter. */
export async function commentMatter(
  db: Database,
  input: { key: string; text: string },
  actor: MatterActor,
  now: Date = new Date(),
): Promise<{ matter: MatterRow; eventId: number } | null> {
  const matter = await findMatterByKey(db, input.key);
  if (matter === null) return null;
  const eventId = await matterEvent(db, matter, "matter.comment", actor, { text: input.text }, now);
  return { matter, eventId };
}

/** The open matters of `keys` confirmed again at `now`, in one statement (a mirror's unchanged findings). */
export async function touchMatters(db: Database, keys: readonly string[], now: Date = new Date()): Promise<void> {
  if (keys.length === 0) return;
  await db.execute(sql`
    update matters set last_seen_at = greatest(last_seen_at, ${now.toISOString()}::timestamptz)
    where reason_key = any(${sql.param([...keys])}::text[]) and state = 'open'`);
}

export async function findMatterByKey(db: Database, key: string): Promise<MatterRow | null> {
  const found = await db.execute<MatterDbRow>(sql`select ${COLUMNS} from matters where reason_key = ${key}`);
  return found.rows[0] ? matterOf(found.rows[0]) : null;
}

/** Every open matter of the kinds, whoever owns it: a mirror's reconcile. */
export async function listOpenMattersOfKinds(db: Database, kinds: readonly string[]): Promise<MatterRow[]> {
  if (kinds.length === 0) return [];
  const found = await db.execute<MatterDbRow>(sql`
    select ${COLUMNS} from matters where state = 'open' and kind = any(${sql.param([...kinds])}::text[]) order by opened_at, id`);
  return found.rows.map(matterOf);
}

/**
 * Who reads a matter (the rights of every door): the owner — every matter; a
 * team lead — their own, and their role's on their pages (a matter of no page
 * is every page's); a chatter — their own. Nobody but the owner reads a matter
 * with money.
 */
export function matterVisibility(viewer: MatterViewer): SQL {
  if (viewer.role === "owner") return sql`true`;
  if (viewer.role === "team_lead") {
    return sql`(not m.money and (m.owner_user_id = ${viewer.userId}
      or (m.owner_role = 'team_lead' and (cardinality(m.page_ids) = 0 or m.page_ids && ${ids(viewer.pageIds)}))))`;
  }
  return sql`(not m.money and m.owner_user_id = ${viewer.userId})`;
}

/**
 * The matters that wait for the viewer THEMSELF, within what they may read: their
 * user's, or a role they hold (`heldRoles`). Not who may read: the owner reads
 * every matter, but «Ждут вас» and its number are only what waits for them.
 */
export function matterHeldBy(viewer: MatterViewer, heldRoles: readonly MatterOwnerRole[]): SQL {
  if (heldRoles.length === 0) return sql`(m.owner_user_id = ${viewer.userId})`;
  return sql`(m.owner_user_id = ${viewer.userId} or m.owner_role = any(${sql.param([...heldRoles])}::text[]))`;
}

/**
 * Whether someone holds the team lead's role now: a living login of that role
 * whose person has not left, or a working person of that role in the registry.
 * Nobody — the owner is the acting team lead.
 */
export async function teamLeadRoleHeld(db: Database): Promise<boolean> {
  const result = await db.execute<{ held: boolean }>(sql`
    select (
      exists (
        select 1 from users u
         where u.role = 'team_lead' and u.disabled_at is null and u.deleted_at is null
           and not exists (select 1 from person_logins l join people p on p.id = l.person_id where l.user_id = u.id and p.state = 'left')
      )
      or exists (select 1 from people p where p.role = 'team_lead' and p.state = 'working')
    ) as held`);
  return result.rows[0]?.held === true;
}

export async function listVisibleMatters(
  db: Database,
  input: {
    viewer: MatterViewer;
    state: "open" | "closed";
    kinds?: readonly string[] | undefined;
    /** Only matters of this page (a matter of no page is every page's). */
    pageId?: number | undefined;
    /** Leave out every matter with money, whoever reads (a narrow door). */
    withoutMoney?: boolean;
    /** Only what waits for the viewer themself: their user's or one of these roles' (`matterHeldBy`). */
    heldRoles?: readonly MatterOwnerRole[] | undefined;
    limit: number;
  },
): Promise<MatterRow[]> {
  const parts: SQL[] = [sql`m.state = ${input.state}`, matterVisibility(input.viewer)];
  if (input.heldRoles !== undefined) parts.push(matterHeldBy(input.viewer, input.heldRoles));
  if (input.kinds !== undefined) parts.push(sql`m.kind = any(${sql.param([...input.kinds])}::text[])`);
  if (input.pageId !== undefined) parts.push(sql`(cardinality(m.page_ids) = 0 or ${input.pageId}::bigint = any(m.page_ids))`);
  if (input.withoutMoney) parts.push(sql`not m.money`);
  // The open: the longest waiting first. The closed: the last closed first.
  const order = input.state === "open" ? sql`m.opened_at, m.id` : sql`m.closed_at desc, m.id desc`;
  const found = await db.execute<MatterDbRow>(sql`
    select ${M_COLUMNS}
    from matters m
    where ${sql.join(parts, sql` and `)}
    order by ${order}
    limit ${input.limit}`);
  return found.rows.map(matterOf);
}

export interface ObjectEventRow {
  id: number;
  objectType: string;
  objectId: string;
  event: string;
  actorUserId: number | null;
  actorAgentKeyId: number | null;
  onBehalfOfUserId: number | null;
  door: MatterDoor;
  changes: Record<string, unknown>;
  createdAt: Date;
}

/** A thing's history, the oldest first. */
export async function listObjectEvents(db: Database, input: { objectType: string; objectId: string; limit?: number }): Promise<ObjectEventRow[]> {
  const found = await db.execute<{
    id: string | number | bigint; object_type: string; object_id: string; event: string;
    actor_user_id: string | number | bigint | null; actor_agent_key_id: string | number | bigint | null;
    on_behalf_of_user_id: string | number | bigint | null; door: MatterDoor; changes: Record<string, unknown> | null; created_at: Date | string;
  }>(sql`
    select id, object_type, object_id, event, actor_user_id, actor_agent_key_id, on_behalf_of_user_id, door, changes, created_at
    from object_events where object_type = ${input.objectType} and object_id = ${input.objectId}
    order by id limit ${input.limit ?? 200}`);
  const num = (value: string | number | bigint | null) => (value === null ? null : Number(value));
  return found.rows.map((row) => ({
    id: Number(row.id),
    objectType: row.object_type,
    objectId: row.object_id,
    event: row.event,
    actorUserId: num(row.actor_user_id),
    actorAgentKeyId: num(row.actor_agent_key_id),
    onBehalfOfUserId: num(row.on_behalf_of_user_id),
    door: row.door,
    changes: row.changes ?? {},
    createdAt: new Date(row.created_at),
  }));
}

// ── The mirrors' checks ─────────────────────────────────────────────────────

export interface MatterCheckRow {
  kind: string;
  attemptedAt: Date;
  /** The last time the source answered; null — never. */
  answeredAt: Date | null;
  /** Why the last attempt failed; null — it answered. */
  error: string | null;
  /** The kind is shown at all (the OnlyFans history requests only while the OnlyFans API is on). */
  applicable: boolean;
  /** The source's read hit its limit: there are at least this many. */
  capped: boolean;
  /** The old list's count from the last answer, and the matters' own after it. */
  legacyCount: number | null;
  matterCount: number | null;
  /** Since when the two counts differ; null — they agree. */
  mismatchSince: Date | null;
}

type CheckDbRow = {
  kind: string; attempted_at: Date | string; answered_at: Date | string | null; error: string | null; applicable: boolean; capped: boolean;
  legacy_count: number | null; matter_count: number | null; mismatch_since: Date | string | null;
};

const dateOrNull = (value: Date | string | null) => (value === null ? null : new Date(value));

/** The source of `kind` answered at `at`: its counts side by side; a mismatch keeps its first moment. */
export async function recordMatterCheckAnswered(
  db: Database,
  input: { kind: string; at: Date; applicable: boolean; capped: boolean; legacyCount: number; matterCount: number },
): Promise<MatterCheckRow> {
  const at = input.at.toISOString();
  const mismatch = input.legacyCount !== input.matterCount;
  const result = await db.execute<CheckDbRow>(sql`
    insert into matter_checks (kind, attempted_at, answered_at, error, applicable, capped, legacy_count, matter_count, mismatch_since, updated_at)
    values (${input.kind}, ${at}::timestamptz, ${at}::timestamptz, null, ${input.applicable}, ${input.capped}, ${input.legacyCount},
      ${input.matterCount}, ${mismatch ? at : null}::timestamptz, clock_timestamp())
    on conflict (kind) do update set
      attempted_at = excluded.attempted_at, answered_at = excluded.answered_at, error = null, applicable = excluded.applicable,
      capped = excluded.capped, legacy_count = excluded.legacy_count, matter_count = excluded.matter_count,
      mismatch_since = case when ${mismatch} then coalesce(matter_checks.mismatch_since, excluded.mismatch_since) else null end,
      updated_at = clock_timestamp()
    returning kind, attempted_at, answered_at, error, applicable, capped, legacy_count, matter_count, mismatch_since`);
  return checkOf(result.rows[0]!);
}

/** The source of `kind` did not answer at `at`: what it said last stays, the kind reads «не проверено». */
export async function recordMatterCheckFailed(db: Database, input: { kind: string; at: Date; error: string }): Promise<void> {
  const at = input.at.toISOString();
  await db.execute(sql`
    insert into matter_checks (kind, attempted_at, error, updated_at)
    values (${input.kind}, ${at}::timestamptz, ${input.error.slice(0, 300)}, clock_timestamp())
    on conflict (kind) do update set attempted_at = excluded.attempted_at, error = excluded.error, updated_at = clock_timestamp()`);
}

export async function listMatterChecks(db: Database): Promise<MatterCheckRow[]> {
  const result = await db.execute<CheckDbRow>(sql`
    select kind, attempted_at, answered_at, error, applicable, capped, legacy_count, matter_count, mismatch_since from matter_checks order by kind`);
  return result.rows.map(checkOf);
}

function checkOf(row: CheckDbRow): MatterCheckRow {
  return {
    kind: row.kind,
    attemptedAt: new Date(row.attempted_at),
    answeredAt: dateOrNull(row.answered_at),
    error: row.error,
    applicable: row.applicable,
    capped: row.capped,
    legacyCount: row.legacy_count === null ? null : Number(row.legacy_count),
    matterCount: row.matter_count === null ? null : Number(row.matter_count),
    mismatchSince: dateOrNull(row.mismatch_since),
  };
}

// ── Names for the wire ──────────────────────────────────────────────────────

/** id → label of every page (a handful), and label → id: matters keep ids, the screens speak labels. */
export async function listMatterPageLabels(db: Database): Promise<{ labelOf: Map<number, string>; idOf: Map<string, number> }> {
  const result = await db.execute<{ id: string | number | bigint; label: string }>(sql`select id, label from pages`);
  const labelOf = new Map<number, string>();
  const idOf = new Map<string, number>();
  for (const row of result.rows) {
    labelOf.set(Number(row.id), row.label);
    idOf.set(row.label, Number(row.id));
  }
  return { labelOf, idOf };
}

/** id → login of the users named, and their person's name. */
export async function listMatterUsernames(db: Database, userIds: readonly number[]): Promise<Map<number, { username: string; displayName: string | null }>> {
  if (userIds.length === 0) return new Map();
  // With the person's name where the login is a person's (the people registry), in one read.
  const result = await db.execute<{ id: string | number | bigint; username: string; display_name: string | null }>(sql`
    select u.id, u.username, p.display_name
      from users u
      left join person_logins l on l.user_id = u.id
      left join people p on p.id = l.person_id
     where u.id = any(${ids([...new Set(userIds)])})`);
  return new Map(result.rows.map((row) => [Number(row.id), { username: row.username, displayName: row.display_name ?? null }]));
}

/** A living, enabled user by login (case aside); null — none. */
export async function findMatterPerson(db: Database, username: string): Promise<{ userId: number; role: MatterOwnerRole } | null> {
  const result = await db.execute<{ id: string | number | bigint; role: MatterOwnerRole }>(sql`
    select id, role from users where lower(username) = lower(${username}) and deleted_at is null and disabled_at is null limit 1`);
  const row = result.rows[0];
  return row ? { userId: Number(row.id), role: row.role } : null;
}

/** The viewer's open matters per kind. */
export async function countVisibleOpenMatters(
  db: Database,
  input: { viewer: MatterViewer; withoutMoney?: boolean; heldRoles?: readonly MatterOwnerRole[] | undefined },
): Promise<Map<string, number>> {
  const result = await db.execute<{ kind: string; open: string | number | bigint }>(sql`
    select m.kind, count(*) as open from matters m
    where m.state = 'open' and ${matterVisibility(input.viewer)} ${input.withoutMoney ? sql`and not m.money` : sql``}
      ${input.heldRoles === undefined ? sql`` : sql`and ${matterHeldBy(input.viewer, input.heldRoles)}`}
    group by m.kind`);
  return new Map(result.rows.map((row) => [row.kind, Number(row.open)]));
}
