import { describe, expect, it } from "vitest";

import type { SyncWorkRow } from "@agency_hub_core/db";
import type { FanslyMessage } from "@agency_hub_core/fansly";

import { demandToUpsert } from "../apps/runtime/src/sync/engine/resource.ts";
import { emptyChain, type ThreadChain } from "../apps/runtime/src/sync/fansly/lib/chain.ts";
import { normalizeFanslyDmMessages } from "../apps/runtime/src/sync/fansly/lib/dm-normalize.ts";
import { createFanslyRegistry, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import {
  DM_HEAD_NOT_FOUND_RETRY_MS,
  dmMessagesModule,
  parseDmMessagesCursor,
  resolveDemand,
  type DemandResolutionInput,
} from "../apps/runtime/src/sync/fansly/resources/dm-messages.ts";

// The DM message reads' rules without I/O (design §5.4): the pure page
// normalization, what one read does for the demanded ids (the not-found ladder
// of plan §7 p.4), the cursor, and the shadow estimate.

const EPOCH_MS = 1561494359900;
const PAGE = "300000000000000001";
const FAN = "500000000000000001";
const NOW = new Date("2026-10-02T12:00:00Z");

/** A Fansly snowflake created at `ms` (sequence `seq`). */
function snowflake(ms: number, seq = 0): string {
  return ((BigInt(ms - EPOCH_MS) << 22n) | BigInt(seq)).toString();
}

function message(id: string, overrides: Partial<FanslyMessage> & { createdAt?: unknown } = {}): FanslyMessage {
  return {
    id,
    type: 1,
    dataVersion: 1,
    content: `text ${id}`,
    groupId: "700000000000000001",
    senderId: FAN,
    correlationId: null,
    inReplyTo: null,
    inReplyToRoot: null,
    createdAt: Math.floor(NOW.getTime() / 1000) - 60,
    attachments: [],
    embeds: [],
    interactions: [],
    likes: [],
    ...overrides,
  } as FanslyMessage;
}

describe("normalizeFanslyDmMessages", () => {
  const context = {
    conversationId: 42,
    platformAccountId: 7,
    platform: "fansly" as const,
    pageAccountId: PAGE,
    partnerPlatformUserId: FAN,
    now: NOW,
  };

  it("builds the hot-table rows, keeps the served order and sets aside what it cannot date", () => {
    const items = [
      message("910000000000000004", { senderId: PAGE, createdAt: 1_759_406_340 }),
      message("910000000000000003", { createdAt: null as never }),
      message("910000000000000002", { senderId: "999", createdAt: 1_759_406_280_000, totalTipAmount: 5_000 }),
      message("910000000000000001", { senderId: null, createdAt: "soon" as never, content: undefined as never }),
    ];
    const normalized = normalizeFanslyDmMessages(items, context);
    expect(normalized.idsInResponseOrder).toEqual(items.map((item) => item.id));
    expect(normalized.unparseable).toEqual([
      { id: "910000000000000003", valueType: "null" },
      { id: "910000000000000001", valueType: "string" },
    ]);
    expect(normalized.implausible).toEqual([]);
    expect(normalized.rows).toEqual([
      expect.objectContaining({
        conversationId: 42, platformAccountId: 7, platformMessageId: "910000000000000004", senderRole: "model",
        createdAt: new Date(1_759_406_340_000), totalTipAmountCents: 0,
      }),
      // Milliseconds stay milliseconds; tips arrive in mills (÷ 10 → cents);
      // a sender that is neither the page nor the partner is unknown.
      expect.objectContaining({
        platformMessageId: "910000000000000002", senderRole: "unknown", createdAt: new Date(1_759_406_280_000),
        totalTipAmountCents: 500,
      }),
    ]);
  });

  it("flags an implausible instant but still stores the row", () => {
    const normalized = normalizeFanslyDmMessages([message("910000000000000009", { createdAt: 5 })], context);
    expect(normalized.rows).toHaveLength(1);
    expect(normalized.implausible).toEqual([{ id: "910000000000000009", rawValue: 5, normalizedAt: new Date(5_000) }]);
  });
});

describe("resolveDemand", () => {
  const sentAtMs = NOW.getTime() - 1_000;
  const old = (seq: number) => snowflake(NOW.getTime() - 3_600_000, seq);
  const head = old(50);
  const chain: ThreadChain = {
    ...emptyChain(),
    state: "partial",
    headId: head,
    headAt: NOW,
    oldestId: old(10),
    oldestCreatedAtMs: null,
    count: 41,
  };
  const input = (overrides: Partial<DemandResolutionInput>): DemandResolutionInput => ({
    variant: "head",
    demandIds: [],
    pageIds: [head, old(49), old(48)],
    walkDone: true,
    restHeadId: head,
    chain,
    misses: {},
    sentAtMs,
    ...overrides,
  });

  it("confirms what the page shows and settles what the walk covered without showing it", () => {
    const resolution = resolveDemand(input({ demandIds: [old(49), old(30), old(5)] }));
    expect(resolution).toMatchObject({ found: [old(49)], covered: [old(30)], dropped: [old(5)], pending: [], retryInMs: null });
  });

  it("waits for an id the vendor's head does not show yet: 15 s, then 60 s, then not found", () => {
    const newer = old(60);
    const first = resolveDemand(input({ demandIds: [newer] }));
    expect(first).toMatchObject({ pending: [newer], misses: { [newer]: 1 }, retryInMs: DM_HEAD_NOT_FOUND_RETRY_MS[0] });
    const second = resolveDemand(input({ demandIds: [newer], misses: first.misses }));
    expect(second).toMatchObject({ pending: [newer], misses: { [newer]: 2 }, retryInMs: DM_HEAD_NOT_FOUND_RETRY_MS[1] });
    const third = resolveDemand(input({ demandIds: [newer], misses: second.misses }));
    expect(third).toMatchObject({ pending: [], expired: [newer], misses: {}, retryInMs: null });
    expect(DM_HEAD_NOT_FOUND_RETRY_MS).toEqual([15_000, 60_000]);
  });

  it("does not count a miss for a message created after the read was sent", () => {
    const late = snowflake(NOW.getTime());
    const resolution = resolveDemand(input({ demandIds: [late] }));
    expect(resolution).toMatchObject({ pending: [late], late: [late], misses: {}, retryInMs: DM_HEAD_NOT_FOUND_RETRY_MS[0] });
  });

  it("an empty head shows nothing: every demanded id waits for the vendor", () => {
    const resolution = resolveDemand(input({ demandIds: [old(1)], pageIds: [], restHeadId: null, chain: emptyChain() }));
    expect(resolution).toMatchObject({ pending: [old(1)], misses: { [old(1)]: 1 } });
  });

  it("while the walk goes on only what it showed resolves, and no miss is counted", () => {
    const resolution = resolveDemand(input({ demandIds: [old(49), old(60)], walkDone: false, misses: { [old(60)]: 1 } }));
    expect(resolution).toMatchObject({ found: [old(49)], pending: [old(60)], misses: { [old(60)]: 1 }, retryInMs: null });
  });

  it("a catch-up or history read leaves the ids it did not show to the passive parity pass", () => {
    for (const variant of ["catchup", "history"] as const) {
      const resolution = resolveDemand(input({ variant, demandIds: [old(49), old(60), old(30)] }));
      expect(resolution).toMatchObject({ found: [old(49)], dropped: [old(60), old(30)], pending: [], covered: [], expired: [] });
    }
  });
});

describe("cursor", () => {
  it("round-trips a staged walk and drops what it cannot read", () => {
    const cursor = parseDmMessagesCursor({
      segment: {
        baseHeadId: "910000000000000001", headId: "910000000000000090", headAt: NOW.toISOString(),
        oldestId: "910000000000000066", oldestCreatedAtMs: 1_000, count: 25,
      },
      walkPages: 2,
      misses: { "910000000000000091": 1, bad: 2, "910000000000000092": 0 },
      shadow: { steps: 3, done: 1 },
      last: { verdict: "joined" },
      historyHeadAt: NOW.toISOString(),
    });
    expect(cursor).toEqual({
      segment: {
        baseHeadId: "910000000000000001", headId: "910000000000000090", headAt: NOW,
        oldestId: "910000000000000066", oldestCreatedAtMs: 1_000, count: 25,
      },
      walkPages: 2,
      misses: { "910000000000000091": 1 },
      shadow: { steps: 3, done: 1 },
      last: { verdict: "joined" },
      historyHeadAt: NOW,
    });
    expect(parseDmMessagesCursor({ historyHeadAt: "not a time" }).historyHeadAt).toBeNull();
    // A proven-empty chat's staged walk has no base head.
    expect(parseDmMessagesCursor({ segment: { baseHeadId: null, headId: "9", headAt: NOW.toISOString(), oldestId: "8", count: 2 } }).segment)
      .toMatchObject({ baseHeadId: null, headId: "9", oldestId: "8", count: 2, oldestCreatedAtMs: null });
    expect(parseDmMessagesCursor({ segment: { baseHeadId: "x", headId: "9", headAt: NOW.toISOString(), oldestId: "8", count: 2 } }).segment)
      .toBeNull();
    expect(parseDmMessagesCursor(null)).toEqual({ segment: null, walkPages: 0, misses: {}, shadow: null, last: null, historyHeadAt: null });
  });
});

describe("registry and shadow", () => {
  function work(messageIds: string[], cursor: unknown = {}): SyncWorkRow {
    return {
      demand: { messageIds, txIds: [], reasons: ["test"], overflow: false },
      cursor,
      subject: "700000000000000001",
    } as unknown as SyncWorkRow;
  }

  it("the three variants are implemented and replay the journal's dm_messages pages", async () => {
    const registry = createFanslyRegistry();
    for (const key of ["dm-messages.head", "dm-messages.catchup", "dm-messages.history"]) {
      expect(fanslyResourceSpec(key)?.module, key).toBeDefined();
      expect(typeof (await registry.module(key)).replay, key).toBe("function");
    }
    expect(fanslyResourceSpec("dm-messages.head")?.replayKinds).toEqual(["dm_messages"]);
  });

  it("coalesces a head read 5 s / 20 s, and 2 s / 6 s for a fast signal", () => {
    const spec = fanslyResourceSpec("dm-messages.head")!;
    const normal = demandToUpsert({ resource: spec.key, subject: "7", demand: { messageIds: ["1"], reason: "ws" } }, spec, {
      pageId: 1, shadow: true, now: NOW,
    })!;
    expect(normal).toMatchObject({
      class: "urgent", dueAt: new Date(NOW.getTime() + 5_000), coalesceUntil: new Date(NOW.getTime() + 20_000),
      deadlineAt: new Date(NOW.getTime() + 30_000), extendOnSignal: true,
    });
    const fast = demandToUpsert({ resource: spec.key, subject: "7", coalesce: "fast", demand: { messageIds: ["1"], reason: "ws" } }, spec, {
      pageId: 1, shadow: true, now: NOW,
    })!;
    expect(fast).toMatchObject({ dueAt: new Date(NOW.getTime() + 2_000), coalesceUntil: new Date(NOW.getTime() + 6_000) });
  });

  it("estimates ⌈demanded ids / 25⌉ reads (at least one); a history read never runs in shadow", async () => {
    const head = dmMessagesModule("head");
    const ids = Array.from({ length: 60 }, (_, index) => snowflake(NOW.getTime() - 60_000, index));
    let cursor: unknown = {};
    const outcomes = [];
    for (let step = 0; step < 3; step += 1) {
      const result = await head.shadow(work(ids, cursor), { spec: "messages.page", params: {} as never }, {} as never);
      outcomes.push(result.work.close ?? "open");
      cursor = result.work.cursor;
    }
    expect(outcomes).toEqual(["open", "open", "done"]);
    expect((await head.shadow(work([]), { spec: "messages.page", params: {} as never }, {} as never)).work.close).toBe("done");
    const history = await dmMessagesModule("history").shadow(work([]), { spec: "messages.page", params: {} as never }, {} as never);
    expect(history.work).toMatchObject({ close: "done", closeReason: "shadow" });
  });
});
