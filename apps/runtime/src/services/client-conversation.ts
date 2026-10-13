import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { checkAiConversationPair, type AiConversationPairState } from "../modules/ai/index.ts";
import { clientConversationsHaveOwnIds } from "./client-features.ts";
import { BadRequestError, ConversationFanMismatchError } from "./errors.ts";

/**
 * chat-extension R20 HF-10: the conversation a client read names
 * (chat-extension architecture §11.1, "reads by conversation"; the contract's
 * section of the same name in routes-client.ts).
 *
 * The shared recaps read, the dossier save from a generation and the archive
 * feed are about one conversation of one fan, and the fan is in the path. On
 * OnlyFans the chat id IS the fan id: the fan names the conversation. On
 * Fansly a chat is a group with an id of its own; the request names it as
 * `conversationRef` (`conversation-recaps-v1`), and the hub reads the
 * conversation by the group and the fan's own data (the dossier) by the fan.
 *
 * The pair is checked before anything is read, by the AI lane's own rule
 * (`checkAiConversationPair`, R20 HF-9): the page's thread of the group names
 * its fan. Another fan's thread is 409 `conversation_fan_mismatch`; this fan's
 * thread is `verified`; no thread yet, or a thread whose fan the hub does not
 * know, is `unverified` and served, as a generation is.
 */
export type ClientConversation =
  /** The fan names the conversation: OnlyFans, and every request without `conversationRef` there. */
  | { kind: "fan"; conversationRef: string; fanRef: string }
  /** A conversation with an id of its own (a Fansly group), checked against its fan. */
  | { kind: "pair"; conversationRef: string; fanRef: string; pair: AiConversationPairState };

/**
 * The conversation of a client read on an admitted page. Refuses, before
 * anything is read: 409 `conversation_fan_mismatch` for a conversation that is
 * not this fan's (on OnlyFans any chat but the fan's own; on Fansly a group the
 * page's capture holds as another fan's), and 400 `bad_request` for a request
 * that does not name the conversation on a page whose chats have ids of their
 * own. A failed read of the page's capture is not swallowed.
 */
export async function resolveClientConversation(
  app: Pick<AppContext, "db">,
  page: { id: number; platform: Platform },
  input: { fanRef: string; conversationRef: string | undefined },
): Promise<ClientConversation> {
  if (!clientConversationsHaveOwnIds(page.platform)) {
    // The chat id IS the fan id: naming it again changes nothing, naming any
    // other chat names another fan's.
    if (input.conversationRef !== undefined && input.conversationRef !== input.fanRef) {
      throw new ConversationFanMismatchError();
    }
    return { kind: "fan", conversationRef: input.fanRef, fanRef: input.fanRef };
  }
  if (input.conversationRef === undefined) {
    // The fan's id names no chat here: read by it, the conversation would be
    // a guess.
    throw new BadRequestError("conversationRef is required on a page whose chats have ids of their own");
  }
  const pair = await checkAiConversationPair(app, {
    pageId: page.id,
    conversationRef: input.conversationRef,
    fanRef: input.fanRef,
  });
  if (pair === null) {
    // Unreachable: the fan comes from the path and is never blank.
    throw new Error("client conversation: the pair check named no pair");
  }
  return { kind: "pair", conversationRef: input.conversationRef, fanRef: input.fanRef, pair };
}

/** The conversations a read of the recaps selects from, and the fan their rows must be stored about. */
export function clientConversationRecapRefs(
  conversation: ClientConversation,
): { conversationRefs: string[]; fanRef?: string } {
  if (conversation.kind === "fan") {
    // As before HF-10: every recap keyed by the fan's chat.
    return { conversationRefs: [conversation.fanRef] };
  }
  // The conversation's own recaps and those stored in the fan's own form (the
  // released Fansly extension's older requests keyed a chat by its fan), each
  // only when stored about this fan (FreshestRecapsInput.fanRef).
  return {
    conversationRefs: [...new Set([conversation.conversationRef, conversation.fanRef])],
    fanRef: conversation.fanRef,
  };
}
