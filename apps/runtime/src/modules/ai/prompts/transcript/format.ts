// MIGRATED VERBATIM (Stage 30) from chatgoose_desktop_fable
// transcript/format.ts @ 1db76a4ae13d (2026-07-06); adapted ONLY in imports.
// Prompts are tuned production assets — do not reword outside
// the parity harness.
import type { TranscriptMessage } from './normalize.ts';

export const EMPTY_TRANSCRIPT_TEXT = 'No conversation history.';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * [HH:MM] in UTC for everyone (SPEC §8.2 decision 2026-06-10; legacy used the
 * machine-local timezone — deliberate change for byte-stable shared context).
 */
export function formatTranscriptTime(createdAtMs: number): string {
  const date = new Date(createdAtMs);
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

/**
 * The day line before a UTC day's first message: `--- YYYY-MM-DD ---`, the
 * shape the Fansly extension's notes fill already sends (its E164) and the
 * notes-fill prompt describes. Without it a window that spans days or weeks
 * reads as one day: `[HH:MM]` is the time of day only.
 */
export function formatTranscriptDayLine(createdAtMs: number): string {
  const date = new Date(createdAtMs);
  return `--- ${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ---`;
}

/** One message: `[HH:MM] Sender: {labels} {text}`. */
export function formatTranscriptLine(message: TranscriptMessage): string {
  const labels = message.labels.join(' ').trim();
  const payload = [labels, message.text].filter(Boolean).join(' ').trim();
  return `[${formatTranscriptTime(message.createdAtMs)}] ${message.sender}: ${payload}`;
}

/** Message lines in order, a day line before each UTC day's first message,
 *  joined with '\n'. */
export function formatTranscript(messages: readonly TranscriptMessage[]): string {
  if (messages.length === 0) {
    return EMPTY_TRANSCRIPT_TEXT;
  }
  const lines: string[] = [];
  let previousDay: string | null = null;
  for (const message of messages) {
    const day = formatTranscriptDayLine(message.createdAtMs);
    if (day !== previousDay) {
      lines.push(day);
      previousDay = day;
    }
    lines.push(formatTranscriptLine(message));
  }
  return lines.join('\n');
}
