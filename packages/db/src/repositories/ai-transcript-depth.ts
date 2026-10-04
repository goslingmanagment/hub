// chat-extension H-6: how deep the two AI transcript readers may read.
//
// Both readers (the archive reader in message-archive.ts and the union reader
// in ai-transcript-union.ts) clamp a requested window to a row cap of their
// own, 1500. One caller reads deeper: the full Recap, which passes `maxRows`.
// Every other caller passes nothing and keeps the cap it always had.

/** The deepest window either AI transcript reader serves, whoever asks. */
export const AI_TRANSCRIPT_DEEP_MAX_ROWS = 3000;

/**
 * The row cap of one read: the reader's own cap, unless the caller raised it.
 *
 * `maxRows` only ever raises the cap, and never past
 * `AI_TRANSCRIPT_DEEP_MAX_ROWS`. A value below the reader's cap, or one that is
 * not a whole number, leaves the reader's cap in place: a caller that wants
 * fewer rows asks for a smaller `limit`.
 */
export function aiTranscriptRowCap(maxRows: number | undefined, readerCap: number): number {
  if (maxRows === undefined || !Number.isInteger(maxRows) || maxRows <= readerCap) {
    return readerCap;
  }
  return Math.min(maxRows, AI_TRANSCRIPT_DEEP_MAX_ROWS);
}
