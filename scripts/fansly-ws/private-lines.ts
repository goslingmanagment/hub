import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Bounded regular-file input; preserve the exact bytes for the evidence hash. */
export async function* readPrivateLines(path: string, maxBytes: number, maxLineBytes: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) {
      throw new Error("invalid_private_input");
    }
    const chunk = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0);
    let bytes = 0;
    while (true) {
      const read = await file.read(chunk, 0, chunk.length, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > maxBytes) throw new Error("input_too_large");
      pending = Buffer.concat([pending, chunk.subarray(0, read.bytesRead)]);
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        if (newline + 1 > maxLineBytes) throw new Error("observation_line_limit");
        yield pending.subarray(0, newline + 1);
        pending = pending.subarray(newline + 1);
      }
      if (pending.length >= maxLineBytes) throw new Error("observation_line_limit");
    }
    if (pending.length > 0) throw new Error("incomplete_observation_line");
  } finally { await file.close(); }
}
