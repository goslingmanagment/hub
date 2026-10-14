// The outcomes to the engine (spec §6.2): every outcome still waiting for
// its resultAck goes to each new connection of the engine, outcomes stored
// meanwhile follow, and `recover` (plan §3.2) resends the ones it names
// before its answer. Every outcome — new or again — leaves the same way:
// the body it names first, in binary frames of up to 1 MiB (plan §4.13),
// then its JSON.
//
// The buffer may hold a great many of them (up to its cap of 2 GiB), so
// nothing here is read or queued whole:
// - Delivery follows the file, not a queue in memory: outcomes are read in
//   the order they were stored (their `seq`, store.ts), a page at a time,
//   from a cursor this connection keeps. A round goes up to the last
//   outcome stored when it began — a fixed bound, however fast new ones
//   come — and ends; outcomes stored since (`live`) ask for one more round,
//   queued once behind whatever waits (a recover is never starved). At
//   most one round and one recover wait at any time.
// - Each outcome is written only while the connection's queue is under a
//   small mark — above it the replay waits for the socket to drain.
// - One replay per connection: a new hello ends the previous one (its
//   connection is gone) and starts afresh from the first outcome.
// - `recover`s waiting their turn are merged into one, answered by one
//   `recoverResult` that names every attempt asked about. An attempt asked
//   about again while its answer is still to come — waiting, or being
//   answered now — adds nothing. The attempts waiting for an answer are
//   capped; an engine that asks about more without waiting for answers
//   breaks the protocol, and its connection is closed.
// - A recover is always answered while its connection lasts, whatever
//   fails on the way. `outcome_resent` only of an outcome sent whole, body
//   and JSON, before the answer; for the rest, what the Hub requests know
//   (`stateOf`): `not_sent` of a request that never left, `unknown`
//   otherwise (hub-requests/).
// - A body is read through one open descriptor for its whole transmission
//   (bodies.ts): a resultAck of an earlier delivery that deletes its file
//   meanwhile does not tear it. A body that is gone before it is opened
//   belongs to an outcome acknowledged meanwhile (nothing to send), or was
//   lost (a failing disk): its outcome then goes as a transport error,
//   which the engine acknowledges. A part that cannot be read abandons the
//   body (a frame that voids the parts sent of it, rpc/protocol.ts); its
//   outcome stays for the next delivery, and the others go on.
//
// What is in memory at any time: one page of outcomes, at most twice the
// cap of attempt ids, one part of a body, and the socket's queue up to its
// mark.

import { errorMessage, makeLog, sleep, type Logger } from "../shared/util.ts";
import type { EventBuffer } from "./buffer.ts";
import { sendBody } from "./send-body.ts";

/** The engine's connection, as the RPC server shows it. */
export interface ReplayLink {
  /** Changes with the connection: work for an old one stops. */
  epoch: () => number;
  /** False: no engine connected. */
  send: (json: string) => boolean;
  /** A body's binary frame; false: no engine connected. */
  sendBinary?: (frame: Buffer) => boolean;
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
  /** What is known of an attempt without an outcome (hub-requests/). */
  stateOf?: (attemptId: number) => "not_sent" | "unknown";
  log?: Logger;
}

type Job = { kind: "deliver" } | { kind: "recover"; attemptIds: Set<number> };

/** How one outcome went: sent whole; sent as a transport error (its body
 *  lost); skipped (acknowledged meanwhile); held back (its body could not
 *  be read — it stays for the next delivery); or the connection is gone. */
type Sent = "sent" | "substituted" | "skipped" | "held" | "gone";

export const REPLAY_HIGH_WATER = 256 * 1024;
/** A recover asks about at most 10 000 attempts (rpc/protocol.ts): two of
 *  them may wait for their answer while one is being answered. */
export const MAX_WAITING = 20_000;
const RECOVER_CHUNK = 64;

export class OutcomeReplay {
  readonly #buffer: EventBuffer;
  readonly #link: ReplayLink;
  readonly #log: Logger;
  readonly #highWater: number;
  readonly #pageCount: number;
  readonly #pageBytes: number;
  readonly #stateOf: (attemptId: number) => "not_sent" | "unknown";
  /** The connection the queued jobs are for. */
  #epoch = -1;
  /** The last outcome (seq) delivered to this connection. */
  #cursor = 0;
  #jobs: Job[] = [];
  #running = false;
  /** The attempts the running recover answers, and its connection. */
  #answering: { epoch: number; attemptIds: Set<number> } | null = null;

  constructor(buffer: EventBuffer, link: ReplayLink, options: ReplayOptions = {}) {
    this.#buffer = buffer;
    this.#link = link;
    this.#log = options.log ?? makeLog("replay");
    this.#highWater = options.highWaterBytes ?? REPLAY_HIGH_WATER;
    this.#pageCount = options.pageCount ?? 64;
    this.#pageBytes = options.pageBytes ?? 256 * 1024;
    this.#stateOf = options.stateOf ?? (() => "unknown");
  }

  /** Jobs waiting (tests, diagnostics): never more than two. */
  get queued(): number {
    return this.#jobs.length;
  }

  /** A new connection (or the buffer opened under one): every outcome
   *  waiting for its resultAck, from the first. Work for an earlier one
   *  ends. */
  connected(): void {
    this.#epoch = this.#link.epoch();
    this.#cursor = 0;
    this.#jobs = [{ kind: "deliver" }];
    this.#run();
  }

  /** Outcomes were stored: one more delivery round for this connection (one
   *  waits at most). Without a connection they wait for the next. What was
   *  stored is read from the file: `_stored` is not kept. */
  live(_stored?: readonly unknown[]): void {
    if (this.#epoch === -1 || this.#epoch !== this.#link.epoch()) return;
    this.#deliverAgain();
  }

  /** The connection is gone: nothing more for it. */
  disconnected(): void {
    this.#epoch = -1;
    this.#jobs = [];
  }

  /** The engine's recover: the outcomes it names that the buffer has, then
   *  the answer. Merged with a recover still waiting its turn; attempts
   *  whose answer is still to come add nothing. False: more would wait for
   *  an answer than the cap — the caller closes the connection. */
  recover(attemptIds: readonly number[]): boolean {
    const epoch = this.#link.epoch();
    if (epoch !== this.#epoch) {
      this.#epoch = epoch;
      this.#cursor = 0;
      this.#jobs = [];
    }
    const waiting = this.#jobs.find((job) => job.kind === "recover");
    const into = waiting?.kind === "recover" ? waiting.attemptIds : new Set<number>();
    const answering = this.#answering?.epoch === epoch ? this.#answering.attemptIds : null;
    const fresh = new Set(attemptIds.filter((id) => !into.has(id) && !answering?.has(id)));
    if (into.size + fresh.size > MAX_WAITING) {
      this.#log("recover.refused", { waiting: into.size, asked: fresh.size, cap: MAX_WAITING });
      return false;
    }
    for (const id of fresh) into.add(id);
    // A recover of nothing still gets its (empty) answer.
    if (!waiting && (into.size > 0 || attemptIds.length === 0)) this.#jobs.push({ kind: "recover", attemptIds: into });
    this.#run();
    return true;
  }

  #deliverAgain(): void {
    if (!this.#jobs.some((job) => job.kind === "deliver")) this.#jobs.push({ kind: "deliver" });
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
        if (job.kind === "deliver") await this.#deliver(epoch);
        else {
          this.#answering = { epoch, attemptIds: job.attemptIds };
          await this.#recover([...job.attemptIds], epoch);
        }
      } catch (error) {
        // Not expected (each step handles its own failures); the next job
        // goes on.
        this.#log("replay.failed", { job: job.kind, error: errorMessage(error) });
      } finally {
        this.#answering = null;
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

  /** One round: the outcomes stored after the cursor, up to the last one
   *  stored when the round began. */
  async #deliver(epoch: number): Promise<void> {
    const bound = this.#buffer.lastOutcomeSeq;
    let sent = 0;
    for (;;) {
      if (!(await this.#room(epoch))) return;
      const page = this.#buffer.outcomesBySeq(this.#cursor, bound, this.#pageCount, this.#pageBytes);
      if (page.length === 0) break;
      for (const outcome of page) {
        if ((await this.#send(outcome, epoch)) === "gone") return;
        this.#cursor = outcome.seq;
        sent += 1;
      }
    }
    // Up to the bound, everything is handled: what is not in the file any
    // more was acknowledged meanwhile.
    this.#cursor = Math.max(this.#cursor, bound);
    if (sent > 0) this.#log("outcomes.delivered", { count: sent, upto: this.#cursor });
    // Stored during the round: the next one, behind what waits.
    if (this.#buffer.lastOutcomeSeq > this.#cursor && this.#epoch === epoch) this.#deliverAgain();
  }

  async #recover(attemptIds: number[], epoch: number): Promise<void> {
    const resent = new Set<number>();
    try {
      // What a producer just put is in the file before it is looked for.
      await this.#buffer.flush();
      for (let index = 0; index < attemptIds.length; index += RECOVER_CHUNK) {
        if (!(await this.#room(epoch))) return;
        for (const outcome of this.#buffer.outcomes(attemptIds.slice(index, index + RECOVER_CHUNK))) {
          const sent = await this.#send(outcome, epoch);
          if (sent === "gone") return;
          if (sent === "sent") resent.add(outcome.attemptId);
        }
      }
    } catch (error) {
      // Answered all the same, with what was sent whole.
      this.#log("recover.failed", { error: errorMessage(error) });
    }
    // The connection gone: nobody to answer — the engine asks its new one.
    if (!(await this.#room(epoch))) return;
    const attempts = attemptIds.map((attemptId) => ({ attemptId, state: resent.has(attemptId) ? "outcome_resent" : this.#known(attemptId) }));
    this.#link.send(JSON.stringify({ type: "recoverResult", attempts }));
    this.#log("recover", { asked: attemptIds.length, resent: resent.size, notSent: attempts.filter((attempt) => attempt.state === "not_sent").length });
  }

  /** What the Hub requests know of an attempt not resent; `unknown` when
   *  even that cannot be read. */
  #known(attemptId: number): "not_sent" | "unknown" {
    try {
      return this.#stateOf(attemptId);
    } catch {
      return "unknown";
    }
  }

  /** One outcome: its body's frames, then its JSON. */
  async #send(outcome: { attemptId: number; json: string; bodyId: string | null }, epoch: number): Promise<Sent> {
    let json = outcome.json;
    let substituted = false;
    if (outcome.bodyId !== null) {
      const body = await this.#sendBody(outcome.bodyId, epoch);
      if (body === "gone") return "gone";
      if (body === "unreadable") return "held";
      if (body === "missing") {
        // Acknowledged meanwhile (its file went with the ack): nothing to send.
        if (this.#buffer.outcomes([outcome.attemptId]).length === 0) return "skipped";
        this.#log("body.missing", { attemptId: outcome.attemptId });
        json = lostBody(json);
        substituted = true;
      }
    }
    if (!(await this.#room(epoch))) return "gone";
    if (!this.#link.send(json)) return "gone";
    return substituted ? "substituted" : "sent";
  }

  /** A body in frames of up to 1 MiB through one open descriptor, the last
   *  one flagged (a body of 0 bytes is one empty last frame), waiting for
   *  the socket between them. A part that cannot be read abandons the parts
   *  sent before it (send-body.ts). */
  #sendBody(bodyId: string, epoch: number): Promise<"sent" | "gone" | "missing" | "unreadable"> {
    const sendBinary = this.#link.sendBinary ?? (() => false);
    return sendBody(bodyId, epoch, { epoch: () => this.#link.epoch(), sendBinary }, (id) => this.#buffer.openBody(id), (at) => this.#room(at), this.#log);
  }
}

/** A result whose body is lost, as the engine can still take it. */
function lostBody(json: string): string {
  try {
    const result = JSON.parse(json) as { attemptId: number; sessionFingerprint: string; outcome?: { kind?: string } };
    return JSON.stringify({
      type: "result",
      attemptId: result.attemptId,
      sessionFingerprint: result.sessionFingerprint,
      outcome: { kind: "transport_error", sent: true, message: "the operator lost the response's body" },
    });
  } catch {
    return json;
  }
}
