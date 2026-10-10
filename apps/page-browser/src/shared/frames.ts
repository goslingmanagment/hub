// Length-prefixed JSON messages over a local stream socket (the holder ↔
// operator link and the supervisor's control socket): 4-byte big-endian
// length, then UTF-8 JSON. The writer may pass pre-serialized JSON text so a
// CDP message is never parsed and re-serialized on its way through.

import type { Socket } from "node:net";

export function encodeMessage(json: string): Buffer {
  const body = Buffer.from(json, "utf8");
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

export class MessageReader {
  #chunks: Buffer[] = [];
  #len = 0;
  readonly maxMessage: number;

  constructor(maxMessage = 512 * 1024 * 1024) {
    this.maxMessage = maxMessage;
  }

  push(chunk: Buffer, onMessage: (json: string) => void): void {
    this.#chunks.push(chunk);
    this.#len += chunk.length;
    for (;;) {
      if (this.#len < 4) return;
      const head = this.#peek(4);
      const size = head.readUInt32BE(0);
      if (size > this.maxMessage) throw new Error(`message of ${size} bytes is over the limit`);
      if (this.#len < 4 + size) return;
      const whole = this.#take(4 + size);
      onMessage(whole.toString("utf8", 4));
    }
  }

  #peek(n: number): Buffer {
    if (this.#chunks[0]!.length >= n) return this.#chunks[0]!.subarray(0, n);
    const merged = Buffer.concat(this.#chunks, this.#len);
    this.#chunks = [merged];
    return merged.subarray(0, n);
  }

  #take(n: number): Buffer {
    const merged = this.#chunks.length === 1 ? this.#chunks[0]! : Buffer.concat(this.#chunks, this.#len);
    this.#chunks = merged.length > n ? [merged.subarray(n)] : [];
    this.#len -= n;
    return merged.subarray(0, n);
  }
}

/** Attach a reader to a socket; parse each message as JSON. */
export function readMessages(socket: Socket, onMessage: (value: unknown, json: string) => void, onError?: (error: Error) => void): void {
  const reader = new MessageReader();
  socket.on("data", (chunk: Buffer) => {
    try {
      reader.push(chunk, (json) => onMessage(JSON.parse(json), json));
    } catch (error) {
      onError?.(error as Error);
      socket.destroy();
    }
  });
}
