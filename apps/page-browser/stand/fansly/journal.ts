// The stand's journal: everything that physically reached the stand's
// Fansly, in the order it came. It is the truth the criteria are judged by —
// the operator's own journals say what it meant to do, this says what
// arrived. Every event carries CLOCK_MONOTONIC (one kernel, so one clock for
// every container of the stand): the runner compares it with the moments of
// the admissions it gave.

import { mono } from "../shared.ts";

export { mono };

export interface JournalEvent {
  /** 1, 2, 3 … in the order of recording; never reused. */
  seq: number;
  mono: number;
  wall: number;
  type: string;
  [field: string]: unknown;
}

export interface JournalPage {
  events: JournalEvent[];
  /** Pass back as `since` for what follows. */
  next: number;
  /** The first number still kept: a reader that asked for an earlier one
   *  lost events (a run far longer than the journal). */
  firstKept: number;
}

export class Journal {
  #events: JournalEvent[] = [];
  #lastSeq = 0;
  readonly #max: number;

  constructor(max = 500_000) {
    this.#max = max;
  }

  log(type: string, fields: Record<string, unknown> = {}): JournalEvent {
    const event: JournalEvent = { ...fields, seq: ++this.#lastSeq, mono: mono(), wall: Date.now(), type };
    this.#events.push(event);
    if (this.#events.length > this.#max) this.#events.splice(0, Math.ceil(this.#max / 10));
    return event;
  }

  /** Events after number `since`, oldest first. */
  since(since: number, limit = 50_000): JournalPage {
    const first = this.#events[0]?.seq ?? this.#lastSeq + 1;
    const start = Math.max(0, Math.floor(since) - first + 1);
    const events = this.#events.slice(start, start + limit);
    return { events, next: events.at(-1)?.seq ?? Math.min(Math.max(0, since), this.#lastSeq), firstKept: first };
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }
}
