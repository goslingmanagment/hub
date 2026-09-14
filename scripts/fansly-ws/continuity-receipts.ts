import { writeSync } from "node:fs";

const FINAL_RECORD_RESERVE = 16 * 1024;

/** Inside Docker fd 1 is a pipe, not the launcher's regular file. The host owns
 * fsync after attach shutdown; never try to fsync this descriptor. */
export function writeContinuityLine(line: string) {
  const buffer = Buffer.from(line);
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(1, buffer, offset);
    if (written === 0) throw new Error("observation_write_stalled");
    offset += written;
  }
}

/** Stream metadata to the caller's private file. Never buffer a six-hour corpus.
 * Reserve room for the final status even when a frame fills the ordinary budget. */
export function createContinuityReceipts(
  writeLine: (line: string) => void,
  limits: { records: number; bytes: number },
) {
  let records = 0;
  let bytes = 0;
  let finished = false;
  const startedMs = performance.now();

  function write(record: Record<string, unknown>, terminal = false) {
    if (finished) throw new Error("observation_already_finished");
    const line = JSON.stringify({
      ...record, ordinal: records + 1, recordedAt: new Date().toISOString(),
      elapsedMs: performance.now() - startedMs,
    }) + "\n";
    const size = Buffer.byteLength(line);
    const reserve = terminal ? 0 : FINAL_RECORD_RESERVE;
    if (records + 1 > limits.records - (terminal ? 0 : 1)
      || bytes + size > limits.bytes - reserve) {
      throw new Error("observation_output_limit");
    }
    writeLine(line);
    records++;
    bytes += size;
    finished = terminal;
  }

  return { write, counts: () => ({ records, bytes }) };
}
