// The stand journal: an append-only, in-memory list of everything that
// physically reached the stand's sockets. Test scenarios read it through the
// control API (`GET /journal?since=`) and compare it with the operator's
// admission journal, so every event carries a CLOCK_MONOTONIC timestamp that is
// comparable across the containers of one Docker VM (they share one kernel).

/** Milliseconds (float) on CLOCK_MONOTONIC — the clock shared by all containers. */
export function mono(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

/** One journal entry. `type`-specific fields are listed in README.md. */
export interface JournalEvent {
  /** 1, 2, 3, … in the order events were recorded; never reused, not reset by clear. */
  seq: number;
  /** `mono()` at the moment the event happened. */
  mono: number;
  /** Wall clock (ISO 8601) for humans; do not compare across containers. */
  wall: string;
  type: string;
  [field: string]: unknown;
}

export interface JournalPage {
  events: JournalEvent[];
  /** Pass back as `since` to get the following events. */
  next: number;
}

export interface JournalOptions {
  /** Keep at most this many events; the oldest tenth is dropped on overflow. */
  maxEvents: number;
  /** Also print every event as one JSON line on stdout (`docker logs`). */
  echo: boolean;
}

export class Journal {
  #events: JournalEvent[] = [];
  #lastSeq = 0;
  #maxEvents: number;
  #echo: boolean;

  constructor(options: JournalOptions) {
    this.#maxEvents = options.maxEvents;
    this.#echo = options.echo;
  }

  /** Record an event now. Field order in the output: seq, mono, wall, type, fields. */
  log(type: string, fields: Record<string, unknown> = {}): JournalEvent {
    // Base keys first in the output, and assigned last so no field can override them.
    const event: JournalEvent = { seq: 0, mono: 0, wall: "", type, ...fields };
    event.seq = ++this.#lastSeq;
    event.mono = mono();
    event.wall = new Date().toISOString();
    event.type = type;
    this.#events.push(event);
    if (this.#events.length > this.#maxEvents) {
      // A safety net against unbounded growth in long soak runs. A reader can
      // spot the gap: the first returned seq is larger than its `since` + 1.
      this.#events.splice(0, Math.ceil(this.#maxEvents / 10));
    }
    if (this.#echo) process.stdout.write(JSON.stringify(event) + "\n");
    return event;
  }

  /** Events with seq > since, oldest first; `limit` caps the page size. */
  since(since: number, limit = Infinity): JournalPage {
    const events = this.#events;
    // Seqs are contiguous inside the array, so the start index is arithmetic.
    const firstSeq = events.length > 0 ? events[0]!.seq : this.#lastSeq + 1;
    const start = Math.max(0, Math.floor(since) - firstSeq + 1);
    const page = events.slice(start, start + Math.max(0, limit));
    const next = page.length > 0 ? page[page.length - 1]!.seq : Math.min(Math.max(0, since), this.#lastSeq);
    return { events: page, next };
  }

  /** Forget all events. Seq keeps counting, so readers' cursors stay valid. */
  clear(): void {
    this.#events = [];
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }
}
