// The outcomes sent again (spec §6.2): every outcome still waiting for its
// resultAck goes to each new connection of the engine, and `recover` (plan
// §3.2) resends the ones it names before its answer. Outcomes just stored
// (`live`) go through the same queue, so every outcome — new or again —
// leaves the same way: the body it names first, in binary frames of up to
// 1 MiB (plan §4.13), then its JSON.
//
// The buffer may hold a great many of them (up to its cap of 2 GiB), so
// nothing here is read or queued whole:
// - outcomes are read a page at a time (by attempt id), and each is written
//   only while the connection's queue is under a small mark — above it the
//   replay waits for the socket to drain;
// - one replay per connection: a new hello ends the previous one (its
//   connection is gone) and starts afresh;
// - `recover`s waiting their turn are merged into one, answered by one
//   `recoverResult` that names every attempt asked about. An attempt asked
//   about again while its answer is still to come — waiting, or being
//   answered now — adds nothing. Everything, answers included, goes out
//   through the same wait for the socket.
// - The attempts waiting for an answer are capped; an engine that asks
//   about more without waiting for answers breaks the protocol, and its
//   connection is closed (it connects again, and the replay starts afresh).
// - An attempt without an outcome is answered by what the Hub requests know
//   of it (`stateOf`): `not_sent` for a request that never left, `unknown`
//   otherwise (hub-requests/).
// - A body whose file is gone (a failing disk) cannot be sent: its outcome
//   goes as a transport error instead — the engine acknowledges that, and
//   the stored outcome goes with the acknowledgement.
//
// What is in memory at any time: one page of outcomes, at most twice the
// cap of attempt ids, one part of a body, and the socket's queue up to its
// mark.

import { BODY_PART_BYTES, encodeBodyFrame } from "../rpc/protocol.ts";
import { makeLog, sleep, type Logger } from "../shared/util.ts";
import type { CommittedOutcome, EventBuffer } from "./buffer.ts";

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

type Job = { kind: "all" } | { kind: "recover"; attemptIds: Set<number> } | { kind: "live"; outcomes: CommittedOutcome[] };

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

  /** Outcomes just stored: sent in turn, for this connection. Without one
   *  they wait for the next (`connected` sends everything stored). */
  live(outcomes: readonly CommittedOutcome[]): void {
    if (outcomes.length === 0 || this.#epoch === -1 || this.#epoch !== this.#link.epoch()) return;
    this.#jobs.push({ kind: "live", outcomes: [...outcomes] });
    this.#run();
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
        else if (job.kind === "live") {
          for (const outcome of job.outcomes) if (!(await this.#send(outcome, epoch))) break;
        } else {
          this.#answering = { epoch, attemptIds: job.attemptIds };
          await this.#recover([...job.attemptIds], epoch);
        }
      } catch (error) {
        this.#log("replay.failed", { job: job.kind, error: error instanceof Error ? error.message : String(error) });
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

  async #all(epoch: number): Promise<void> {
    let after = 0;
    let sent = 0;
    for (;;) {
      if (!(await this.#room(epoch))) return;
      const page = this.#buffer.outcomePage(after, this.#pageCount, this.#pageBytes);
      if (page.length === 0) break;
      for (const outcome of page) {
        if (!(await this.#send(outcome, epoch))) return;
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
        if (!(await this.#send(outcome, epoch))) return;
        resent.add(outcome.attemptId);
      }
    }
    if (!(await this.#room(epoch))) return;
    // Without an outcome, what the Hub requests know: `not_sent` only of a
    // request that never left (a wrong one would let a sent request pass as
    // unsent), `unknown` otherwise.
    const attempts = attemptIds.map((attemptId) => ({ attemptId, state: resent.has(attemptId) ? "outcome_resent" : this.#stateOf(attemptId) }));
    this.#link.send(JSON.stringify({ type: "recoverResult", attempts }));
    this.#log("recover", { asked: attemptIds.length, resent: resent.size, notSent: attempts.filter((attempt) => attempt.state === "not_sent").length });
  }

  /** One outcome: its body's frames, then its JSON. False: the connection
   *  is not this job's any more. */
  async #send(outcome: { attemptId: number; json: string; bodyId: string | null }, epoch: number): Promise<boolean> {
    let json = outcome.json;
    if (outcome.bodyId !== null) {
      const body = await this.#sendBody(outcome.bodyId, epoch);
      if (body === "gone") return false;
      if (body === "missing") {
        // Acknowledged meanwhile (its file went with the ack): nothing to send.
        if (this.#buffer.outcomes([outcome.attemptId]).length === 0) return true;
        this.#log("body.missing", { attemptId: outcome.attemptId });
        json = lostBody(json);
      }
    }
    if (!(await this.#room(epoch))) return false;
    return this.#link.send(json);
  }

  /** A body in frames of up to 1 MiB, the last one flagged (a body of 0
   *  bytes is one empty last frame), waiting for the socket between them. */
  async #sendBody(bodyId: string, epoch: number): Promise<"sent" | "gone" | "missing"> {
    const size = this.#buffer.bodySize(bodyId);
    if (size === null) return "missing";
    const parts = Math.max(1, Math.ceil(size / BODY_PART_BYTES));
    const sendBinary = this.#link.sendBinary ?? (() => false);
    for (let part = 0; part < parts; part++) {
      if (!(await this.#room(epoch))) return "gone";
      const data = this.#buffer.readBody(bodyId, part, BODY_PART_BYTES);
      if (data === null) return "missing";
      if (!sendBinary(encodeBodyFrame(bodyId, part, part === parts - 1, data))) return "gone";
    }
    return "sent";
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
