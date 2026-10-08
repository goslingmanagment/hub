import { readOpenChatUnavailabilityForRequest } from "@agency_hub_core/db";

import type { AppContext } from "../../../bootstrap.ts";

// Arena "vanished chat" (plan §5): a chat Fansly no longer serves to its page
// (an established unavailability episode). Every AI request on such a chat —
// the kernel lane and the client-context lane alike — ends its transcript with
// one line saying so; on the kernel lane the hub's own socket messages of the
// chat are labelled too. The client's transcript is never relabelled.

/** The label of a socket message of a chat Fansly no longer serves to its
 *  page: no REST read can confirm it. */
export const UNCONFIRMED_SOCKET_MESSAGE_LABEL = "[Unconfirmed]";

/** The chat's access as one AI request reads it. */
export interface AiChatAccess {
  /** The chat has an established unavailability episode. A refusing one may
   *  still be answered on the next read and changes nothing. */
  unavailable: boolean;
  /** The episode read failed: the generation runs without the line, and its
   *  context manifest says so. */
  error: boolean;
}

/**
 * The chat's access for an AI request on a page. The request names its chat by
 * `conversationRef` — the Fansly group id, or the fan's account id from an
 * older client — and may name the fan (`fanRef`) and, on the client-context
 * lane, the group (`clientContext.media.groupRef`): a group id of the page's
 * threads wins, else the fan's chat with the page. Only the Fansly engine
 * writes episodes, so another platform's chat never has one. Never throws.
 */
export async function readAiChatAccess(
  app: Pick<AppContext, "db" | "logger">,
  input: { pageId: number; conversationRef: string; fanRef: string | null; groupRef: string | null },
): Promise<AiChatAccess> {
  const refs = (values: Array<string | null>) => values.filter((value): value is string => value !== null && value.trim() !== "");
  try {
    const episode = await readOpenChatUnavailabilityForRequest(app.db, {
      pageId: input.pageId,
      groupIds: refs([input.conversationRef, input.groupRef]),
      partnerIds: refs([input.conversationRef, input.fanRef]),
    });
    return { unavailable: episode?.state === "established", error: false };
  } catch (error) {
    app.logger.warn(
      { pageId: input.pageId, errorName: error instanceof Error ? error.name : typeof error },
      "ai chat access read failed; the generation runs without it",
    );
    return { unavailable: false, error: true };
  }
}

/**
 * The line after the transcript of a chat Fansly no longer serves to its page.
 * `unconfirmed`: how many of the transcript's socket messages carry
 * `UNCONFIRMED_SOCKET_MESSAGE_LABEL` (the hub's transcript), or null when the
 * transcript is the client's own and the hub cannot point at them. Separated
 * like the image-notes guide, appended after whatever rendered the transcript
 * last.
 */
export function chatUnavailableTranscriptNote(input: { unconfirmed: number | null }): string {
  const socket = input.unconfirmed === null
    ? " Its newest messages may have arrived over the live socket only and are not confirmed."
    : input.unconfirmed > 0
      ? ` Messages marked ${UNCONFIRMED_SOCKET_MESSAGE_LABEL} arrived over the live socket and are not confirmed.`
      : "";
  return "\n\nChat status: Fansly no longer serves this chat's history to the page — the fan probably blocked the page "
    + `or deleted their account.${socket}`;
}
