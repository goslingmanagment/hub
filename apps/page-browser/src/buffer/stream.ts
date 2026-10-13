// The event stream to the engine (plan §4.4, step 4; spec §6.1):
//
//   engine → events.subscribe { bufferId, afterSeq }   the last number it acked
//   operator → events { bufferId, events }             ≤ 500 events or 1 MB, in order
//   engine → ack { bufferId, uptoSeq }                 committed in Postgres
//
// - Only durable events are sent, in the order of their numbers, from the
//   one after `afterSeq`. A reconnect subscribes again from the last ack:
//   what was sent and not acknowledged comes again (the engine keys events
//   by (buffer id, number), so a repeat is no duplicate).
// - The buffer id is in the subscription, in every batch and in every ack.
//   One that is not this buffer's is refused (`events.refused`, which names
//   this buffer's id): after the volume was made anew, a late ack of the old
//   buffer's number 5000 would otherwise acknowledge — and delete — events
//   the engine never had.
// - An ack covers only what this subscription sent; anything past that is
//   refused. The subscription's own `afterSeq` is the engine's word that it
//   has everything up to it: those events go.
// - The buffer keeps durably the highest number it ever sent (`sentMax`,
//   schema v4): before an event past it goes, the mark is raised over
//   everything stored (one write per advance). A subscription past the mark
//   is refused (`ahead`) as one past the last number is: the engine can only
//   have committed what was sent. A file restored from before keeps its old
//   mark, so however far its numbers grow, an old position never
//   acknowledges — deletes — its new events (PR 13, Astra's review).
// - At most a few batches are on their way unacknowledged: the engine's
//   commits pace the stream, and the rest waits in the buffer (a Hub deploy,
//   a database outage: the socket is not broken, plan §4.4, step 7).
//
// Bodies are not sent yet (buffer.ts): when they are, their binary parts go
// before the batch that names them, and count in its bytes.

import type { Ack, EventsRefused, EventsSubscribe } from "../rpc/protocol.ts";
import { makeLog, type Logger } from "../shared/util.ts";
import type { EventBuffer } from "./buffer.ts";

export interface StreamOptions {
  maxEvents?: number;
  maxBytes?: number;
  /** Batches sent and not yet acknowledged, at most. */
  inFlightBatches?: number;
  log?: Logger;
}

interface Subscription {
  /** The last number sent. */
  sentSeq: number;
  /** The last number the engine acknowledged. */
  ackedSeq: number;
  /** The last number of each batch on its way. */
  inFlight: number[];
}

export const STREAM_IN_FLIGHT = 4;

export class EventStream {
  readonly #buffer: EventBuffer;
  /** Sends one JSON message to the engine; false when no engine is linked. */
  readonly #send: (json: string) => boolean;
  readonly #log: Logger;
  readonly #inFlightBatches: number;
  #maxEvents: number;
  #maxBytes: number;
  #sub: Subscription | null = null;
  #pumping = false;

  constructor(buffer: EventBuffer, send: (json: string) => boolean, options: StreamOptions = {}) {
    this.#buffer = buffer;
    this.#send = send;
    this.#log = options.log ?? makeLog("stream");
    this.#maxEvents = options.maxEvents ?? 500;
    this.#maxBytes = options.maxBytes ?? 1024 * 1024;
    this.#inFlightBatches = options.inFlightBatches ?? STREAM_IN_FLIGHT;
  }

  /** The engine's batch size (plan §4.14), within sane bounds. */
  setBatch(maxEvents: number, maxBytes: number): void {
    this.#maxEvents = Math.min(10_000, Math.max(1, Math.floor(maxEvents)));
    this.#maxBytes = Math.min(64 * 1024 * 1024, Math.max(1024, Math.floor(maxBytes)));
  }

  get subscribed(): boolean {
    return this.#sub !== null;
  }

  /** Where the subscription stands (tests, diagnostics). */
  get position(): { sentSeq: number; ackedSeq: number; inFlight: number } | null {
    const sub = this.#sub;
    return sub ? { sentSeq: sub.sentSeq, ackedSeq: sub.ackedSeq, inFlight: sub.inFlight.length } : null;
  }

  /** The engine's connection changed (a new hello, a lost link): it
   *  subscribes again. */
  reset(): void {
    if (this.#sub) this.#log("stream.ended", { sentSeq: this.#sub.sentSeq, ackedSeq: this.#sub.ackedSeq });
    this.#sub = null;
  }

  /** Returns the refusal to send, or null: the stream runs. */
  subscribe(message: EventsSubscribe): EventsRefused | null {
    // A buffer that cannot be opened has nothing to say about its numbers:
    // the engine subscribes again once state no longer says so.
    if (this.#buffer.unavailable) return this.#refuse("events.subscribe", "unavailable", message.bufferId, message.afterSeq);
    if (message.bufferId !== this.#buffer.id) return this.#refuse("events.subscribe", "foreign_buffer", message.bufferId, message.afterSeq);
    // The engine has more than this buffer ever gave — numbered, or sent:
    // not this buffer's history (a restored file) — nothing of it is
    // acknowledged, however far its numbers grew since.
    if (message.afterSeq > this.#buffer.lastSeq || message.afterSeq > this.#buffer.sentMax) {
      return this.#refuse("events.subscribe", "ahead", message.bufferId, message.afterSeq);
    }
    this.#buffer.acknowledge(message.afterSeq);
    this.#sub = { sentSeq: message.afterSeq, ackedSeq: message.afterSeq, inFlight: [] };
    this.#log("stream.subscribed", { afterSeq: message.afterSeq, lastSeq: this.#buffer.lastSeq });
    this.pump();
    return null;
  }

  ack(message: Ack): EventsRefused | null {
    if (this.#buffer.unavailable) return this.#refuse("ack", "unavailable", message.bufferId, message.uptoSeq);
    if (message.bufferId !== this.#buffer.id) return this.#refuse("ack", "foreign_buffer", message.bufferId, message.uptoSeq);
    const sub = this.#sub;
    if (!sub) return this.#refuse("ack", "not_subscribed", message.bufferId, message.uptoSeq);
    if (message.uptoSeq > sub.sentSeq) return this.#refuse("ack", "beyond_sent", message.bufferId, message.uptoSeq);
    if (message.uptoSeq <= sub.ackedSeq) return null;
    sub.ackedSeq = message.uptoSeq;
    sub.inFlight = sub.inFlight.filter((last) => last > message.uptoSeq);
    this.#buffer.acknowledge(message.uptoSeq);
    this.pump();
    return null;
  }

  /** Sends what is durable and not sent, while the window allows. */
  pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (;;) {
        const sub = this.#sub;
        if (!sub || sub.inFlight.length >= this.#inFlightBatches) return;
        const envelope = `{"type":"events","bufferId":${JSON.stringify(this.#buffer.id)},"events":[`;
        const events = this.#buffer.readEvents(sub.sentSeq, this.#maxEvents, this.#maxBytes - envelope.length - 2);
        if (events.length === 0) return;
        // Nothing goes past the durable mark: it is raised first, over
        // everything stored now; not raised, nothing goes (tried again with
        // the next commit).
        if (events.at(-1)!.seq > this.#buffer.sentMax && !this.#buffer.raiseSentMax()) return;
        if (!this.#send(`${envelope}${events.map((event) => event.json).join(",")}]}`)) {
          this.reset();
          return;
        }
        sub.sentSeq = events.at(-1)!.seq;
        sub.inFlight.push(sub.sentSeq);
      }
    } finally {
      this.#pumping = false;
    }
  }

  #refuse(of: EventsRefused["of"], reason: EventsRefused["reason"], givenBufferId: string, givenSeq: number): EventsRefused {
    this.#log("stream.refused", { of, reason, givenBufferId, givenSeq, bufferId: this.#buffer.id, lastSeq: this.#buffer.lastSeq });
    return { type: "events.refused", of, reason, bufferId: this.#buffer.id, givenBufferId, givenSeq };
  }
}
