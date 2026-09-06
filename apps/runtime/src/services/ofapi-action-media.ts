import { sql } from "drizzle-orm";
import type { Database } from "@agency_hub_core/db";
import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, ConflictError } from "./errors.ts";

const nativeId = /^[1-9][0-9]{0,63}$/;
const cdnToken = /^ofapi_media_[A-Za-z0-9_-]{1,128}$/;
type MediaCommand = { pageId: number } & Record<string, unknown>;
function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }

/** Validate retained custody only. The supplied database keeps dispatch-time checks under the caller's lock. */
export async function validateOfapiActionMedia(app: AppContext, command: MediaCommand, accountId: string, db: Database = app.db): Promise<string[]> {
  const references: unknown[] = [];
  for (const field of ["mediaFiles", "previews"] as const) {
    if (command[field] === undefined) continue;
    if (!Array.isArray(command[field])) throw new BadRequestError("Media selections must be arrays of stored IDs");
    references.push(...command[field]);
  }
  for (const field of ["avatar", "header"] as const) if (command[field] !== undefined) references.push(command[field]);
  if (references.some(value => typeof value !== "string" || (!nativeId.test(value) && !cdnToken.test(value)))) throw new BadRequestError("Choose stored vault IDs or completed upload IDs");
  const unique = [...new Set(references as string[])].sort();
  const tokens: string[] = [];
  for (const reference of unique) {
    if (nativeId.test(reference)) {
      const media = (await db.execute<{ is_ready: boolean | null; has_error: boolean | null; can_view: boolean | null }>(sql`
        select is_ready,has_error,can_view from ofapi_media_catalog
        where page_id=${command.pageId} and account_id=${accountId} and material_kind='vault' and media_ref=${reference}
        for share
      `)).rows[0];
      if (!media || media.is_ready !== true || media.has_error === true || media.can_view === false) throw new ConflictError("Refresh this account's vault metadata until every selected material is available and ready");
      continue;
    }
    // CDN projection IDs are hashes; the upload job retains the authoritative one-use token.
    const uploads = (await db.execute<{ cursor: unknown }>(sql`
      select cursor from ofapi_capture_jobs
      where page_id=${command.pageId} and ofapi_account_id=${accountId} and kind='media_upload'
        and state='complete' and target->>'destination'='cdn' and cursor->>'status'='completed' and cursor->>'mediaRef'=${reference}
      for share
    `)).rows;
    if (!uploads.some(upload => {
      const cursor = object(upload.cursor);
      return cursor?.mediaRef === reference && cursor.status === "completed" && cursor.hasError !== true && cursor.isReady !== false;
    })) throw new ConflictError("Every one-use material needs a completed upload for this account before it can be used");
    tokens.push(reference);
  }
  return tokens;
}

/** Called inside the action claim transaction. Nested savepoints also make a multi-token refusal atomic. */
export async function reserveOfapiActionMedia(db: Database, intentId: string, accountId: string, tokens: string[]): Promise<void> {
  if (tokens.some(token => !cdnToken.test(token))) throw new BadRequestError("Only completed one-use upload tokens can be reserved");
  const unique = [...new Set(tokens)].sort();
  if (!unique.length) return;
  await db.transaction(async tx => {
    for (const token of unique) {
      await tx.execute(sql`insert into ofapi_media_token_custody(account_id,token,operation_id,command_id,action_intent_id)
        values(${accountId},${token},${intentId}::uuid,null,${intentId}::uuid) on conflict do nothing`);
      const held = (await tx.execute<{ operation_id: string; command_id: string | null; action_intent_id: string | null }>(sql`
        select operation_id,command_id,action_intent_id from ofapi_media_token_custody
        where account_id=${accountId} and token=${token} for update
      `)).rows[0];
      if (held?.operation_id !== intentId || held.action_intent_id !== intentId || held.command_id !== null) throw new ConflictError("This one-use material is already reserved by another action or chat send");
    }
  });
}
