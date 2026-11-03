import { CLIENT_DELETED_MESSAGES_MAX, type ClientDeletedMessagesResponse } from "@agency_hub_core/contracts";
import { findPageSummaryByLabel, listClientDeletedMessages } from "@agency_hub_core/db";

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
 */
export const DELETED_MESSAGES_FEATURE = "deleted-messages-v1";

export async function readClientDeletedMessages(
  app: AppContext,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; fanRef: string },
): Promise<ClientDeletedMessagesResponse> {
  // A cookie session → 403: the read is a client's.
  requireApiKeyUser(principal);
  const page = await requireClientGrantedPage(app, principal, await findPageSummaryByLabel(app.db, input.pageLabel), DELETED_MESSAGES_FEATURE);
  const { total, rows } = page.platform === "fansly"
    ? await listClientDeletedMessages(app.db, { pageId: page.id, fanRef: input.fanRef, limit: CLIENT_DELETED_MESSAGES_MAX })
    : { total: 0, rows: [] };
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
    serverNow: new Date().toISOString(),
  };
}
