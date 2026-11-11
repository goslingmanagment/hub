import {
  CLIENT_CHAT_LENGTH_CHATTERS_MAX,
  CLIENT_DELETED_MESSAGES_MAX,
  type ClientChatAuthors,
  type ClientChatLength,
  type ClientDeletedMessagesResponse,
} from "@agency_hub_core/contracts";
import {
  findPageSummaryByLabel,
  listClientDeletedMessages,
  readClientChatAuthors,
  readClientChatLength,
  readClientOnlyFansChat,
  type ClientChatAuthorsRow,
  type ClientChatLengthRow,
  type ClientOnlyFansChatRow,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { requireClientGrantedPage } from "./client-switches.ts";

/**
 * The fan's deleted messages of a page (`clientDeletedMessages`, capability
 * `deleted-messages-v1`), with the text the hub kept.
 *
 * WHY THE TEXT. A Fansly deletion is a fact about the message, not an erasure
 * (owner, 2026-09-28): the stored copies are marked deleted and keep their
 * text (repositories/fansly-ws-deletions.ts). The conversation feed and the AI
 * still read a deleted message as an empty row; this read is the one place a
 * client gets its text: the chat extension shows the fan's deleted messages in
 * the Fansly chat header to the chatters of the page (owner, 2026-11-03).
 *
 * WHO MAY READ. A device token's (a cookie session is 403), for an active page
 * granted to the caller (else 409 `client_feature_disabled` / `not_granted`,
 * the same answer for a page that does not exist). No owner switch.
 *
 * WHAT. The rows of the Fansly live overlay the page's socket saw the fan
 * delete (kept since 2026-10-01): a message deleted before the hub captured it
 * was never stored. On another platform's page the list is empty. Database
 * only: no platform request, no queued work.
 *
 * THE CHAT'S LENGTH. With `conversationRef` the same read answers how many
 * messages the open chat ever had and since when (owner, 2026-11-08: a badge
 * in the header, «без лишних запросов и точно»): the header asks this read
 * once per opened chat anyway. Exact or nothing (`chatLengthOf`).
 *
 * WHO WROTE IT. The same answer names the chat's authors (owner, 2026-11-11:
 * «кто из чатеров сколько сообщений оставил»): the chatters by their reported
 * sends (send-attribution-v1), always; the fan's and the page's unattributed
 * messages only beside a proven length, the page's side counted from the
 * archive and the fan's the rest of the length (`chatAuthorsOf`).
 *
 * ON ONLYFANS. The same card on ChatSpace (owner, 2026-11-11: «там же все то
 * же самое нужно»). There the chat is the fan, and no sync proves its first
 * message, so the answer is what the message archive holds of it, marked
 * `approximate`: its rows, both sides, deleted ones included, since the
 * earliest of them; the page's side is the archive's too, so the fan and the
 * unattributed come out by the same arithmetic. Nothing in the archive and no
 * reported send: `chat` null (`onlyFansChatLengthOf`).
 */
export const DELETED_MESSAGES_FEATURE = "deleted-messages-v1";

/**
 * What the header may say of a thread: the count and the first message only when the sync proved the chain reaches
 * the chat's first message; otherwise both null, never a count that may miss older messages; and who wrote them. Pure.
 */
export function chatLengthOf(
  conversationRef: string,
  row: ClientChatLengthRow,
  authors: ClientChatAuthorsRow,
  callerUserId: number,
): ClientChatLength {
  const complete = row.historyState === "complete";
  const messages = complete ? row.chainCount + row.afterHead : null;
  return {
    conversationRef,
    messages,
    firstMessageAt: !complete || row.oldestAt === null ? null : row.oldestAt.toISOString(),
    authors: chatAuthorsOf(messages, authors, callerUserId),
  };
}

/**
 * What the header may say of an OnlyFans chat: what the archive holds of it, marked approximate, and who wrote it by
 * the same arithmetic as a proven chat's; null when the archive holds nothing of it and nobody reported a send. Pure.
 */
export function onlyFansChatLengthOf(conversationRef: string, row: ClientOnlyFansChatRow, callerUserId: number): ClientChatLength | null {
  if (row.messages === 0 && row.authors.chatters.length === 0) return null;
  return {
    conversationRef,
    messages: row.messages,
    firstMessageAt: row.oldestAt === null ? null : row.oldestAt.toISOString(),
    authors: chatAuthorsOf(row.messages, row.authors, callerUserId),
    approximate: true,
  };
}

/**
 * Who wrote the chat's `messages`. The chatters, the most messages first (then by name), at most
 * CLIENT_CHAT_LENGTH_CHATTERS_MAX, whatever the history's state. The fan and the unattributed only with a proven length
 * and the page's side counted: the page's messages are at least the chatters' (a send can be reported a moment before
 * the archive holds it), the fan's are the rest of the length, and the unattributed what of the page's no chatter
 * claims; so they add up to `messages` unless a side is ahead of the length. Pure.
 */
export function chatAuthorsOf(messages: number | null, authors: ClientChatAuthorsRow, callerUserId: number): ClientChatAuthors {
  const chatters = authors.chatters
    .filter((chatter) => chatter.messages > 0)
    .sort((a, b) => b.messages - a.messages || a.username.localeCompare(b.username) || a.userId - b.userId)
    .slice(0, CLIENT_CHAT_LENGTH_CHATTERS_MAX)
    .map((chatter) => ({ userId: chatter.userId, name: chatter.username, isMe: chatter.userId === callerUserId, messages: chatter.messages }));
  if (messages === null || authors.pageSide === null) return { chatters, fan: null, unattributed: null };
  const attributed = chatters.reduce((sum, chatter) => sum + chatter.messages, 0);
  const page = Math.max(authors.pageSide, attributed);
  return {
    chatters,
    fan: Math.max(0, messages - page),
    unattributed: Math.max(0, Math.min(page, messages) - attributed),
  };
}

/** The open chat's length and authors, when the page's thread of the group is this fan's; null otherwise. */
async function readChat(
  db: Database,
  input: { pageId: number; conversationRef: string; fanRef: string },
  callerUserId: number,
): Promise<ClientChatLength | null> {
  const length = await readClientChatLength(db, input);
  if (length === null) return null;
  // The archive's count only beside a proven length: an unproven chat never pays for it.
  const authors = await readClientChatAuthors(db, { ...input, countPageSide: length.historyState === "complete" });
  return chatLengthOf(input.conversationRef, length, authors, callerUserId);
}

/** The open OnlyFans chat's length and authors as the archive holds them; null when it holds nothing of the chat. */
async function readOnlyFansChat(
  db: Database,
  input: { pageId: number; conversationRef: string; fanRef: string },
  callerUserId: number,
): Promise<ClientChatLength | null> {
  // The chat is the fan: read by the fan's id, the client's conversationRef only echoed back.
  const row = await readClientOnlyFansChat(db, { pageId: input.pageId, fanRef: input.fanRef });
  return onlyFansChatLengthOf(input.conversationRef, row, callerUserId);
}

export async function readClientDeletedMessages(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; fanRef: string; conversationRef?: string },
): Promise<ClientDeletedMessagesResponse> {
  // A cookie session → 403: the read is a client's.
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, input.pageLabel), DELETED_MESSAGES_FEATURE);
  const fansly = page.platform === "fansly";
  const { conversationRef } = input;
  // A Fansly chat by its thread, an OnlyFans chat by the archive; another platform's never.
  const readOpenChat = fansly ? readChat : page.platform === "onlyfans" ? readOnlyFansChat : null;
  const [{ total, rows }, chat] = await Promise.all([
    fansly
      ? listClientDeletedMessages(app.db, { pageId: page.id, fanRef: input.fanRef, limit: CLIENT_DELETED_MESSAGES_MAX })
      : { total: 0, rows: [] },
    readOpenChat !== null && conversationRef !== undefined
      ? readOpenChat(app.db, { pageId: page.id, conversationRef, fanRef: input.fanRef }, principal.user.id)
      : null,
  ]);
  return {
    pageLabel: page.label,
    fanRef: input.fanRef,
    total,
    messages: rows.map((row) => ({
      platformMessageId: row.platformMessageId,
      conversationRef: row.conversationRef,
      text: row.text,
      attachments: row.attachments,
      sentAt: row.sentAt === null ? null : row.sentAt.toISOString(),
      deletedAt: row.deletedAt.toISOString(),
    })),
    ...(conversationRef === undefined ? {} : { chat }),
    serverNow: new Date().toISOString(),
  };
}
