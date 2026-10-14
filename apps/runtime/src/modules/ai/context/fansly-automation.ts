import { listPageAutomatedMessageTexts, type FanslyMessageMarkers } from "@agency_hub_core/db";
import { normalizeDmMessageText } from "@agency_hub_core/shared";

import type { AppContext } from "../../../bootstrap.ts";

// chat-extension R20 HF-7д (parity row AI-033): the model's welcome and mass
// messages in the Fansly transcript the hub loads itself, marked as the
// released Fansly extension 2.10.1 marks them in the transcript of Hi
// (fansly-chat src/shared/followers.ts `automationReason`,
// src/shared/greeting-context.ts `AUTOMATED_MESSAGE_LABEL`), from the hub's
// own stores:
//
// - `type` and `correlationId` with their presence: the archive's columns
//   (HF-7д0) and the socket overlay's, read with the transcript's rows; an
//   archive row from before HF-7д0 takes the overlay's markers for the same
//   message when the socket saw it;
// - the reply: the archive's `in_reply_to_ref`, the overlay's
//   `in_reply_to_message_id`;
// - the welcome texts: the page's automations as the catalog captured them
//   from `/message/automated` (`page_automated_messages`); the hub makes no
//   request for them.
//
// The rule is the old one, in its order: `type` 2; a `correlationId` other
// than '0' on a message that answers none; a text equal to a welcome text after
// whitespace is collapsed. A fan's message is never automatic. A marker the
// hub never observed is not automation: a row from before HF-7д0, a socket
// frame without the key (the old rule reads a missing key the same way).

/** The released extension's transcript label, byte for byte; the Hi template
 *  explains it to the model (prompts/templates.ts). */
export const AUTOMATED_MESSAGE_LABEL = "[Automatic / mass message]";

export type FanslyAutomationReason = "type-2" | "non-reply-correlation" | "welcome-text-match";

/** One served message as the classifier reads it. */
export interface FanslyAutomationEvidence {
  /** The page sent it: the transcript's `Model` line. */
  fromModel: boolean;
  markers: FanslyMessageMarkers;
  /** The message it answers; null when none is known. */
  inReplyTo: string | null;
  /** Its text as the transcript reads it (`normalizeDmMessageText`). */
  text: string;
}

/** The old `normalizeWelcome`: whitespace runs to one space, trimmed. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * A page's welcome texts as the classifier compares them: each one read as a
 * message text is read (`normalizeDmMessageText`, the transcript's reading of
 * the vendor's content), whitespace collapsed; an empty one names nothing.
 */
export function fanslyWelcomeTextSet(texts: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const text of texts) {
    const key = collapseWhitespace(normalizeDmMessageText(text));
    if (key !== "") {
      set.add(key);
    }
  }
  return set;
}

/** Why the old extension would call this message automatic; null = personal. */
export function fanslyAutomationReason(
  message: FanslyAutomationEvidence,
  welcome: ReadonlySet<string>,
): FanslyAutomationReason | null {
  if (!message.fromModel) {
    return null;
  }
  // An unobserved marker is null here (fanslyMessageMarkers), so it never matches.
  if (message.markers.type === 2) {
    return "type-2";
  }
  const correlationId = message.markers.correlationId;
  if (
    correlationId !== null
    && correlationId !== "0"
    && (message.inReplyTo === null || message.inReplyTo === "0")
  ) {
    return "non-reply-correlation";
  }
  const text = collapseWhitespace(message.text);
  return text !== "" && welcome.has(text) ? "welcome-text-match" : null;
}

/** What the transcript loader is given to mark a Fansly Hi transcript. */
export interface FanslyAutomationInput {
  /** The page's welcome texts (`fanslyWelcomeTextSet`); null when their read
   *  failed: then the markers alone decide, and the manifest says so. */
  welcome: ReadonlySet<string> | null;
}

/** What the marks leave in the context manifest: counts only, never a text. */
export interface FanslyAutomationManifest {
  /** Messages of the served window marked, and why. */
  marked: number;
  typeTwo: number;
  nonReplyCorrelation: number;
  welcomeText: number;
  /** The model's messages of the window whose `type` and `correlationId` the
   *  hub never observed in any store (archived before HF-7д0, never seen on
   *  the socket): only a welcome text marks them. */
  modelMarkersUnknown: number;
  /** The model's archive rows of the window without markers that took the
   *  socket overlay's for the same message. */
  overlayMarkers: number;
  /** How many welcome texts were compared; null when their read failed. */
  welcomeTexts: number | null;
  /** The overlay's markers could not be read: those rows stayed unknown. */
  overlayMarkersError?: true;
}

/**
 * The page's welcome texts for one generation: one indexed read of its
 * captured automations. A failed read never fails the generation: null, and
 * the markers alone decide.
 */
export async function loadFanslyAutomationInput(
  app: Pick<AppContext, "db" | "logger">,
  input: { pageId: number },
): Promise<FanslyAutomationInput> {
  try {
    return { welcome: fanslyWelcomeTextSet(await listPageAutomatedMessageTexts(app.db, input)) };
  } catch (error) {
    app.logger.warn({ pageId: input.pageId, err: error }, "ai fansly welcome texts read failed");
    return { welcome: null };
  }
}
