import { countOnlyFansPageTextRecipients } from "@agency_hub_core/db";

import type { AppContext } from "../../../bootstrap.ts";
import type { TranscriptMessage } from "../prompts/index.ts";
import { AUTOMATED_MESSAGE_LABEL } from "./fansly-automation.ts";

// Hi's template tells the model that a Model line marked
// `[Automatic / mass message]` is a welcome or mass message, never a personal
// opener the fan ignored. The transcript loader marks a Fansly message it read
// from the archive or the socket (fansly-automation.ts). Two kinds stayed
// unmarked (prod, 2026-10-20..23: 42 of 240 Fansly Hi transcripts, every
// OnlyFans one):
//  - Fansly, a message the generation knows only from the client's fresh
//    text: the client's start proof names it in `automatedIds`, from the
//    message's own markers on the page;
//  - OnlyFans, where OFAPI marks neither the welcome message nor an
//    automation's follow-up (`isFromQueue` is false on both): a text the page
//    sent word for word to many fans is one. On 2026-10-23 the welcome had
//    reached 1376 fans, a mass message 5938, the follow-ups 109 to 166; the
//    lines chatters repeat stay under 50.

/** OnlyFans: the fewest fans a text must have reached to count as automatic. */
export const ONLYFANS_AUTOMATED_TEXT_MIN_FANS = 100;

/** The Model messages named in `ids` take the mark first, where the loader
 *  puts it; a message already marked keeps its labels. */
export function markAutomatedMessages(
  messages: readonly TranscriptMessage[],
  ids: ReadonlySet<string>,
): { messages: TranscriptMessage[]; marked: number } {
  let marked = 0;
  const result = messages.map((message) => {
    if (message.sender !== "Model" || !ids.has(message.id) || message.labels.includes(AUTOMATED_MESSAGE_LABEL)) {
      return message;
    }
    marked += 1;
    return { ...message, labels: [AUTOMATED_MESSAGE_LABEL, ...message.labels] };
  });
  return { messages: result, marked };
}

/**
 * OnlyFans: the Model messages of the window whose exact text the page sent to
 * at least ONLYFANS_AUTOMATED_TEXT_MIN_FANS fans. One read for the window's
 * texts; a failed read marks nothing and never fails the generation.
 */
export async function findOnlyFansAutomatedMessageIds(
  app: Pick<AppContext, "db" | "logger">,
  input: { pageId: number; messages: readonly TranscriptMessage[] },
): Promise<Set<string>> {
  const fromModel = input.messages.filter((message) => message.sender === "Model" && message.text !== "");
  if (fromModel.length === 0) {
    return new Set();
  }
  let fans: Map<string, number>;
  try {
    fans = await countOnlyFansPageTextRecipients(app.db, {
      pageId: input.pageId,
      texts: [...new Set(fromModel.map((message) => message.text))],
    });
  } catch (error) {
    app.logger.warn({ pageId: input.pageId, err: error instanceof Error ? error.name : "error" }, "ai automated text read failed open");
    return new Set();
  }
  return new Set(fromModel
    .filter((message) => (fans.get(message.text) ?? 0) >= ONLYFANS_AUTOMATED_TEXT_MIN_FANS)
    .map((message) => message.id));
}
