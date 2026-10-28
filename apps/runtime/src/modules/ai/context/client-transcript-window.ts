// The owner's live chat window on a transcript the client sent (chat-extension
// Telegram spec §4.3). The archive lane reads at most `aiFeatureWindows[feature]`
// latest messages (feature-settings.ts); a Telegram request sends everything
// Telegram Web rendered (up to ~120 messages), so the hub cuts that text to
// the same window here: the last N message lines with the day line each one
// stands under, the rest of the text kept as it came.
//
// The text is the extension's (Telegram's `transcript` in clientContext):
//   (translated by Telegram)          header lines, before any message: kept
//   --- Today ---                     a day line
//   [14:02] Fan: hi                   a message starts
//   and a second line of it           continuation of the message above
//   --- newer messages are not loaded ---   a trailer after the last message: kept
// A text with no message line (`No conversation history.`) is left alone.

const MESSAGE_START = /^\[\d{1,2}:\d{2}\] (?:Fan|Model):/;
const DAY_LINE = /^--- .+ ---$/;

export interface ClientTranscriptWindowCut {
  /** The messages the text held. */
  before: number;
  /** The messages kept: the window. */
  after: number;
}

export interface ClientTranscriptWindow {
  transcript: string;
  /** The messages the returned text holds. */
  messageCount: number;
  /** Null when nothing was cut. */
  cut: ClientTranscriptWindowCut | null;
}

/** Keeps the last `maxMessages` messages of a client's transcript text. */
export function cutClientTranscriptWindow(transcript: string, maxMessages: number): ClientTranscriptWindow {
  const lines = transcript.split("\n");
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (MESSAGE_START.test(line)) starts.push(index);
  });
  if (starts.length <= maxMessages) {
    return { transcript, messageCount: starts.length, cut: null };
  }
  const firstMessage = starts[0]!;
  const firstKept = starts[starts.length - maxMessages]!;
  // The header: what came before the first message, but its day lines (the
  // kept messages' own day line is found below).
  const header = lines.slice(0, firstMessage).filter((line) => !DAY_LINE.test(line));
  // The day line the first kept message stands under, if it falls in the cut.
  let dayLine: string | undefined;
  for (let index = firstKept - 1; index >= 0; index -= 1) {
    if (DAY_LINE.test(lines[index]!)) {
      dayLine = lines[index]!;
      break;
    }
  }
  const kept = lines.slice(firstKept);
  return {
    transcript: [...header, ...(dayLine !== undefined ? [dayLine] : []), ...kept].join("\n"),
    messageCount: maxMessages,
    cut: { before: starts.length, after: maxMessages },
  };
}
