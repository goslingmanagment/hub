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
    expect(events[0]!.data).toMatchObject({ rawType: 2110, amount: 1000, destinationAmount: 800 });
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

  it("declares nothing for fansly dm pages, OM pages, or unknown kinds", () => {
    expect(canonicalizeSyncPullObservation(observation({
      platform: "fansly",
      kind: "dm_messages",
      payload: { messages: [{ id: "m1" }] },
    }))).toEqual([]);
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
    expect(familyForObservation({ source: "webhook", kind: "tips.received" })).toBeNull();
    expect(familyForObservation({ source: "pull", kind: "earnings_transactions" })?.source).toBe("pull");
    expect(familyForObservation({ source: "pull", kind: "subscribers" })).toBeNull();
    expect(familyForObservation({ source: "command_result", kind: "command.failed" })?.source).toBe("command_result");
    expect(familyForObservation({ source: "operator", kind: "admin.sync_trigger" })).toBeNull();
  });
});
