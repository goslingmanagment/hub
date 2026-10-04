import type {
  AI_CONTEXT_LIVE_STATUSES,
  AiFeatureContextFrame,
  AiLiveTextContext,
  AiStreamCapability,
} from "@agency_hub_core/contracts";
import { lookupAiLiveTextMessages, type AiLiveTextStoreState } from "@agency_hub_core/db";
import { normalizeDmMessageText, type Platform } from "@agency_hub_core/shared";

import { pageScopeFor } from "../../../api/request-auth.ts";
import type { AppContext } from "../../../bootstrap.ts";
import type { HumanAuthPrincipal } from "../../../services/auth.ts";
import { SERVED_CLIENT_CAPABILITIES } from "../../../services/client-capabilities.ts";
import { evaluateClientFeature } from "../../../services/client-features.ts";
import { loadClientSwitches } from "../../../services/client-switches.ts";
import { loadEffectiveConfig } from "../../../services/effective-config.ts";
import { BadRequestError, ContextConflictError } from "../../../services/errors.ts";
import {
  formatTranscript,
  normalizeTranscriptMessages,
  type OfapiChatMessage,
  type OperationFeature,
  type TranscriptMessage,
} from "../prompts/index.ts";
import type { AiContextMessageRef, TranscriptServedSnapshot } from "./context-frame.ts";

// chat-extension H-4c — the fresh text of the open OnlyFans chat.
//
// The hub's archive trails the chat a chatter is looking at by seconds to
// minutes. A client that reads the open page sends the last confirmed messages
// with the request (`liveTextContext`), and the hub merges them into the
// transcript it loaded itself, by platform message id, for THIS generation
// only. The client's text is written to no store the hub reads back: not the
// archives, not observations, not a dossier. It lives in the restricted record
// of the one generation, which is marked `contextScope: "principal-draft"` so
// no shared reader ever selects it.
//
// The merge runs AFTER the transcript loader returns and never inside it: the
// loader is the hub's own truth and stays exactly what it was for every caller
// that sends no fresh text.

/** The features that draft a message to the fan. Recap, Review and Coach read
 *  the hub's transcript only: a recap built on one person's page would be
 *  shared with everyone. */
export const AI_LIVE_TEXT_FEATURES = [
  "fast-reply",
  "improve-draft",
  "hi-greeting",
  "ping",
] as const satisfies readonly OperationFeature[];

/** `params.contextScope` of a generation whose transcript held text only its
 *  caller's client supplied. Shared readers skip every row that carries a scope
 *  (usableFanSummaryPredicate, packages/db ai-restricted.ts). */
export const AI_CONTEXT_SCOPE_PRINCIPAL_DRAFT = "principal-draft";

export type AiLiveTextMode = "off" | "shadow" | "serve";
export type AiLiveTextStatus = (typeof AI_CONTEXT_LIVE_STATUSES)[number];
export type AiLiveTextItem = AiLiveTextContext["items"][number];

/**
 * Refuses fresh text where it can never be used. Pure; runs after the page was
 * admitted and before any context loads. A refusal here is a client bug, so it
 * is a 400 with a machine reason. The owner's switch is NOT here: switched
 * off, fresh text is ignored, never refused (resolveLiveTextMode).
 *
 * `isFanslyRequest` comes from the feature service's single platform-branch
 * site rather than a second one here.
 */
export function assertLiveTextRequestShape(input: {
  feature: OperationFeature;
  isFanslyRequest: boolean;
  hasClientContext: boolean;
  capabilities: ReadonlySet<AiStreamCapability> | undefined;
}): void {
  if (!(AI_LIVE_TEXT_FEATURES as readonly string[]).includes(input.feature)) {
    throw new BadRequestError(`${input.feature} does not accept liveTextContext`, {
      reason: "live_text_not_allowed",
    });
  }
  if (input.isFanslyRequest) {
    throw new BadRequestError("liveTextContext is only accepted for OnlyFans pages", {
      reason: "live_text_not_allowed",
    });
  }
  if (input.hasClientContext) {
    throw new BadRequestError("liveTextContext cannot be combined with clientContext", {
      reason: "live_text_not_allowed",
    });
  }
  // The answer to fresh text is the `live` block of the context frame; a
  // caller that cannot read the frame cannot tell whether its text was used.
  if (!input.capabilities?.has("context-v1")) {
    throw new BadRequestError("liveTextContext requires the context-v1 capability", {
      reason: "capability_required",
    });
  }
}

/** The page as the chat-extension feature evaluation reads it. */
export interface LiveTextPage {
  id: number;
  label: string;
  platform: Platform;
  /** `pages.external_page_id`. */
  platformAccountId: string | null;
}

/**
 * What the hub does with fresh text on this page right now: the owner's
 * `aiLiveTextContextMode`, and only where the page's `freshText` flag is on
 * (the same evaluation the bootstrap announces: master switch, flag, platform,
 * binding, served capability).
 *
 * Anything that is not a clear `shadow` or `serve` is `off`, a failed read
 * included: fresh text is an addition, so the safe answer is to leave it out
 * and let the generation run on the hub's transcript. It never throws: a
 * client's bootstrap may be up to its TTL old, and a switch the owner has just
 * turned off must not fail the generations of clients that have not heard yet.
 */
export async function resolveLiveTextMode(app: AppContext, page: LiveTextPage): Promise<AiLiveTextMode> {
  try {
    const effective = await loadEffectiveConfig(app.db, app.config);
    const mode = effective.aiLiveTextContextMode;
    if (mode !== "shadow" && mode !== "serve") {
      return "off";
    }
    const switches = await loadClientSwitches(app);
    const availability = evaluateClientFeature({
      settings: switches.settings,
      page: { label: page.label, platform: page.platform, platformAccountId: page.platformAccountId },
      flag: "freshText",
      served: SERVED_CLIENT_CAPABILITIES,
    });
    return availability.available ? mode : "off";
  } catch (error) {
    app.logger.warn({ pageId: page.id, err: error }, "ai fresh-text switch lookup failed; fresh text ignored");
    return "off";
  }
}

export type AiLiveTextRejectReason =
  /** Tombstoned in a store of the page: a client's copy never brings it back. */
  | "deleted"
  /** The same id a second time in one snapshot: the first one stands. */
  | "duplicate"
  /** Nothing is left of the text once it is normalized like an archive row. */
  | "empty"
  /** The transcript cannot key the id (not a safe integer) or the time. */
  | "unusable"
  /** The store lookup failed: the id could be deleted or another chat's. */
  | "unverified";

export type AiLiveTextConflictReason =
  /** The hub holds the message as sent by the other side. */
  | "direction"
  /** The hub holds the id under another chat. */
  | "foreign_chat";

export interface AiLiveTextMerge {
  /** The merged transcript, oldest first, capped to the window. */
  messages: TranscriptMessage[];
  /** `messages` under the refs their stores keep, index for index. */
  window: AiContextMessageRef[];
  /** Ids of the client's items the merged window holds: text the hub's own
   *  transcript did not have. */
  accepted: string[];
  rejected: Array<{ id: string; reason: AiLiveTextRejectReason }>;
  /** Items that contradict what the hub holds. With any, the snapshot is not
   *  of this conversation and the merged transcript must not serve. */
  conflicts: Array<{ id: string; reason: AiLiveTextConflictReason }>;
  /** Items the hub's transcript already held, with the same sender: the hub's
   *  row stands. */
  matched: number;
  /** Items that merged in but lie before the window's cap. */
  outsideWindow: number;
  /** The client's newest item, and whether the hub's transcript held it. */
  headRef: string | null;
  hubSawHead: boolean;
}

/** Numeric ids compare as numbers without becoming one (they can pass 2^53). */
function compareNumericIds(left: string, right: string): number {
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}

/** One client item as a transcript message, through the path an archive row
 *  takes: `normalizeDmMessageText` is what turns a platform message into the
 *  archive's `text_plain` (tags and entities out), and the transcript
 *  normalizer is what every row then goes through. No price, tip or media: a
 *  client sends text only, and money is the hub's own. */
function liveItemToTranscriptMessage(item: AiLiveTextItem, id: number): TranscriptMessage | null {
  const shaped = {
    id,
    text: normalizeDmMessageText(item.text),
    isSentByMe: item.direction === "model",
    createdAt: item.occurredAt,
    price: null,
    isOpened: null,
    isTip: false,
    tipAmount: null,
    mediaCount: 0,
    media: [],
  } as OfapiChatMessage;
  const [message] = normalizeTranscriptMessages([shaped]);
  if (!message || !Number.isFinite(message.createdAtMs) || message.text.trim().length === 0) {
    return null;
  }
  return message;
}

/**
 * Merges a client's fresh text into the transcript the hub loaded. Pure.
 *
 * - The hub's rows come first and win: an id the transcript already holds keeps
 *   the hub's text (a difference between the page's HTML and the archive's
 *   plain text is not a disagreement), provided the client names the same
 *   sender.
 * - An id the hub holds as sent by the OTHER side, or under another chat, is a
 *   conflict: the snapshot is not of this conversation.
 * - A tombstoned id is rejected, never restored.
 * - The rest joins the transcript, sorted by time then id like every
 *   transcript, and the newest `limit` messages are kept.
 *
 * `stores` holds the store state of the ids the transcript does not hold;
 * `null` when that read failed, and then nothing the hub cannot vouch for
 * joins.
 */
export function mergeLiveText(input: {
  /** The loaded transcript, oldest first, and the refs of its messages, index
   *  for index (TranscriptContext.messages / .served.window). */
  messages: readonly TranscriptMessage[];
  window: readonly AiContextMessageRef[];
  items: readonly AiLiveTextItem[];
  stores: ReadonlyMap<string, AiLiveTextStoreState> | null;
  limit: number;
}): AiLiveTextMerge {
  const hubByRef = new Map(input.window.map((message) => [message.messageRef, message]));
  const hubIds = new Set(input.messages.map((message) => message.id));
  const merged = input.messages.map((message, index) => ({
    message,
    ref: input.window[index] ?? {
      messageRef: String(message.id),
      occurredAt: new Date(message.createdAtMs),
      isFromFan: message.sender === "Fan",
    },
    fromClient: false,
  }));

  const rejected: AiLiveTextMerge["rejected"] = [];
  const conflicts: AiLiveTextMerge["conflicts"] = [];
  const seen = new Set<string>();
  let matched = 0;
  let added = 0;
  let head: { ref: string; atMs: number } | null = null;

  for (const item of input.items) {
    const id = item.platformMessageId;
    if (seen.has(id)) {
      rejected.push({ id, reason: "duplicate" });
      continue;
    }
    seen.add(id);
    const atMs = Date.parse(item.occurredAt);
    if (
      Number.isFinite(atMs)
      && (head === null || atMs > head.atMs || (atMs === head.atMs && compareNumericIds(id, head.ref) > 0))
    ) {
      head = { ref: id, atMs };
    }

    const fromFan = item.direction === "fan";
    const held = hubByRef.get(id);
    if (held) {
      if (held.isFromFan === fromFan) {
        matched += 1;
      } else {
        conflicts.push({ id, reason: "direction" });
      }
      continue;
    }
    if (input.stores === null) {
      rejected.push({ id, reason: "unverified" });
      continue;
    }
    const state = input.stores.get(id);
    if (state?.foreign) {
      conflicts.push({ id, reason: "foreign_chat" });
      continue;
    }
    if (state?.deleted) {
      rejected.push({ id, reason: "deleted" });
      continue;
    }
    if (state !== undefined && state.isSentByMe !== null && state.isSentByMe === fromFan) {
      conflicts.push({ id, reason: "direction" });
      continue;
    }
    // The transcript keys a message by Number(ref): an id it cannot hold
    // exactly, or one that collides with a row already there, cannot join.
    const numericId = Number(id);
    if (!Number.isSafeInteger(numericId) || hubIds.has(numericId)) {
      rejected.push({ id, reason: "unusable" });
      continue;
    }
    const message = liveItemToTranscriptMessage(item, numericId);
    if (message === null) {
      rejected.push({ id, reason: Number.isFinite(atMs) ? "empty" : "unusable" });
      continue;
    }
    hubIds.add(numericId);
    added += 1;
    merged.push({
      message,
      ref: { messageRef: id, occurredAt: new Date(message.createdAtMs), isFromFan: fromFan },
      fromClient: true,
    });
  }

  // The transcript's own order (normalizeTranscriptMessages), then its cap.
  merged.sort((left, right) => (
    left.message.createdAtMs - right.message.createdAtMs || left.message.id - right.message.id
  ));
  // `slice(-0)` is the whole array, not none of it.
  const kept = input.limit > 0 ? merged.slice(-input.limit) : [];
  const accepted = kept.filter((entry) => entry.fromClient).map((entry) => entry.ref.messageRef);

  return {
    messages: kept.map((entry) => entry.message),
    window: kept.map((entry) => entry.ref),
    accepted,
    rejected,
    conflicts,
    matched,
    outsideWindow: added - accepted.length,
    headRef: head?.ref ?? null,
    hubSawHead: head !== null && hubByRef.has(head.ref),
  };
}

function countByReason<R extends string>(entries: ReadonlyArray<{ reason: R }>): Partial<Record<R, number>> {
  const counts: Partial<Record<R, number>> = {};
  for (const entry of entries) {
    counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
  }
  return counts;
}

/**
 * What the generation's context manifest records about the fresh text: message
 * ids, counts and switches. NEVER a message's text or time: in `shadow` the
 * client's text reaches no prompt, and the manifest must not be the place it
 * is kept after all.
 */
export function liveTextManifest(input: {
  mode: Exclude<AiLiveTextMode, "off">;
  status: AiLiveTextStatus;
  sent: number;
  merge: AiLiveTextMerge;
}): Record<string, unknown> {
  const { merge } = input;
  return {
    source: "client-supplied",
    mode: input.mode,
    status: input.status,
    sent: input.sent,
    accepted: merge.accepted.length,
    rejected: merge.rejected.length,
    conflicts: merge.conflicts.length,
    matched: merge.matched,
    outsideWindow: merge.outsideWindow,
    headRef: merge.headRef,
    archiveSawHead: merge.hubSawHead,
    acceptedRefs: merge.accepted,
    rejectedRefs: merge.rejected.map((entry) => entry.id),
    rejectedReasons: countByReason(merge.rejected),
    conflictRefs: merge.conflicts.map((entry) => entry.id),
    conflictReasons: countByReason(merge.conflicts),
  };
}

/** The part of a loaded transcript the merge reads and replaces
 *  (`TranscriptContext` satisfies it; named here so this file does not import
 *  the loader that re-exports it). */
export interface LiveTextTranscript {
  transcript: string;
  messages: TranscriptMessage[];
  contextManifest: Record<string, unknown>;
  served: TranscriptServedSnapshot;
}

export interface AppliedLiveText<T extends LiveTextTranscript> {
  /** What the generation reads: the loaded transcript as it was, or in `serve`
   *  the merged one. */
  transcript: T;
  /** The `live` block of the `context_v1` frame. */
  live: AiFeatureContextFrame["live"];
  /** Set when the served transcript holds text only the caller's client
   *  supplied; lands in the generation's `params.contextScope`. */
  contextScope?: typeof AI_CONTEXT_SCOPE_PRINCIPAL_DRAFT;
}

/**
 * Applies a request's fresh text to the transcript the hub loaded.
 *
 * - No fresh text: the loaded transcript, untouched (`not_sent`).
 * - Switched off: the same, and the frame says `disabled`. Nothing is recorded:
 *   the generation is byte for byte one without fresh text.
 * - `shadow`: the merge is computed and recorded in the context manifest (ids
 *   and counts), and the loaded transcript serves. A conflict is recorded, not
 *   thrown: a shadow mode never changes what a caller gets.
 * - `serve`: a conflict refuses the request (400 `context_conflict`). Otherwise
 *   the merged transcript serves; with at least one accepted item the
 *   generation is scoped `principal-draft`.
 *
 * One database read (the store lookup for the ids the transcript does not
 * hold), and only for a page the caller was already admitted to. It fails
 * closed: without it nothing the hub cannot vouch for joins the transcript.
 */
export async function applyLiveTextContext<T extends LiveTextTranscript>(
  app: AppContext,
  input: {
    principal: HumanAuthPrincipal;
    page: LiveTextPage;
    conversationRef: string;
    /** The transcript window of this generation. */
    limit: number;
    transcript: T;
    liveTextContext: AiLiveTextContext | undefined;
  },
): Promise<AppliedLiveText<T>> {
  if (input.liveTextContext === undefined) {
    return { transcript: input.transcript, live: { status: "not_sent", accepted: 0, rejected: 0 } };
  }
  const mode = await resolveLiveTextMode(app, input.page);
  if (mode === "off") {
    return { transcript: input.transcript, live: { status: "disabled", accepted: 0, rejected: 0 } };
  }

  const { items } = input.liveTextContext;
  const loaded = input.transcript;
  const heldRefs = new Set(loaded.served.window.map((message) => message.messageRef));
  const outside = [...new Set(items.map((item) => item.platformMessageId))].filter((id) => !heldRefs.has(id));
  let stores: Map<string, AiLiveTextStoreState> | null = new Map();
  if (outside.length > 0) {
    try {
      stores = await lookupAiLiveTextMessages(app.db, {
        pageId: input.page.id,
        platform: input.page.platform,
        conversationRef: input.conversationRef,
        messageRefs: outside,
        // Other pages are read only as far as the caller may read them.
        otherPageIds: pageScopeFor(input.principal) ?? null,
      });
    } catch (error) {
      stores = null;
      app.logger.warn({ pageId: input.page.id, err: error }, "ai fresh-text store lookup failed; unverified items rejected");
    }
  }

  const merge = mergeLiveText({
    messages: loaded.messages,
    window: loaded.served.window,
    items,
    stores,
    limit: input.limit,
  });
  if (mode === "serve" && merge.conflicts.length > 0) {
    throw new ContextConflictError(merge.conflicts.map((conflict) => conflict.id));
  }

  // A conflicting item was not used either: to the client it is one more
  // rejected item (only `shadow` gets this far with one).
  const rejected = merge.rejected.length + merge.conflicts.length;
  const status: AiLiveTextStatus = mode === "shadow"
    ? "shadow"
    : merge.accepted.length === 0 && rejected > 0 ? "rejected" : "served";
  const contextManifest = {
    ...loaded.contextManifest,
    liveText: liveTextManifest({ mode, status, sent: items.length, merge }),
  };
  const live = { status, accepted: merge.accepted.length, rejected };
  if (mode === "shadow") {
    return { transcript: { ...loaded, contextManifest }, live };
  }
  return {
    transcript: {
      ...loaded,
      transcript: formatTranscript(merge.messages),
      messages: merge.messages,
      contextManifest,
      served: { ...loaded.served, window: merge.window },
    },
    live,
    ...(merge.accepted.length > 0 ? { contextScope: AI_CONTEXT_SCOPE_PRINCIPAL_DRAFT } : {}),
  };
}
