import { describe, expect, it } from "vitest";

import { compareFanslySnowflakeIds, fanslySnowflakeToDate } from "@agency_hub_core/shared";

import { emptyChain, foldChainPage, type ChainPage, type ThreadChain } from "../apps/runtime/src/sync/fansly/lib/chain.ts";
import { listHeadNeedsRead } from "../apps/runtime/src/sync/fansly/lib/conversation-list.ts";
import { compareNotificationRefs } from "../apps/runtime/src/sync/fansly/lib/notifications-rules.ts";
import { demandAnswered, resolveDemand } from "../apps/runtime/src/sync/fansly/resources/dm-messages.ts";

// Bug hunt 2026-10-09 (ids-units): Fansly snowflakes cross 1e18 (19 digits)
// on 2027-01-14 07:49 UTC. These ids straddle that instant: the last
// 18-digit ids and the first 19-digit ones, as the engine will see them mixed.
const OLD_A = "999999999999999000"; // 18 digits, just before the rollover
const OLD_B = "999999999999999999"; // the last 18-digit id
const NEW_A = "1000000000000000000"; // the first 19-digit id
const NEW_B = "1000000000000004096";
const NEW_C = "1000000000000008192";

describe("19-digit rollover (2027-01-14)", () => {
  it("dates the rollover instant", () => {
    expect(fanslySnowflakeToDate(NEW_A).toISOString()).toBe("2027-01-14T07:48:59.001Z");
    // Plain string order is wrong across the boundary; the helpers are not.
    expect(NEW_A < OLD_B).toBe(true);
    expect(compareFanslySnowflakeIds(NEW_A, OLD_B)).toBe(1);
    expect(compareNotificationRefs(NEW_A, OLD_B)).toBeGreaterThan(0);
  });

  it("the chain fold extends an 18-digit head with 19-digit messages", () => {
    const chain: ThreadChain = {
      ...emptyChain("unverified"),
      state: "partial",
      headId: OLD_B,
      headAt: new Date("2027-01-14T07:48:00Z"),
      oldestId: OLD_A,
      oldestCreatedAtMs: 1,
      count: 2,
      upwardCount: 0,
    };
    const page: ChainPage = {
      before: null,
      limit: 25,
      ids: [NEW_C, NEW_B, NEW_A, OLD_B],
      createdAtMs: [3, 2, 1, 0].map((s) => Date.parse("2027-01-14T07:49:00Z") + s * 1000),
      capturedAt: new Date("2027-01-14T07:50:00Z"),
      witness: { kind: "raw", rawPayloadId: 1 },
    };
    const fold = foldChainPage(chain, null, page, null);
    expect(fold.verdict).toMatchObject({ kind: "joined", added: 3 });
    expect(fold.chain.headId).toBe(NEW_C);
  });

  it("a 19-digit list head over an 18-digit confirmed head asks for a read", () => {
    expect(listHeadNeedsRead({
      groupId: "1",
      fanId: 7,
      metadata: {},
      headConfirmedId: OLD_B,
      newestStoredMessageId: OLD_B,
      listHeadId: NEW_A,
      listHeadAt: null,
    }, null)).toBe(true);
  });

  it("an episode's 18-digit answered head does not answer a 19-digit message", () => {
    expect(demandAnswered({ messageIds: [NEW_A], txIds: [], reasons: ["ws:message_created"], overflow: false }, OLD_B)).toBe(false);
    expect(demandAnswered({ messageIds: [OLD_A], txIds: [], reasons: ["ws:message_created"], overflow: false }, OLD_B)).toBe(true);
  });

  it("a 19-digit demanded id newer than an 18-digit vendor head stays pending, never covered", () => {
    const chain: ThreadChain = { ...emptyChain("unverified"), state: "partial", headId: OLD_B, oldestId: OLD_A, count: 2, oldestCreatedAtMs: 1 };
    const resolution = resolveDemand({
      variant: "head",
      demandIds: [NEW_A],
      pageIds: [OLD_B, OLD_A],
      walkDone: true,
      restHeadId: OLD_B,
      chain,
      misses: {},
      sentAtMs: Date.parse("2027-01-14T07:50:00Z"),
    });
    expect(resolution.covered).toEqual([]);
    expect(resolution.pending).toEqual([NEW_A]);
  });
});
