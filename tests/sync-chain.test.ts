import { describe, expect, it } from "vitest";

import {
  chainPageNeedsStoredFacts,
  emptyChain,
  FIRST_SECOND_RULE_ENABLED,
  foldChainPage,
  isFirstSecondPage,
  isShortPage,
  nextChainCursor,
  validateChainPage,
  type ChainPage,
  type ChainVerdict,
  type Segment,
  type StoredFacts,
  type ThreadChain,
} from "../apps/runtime/src/sync/fansly/lib/chain.ts";

// Fansly Sync Engine design §8.1: every row of the chain table, the page
// contract, the 16.09 counterexample, and a model-based property — a chain
// never claims a message range it did not read contiguously, and `complete`
// always reaches the first message of the chat.

const T0 = Date.parse("2026-09-16T19:59:00Z");
let nextRawId = 1000;

function at(offsetSeconds: number): Date {
  return new Date(T0 + offsetSeconds * 1000);
}

function page(before: string | null, ids: readonly (string | number)[], options: { limit?: number; at?: Date } = {}): ChainPage {
  const list = ids.map(String);
  return {
    before,
    limit: options.limit ?? 25,
    ids: list,
    createdAtMs: list.map((id) => T0 - (1_000_000 - Number(id)) * 1000),
    capturedAt: options.at ?? at(0),
    witness: { kind: "raw", rawPayloadId: nextRawId++ },
  };
}

const NO_STORED: StoredFacts = { nonDeletedCount: 0, oldestNonDeletedId: null };

function range(from: number, to: number): string[] {
  // Newest first: from > to.
  const ids: string[] = [];
  for (let id = from; id >= to; id -= 1) ids.push(String(id));
  return ids;
}

function partial(head: number, oldest: number, extra: Partial<ThreadChain> = {}): ThreadChain {
  return {
    ...emptyChain("unverified"),
    state: "partial",
    headId: String(head),
    headAt: at(-60),
    oldestId: String(oldest),
    oldestCreatedAtMs: 1,
    count: head - oldest + 1,
    ...extra,
  };
}

function segment(base: number | null, head: number, oldest: number): Segment {
  return { baseHeadId: base === null ? null : String(base), headId: String(head), headAt: at(-30), oldestId: String(oldest), oldestCreatedAtMs: 2, count: head - oldest + 1 };
}

describe("the page contract (nothing of a rejected page is folded)", () => {
  const chain = partial(500, 480);
  const staged = segment(500, 530, 520);
  const cases: Array<[string, ChainPage, ChainVerdict]> = [
    ["a non-decimal id", page(null, ["510", "abc"]), { kind: "contract_violation", reason: "bad_id" }],
    ["a missing id", page(null, ["510", ""]), { kind: "contract_violation", reason: "bad_id" }],
    ["a non-decimal cursor", page("x1", ["510"]), { kind: "contract_violation", reason: "bad_id" }],
    ["more ids than the limit", page(null, range(530, 501), { limit: 25 }), { kind: "contract_violation", reason: "over_limit" }],
    ["oldest first", page(null, ["501", "502"]), { kind: "contract_violation", reason: "not_newest_first" }],
    ["a duplicate id", page(null, ["502", "502"]), { kind: "contract_violation", reason: "not_newest_first" }],
    ["the cursor repeated as the last id", page("480", ["480"]), { kind: "contract_violation", reason: "cursor_repeated" }],
    ["the cursor repeated inside the page", page("480", ["480", "479"]), { kind: "contract_violation", reason: "cursor_repeated" }],
    ["an id above the cursor", page("480", ["481", "479"]), { kind: "contract_violation", reason: "ids_not_below_before" }],
  ];
  for (const [name, rejected, verdict] of cases) {
    it(`refuses ${name}`, () => {
      expect(validateChainPage(rejected)).toEqual(verdict);
      const fold = foldChainPage(chain, staged, rejected, NO_STORED);
      expect(fold.verdict).toEqual(verdict);
      expect(fold.chain).toBe(chain);
      expect(fold.segment).toBe(staged);
      expect(fold.reported).toEqual([]);
    });
  }

  it("accepts a page ordered newest first below its cursor, short or not", () => {
    expect(validateChainPage(page("480", ["479", "470", "3"]))).toBeNull();
    expect(validateChainPage(page(null, []))).toBeNull();
  });

  it("treats a malformed page object as a caller bug, not data", () => {
    expect(() => validateChainPage({ ...page(null, ["1"]), createdAtMs: [] })).toThrow(/createdAt/);
    expect(() => validateChainPage({ ...page(null, ["1"]), limit: 0 })).toThrow(/limit/);
  });
});

describe("head pages (before absent)", () => {
  it("drops a staged walk first, then folds the head against the chain (segment_dropped_by_head)", () => {
    const fold = foldChainPage(partial(500, 480), segment(500, 540, 530), page(null, range(503, 499), { at: at(5) }), NO_STORED);
    expect(fold.reported).toEqual([{ kind: "segment_dropped_by_head" }]);
    expect(fold.segment).toBeNull();
    expect(fold.verdict).toEqual({ kind: "joined", added: 3, joinKind: "contains_head" });
    expect(fold.chain).toMatchObject({ headId: "503", headAt: at(5), oldestId: "480", count: 24, upwardCount: 3 });
  });

  it("completes a chat the hub holds nothing of on an empty head (empty_head, proof empty_page)", () => {
    const empty = page(null, [], { at: at(7) });
    expect(chainPageNeedsStoredFacts(empty)).toBe(true);
    const fold = foldChainPage(emptyChain(), null, empty, NO_STORED);
    expect(fold.verdict).toEqual({ kind: "completed", via: "empty_head" });
    expect(fold.chain).toMatchObject({
      state: "complete",
      proof: "empty_page",
      headId: null,
      oldestId: null,
      count: 0,
      headAt: at(7),
      provenAt: at(7),
      proofWitness: { kind: "raw", rawPayloadId: (empty.witness as { rawPayloadId: number }).rawPayloadId },
    });
  });

  it("never completes on an empty head of a chat whose messages the hub stores (empty_head_with_stored)", () => {
    const chain = emptyChain("unverified");
    const fold = foldChainPage(chain, null, page(null, []), { nonDeletedCount: 117, oldestNonDeletedId: "100" });
    expect(fold.verdict).toEqual({ kind: "anomaly", reason: "empty_head_with_stored" });
    expect(fold.chain).toBe(chain);
  });

  it("flags an empty head of a chat with a chain (empty_head_with_chain), chain untouched", () => {
    const chain = partial(500, 480);
    const fold = foldChainPage(chain, null, page(null, []), NO_STORED);
    expect(fold.verdict).toEqual({ kind: "anomaly", reason: "empty_head_with_chain" });
    expect(fold.chain).toBe(chain);
  });

  it("starts a chain on a head page of a thread without one (none or unverified)", () => {
    for (const state of ["none", "unverified"] as const) {
      const fold = foldChainPage(emptyChain(state, 3), null, page(null, range(520, 500), { at: at(9) }), null);
      expect(fold.verdict).toEqual({ kind: "started" });
      expect(fold.chain).toMatchObject({
        epoch: 3, state: "partial", headId: "520", headAt: at(9), oldestId: "500", count: 21, upwardCount: 0, proof: null,
      });
    }
  });

  it("only re-dates the head when it is unchanged", () => {
    const chain = partial(500, 480);
    const fold = foldChainPage(chain, null, page(null, range(500, 476), { at: at(11) }), null);
    expect(fold.verdict).toEqual({ kind: "head_unchanged" });
    expect(fold.chain).toEqual({ ...chain, headAt: at(11) });
  });

  it("joins a head page that crosses below a head it does not contain (crossed_head)", () => {
    const fold = foldChainPage(partial(500, 480), null, page(null, ["504", "502", "499"]), null);
    expect(fold.verdict).toEqual({ kind: "joined", added: 2, joinKind: "crossed_head" });
    expect(fold.chain).toMatchObject({ headId: "504", count: 23, upwardCount: 2 });
  });

  it("flags a head that went back (head_regressed), chain untouched", () => {
    const chain = partial(500, 480);
    const fold = foldChainPage(chain, null, page(null, range(498, 490)), null);
    expect(fold.verdict).toEqual({ kind: "anomaly", reason: "head_regressed" });
    expect(fold.chain).toBe(chain);
  });

  it("stages a head walk when every id is newer than the head — also on a short page", () => {
    const chain = partial(500, 480);
    const fold = foldChainPage(chain, null, page(null, range(530, 520), { at: at(13) }), null);
    expect(fold.verdict).toEqual({ kind: "staged" });
    expect(fold.chain).toBe(chain);
    expect(fold.segment).toEqual({
      baseHeadId: "500", headId: "530", headAt: at(13), oldestId: "520", oldestCreatedAtMs: expect.any(Number), count: 11,
    });
    expect(nextChainCursor(fold.chain, fold.segment)).toBe("520");
  });
});

describe("pages of a staged walk (before = segment.oldestId)", () => {
  it("drops a stale walk when the chain head moved since it started (segment_stale)", () => {
    const chain = partial(505, 480);
    const fold = foldChainPage(chain, segment(500, 540, 530), page("530", range(529, 520)), null);
    expect(fold.verdict).toEqual({ kind: "segment_stale" });
    expect(fold.segment).toBeNull();
    expect(fold.chain).toBe(chain);
  });

  it("joins when the walk reaches the head it started above (contains_head)", () => {
    const fold = foldChainPage(partial(500, 480), segment(500, 540, 530), page("530", range(529, 495), { limit: 50 }), null);
    expect(fold.verdict).toEqual({ kind: "joined", added: 11 + 29, joinKind: "contains_head" });
    expect(fold.segment).toBeNull();
    expect(fold.chain).toMatchObject({ headId: "540", headAt: at(-30), oldestId: "480", count: 21 + 40, upwardCount: 40 });
  });

  it("joins when the walk crosses the head (crossed_head)", () => {
    const fold = foldChainPage(partial(500, 480), segment(500, 540, 530), page("530", ["520", "510", "499"]), null);
    expect(fold.verdict).toEqual({ kind: "joined", added: 13, joinKind: "crossed_head" });
    expect(fold.chain).toMatchObject({ headId: "540", count: 21 + 13 });
  });

  it("extends the walk while every id is still above the head (staged)", () => {
    const fold = foldChainPage(partial(500, 480), segment(500, 540, 530), page("530", range(529, 510)), null);
    expect(fold.verdict).toEqual({ kind: "staged" });
    expect(fold.segment).toMatchObject({ baseHeadId: "500", headId: "540", oldestId: "510", count: 31 });
  });

  it("an empty page under a walk that never met the old chain: the walk is the whole history (segment_empty_page)", () => {
    const chain = partial(500, 480, { epoch: 2, upwardCount: 7 });
    const empty = page("530", [], { at: at(20) });
    const fold = foldChainPage(chain, segment(500, 540, 530), empty, NO_STORED);
    expect(fold.verdict).toEqual({ kind: "completed", via: "segment_empty_page" });
    expect(fold.reported).toEqual([{ kind: "anomaly", reason: "old_chain_vanished" }]);
    expect(fold.segment).toBeNull();
    expect(fold.chain).toMatchObject({
      epoch: 3, state: "complete", proof: "empty_page", headId: "540", oldestId: "530", count: 11, upwardCount: 0, provenAt: at(20),
    });
  });

  it("never completes over older stored messages (old_chain_vanished_with_stored), nothing folded", () => {
    const chain = partial(500, 480);
    const staged = segment(500, 540, 530);
    const fold = foldChainPage(chain, staged, page("530", []), { nonDeletedCount: 40, oldestNonDeletedId: "480" });
    expect(fold.verdict).toEqual({ kind: "anomaly", reason: "old_chain_vanished_with_stored" });
    expect(fold.chain).toBe(chain);
    expect(fold.segment).toBe(staged);
  });
});

describe("pages below the chain (before = contiguous_oldest_id)", () => {
  it("completes a partial chain on an empty page (empty_page) and keeps the witness", () => {
    const empty = page("480", [], { at: at(30) });
    const fold = foldChainPage(partial(500, 480), null, empty, NO_STORED);
    expect(fold.verdict).toEqual({ kind: "completed", via: "empty_page" });
    expect(fold.chain).toMatchObject({
      state: "complete", proof: "empty_page", provenAt: at(30), oldestId: "480", count: 21,
      proofWitness: { kind: "raw", rawPayloadId: (empty.witness as { rawPayloadId: number }).rawPayloadId },
    });
  });

  it("maps an engine witness to its observation", () => {
    const empty: ChainPage = {
      ...page("480", []),
      witness: { kind: "attempt", attemptId: 9, observationId: 77, receivedAt: at(31) },
    };
    expect(foldChainPage(partial(500, 480), null, empty, NO_STORED).chain.proofWitness)
      .toEqual({ kind: "observation", observationId: 77, receivedAt: at(31) });
  });

  it("extends a partial chain downwards (extended_down)", () => {
    const fold = foldChainPage(partial(500, 480), null, page("480", range(479, 455)), null);
    expect(fold.verdict).toEqual({ kind: "extended_down", added: 25 });
    expect(fold.chain).toMatchObject({ oldestId: "455", count: 46, state: "partial" });
    expect(nextChainCursor(fold.chain, null)).toBe("455");
  });

  it("does not move a chain on any other cursor (not_continuing)", () => {
    const chain = partial(500, 480);
    expect(foldChainPage(chain, null, page("470", range(469, 460)), null)).toEqual({
      chain, segment: null, verdict: { kind: "not_continuing" }, reported: [],
    });
    expect(foldChainPage(emptyChain("unverified"), null, page("470", []), NO_STORED).verdict).toEqual({ kind: "not_continuing" });
  });
});

describe("complete chains", () => {
  const complete = { ...partial(500, 1), state: "complete" as const, proof: "empty_page" as const, proofWitness: { kind: "raw" as const, rawPayloadId: 1 }, provenAt: at(-100) };

  it("stay complete when the head moves", () => {
    const fold = foldChainPage(complete, null, page(null, range(503, 495)), null);
    expect(fold.verdict).toEqual({ kind: "joined", added: 3, joinKind: "contains_head" });
    expect(fold.chain).toMatchObject({ state: "complete", proof: "empty_page", headId: "503", count: 503 });
  });

  it("agree with a re-read of their end (not_continuing) and flag messages below it", () => {
    expect(foldChainPage(complete, null, page("1", []), NO_STORED).verdict).toEqual({ kind: "not_continuing" });
    const fold = foldChainPage(complete, null, page("1", ["0"]), null);
    expect(fold.verdict).toEqual({ kind: "anomaly", reason: "messages_below_proven_end" });
    expect(fold.chain).toBe(complete);
  });

  it("a proven-empty chat that gets messages is read down to an empty page before it claims them", () => {
    let fold = foldChainPage(emptyChain(), null, page(null, [], { at: at(1) }), NO_STORED);
    expect(fold.chain.state).toBe("complete");
    fold = foldChainPage(fold.chain, fold.segment, page(null, range(30, 6), { at: at(2) }), null);
    expect(fold.verdict).toEqual({ kind: "staged" });
    expect(fold.segment).toMatchObject({ baseHeadId: null, headId: "30", oldestId: "6" });
    fold = foldChainPage(fold.chain, fold.segment, page("6", range(5, 1)), null);
    expect(fold.verdict).toEqual({ kind: "staged" });
    const end = page("1", [], { at: at(3) });
    fold = foldChainPage(fold.chain, fold.segment, end, NO_STORED);
    expect(fold.verdict).toEqual({ kind: "joined", added: 30, joinKind: "crossed_head" });
    expect(fold.chain).toMatchObject({ state: "complete", headId: "30", headAt: at(2), oldestId: "1", count: 30, provenAt: at(3) });
  });
});

describe("the 16.09 counterexample (raw 2975891 / 2975902)", () => {
  it("a head page of 24 of 25 with older stored messages starts a partial chain, never a complete one", () => {
    const head = page(null, range(1024, 1001), { limit: 25 });
    expect(isShortPage(head)).toBe(true);
    const fold = foldChainPage(emptyChain("unverified"), null, head, null);
    expect(fold.verdict).toEqual({ kind: "started" });
    expect(fold.chain.state).toBe("partial");
    expect(fold.chain.proof).toBeNull();
  });

  it("a limit-1 head repair is never a short page", () => {
    expect(isShortPage(page(null, ["9"], { limit: 1 }))).toBe(false);
    expect(isShortPage(page(null, [], { limit: 25 }))).toBe(false);
    expect(isShortPage(page(null, range(25, 1), { limit: 25 }))).toBe(false);
  });
});

describe("stored facts and the first-second heuristic", () => {
  it("are read only for empty pages", () => {
    expect(chainPageNeedsStoredFacts(page(null, ["5"]))).toBe(false);
    expect(() => foldChainPage(emptyChain(), null, page(null, []), null)).toThrow(/StoredFacts/);
    expect(() => foldChainPage(partial(500, 480), segment(500, 540, 530), page("530", []), null)).toThrow(/StoredFacts/);
  });

  it("keeps the first-second rule off (owner decision №3) and only measures it", () => {
    expect(FIRST_SECOND_RULE_ENABLED).toBe(false);
    const epoch = 1561494359900n;
    const snowflake = (ms: number) => String((BigInt(ms) - epoch) << 22n);
    const chatMs = Date.parse("2025-03-01T10:00:00Z");
    const groupId = snowflake(chatMs);
    expect(isFirstSecondPage(groupId, { limit: 25, ids: [snowflake(chatMs + 60_000), snowflake(chatMs + 400)] })).toBe(true);
    expect(isFirstSecondPage(groupId, { limit: 25, ids: [snowflake(chatMs + 60_000), snowflake(chatMs - 900)] })).toBe(true);
    expect(isFirstSecondPage(groupId, { limit: 25, ids: [snowflake(chatMs + 60_000), snowflake(chatMs + 1500)] })).toBe(false);
    expect(isFirstSecondPage(groupId, { limit: 2, ids: [snowflake(chatMs + 60_000), snowflake(chatMs + 400)] })).toBe(false);
    expect(isFirstSecondPage(groupId, { limit: 1, ids: [snowflake(chatMs + 400)] })).toBe(false);
    // Folding a first-second page never completes the chain.
    expect(foldChainPage(emptyChain(), null, { ...page(null, []), ids: [snowflake(chatMs + 400)], createdAtMs: [chatMs + 400] }, null).chain.state)
      .toBe("partial");
  });
});

describe("model: a chain only claims what it read contiguously", () => {
  function prng(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }

  it("holds over random chats, arrivals and read orders", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = prng(seed);
      const messages: number[] = [];
      let nextId = 1000;
      const initial = Math.floor(random() * 80);
      for (let index = 0; index < initial; index += 1) messages.push((nextId += 1 + Math.floor(random() * 3)));
      let chain = emptyChain(initial > 0 ? "unverified" : "none");
      let staged: Segment | null = null;
      const limit = 1 + Math.floor(random() * 25);
      for (let step = 0; step < 60; step += 1) {
        if (random() < 0.15) {
          const arrivals = 1 + Math.floor(random() * 40);
          for (let index = 0; index < arrivals; index += 1) messages.push((nextId += 1 + Math.floor(random() * 3)));
        }
        const cursor = random() < 0.25 ? null : nextChainCursor(chain, staged);
        const below = cursor === null ? messages : messages.filter((id) => id < Number(cursor));
        const served = below.slice(-limit).reverse();
        const read = page(cursor, served, { limit, at: at(step) });
        const stored: StoredFacts = { nonDeletedCount: 0, oldestNonDeletedId: null };
        const fold = foldChainPage(chain, staged, read, chainPageNeedsStoredFacts(read) ? stored : null);
        expect(fold.verdict.kind).not.toBe("contract_violation");
        expect(fold.verdict.kind).not.toBe("anomaly");
        chain = fold.chain;
        staged = fold.segment;
        if (chain.headId !== null) {
          const head = Number(chain.headId);
          const oldest = Number(chain.oldestId);
          expect(chain.count, `seed ${seed} step ${step}`).toBe(messages.filter((id) => id >= oldest && id <= head).length);
        }
        if (chain.state === "complete") {
          expect(chain.oldestId === null ? null : Number(chain.oldestId), `seed ${seed}`)
            .toBe(chain.oldestId === null ? null : messages[0]);
        }
      }
    }
  });
});
