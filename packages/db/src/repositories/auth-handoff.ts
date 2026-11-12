import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// One-time sign-in codes between the names Hub serves (0388,
// apps/runtime/src/services/signin-handoff.ts). Raw SQL: no query-builder
// table. Every code is single use: the claim locks the row and marks it used in
// the transaction that acts on it, so two requests with one code cannot both win.

export type HandoffCodeKind = "session" | "narrow" | "server";

export interface HandoffCodeRecord {
  id: number;
  kind: HandoffCodeKind;
  target: string;
  userId: number;
  sessionId: number | null;
  deviceTokenId: number | null;
  stateDigest: string | null;
  sealedSession: string | null;
  next: string;
  expiresAt: Date;
  usedAt: Date | null;
}

type Row = Record<string, unknown>;

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function codeOf(row: Row): HandoffCodeRecord {
  return {
    id: Number(row.id),
    kind: row.kind as HandoffCodeKind,
    target: String(row.target),
    userId: Number(row.user_id),
    sessionId: nullableNumber(row.session_id),
    deviceTokenId: nullableNumber(row.device_token_id),
    stateDigest: (row.state_digest as string | null) ?? null,
    sealedSession: (row.sealed_session as string | null) ?? null,
    next: String(row.next),
    expiresAt: date(row.expires_at),
    usedAt: row.used_at === null || row.used_at === undefined ? null : date(row.used_at),
  };
}

const CODE_COLUMNS = sql`id, kind, target, user_id, session_id, device_token_id, state_digest, sealed_session, next, expires_at, used_at`;

export interface NewHandoffCode {
  codeDigest: string;
  kind: HandoffCodeKind;
  target: string;
  userId: number;
  sessionId: number | null;
  deviceTokenId: number | null;
  stateDigest: string | null;
  sealedSession: string | null;
  next: string;
  expiresAt: Date;
}

export async function insertHandoffCode(db: Database, input: NewHandoffCode): Promise<void> {
  await db.execute(sql`
    insert into auth_handoff_codes
      (code_digest, kind, target, user_id, session_id, device_token_id, state_digest, sealed_session, next, expires_at)
    values (${input.codeDigest}, ${input.kind}, ${input.target}, ${input.userId}, ${input.sessionId},
            ${input.deviceTokenId}, ${input.stateDigest}, ${input.sealedSession}, ${input.next}, ${input.expiresAt})
  `);
}

/**
 * The code behind a digest, locked for the rest of the transaction (FOR UPDATE),
 * used or not: the caller decides, and marks it used with `markHandoffCodeUsed`
 * in the same transaction. Null — no such code.
 */
export async function lockHandoffCode(db: Database, codeDigest: string): Promise<HandoffCodeRecord | null> {
  const result = await db.execute<Row>(sql`
    select ${CODE_COLUMNS} from auth_handoff_codes where code_digest = ${codeDigest} for update
  `);
  const row = result.rows[0];
  return row === undefined ? null : codeOf(row);
}

/** Spent: used now, the sealed session dropped; a server code keeps the digest of its grant. */
export async function markHandoffCodeUsed(
  db: Database,
  input: { id: number; grantDigest?: string | null },
): Promise<void> {
  await db.execute(sql`
    update auth_handoff_codes
       set used_at = clock_timestamp(), sealed_session = null, grant_digest = ${input.grantDigest ?? null}
     where id = ${input.id} and used_at is null
  `);
}

export interface HandoffGrantRecord {
  target: string;
  userId: number;
  sessionId: number;
}

/** The server sign-in a grant handle names (a used server code), or null. Reads only. */
export async function findHandoffGrant(db: Database, grantDigest: string): Promise<HandoffGrantRecord | null> {
  const result = await db.execute<Row>(sql`
    select target, user_id, session_id from auth_handoff_codes
     where grant_digest = ${grantDigest} and kind = 'server' and used_at is not null
  `);
  const row = result.rows[0];
  return row === undefined || row.session_id === null
    ? null
    : { target: String(row.target), userId: Number(row.user_id), sessionId: Number(row.session_id) };
}

/** A session row by id, for the server client's redeem and re-check (it has no token). Reads only. */
export async function findHandoffSession(db: Database, sessionId: number): Promise<{
  userId: number;
  expiresAt: Date;
  revokedAt: Date | null;
  narrowDeviceTokenId: number | null;
} | null> {
  const result = await db.execute<Row>(sql`
    select user_id, expires_at, revoked_at, narrow_device_token_id from auth_sessions where id = ${sessionId}
  `);
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
      userId: Number(row.user_id),
      expiresAt: date(row.expires_at),
      revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : date(row.revoked_at),
      narrowDeviceTokenId: nullableNumber(row.narrow_device_token_id),
    };
}

/**
 * The nightly retention sweep (worker-services.ts, `fansly.raw-payload-cleanup`): the codes that can no longer be
 * accepted or redeemed go — used, or past their minute — an hour after that, so a code is never taken from under its
 * own accept. A redeemed server code is the handle its service re-checks the sign-in with (`grant_digest`,
 * sso/check): it stays while the Hub session behind it lives and goes once that session is revoked or past its end.
 * Credentials Hub minted, never a captured fact; `authSso` is a GET that mints a row each time it is asked.
 */
export async function deleteSpentHandoffCodes(db: Database, now: Date): Promise<number> {
  const result = await db.execute(sql`
    delete from auth_handoff_codes c
     where coalesce(c.used_at, c.expires_at) < ${now.toISOString()}::timestamptz - interval '1 hour'
       and not (
         c.kind = 'server' and c.used_at is not null and exists (
           select 1 from auth_sessions s
            where s.id = c.session_id and s.revoked_at is null and s.expires_at > ${now.toISOString()}::timestamptz))
  `);
  return result.rowCount ?? 0;
}
