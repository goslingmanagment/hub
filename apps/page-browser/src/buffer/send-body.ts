// One stored body to the engine (plan §4.13): binary frames of up to 1 MiB
// through one open descriptor, the last one flagged — a body of 0 bytes is
// one empty last frame — waiting for the socket between them. A part that
// cannot be read abandons the parts sent before it (rpc/protocol.ts). The
// outcomes' delivery (replay.ts) and the event stream (stream.ts) both send
// bodies so, each before the JSON that names them.

import { BODY_PART_BYTES, encodeBodyAbandon, encodeBodyFrame } from "../rpc/protocol.ts";
import { errorMessage, type Logger } from "../shared/util.ts";
import type { BodyReader } from "./bodies.ts";

/** Where a body's frames go. */
export interface BodyLink {
  /** Changes with the connection: a body for an old one stops. */
  epoch: () => number;
  /** A binary frame; false: no engine connected. */
  sendBinary: (frame: Buffer) => boolean;
}

/** How a body went: sent whole; gone (the connection, before the end);
 *  missing (no file); unreadable (a part could not be read — abandoned). */
export type BodySent = "sent" | "gone" | "missing" | "unreadable";

/**
 * Send body `bodyId`: `open` opens it for this one transmission (null: not
 * there), `room` waits until the connection of `epoch` can take more and
 * says whether it is still that connection.
 */
export async function sendBody(bodyId: string, epoch: number, link: BodyLink, open: (bodyId: string) => BodyReader | null, room: (epoch: number) => Promise<boolean>, log: Logger): Promise<BodySent> {
  let reader: BodyReader | null;
  try {
    reader = open(bodyId);
  } catch (error) {
    log("body.unreadable", { bodyId, part: 0, error: errorMessage(error) });
    return "unreadable";
  }
  if (reader === null) return "missing";
  let part = 0;
  try {
    const parts = Math.max(1, Math.ceil(reader.size / BODY_PART_BYTES));
    for (; part < parts; part++) {
      if (!(await room(epoch))) return "gone";
      const data = reader.read(part, BODY_PART_BYTES);
      if (!link.sendBinary(encodeBodyFrame(bodyId, part, part === parts - 1, data))) return "gone";
    }
    return "sent";
  } catch (error) {
    log("body.unreadable", { bodyId, part, error: errorMessage(error) });
    if (part > 0 && link.epoch() === epoch) link.sendBinary(encodeBodyAbandon(bodyId, part));
    return "unreadable";
  } finally {
    reader.close();
  }
}
