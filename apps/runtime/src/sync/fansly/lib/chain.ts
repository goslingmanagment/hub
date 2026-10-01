import { fanslySnowflakeToDate } from "@agency_hub_core/shared";

// Fansly Sync Engine (plan §6.2, design §8.1): THE definition of a contiguous
// DM chain and of a complete history. Pure: the engine's DM apply and the
// journal rebuild (chain-rebuild.ts) fold the same pages through the same
// function, so an online chain and a rebuilt one agree by construction.
//
// A chain is proven by consecutive vendor pages from a confirmed head:
//   - a head read (`before` absent) confirms the newest message;
//   - a read `before = X` continues the chain only when X is the chain's own
//     oldest id (or the oldest id of a staged head walk);
//   - complete is proved ONLY by an accepted EMPTY page at
//     `before = contiguous_oldest_id`, or by the empty head of a chat the hub
//     holds nothing of (owner decision №3). A short page is not an end, an
//     overlap with stored messages is not a proof, a repeated cursor is a
//     contract failure, and nothing is folded from an error response.
//
// Ids are Fansly snowflakes and compare as BigInt.

/** Owner decision №3: completeness only by an empty page. The first-second
 *  heuristic (plan §6.2 rule 2) is measured by `sync chain check-end-rule`
 *  and never folded. */
export const FIRST_SECOND_RULE_ENABLED = false;

/** `history_state` of a thread (§2.3). */
export type ChainHistoryState = "none" | "unverified" | "partial" | "complete";

/** Where an accepted page came from: an engine attempt (its observation) or a
 *  legacy journal row. */
export type ChainWitness =
  | { kind: "attempt"; attemptId: number; observationId: number; receivedAt: Date }
  | { kind: "raw"; rawPayloadId: number };

/** The stored form of the page that proved `complete`
 *  (`history_proof_observation_id/_received_at` or `history_proof_raw_payload_id`). */
export type ChainProofWitness =
  | { kind: "observation"; observationId: number; receivedAt: Date }
  | { kind: "raw"; rawPayloadId: number };

export interface ThreadChain {
  epoch: number;
  state: ChainHistoryState;
  /** `head_confirmed_id` / `_at` (capture time of the page that showed it). */
  headId: string | null;
  headAt: Date | null;
  /** `contiguous_oldest_id` and its message `created_at`. */
  oldestId: string | null;
  oldestCreatedAtMs: number | null;
  count: number;
  upwardCount: number;
  proof: "empty_page" | null;
  /** The proving empty page and its capture time; null unless `complete`. */
  proofWitness: ChainProofWitness | null;
  provenAt: Date | null;
}

/**
 * A staged head walk (§8.1): a head read whose messages are all newer than the
 * chain's head is read down (`before = oldestId`) until it meets the head.
 * `baseHeadId` is the chain head it must meet; null when the chain is the
 * proven-empty chat (an empty head), which a segment joins only by reaching an
 * empty page itself. `headAt` and `oldestCreatedAtMs` become the chain's when
 * the segment joins.
 */
export interface Segment {
  baseHeadId: string | null;
  headId: string;
  headAt: Date;
  oldestId: string;
  oldestCreatedAtMs: number | null;
  count: number;
}

/** One accepted `/message` page: ids and `createdAt` in RESPONSE order. */
export interface ChainPage {
  before: string | null;
  limit: number;
  ids: readonly string[];
  createdAtMs: readonly (number | null)[];
  capturedAt: Date;
  witness: ChainWitness;
}

export type ChainAnomalyReason =
  | "empty_head_with_chain"
  | "empty_head_with_stored"
  | "head_regressed"
  | "old_chain_vanished"
  | "old_chain_vanished_with_stored"
  | "messages_below_proven_end";

export type ChainContractViolationReason =
  | "not_newest_first"
  | "ids_not_below_before"
  | "cursor_repeated"
  | "over_limit"
  | "bad_id";

export type ChainCompletion = "empty_page" | "empty_head" | "segment_empty_page";

export type ChainVerdict =
  | { kind: "started" }
  | { kind: "head_unchanged" }
  | { kind: "staged" }
  | { kind: "joined"; added: number; joinKind: "contains_head" | "crossed_head" }
  | { kind: "extended_down"; added: number }
  | { kind: "completed"; via: ChainCompletion }
  | { kind: "segment_stale" }
  | { kind: "segment_dropped_by_head" }
  | { kind: "not_continuing" }
  | { kind: "anomaly"; reason: ChainAnomalyReason }
  | { kind: "contract_violation"; reason: ChainContractViolationReason };

/**
 * What the hub stores for the thread: its non-deleted `page_dm_messages`, read
 * in the transaction of the fold (engine) or at rebuild time (today's rows,
 * conservative). Needed only for empty pages (`chainPageNeedsStoredFacts`).
 */
export interface StoredFacts {
  nonDeletedCount: number;
  oldestNonDeletedId: string | null;
}

export interface ChainFold {
  chain: ThreadChain;
  segment: Segment | null;
  verdict: ChainVerdict;
  /** Verdicts reported alongside the main one: `segment_dropped_by_head`
   *  before a head fold, `anomaly old_chain_vanished` with a
   *  `segment_empty_page` completion. */
  reported: readonly ChainVerdict[];
}

/** A thread without a chain: `none`, or `unverified` when the hub already
 *  holds messages the chain has not proven. */
export function emptyChain(state: "none" | "unverified" = "none", epoch = 0): ThreadChain {
  return {
    epoch,
    state,
    headId: null,
    headAt: null,
    oldestId: null,
    oldestCreatedAtMs: null,
    count: 0,
    upwardCount: 0,
    proof: null,
    proofWitness: null,
    provenAt: null,
  };
}

const DECIMAL_ID = /^[0-9]{1,30}$/;

function isDecimalId(value: string): boolean {
  return DECIMAL_ID.test(value);
}

function idValue(value: string): bigint {
  return BigInt(value);
}

/**
 * The page contract (null = accepted). Any violation quarantines the page and
 * nothing of it is folded: ids decimal; strictly decreasing (newest first,
 * which also makes them unique); at most `limit`; with `before = X` every id
 * below X — an id equal to X is a repeated cursor (never "end").
 */
export function validateChainPage(page: ChainPage): ChainVerdict | null {
  if (page.createdAtMs.length !== page.ids.length) {
    throw new Error(`chain page: ${page.ids.length} ids but ${page.createdAtMs.length} createdAt values`);
  }
  if (!Number.isSafeInteger(page.limit) || page.limit < 1) {
    throw new Error(`chain page: limit must be a positive integer (is ${String(page.limit)})`);
  }
  if (page.before !== null && !isDecimalId(page.before)) {
    return { kind: "contract_violation", reason: "bad_id" };
  }
  if (!page.ids.every(isDecimalId)) {
    return { kind: "contract_violation", reason: "bad_id" };
  }
  if (page.ids.length > page.limit) {
    return { kind: "contract_violation", reason: "over_limit" };
  }
  for (let index = 1; index < page.ids.length; index += 1) {
    if (idValue(page.ids[index]!) >= idValue(page.ids[index - 1]!)) {
      return { kind: "contract_violation", reason: "not_newest_first" };
    }
  }
  if (page.before !== null) {
    const before = idValue(page.before);
    if (page.ids.some((id) => idValue(id) === before)) {
      return { kind: "contract_violation", reason: "cursor_repeated" };
    }
    if (page.ids.some((id) => idValue(id) > before)) {
      return { kind: "contract_violation", reason: "ids_not_below_before" };
    }
  }
  return null;
}

/** Whether folding this page reads `StoredFacts` (only empty pages do). The
 *  caller may pass null for every other page. */
export function chainPageNeedsStoredFacts(page: ChainPage): boolean {
  return page.ids.length === 0;
}

function requireStored(stored: StoredFacts | null): StoredFacts {
  if (stored === null) throw new Error("chain fold: an empty page needs the thread's StoredFacts");
  return stored;
}

/** Two message ids name the same message (snowflake value; null only equals null). */
export function sameMessageId(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return isDecimalId(left) && isDecimalId(right) ? idValue(left) === idValue(right) : left === right;
}

function storedOlderThan(stored: StoredFacts, id: string): boolean {
  return stored.oldestNonDeletedId !== null
    && isDecimalId(stored.oldestNonDeletedId)
    && idValue(stored.oldestNonDeletedId) < idValue(id);
}

function proofWitnessOf(witness: ChainWitness): ChainProofWitness {
  return witness.kind === "raw"
    ? { kind: "raw", rawPayloadId: witness.rawPayloadId }
    : { kind: "observation", observationId: witness.observationId, receivedAt: witness.receivedAt };
}

function lastOf(page: ChainPage): { id: string; createdAtMs: number | null } {
  const index = page.ids.length - 1;
  return { id: page.ids[index]!, createdAtMs: page.createdAtMs[index] ?? null };
}

function unchanged(chain: ThreadChain, segment: Segment | null, verdict: ChainVerdict, reported: ChainVerdict[] = []): ChainFold {
  return { chain, segment, verdict, reported };
}

/** How the page's ids relate to a known head id: the ids above it, and
 *  whether the page reaches it (contains it, or crosses below it). */
function relateToHead(page: ChainPage, headId: string) {
  const head = idValue(headId);
  const values = page.ids.map(idValue);
  const above = values.filter((value) => value > head).length;
  const contains = values.some((value) => value === head);
  const crossed = !contains && values.length > 0 && values[values.length - 1]! < head;
  return { above, contains, reaches: contains || crossed };
}

/** Fold one accepted (or rejected) page into the thread's chain (§8.1 table). */
export function foldChainPage(
  chain: ThreadChain,
  segment: Segment | null,
  page: ChainPage,
  stored: StoredFacts | null,
): ChainFold {
  const violation = validateChainPage(page);
  if (violation !== null) return unchanged(chain, segment, violation);
  if (page.before === null) return foldHead(chain, segment, page, stored);
  if (segment !== null && sameMessageId(page.before, segment.oldestId)) {
    return foldSegmentPage(chain, segment, page, stored);
  }
  if (chain.oldestId !== null && sameMessageId(page.before, chain.oldestId)) {
    return foldBelowOldest(chain, segment, page);
  }
  return unchanged(chain, segment, { kind: "not_continuing" });
}

function foldHead(chain: ThreadChain, staged: Segment | null, page: ChainPage, stored: StoredFacts | null): ChainFold {
  // The legacy journal interleaves head repairs with `before` walks: a head
  // read drops a staged walk, then folds against the chain itself.
  const reported: ChainVerdict[] = staged === null ? [] : [{ kind: "segment_dropped_by_head" }];
  const segment = null;

  if (page.ids.length === 0) {
    if (chain.count > 0) {
      return unchanged(chain, segment, { kind: "anomaly", reason: "empty_head_with_chain" }, reported);
    }
    // An empty head of a chat the hub holds messages of is not an empty page
    // at before = contiguous_oldest_id (decision №3): review, nothing folded.
    if (requireStored(stored).nonDeletedCount > 0) {
      return unchanged(chain, segment, { kind: "anomaly", reason: "empty_head_with_stored" }, reported);
    }
    return {
      chain: {
        ...chain,
        state: "complete",
        headId: null,
        headAt: page.capturedAt,
        oldestId: null,
        oldestCreatedAtMs: null,
        count: 0,
        proof: "empty_page",
        proofWitness: proofWitnessOf(page.witness),
        provenAt: page.capturedAt,
      },
      segment,
      verdict: { kind: "completed", via: "empty_head" },
      reported,
    };
  }

  const first = page.ids[0]!;
  const last = lastOf(page);
  if (chain.headId === null) {
    if (chain.state === "complete") {
      // The proven-empty chat got messages: read them down to an empty page
      // before the chain may claim them (the head read alone could be cut).
      return {
        chain,
        segment: {
          baseHeadId: null,
          headId: first,
          headAt: page.capturedAt,
          oldestId: last.id,
          oldestCreatedAtMs: last.createdAtMs,
          count: page.ids.length,
        },
        verdict: { kind: "staged" },
        reported,
      };
    }
    return {
      chain: {
        ...chain,
        state: "partial",
        headId: first,
        headAt: page.capturedAt,
        oldestId: last.id,
        oldestCreatedAtMs: last.createdAtMs,
        count: page.ids.length,
        upwardCount: 0,
        proof: null,
        proofWitness: null,
        provenAt: null,
      },
      segment,
      verdict: { kind: "started" },
      reported,
    };
  }

  const head = idValue(chain.headId);
  const newest = idValue(first);
  if (newest === head) {
    return {
      chain: { ...chain, headAt: page.capturedAt },
      segment,
      verdict: { kind: "head_unchanged" },
      reported,
    };
  }
  if (newest < head) {
    return unchanged(chain, segment, { kind: "anomaly", reason: "head_regressed" }, reported);
  }
  const relation = relateToHead(page, chain.headId);
  if (relation.reaches) {
    return {
      chain: {
        ...chain,
        headId: first,
        headAt: page.capturedAt,
        count: chain.count + relation.above,
        upwardCount: chain.upwardCount + relation.above,
      },
      segment,
      verdict: { kind: "joined", added: relation.above, joinKind: relation.contains ? "contains_head" : "crossed_head" },
      reported,
    };
  }
  // Every id is newer than the head: stage the walk, also when the page is
  // short (a short page is not an end).
  return {
    chain,
    segment: {
      baseHeadId: chain.headId,
      headId: first,
      headAt: page.capturedAt,
      oldestId: last.id,
      oldestCreatedAtMs: last.createdAtMs,
      count: page.ids.length,
    },
    verdict: { kind: "staged" },
    reported,
  };
}

function foldSegmentPage(chain: ThreadChain, segment: Segment, page: ChainPage, stored: StoredFacts | null): ChainFold {
  if (!sameMessageId(chain.headId, segment.baseHeadId)) {
    // The chain head moved since the walk started: re-read the head.
    return unchanged(chain, null, { kind: "segment_stale" });
  }

  if (page.ids.length === 0) {
    if (storedOlderThan(requireStored(stored), segment.oldestId)) {
      // The vendor says the chat ends here, the hub holds older messages:
      // review (the same signal as check-end-rule check 2), nothing folded.
      return unchanged(chain, segment, { kind: "anomaly", reason: "old_chain_vanished_with_stored" });
    }
    if (segment.baseHeadId === null) {
      // The proven-empty chat's new messages, read to an empty page.
      return {
        chain: {
          ...chain,
          state: "complete",
          headId: segment.headId,
          headAt: segment.headAt,
          oldestId: segment.oldestId,
          oldestCreatedAtMs: segment.oldestCreatedAtMs,
          count: segment.count,
          upwardCount: chain.upwardCount + segment.count,
          proof: "empty_page",
          proofWitness: proofWitnessOf(page.witness),
          provenAt: page.capturedAt,
        },
        segment: null,
        verdict: { kind: "joined", added: segment.count, joinKind: "crossed_head" },
        reported: [],
      };
    }
    // The walk reached the start of the chat without meeting the old head:
    // the old chain vanished; the segment is the whole history.
    return {
      chain: {
        epoch: chain.epoch + 1,
        state: "complete",
        headId: segment.headId,
        headAt: segment.headAt,
        oldestId: segment.oldestId,
        oldestCreatedAtMs: segment.oldestCreatedAtMs,
        count: segment.count,
        upwardCount: 0,
        proof: "empty_page",
        proofWitness: proofWitnessOf(page.witness),
        provenAt: page.capturedAt,
      },
      segment: null,
      verdict: { kind: "completed", via: "segment_empty_page" },
      reported: [{ kind: "anomaly", reason: "old_chain_vanished" }],
    };
  }

  const last = lastOf(page);
  if (segment.baseHeadId !== null) {
    const relation = relateToHead(page, segment.baseHeadId);
    if (relation.reaches) {
      const added = segment.count + relation.above;
      return {
        chain: {
          ...chain,
          headId: segment.headId,
          headAt: segment.headAt,
          count: chain.count + added,
          upwardCount: chain.upwardCount + added,
        },
        segment: null,
        verdict: { kind: "joined", added, joinKind: relation.contains ? "contains_head" : "crossed_head" },
        reported: [],
      };
    }
  }
  return {
    chain,
    segment: {
      ...segment,
      oldestId: last.id,
      oldestCreatedAtMs: last.createdAtMs,
      count: segment.count + page.ids.length,
    },
    verdict: { kind: "staged" },
    reported: [],
  };
}

function foldBelowOldest(chain: ThreadChain, segment: Segment | null, page: ChainPage): ChainFold {
  if (chain.state === "complete") {
    // A proven end re-read: an empty page agrees (nothing to fold); messages
    // below it contradict the proof — review, the chain is untouched.
    return page.ids.length === 0
      ? unchanged(chain, segment, { kind: "not_continuing" })
      : unchanged(chain, segment, { kind: "anomaly", reason: "messages_below_proven_end" });
  }
  if (page.ids.length === 0) {
    return {
      chain: {
        ...chain,
        state: "complete",
        proof: "empty_page",
        proofWitness: proofWitnessOf(page.witness),
        provenAt: page.capturedAt,
      },
      segment,
      verdict: { kind: "completed", via: "empty_page" },
      reported: [],
    };
  }
  const last = lastOf(page);
  return {
    chain: {
      ...chain,
      oldestId: last.id,
      oldestCreatedAtMs: last.createdAtMs,
      count: chain.count + page.ids.length,
    },
    segment,
    verdict: { kind: "extended_down", added: page.ids.length },
    reported: [],
  };
}

/** The `before` of the next read that continues the thread's chain downwards
 *  (a staged walk first), or null for a head read. */
export function nextChainCursor(chain: ThreadChain, segment: Segment | null): string | null {
  if (segment !== null) return segment.oldestId;
  return chain.state === "partial" ? chain.oldestId : null;
}

/** Creation instant of a Fansly snowflake id in ms, or null for a non-id. */
export function snowflakeMs(id: string): number | null {
  if (!isDecimalId(id)) return null;
  const ms = fanslySnowflakeToDate(id).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Plan §6.2 rule 2 (measured, never folded while FIRST_SECOND_RULE_ENABLED is
 * false): a SHORT page (fewer ids than its limit, a limit above 1) whose
 * oldest message was created within ±1 s of the chat's creation (both from
 * the snowflakes).
 */
export function isFirstSecondPage(groupId: string, page: Pick<ChainPage, "ids" | "limit">): boolean {
  if (page.limit <= 1 || page.ids.length === 0 || page.ids.length >= page.limit) return false;
  const chatMs = snowflakeMs(groupId);
  const oldestMs = snowflakeMs(page.ids[page.ids.length - 1]!);
  return chatMs !== null && oldestMs !== null && Math.abs(oldestMs - chatMs) <= 1000;
}

/** A short page in the sense of the end-rule check: some ids, fewer than its
 *  own limit, and a limit above 1 (a limit-1 page is never short). */
export function isShortPage(page: Pick<ChainPage, "ids" | "limit">): boolean {
  return page.limit > 1 && page.ids.length > 0 && page.ids.length < page.limit;
}
