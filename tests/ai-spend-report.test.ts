import { describe, expect, it } from "vitest";

import type { AiSpendCell } from "@agency_hub_core/db";

import {
  attributeShiftSpend,
  foldSpendCells,
  settingChangeFeatures,
  spendWindow,
  splitSpendParts,
} from "../apps/runtime/src/services/ai-spend-report.ts";

function cell(overrides: Partial<AiSpendCell>): AiSpendCell {
  return {
    dimension: "feature",
    key: "fast-reply",
    label: "fast-reply",
    model: "anthropic:claude-opus-5-5",
    calls: 1,
    costMicroUsd: 0,
    approximateMicroUsd: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheWriteUnsplitTokens: 0,
    outputTokens: 0,
    regenerationCalls: 0,
    regenerationMicroUsd: 0,
    failedCalls: 0,
    failedMicroUsd: 0,
    ...overrides,
  };
}

describe("AI spend report", () => {
  it("splits a recorded Opus 5.5 price into its token types at list rates", () => {
    // 3250 in × $4 + 5153 read × $0.2 + 77 1h-writes × $8 + 300 out × $20
    const cost = 13000 + 1031 + 616 + 6000;
    expect(splitSpendParts("anthropic:claude-opus-5-5", cell({
      costMicroUsd: cost,
      inputTokens: 3250,
      cacheReadTokens: 5153,
      cacheWrite1hTokens: 77,
      outputTokens: 300,
    }))).toEqual({
      inputMicroUsd: 13000,
      cacheReadMicroUsd: 1031,
      cacheWriteMicroUsd: 616,
      outputMicroUsd: 6000,
      otherMicroUsd: 0,
    });
  });

  it("places cache writes with no TTL split between the 5m and 1h rates by what the price leaves", () => {
    // 100 writes priced at 1h ($8) on an old row: 800, of which 500 is the 5m floor.
    const parts = splitSpendParts("anthropic:claude-opus-5-5", cell({ costMicroUsd: 4000 + 800, inputTokens: 1000, cacheWriteUnsplitTokens: 100 }));
    expect(parts).toMatchObject({ inputMicroUsd: 4000, cacheWriteMicroUsd: 800, otherMicroUsd: 0 });
    // An estimate above every rate keeps the excess as "other", never as cache.
    const estimated = splitSpendParts("anthropic:claude-opus-5-5", cell({ costMicroUsd: 9000, inputTokens: 1000, cacheWriteUnsplitTokens: 100 }));
    expect(estimated).toMatchObject({ cacheWriteMicroUsd: 800, otherMicroUsd: 4200 });
  });

  it("leaves a model the catalog lacks wholly in other", () => {
    expect(splitSpendParts("anthropic:claude-unknown", cell({ costMicroUsd: 1234, inputTokens: 10 })))
      .toEqual({ inputMicroUsd: 0, cacheReadMicroUsd: 0, cacheWriteMicroUsd: 0, outputMicroUsd: 0, otherMicroUsd: 1234 });
  });

  it("folds a dimension over models, dearest first, and keeps days in time order", () => {
    const cells = [
      cell({ key: "coach-chat", label: "coach-chat", costMicroUsd: 300, calls: 2 }),
      cell({ key: "fast-reply", label: "fast-reply", costMicroUsd: 200, calls: 3 }),
      cell({ key: "fast-reply", label: "fast-reply", model: "anthropic:claude-opus-4-8", costMicroUsd: 200, calls: 1 }),
      cell({ dimension: "day", key: "2026-10-28", label: "2026-10-28", costMicroUsd: 1 }),
      cell({ dimension: "day", key: "2026-10-27", label: "2026-10-27", costMicroUsd: 9 }),
    ];
    expect(foldSpendCells(cells, "feature").map((row) => [row.key, row.costMicroUsd, row.calls]))
      .toEqual([["fast-reply", 400, 4], ["coach-chat", 300, 2]]);
    expect(foldSpendCells(cells, "day").map((row) => row.key)).toEqual(["2026-10-27", "2026-10-28"]);
  });

  it("names the features a setting change touched: by its JSON keys or by its name", () => {
    expect(settingChangeFeatures(
      "aiFeatureEfforts",
      { "coach-chat": "high", "fast-reply": "low" },
      { "coach-chat": "medium", "fast-reply": "low", "ping": "low" },
    )).toEqual(["coach-chat", "ping"]);
    expect(settingChangeFeatures("aiFeatureWindows", "{\"fast-reply\":25}", "{\"fast-reply\":40}")).toEqual(["fast-reply"]);
    // A switch of one lane is that lane's, not the whole hub's.
    expect(settingChangeFeatures("fanFactsEnabled", true, false)).toEqual(["fan-facts"]);
    expect(settingChangeFeatures("aiNotesTrimEnabled", false, true)).toEqual(["fan-notes-fill"]);
    expect(settingChangeFeatures("aiMediaDescribePagePolicies", { "lora-of": { since: "a" } }, { "lora-of": { since: "b" } }))
      .toEqual(["media-describe"]);
    // A setting of every feature, or keyed by page with no lane in its name: the whole hub.
    expect(settingChangeFeatures("chatMuseAiPromptDebugEchoEnabled", false, true)).toBeNull();
    expect(settingChangeFeatures("aiTranscriptMaxMessages", 100, 50)).toBeNull();
    expect(settingChangeFeatures("aiFeatureEfforts", { a: 1 }, { a: 1 })).toBeNull();
  });

  it("scales a spend window to a day, and not under an hour", () => {
    expect(spendWindow(72, 84_000_000)).toEqual({ hours: 72, microUsd: 84_000_000, perDayMicroUsd: 28_000_000 });
    expect(spendWindow(6, 1_500_000).perDayMicroUsd).toBe(6_000_000);
    expect(spendWindow(0.5, 100).perDayMicroUsd).toBeNull();
  });

  it("sums a chatter's AI spend into their shifts and keeps the rest apart", () => {
    const at = (iso: string) => new Date(iso);
    const shifts = [
      { userId: 1, username: "anna", startedAt: at("2026-10-28T08:00:00Z").getTime(), endedAt: at("2026-10-28T16:00:00Z").getTime(), workedMinutes: 420 },
      { userId: 2, username: "boris", startedAt: at("2026-10-28T10:00:00Z").getTime(), endedAt: at("2026-10-28T12:00:00Z").getTime(), workedMinutes: 120 },
    ];
    const result = attributeShiftSpend(shifts, [
      { userId: 1, minute: at("2026-10-28T09:00:00Z"), costMicroUsd: 3_000_000 },
      { userId: 1, minute: at("2026-10-28T15:59:00Z"), costMicroUsd: 500_000 },
      // After anna's shift ended, and boris's minute inside anna's hours only.
      { userId: 1, minute: at("2026-10-28T16:00:00Z"), costMicroUsd: 100_000 },
      { userId: 2, minute: at("2026-10-28T13:00:00Z"), costMicroUsd: 200_000 },
      { userId: 2, minute: at("2026-10-28T11:00:00Z"), costMicroUsd: 1_200_000 },
    ]);
    expect(result).toMatchObject({
      shifts: 2,
      workedMinutes: 540,
      inShiftsMicroUsd: 4_700_000,
      outsideShiftsMicroUsd: 300_000,
      perShiftMicroUsd: 2_350_000,
      perWorkedHourMicroUsd: Math.round(4_700_000 / 540 * 60),
    });
    expect(result.byChatter.map((row) => [row.username, row.inShiftsMicroUsd, row.perWorkedHourMicroUsd]))
      .toEqual([["anna", 3_500_000, 500_000], ["boris", 1_200_000, 600_000]]);
  });
});
