// chat-extension H-6, R20 HF-6: how deep the two AI transcript readers may read.
//
// Both readers (the archive reader in message-archive.ts and the union reader
// in ai-transcript-union.ts) clamp a requested window to a row cap of their
// own, 1500. Two callers read deeper, the full Recap and the notes fill, and
// they pass `maxRows`; so does the Fansly live overlay union for them. Every
// other caller passes nothing and keeps the cap it always had.

/** The deepest window either AI transcript reader serves, whoever asks. */
export const AI_TRANSCRIPT_DEEP_MAX_ROWS = 5000;

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
