import { constants } from "node:fs";
import { open } from "node:fs/promises";

export async function readPrivateFile(path: string, maxBytes: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) {
      throw new Error("invalid_private_input");
    }
    // Bound the read even if the file grows after stat.
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error("input_too_large");
    return buffer.subarray(0, offset);
  } finally { await file.close(); }
}
