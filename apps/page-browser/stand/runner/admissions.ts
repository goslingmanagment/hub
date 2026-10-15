// What the stand's engine admits, and when (plan §4.3, §4.13; spec §3,
// §6.1): on the rules of main's engine (apps/runtime/src/sync/engine/
// pacer.ts, actor.ts, site-slot.ts; sync/fansly/browser-site.ts) as far as
// the stand needs them.
//
// - One admitted operation in flight per page, a Hub request or a site
//   request alike: the engine's pacer has one place in flight, and the
//   operator's send gate is built on it (src/egress/gate.ts: "to the API
//   host only one admitted request is in flight, and every other request
//   waits in Chrome's Fetch interception"). An engine that lets a second one
//   go while the first still waits for its connection gives the gate a
//   window its own request may not be the one to fill: Chrome writes the
//   older request there — after that one's deadline (series de-b73667eb,
//   stand t9: a Hub preflight 3.8 s, a site preflight 13.7 s past their
//   deadlines, each in a later Hub request's window).
// - The next operation no sooner than `paceMs` after the end of the last one
//   that may have left (`siteDone.sent`; a Hub `result` that may have been
//   sent). One that never left — refused, not used, its request gone before
//   the admission came — sets no pace (the pacer marks no send for it,
//   `pacer.ts` `complete`): otherwise what a restarted browser left behind,
//   each admission answered "not used" at once, would each cost a pace, and
//   the requests of the new document would wait behind them for longer than
//   a run.
// - Nothing before the operator's `quiesced` on the connection: the earlier
//   owner's work is not known to be over (plan §4.7; main's engine admits
//   nothing before it either, browser-site.ts `pending`).
// - Hub and site take turns when both wait (main's engine gives the site its
//   slot between its own, engine/site-admission.ts `SiteTurns`).
// - Site requests: the oldest asked first; one past its wait
//   (`waitDeadlineMono`) is refused `wait_expired`; an id is admitted once
//   (spec §6.1); what a connection that went asked and was not answered is
//   dropped — the operator asks it again on the next one, by the same id
//   (spec §6.2).
// - An operation whose end does not come within `endWaitMs` (the engine's
//   `SITE_END_WAIT_MS`) frees the place as one that may have left: an
//   operator that lost it must not stop the page for the rest of a series.
//   Its attempt stays without an outcome — the run's `recover` asks.
// - Held between the runs of a series: nothing is admitted — no attempt is
//   issued under a run that is being judged; what waits is admitted (or
//   refused) once the next run begins.

import type { SiteAdmit } from "../../src/rpc/protocol.ts";

/** host + path + query of a site request, as the stand's journal has it. */
export function siteTarget(request: Pick<SiteAdmit, "host" | "path" | "query">): string {
  return `${request.host}${request.path}${request.query ? `?${request.query.replace(/^\?/, "")}` : ""}`;
}

/** Ids of finished requests kept (as the engine's `SITE_IDS_REMEMBERED`). */
export const SITE_IDS_REMEMBERED = 4096;

/** A Hub request that wanted its turn this recently still wants it. */
const HUB_WANTS_MS = 1000;

export interface AdmissionsDeps {
  now: () => number;
  /** The attempt of a site admission, recorded before it is given. */
  issue: (request: SiteAdmit, target: string) => Promise<number>;
  admit: (request: SiteAdmit, target: string, attemptId: number) => void;
  refuse: (request: SiteAdmit, reason: "wait_expired" | "buffer_full") => void;
  paceMs: number;
  /** How long an admitted operation's end is waited for (60 s). */
  endWaitMs?: number;
  /** An admitted operation's end did not come in `endWaitMs`. */
  endWaitOver?: (what: string) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

type Flight = { kind: "site"; ref: string; method: string; target: string; timer: unknown } | { kind: "hub"; attemptId: number | null; timer: unknown };

/** The Hub request that holds the place in flight. */
export interface HubTurn {
  /** Its attempt, once issued: its `result` ends the turn. */
  bind(attemptId: number): void;
  /** It ended before its result could come (not issued, not written). */
  release(sent: boolean): void;
}

export class Admissions {
  readonly #deps: AdmissionsDeps;
  #queue: SiteAdmit[] = [];
  #inFlight: Flight | null = null;
  /** When the last operation that may have left ended (none yet: no pace). */
  #lastSendEndMono = Number.NEGATIVE_INFINITY;
  #lastKind: "hub" | "site" | null = null;
  #hubWantedMono = Number.NEGATIVE_INFINITY;
  readonly #finished = new Set<string>();
  #held = false;
  #ready = true;
  #timer: unknown = null;

  constructor(deps: AdmissionsDeps) {
    this.#deps = deps;
  }

  get held(): boolean {
    return this.#held;
  }

  /** An admitted operation is in flight (its end not come yet). */
  get busy(): boolean {
    return this.#inFlight !== null;
  }

  /** Held between runs: nothing is admitted until released. */
  hold(on: boolean): void {
    this.#held = on;
    if (!on) this.#pump();
  }

  /** The connection may admit (its `quiesced` came) or may not (none yet). */
  ready(on: boolean): void {
    this.#ready = on;
    if (on) this.#pump();
  }

  // ── site requests ──────────────────────────────────────────────────────

  /** The operator asks a site request's admission. */
  ask(request: SiteAdmit): void {
    const id = request.siteRequestId;
    if ((this.#inFlight?.kind === "site" && this.#inFlight.ref === id) || this.#finished.has(id) || this.#queue.some((queued) => queued.siteRequestId === id)) return;
    this.#queue.push(request);
    this.#pump();
  }

  /** The operator's end of an admitted site request. */
  done(siteRequestId: string, sent: boolean): void {
    const flight = this.#inFlight;
    if (flight?.kind !== "site" || flight.ref !== siteRequestId) return;
    this.#end(flight, sent);
  }

  /** The connection went: what it asked and was not answered is dropped. */
  linkGone(): void {
    this.#queue = [];
  }

  /** The site's requests that wait now: asked an admission and not given
   *  one yet, or admitted and not ended. */
  waiting(): Array<{ siteRequestId: string; method: string; target: string }> {
    const queued = this.#queue.map((next) => ({ siteRequestId: next.siteRequestId, method: next.method, target: siteTarget(next) }));
    const flight = this.#inFlight;
    return flight?.kind === "site" ? [{ siteRequestId: flight.ref, method: flight.method, target: flight.target }, ...queued] : queued;
  }

  // ── Hub requests ───────────────────────────────────────────────────────

  /** A Hub request may go now: the place in flight is free, the pace has
   *  passed, and it is not the site's turn. Null: not now (asked again
   *  later; the wish is remembered so that the site leaves it its turn). */
  takeHub(): HubTurn | null {
    this.#hubWantedMono = this.#deps.now();
    if (!this.#free() || this.#paceLeft() > 0) return null;
    if (this.#lastKind === "hub" && this.#admissibleSite()) return null;
    const flight: Flight = { kind: "hub", attemptId: null, timer: null };
    this.#inFlight = flight;
    this.#lastKind = "hub";
    this.#armEndWait(flight, "a Hub request");
    return {
      bind: (attemptId) => {
        flight.attemptId = attemptId;
      },
      release: (sent) => {
        if (this.#inFlight === flight) this.#end(flight, sent);
      },
    };
  }

  /** The operator's `result` of a Hub attempt. */
  hubDone(attemptId: number, sent: boolean): void {
    const flight = this.#inFlight;
    if (flight?.kind !== "hub" || flight.attemptId !== attemptId) return;
    this.#end(flight, sent);
  }

  // ── the place in flight ────────────────────────────────────────────────

  #free(): boolean {
    return !this.#held && this.#ready && this.#inFlight === null;
  }

  #paceLeft(): number {
    return this.#lastSendEndMono + this.#deps.paceMs - this.#deps.now();
  }

  #admissibleSite(): boolean {
    const now = this.#deps.now();
    return this.#queue.some((request) => now < request.waitDeadlineMono);
  }

  #end(flight: Flight, sent: boolean): void {
    if (flight.timer !== null) (this.#deps.clearTimer ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout)))(flight.timer);
    flight.timer = null;
    if (this.#inFlight === flight) this.#inFlight = null;
    if (sent) this.#lastSendEndMono = this.#deps.now();
    this.#pump();
  }

  #armEndWait(flight: Flight, what: string): void {
    flight.timer = (this.#deps.setTimer ?? setTimeout)(() => {
      if (this.#inFlight !== flight) return;
      flight.timer = null;
      this.#deps.endWaitOver?.(flight.kind === "site" ? `site request ${flight.ref}` : `${what}${flight.attemptId === null ? "" : ` (attempt ${flight.attemptId})`}`);
      this.#end(flight, true);
    }, this.#deps.endWaitMs ?? 60_000);
  }

  #later(ms: number): void {
    if (this.#timer !== null) return;
    this.#timer = (this.#deps.setTimer ?? setTimeout)(() => {
      this.#timer = null;
      this.#pump();
    }, ms);
  }

  #finish(id: string): void {
    this.#finished.delete(id);
    this.#finished.add(id);
    if (this.#finished.size > SITE_IDS_REMEMBERED) this.#finished.delete(this.#finished.values().next().value!);
  }

  #pump(): void {
    while (this.#free() && this.#queue.length > 0) {
      const next = this.#queue[0]!;
      const now = this.#deps.now();
      if (now >= next.waitDeadlineMono) {
        this.#queue.shift();
        this.#finish(next.siteRequestId);
        this.#deps.refuse(next, "wait_expired");
        continue;
      }
      const wait = this.#paceLeft();
      if (wait > 0) return this.#later(wait);
      // The Hub request's turn, while it still wants one.
      const hubWants = now - this.#hubWantedMono < HUB_WANTS_MS;
      if (this.#lastKind === "site" && hubWants) return this.#later(HUB_WANTS_MS);
      this.#queue.shift();
      const target = siteTarget(next);
      const flight: Flight = { kind: "site", ref: next.siteRequestId, method: next.method, target, timer: null };
      this.#inFlight = flight;
      this.#lastKind = "site";
      this.#finish(next.siteRequestId);
      void this.#deps.issue(next, target).then(
        (attemptId) => {
          if (this.#inFlight !== flight) return;
          this.#armEndWait(flight, "a site request");
          this.#deps.admit(next, target, attemptId);
        },
        () => {
          this.#deps.refuse(next, "buffer_full");
          if (this.#inFlight === flight) this.#end(flight, false);
        },
      );
      return;
    }
  }
}
