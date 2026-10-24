import { describe, expect, it } from "vitest";

import type { PublicationWire } from "@agency_hub_core/contracts";

import {
  approvalItems,
  dayKeyOf,
  dayStartIso,
  dollarsInput,
  groupPublicationsByDay,
  parseDollars,
  priceLabel,
  settingsForm,
  windowRange,
  type SettingsDraft,
} from "../apps/dashboard/src/pages/publications/publicationsView.ts";

// The «Публикации» screen's own logic (docs/plans/2026-10-23-wall-posts, PR 2):
// the Moscow day a post lands in, the date window it asks the hub for, and the
// dollars a person types turned into the mills the hub takes. The words are
// not pinned here.

function publication(id: number, publishAt: string, extra: Partial<PublicationWire> = {}): PublicationWire {
  return {
    id, pageLabel: "lilly-1", platform: "fansly", kind: "fyp_post", status: "draft", version: 1, text: "",
    publishAt, expiresAt: null, wallRefs: [], tierRefs: [], priceMills: null, repost: false, media: [],
    findings: [], blocked: false, author: { kind: "human", userId: 1, agentKeyId: null },
    approvedRevisionId: null, platformPostRef: null, statusReason: null, previousPublicationId: null, withdrawal: null, deletion: null,
    createdAt: publishAt, updatedAt: publishAt, statusChangedAt: publishAt,
    ...extra,
  };
}

describe("Moscow days", () => {
  it("puts a post in the Moscow day it goes out, not the UTC one", () => {
    // 22:30 UTC on the 23rd is 01:30 on the 24th in Moscow.
    expect(dayKeyOf("2026-10-23T22:30:00.000Z")).toBe("2026-10-24");
    expect(dayKeyOf("2026-10-23T20:59:00.000Z")).toBe("2026-10-23");
  });

  it("starts a Moscow day at 21:00 UTC of the day before", () => {
    expect(dayStartIso("2026-10-24")).toBe("2026-10-23T21:00:00.000Z");
    // A zone with a clock change: the day's start is still its own midnight.
    expect(dayStartIso("2026-03-29", "Europe/Berlin")).toBe("2026-03-28T23:00:00.000Z");
    expect(dayStartIso("2026-03-30", "Europe/Berlin")).toBe("2026-03-29T22:00:00.000Z");
  });

  it("groups by day, earliest first, each day in publish order", () => {
    const days = groupPublicationsByDay([
      publication(3, "2026-10-24T09:00:00.000Z"),
      publication(1, "2026-10-23T22:30:00.000Z"),
      publication(2, "2026-10-23T10:00:00.000Z"),
      publication(4, "2026-10-24T09:00:00.000Z", { pageLabel: "ari-1" }),
    ], "2026-10-23");
    expect(days.map((day) => [day.key, day.publications.map((item) => item.id)])).toEqual([
      ["2026-10-23", [2]],
      ["2026-10-24", [1, 4, 3]],
    ]);
    expect(days[0]?.label.startsWith("Сегодня")).toBe(true);
    expect(days[1]?.label.startsWith("Завтра")).toBe(true);
  });

  it("asks for whole Moscow days, today included either way", () => {
    expect(windowRange("next7", "2026-10-23")).toEqual({ from: "2026-10-22T21:00:00.000Z", to: "2026-10-29T21:00:00.000Z" });
    expect(windowRange("last7", "2026-10-23")).toEqual({ from: "2026-10-16T21:00:00.000Z", to: "2026-10-23T21:00:00.000Z" });
    expect(windowRange("all", "2026-10-23")).toEqual({});
  });
});

describe("dollars and mills", () => {
  it("reads what a person types as mills, through the money codec", () => {
    expect(parseDollars("9.99")).toEqual({ mills: 9990, error: null });
    expect(parseDollars("$5")).toEqual({ mills: 5000, error: null });
    expect(parseDollars(" 12,5 ")).toEqual({ mills: 12500, error: null });
    expect(parseDollars("0.1")).toEqual({ mills: 100, error: null });
    expect(parseDollars("")).toEqual({ mills: null, error: null });
  });

  it("refuses what is not a price in whole cents", () => {
    for (const text of ["0", "0.00", "-5", "1.999", "abc", "5 долларов", "1e3"]) {
      expect(parseDollars(text).mills, text).toBeNull();
      expect(parseDollars(text).error, text).not.toBeNull();
    }
  });

  it("shows mills back as the dollars a person typed", () => {
    expect(dollarsInput(5000)).toBe("5");
    expect(dollarsInput(9990)).toBe("9.99");
    expect(dollarsInput(5500)).toBe("5.50");
    expect(dollarsInput(5010)).toBe("5.01");
    expect(dollarsInput(null)).toBe("");
    expect(priceLabel(15000)).toBe("$15");
    expect(priceLabel(9990)).toBe("$9.99");
    for (const mills of [100, 5000, 9990, 12500, 99_999_990]) {
      expect(parseDollars(dollarsInput(mills)).mills).toBe(mills);
    }
  });
});

describe("page settings", () => {
  const draft: SettingsDraft = { enabled: true, priceMin: "5", priceMax: "30", repostDays: "30", dailyLimit: "" };

  it("sends the price range in mills", () => {
    expect(settingsForm(draft).body).toEqual({
      enabled: true, paidPriceMinMills: 5000, paidPriceMaxMills: 30000, repostThresholdDays: 30, dailyLimit: null,
    });
    expect(settingsForm({ ...draft, priceMin: "", priceMax: "", dailyLimit: "4" }).body).toMatchObject({
      paidPriceMinMills: null, paidPriceMaxMills: null, dailyLimit: 4,
    });
  });

  it("refuses half a range, an upside-down one and out-of-bounds numbers", () => {
    expect(settingsForm({ ...draft, priceMax: "" }).errors.price).toBeDefined();
    expect(settingsForm({ ...draft, priceMin: "40" }).errors.price).toBeDefined();
    expect(settingsForm({ ...draft, repostDays: "0" }).errors.repostDays).toBeDefined();
    expect(settingsForm({ ...draft, repostDays: "366" }).errors.repostDays).toBeDefined();
    expect(settingsForm({ ...draft, dailyLimit: "2.5" }).errors.dailyLimit).toBeDefined();
    for (const bad of [{ priceMax: "" }, { priceMin: "40" }, { repostDays: "x" }, { dailyLimit: "0" }]) {
      expect(settingsForm({ ...draft, ...bad }).body).toBeNull();
    }
  });
});

describe("approving a selection", () => {
  it("sends the versions shown, in the order shown, approvable drafts only", () => {
    const shown = [
      publication(5, "2026-10-24T08:00:00.000Z", { version: 3 }),
      publication(2, "2026-10-24T09:00:00.000Z", { version: 1, blocked: true }),
      publication(9, "2026-10-24T10:00:00.000Z", { version: 2, status: "approved" }),
      publication(1, "2026-10-24T11:00:00.000Z", { version: 7 }),
    ];
    expect(approvalItems(shown, new Set([1, 2, 5, 9]))).toEqual([{ id: 5, version: 3 }, { id: 1, version: 7 }]);
  });
});
