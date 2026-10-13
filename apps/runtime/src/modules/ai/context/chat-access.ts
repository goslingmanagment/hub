import type { AI_CONTEXT_PAIR_STATES } from "@agency_hub_core/contracts";
import {
  listPageDmConversationsByPlatformConversationIds,
  readOpenChatUnavailabilityForRequest,
} from "@agency_hub_core/db";

import type { AppContext } from "../../../bootstrap.ts";
import { ConversationFanMismatchError } from "../../../services/errors.ts";

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

// chat-extension R20 HF-9 — the pair `groupId ↔ fanRef`. On Fansly a chat is a
// group with an id of its own: a request whose transcript the hub loads itself
// names the group (`conversationRef`) and the fan (`fanRef`) apart, and the hub
// reads the transcript by the one and the fan's spend, dossier and name by the
// other. The page's capture (`page_dm_threads`, one row per page and group)
// says whose chat a group is.

/** What the hub can vouch for about the pair a request names. */
export type AiConversationPairState = (typeof AI_CONTEXT_PAIR_STATES)[number];

/**
 * The verdict on a pair from the page's thread of the group (`thread` is null
 * when the page holds none). `verified`: the thread's fan is `fanRef`;
 * `mismatch`: it is another fan; `unverified`: no thread yet (a chat the hub
 * has not captured), or a thread whose fan the hub does not know. Ids compare
 * as exact strings. Pure, so the rule is unit-testable without a database.
 */
export function classifyAiConversationPair(input: {
  thread: { partnerPlatformUserId: string | null } | null;
  fanRef: string;
}): AiConversationPairState | "mismatch" {
  const fan = input.thread?.partnerPlatformUserId ?? null;
  if (fan === null || fan === "") {
    return "unverified";
  }
  return fan === input.fanRef ? "verified" : "mismatch";
}

/**
 * Checks the pair a Fansly request names, on a page the caller was already
 * admitted to: one indexed read of the page's thread of the group (hidden
 * threads count: a chat out of the list is still that fan's). `null` when the
 * request names no fan (no `fanRef`, or a blank one): there is no pair to
 * check. A pair the page's capture contradicts throws
 * `ConversationFanMismatchError` (409 `conversation_fan_mismatch`). A failed
 * read is not swallowed: a pair the hub could not check is never served as one
 * it could not contradict.
 */
export async function checkAiConversationPair(
  app: Pick<AppContext, "db">,
  input: { pageId: number; conversationRef: string; fanRef: string | null | undefined },
): Promise<AiConversationPairState | null> {
  if (input.fanRef === null || input.fanRef === undefined || input.fanRef.trim() === "") {
    return null;
  }
  const [thread] = await listPageDmConversationsByPlatformConversationIds(app.db, {
    platformAccountId: input.pageId,
    platformConversationIds: [input.conversationRef],
  });
  const state = classifyAiConversationPair({ thread: thread ?? null, fanRef: input.fanRef });
  if (state === "mismatch") {
    throw new ConversationFanMismatchError();
  }
  return state;
}
