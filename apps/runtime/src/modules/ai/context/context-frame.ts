import type {
  AI_CONTEXT_SOURCES,
  AI_COVERAGE_CHECK_DELETED_STATES,
  AI_COVERAGE_CHECK_WINDOW_STATES,
  AI_FAN_LANGUAGE_EVIDENCE,
  AI_KNOWN_FAN_MESSAGE_STATES,
  AiCoverageCheck,
  ClientCoverageLevel,
} from "@agency_hub_core/contracts";
import { lookupAiKnownMessages, type AiKnownMessageStoreState } from "@agency_hub_core/db";

import type { AppContext } from "../../../bootstrap.ts";
import type { AiFeatureContextFrameBody } from "../../../services/ai-gateway.ts";
import { loadClientConversationCoverage } from "../../../services/client-coverage.ts";
import { formatTranscriptDayLine, formatTranscriptLine, type TranscriptMessage } from "../prompts/index.ts";
import type { AiConversationPairState } from "./chat-access.ts";

// chat-extension H-4b — the `context_v1` frame: which transcript snapshot
// ACTUALLY served a generation. Everything here describes the transcript the
// loader already built and the cut the prompt made of it; nothing changes what
// the model reads.

export type AiContextSource = (typeof AI_CONTEXT_SOURCES)[number];
export type AiKnownFanMessageState = (typeof AI_KNOWN_FAN_MESSAGE_STATES)[number];
export type AiFanLanguageEvidence = (typeof AI_FAN_LANGUAGE_EVIDENCE)[number];
export type AiCoverageCheckWindowState = (typeof AI_COVERAGE_CHECK_WINDOW_STATES)[number];
export type AiCoverageCheckDeletedState = (typeof AI_COVERAGE_CHECK_DELETED_STATES)[number];

/** The frame's `coverageCheck`: one answer per id of the body's lists, in their order. */
export interface AiCoverageCheckAnswer {
  window: Array<{ id: string; state: AiCoverageCheckWindowState }>;
  deleted: Array<{ id: string; state: AiCoverageCheckDeletedState }>;
}

/** One message as the frame names it: the ref its store keeps, which is the
 *  transcript's own message id (HF-8a: never a number). */
export interface AiContextMessageRef {
  messageRef: string;
  occurredAt: Date | null;
  isFromFan: boolean;
}

/** What `loadTranscriptContext` served, for the frame. */
export interface TranscriptServedSnapshot {
  /** The reader whose rows became the transcript. */
  source: AiContextSource;
  /** The transcript's messages, oldest first: after shaping, the dedupe and
   *  the window cap. The prompt holds all of them, except that the Coach
   *  whole-prompt budget may cut the oldest: `loadAiContextFrameBody` takes
   *  that cut (`omittedByPromptBudget`) before the frame reports the window. */
  window: AiContextMessageRef[];
  /** The plain archive reader's newest row. Diagnostics: with `source: "union"`
   *  the transcript may reach past it. */
  archiveHead: AiContextMessageRef | null;
}

/**
 * The transcript's messages under the refs their stores keep. A transcript
 * message's id IS its row's ref, the exact string (HF-8a): two ids a double
 * cannot tell apart are two messages here and get two answers.
 */
export function servedWindowOf(messages: readonly TranscriptMessage[]): AiContextMessageRef[] {
  return messages.map((message) => ({
    messageRef: message.id,
    occurredAt: new Date(message.createdAtMs),
    isFromFan: message.sender === "Fan",
  }));
}

/**
 * How many of the transcript's oldest messages the prompt does not hold whole.
 * Only the Coach whole-prompt budget shortens a transcript: it leaves out the
 * first `omittedChars` UTF-16 units of the rendered text, wherever that lands.
 * A message counts as read only when its whole line survived, so the line the
 * cut runs through is out together with every line before it.
 *
 * `messages` are the ones `transcript` was rendered from, in order (with their
 * image notes, when the prompt carries them). Each counted line is checked
 * against the text: a text these messages do not render to vouches for none.
 */
export function transcriptMessagesOmittedByBudget(input: {
  transcript: string;
  messages: readonly TranscriptMessage[];
  omittedChars: number;
}): number {
  if (input.omittedChars <= 0) {
    return 0;
  }
  let offset = 0;
  let previousDay: string | null = null;
  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index]!;
    // A day's first message comes after its day line; the day line alone
    // vouches for no message.
    const day = formatTranscriptDayLine(message.createdAtMs);
    if (day !== previousDay) {
      if (!input.transcript.startsWith(day, offset)) {
        return input.messages.length;
      }
      offset += day.length + 1;
      previousDay = day;
    }
    const line = formatTranscriptLine(message);
    if (!input.transcript.startsWith(line, offset)) {
      return input.messages.length;
    }
    if (offset >= input.omittedChars) {
      return index;
    }
    // Lines are joined by one "\n".
    offset += line.length + 1;
  }
  return input.messages.length;
}

/** How many of the fan's latest text messages the script evidence reads. */
export const FAN_LANGUAGE_EVIDENCE_MESSAGES = 20;
/** Below this share of the fan's letters, the other script is noise (a brand
 *  name, "ok", a pasted link), not a second language. */
const FAN_LANGUAGE_MINOR_SCRIPT_SHARE = 0.15;

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/**
 * A rough guess at the alphabet the fan writes in, from the letters of the
 * fan's latest text messages in the served window. It counts letters, it does
 * not detect a language: `unknown` when the fan wrote no Latin or Cyrillic
 * letters, or mostly letters of another script.
 */
export function fanLanguageEvidenceOf(messages: readonly TranscriptMessage[]): AiFanLanguageEvidence {
  const text = messages
    .filter((message) => message.sender === "Fan" && message.text.trim().length > 0)
    .slice(-FAN_LANGUAGE_EVIDENCE_MESSAGES)
    .map((message) => message.text)
    .join("\n");
  const latin = countMatches(text, /\p{Script=Latin}/gu);
  const cyrillic = countMatches(text, /\p{Script=Cyrillic}/gu);
  const known = latin + cyrillic;
  if (known === 0 || countMatches(text, /\p{L}/gu) - known > known) {
    return "unknown";
  }
  if (Math.min(latin, cyrillic) / known >= FAN_LANGUAGE_MINOR_SCRIPT_SHARE) {
    return "mixed";
  }
  return latin > cyrillic ? "latin" : "cyrillic";
}

/**
 * One answer per id the client named, in the client's order, judged against
 * the transcript that served the generation. An id matches a window ref only
 * as the same string, never as the same number:
 * - `included`: the served window holds it as a fan message;
 * - `deleted`: not in the window, and tombstoned in this conversation;
 * - `absent`: not in the window (never seen for this conversation, an id of
 *   another chat, older than the window, or cut by the prompt budget);
 * - `unknown`: the hub cannot tell — the stores could not be read, or the
 *   window holds the id as the model's own message.
 *
 * `stores` holds the store state of the ids the window does not hold; null
 * when that read failed.
 */
export function resolveKnownFanMessages(input: {
  ids: readonly string[];
  window: readonly AiContextMessageRef[];
  stores: ReadonlyMap<string, AiKnownMessageStoreState> | null;
}): Array<{ id: string; state: AiKnownFanMessageState }> {
  const served = new Map(input.window.map((message) => [message.messageRef, message]));
  return input.ids.map((id) => {
    const inWindow = served.get(id);
    if (inWindow) {
      return { id, state: inWindow.isFromFan ? "included" : "unknown" };
    }
    if (input.stores === null) {
      return { id, state: "unknown" };
    }
    return { id, state: input.stores.get(id) === "deleted" ? "deleted" : "absent" };
  });
}

/**
 * chat-extension R20 HF-8в: one answer per id of the body's `coverageCheck`,
 * each list in the client's order, judged against the transcript that served
 * the generation like `resolveKnownFanMessages` (an id matches a window ref
 * only as the same string).
 *
 * An id of `window` (a message the tab holds):
 * - `included`: the served window holds it, from the side the tab says;
 * - `direction_mismatch`: the served window holds it from the other side;
 * - `outside_window`: not in the window, but held for this conversation (older
 *   than the window, or cut by the prompt budget);
 * - `deleted`: not in the window, and tombstoned for this conversation;
 * - `absent`: not in the window, and not held for this conversation (never
 *   seen, another chat's, or only in a store the serving reader did not read);
 * - `unknown`: not in the window, and the stores could not be read.
 *
 * An id of `deletedIds` (a message the tab saw deleted):
 * - `still_served`: the served window holds it: the model read a message the
 *   tab saw deleted;
 * - `deleted`: not in the window, and tombstoned for this conversation;
 * - `absent`: not in the window, and no tombstone for this conversation (the
 *   model did not read it, whatever else the stores hold);
 * - `unknown`: not in the window, and the stores could not be read.
 *
 * `stores` holds the store state of the ids the window does not hold; null
 * when that read failed.
 */
export function resolveCoverageCheck(input: {
  check: AiCoverageCheck;
  window: readonly AiContextMessageRef[];
  stores: ReadonlyMap<string, AiKnownMessageStoreState> | null;
}): AiCoverageCheckAnswer {
  const served = new Map(input.window.map((message) => [message.messageRef, message]));
  const stored = (id: string) => input.stores?.get(id) ?? "absent";
  return {
    window: input.check.window.map(({ id, dir }): AiCoverageCheckAnswer["window"][number] => {
      const inWindow = served.get(id);
      if (inWindow) {
        return { id, state: inWindow.isFromFan === (dir === "fan") ? "included" : "direction_mismatch" };
      }
      if (input.stores === null) {
        return { id, state: "unknown" };
      }
      const state = stored(id);
      return { id, state: state === "present" ? "outside_window" : state };
    }),
    deleted: input.check.deletedIds.map((id): AiCoverageCheckAnswer["deleted"][number] => {
      if (served.has(id)) {
        return { id, state: "still_served" };
      }
      if (input.stores === null) {
        return { id, state: "unknown" };
      }
      return { id, state: stored(id) === "deleted" ? "deleted" : "absent" };
    }),
  };
}

function frameHead(message: AiContextMessageRef | null) {
  return message === null
    ? null
    : {
      messageRef: message.messageRef,
      occurredAt: message.occurredAt?.toISOString() ?? null,
      isFromFan: message.isFromFan,
    };
}

export function buildAiContextFrameBody(input: {
  served: TranscriptServedSnapshot;
  requestedCount: number;
  coverage: ClientCoverageLevel;
  knownFanMessages?: Array<{ id: string; state: AiKnownFanMessageState }>;
  /** R20 HF-8в: the answers to the body's `coverageCheck`; absent unless the
   *  caller advertised `coverage-check-v1` and sent one. */
  coverageCheck?: AiCoverageCheckAnswer;
  /** What the hub did with the request's fresh text (live-text.ts); absent
   *  when the request sent none. */
  live?: AiFeatureContextFrameBody["live"];
  fanLanguageEvidence: AiFanLanguageEvidence;
  /** R20 HF-9: the checked pair of a Fansly request (`checkAiConversationPair`);
   *  absent when no pair was checked. */
  pair?: AiConversationPairState;
}): AiFeatureContextFrameBody {
  return {
    source: input.served.source,
    servedHead: frameHead(input.served.window[input.served.window.length - 1] ?? null),
    archiveHead: frameHead(input.served.archiveHead),
    window: { requested: input.requestedCount, served: input.served.window.length },
    coverage: input.coverage,
    ...(input.knownFanMessages !== undefined ? { knownFanMessages: input.knownFanMessages } : {}),
    ...(input.coverageCheck !== undefined ? { coverageCheck: input.coverageCheck } : {}),
    live: input.live ?? { status: "not_sent", accepted: 0, rejected: 0 },
    fanLanguageEvidence: input.fanLanguageEvidence,
    ...(input.pair !== undefined ? { pair: input.pair } : {}),
  };
}

/**
 * Assembles the frame for a generation whose transcript the hub loaded itself.
 * Database reads only, and only for the page the caller was already admitted
 * to: the coverage row, then one lookup for every named id (of
 * `knownFanMessageIds` and `coverageCheck`) the window does not hold. Both
 * reads fail open: the frame describes a generation, it must never cost one —
 * a failed read reports `unknown`.
 */
export async function loadAiContextFrameBody(
  app: Pick<AppContext, "db" | "logger">,
  input: {
    pageId: number;
    platform: string;
    conversationRef: string;
    served: TranscriptServedSnapshot;
    messages: readonly TranscriptMessage[];
    /** How many of the oldest transcript messages the prompt left out
     *  (`transcriptMessagesOmittedByBudget`). They are not in the window the
     *  frame reports: their ids answer like any message the model did not read. */
    omittedByPromptBudget?: number;
    requestedCount: number;
    knownFanMessageIds?: readonly string[];
    /** R20 HF-8в: the body's `coverageCheck`, passed only for a caller that
     *  advertised `coverage-check-v1`. */
    coverageCheck?: AiCoverageCheck;
    /** The frame's `live` block (applyLiveTextContext). */
    live?: AiFeatureContextFrameBody["live"];
    /** The frame's `pair` (R20 HF-9); absent when no pair was checked. */
    pair?: AiConversationPairState;
  },
): Promise<AiFeatureContextFrameBody> {
  const omitted = Math.min(Math.max(input.omittedByPromptBudget ?? 0, 0), input.served.window.length);
  const served: TranscriptServedSnapshot = omitted === 0
    ? input.served
    : { ...input.served, window: input.served.window.slice(omitted) };
  const messages = omitted === 0 ? input.messages : input.messages.slice(omitted);

  let coverage: ClientCoverageLevel = "unknown";
  try {
    coverage = await loadClientConversationCoverage(app, {
      pageId: input.pageId,
      platform: input.platform,
      conversationRef: input.conversationRef,
    });
  } catch (error) {
    app.logger.warn({ pageId: input.pageId, err: error }, "ai context frame coverage lookup failed");
  }

  // Every named id the window does not hold, from both fields, in one lookup.
  const servedRefs = new Set(served.window.map((message) => message.messageRef));
  const outsideWindow = [...new Set([
    ...(input.knownFanMessageIds ?? []),
    ...(input.coverageCheck?.window.map((item) => item.id) ?? []),
    ...(input.coverageCheck?.deletedIds ?? []),
  ])].filter((id) => !servedRefs.has(id));
  let stores: Map<string, AiKnownMessageStoreState> | null = new Map();
  if (outsideWindow.length > 0) {
    try {
      stores = await lookupAiKnownMessages(app.db, {
        pageId: input.pageId,
        platform: input.platform,
        conversationRef: input.conversationRef,
        messageRefs: outsideWindow,
        // The stores the serving reader read: the socket overlay hides a
        // message it tombstoned, so only then does its mark count.
        liveOverlay: served.source === "live_union",
      });
    } catch (error) {
      stores = null;
      app.logger.warn({ pageId: input.pageId, err: error }, "ai context frame known-message lookup failed");
    }
  }
  const knownFanMessages = input.knownFanMessageIds === undefined
    ? undefined
    : resolveKnownFanMessages({ ids: input.knownFanMessageIds, window: served.window, stores });
  const coverageCheck = input.coverageCheck === undefined
    ? undefined
    : resolveCoverageCheck({ check: input.coverageCheck, window: served.window, stores });

  return buildAiContextFrameBody({
    served,
    requestedCount: input.requestedCount,
    coverage,
    ...(knownFanMessages !== undefined ? { knownFanMessages } : {}),
    ...(coverageCheck !== undefined ? { coverageCheck } : {}),
    ...(input.live !== undefined ? { live: input.live } : {}),
    fanLanguageEvidence: fanLanguageEvidenceOf(messages),
    ...(input.pair !== undefined ? { pair: input.pair } : {}),
  });
}
