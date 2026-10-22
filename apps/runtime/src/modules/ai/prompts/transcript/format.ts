// MIGRATED VERBATIM from chatgoose_desktop_fable
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

const MESSAGE_TIME_RE = /^\[(\d\d):(\d\d)\] /;
const DAY_LINE_RE = /^--- \d{4}-\d\d-\d\d ---$/;

/**
 * Drops the `[HH:MM] ` of a message older than the last `keepRecent` ones,
 * unless it opens a day or the transcript, or follows a pause of at least
 * `pauseMinutes`. The day lines stay, so every message keeps its date. A time
 * earlier than the one before it (midnight without a day line) counts as a
 * pause. Lines that are not a message start (continuations, notes, a client's
 * own format) are left as they are.
 *
 * Reply bench 2026-10-22 (32 prod prompts, blind judge): 7.28 against 7.02
 * and 6.84 for two runs of the full transcript, about 300 fewer input tokens
 * per Reply.
 */
export function thinTranscriptTimes(transcript: string, keepRecent = 15, pauseMinutes = 60): string {
  const lines = transcript.split('\n');
  const starts = lines.flatMap((line, index) => (MESSAGE_TIME_RE.test(line) ? [index] : []));
  const recentFrom = starts.length > keepRecent ? starts[starts.length - keepRecent]! : 0;
  let previous: number | null = null;
  let dayOpen = false;
  return lines
    .map((line, index) => {
      if (DAY_LINE_RE.test(line)) {
        dayOpen = true;
        return line;
      }
      const match = MESSAGE_TIME_RE.exec(line);
      if (!match) {
        return line;
      }
      const minutes = Number(match[1]) * 60 + Number(match[2]);
      const pause = previous === null || minutes < previous || minutes - previous >= pauseMinutes;
      const keep = index >= recentFrom || dayOpen || pause;
      previous = minutes;
      dayOpen = false;
      return keep ? line : line.slice(match[0].length);
    })
    .join('\n');
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
