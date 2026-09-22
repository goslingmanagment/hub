import { describe, expect, it } from "vitest";

import {
  isOfapiCreditFloorBlocking,
  isOfapiDmSyncEligiblePage,
  OFAPI_FLOOR_BALANCE_FRESHNESS_MS,
  parseOfapiChatSummary,
} from "../apps/runtime/src/services/sync/ofapi-dm-sync.ts";
import { filterOnlyFansDmPollingStreams } from "../apps/runtime/src/services/sync/onlyfans-dm-polling.ts";

describe("isOfapiDmSyncEligiblePage", () => {
  it("requires the flag, the onlyfans platform, and an OFAPI account mapping", () => {
    const page = { platform: "onlyfans", ofapiAccountId: "acct_1" };
    expect(isOfapiDmSyncEligiblePage({ ofapiDmSyncEnabled: true }, page)).toBe(true);
    expect(isOfapiDmSyncEligiblePage({ ofapiDmSyncEnabled: false }, page)).toBe(false);
    expect(isOfapiDmSyncEligiblePage(undefined, page)).toBe(false);
    expect(isOfapiDmSyncEligiblePage(
      { ofapiDmSyncEnabled: true },
      { platform: "fansly", ofapiAccountId: "acct_1" },
    )).toBe(false);
    expect(isOfapiDmSyncEligiblePage(
      { ofapiDmSyncEnabled: true },
      { platform: "onlyfans", ofapiAccountId: null },
    )).toBe(false);
  });
});

// Audit F7: a sub-floor balance must only park while the observation is fresh
// — parked streams make no requests, so a stale observation would otherwise
// outlive an account top-up forever (the only other refresher, the balance
// ping, is default-off).
describe("isOfapiCreditFloorBlocking", () => {
  const now = new Date("2026-06-13T12:00:00Z");
  const fresh = new Date(now.getTime() - 60_000);
  const stale = new Date(now.getTime() - OFAPI_FLOOR_BALANCE_FRESHNESS_MS);

  it("parks on a fresh sub-floor balance", () => {
    expect(isOfapiCreditFloorBlocking({
      creditFloor: 500, lastBalance: 100, lastBalanceAt: fresh, now,
    })).toBe(true);
  });

  it("lets a probe through once the observation is as old as the park delay", () => {
    expect(isOfapiCreditFloorBlocking({
      creditFloor: 500, lastBalance: 100, lastBalanceAt: stale, now,
    })).toBe(false);
  });

  it("treats a balance with no observation time as stale", () => {
    expect(isOfapiCreditFloorBlocking({
      creditFloor: 500, lastBalance: 100, lastBalanceAt: null, now,
    })).toBe(false);
  });

  it("never parks at or above the floor, with no floor, or with no balance", () => {
    expect(isOfapiCreditFloorBlocking({
      creditFloor: 500, lastBalance: 500, lastBalanceAt: fresh, now,
    })).toBe(false);
    expect(isOfapiCreditFloorBlocking({
      creditFloor: 0, lastBalance: 100, lastBalanceAt: fresh, now,
    })).toBe(false);
    expect(isOfapiCreditFloorBlocking({
      creditFloor: 500, lastBalance: null, lastBalanceAt: fresh, now,
    })).toBe(false);
  });
});

describe("filterOnlyFansDmPollingStreams", () => {
  const streams = ["light", "dm_conversations", "dm_messages"] as const;

  it("still drops DM streams for unmapped OnlyFans pages when polling is off", () => {
    expect(filterOnlyFansDmPollingStreams(
      "onlyfans",
      [...streams],
      { onlyFansDmPollingEnabled: false, ofapiDmSyncEnabled: true },
      { ofapiAccountId: null },
    )).toEqual(["light"]);
  });

  it("keeps List Chats but permanently removes the legacy history stream for mapped pages", () => {
    expect(filterOnlyFansDmPollingStreams(
      "onlyfans",
      [...streams],
      { onlyFansDmPollingEnabled: false, ofapiDmSyncEnabled: true },
      { ofapiAccountId: "acct_1" },
    )).toEqual(["light", "dm_conversations"]);

    expect(filterOnlyFansDmPollingStreams(
      "onlyfans",
      [...streams],
      { onlyFansDmPollingEnabled: false, ofapiDmSyncEnabled: false },
      { ofapiAccountId: "acct_1" },
    )).toEqual(["light"]);
  });
});

describe("parseOfapiChatSummary", () => {
  it("maps a docs-shaped chats item to a conversation summary", () => {
    const summary = parseOfapiChatSummary({
      unreadMessagesCount: 3,
      lastMessage: {
        id: 1000300,
        text: "<p>last <b>message</b></p>",
        createdAt: "2026-06-11T10:00:00+00:00",
        fromUser: { id: 1000005, _view: "s" },
      },
      fan: {
        id: 1000005,
        name: "Fan Display",
        username: "fan005",
        displayName: "",
      },
    });

    expect(summary).not.toBeNull();
    expect(summary!.fanId).toBe("1000005");
    expect(summary!.username).toBe("fan005");
    expect(summary!.displayName).toBe("Fan Display");
    expect(summary!.unreadCount).toBe(3);
    expect(summary!.lastMessage).toEqual({
      messageId: "1000300",
      createdAt: new Date("2026-06-11T10:00:00.000Z"),
      senderId: "1000005",
      senderRole: "fan",
      preview: "last message",
    });
  });

  it("resolves the model role when the last message is not from the fan", () => {
    const summary = parseOfapiChatSummary({
      unreadMessagesCount: 0,
      lastMessage: {
        id: 1000301,
        text: "<p>hi</p>",
        createdAt: "2026-06-11T10:00:00+00:00",
        fromUser: { id: 42, _view: "i" },
      },
      fan: { id: 1000005, name: "Fan", username: "fan005" },
    });
    expect(summary!.lastMessage!.senderRole).toBe("model");

    expect(parseOfapiChatSummary({ fan: {} })).toBeNull();
  });
});
