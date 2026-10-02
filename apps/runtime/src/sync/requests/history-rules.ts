import { createHash } from "node:crypto";

import {
  HISTORY_INPUT_MAX_LENGTH,
  type HistoryDepth,
  type HistoryInputKind,
  type HistoryItemAnchor,
  type HistoryItemSatisfiedBy,
  type HistoryThreadFacts,
} from "@agency_hub_core/db";
import { compareFanslySnowflakeIds } from "@agency_hub_core/shared";

// The pure rules of a history request (plan §4.2, design §7.1): how inputs
// are normalized and fingerprinted, which chat a fan id names, when a fan's
// depth is anchored, when the chat must be read from its head first, and
// when a fan is satisfied. The service (history.ts) and the DM resource's
// `.history` plan share them, so the plan and the satisfaction hook can never
// disagree about what a fan still needs.

const DECIMAL = /^[0-9]{1,30}$/;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ── inputs ────────────────────────────────────────────────────────────────────

export type HistoryFanInput =
  | { kind: "fan"; platformUserId: string }
  | { kind: "conversation"; conversationRef: string }
  | { kind: "chat_url"; url: string };

export interface NormalizedHistoryInput {
  /** Position among the request's distinct inputs (0-based). */
  ordinal: number;
  inputKind: HistoryInputKind;
  /** The input as given, trimmed (stored, unique per request). */
  inputRef: string;
  /** A Fansly account id the input names (kind fan), when well-formed. */
  fanRef: string | null;
  /** The chat's group id the input names (conversation, chat URL), when well-formed. */
  groupId: string | null;
}

export const HISTORY_INPUT_KIND_OF: Readonly<Record<HistoryFanInput["kind"], HistoryInputKind>> = {
  fan: "fan_platform_user_id",
  conversation: "conversation_ref",
  chat_url: "chat_url",
};

/**
 * The group id of a Fansly chat link (`https://fansly.com/messages/<id>`,
 * with or without scheme, `www.`, query or trailing slash). Hand-parsed like
 * the agent resolver's inputs (`normalizeResolveInput`): `new URL` throws on
 * strings a human pastes. Null for anything else.
 */
export function parseFanslyChatUrl(raw: string): string | null {
  const withoutScheme = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const withoutQuery = withoutScheme.split(/[?#]/, 1)[0] ?? "";
  const segments = withoutQuery.split("/").filter((segment) => segment.length > 0);
  const host = (segments[0] ?? "").toLowerCase().replace(/^www\./, "");
  if (host !== "fansly.com") return null;
  const at = segments.indexOf("messages");
  const id = at === -1 ? undefined : segments[at + 1];
  return id !== undefined && DECIMAL.test(id) ? id : null;
}

export class HistoryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryInputError";
  }
}

/**
 * Trim and de-duplicate a request's fans (an identical input twice is one
 * fan). A malformed id is not an error here: it resolves to nothing and the
 * fan is refused `not_found` — a bad fan never fails the request. Throws
 * `HistoryInputError` for an input that cannot be stored (empty, too long,
 * unknown kind).
 */
export function normalizeHistoryInputs(fans: readonly HistoryFanInput[]): NormalizedHistoryInput[] {
  const seen = new Set<string>();
  const inputs: NormalizedHistoryInput[] = [];
  for (const [index, fan] of fans.entries()) {
    const raw = fan.kind === "fan" ? fan.platformUserId : fan.kind === "conversation" ? fan.conversationRef : fan.kind === "chat_url" ? fan.url : null;
    if (raw === null) throw new HistoryInputError(`fans[${index}]: unknown kind`);
    if (typeof raw !== "string") throw new HistoryInputError(`fans[${index}]: the reference must be a string`);
    const ref = raw.trim();
    if (ref.length === 0) throw new HistoryInputError(`fans[${index}]: the reference is empty`);
    if (ref.length > HISTORY_INPUT_MAX_LENGTH) {
      throw new HistoryInputError(`fans[${index}]: the reference is longer than ${HISTORY_INPUT_MAX_LENGTH} characters`);
    }
    const inputKind = HISTORY_INPUT_KIND_OF[fan.kind];
    const key = `${inputKind}\u0000${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    inputs.push({
      ordinal: inputs.length,
      inputKind,
      inputRef: ref,
      fanRef: fan.kind === "fan" && DECIMAL.test(ref) ? ref : null,
      groupId: fan.kind === "conversation" ? (DECIMAL.test(ref) ? ref : null) : fan.kind === "chat_url" ? parseFanslyChatUrl(ref) : null,
    });
  }
  return inputs;
}

/** The depth as the fingerprint and the API carry it. */
export function depthJson(depth: HistoryDepth): Record<string, unknown> {
  switch (depth.kind) {
    case "all":
      return { kind: "all" };
    case "latest":
      return { kind: "latest", count: depth.count };
    case "before_boundary":
      return {
        kind: "before_boundary",
        at: depth.at === null ? null : depth.at.toISOString(),
        messageRef: depth.messageRef,
      };
  }
}

/**
 * The request fingerprint (design §7.1.3, the `hydrationRequestFingerprint`
 * pattern): the page, the sorted normalized inputs, the depth and the
 * reason's own digest — never the reason itself.
 */
export function historyRequestFingerprint(input: {
  pageId: number;
  inputs: readonly Pick<NormalizedHistoryInput, "inputKind" | "inputRef">[];
  depth: HistoryDepth;
  reason: string;
}): string {
  const inputs = input.inputs.map((item) => `${item.inputKind}:${item.inputRef}`).sort();
  return sha256(JSON.stringify(["history-request-v1", input.pageId, inputs, depthJson(input.depth), sha256(input.reason)]));
}

export function reasonDigest(reason: string): string {
  return sha256(reason);
}

// ── which chat a fan names ────────────────────────────────────────────────────

/**
 * Of several visible chats of one fan on one page ([A16]: 3 fans on
 * 2026-10-02), the one with the latest message, then the newest row.
 */
export function chooseFanThread(candidates: readonly HistoryThreadFacts[]): HistoryThreadFacts | null {
  let best: HistoryThreadFacts | null = null;
  for (const candidate of candidates) {
    if (!candidate.isVisible) continue;
    if (best === null) {
      best = candidate;
      continue;
    }
    const left = candidate.lastMessageAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const right = best.lastMessageAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (left > right || (left === right && candidate.threadId > best.threadId)) best = candidate;
  }
  return best;
}

// ── anchors (design §7.1.4) ───────────────────────────────────────────────────

/** The chain columns the anchor and satisfaction rules read. */
export type ChainFacts = Pick<HistoryThreadFacts,
  "headConfirmedId" | "headConfirmedAt" | "contiguousOldestId" | "contiguousOldestAt" | "contiguousCount"
  | "chainUpwardCount" | "chainEpoch" | "historyState" | "historyProof">;

export function chainComplete(chain: Pick<ChainFacts, "historyState" | "historyProof">): boolean {
  return chain.historyState === "complete" && chain.historyProof === "empty_page";
}

export function anchorOfChain(chain: ChainFacts): Omit<HistoryItemAnchor, "fixedAt"> | null {
  if (chain.headConfirmedId === null) return null;
  return { messageId: chain.headConfirmedId, upwardCount: chain.chainUpwardCount, chainEpoch: chain.chainEpoch };
}

/**
 * The anchor at intake: the chain's head, when the page's socket is open,
 * verified, and has been since before the head was confirmed — no message can
 * have arrived above it unseen. Otherwise none: the first read is a head read.
 */
export function anchorAtIntake(chain: ChainFacts, socket: { verifiedAt: Date } | null): Omit<HistoryItemAnchor, "fixedAt"> | null {
  if (socket === null || chain.headConfirmedAt === null) return null;
  if (socket.verifiedAt.getTime() > chain.headConfirmedAt.getTime()) return null;
  return anchorOfChain(chain);
}

/** What the anchor rules know of the chat's `dm-messages.history` walk. */
export interface HistoryWalkFacts {
  /** Capture time of the walk's latest head read. */
  historyHeadAt: Date | null;
  /** A head walk is staged above the chain (§8.1): the head is not accepted yet. */
  segmentStaged: boolean;
}

export type AnchorDecision =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "set"; anchor: Omit<HistoryItemAnchor, "fixedAt"> };

/**
 * After a read of the chat (§7.1.4, §7.1.6): an anchor of another chain epoch
 * is cleared; a fan without one is anchored at the chain's head once a head
 * was accepted after the fan was filed — confirmed by any read (its capture
 * time is later), or read by this walk with nothing left staged (a head that
 * moved down or showed nothing new still is the head).
 */
export function decideAnchor(
  item: { anchor: Pick<HistoryItemAnchor, "chainEpoch"> | null; createdAt: Date },
  chain: ChainFacts,
  walk: HistoryWalkFacts,
): AnchorDecision {
  if (item.anchor !== null) {
    return item.anchor.chainEpoch === chain.chainEpoch ? { kind: "keep" } : { kind: "clear" };
  }
  const anchor = anchorOfChain(chain);
  if (anchor === null) return { kind: "keep" };
  const filed = item.createdAt.getTime();
  const confirmedSince = chain.headConfirmedAt !== null && chain.headConfirmedAt.getTime() >= filed;
  const readSince = walk.historyHeadAt !== null && walk.historyHeadAt.getTime() >= filed && !walk.segmentStaged;
  return confirmedSince || readSince ? { kind: "set", anchor } : { kind: "keep" };
}

/**
 * The `.history` walk reads the chat's head (not `before = contiguous oldest`)
 * while a fan attached to it has no anchor and no head read of this walk has
 * happened since that fan was filed (design §7.1.4: "the first read is a head
 * read"). One head read per newcomer, never a loop: a head that anchors
 * nothing (moved down, showed nothing new) still counts as read.
 */
export function needsHistoryHeadRead(
  items: ReadonlyArray<{ anchor: unknown; createdAt: Date }>,
  historyHeadAt: Date | null,
): boolean {
  return items.some((item) => item.anchor === null
    && (historyHeadAt === null || historyHeadAt.getTime() < item.createdAt.getTime()));
}

// ── satisfaction (design §7.1.6) ──────────────────────────────────────────────

/** Chain messages counted for `latest N` from the anchor: the chain minus what
 *  it gained above the anchor. Null without an anchor of this epoch. */
export function belowAnchor(anchor: Pick<HistoryItemAnchor, "upwardCount" | "chainEpoch"> | null, chain: ChainFacts): number | null {
  if (anchor === null || anchor.chainEpoch !== chain.chainEpoch) return null;
  return Math.max(0, chain.contiguousCount - (chain.chainUpwardCount - anchor.upwardCount));
}

export interface Satisfaction {
  by: Exclude<HistoryItemSatisfiedBy, "already_satisfied">;
  oldestId: string | null;
  /** Chain messages counted for the depth. */
  count: number;
}

/**
 * Whether a fan's depth is met by the chat's chain:
 *   all          — the chain is complete (proven by an empty page; decision №3);
 *   latest N     — ≥ N chain messages below the anchor (same epoch), or complete;
 *   before_boundary — the chain reaches the boundary (time, or message id by
 *                  snowflake), or complete.
 */
export function judgeSatisfaction(
  item: { depth: HistoryDepth; anchor: Pick<HistoryItemAnchor, "upwardCount" | "chainEpoch"> | null },
  chain: ChainFacts,
): Satisfaction | null {
  const complete = chainComplete(chain);
  switch (item.depth.kind) {
    case "all":
      return complete ? { by: "empty_page", oldestId: chain.contiguousOldestId, count: chain.contiguousCount } : null;
    case "latest": {
      const below = belowAnchor(item.anchor, chain);
      if (below !== null && below >= item.depth.count) {
        return { by: "latest_n", oldestId: chain.contiguousOldestId, count: below };
      }
      return complete ? { by: "latest_n", oldestId: chain.contiguousOldestId, count: below ?? chain.contiguousCount } : null;
    }
    case "before_boundary": {
      const reached = chain.contiguousOldestId !== null && (chain.historyState === "partial" || complete) && (
        (item.depth.at !== null && chain.contiguousOldestAt !== null && chain.contiguousOldestAt.getTime() <= item.depth.at.getTime())
        || (item.depth.messageRef !== null && DECIMAL.test(item.depth.messageRef)
          && (compareFanslySnowflakeIds(chain.contiguousOldestId, item.depth.messageRef) ?? 1) <= 0)
      );
      return reached || complete ? { by: "boundary", oldestId: chain.contiguousOldestId, count: chain.contiguousCount } : null;
    }
  }
}

/** Messages a fan has loaded so far (its view, and the frozen final). */
export function loadedMessages(
  item: { depth: HistoryDepth; anchor: Pick<HistoryItemAnchor, "upwardCount" | "chainEpoch"> | null },
  chain: ChainFacts,
): number {
  if (item.depth.kind === "latest") {
    const below = belowAnchor(item.anchor, chain);
    return Math.min(item.depth.count, below ?? 0);
  }
  return chain.contiguousCount;
}
