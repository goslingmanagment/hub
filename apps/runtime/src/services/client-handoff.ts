import {
  CLIENT_ACTIVITY_LOST_MINUTES,
  CLIENT_HANDOFF_HOURS,
  IN_CONVERSATION_MINUTES,
  type ClientHandoffResponse,
} from "@agency_hub_core/contracts";
import {
  findPageSummaryByLabel,
  listHandoffFans,
  listPageOpenCustoms,
  listPageOpenPromises,
  listPageSpenderAwaitingReply,
  listRecentPageAuthors,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type HumanAuthPrincipal } from "./auth.ts";
import { inConversationOf } from "./client-in-conversation.ts";
import { requireClientGrantedPage } from "./client-switches.ts";

/**
 * Chat Memory week 3 (docs/plans/2026-10-24-chat-memory/week-3.md §4): the
 * shift handoff of a page (`clientHandoff`) — what the next chatter needs with
 * no «кого оставить?»: whom the team wrote to in the last CLIENT_HANDOFF_HOURS
 * and who is still «в разговоре» (week 1), who waits for a reply (the queue of
 * week 3), and the open promises (the facts of week 2). Database only.
 */

export const HANDOFF_FEATURE = "handoff";
const RECENT_LIMIT = 50;
const WAITING_HEAD = 10;
const PROMISES_LIMIT = 30;

export async function readClientHandoff(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string },
): Promise<ClientHandoffResponse> {
  // A cookie session → 403: the handoff is a client's.
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, input.pageLabel), HANDOFF_FEATURE);
  const now = new Date();
  const [recent, authors, waiting, promises, customs] = await Promise.all([
    listHandoffFans(app.db, { pageId: page.id, now, hours: CLIENT_HANDOFF_HOURS, limit: RECENT_LIMIT }),
    listRecentPageAuthors(app.db, { pageId: page.id, now, minutes: IN_CONVERSATION_MINUTES, lostMinutes: CLIENT_ACTIVITY_LOST_MINUTES }),
    listPageSpenderAwaitingReply(app.db, { pageId: page.id, limit: WAITING_HEAD, everyone: true, now }),
    listPageOpenPromises(app.db, { pageId: page.id, limit: PROMISES_LIMIT }),
    listPageOpenCustoms(app.db, { pageIds: [page.id], limit: PROMISES_LIMIT }),
  ]);
  const talking = new Map(inConversationOf(authors, principal.user.id).map((fan) => [fan.fanRef, fan.chatters.map((chatter) => chatter.name)]));
  return {
    pageLabel: page.label,
    recent: recent.map((fan) => ({
      fanRef: fan.fanRef,
      conversationRef: fan.conversationRef,
      username: fan.username,
      alias: fan.alias,
      lastSentAt: fan.lastSentAt.toISOString(),
      messages: fan.messages,
      chatters: fan.chatters,
      inConversation: talking.get(fan.fanRef) ?? [],
    })),
    waiting: {
      total: waiting.total,
      head: waiting.items.map((item) => ({
        fanRef: item.fanRef,
        conversationRef: item.conversationRef,
        username: item.username,
        alias: item.alias,
        lifetimeGrossMills: Number(item.lifetimeGrossMills),
        lastFanMessageAt: item.lastFanMessageAt.toISOString(),
      })),
    },
    customs: customs.map((custom) => ({
      fanRef: custom.fanRef,
      conversationRef: custom.conversationRef,
      description: custom.description,
      state: custom.state,
      paidAt: custom.paidAt === null ? null : custom.paidAt.toISOString(),
      createdAt: custom.createdAt.toISOString(),
    })),
    promises: promises.map((promise) => ({
      fanRef: promise.fanRef,
      conversationRef: promise.conversationRef,
      text: promise.text,
      messageRef: promise.messageRef,
      messageAt: promise.messageAt === null ? null : promise.messageAt.toISOString(),
    })),
    serverNow: now.toISOString(),
  };
}
