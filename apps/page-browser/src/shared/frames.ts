// Length-prefixed JSON messages over a local stream socket (the holder ↔
// operator link): a 4-byte big-endian length, then UTF-8 JSON. A writer may
// hand over pre-serialized JSON, so a CDP message is never parsed and
// re-serialized on its way through the holder.

import type { Duplex } from "node:stream";

export function encodeMessage(json: string | Buffer): Buffer {
  const body = typeof json === "string" ? Buffer.from(json, "utf8") : json;
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

/** Several buffers as one message, without joining them first. */
export function encodeParts(parts: Buffer[]): Buffer {
  let length = 0;
  for (const part of parts) length += part.length;
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(length, 0);
  return Buffer.concat([head, ...parts], 4 + length);
}

export class MessageReader {
  #chunks: Buffer[] = [];
  #length = 0;
  readonly maxMessage: number;

  constructor(maxMessage = 512 * 1024 * 1024) {
    this.maxMessage = maxMessage;
  }

  push(chunk: Buffer, onMessage: (json: string) => void): void {
    this.#chunks.push(chunk);
    this.#length += chunk.length;
    for (;;) {
      if (this.#length < 4) return;
      const size = this.#peek(4).readUInt32BE(0);
      if (size > this.maxMessage) throw new Error(`message of ${size} bytes is over the limit`);
      if (this.#length < 4 + size) return;
      onMessage(this.#take(4 + size).toString("utf8", 4));
    }
  }

  #peek(n: number): Buffer {
    const first = this.#chunks[0]!;
    if (first.length >= n) return first.subarray(0, n);
    const merged = Buffer.concat(this.#chunks, this.#length);
    this.#chunks = [merged];
    return merged.subarray(0, n);
  }

  #take(n: number): Buffer {
    const merged = this.#chunks.length === 1 ? this.#chunks[0]! : Buffer.concat(this.#chunks, this.#length);
    this.#chunks = merged.length > n ? [merged.subarray(n)] : [];
    this.#length -= n;
    return merged.subarray(0, n);
  }
}

/** Read messages off a stream; each is parsed as JSON. A malformed stream
 *  is destroyed; what the handler throws is the handler's own business. */
export function readMessages(stream: Duplex, onMessage: (value: unknown) => void, onError?: (error: Error) => void): void {
  const reader = new MessageReader();
  stream.on("data", (chunk: Buffer) => {
    const values: unknown[] = [];
    try {
      reader.push(chunk, (json) => values.push(JSON.parse(json)));
    } catch (error) {
      onError?.(error as Error);
      stream.destroy();
      return;
    }
    for (const value of values) onMessage(value);
  });
}
