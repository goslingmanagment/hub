import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";

export interface FollowerOutreachInput {
  pageId: number;
  fanRef: string;
  userId: number;
  attemptId: string;
  action: "reserve" | "dispatch" | "sent";
  messageRef?: string | undefined;
}

/** Serialize only this page/fan. A lease guards multiple browsers; persistent
 * dispatch custody guards indeterminate responses and event-page teardown. */
export async function transitionFollowerOutreach(db: Database, input: FollowerOutreachInput): Promise<{
  owned: boolean;
  state: "reserved" | "dispatching" | "sent" | "expired";
  expiresAt: string | null;
}> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`follower-outreach:${input.pageId}:${input.fanRef}`}, 0))`);
    if (input.action === "reserve") {
      await tx.execute(sql`update follower_outreach_attempts set state = 'expired', updated_at = now()
        where platform_account_id = ${input.pageId} and fan_ref = ${input.fanRef}
          and state = 'reserved' and expires_at <= now()`);
      await tx.execute(sql`insert into follower_outreach_attempts (attempt_id, platform_account_id, fan_ref, user_id, state, expires_at)
        values (${input.attemptId}::uuid, ${input.pageId}, ${input.fanRef}, ${input.userId}, 'reserved', now() + interval '60 seconds')
        on conflict do nothing`);
    } else if (input.action === "dispatch") {
      await tx.execute(sql`update follower_outreach_attempts set state = 'dispatching', updated_at = now()
        where attempt_id = ${input.attemptId}::uuid and platform_account_id = ${input.pageId}
          and fan_ref = ${input.fanRef} and user_id = ${input.userId} and state = 'reserved' and expires_at > now()`);
    } else {
      await tx.execute(sql`update follower_outreach_attempts set state = 'sent', message_ref = ${input.messageRef ?? null}, updated_at = now()
        where attempt_id = ${input.attemptId}::uuid and platform_account_id = ${input.pageId}
          and fan_ref = ${input.fanRef} and user_id = ${input.userId} and state = 'dispatching'`);
    }
    const result = await tx.execute<{ attempt_id: string; user_id: bigint; state: "reserved" | "dispatching" | "sent" | "expired"; expires_at: Date }>(sql`
      select a.attempt_id, a.user_id, a.state, a.expires_at from follower_outreach_attempts a
      where a.platform_account_id = ${input.pageId} and a.fan_ref = ${input.fanRef} and a.state <> 'expired'`);
    const row = result.rows[0];
    return {
      owned: Boolean(row && row.attempt_id === input.attemptId && Number(row.user_id) === input.userId),
      state: row?.state ?? "expired",
      expiresAt: row?.state === "reserved" ? new Date(row.expires_at).toISOString() : null,
    };
  });
}
