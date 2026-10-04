import type {
  AI_CONTEXT_SOURCES,
  AI_FAN_LANGUAGE_EVIDENCE,
  AI_KNOWN_FAN_MESSAGE_STATES,
  ClientCoverageLevel,
} from "@agency_hub_core/contracts";
import { lookupAiKnownMessages, type AiKnownMessageStoreState } from "@agency_hub_core/db";

import type { AppContext } from "../../../bootstrap.ts";
import type { AiFeatureContextFrameBody } from "../../../services/ai-gateway.ts";
import { loadClientConversationCoverage } from "../../../services/client-coverage.ts";
import type { TranscriptMessage } from "../prompts/index.ts";

// chat-extension H-4b — the `context_v1` frame: which transcript snapshot
// ACTUALLY served a generation. Everything here describes the transcript the
// loader already built; nothing changes what the model reads.

export type AiContextSource = (typeof AI_CONTEXT_SOURCES)[number];
export type AiKnownFanMessageState = (typeof AI_KNOWN_FAN_MESSAGE_STATES)[number];
export type AiFanLanguageEvidence = (typeof AI_FAN_LANGUAGE_EVIDENCE)[number];

/** One message as the frame names it: the ref its store keeps, never the
 *  transcript's numeric id. */
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
   *  the window cap, so exactly what the prompt holds. */
  window: AiContextMessageRef[];
  /** The plain archive reader's newest row. Diagnostics: with `source: "union"`
   *  the transcript may reach past it. */
  archiveHead: AiContextMessageRef | null;
}

/**
 * The transcript's messages under the refs their stores keep. The transcript
 * keys a message by `Number(ref)`; a ref is recovered from the served rows
 * with the transcript's own rules: only rows it can shape (a finite numeric
 * ref and an event time), the first row of a ref wins.
 */
export function servedWindowOf(
  rows: ReadonlyArray<{ messageRef: string; occurredAt: Date | null }>,
  messages: readonly TranscriptMessage[],
): AiContextMessageRef[] {
  const refById = new Map<number, string>();
  for (const row of rows) {
    const id = Number(row.messageRef);
    if (Number.isFinite(id) && row.occurredAt !== null && !refById.has(id)) {
      refById.set(id, row.messageRef);
    }
  }
  return messages.map((message) => ({
    messageRef: refById.get(message.id) ?? String(message.id),
    occurredAt: new Date(message.createdAtMs),
    isFromFan: message.sender === "Fan",
  }));
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
 * the transcript that served the generation:
 * - `included`: the served window holds it as a fan message;
 * - `deleted`: not in the window, and tombstoned in this conversation;
 * - `absent`: not in the window (never seen for this conversation, an id of
 *   another chat, or older than the window);
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
  fanLanguageEvidence: AiFanLanguageEvidence;
}): AiFeatureContextFrameBody {
  return {
    source: input.served.source,
    servedHead: frameHead(input.served.window[input.served.window.length - 1] ?? null),
    archiveHead: frameHead(input.served.archiveHead),
    window: { requested: input.requestedCount, served: input.served.window.length },
    coverage: input.coverage,
    ...(input.knownFanMessages !== undefined ? { knownFanMessages: input.knownFanMessages } : {}),
    // The client's fresh text is a later step: none is accepted yet.
    live: { status: "not_sent", accepted: 0, rejected: 0 },
    fanLanguageEvidence: input.fanLanguageEvidence,
  };
}

/**
 * Assembles the frame for a generation whose transcript the hub loaded itself.
 * Database reads only, and only for the page the caller was already admitted
 * to. Both reads fail open: the frame describes a generation, it must never
 * cost one — a failed read reports `unknown`.
 */
export async function loadAiContextFrameBody(
  app: Pick<AppContext, "db" | "logger">,
  input: {
    pageId: number;
    platform: string;
    conversationRef: string;
    served: TranscriptServedSnapshot;
    messages: readonly TranscriptMessage[];
    requestedCount: number;
    knownFanMessageIds?: readonly string[];
  },
): Promise<AiFeatureContextFrameBody> {
  let coverage: ClientCoverageLevel = "unknown";
  try {
    coverage = await loadClientConversationCoverage(app, {
      pageId: input.pageId,
      conversationRef: input.conversationRef,
    });
  } catch (error) {
    app.logger.warn({ pageId: input.pageId, err: error }, "ai context frame coverage lookup failed");
  }

  let knownFanMessages: Array<{ id: string; state: AiKnownFanMessageState }> | undefined;
  if (input.knownFanMessageIds !== undefined) {
    const servedRefs = new Set(input.served.window.map((message) => message.messageRef));
    const outsideWindow = input.knownFanMessageIds.filter((id) => !servedRefs.has(id));
    let stores: Map<string, AiKnownMessageStoreState> | null = new Map();
    if (outsideWindow.length > 0) {
      try {
        stores = await lookupAiKnownMessages(app.db, {
          pageId: input.pageId,
          platform: input.platform,
          conversationRef: input.conversationRef,
          messageRefs: outsideWindow,
        });
      } catch (error) {
        stores = null;
        app.logger.warn({ pageId: input.pageId, err: error }, "ai context frame known-message lookup failed");
      }
    }
    knownFanMessages = resolveKnownFanMessages({
      ids: input.knownFanMessageIds,
      window: input.served.window,
      stores,
    });
  }

  return buildAiContextFrameBody({
    served: input.served,
    requestedCount: input.requestedCount,
    coverage,
    ...(knownFanMessages !== undefined ? { knownFanMessages } : {}),
    fanLanguageEvidence: fanLanguageEvidenceOf(input.messages),
  });
}
