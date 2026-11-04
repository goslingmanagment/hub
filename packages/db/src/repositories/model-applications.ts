import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Model questionnaires from the agency site (0353): raw SQL over
// model_applications. The public intake (services/model-applications.ts)
// writes; the hub CLI reads. Sensitive personal data — never in logs.

export type ModelApplicationGoogleStatus = "recorded" | "failed" | "skipped";

export interface ModelApplicationAnswer {
  section: string;
  key: string;
  label: string;
  value: string;
}

export type ModelApplicationGoogleFields = Record<string, string | string[]>;

export interface ModelApplicationRow {
  id: number;
  createdAt: Date;
  form: string;
  answers: ModelApplicationAnswer[];
  googleFields: ModelApplicationGoogleFields | null;
  googleStatus: ModelApplicationGoogleStatus;
  googleError: string | null;
  ipHash: string;
  userAgent: string | null;
}

const MODEL_APPLICATION_IP_LOCK_SEED = 615_204_377;

type RawModelApplicationRow = {
  id: string | number;
  created_at: Date | string;
  form: string;
  answers: unknown;
  google_fields: unknown;
  google_status: ModelApplicationGoogleStatus;
  google_error: string | null;
  ip_hash: string;
  user_agent: string | null;
};

function mapRow(row: RawModelApplicationRow): ModelApplicationRow {
  return {
    id: Number(row.id),
    createdAt: new Date(row.created_at),
    form: row.form,
    answers: Array.isArray(row.answers) ? (row.answers as ModelApplicationAnswer[]) : [],
    googleFields: row.google_fields !== null && typeof row.google_fields === "object"
      ? (row.google_fields as ModelApplicationGoogleFields)
      : null,
    googleStatus: row.google_status,
    googleError: row.google_error,
    ipHash: row.ip_hash,
    userAgent: row.user_agent,
  };
}

/**
 * Stores one questionnaire unless its address already has `maxPerWindow`
 * stored within `windowMs`. The count and the insert share one transaction
 * under a per-address advisory lock, so concurrent submissions from one
 * address cannot pass the limit together.
 */
export async function insertModelApplicationWithinLimit(
  db: Database,
  input: {
    form: string;
    answers: ModelApplicationAnswer[];
    googleFields: ModelApplicationGoogleFields | null;
    googleStatus: ModelApplicationGoogleStatus;
    googleError: string | null;
    ipHash: string;
    userAgent: string | null;
    maxPerWindow: number;
    windowMs: number;
    now?: Date;
  },
): Promise<{ status: "stored"; id: number } | { status: "rate_limited" }> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - input.windowMs);
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${input.ipHash}, ${MODEL_APPLICATION_IP_LOCK_SEED}))`);
    const counted = await tx.execute<{ count: string | number }>(sql`
      select count(*) as count from model_applications
      where ip_hash = ${input.ipHash} and created_at > ${since.toISOString()}::timestamptz`);
    if (Number(counted.rows[0]?.count ?? 0) >= input.maxPerWindow) {
      return { status: "rate_limited" as const };
    }
    const inserted = await tx.execute<{ id: string | number }>(sql`
      insert into model_applications
        (created_at, form, answers, google_fields, google_status, google_error, ip_hash, user_agent)
      values (${now.toISOString()}::timestamptz, ${input.form}, ${JSON.stringify(input.answers)}::jsonb,
              ${input.googleFields === null ? null : JSON.stringify(input.googleFields)}::jsonb,
              ${input.googleStatus}, ${input.googleError}, ${input.ipHash}, ${input.userAgent})
      returning id`);
    const id = inserted.rows[0]?.id;
    if (id === undefined) {
      throw new Error("model_applications insert returned no id");
    }
    return { status: "stored" as const, id: Number(id) };
  });
}

/** The id the next stored questionnaire would most likely get; writes nothing. */
export async function peekNextModelApplicationId(db: Database): Promise<number> {
  const result = await db.execute<{ next_id: string | number }>(sql`
    select coalesce(max(id), 0) + 1 as next_id from model_applications`);
  return Number(result.rows[0]?.next_id ?? 1);
}

export async function setModelApplicationGoogleResult(
  db: Database,
  input: { id: number; status: ModelApplicationGoogleStatus; error: string | null },
): Promise<void> {
  await db.execute(sql`
    update model_applications set google_status = ${input.status}, google_error = ${input.error}
    where id = ${input.id}`);
}

export async function listModelApplications(
  db: Database,
  input: { limit: number },
): Promise<ModelApplicationRow[]> {
  const result = await db.execute<RawModelApplicationRow>(sql`
    select id, created_at, form, answers, google_fields, google_status, google_error, ip_hash, user_agent
    from model_applications
    order by id desc
    limit ${input.limit}`);
  return result.rows.map(mapRow);
}

export async function getModelApplication(db: Database, id: number): Promise<ModelApplicationRow | null> {
  const result = await db.execute<RawModelApplicationRow>(sql`
    select id, created_at, form, answers, google_fields, google_status, google_error, ip_hash, user_agent
    from model_applications
    where id = ${id}`);
  const row = result.rows[0];
  return row === undefined ? null : mapRow(row);
}

// --- Fillings of the questionnaire (0354): the page's progress posts ---

export interface ModelApplicationSessionRow {
  session: string;
  form: string;
  startedAt: Date;
  updatedAt: Date;
  filled: number;
  total: number;
  section: string | null;
  name: string | null;
  startNotifiedAt: Date | null;
  abandonNotifiedAt: Date | null;
  submittedAt: Date | null;
  applicationId: number | null;
}

/** One filling with its latest answers snapshot (null — its page sent none). */
export interface ModelApplicationSessionDetail extends ModelApplicationSessionRow {
  answers: ModelApplicationAnswer[] | null;
}

type RawModelApplicationSessionRow = {
  session: string;
  form: string;
  started_at: Date | string;
  updated_at: Date | string;
  filled: number;
  total: number;
  section: string | null;
  name: string | null;
  start_notified_at: Date | string | null;
  abandon_notified_at: Date | string | null;
  submitted_at: Date | string | null;
  application_id: string | number | null;
};

const MODEL_APPLICATION_SESSION_IP_LOCK_SEED = 615_204_378;

function optionalDate(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}

function mapSessionRow(row: RawModelApplicationSessionRow): ModelApplicationSessionRow {
  return {
    session: row.session,
    form: row.form,
    startedAt: new Date(row.started_at),
    updatedAt: new Date(row.updated_at),
    filled: Number(row.filled),
    total: Number(row.total),
    section: row.section,
    name: row.name,
    startNotifiedAt: optionalDate(row.start_notified_at),
    abandonNotifiedAt: optionalDate(row.abandon_notified_at),
    submittedAt: optionalDate(row.submitted_at),
    applicationId: row.application_id === null ? null : Number(row.application_id),
  };
}

/**
 * One progress post: upserts the filling (a later post clears its abandon
 * mark, so a second abandonment can be reported), unless it is a new filling
 * and its address already started `maxNewPerWindow` within `newWindowMs`. The
 * start notice is claimed here, once per filling: the first post with
 * filled ≥ 1 of a filling not sent yet. Absent section or name keep the
 * stored ones.
 */
export async function recordModelApplicationProgress(
  db: Database,
  input: {
    session: string;
    form: string;
    filled: number;
    total: number;
    section: string | null;
    name: string | null;
    /** The latest answers snapshot; null keeps the stored one. */
    answers: ModelApplicationAnswer[] | null;
    ipHash: string;
    maxNewPerWindow: number;
    newWindowMs: number;
    now?: Date;
  },
): Promise<{ status: "rate_limited" } | { status: "recorded"; startClaimed: boolean; name: string | null }> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - input.newWindowMs);
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${input.ipHash}, ${MODEL_APPLICATION_SESSION_IP_LOCK_SEED}))`);
    const existing = await tx.execute(sql`
      select 1 from model_application_sessions where session = ${input.session}::uuid`);
    if (existing.rows.length === 0) {
      const counted = await tx.execute<{ count: string | number }>(sql`
        select count(*) as count from model_application_sessions
        where ip_hash = ${input.ipHash} and started_at > ${since.toISOString()}::timestamptz`);
      if (Number(counted.rows[0]?.count ?? 0) >= input.maxNewPerWindow) {
        return { status: "rate_limited" as const };
      }
    }
    await tx.execute(sql`
      insert into model_application_sessions
        (session, form, started_at, updated_at, filled, total, section, name, answers, ip_hash)
      values (${input.session}::uuid, ${input.form}, ${now.toISOString()}::timestamptz,
              ${now.toISOString()}::timestamptz, ${input.filled}, ${input.total},
              ${input.section}, ${input.name},
              ${input.answers === null ? null : JSON.stringify(input.answers)}::jsonb, ${input.ipHash})
      on conflict (session) do update set
        form = excluded.form,
        updated_at = excluded.updated_at,
        filled = excluded.filled,
        total = excluded.total,
        section = coalesce(excluded.section, model_application_sessions.section),
        name = coalesce(excluded.name, model_application_sessions.name),
        answers = coalesce(excluded.answers, model_application_sessions.answers),
        abandon_notified_at = null`);
    const claimed = await tx.execute<{ name: string | null }>(sql`
      update model_application_sessions set start_notified_at = ${now.toISOString()}::timestamptz
      where session = ${input.session}::uuid
        and start_notified_at is null and submitted_at is null and filled >= 1
      returning name`);
    const claimedRow = claimed.rows[0];
    return {
      status: "recorded" as const,
      startClaimed: claimedRow !== undefined,
      name: claimedRow?.name ?? null,
    };
  });
}

/** A stored questionnaire ends its filling: the filling is created if its page never reported it. */
export async function markModelApplicationSessionSubmitted(
  db: Database,
  input: {
    session: string;
    form: string;
    applicationId: number;
    name: string | null;
    ipHash: string;
    now?: Date;
  },
): Promise<void> {
  const now = (input.now ?? new Date()).toISOString();
  await db.execute(sql`
    insert into model_application_sessions
      (session, form, started_at, updated_at, name, ip_hash, submitted_at, application_id)
    values (${input.session}::uuid, ${input.form}, ${now}::timestamptz, ${now}::timestamptz,
            ${input.name}, ${input.ipHash}, ${now}::timestamptz, ${input.applicationId})
    on conflict (session) do update set
      updated_at = excluded.updated_at,
      submitted_at = excluded.submitted_at,
      application_id = excluded.application_id,
      name = coalesce(model_application_sessions.name, excluded.name)`);
}

/**
 * Claims the fillings left unsent: started (filled ≥ 1), not sent, not
 * reported yet, silent since `idleBefore`. Each is marked reported as it is
 * returned, so it is reported once — until a later post clears the mark.
 */
export async function claimAbandonedModelApplicationSessions(
  db: Database,
  input: { idleBefore: Date; limit: number; now?: Date },
): Promise<ModelApplicationSessionRow[]> {
  const now = (input.now ?? new Date()).toISOString();
  const result = await db.execute<RawModelApplicationSessionRow>(sql`
    update model_application_sessions s set abandon_notified_at = ${now}::timestamptz
    from (
      select session from model_application_sessions
      where submitted_at is null and filled >= 1 and abandon_notified_at is null
        and updated_at < ${input.idleBefore.toISOString()}::timestamptz
      order by updated_at
      limit ${input.limit}
      for update skip locked
    ) due
    where s.session = due.session
    returning s.session::text as session, s.form, s.started_at, s.updated_at, s.filled, s.total,
      s.section, s.name, s.start_notified_at, s.abandon_notified_at, s.submitted_at, s.application_id`);
  return result.rows.map(mapSessionRow);
}

export async function listRecentModelApplicationSessions(
  db: Database,
  input: { since: Date; limit: number },
): Promise<ModelApplicationSessionRow[]> {
  const result = await db.execute<RawModelApplicationSessionRow>(sql`
    select session::text as session, form, started_at, updated_at, filled, total, section, name,
      start_notified_at, abandon_notified_at, submitted_at, application_id
    from model_application_sessions
    where updated_at > ${input.since.toISOString()}::timestamptz
    order by updated_at desc
    limit ${input.limit}`);
  return result.rows.map(mapSessionRow);
}

export async function getModelApplicationSession(
  db: Database,
  session: string,
): Promise<ModelApplicationSessionDetail | null> {
  const result = await db.execute<RawModelApplicationSessionRow & { answers: unknown }>(sql`
    select session::text as session, form, started_at, updated_at, filled, total, section, name,
      start_notified_at, abandon_notified_at, submitted_at, application_id, answers
    from model_application_sessions
    where session = ${session}::uuid`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    ...mapSessionRow(row),
    answers: Array.isArray(row.answers) ? (row.answers as ModelApplicationAnswer[]) : null,
  };
}
