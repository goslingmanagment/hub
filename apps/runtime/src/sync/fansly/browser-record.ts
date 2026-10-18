import {
  recordPageBrowserAlarm,
  recordPageBrowserDelivery,
  recordPageBrowserLinkError,
  recordPageBrowserState,
  type Database,
  type PageBrowserStateInput,
} from "@agency_hub_core/db";

import type { Alarm, State } from "../../services/egress/page-browser-protocol.ts";
import type { LinkStatus, PageBrowserRpcClient } from "../../services/egress/page-browser-rpc.ts";
import { errorName, type SyncLogger } from "../engine/commit.ts";
import type { Clock, Metrics } from "../engine/ports.ts";

// What the engine keeps of what a page's operator says of itself (Project
// Browser plan §4.11; stage 3 PR 17), on the profile's row (`page_browsers`),
// over the link of the page's current owner — its slot on the browser or a
// leave of it:
//
// - its `state`: written at once when anything but its buffer's figures
//   moved, else at most every `stateRefreshMs` — the alert evaluator's
//   `browser_down` reads its age (no state for 2 min while the page's owner
//   runs), the «Браузер» block shows it;
// - the halt it holds for the owner's decision on its volume (`state.halt`,
//   Astra round 3), mirrored with the state for the owner's view and the id
//   his start clears. The operator enforces it; the mirror only refuses
//   besides (Astra round 4): it keeps a halt until the operator says it
//   cleared that very one (`state.lastClearedHaltId`) — a halt the operator
//   merely stops saying (lost by a restart) stays. A failed write loses
//   nothing: the next state brings it again;
// - its link refused (`token`, `protocol_version`, spec §6.3 rule 6) or
//   broken by a protocol error (`protocol_error`, rule 3) — cleared by the
//   next state;
// - whether a Hub request can go now (`state.hubSend`, minor 5) — a page may
//   be `ready` while its transport refuses them — and Chrome's crash dumps on
//   the profile as counted (`state.crashDumps`), kept with the state;
// - the exit's refusals since the operator started (`state.egressFailures`:
//   the page's SOCKS5 by kind, step, reply and the host's class; the rules
//   extension's blocks by the host's class, the self-test's probes apart),
//   kept with the state, and what grew of them since the state before into
//   the engine's counters (`sync_browser_socks_failures`,
//   `sync_browser_dnr_blocks`) — the first state this recorder hears is only
//   its baseline: an engine before it may have counted it;
// - its last `alarm` (kind, instant, scalar details);
// - the delivery of its events to the engine's commit: p50 and p95 over the
//   last `deliveryWindowMs`, written every `deliveryWriteMs` while events
//   come.
//
// Nothing secret: the protocol's state and alarms carry none (spec §6.1), and
// the session's fingerprint is a digest the row has kept since PR 12.

export interface BrowserRecorderTiming {
  /** A state like the last one written is written again after this long. */
  stateRefreshMs: number;
  /** The window of the delivery's figures, and how often they are written. */
  deliveryWindowMs: number;
  deliveryWriteMs: number;
}

export const BROWSER_RECORDER_TIMING: Readonly<BrowserRecorderTiming> = Object.freeze({
  stateRefreshMs: 15_000,
  deliveryWindowMs: 5 * 60_000,
  deliveryWriteMs: 60_000,
});

export interface BrowserRecorderDeps {
  db: Database;
  pageId: number;
  profileId: string;
  client: PageBrowserRpcClient;
  clock: Clock;
  logger: SyncLogger;
  metrics: Metrics;
  timing?: Partial<BrowserRecorderTiming>;
}

/** What of a state is worth a write at once (all but the buffer's figures,
 *  which move with every event). */
function stateKey(state: State): string {
  return JSON.stringify([state.step, state.stopReason, state.retryAtWall, state.exitOpen, state.mode, state.sessionFingerprint,
    state.accountId, state.exitIp, state.chromeVersion, state.operatorVersion, state.selfTest, state.halt ?? null, state.lastClearedHaltId ?? null,
    state.hubSend ?? null, state.crashDumps ?? null]);
}

const wallDate = (wall: number | null): Date | null => (wall === null ? null : new Date(wall));

/** What a state of minor 5 says for audits, as Hub keeps it: whether a Hub
 *  request can go now, Chrome's crash dumps, the exit's refusals counted. An
 *  older operator's: null. */
export function stateTelemetry(state: State): Pick<PageBrowserStateInput, "hubSend" | "crashDumps" | "egressFailures"> {
  const { hubSend, crashDumps, egressFailures } = state;
  return {
    egressFailures: egressFailures === undefined
      ? null
      : {
        since: new Date(egressFailures.sinceWall),
        socks: egressFailures.socks.map(({ lastAtWall, ...entry }) => ({ ...entry, lastAt: new Date(lastAtWall).toISOString() })),
        dnr: egressFailures.dnr.map(({ lastAtWall, ...entry }) => ({ ...entry, lastAt: new Date(lastAtWall).toISOString() })),
      },
    hubSend: hubSend === undefined ? null : { allowed: hubSend.allowed, reason: hubSend.reason, since: wallDate(hubSend.sinceWall) },
    crashDumps: crashDumps === undefined || crashDumps === null
      ? null
      : {
        completed: { count: crashDumps.completed.count, newestAt: wallDate(crashDumps.completed.newestAtWall) },
        pending: { count: crashDumps.pending.count, newestAt: wallDate(crashDumps.pending.newestAtWall) },
        countedAt: new Date(crashDumps.countedAtWall),
      },
  };
}

/** The exit's refusals of a state by entry, each with its counter's name and
 *  labels (closed vocabularies: engine/counters.ts keeps them). */
function egressCounts(failures: NonNullable<State["egressFailures"]>): Map<string, { name: string; labels: Record<string, string>; count: number }> {
  const out = new Map<string, { name: string; labels: Record<string, string>; count: number }>();
  for (const e of failures.socks) {
    out.set(`socks|${e.kind}|${e.step}|${e.rep ?? ""}|${e.cls}`, { name: "sync_browser_socks_failures", labels: { kind: e.kind, how: e.step, status: e.rep === null ? "none" : String(e.rep), of: e.cls }, count: e.count });
  }
  for (const e of failures.dnr) {
    out.set(`dnr|${e.cls}|${e.probe}`, { name: "sync_browser_dnr_blocks", labels: { of: e.cls, as: e.probe ? "probe" : "page" }, count: e.count });
  }
  return out;
}

function quantile(sorted: readonly number[], q: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

/** How often the recorder looks whether a state or the delivery is due. */
const RECORDER_LOOK_MS = 5_000;

export class BrowserRecorder {
  readonly #d: BrowserRecorderDeps;
  readonly #timing: BrowserRecorderTiming;
  readonly #unlisten: Array<() => void> = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #stopped = false;
  #latest: State | null = null;
  /** The exit's refusals of the last state heard (by entry), and since when
   *  its operator counts (null: none heard yet). */
  #egressSeen: { sinceWall: number; counts: Map<string, number> } | null = null;
  /** A state came that is not written yet. */
  #unwritten = false;
  #writing: Promise<void> | null = null;
  #writtenKey: string | null = null;
  #writtenAt = Number.NEGATIVE_INFINITY;
  #linkError: string | null = null;
  #delivery: Array<{ atMono: number; lagMs: number }> = [];
  #deliveryWrittenMono = Number.NEGATIVE_INFINITY;
  #deliveryWriting: Promise<void> | null = null;

  constructor(deps: BrowserRecorderDeps) {
    this.#d = deps;
    this.#timing = { ...BROWSER_RECORDER_TIMING, ...deps.timing };
  }

  start(): void {
    if (this.#stopped || this.#timer !== null) return;
    const { client } = this.#d;
    this.#unlisten.push(client.onState((state) => this.#onState(state)));
    this.#unlisten.push(client.onAlarm((alarm) => this.#onAlarm(alarm)));
    this.#unlisten.push(client.onLink((status) => this.#onLink(status)));
    const state = client.state;
    if (state !== null) this.#onState(state);
    this.#timer = setInterval(() => this.look(), Math.min(RECORDER_LOOK_MS, this.#timing.stateRefreshMs));
    this.#timer.unref?.();
  }

  /** Stops recording; a write under way finishes. Never rejects. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    for (const unlisten of this.#unlisten.splice(0)) unlisten();
    await this.#writing?.catch(() => undefined);
    await this.#deliveryWriting?.catch(() => undefined);
  }

  /** The intake committed events: how long each took from the operator's
   *  instant to the commit. */
  delivered(lagsMs: readonly number[]): void {
    if (this.#stopped || lagsMs.length === 0) return;
    const atMono = this.#d.clock.monoNow();
    for (const lagMs of lagsMs) if (Number.isFinite(lagMs)) this.#delivery.push({ atMono, lagMs: Math.max(0, lagMs) });
  }

  /** A state like the last one written again once it is stale, and the
   *  delivery's figures once they are due (the timer; tests). */
  look(): void {
    if (this.#stopped) return;
    this.#writeState();
    this.#deliveryWriting ??= this.#writeDelivery().finally(() => {
      this.#deliveryWriting = null;
    });
  }

  /** Every state the operator said so far is written (tests). */
  async flushed(): Promise<void> {
    while (this.#writing !== null) await this.#writing.catch(() => undefined);
    await this.#deliveryWriting?.catch(() => undefined);
  }

  #onState(state: State): void {
    if (this.#stopped) return;
    this.#countEgress(state);
    this.#latest = state;
    this.#unwritten = true;
    this.#writeState();
  }

  /** The latest state the operator said, written — at once when it differs
   *  from the one written last, else once that one is `stateRefreshMs` old.
   *  Only a state the operator said since: its record's age is its silence. */
  #writeState(): void {
    if (this.#writing !== null || !this.#unwritten) return;
    const state = this.#latest;
    if (state === null) return;
    const key = stateKey(state);
    const now = this.#d.clock.monoNow();
    if (key === this.#writtenKey && now - this.#writtenAt < this.#timing.stateRefreshMs) return;
    this.#unwritten = false;
    const { db, profileId, logger, pageId } = this.#d;
    this.#writing = (async () => {
      let written = false;
      try {
        await recordPageBrowserState(db, {
          profileId,
          step: state.step,
          stopReason: state.stopReason,
          mode: state.mode,
          exitOpen: state.exitOpen,
          sessionFingerprint: state.sessionFingerprint,
          accountId: state.accountId,
          exitIp: state.exitIp,
          chromeVersion: state.chromeVersion,
          operatorVersion: state.operatorVersion,
          selfTest: state.selfTest === null ? null : { ok: state.selfTest.ok, at: new Date(state.selfTest.atWall), failed: state.selfTest.failed },
          buffer: { bytes: state.buffer.bytes, oldestAgeMs: state.buffer.oldestAgeMs },
          retryAt: state.retryAtWall === null ? null : new Date(state.retryAtWall),
          halt: state.halt === undefined || state.halt === null ? null : { id: state.halt.id, reason: state.halt.reason, at: new Date(state.halt.atWall) },
          lastClearedHaltId: state.lastClearedHaltId ?? null,
          ...stateTelemetry(state),
        });
        this.#writtenKey = key;
        this.#writtenAt = now;
        this.#linkError = null;
        written = true;
      } catch (error) {
        // Written with the next state, or the next look — never at once (a
        // database that is away is not asked in a loop).
        if (this.#latest === state) this.#unwritten = true;
        logger.warn({ pageId, err: errorName(error) }, "Fansly sync browser: the operator's state could not be recorded");
      } finally {
        this.#writing = null;
      }
      // A newer state came meanwhile.
      if (written && !this.#stopped) this.#writeState();
    })();
  }

  /** What grew of the exit's refusals since the state before (a new
   *  operator's: all of it) into the engine's counters; the first state this
   *  recorder hears is its baseline. */
  #countEgress(state: State): void {
    const failures = state.egressFailures;
    if (failures === undefined) return;
    const counts = egressCounts(failures);
    const seen = this.#egressSeen;
    this.#egressSeen = { sinceWall: failures.sinceWall, counts: new Map([...counts].map(([key, entry]) => [key, entry.count])) };
    if (seen === null) return;
    const before = seen.sinceWall === failures.sinceWall ? seen.counts : new Map<string, number>();
    const { metrics, pageId } = this.#d;
    for (const [key, entry] of counts) {
      const grew = entry.count - (before.get(key) ?? 0);
      if (grew > 0) metrics.increment(entry.name, { pageId, ...entry.labels }, grew);
    }
  }

  #onAlarm(alarm: Alarm): void {
    if (this.#stopped) return;
    const { db, profileId, pageId, logger, metrics } = this.#d;
    metrics.increment("sync_browser_alarm", { pageId, kind: alarm.kind });
    void recordPageBrowserAlarm(db, { profileId, kind: alarm.kind, at: new Date(alarm.atWall), detail: alarm.detail }).catch((error: unknown) => {
      logger.warn({ pageId, kind: alarm.kind, err: errorName(error) }, "Fansly sync browser: the operator's alarm could not be recorded");
    });
  }

  #onLink(status: LinkStatus): void {
    if (this.#stopped) return;
    const linkError = status.kind === "refused"
      ? (status.reason === "protocol_major" || status.reason === "protocol_minor" ? "protocol_version" : status.reason)
      : status.kind === "down" && status.reason.startsWith("protocol error") ? "protocol_error" : null;
    if (linkError === null || linkError === this.#linkError) return;
    this.#linkError = linkError;
    const { db, profileId, pageId, logger } = this.#d;
    logger.warn({ pageId, linkError }, "Fansly sync browser: the engine cannot work with the page's operator");
    void recordPageBrowserLinkError(db, { profileId, linkError }).catch((error: unknown) => {
      logger.warn({ pageId, err: errorName(error) }, "Fansly sync browser: the link's error could not be recorded");
    });
  }

  async #writeDelivery(): Promise<void> {
    const now = this.#d.clock.monoNow();
    if (now - this.#deliveryWrittenMono < this.#timing.deliveryWriteMs) return;
    this.#delivery = this.#delivery.filter((entry) => now - entry.atMono <= this.#timing.deliveryWindowMs);
    // Nothing delivered within the window: the figures say nothing new.
    if (this.#delivery.length === 0) return;
    const sorted = this.#delivery.map((entry) => entry.lagMs).sort((a, b) => a - b);
    this.#deliveryWrittenMono = now;
    try {
      await recordPageBrowserDelivery(this.#d.db, { profileId: this.#d.profileId, p50Ms: quantile(sorted, 0.5), p95Ms: quantile(sorted, 0.95) });
    } catch (error) {
      this.#d.logger.warn({ pageId: this.#d.pageId, err: errorName(error) }, "Fansly sync browser: the delivery's figures could not be recorded");
    }
  }
}
