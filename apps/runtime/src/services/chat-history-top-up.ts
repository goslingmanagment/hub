import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import type { AppContext } from "../bootstrap.ts";
import { HistoryRequestError, submitHistoryRequest } from "../sync/requests/history.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

/**
 * Chat Memory week 1 (docs/plans/2026-10-24-chat-memory/plan.md §4, C1c): the
 * full history of every active chat on every Fansly page, kept full.
 *
 * Old chat history is read only by request (owner decision №2). On
 * 2026-10-24 the owner asked for the full history of active chats; the
 * one-off requests of that day filled what was missing, and this job keeps it
 * so: once a day it files, for each live Fansly page, one request for the
 * chats where the fan wrote in the last CHAT_HISTORY_TOP_UP_WINDOW_HOURS and
 * whose history is not proven full — a fan back after a long silence brings
 * his old chat in. Behind the live switch `chatHistoryTopUpEnabled`.
 *
 * The reads are the engine's, in the page's own pace and in its requests
 * class (40 % of the slots under contention); this job sends nothing to
 * Fansly itself. A chat Fansly refuses, or one excluded from message sync, is
 * left out: a request would only refuse it again.
 */

export const CHAT_HISTORY_TOP_UP_QUEUE = "chat-memory.history.top-up";
/** The fan wrote within this long: the job runs daily, so a day and a margin. */
export const CHAT_HISTORY_TOP_UP_WINDOW_HOURS = 26;
/** A history request names at most this many chats. */
const MAX_CHATS_PER_REQUEST = 1000;
const REASON = "chat memory: the full history of chats where the fan wrote in the last day (owner, 2026-10-24)";

/** A uuid derived from the page and the UTC day, so a second run of the same day is the same request. Pure. */
export function topUpIdempotencyKey(pageId: number, now: Date): string {
  const hex = createHash("sha256").update(`chat-history-top-up:${pageId}:${now.toISOString().slice(0, 10)}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface ChatHistoryTopUpResult {
  skipped: "off" | null;
  pages: Array<{ pageLabel: string; chats: number; outcome: string }>;
}

export async function runChatHistoryTopUp(app: AppContext, now = new Date()): Promise<ChatHistoryTopUpResult> {
  const effective = await loadEffectiveConfig(app.db, app.config);
  if (effective.chatHistoryTopUpEnabled !== true) return { skipped: "off", pages: [] };

  const candidates = await app.db.execute<{ page_id: string | number; page_label: string; conversation_ref: string }>(sql`
    select p.id as page_id, p.label as page_label, t.platform_conversation_id as conversation_ref
    from page_dm_threads t
    join pages p on p.id = t.platform_account_id
    join sync_pages sp on sp.page_id = p.id
    where p.platform = 'fansly' and p.deleted_at is null
      and sp.mode = 'live' and sp.requests_enabled_at is not null and sp.requests_enabled_at <= now()
      and t.last_fan_message_at >= ${now.toISOString()}::timestamptz - make_interval(hours => ${CHAT_HISTORY_TOP_UP_WINDOW_HOURS})
      and t.history_state <> 'complete'
      and t.is_visible and t.fan_id is not null
      and t.metadata->>'messageSyncExcludedReason' is null
      and not exists (
        select 1 from page_dm_thread_unavailability u
        where u.thread_id = t.id and u.ended_at is null and u.state = 'established'
      )
    order by p.id, t.last_fan_message_at desc`);

  const byPage = new Map<number, { label: string; chats: string[] }>();
  for (const row of candidates.rows) {
    const page = byPage.get(Number(row.page_id)) ?? { label: row.page_label, chats: [] };
    if (page.chats.length < MAX_CHATS_PER_REQUEST) page.chats.push(row.conversation_ref);
    byPage.set(Number(row.page_id), page);
  }

  const pages: ChatHistoryTopUpResult["pages"] = [];
  for (const [pageId, page] of byPage) {
    try {
      const result = await submitHistoryRequest({ db: app.db, rawConfig: app.config }, {
        pageId,
        requester: { kind: "owner_cli", userId: null },
        fans: page.chats.map((conversationRef) => ({ kind: "conversation", conversationRef })),
        depth: { kind: "all" },
        reason: REASON,
        idempotencyKey: topUpIdempotencyKey(pageId, now),
      }, { audit: { source: "scheduler", actorUserId: null } });
      pages.push({ pageLabel: page.label, chats: page.chats.length, outcome: result.disposition });
    } catch (error) {
      // One page's refusal (paused, not live any more) never stops the others.
      if (!(error instanceof HistoryRequestError)) throw error;
      pages.push({ pageLabel: page.label, chats: page.chats.length, outcome: `refused:${error.code}` });
    }
  }
  app.logger.info({ pages }, "Chat history top-up filed");
  return { skipped: null, pages };
}

export async function ensureChatHistoryTopUpQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, CHAT_HISTORY_TOP_UP_QUEUE, { policy: "exclusive" }, createdQueues);
}

/** Daily at 04:40 UTC (07:40 Moscow): the night's returns are in, the day's shifts have not begun. */
export async function ensureChatHistoryTopUpSchedule(boss: QueueCreationClient) {
  await boss.schedule?.(CHAT_HISTORY_TOP_UP_QUEUE, "40 4 * * *", null, { tz: "UTC" });
}
