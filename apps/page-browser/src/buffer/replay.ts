// The outcomes sent again (spec §6.2): every outcome still waiting for its
// resultAck goes to each new connection of the engine, and `recover` (plan
// §3.2) resends the ones it names before its answer.
//
// The buffer may hold a great many of them (up to its cap of 2 GiB), so
// nothing here is read or queued whole:
// - outcomes are read a page at a time (by attempt id), and each is written
//   only while the connection's queue is under a small mark — above it the
//   replay waits for the socket to drain;
// - one replay per connection: a new hello ends the previous one (its
//   connection is gone) and starts afresh;
// - `recover`s waiting their turn are merged into one, answered by one
//   `recoverResult` that names every attempt asked about.
//
// What is in memory at any time: one page of outcomes, the attempt ids of
// at most two recovers, and the socket's queue up to its mark.

import { makeLog, sleep, type Logger } from "../shared/util.ts";
import type { EventBuffer } from "./buffer.ts";

/** The engine's connection, as the RPC server shows it. */
export interface ReplayLink {
  /** Changes with the connection: work for an old one stops. */
  epoch: () => number;
  /** False: no engine connected. */
  send: (json: string) => boolean;
  /** Bytes queued and not yet handed to the socket. */
  backlog: () => number;
  /** Settles once the queue drained, or the connection is gone. */
  drained: () => Promise<void>;
}

export interface ReplayOptions {
  /** The queue's mark: above it, the replay waits. */
  highWaterBytes?: number;
  pageCount?: number;
  pageBytes?: number;
  log?: Logger;
}

type Job = { kind: "all" } | { kind: "recover"; attemptIds: Set<number> };

export const REPLAY_HIGH_WATER = 256 * 1024;
/** A recover asks about at most 10 000 attempts (rpc/protocol.ts); merged
 *  ones are kept up to this many, the rest answered `unknown` at once. */
const MAX_MERGED = 50_000;
const RECOVER_CHUNK = 64;

export class OutcomeReplay {
  readonly #buffer: EventBuffer;
  readonly #link: ReplayLink;
  readonly #log: Logger;
  readonly #highWater: number;
  readonly #pageCount: number;
  readonly #pageBytes: number;
  /** The connection the queued jobs are for. */
  #epoch = -1;
  #jobs: Job[] = [];
  #running = false;

  constructor(buffer: EventBuffer, link: ReplayLink, options: ReplayOptions = {}) {
    this.#buffer = buffer;
    this.#link = link;
    this.#log = options.log ?? makeLog("replay");
    this.#highWater = options.highWaterBytes ?? REPLAY_HIGH_WATER;
    this.#pageCount = options.pageCount ?? 64;
    this.#pageBytes = options.pageBytes ?? 256 * 1024;
  }

  /** Jobs waiting (tests, diagnostics). */
  get queued(): number {
    return this.#jobs.length;
  }

  /** A new connection (or the buffer opened under one): every outcome
   *  waiting for its resultAck, once. Work for an earlier one ends. */
  connected(): void {
    this.#epoch = this.#link.epoch();
    this.#jobs = [{ kind: "all" }];
    this.#run();
  }

  /** The connection is gone: nothing more for it. */
  disconnected(): void {
    this.#epoch = -1;
    this.#jobs = [];
  }

  /** The engine's recover: the outcomes it names that the buffer has, then
   *  the answer. Merged with a recover still waiting its turn. */
  recover(attemptIds: readonly number[]): void {
    const epoch = this.#link.epoch();
    if (epoch !== this.#epoch) {
      this.#epoch = epoch;
      this.#jobs = [];
    }
    const waiting = this.#jobs.find((job) => job.kind === "recover");
    const into = waiting?.kind === "recover" ? waiting.attemptIds : new Set<number>();
    const overflow: number[] = [];
    for (const id of attemptIds) {
      if (into.has(id)) continue;
      if (into.size >= MAX_MERGED) overflow.push(id);
      else into.add(id);
    }
    if (!waiting) this.#jobs.push({ kind: "recover", attemptIds: into });
    if (overflow.length > 0) {
      // An engine that asks this much without waiting for answers: what is
      // past the mark is `unknown` — never wrong, only less helpful.
      this.#log("recover.overflow", { unknown: overflow.length });
      this.#link.send(JSON.stringify({ type: "recoverResult", attempts: overflow.map((attemptId) => ({ attemptId, state: "unknown" })) }));
    }
    this.#run();
  }

  #run(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#work().finally(() => {
      this.#running = false;
      if (this.#jobs.length > 0) this.#run();
    });
  }

  async #work(): Promise<void> {
    for (;;) {
      const job = this.#jobs.shift();
      if (!job) return;
      const epoch = this.#epoch;
      try {
        if (job.kind === "all") await this.#all(epoch);
        else await this.#recover([...job.attemptIds], epoch);
      } catch (error) {
        this.#log("replay.failed", { job: job.kind, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /** True once the connection's queue is under the mark; false when the
   *  connection is not this job's any more. */
  async #room(epoch: number): Promise<boolean> {
    while (this.#link.epoch() === epoch && this.#link.backlog() > this.#highWater) {
      await this.#link.drained();
      // A drain that came before the queue fell under the mark: a breath.
      if (this.#link.backlog() > this.#highWater) await sleep(5);
    }
    return this.#link.epoch() === epoch && this.#epoch === epoch;
  }

  async #all(epoch: number): Promise<void> {
    let after = 0;
    let sent = 0;
    for (;;) {
      if (!(await this.#room(epoch))) return;
      const page = this.#buffer.outcomePage(after, this.#pageCount, this.#pageBytes);
      if (page.length === 0) break;
      for (const outcome of page) {
        if (!(await this.#room(epoch))) return;
        if (!this.#link.send(outcome.json)) return;
        sent += 1;
      }
      after = page.at(-1)!.attemptId;
    }
    if (sent > 0) this.#log("outcomes.resent", { count: sent });
  }

  async #recover(attemptIds: number[], epoch: number): Promise<void> {
    // What a producer just put is in the file before it is looked for.
    await this.#buffer.flush();
    const resent = new Set<number>();
    for (let index = 0; index < attemptIds.length; index += RECOVER_CHUNK) {
      if (!(await this.#room(epoch))) return;
      for (const outcome of this.#buffer.outcomes(attemptIds.slice(index, index + RECOVER_CHUNK))) {
        if (!(await this.#room(epoch))) return;
        if (!this.#link.send(outcome.json)) return;
        resent.add(outcome.attemptId);
      }
    }
    if (!(await this.#room(epoch))) return;
    // Without an outcome the answer is `unknown`: `not_sent` needs what the
    // Hub requests know of their sends (PR 9), and a wrong `not_sent` would
    // let a sent request pass as unsent.
    this.#link.send(JSON.stringify({ type: "recoverResult", attempts: attemptIds.map((attemptId) => ({ attemptId, state: resent.has(attemptId) ? "outcome_resent" : "unknown" })) }));
    this.#log("recover", { asked: attemptIds.length, resent: resent.size });
  }
}
