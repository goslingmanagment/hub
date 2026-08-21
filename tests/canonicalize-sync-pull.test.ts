import { describe, expect, it } from "vitest";

import { canonicalizeCommandResultObservation } from "../apps/runtime/src/services/canonicalize/command-result.ts";
import { familyForObservation } from "../apps/runtime/src/services/canonicalize/index.ts";
import { canonicalizeSyncPullObservation } from "../apps/runtime/src/services/canonicalize/sync-pull.ts";
import type { CanonicalizableObservation } from "../apps/runtime/src/services/canonicalize/types.ts";

const RECEIVED_AT = new Date("2026-07-01T00:00:00Z");

function observation(input: Partial<CanonicalizableObservation>): CanonicalizableObservation {
  return {
    id: 55,
    source: "pull",
    producer: "sync:fansly:transactions",
    platform: "fansly",
    accountId: 3,
    kind: "earnings_transactions",
    payload: {},
    observedAt: null,
    receivedAt: RECEIVED_AT,
    ...input,
  };
}

describe("sync-pull canonicalizer (Stage 8)", () => {
  it("canonicalizes a Fansly earnings_transactions page into transaction.posted events", () => {
    const events = canonicalizeSyncPullObservation(observation({
      payload: {
        total: 2,
        data: [
          {
            transactionId: "ftx-1",
            walletId: "w-1",
            accountId: "model-acct",
            correlationAccountId: "fan-acct-9",
            senderId: "fan-acct-9",
            type: 2110,
            amount: 1000,
            destinationAmount: 800,
            destinationTax: 200,
            status: 2,
            createdAt: Date.parse("2026-06-01T10:00:00Z"),
          },
          { transactionId: null }, // unparseable row skipped, never thrown
          {
            transactionId: "ftx-2",
            correlationAccountId: null,
            senderId: "fan-acct-3",
            type: 15001,
            amount: 500,
            destinationAmount: 400,
            status: 2,
            createdAt: Date.parse("2026-06-02T10:00:00Z"),
          },
        ],
      },
    }));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "transaction.posted",
      occurredAt: new Date("2026-06-01T10:00:00Z"),
      fanIdentityRef: "fan-acct-9",
      transactionRef: "ftx-1",
      dedupKey: "txn:ftx-1",
    });
    // A46 (W8.2): Fansly amounts are MILLS; new events say so — the OFAPI
    // transaction.posted twin declares "dollars" (see the webhook suite).
    expect(events[0]!.data).toMatchObject({
      rawType: 2110,
      amount: 1000,
      amountUnit: "mills",
      destinationAmount: 800,
    });
    expect(events[1]!.fanIdentityRef).toBe("fan-acct-3");
  });

  it("canonicalizes OFAPI REST dm_messages items with webhook-colliding dedup keys", () => {
    const events = canonicalizeSyncPullObservation(observation({
      platform: "onlyfans",
      kind: "dm_messages",
      producer: "sync:onlyfans:dm_messages",
      payload: {
        items: [
          {
            id: 1000006,
            createdAt: "2026-06-10T18:35:30+00:00",
            fromUser: { id: 1000005 },
            isSentByMe: false,
            text: "<p>hi</p>",
            price: 0,
            isTip: false,
            isFree: true,
          },
          {
            id: 1000027,
            createdAt: "2026-06-10T21:25:47+00:00",
            isSentByMe: true,
            text: "<p>ppv</p>",
            price: 25,
            isFree: false,
          },
        ],
      },
    }));

    expect(events).toHaveLength(2);
    // Same message id as the webhook fixture — the dedup keys collide by
    // construction (the cross-producer proof rides on this).
    expect(events[0]).toMatchObject({
      type: "message.received",
      fanIdentityRef: "1000005",
      messageRef: "1000006",
      dedupKey: "msg:received:1000006",
    });
    expect(events[1]).toMatchObject({
      type: "message.sent",
      fanIdentityRef: null,
      dedupKey: "msg:sent:1000027",
    });
  });

  it("canonicalizes fansly dm pages against the page's own account ref (v2)", () => {
    const context = { nativeAccountRefByAccountId: new Map([[3, "fansly-own-1"]]) };
    const events = canonicalizeSyncPullObservation(observation({
      platform: "fansly",
      kind: "dm_messages",
      payload: {
        messages: [
          {
            id: "fm-10",
            groupId: "grp-1",
            senderId: "fansly-fan-7",
            content: "hi!",
            createdAt: Date.parse("2026-06-21T09:00:00Z"),
            totalTipAmount: 5000, // MILLS
          },
          {
            id: "fm-11",
            groupId: "grp-1",
            senderId: "fansly-own-1",
            content: "hello back",
            createdAt: Date.parse("2026-06-21T09:01:00Z"),
          },
        ],
        // Fansly includes newly observed PPV purchases inline on DM pages.
        // v4 materializes them immediately; purchase_history then backfills
        // older buyers for the same media id.
        accountMediaOrders: [{
          accountId: "fansly-fan-7",
          accountMediaId: "media-99",
          createdAt: Math.floor(Date.parse("2026-06-21T09:02:00Z") / 1000),
          type: 1,
        }],
      },
    }), context);
    // v5 (WP-F0(b)): the same page now also yields the ORDER-identity lane.
    // message.ppv_unlocked is unchanged and keeps running beside it — the two
    // describe one purchase from two identities and are never summed.
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      type: "message.received",
      fanIdentityRef: "fansly-fan-7",
      conversationRef: "grp-1",
      dedupKey: "msg:received:fm-10",
    });
    expect(events[0]!.data).toMatchObject({ tipAmountMills: 5000, isTip: true });
    expect(events[1]).toMatchObject({
      type: "message.sent",
      fanIdentityRef: null,
      dedupKey: "msg:sent:fm-11",
    });
    expect(events[2]).toMatchObject({
      type: "message.ppv_unlocked",
      fanIdentityRef: "fansly-fan-7",
      dedupKey: "ppv:fansly-fan-7:media-99:2026-06-21T09:02:00.000Z",
    });
    expect(events[3]).toMatchObject({
      type: "media.order_observed",
      fanIdentityRef: "fansly-fan-7",
      // Composite natural key: the live order shape carries no order id.
      dedupKey: `mediaorder:v1:3:media-99:fansly-fan-7:${
        Math.floor(Date.parse("2026-06-21T09:02:00Z") / 1000)
      }`,
    });
    // Receipt-time (§3.2b): the ORDER event is dated at the observation, with
    // the provider instant typed in data — so a historical order can never aim
    // an append at a cold partition.
    expect(events[3]!.occurredAt).toEqual(RECEIVED_AT);
    expect(events[3]!.data).toMatchObject({ orderedAt: "2026-06-21T09:02:00.000Z" });
    expect(events[3]!.data.occurredAtClamped).toBeUndefined();

    // Without the page's own ref the observation stays undecidable → zero events.
    expect(canonicalizeSyncPullObservation(observation({
      platform: "fansly",
      kind: "dm_messages",
      payload: { messages: [{ id: "fm-12" }] },
    }))).toEqual([]);
  });

  it("canonicalizes a media-scoped purchase-history response", () => {
    const events = canonicalizeSyncPullObservation(observation({
      kind: "purchase_history",
      payload: {
        accountMediaOrderHistory: [{
          accountId: "fansly-fan-8",
          accountMediaBundleId: "bundle-44",
          createdAt: Math.floor(Date.parse("2026-06-22T10:00:00Z") / 1000),
          type: 2,
        }],
      },
    }));

    expect(events).toEqual([
      expect.objectContaining({
        type: "message.ppv_unlocked",
        fanIdentityRef: "fansly-fan-8",
        dedupKey: "ppv:fansly-fan-8:bundle-44:2026-06-22T10:00:00.000Z",
        data: expect.objectContaining({ accountMediaBundleId: "bundle-44" }),
      }),
      // v5: purchase_history shares the DM sidecar shapes, so it feeds the
      // media plane through the SAME composite key an inline DM order row
      // would mint — which is what collapses both lanes to one media_orders
      // row (see the coexistence test).
      expect.objectContaining({
        type: "media.order_observed",
        fanIdentityRef: "fansly-fan-8",
        dedupKey: `mediaorder:v1:3:bundle-44:fansly-fan-8:${
          Math.floor(Date.parse("2026-06-22T10:00:00Z") / 1000)
        }`,
      }),
    ]);
  });

  it("poisons an entire Fansly fan/window on malformed money or aggregate overflow", () => {
    const lifetime = canonicalizeSyncPullObservation(observation({
      kind: "fan_earnings_stats",
      payload: [
        { correlationAccountId: "fan-valid", totalGross: 5_000, totalNet: 4_000, type: 2010 },
        { correlationAccountId: "fan-valid", totalGross: 2_000, totalNet: 1_600, type: 2110 },
        { correlationAccountId: "fan-poisoned", totalGross: 5_000, totalNet: 4_000, type: 2010 },
        { correlationAccountId: "fan-poisoned", totalGross: 1_000, type: 2110 },
        { correlationAccountId: "fan-fractional", totalGross: 1.5, totalNet: 1, type: 2010 },
        {
          correlationAccountId: "fan-overflow",
          totalGross: Number.MAX_SAFE_INTEGER,
          totalNet: Number.MAX_SAFE_INTEGER,
          type: 2010,
        },
        { correlationAccountId: "fan-overflow", totalGross: 1, totalNet: 0, type: 2110 },
        { correlationAccountId: "fan-wrong-money", totalGross: "5000", totalNet: 4_000 },
      ],
    }));

    expect(lifetime).toHaveLength(1);
    expect(lifetime[0]).toMatchObject({
      type: "fan.earnings_observed",
      fanIdentityRef: "fan-valid",
      data: { window: "lifetime", grossMills: 7_000, netMills: 5_600 },
    });

    const monthly = canonicalizeSyncPullObservation(observation({
      kind: "fan_earnings_monthly",
      payload: [
        { correlationAccountId: "fan-valid", year: 2026, month: 7, totalGross: 2_000, totalNet: 1_600 },
        { correlationAccountId: "fan-poisoned", year: 2026, month: 7, totalGross: 2_000, totalNet: 1_600 },
        { correlationAccountId: "fan-poisoned", year: 2026, month: 7, totalGross: 1_000, totalNet: null },
        { correlationAccountId: "fan-month-zero", year: 2026, month: 0, totalGross: 2_000, totalNet: 1_600 },
        { correlationAccountId: "fan-month-fraction", year: 2026, month: 7.5, totalGross: 2_000, totalNet: 1_600 },
      ],
    }));

    expect(monthly).toHaveLength(1);
    expect(monthly[0]).toMatchObject({
      fanIdentityRef: "fan-valid",
      data: { window: "2026-07", grossMills: 2_000, netMills: 1_600 },
    });
  });

  // W8.2 / A49 gate (cross-review): the proposed workboard-recompute fallback
  // (message.* with null fanIdentityRef → use conversationRef as the fan)
  // is only sound if a Fansly message.sent event's conversationRef IS the
  // thread partner's platform account id. IT IS NOT: Fansly DMs are keyed by
  // the messaging GROUP id (`item.groupId`) — a separate id space from
  // account ids (the messaging-groups payload carries `partnerAccountId`
  // alongside `groupId`; see trimFanslyMessagingGroupsPayload). Feeding a
  // groupId into findPlatformFan can never resolve (or worse, could collide) —
  // so the fallback stays DISABLED and this pin documents the refutation.
  // If Fansly conversationRef semantics ever change to the partner account,
  // this test fails and A49 can be revisited.
  it("A49 refutation pin: Fansly message.sent conversationRef is the GROUP id, not the thread partner", () => {
    const context = { nativeAccountRefByAccountId: new Map([[3, "fansly-own-1"]]) };
    // Live-shape Fansly DM item (fixture-proven fields: id/groupId/senderId/
    // content/createdAt): the model (own ref) writes to fan "fansly-fan-7"
    // inside messaging group "grp-777".
    const events = canonicalizeSyncPullObservation(observation({
      platform: "fansly",
      kind: "dm_messages",
      payload: {
        messages: [{
          id: "fm-sent-1",
          groupId: "grp-777",
          senderId: "fansly-own-1",
          content: "model reply",
          createdAt: Math.floor(Date.parse("2026-06-21T09:05:00Z") / 1000),
        }],
      },
    }), context);

    expect(events).toHaveLength(1);
    const sent = events[0]!;
    expect(sent.type).toBe("message.sent");
    // The honest nulls/refs the A49 fallback would have misused:
    expect(sent.fanIdentityRef).toBeNull();
    expect(sent.conversationRef).toBe("grp-777");
    expect(sent.conversationRef).not.toBe("fansly-fan-7");
    expect(sent.conversationRef).not.toBe("fansly-own-1");
  });

  it("declares nothing for OM pages or unknown kinds", () => {
    expect(canonicalizeSyncPullObservation(observation({
      kind: "onlymonster_transactions",
      payload: { data: [] },
    }))).toEqual([]);
    expect(canonicalizeSyncPullObservation(observation({
      kind: "subscribers",
      payload: {},
    }))).toEqual([]);
  });
});

describe("command-result canonicalizer (Stage 8)", () => {
  it("collapses terminal command states into command.settled", () => {
    const events = canonicalizeCommandResultObservation(observation({
      source: "command_result",
      producer: "ofapi:command-executor",
      platform: "onlyfans",
      kind: "command.confirmed",
      payload: {
        commandId: "cmd-77",
        commandKind: "send_text",
        pageId: 4,
        conversationId: "1000005",
        state: "confirmed",
        platformMessageId: "1000027",
      },
    }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "command.settled",
      conversationRef: "1000005",
      dedupKey: "cmd:cmd-77:confirmed",
    });
    expect(events[0]!.data).toMatchObject({ commandId: "cmd-77", state: "confirmed" });
  });
});

describe("canonicalizer registry dispatch", () => {
  it("routes each source to its family and leaves undeclared kinds unowned", () => {
    expect(familyForObservation({ source: "webhook", kind: "messages.received" })?.source).toBe("webhook");
    // tips.received graduated to declared in webhook family v2 (decision #81).
    expect(familyForObservation({ source: "webhook", kind: "tips.received" })?.source).toBe("webhook");
    expect(familyForObservation({ source: "webhook", kind: "users.typing" })).toBeNull();
    expect(familyForObservation({ source: "pull", kind: "earnings_transactions" })?.source).toBe("pull");
    expect(familyForObservation({ source: "pull", kind: "subscribers" })).toBeNull();
    expect(familyForObservation({ source: "command_result", kind: "command.failed" })?.source).toBe("command_result");
    // Stage 11: declared desktop kinds route to client_capture; unknown wait.
    expect(familyForObservation({ source: "client_capture", kind: "desktop.ai_acceptance" })?.source)
      .toBe("client_capture");
    expect(familyForObservation({ source: "client_capture", kind: "desktop.unknown:mystery" })).toBeNull();
    expect(familyForObservation({ source: "operator", kind: "admin.sync_trigger" })).toBeNull();
  });
});
