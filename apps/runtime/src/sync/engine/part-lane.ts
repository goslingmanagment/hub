import { getSyncAttempt, getSyncPage, LiveGateClosedError, markAttemptCommitFailed, OwnershipLostError, pickLaneWork, type SyncPageRow, type SyncWorkRow } from "@agency_hub_core/db";
import { FanslySendRefusedError } from "@agency_hub_core/fansly";
import { FANSLY_PAUSE_MIN_MS } from "@agency_hub_core/shared";

import { holdSetOf, whyHeld } from "./admission.ts";
import {
  AdmissionHeldError,
  admit,
  apply,
  applyLocal,
  capture,
  commitNoHttp,
  errorName,
  isAnswerInMemory,
  settleNotSent,
  SyncCrashFault,
  type AdmissionRecord,
  type CaptureSend,
  type CommitDeps,
} from "./commit.ts";
import { SEND_WINDOW_MS, type SlotGrant } from "./pacer.ts";
import {
  CredentialsGenerationChangedError,
  PageTransportUnavailableError,
  UnsendableRequestError,
  type OwnershipSession,
  type PageTransport,
  type TransportOutcome,
} from "./ports.ts";
import type { PlanContext, ResourceModule, StepPlan } from "./resource.ts";

// The storage lane of a page's actor (vault packs, owner 2026-11-03): an
// upload's parts — PUTs of a file's bytes to the presigned S3 URLs its
// create named — a few at once, beside the page's one managed request to
// Fansly and outside its pause. S3 is not Fansly: the pause, the one request
// in flight and the route budgets are Fansly's (pacer.ts, route-policy.ts);
// every request to Fansly itself — the upload's create, its completion, the
// reads of its processing, the album's writes — still takes its turn at the
// pacer. A part still goes through the page's browser and its proxy, as the
// site's own parallel parts do.
//
// Each part is a work of `publish.part` (registry.ts) and an attempt of its
// own, admitted, sent and committed exactly as the actor does any request —
// the admission transaction (the owner's pause and the page's holds under the
// row lock, the module's `onAdmit` recording the request before the send),
// the browser's check answered by the write's fresh confirmation, the
// capture, the apply, the acknowledgement — save the pacer: its grant is the
// lane's (ownership alive, within the send window), its attempt records no
// pause (`pause_ms` 0; the send audit judges no part, send-audit.ts), and the
// cycle's pointer does not move. Only where the page's browser says it takes
// parts so (protocol minor 10, `PageTransport.parallelParts`); else the
// actor's pick sends them in its turn, one at a time, as before. The actor
// leaves `publish.part` out of its own pick while the lane runs.
//
// A commit that keeps failing ends the actor as one after a send does
// (`exit`): its recovery closes the attempt `unknown`, and the part goes
// again (publish/uploads.ts).

/** The registry key of an upload's parts. */
export const PART_LANE_KEY = "publish.part";
/** The lane looks for due parts this often while it has room and none is
 *  due (the actor's wake is its own: the lane never takes its NOTIFY). */
export const PART_LANE_IDLE_MS = 1_000;
const COMMIT_ATTEMPTS = 3;
const COMMIT_BACKOFF_MS = 1_000;

export interface PartLaneDeps extends CommitDeps {
  transport: PageTransport;
  ownership: Pick<OwnershipSession, "alive">;
  /** The plan's context of the page as read now (actor.ts `planContextOf`). */
  planContext(page: SyncPageRow, now: Date): PlanContext;
  /** What the page's pick leaves out now (actor.ts `pickExclusions`): paused
   *  and switched-off keys, held resource files. */
  exclusions(page: SyncPageRow, now: Date): { excludeResources: string[]; excludeFiles: string[] };
}

export type PartLaneExit = { kind: "ownership_lost"; foreign: boolean } | { kind: "failed"; error: string };

export class PartLane {
  readonly #d: PartLaneDeps;
  /** The parts on the wire or being committed, by their work. */
  readonly #inFlight = new Map<number, Promise<void>>();
  #loop: Promise<void> | null = null;
  #changed: (() => void) | null = null;
  #exit: PartLaneExit | null = null;
  /** A crash fault (tests) met inside the lane: the actor rethrows it. */
  #crash: SyncCrashFault | null = null;
  /** No new part before this (monotonic): the page's browser refused one as
   *  not sent — no room, or it could not take it now. */
  #notBeforeMono = Number.NEGATIVE_INFINITY;
  /** Parts admitted by this lane (tests, status). */
  admissions = 0;

  constructor(deps: PartLaneDeps) {
    this.#d = deps;
  }

  /** How many parts go at once now: what the page's browser takes (0: none —
   *  the actor's pick sends them in its turn). */
  width(): number {
    const width = this.#d.transport.parallelParts?.() ?? 0;
    return Number.isSafeInteger(width) && width > 0 ? width : 0;
  }

  /** Why the actor must end (a commit that kept failing, ownership lost), or
   *  null. A crash fault (tests) is thrown here, as the actor's own would be. */
  get exit(): PartLaneExit | null {
    if (this.#crash !== null) throw this.#crash;
    return this.#exit;
  }

  get inFlight(): number {
    return this.#inFlight.size;
  }

  start(signals: { stop: AbortSignal; abort: AbortSignal }): void {
    this.#loop ??= this.#run(signals).catch((error: unknown) => this.#failed(error, "stopped by an error"));
  }

  /** The loop's end and every part's commit (their sends end by the abort
   *  signal the actor holds); a crash fault met meanwhile is thrown. */
  async stopped(): Promise<void> {
    await this.#loop;
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight.values()]);
    if (this.#crash !== null) throw this.#crash;
  }

  /** An error the lane cannot go on from: a crash fault is kept for the
   *  actor to throw; anything else is logged. */
  #failed(error: unknown, what: string): void {
    if (error instanceof SyncCrashFault) {
      this.#crash ??= error;
      return;
    }
    this.#d.logger.warn({ pageId: this.#d.pageId, err: errorName(error) }, `Fansly sync part lane: ${what}`);
  }

  async #run(signals: { stop: AbortSignal; abort: AbortSignal }): Promise<void> {
    const d = this.#d;
    while (!signals.stop.aborted && this.#exit === null && this.#crash === null && d.ownership.alive()) {
      const width = this.width();
      let started = false;
      if (width > 0 && this.#inFlight.size < width && d.clock.monoNow() >= this.#notBeforeMono) {
        try {
          started = await this.#startOne(signals);
        } catch (error) {
          if (error instanceof SyncCrashFault) {
            this.#crash ??= error;
            break;
          }
          if (error instanceof OwnershipLostError) {
            this.#exit = { kind: "ownership_lost", foreign: true };
            break;
          }
          d.metrics.increment("sync_part_lane_errors", { error: errorName(error) });
          d.logger.warn({ pageId: d.pageId, err: errorName(error) }, "Fansly sync part lane: a step failed before its send");
        }
      }
      if (!started) await this.#idle(signals.stop);
    }
  }

  /** Until a part ends, the idle period passes, or the lane stops. */
  #idle(stop: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        stop.removeEventListener("abort", done);
        if (this.#changed === done) this.#changed = null;
        resolve();
      };
      const timer = setTimeout(done, PART_LANE_IDLE_MS);
      stop.addEventListener("abort", done, { once: true });
      this.#changed = done;
    });
  }

  /** One due part admitted and sent (its commit runs on). False: nothing to
   *  send now. */
  async #startOne(signals: { stop: AbortSignal; abort: AbortSignal }): Promise<boolean> {
    const d = this.#d;
    // No due part, nothing more to read (an idle lane costs one query a second).
    if (await pickLaneWork(d.db, { pageId: d.pageId, resource: PART_LANE_KEY, now: null }) === null) return false;
    const page = await getSyncPage(d.db, d.pageId);
    if (page === null || page.pausedAll) return false;
    // A browser just started confirms its session by the actor's identity
    // read first: nothing of the page's goes before it.
    if (d.transport.needsSessionConfirmation?.() === true) return false;
    const now = d.clock.wallNow();
    // What holds the page holds its parts: they go through its proxy.
    const holds = holdSetOf(page.holds);
    if (whyHeld(holds, null, {}, now) !== null) return false;
    const { excludeResources, excludeFiles } = d.exclusions(page, now);
    if (excludeResources.includes(PART_LANE_KEY)) return false;
    const work = await pickLaneWork(d.db, { pageId: d.pageId, resource: PART_LANE_KEY, now: null, excludeResources, excludeFiles });
    if (work === null) return false;
    const module = await d.registry.module(work.resource);
    let plan: StepPlan;
    try {
      plan = await module.plan(work, d.planContext(page, now));
    } catch (error) {
      d.logger.warn({ pageId: d.pageId, workId: work.id, err: errorName(error) }, "Fansly sync part lane: a part's plan failed");
      return false;
    }
    if (plan.kind === "local") {
      await applyLocal(d, work, module, plan);
      return true;
    }
    if (plan.kind !== "request") {
      await commitNoHttp(d, work, plan);
      return true;
    }
    let request: Awaited<ReturnType<PageTransport["prepare"]>>;
    try {
      request = await d.transport.prepare(plan.request, { work });
    } catch (error) {
      // The browser cannot take it now, or what it was prepared under moved:
      // the actor's own lap says so and acts; the lane waits.
      if (error instanceof PageTransportUnavailableError || error instanceof CredentialsGenerationChangedError) return false;
      if (!(error instanceof UnsendableRequestError)) throw error;
      d.metrics.increment("sync_unsendable", { resource: work.resource, reason: error.reason });
      const ended: Exclude<StepPlan, { kind: "request" }> = module.unsendable?.(work, error) ?? { kind: "done", reason: error.reason, result: error.result };
      if (ended.kind === "local") await applyLocal(d, work, module, ended);
      else await commitNoHttp(d, work, ended);
      return true;
    }
    const issuedMono = d.clock.monoNow();
    // No pause applied, no cycle moved: the attempt says so (pause 0, no
    // slot; its setting the floor, as a setting must be one).
    const settingMs = FANSLY_PAUSE_MIN_MS;
    const grant: SlotGrant = { settingMs, jitterU: 0, pauseMs: 0, earliestMono: issuedMono };
    let admission: AdmissionRecord | null;
    try {
      admission = await admit(d, { work, workClass: "planned", slot: null, nextCyclePos: null }, plan.request, grant, { routeIntervalMs: 0, familyIntervalMs: null }, module, request);
    } catch (error) {
      if (error instanceof LiveGateClosedError || error instanceof AdmissionHeldError) return false;
      throw error;
    }
    if (admission === null) return false;
    this.admissions += 1;
    d.metrics.increment("sync_part_lane_admissions", { pageId: d.pageId });
    const sending = this.#send(admission, work, module, request, issuedMono, settingMs, signals)
      .catch((error: unknown) => this.#failed(error, "a part's commit failed"))
      .finally(() => {
        this.#inFlight.delete(work.id);
        this.#changed?.();
      });
    this.#inFlight.set(work.id, sending);
    return true;
  }

  /** One part on the wire, then its commit: as the actor's own send and
   *  commit, with the lane's grant in place of the pacer's. */
  async #send(
    admission: AdmissionRecord,
    work: SyncWorkRow,
    module: ResourceModule,
    request: Awaited<ReturnType<PageTransport["prepare"]>>,
    issuedMono: number,
    settingMs: number,
    signals: { stop: AbortSignal; abort: AbortSignal },
  ): Promise<void> {
    const d = this.#d;
    const sendDeadlineMono = issuedMono + SEND_WINDOW_MS;
    let grantedMono: number | null = null;
    let used = false;
    const grant = (): FanslySendRefusedError | null => {
      if (used) return new FanslySendRefusedError("lease_used");
      used = true;
      if (signals.stop.aborted || !d.ownership.alive()) return new FanslySendRefusedError("lease_inactive");
      const now = d.clock.monoNow();
      if (now >= sendDeadlineMono) return new FanslySendRefusedError("send_deadline_passed");
      grantedMono = now;
      return null;
    };
    const writeFingerprint = request.writeFingerprint;
    const confirmWrite = writeFingerprint === undefined || module.confirmWrite === undefined
      ? undefined
      : () => module.confirmWrite!(d.db, work, { attemptId: admission.attemptId, writeFingerprint, ...(d.settings === undefined ? {} : { settings: d.settings }) });
    let outcome: TransportOutcome;
    try {
      outcome = await d.transport.send(request, {
        // Never sent from this process: a part goes through the page's browser.
        check: () => new FanslySendRefusedError("lease_inactive"),
        grant,
        ...(confirmWrite === undefined ? {} : { confirmWrite }),
      }, signals.abort, { attemptId: admission.attemptId, ownerGeneration: d.generation, issuedMono, sendDeadlineMono });
    } catch (error) {
      outcome = { kind: "transport_error", sent: grantedMono !== null, message: errorName(error) };
    }
    const sendFacts = sendOf(d, outcome, { issuedMono, grantedMono, settingMs });
    try {
      await this.#committed(async () => {
        if (outcome.kind === "aborted_before_send") {
          // Never left: the work is open again — not at once, or a browser
          // with no room would be asked lap after lap.
          this.#notBeforeMono = d.clock.monoNow() + PART_LANE_IDLE_MS;
          await settleNotSent(d, admission, outcome);
          this.#settled(admission.attemptId);
          return;
        }
        const captured = await capture(d, admission, sendFacts, outcome, module);
        const inMemoryOnly = isAnswerInMemory(admission.request.spec);
        if (!inMemoryOnly) this.#settled(admission.attemptId);
        if (captured.applyNow) await apply(d, { attemptId: admission.attemptId, operation: admission.request.spec }, captured.inMemory);
        if (inMemoryOnly && await this.#answerCommitted(admission.attemptId)) this.#settled(admission.attemptId);
      });
    } catch (error) {
      if (error instanceof SyncCrashFault) throw error;
      // The actor ends as after any commit that kept failing: its recovery
      // closes the attempt `unknown`, and the part goes again.
      if (error instanceof OwnershipLostError) {
        this.#exit ??= { kind: "ownership_lost", foreign: true };
        return;
      }
      this.#exit ??= { kind: "failed", error: errorName(error) };
      await markAttemptCommitFailed(d.db, { attemptId: admission.attemptId, errorClass: `commit_failed:${errorName(error)}` }).catch(() => undefined);
    }
  }

  async #committed(commit: () => Promise<void>): Promise<void> {
    let last: unknown = null;
    for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt += 1) {
      try {
        await commit();
        return;
      } catch (error) {
        if (error instanceof SyncCrashFault || error instanceof OwnershipLostError) throw error;
        last = error;
        this.#d.logger.warn({ pageId: this.#d.pageId, attempt, err: errorName(error) }, "Fansly sync part lane: commit failed; retrying");
        if (attempt < COMMIT_ATTEMPTS) await this.#d.clock.sleep(COMMIT_BACKOFF_MS).catch(() => undefined);
      }
    }
    throw last;
  }

  async #answerCommitted(attemptId: number): Promise<boolean> {
    try {
      const attempt = await getSyncAttempt(this.#d.db, attemptId);
      if (attempt === null || attempt.outcome === "admitted" || attempt.outcome === "sent") return false;
      return attempt.applyState === "applied" || attempt.applyState === "none";
    } catch {
      return false;
    }
  }

  #settled(attemptId: number): void {
    try {
      this.#d.transport.settled?.(attemptId);
    } catch (error) {
      this.#d.logger.debug({ attemptId, err: errorName(error) }, "Fansly sync part lane: the transport's settle failed");
    }
  }
}

/** A part's send facts, as the pacer marks an admission's (pacer.ts
 *  `complete`): the instant the browser reported it left — never before the
 *  lane let it go, never after now — else, if it may have left, now. No
 *  pause, no gap to a previous send: the lane keeps none. */
export function sendOf(d: Pick<CommitDeps, "clock">, outcome: TransportOutcome, input: { issuedMono: number; grantedMono: number | null; settingMs: number }): CaptureSend {
  const now = d.clock.monoNow();
  const mayHaveSent = outcome.kind === "response" || ((outcome.kind === "transport_error" || outcome.kind === "timeout") && outcome.sent);
  const reported = !mayHaveSent
    ? null
    : outcome.kind === "response"
      ? (outcome.sendMark === "transport_reported" && Number.isFinite(outcome.sentMono) ? outcome.sentMono! : null)
      : (outcome.kind === "transport_error" || outcome.kind === "timeout") && Number.isFinite(outcome.sentMono) ? outcome.sentMono! : null;
  const sentMono = !mayHaveSent ? null : reported === null ? now : Math.min(Math.max(reported, input.grantedMono ?? input.issuedMono), now);
  const wallOf = (mono: number | null) => (mono === null ? null : new Date(d.clock.wallNow().getTime() - (now - mono)));
  return {
    sent: sentMono !== null,
    sentWall: wallOf(sentMono),
    sendMark: sentMono === null ? null : reported === null ? "completion_fallback" : "transport_reported",
    sendMonoOffsetMs: sentMono === null ? null : sentMono - input.issuedMono,
    gapPrevMs: null,
    durationMs: sentMono === null ? null : now - sentMono,
    pauseMs: 0,
    settingMs: input.settingMs,
    grantedWall: wallOf(input.grantedMono),
    releasedWall: null,
  };
}
