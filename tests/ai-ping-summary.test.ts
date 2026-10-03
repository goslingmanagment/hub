import { describe, expect, it } from "vitest";

import { FAN_SILENCE_DAYS_MAX } from "@agency_hub_core/contracts";

import {
  analyzePingSegment,
  computePingSummary,
  normalizeTranscriptMessages,
  PING_ACTIVE_WINDOW_MS,
  type OfapiChatMessage,
  type TranscriptMessage,
} from "../apps/runtime/src/modules/ai/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse("2026-10-03T12:00:00.000Z");

/** The generation's inline computation before the helper existed, copied
 * from features/index.ts (Decision #127) minus the policy gate that stays
 * there, so the helper is pinned to the values the prompt used to receive. */
function inlineGenerationValues(messages: readonly TranscriptMessage[], pingNowMs: number) {
  const pingAnalysis = analyzePingSegment(messages, pingNowMs);
  return {
    pingSegment: pingAnalysis.segment,
    fanSilenceDays: pingAnalysis.latestFanTextAtMs !== null
      ? Math.min(
          FAN_SILENCE_DAYS_MAX,
          Math.max(0, Math.floor((pingNowMs - pingAnalysis.latestFanTextAtMs) / DAY_MS)),
        )
      : undefined,
  };
}

/** What features/index.ts now puts into the prompt context values. */
function generationValues(messages: readonly TranscriptMessage[], nowMs: number) {
  const pingSummary = computePingSummary(messages, nowMs);
  return {
    pingSegment: pingSummary.segment,
    fanSilenceDays: pingSummary.fanSilenceDays ?? undefined,
  };
}

let nextId = 1;

/** One archive row in the shape the context loaders hand the migrated
 * normalizer: `isSentByMe` decides the sender, as it does in generation. */
function row(input: {
  atMs: number;
  isSentByMe: boolean;
  text?: string;
  isTip?: boolean;
  tipAmount?: number;
  mediaCount?: number;
}): OfapiChatMessage {
  return {
    id: nextId++,
    text: input.text ?? "",
    isSentByMe: input.isSentByMe,
    createdAt: new Date(input.atMs).toISOString(),
    price: null,
    isOpened: null,
    isTip: input.isTip ?? false,
    tipAmount: input.tipAmount ?? null,
    mediaCount: input.mediaCount ?? 0,
    media: Array.from({ length: input.mediaCount ?? 0 }, (_, index) => ({ id: index + 1, type: "photo", canView: true })),
  } as OfapiChatMessage;
}

const fanText = (atMs: number, text = "hey") => row({ atMs, isSentByMe: false, text });
const modelText = (atMs: number, text = "miss you") => row({ atMs, isSentByMe: true, text });

function summarize(rows: OfapiChatMessage[], nowMs = NOW_MS) {
  const messages = normalizeTranscriptMessages(rows);
  const summary = computePingSummary(messages, nowMs);
  expect(generationValues(messages, nowMs)).toEqual(inlineGenerationValues(messages, nowMs));
  return summary;
}

describe("computePingSummary", () => {
  it("treats a fan text exactly five days old as active and one millisecond older as silent", () => {
    expect(PING_ACTIVE_WINDOW_MS).toBe(5 * DAY_MS);
    const atBoundary = NOW_MS - PING_ACTIVE_WINDOW_MS;
    expect(summarize([fanText(atBoundary)])).toEqual({ segment: "active", fanSilenceDays: 5 });
    expect(summarize([fanText(atBoundary - 1)])).toEqual({ segment: "segment-b", fanSilenceDays: 5 });
    expect(summarize([fanText(atBoundary + 1)])).toEqual({ segment: "active", fanSilenceDays: 4 });
  });

  it("reads one clock for both values, so the silence never contradicts the segment", () => {
    // A single nowMs at the boundary: active with 5 whole days, never
    // "active" next to a 6-day silence or "segment-b" next to 4 days.
    const messages = normalizeTranscriptMessages([fanText(NOW_MS - 5 * DAY_MS)]);
    const summary = computePingSummary(messages, NOW_MS);
    expect(summary).toEqual({ segment: "active", fanSilenceDays: 5 });
    expect(computePingSummary(messages, NOW_MS + 1)).toEqual({ segment: "segment-b", fanSilenceDays: 5 });
  });

  it("needs three fan texts for segment-a; one or two at the same dates stay segment-b", () => {
    const old = NOW_MS - 30 * DAY_MS;
    expect(summarize([fanText(old - 2 * DAY_MS), fanText(old)])).toEqual({ segment: "segment-b", fanSilenceDays: 30 });
    expect(summarize([fanText(old)])).toEqual({ segment: "segment-b", fanSilenceDays: 30 });
    expect(summarize([fanText(old - 2 * DAY_MS), fanText(old - DAY_MS), fanText(old)]))
      .toEqual({ segment: "segment-a", fanSilenceDays: 30 });
    // Three texts sharing one timestamp count as three.
    expect(summarize([fanText(old), fanText(old, "you there"), fanText(old, "?")]))
      .toEqual({ segment: "segment-a", fanSilenceDays: 30 });
  });

  it("does not count label-only or tip-only messages, nor the model's texts", () => {
    const old = NOW_MS - 20 * DAY_MS;
    const recent = NOW_MS - DAY_MS;
    const rows = [
      fanText(old),
      row({ atMs: recent, isSentByMe: false, mediaCount: 2 }),
      row({ atMs: recent, isSentByMe: false, isTip: true, tipAmount: 25 }),
      row({ atMs: recent, isSentByMe: false, isTip: true }),
      row({ atMs: recent, isSentByMe: false, text: "  <p> </p> " }),
      modelText(recent),
      modelText(recent),
      modelText(recent),
    ];
    const messages = normalizeTranscriptMessages(rows);
    // The label-only rows are really in the transcript, just without text.
    expect(messages.filter((message) => message.sender === "Fan" && message.labels.length > 0)).toHaveLength(3);
    expect(summarize(rows)).toEqual({ segment: "segment-b", fanSilenceDays: 20 });
  });

  it("counts every message the model did not send as the fan's, as generation does", () => {
    // The helper's half only: rows built here with isSentByMe false (what a
    // system or unknown sender role carries in the archive) read as the fan.
    // That the real loaders turn those sender roles into isSentByMe false is
    // asserted against the database in client-ping-summary.integration.test.ts.
    const old = NOW_MS - 12 * DAY_MS;
    const notByModel = [
      row({ atMs: old - 2 * DAY_MS, isSentByMe: false, text: "system: subscription renewed" }),
      row({ atMs: old - DAY_MS, isSentByMe: false, text: "unknown sender" }),
      row({ atMs: old, isSentByMe: false, text: "hi" }),
    ];
    const messages = normalizeTranscriptMessages(notByModel);
    expect(messages.map((message) => message.sender)).toEqual(["Fan", "Fan", "Fan"]);
    expect(summarize(notByModel)).toEqual({ segment: "segment-a", fanSilenceDays: 12 });
  });

  it("has no silence without a fan text and clamps it to the contract range", () => {
    expect(summarize([])).toEqual({ segment: "segment-b", fanSilenceDays: null });
    expect(summarize([modelText(NOW_MS - DAY_MS), row({ atMs: NOW_MS, isSentByMe: false, mediaCount: 1 })]))
      .toEqual({ segment: "segment-b", fanSilenceDays: null });
    expect(summarize([fanText(NOW_MS + 3 * DAY_MS)])).toEqual({ segment: "active", fanSilenceDays: 0 });
    expect(summarize([fanText(0), fanText(1), fanText(2)], (FAN_SILENCE_DAYS_MAX + 50) * DAY_MS))
      .toEqual({ segment: "segment-a", fanSilenceDays: FAN_SILENCE_DAYS_MAX });
  });

  it("matches the former inline generation values over a seeded sweep", () => {
    let seed = 0x9e3779b9;
    const random = () => {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
      return seed / 0x1_0000_0000;
    };
    let boundaryRounds = 0;
    for (let round = 0; round < 500; round += 1) {
      const count = Math.floor(random() * 8);
      const rows: OfapiChatMessage[] = [];
      for (let index = 0; index < count; index += 1) {
        const atMs = NOW_MS - Math.floor(random() * 40 * DAY_MS) + Math.floor(random() * DAY_MS);
        const kind = random();
        rows.push(
          kind < 0.45
            ? fanText(atMs)
            : kind < 0.7
              ? modelText(atMs)
              : kind < 0.85
                ? row({ atMs, isSentByMe: false, mediaCount: 1 })
                : row({ atMs, isSentByMe: false, isTip: true, tipAmount: 5 }),
        );
      }
      const messages = normalizeTranscriptMessages(rows);
      // Every tenth round lands exactly on the 5-day boundary of the fan
      // text that decides the segment, and the next one a millisecond past it.
      const decidingFanTextAtMs = analyzePingSegment(messages, NOW_MS).latestFanTextAtMs;
      const boundaryOffsetMs = round % 10 === 0 ? 0 : round % 10 === 1 ? 1 : null;
      const nowMs = decidingFanTextAtMs !== null && boundaryOffsetMs !== null
        ? decidingFanTextAtMs + PING_ACTIVE_WINDOW_MS + boundaryOffsetMs
        : NOW_MS;
      expect(generationValues(messages, nowMs)).toEqual(inlineGenerationValues(messages, nowMs));
      if (decidingFanTextAtMs !== null && boundaryOffsetMs !== null) {
        expect(computePingSummary(messages, nowMs).segment === "active").toBe(boundaryOffsetMs === 0);
        boundaryRounds += 1;
      }
    }
    expect(boundaryRounds).toBeGreaterThan(50);
  });
});
