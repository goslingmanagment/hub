// A producer the buffer test kills mid-write (Project Browser plan §4.4; PR
// 11): it opens the buffer in argv[2] and appends `ws.in` frames without
// pause, numbered from the buffer's next number, 64 in flight; every
// confirmed one is printed `ok <seq>` once its batch is durable. Run by
// plain Node (type stripping), as the operator runs in the image.

import { join } from "node:path";

import { EventBuffer } from "../../apps/page-browser/src/buffer/buffer.ts";

const dir = process.argv[2];
const pad = Number(process.argv[3] ?? "0");
if (!dir) throw new Error("usage: page-browser-buffer-child.ts <dir> [pad]");

const buffer = new EventBuffer({ dir: join(dir, "store"), idFile: join(dir, "buffer-id"), batchMs: 5, minFreeBytes: 0, log: () => undefined });
let next = buffer.lastSeq;
let inFlight = 0;

/** The frame of number `n`: what the test expects to find under it. */
function frame(n: number): string {
  return `frame ${n} ${"x".repeat(pad)}`;
}

function more(): void {
  while (inFlight < 64) {
    next += 1;
    inFlight += 1;
    const appended = buffer.append({ kind: "ws.in", connectionId: "conn-crash", frame: frame(next) });
    if (!appended.ok) {
      process.stdout.write(`refused ${appended.reason}\n`);
      process.exit(3);
    }
    void appended.durable.then((durable) => {
      inFlight -= 1;
      if (!durable.ok) {
        process.stdout.write(`failed ${durable.reason}\n`);
        process.exit(4);
      }
      process.stdout.write(`ok ${durable.seq}\n`);
      more();
    });
  }
}

process.stdout.write(`open ${buffer.id} ${buffer.lastSeq}\n`);
more();
