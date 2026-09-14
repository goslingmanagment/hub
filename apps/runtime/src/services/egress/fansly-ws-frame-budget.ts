import { FANSLY_WS_MAX_FRAME_BYTES } from "@agency_hub_core/shared";

/** A bounded header scanner, not a protocol decoder. Stops before Undici can
 * buffer oversized/never-ending fragmented messages. No compression accepted. */
export function createFanslyWsFrameBudget() {
  const header = Buffer.alloc(10);
  let headerBytes = 0;
  let headerSize = 2;
  let remaining = 0;
  let messageBytes = 0;
  let fragments = 0;
  let endMessage = false;
  let refused = false;
  return (chunk: Buffer): boolean => {
    if (refused) return false;
    let offset = 0;
    while (offset < chunk.length) {
      if (remaining > 0) {
        const consumed = Math.min(remaining, chunk.length - offset);
        remaining -= consumed; offset += consumed;
        if (remaining > 0) continue;
        if (endMessage) { messageBytes = 0; fragments = 0; }
      }
      if (offset === chunk.length) break;
      const take = Math.min(headerSize - headerBytes, chunk.length - offset);
      chunk.copy(header, headerBytes, offset, offset + take);
      headerBytes += take; offset += take;
      if (headerBytes < headerSize) continue;
      if (headerSize === 2) {
        if ((header[0]! & 0x70) || (header[1]! & 0x80)) { refused = true; return false; }
        const length = header[1]! & 0x7f;
        headerSize = length === 126 ? 4 : length === 127 ? 10 : 2;
        if (headerBytes < headerSize) continue;
      }
      const bytes = headerSize === 10 ? header.readBigUInt64BE(2)
        : BigInt(headerSize === 4 ? header.readUInt16BE(2) : header[1]! & 0x7f);
      const data = (header[0]! & 0x08) === 0;
      endMessage = data && (header[0]! & 0x80) !== 0;
      if (data) { messageBytes += Number(bytes); fragments++; }
      if (bytes > BigInt(FANSLY_WS_MAX_FRAME_BYTES) || messageBytes > FANSLY_WS_MAX_FRAME_BYTES
        || fragments > 4096 || (!data && bytes > 125n)) {
        refused = true; return false;
      }
      remaining = Number(bytes);
      headerBytes = 0; headerSize = 2;
      if (remaining === 0 && endMessage) { messageBytes = 0; fragments = 0; }
    }
    return true;
  };
}
