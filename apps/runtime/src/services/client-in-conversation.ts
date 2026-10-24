import {
  CLIENT_ACTIVITY_LOST_MINUTES,
  IN_CONVERSATION_MINUTES,
  type ClientInConversationResponse,
} from "@agency_hub_core/contracts";
import { findPageSummaryByLabel, listRecentPageAuthors, type RecentPageAuthorRow } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { requireClientGrantedPage } from "./client-switches.ts";

/**
 * Chat Memory week 1 (docs/plans/2026-10-24-chat-memory/plan.md §3): «в
 * разговоре» — who is talking to which fan of the page now
 * (`clientInConversation`).
 *
 * A person is in a conversation with a fan while their newest message to him
 * with an author (client_send_attributions) is under IN_CONVERSATION_MINUTES
 * old — unless their extension closed after it: an install of theirs beat
 * since the message, and none is open now (closed, or silent
 * CLIENT_ACTIVITY_LOST_MINUTES). A person whose extension has never beaten
 * since (an older build) keeps the mark for the full window: nothing says
 * they left.
 *
 * Database only: nothing here asks a platform or queues work. A warning for
 * the chatter, never a block: nobody owns a fan.
 */

export const IN_CONVERSATION_FEATURE = "in-conversation";

/** Whether this author still holds the mark: not gone since their message. Pure. */
export function stillInConversation(row: Pick<RecentPageAuthorRow, "heardSince" | "openNow">): boolean {
  return !row.heardSince || row.openNow;
}

/** The fans with their chatters, newest message first, from the page's recent authors. Pure. */
export function inConversationOf(
  rows: readonly RecentPageAuthorRow[],
  me: number,
): ClientInConversationResponse["fans"] {
  const fans = new Map<string, ClientInConversationResponse["fans"][number]>();
  const kept = rows.filter(stillInConversation).sort((a, b) => b.lastSentAt.getTime() - a.lastSentAt.getTime());
  for (const row of kept) {
    const fan = fans.get(row.fanRef) ?? { fanRef: row.fanRef, conversationRef: row.conversationRef, chatters: [] };
    fan.conversationRef ??= row.conversationRef;
    fan.chatters.push({
      userId: row.userId,
      name: row.username,
      isMe: row.userId === me,
      lastSentAt: row.lastSentAt.toISOString(),
      until: new Date(row.lastSentAt.getTime() + IN_CONVERSATION_MINUTES * 60_000).toISOString(),
    });
    fans.set(row.fanRef, fan);
  }
  return [...fans.values()];
}

export async function readClientInConversation(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string },
): Promise<ClientInConversationResponse> {
  // A cookie session → 403: the read is a client's.
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, input.pageLabel), IN_CONVERSATION_FEATURE);
  const now = new Date();
  const rows = await listRecentPageAuthors(app.db, {
    pageId: page.id,
    now,
    minutes: IN_CONVERSATION_MINUTES,
    lostMinutes: CLIENT_ACTIVITY_LOST_MINUTES,
  });
  return { pageLabel: page.label, fans: inConversationOf(rows, principal.user.id), serverNow: now.toISOString() };
}
