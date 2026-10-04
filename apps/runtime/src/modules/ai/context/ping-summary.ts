import { FAN_SILENCE_DAYS_MAX } from "@agency_hub_core/contracts";

import {
  analyzePingSegment,
  type PingSegment,
  type TranscriptMessage,
} from "../prompts/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Ping view of one conversation: the segment and the fan's silence. */
export interface PingSummary {
  segment: PingSegment;
  /** Whole days since the fan's last text message, clamped to
   * 0..FAN_SILENCE_DAYS_MAX; null when the window holds no fan text. */
  fanSilenceDays: number | null;
}

/**
 * The one Ping summary the hub computes. Generation feeds it to the prompt;
 * readers that show a conversation to a client use the same function, so
 * both report the same segment and silence for the same messages.
 *
 * One analysis call and one clock feed both values. A Date.now() per field
 * could disagree exactly at the 5-day segment boundary (Decision #127).
 * `messages` are the ascending transcript messages the context loaders
 * return; label-only and tip-only messages carry no text and are ignored,
 * and every message the model did not send counts as the fan's.
 */
export function computePingSummary(
  messages: readonly TranscriptMessage[],
  nowMs: number,
): PingSummary {
  const analysis = analyzePingSegment(messages, nowMs);
  return {
    segment: analysis.segment,
    fanSilenceDays: analysis.latestFanTextAtMs === null
      ? null
      : Math.min(
          FAN_SILENCE_DAYS_MAX,
          Math.max(0, Math.floor((nowMs - analysis.latestFanTextAtMs) / DAY_MS)),
        ),
  };
}
