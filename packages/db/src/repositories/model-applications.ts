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
