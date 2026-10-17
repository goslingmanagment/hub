import type { AiLivePpvContext } from "@agency_hub_core/contracts";

import type { AppContext } from "../../../bootstrap.ts";
import { BadRequestError } from "../../../services/errors.ts";
import { formatTranscript, type OperationFeature, type TranscriptMessage } from "../prompts/index.ts";
import {
  AI_CONTEXT_SCOPE_PRINCIPAL_DRAFT,
  AI_LIVE_TEXT_FEATURES,
  resolveLiveTextMode,
  type AiLiveTextMode,
  type LiveTextPage,
  type LiveTextTranscript,
} from "./live-text.ts";

// chat-extension X51 — the PPV state of the open OnlyFans chat as the platform
// gives it right now.
//
// The transcript marks the model's paid message `[… - PPV $X.XX, purchased]`,
// `not purchased` or `unknown` from what the hub's stores hold (OnlyFans'
// `isOpened`, a purchase fact). A store may hold a paid message without that
// flag, or with a `false` from before the fan bought it, and a message the
// archive has not caught yet carries no mark at all. The client reads the chat
// it is showing from OnlyMonster's API, whose messages carry OnlyFans' own
// `isOpened`, and sends the model's paid messages with their price and that
// flag (`livePpvContext`). The hub applies it to the transcript of THIS
// generation only, after the fresh text joined (context/live-text.ts), under
// the same owner's switch, and stores it nowhere: a generation it changed is
// scoped `principal-draft`, like one served fresh text.
//
// The client says what OnlyFans says now; the hub's rows say what was seen
// before. A purchase does not come undone, so `purchased` from either side
// stands. The price on a mark is the hub's own; the client's is used only for a
// message that carries no label at all (a fresh message the archive has not
// caught, a paid text). A message the hub holds with media and no price is the
// hub's free media: it is left as it is, since the image notes read its label
// as written and may describe it (media-notes.ts), never a paid body.

export type AiLivePpvItem = AiLivePpvContext["items"][number];

/**
 * Refuses a PPV state where it can never be used: the features that take the
 * fresh text, never beside clientContext, on an OnlyFans page (a Fansly page
 * marks each attachment from its own stores, context/fansly-ppv.ts). A refusal
 * is a client bug: a 400 with the fresh text's reason, `live_text_not_allowed`
 * (one reason for both fields of the open chat). The owner's switch is not here.
 */
export function assertLivePpvRequestShape(input: {
  feature: OperationFeature;
  /** The admitted page is a Fansly one (the request's platform is the page's). */
  isFanslyPage: boolean;
  hasClientContext: boolean;
}): void {
  if (!(AI_LIVE_TEXT_FEATURES as readonly string[]).includes(input.feature)) {
    throw new BadRequestError(`${input.feature} does not accept livePpvContext`, { reason: "live_text_not_allowed" });
  }
  if (input.hasClientContext) {
    throw new BadRequestError("livePpvContext cannot be combined with clientContext", { reason: "live_text_not_allowed" });
  }
  if (input.isFanslyPage) {
    throw new BadRequestError("livePpvContext is taken on an OnlyFans page only", { reason: "live_text_not_allowed" });
  }
}

/** A transcript's PPV mark: the media label's body before it, if any, then the price and the state. */
const PPV_MARK = /^\[(?:(.+) - )?PPV \$(\d+\.\d{2}), (purchased|not purchased|unknown)\]$/;

export type AiLivePpvIgnoredReason =
  /** The id is not in the served transcript (older than its window, or unknown). */
  | "absent"
  /** The transcript holds the id as the fan's message: a fan's message has no PPV state. */
  | "fan"
  /** The hub holds the message with labels and no price (its free media): left as the image notes read it. */
  | "unpriced"
  /** The same id a second time (the schema refuses it; kept for a direct caller). */
  | "duplicate";

export interface AiLivePpvApplied {
  /** The transcript, with the marks the client's state changed. */
  messages: TranscriptMessage[];
  /** Ids whose mark the client's state changed or added. */
  changed: string[];
  /** Ids the transcript holds with the same state already. */
  matched: string[];
  ignored: Array<{ id: string; reason: AiLivePpvIgnoredReason }>;
}

function usd(amount: number): string {
  return amount.toFixed(2);
}

/**
 * Applies a client's PPV state to the transcript's messages. Pure; the
 * messages it does not change are returned as they were (the same objects).
 */
export function applyLivePpv(messages: readonly TranscriptMessage[], items: readonly AiLivePpvItem[]): AiLivePpvApplied {
  const byId = new Map<string, AiLivePpvItem>();
  const ignored: AiLivePpvApplied["ignored"] = [];
  for (const item of items) {
    if (byId.has(item.platformMessageId)) {
      ignored.push({ id: item.platformMessageId, reason: "duplicate" });
      continue;
    }
    byId.set(item.platformMessageId, item);
  }
  const changed: string[] = [];
  const matched: string[] = [];
  const seen = new Set<string>();
  const out = messages.map((message) => {
    const item = byId.get(message.id);
    if (item === undefined) {
      return message;
    }
    seen.add(message.id);
    if (message.sender !== "Model") {
      ignored.push({ id: message.id, reason: "fan" });
      return message;
    }
    const labels = [...message.labels];
    const at = labels.findIndex((label) => PPV_MARK.test(label));
    if (at >= 0) {
      const [, body, price, state] = PPV_MARK.exec(labels[at] as string) as RegExpExecArray;
      const next = state === "purchased" || item.purchased ? "purchased" : "not purchased";
      if (next === state) {
        matched.push(message.id);
        return message;
      }
      labels[at] = `[${body !== undefined ? `${body} - ` : ""}PPV $${price}, ${next}]`;
    } else if (labels.length > 0) {
      ignored.push({ id: message.id, reason: "unpriced" });
      return message;
    } else {
      labels.push(`[PPV $${usd(item.priceUsd)}, ${item.purchased ? "purchased" : "not purchased"}]`);
    }
    changed.push(message.id);
    return { ...message, labels };
  });
  for (const id of byId.keys()) {
    if (!seen.has(id)) {
      ignored.push({ id, reason: "absent" });
    }
  }
  return { messages: out, changed, matched, ignored };
}

export interface AppliedLivePpv<T extends LiveTextTranscript> {
  /** What the generation reads: the transcript as it came, or in `serve` with the client's state. */
  transcript: T;
  /** Set when the served transcript holds a state only the caller's client supplied. */
  contextScope?: typeof AI_CONTEXT_SCOPE_PRINCIPAL_DRAFT;
}

/**
 * Applies a request's PPV state to the transcript the generation reads (after
 * the fresh text joined). No state, or the switch off: the transcript as it
 * came. `shadow`: what would change is recorded in the context manifest (ids
 * and counts), and the transcript serves as it came. `serve`: the changed
 * transcript serves, and a generation with at least one changed mark is scoped
 * `principal-draft`. Never throws: a state the hub cannot apply is no reason to
 * fail a generation.
 */
export async function applyLivePpvContext<T extends LiveTextTranscript>(
  app: AppContext,
  input: {
    page: LiveTextPage;
    transcript: T;
    livePpvContext: AiLivePpvContext | undefined;
    /** The fresh text's mode when the caller resolved it already. */
    mode?: AiLiveTextMode;
  },
): Promise<AppliedLivePpv<T>> {
  if (input.livePpvContext === undefined) {
    return { transcript: input.transcript };
  }
  const mode = input.mode ?? await resolveLiveTextMode(app, input.page);
  if (mode === "off") {
    return { transcript: input.transcript };
  }
  let applied: AiLivePpvApplied;
  try {
    applied = applyLivePpv(input.transcript.messages, input.livePpvContext.items);
  } catch (error) {
    app.logger.warn(
      { pageId: input.page.id, errorName: error instanceof Error ? error.name : typeof error },
      "ai live PPV state failed; ignored",
    );
    return { transcript: input.transcript };
  }
  const contextManifest = {
    ...input.transcript.contextManifest,
    livePpv: {
      source: "client-supplied",
      mode,
      sent: input.livePpvContext.items.length,
      changed: applied.changed.length,
      matched: applied.matched.length,
      ignored: applied.ignored.length,
      changedRefs: applied.changed,
      ignoredRefs: applied.ignored.map((entry) => entry.id),
    },
  };
  if (mode === "shadow" || applied.changed.length === 0) {
    return { transcript: { ...input.transcript, contextManifest } };
  }
  return {
    transcript: {
      ...input.transcript,
      transcript: formatTranscript(applied.messages),
      messages: applied.messages,
      contextManifest,
    },
    contextScope: AI_CONTEXT_SCOPE_PRINCIPAL_DRAFT,
  };
}
