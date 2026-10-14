import { createHash } from "node:crypto";

import {
  browserWsFrameKey,
  captureBrowserWsFrame,
  findPageById,
  getSyncPage,
  haltPageBrowserIntake,
  insertObservation,
  lockOwnedPage,
  lockPageBrowserIntake,
  markBrowserWsLoss,
  markPostRepliesDirty,
  OwnershipLostError,
  readPageBrowserIntake,
  touchBrowserWsConnection,
  upsertDemands,
  verifyBrowserWsConnection,
  writePageBrowserIntake,
  type Database,
  type UpsertDemandInput,
} from "@agency_hub_core/db";
import { businessFanslyWsFrame, classifyFanslyWsFrame } from "@agency_hub_core/shared";

import type { BufferEvent, EventsRefused, State } from "../../services/egress/page-browser-protocol.ts";
import type { DeliveredEvents, LinkStatus, PageBrowserRpcClient } from "../../services/egress/page-browser-rpc.ts";
import { errorName, type SyncLogger } from "../engine/commit.ts";
import type { Metrics } from "../engine/ports.ts";
import { demandToUpsert, type DemandSignal, type EngineRegistry } from "../engine/resource.ts";
import { siteResponseObservation } from "./browser-site-capture.ts";
import { replaceJournalUnstorableText } from "./lib/journal-lone-surrogates.ts";
import { FANSLY_ROUTES, isFanslyRoute } from "./routes.ts";
import type { BrowserWsSource, BrowserWsTaken } from "./ws/browser-source.ts";

// The intake of a page's operator buffer (Project Browser, plan §3.2 «Приём
// буфера и восстановление», «Кадры сокета», «Ответы на собственные
// API-запросы сайта», §4.4; spec §6.1; stage 3 PR 13).
//
// The stream (plan §4.4, step 4): the intake subscribes with the buffer id
// and the last number it committed (`events.subscribe`), takes the batches
// in order, commits each in ONE transaction with its new position
// (`page_browsers.events_*`, 0276), and only then acknowledges it (`ack`).
// The position is the next subscription's `afterSeq`, which the operator
// takes as the acknowledgement of everything up to it. So:
// - a crash before the commit loses nothing: the batch comes again;
// - a crash after the commit, before the ack, or an ack lost on the way,
//   duplicates nothing: the next subscription starts after it, and an event
//   delivered again is taken by its id (the position is read under its row
//   lock; every write is keyed by the event's id besides);
// - a batch of another buffer, or of an earlier connection, is never taken
//   nor acknowledged, and an ack is always the batch's own buffer's: a late
//   ack of an old buffer never acknowledges the new one's events (the
//   operator refuses it, `events.refused`, and the intake lets it be).
// - Events come in the order of their numbers. A batch that leaves a hole is
//   asked for again; a subscription whose FIRST batch already starts past
//   the event expected names events the operator no longer has (a position
//   older than its acknowledgements: a database restored from before) — they
//   are a loss since the loss boundary (below), taken as a gap, and the
//   stream goes on from what there is.
// - `events.refused`: another buffer (the volume was made anew) — the intake
//   starts over with the operator's buffer from its first event, and the
//   old buffer's untaken tail is a loss since the loss boundary; a
//   buffer that cannot be opened — again once the operator's state says it
//   opened; a subscription ahead of the buffer (a file restored from before)
//   — that buffer is halted for good (`page_browsers.events_halted_*`, alert
//   2 `browser_buffer_halted`; until the halt is written nothing at all is
//   subscribed, its write tried again): its numbers are not this history's, and
//   once they grew past the position a subscription would acknowledge events
//   never taken; only another buffer of the operator is taken again; an ack
//   before the subscription or past what it sent — subscribe again from the
//   position.
// - Every batch commits under the page's owner generation (`lockOwnedPage`):
//   an intake of an earlier owner commits nothing and stops.
//
// The loss boundary (`page_browsers.events_last_wall`): where a loss whose
// start nothing names reads back from — the latest instant of a `ws.open` or
// a `ws.in` the engine committed, of any buffer. Only those bound a socket
// message missed after them: the operator stamps them by Chrome's own time of
// the event (`cdp/chrome-clock.ts`: never later than Chrome saw it), and CDP
// tells a session's socket events in their order, so whatever came after the
// last one taken is no older than it. Nothing else moves the boundary: a
// `site.response` or a `gap` is stamped when the operator took it, and a
// frame CDP tells late can follow either in the stream with an older stamp —
// a boundary at the take would start the repair late by that delay, outside
// its 60 s margin once the delay is longer (`repositories/sync/ws-gap.ts`);
// a `ws.close` the operator writes itself (its browser gone, its start) is
// stamped at its take too, while what CDP still had of that socket is
// dropped — a close moves no boundary later, as on the operator's side
// (`ws/sockets.ts`). Before any is taken the boundary is unknown: the next
// connection's gap starts at the previous connection's end, as for the
// engine's own socket.
//
// What each event is:
// - `ws.open`/`ws.close`: the site socket's connection rows
//   (`ws/browser-source.ts`); a `ws.open` takes the loss marked before it.
// - `ws.in`: classified as the engine's own socket classifies (`connection.ts`).
//   The session's confirmation (`t:1`) verifies the connection, and the first
//   one asks for the gap's repair (`repair.ws-gap`) in the same transaction
//   — as the engine's own socket does at its first verified guard; a refused
//   authorization (`t:0`, 401) asks for `account.verify`; a pong and the
//   provider's errors are counted; a business frame is captured by its event
//   id (`captureBrowserWsFrame`: `browser:<buffer id>:<number>`, fenced by the
//   page and the session — the connection row its `ws.open` opened, open or
//   not), and after the commit goes to the live overlay as every captured
//   frame (`fansly_ws_decode_receipts`, the live applier, the worker timer).
//   A frame that cannot be kept — not JSON, or one the business traversal
//   refuses (more children than it reads) — is never acknowledged as if it
//   were: its loss is marked (`fansly.ws.frame.v1:refused`), its connection's
//   gap open again (`markBrowserWsLoss`, its `loss_since`) — or, its
//   connection unknown, the page's connection still open and the next one's
//   gap — and the repair asked for, in the same transaction.
// - `gap`: the operator lost or could not keep events from `fromWall` (plan
//   §4.4, step 6). The engine's own machinery backfills a socket's gap: the
//   next connection's `gap_since` (0196) is where its `repair.ws-gap` reads
//   back from. So the gap lowers the next connection's `gap_since` to its
//   boundary (kept in `events_gap_since` until a connection takes it); a
//   boundary the operator cannot name (`fromSeq`/`fromWall` null: nothing
//   before it in its buffer) is the loss boundary — and with none, the
//   previous connection's end, as for the engine's own socket. Every reason
//   is taken alike (`ws_reconnect`, `operator_start`, `chrome_restart`,
//   `buffer_full`, `disk_full`). A loss the intake finds itself — events the
//   operator no longer has, a new buffer's predecessor's untaken tail — also
//   opens the gap of the connection still open from the loss boundary (it may
//   never close in the stream): verified, its repair is asked for at once.
// - `site.response`: the site's answer, journaled in `observations`
//   (`browser_site`) by `browser-site-capture.ts`; a body the operator could
//   not take whole leaves a mark there, and — of the session the engine
//   trusts only — the reads that backfill it are asked for (`#backfillOf`:
//   the chat's head read for a head page — an older page is history, read
//   only for a request (I12), so its mark stays; the reply walk of a post of
//   the page's own; the polls of any other route). A body that did not
//   arrive whole over the link is not taken: the batch is cut before it, and
//   the operator sends it again.

/** The intake's timing. Production always uses the defaults; tests scale
 *  them. */
export interface BrowserIntakeTiming {
  /** A failed batch: subscribe again after these (the last one repeats). */
  retryMs: readonly number[];
  /** A batch cut before a body that did not arrive whole: subscribe again
   *  after this. */
  bodyRetryMs: number;
}

export const BROWSER_INTAKE_TIMING: Readonly<BrowserIntakeTiming> = Object.freeze({
  retryMs: [250, 1_000, 5_000, 15_000],
  bodyRetryMs: 1_000,
});

/** Committed batches kept for diagnostics (a ring: the newest). */
export const BROWSER_INTAKE_RECENT_BATCHES = 32;

/** Where a test may break the intake: inside the batch's transaction before
 *  its commit (it rolls back), after the commit before the ack, or the write
 *  of a halt (a plain error there is a write that failed). */
export type BrowserIntakeFaultPoint = "in_batch" | "after_commit" | "halt_write";
export type BrowserIntakeFaultHook = (point: BrowserIntakeFaultPoint) => void | Promise<void>;

/** Thrown by a test's fault hook: the intake stops as a process that died
 *  there would — nothing more is committed or acknowledged. */
export class BrowserIntakeCrash extends Error {
  constructor(readonly point: BrowserIntakeFaultPoint) {
    super(`simulated intake crash at ${point}`);
    this.name = "BrowserIntakeCrash";
  }
}

export interface BrowserIntakeDeps {
  db: Database;
  pageId: number;
  /** The page's owner generation: every batch commits under its fence. */
  generation: bigint;
  /** `pages.external_page_id`: the observations' native account ref. */
  ownRef: string | null;
  /** The page's operator link (shared with its transport). */
  client: PageBrowserRpcClient;
  /** The site socket's connection rows. */
  source: BrowserWsSource;
  /** The registry the demands (`repair.ws-gap`, `account.verify`, a poll's
   *  backfill) go through. */
  registry: EngineRegistry;
  logger: SyncLogger;
  metrics: Metrics;
  /** A captured frame, after its commit: its live overlay apply. Absent: the
   *  worker timer applies it. */
  applyLive?: (observationId: number) => void;
  /** TESTS ONLY. */
  timing?: Partial<BrowserIntakeTiming>;
  /** TESTS ONLY. */
  faults?: BrowserIntakeFaultHook;
}

/** What one committed batch did (tests, metrics). */
export interface BrowserIntakeBatch {
  bufferId: string;
  fromSeq: number;
  uptoSeq: number;
  frames: number;
  fenced: number;
  siteResponses: number;
  gaps: number;
  /** Frames the journal could not keep: losses on their connection. */
  lost: number;
}

interface Subscription {
  bufferId: string;
  /** The last number committed of `bufferId` (this subscription's start, then
   *  every batch's end). */
  committedSeq: number;
  /** The connection it was asked on. */
  epoch: number;
  /** No batch of it was taken yet: its first one may start past the event
   *  expected (events the operator no longer has — a gap). */
  first: boolean;
  /** The buffer the position named before this one (a volume made anew):
   *  its untaken tail is a loss since the loss boundary. */
  switchedFrom: string | null;
}

/** A frame's class, as the engine's own socket reads it (`connection.ts`). */
type FrameClass = ReturnType<typeof classifyFanslyWsFrame>;

const NIL_BUFFER = "00000000-0000-0000-0000-000000000000";
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function minDate(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** An event's instant as the database may take it (never in the future). */
function wallOf(event: BufferEvent, now: Date): Date {
  return new Date(Math.min(event.atWall, now.getTime()));
}

/** Does the event's instant bound a socket message missed after it (the
 *  loss boundary, above)? Only a socket's open and its frames: stamped by
 *  Chrome's own time of them, and told in their order. A close may be the
 *  operator's own, stamped at its take; a site's answer and a gap are. */
function boundsSocketLoss(event: BufferEvent): boolean {
  return event.kind === "ws.open" || event.kind === "ws.in";
}

export class BrowserBufferIntake {
  readonly #d: BrowserIntakeDeps;
  readonly #timing: BrowserIntakeTiming;
  #sub: Subscription | null = null;
  /** The operator named another buffer: start over with it. */
  #startOver: string | null = null;
  /** The buffer cannot be opened: subscribe again once the state says so. */
  #waitingForBuffer = false;
  #chain: Promise<void> = Promise.resolve();
  #retryTimer: NodeJS.Timeout | null = null;
  #failures = 0;
  #started = false;
  #stopped = false;
  #stopReason: string | null = null;
  /** A buffer nothing is taken of (as persisted; kept here too should the
   *  write fail). */
  #halted: string | null = null;
  /** A halt not written yet: nothing is subscribed until it is (fail
   *  closed — a restart reads the position without it). */
  #haltUnwritten: { bufferId: string; reason: string } | null = null;
  readonly #unlisten: Array<() => void> = [];
  #recent: BrowserIntakeBatch[] = [];
  #committedBatches = 0;

  constructor(deps: BrowserIntakeDeps) {
    this.#d = deps;
    this.#timing = { ...BROWSER_INTAKE_TIMING, ...deps.timing };
  }

  /** Why the intake stopped for good (a newer owner, a crash in a test);
   *  null while it runs. */
  get stopReason(): string | null {
    return this.#stopReason;
  }

  /** The newest committed batches, oldest first (diagnostics, tests). */
  get batches(): readonly BrowserIntakeBatch[] {
    return this.#recent;
  }

  /** How many batches this intake committed. */
  get committedBatches(): number {
    return this.#committedBatches;
  }

  /** The subscription now (tests, diagnostics). */
  get position(): { bufferId: string; committedSeq: number } | null {
    return this.#sub === null ? null : { bufferId: this.#sub.bufferId, committedSeq: this.#sub.committedSeq };
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    const client = this.#d.client;
    client.onEvents((delivered) => this.#enqueue(() => this.#take(delivered)));
    client.onEventsRefused((refused) => this.#enqueue(() => this.#refused(refused)));
    this.#unlisten.push(() => client.onEvents(null), () => client.onEventsRefused(null));
    this.#unlisten.push(client.onLink((status) => this.#onLink(status)));
    this.#unlisten.push(client.onState((state) => this.#onState(state)));
    const status = client.status;
    if (status.kind === "up") this.#onLink(status);
  }

  /** Stop taking events: what is being committed finishes; nothing more is
   *  asked. Never rejects. */
  async stop(): Promise<void> {
    this.#halt("stopped");
    await this.#chain.catch(() => undefined);
  }

  /** Every batch taken so far is committed and acknowledged (tests). */
  idle(): Promise<void> {
    return this.#chain.catch(() => undefined);
  }

  #halt(reason: string): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#stopReason = reason;
    this.#sub = null;
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    for (const unlisten of this.#unlisten.splice(0)) unlisten();
  }

  #enqueue(task: () => Promise<void>): void {
    if (this.#stopped) return;
    this.#chain = this.#chain.then(async () => {
      if (this.#stopped) return;
      try {
        await task();
      } catch (error) {
        if (error instanceof BrowserIntakeCrash) {
          this.#halt(`crash:${error.point}`);
          return;
        }
        this.#d.logger.warn({ pageId: this.#d.pageId, err: errorName(error) }, "Fansly sync browser intake: a step failed");
      }
    });
  }

  // ── the subscription ──────────────────────────────────────────────────────

  #onLink(status: LinkStatus): void {
    if (this.#stopped) return;
    if (status.kind !== "up") {
      // Whatever was sent on the connection that went comes again on the next.
      this.#sub = null;
      return;
    }
    this.#enqueue(() => this.#subscribe(`the link is up (buffer ${status.bufferId || "unknown"})`, status.bufferId));
  }

  #onState(state: State): void {
    if (this.#stopped || !this.#waitingForBuffer || state.stopReason === "buffer_unavailable") return;
    this.#waitingForBuffer = false;
    this.#enqueue(() => this.#subscribe("the operator's buffer opened", null));
  }

  /** Subscribe from the position committed (or start over with the buffer
   *  the operator named). `linkBufferId`: the buffer the link's hello
   *  named. */
  async #subscribe(why: string, linkBufferId: string | null): Promise<void> {
    const { client, pageId, logger } = this.#d;
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    // A halt is written before anything else is asked of the operator.
    if (!(await this.#persistHalt())) return;
    if (!client.up) return;
    let stored;
    try {
      stored = await readPageBrowserIntake(this.#d.db, pageId);
    } catch (error) {
      logger.warn({ pageId, err: errorName(error) }, "Fansly sync browser intake: the position does not read; subscribing again later");
      this.#retryLater();
      return;
    }
    if (stored === null) {
      logger.error({ pageId }, "Fansly sync browser intake: the page has no browser profile; its buffer is not taken");
      this.#retryLater();
      return;
    }
    const linkBuffer = linkBufferId !== null && UUID_TEXT.test(linkBufferId) ? linkBufferId : null;
    let bufferId: string;
    let afterSeq: number;
    let switchedFrom: string | null = null;
    if (this.#startOver !== null) {
      bufferId = this.#startOver;
      afterSeq = 0;
      switchedFrom = stored.bufferId !== bufferId ? stored.bufferId : null;
    } else if (stored.bufferId !== null && (linkBuffer === null || linkBuffer === stored.bufferId)) {
      bufferId = stored.bufferId;
      afterSeq = stored.ackedSeq;
    } else if (linkBuffer !== null) {
      // A buffer the engine never took, or another than the one it took (the
      // volume was made anew): from its first event.
      bufferId = linkBuffer;
      afterSeq = 0;
      switchedFrom = stored.bufferId;
    } else {
      // No buffer known yet: the operator names its own when it refuses.
      bufferId = NIL_BUFFER;
      afterSeq = 0;
    }
    const halted = this.#halted ?? stored.halted?.bufferId ?? null;
    if (halted !== null && bufferId === halted) {
      // Its history contradicts the engine's: never taken again, whatever its
      // numbers become. Another buffer of the operator is (a new hello).
      this.#sub = null;
      this.#startOver = null;
      this.#d.metrics.increment("sync_browser_buffer_halted", { pageId });
      logger.error({ pageId, bufferId, why }, "Fansly sync browser intake: the operator's buffer is halted (its history is not the engine's); nothing of it is taken until it names another");
      return;
    }
    this.#sub = { bufferId, committedSeq: afterSeq, epoch: client.epoch, first: true, switchedFrom };
    if (switchedFrom !== null) {
      this.#d.metrics.increment("sync_browser_buffer_switched", { pageId });
      logger.warn({ pageId, from: switchedFrom, to: bufferId }, "Fansly sync browser intake: another buffer of the operator; taken from its first event, the old one's untaken tail is a gap");
    }
    logger.info({ pageId, bufferId, afterSeq, why }, "Fansly sync browser intake: subscribing");
    if (!client.subscribe(bufferId, afterSeq)) this.#sub = null;
  }

  /** The halt written, or — while it cannot be — nothing subscribed at all,
   *  the write tried again on the retry ladder. True: nothing to write. */
  async #persistHalt(): Promise<boolean> {
    const unwritten = this.#haltUnwritten;
    if (unwritten === null) return true;
    const { pageId, logger } = this.#d;
    try {
      if (this.#d.faults !== undefined) await this.#d.faults("halt_write");
      await haltPageBrowserIntake(this.#d.db, { pageId, bufferId: unwritten.bufferId, reason: unwritten.reason });
      if (this.#haltUnwritten === unwritten) this.#haltUnwritten = null;
      return true;
    } catch (error) {
      if (error instanceof BrowserIntakeCrash) throw error;
      this.#d.metrics.increment("sync_browser_halt_unwritten", { pageId });
      logger.error({ pageId, bufferId: unwritten.bufferId, err: errorName(error) },
        "Fansly sync browser intake: the halt is not written; nothing is subscribed until it is");
      this.#sub = null;
      this.#retryLater();
      return false;
    }
  }

  #retryLater(ms?: number): void {
    if (this.#stopped || this.#retryTimer !== null) return;
    const ladder = this.#timing.retryMs;
    const wait = ms ?? ladder[Math.min(this.#failures, ladder.length - 1)] ?? 1_000;
    if (ms === undefined) this.#failures += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#enqueue(() => this.#subscribe("tried again", null));
    }, wait);
    this.#retryTimer.unref?.();
  }

  async #refused(refused: EventsRefused): Promise<void> {
    const { pageId, logger, metrics } = this.#d;
    const sub = this.#sub;
    metrics.increment("sync_browser_events_refused", { pageId, of: refused.of, reason: refused.reason });
    if (refused.of === "ack" && (sub === null || refused.givenBufferId !== sub.bufferId)) {
      // A late ack of another subscription's buffer: refused, as it must be.
      logger.debug({ pageId, givenBufferId: refused.givenBufferId, reason: refused.reason }, "Fansly sync browser intake: a late ack of another buffer was refused");
      return;
    }
    switch (refused.reason) {
      case "foreign_buffer":
        if (!UUID_TEXT.test(refused.bufferId)) {
          this.#waitingForBuffer = true;
          return;
        }
        this.#startOver = refused.bufferId;
        this.#sub = null;
        await this.#subscribe(`the operator's buffer is ${refused.bufferId}`, null);
        return;
      case "unavailable":
        // Subscribed again once the operator's state says the buffer opened.
        this.#sub = null;
        this.#waitingForBuffer = true;
        if (this.#d.client.state !== null && this.#d.client.state.stopReason !== "buffer_unavailable") {
          this.#waitingForBuffer = false;
          this.#retryLater();
        }
        return;
      case "ahead": {
        // The engine has more of this buffer than the buffer gave: not this
        // history (a file restored from before). Halted for good: once its
        // numbers grew past the position, a subscription would acknowledge
        // events the engine never took. Never retried; only another buffer
        // is taken (alert 2 `browser_buffer_halted` while it stands).
        this.#sub = null;
        this.#startOver = null;
        this.#halted = refused.bufferId;
        this.#haltUnwritten = { bufferId: refused.bufferId, reason: "ahead" };
        metrics.increment("sync_browser_buffer_ahead", { pageId });
        logger.error({ pageId, bufferId: refused.bufferId, givenSeq: refused.givenSeq },
          "Fansly sync browser intake: the operator's buffer is behind what the engine committed of it; halted, nothing of it is taken");
        await this.#persistHalt();
        return;
      }
      case "not_subscribed":
      case "beyond_sent":
        await this.#subscribe(`an ack was refused (${refused.reason})`, null);
        return;
    }
  }

  // ── a batch ───────────────────────────────────────────────────────────────

  async #take(delivered: DeliveredEvents): Promise<void> {
    const { pageId, metrics, logger, client } = this.#d;
    const sub = this.#sub;
    if (sub === null || delivered.epoch !== sub.epoch || delivered.bufferId !== sub.bufferId) {
      // Of another connection or another buffer: never taken, never acked.
      metrics.increment("sync_browser_events_dropped", { pageId, why: sub === null ? "no_subscription" : delivered.bufferId !== sub?.bufferId ? "buffer" : "connection" });
      return;
    }
    // In order, from the event after the last one committed.
    const fresh: BufferEvent[] = [];
    let expected = sub.committedSeq + 1;
    let hole = false;
    /** The subscription's first batch starts past the event expected: the
     *  operator no longer has the ones between. */
    let missing = false;
    for (const event of delivered.events) {
      if (event.seq <= sub.committedSeq) continue;
      if (event.seq !== expected) {
        if (sub.first && fresh.length === 0) missing = true;
        else {
          hole = true;
          break;
        }
      }
      fresh.push(event);
      expected = event.seq + 1;
    }
    if (fresh.length === 0) {
      if (hole) await this.#subscribe("a batch left a hole", null);
      else client.ack(sub.bufferId, sub.committedSeq);
      return;
    }
    if (missing) {
      metrics.increment("sync_browser_events_missing", { pageId });
      logger.error({ pageId, bufferId: sub.bufferId, expected: sub.committedSeq + 1, first: fresh[0]!.seq },
        "Fansly sync browser intake: the operator no longer has events after the last one committed; taken as a gap");
    }
    // A body that did not arrive whole: the batch is cut before its event,
    // which the operator sends again.
    let cut = false;
    const take: BufferEvent[] = [];
    for (const event of fresh) {
      if (event.kind === "site.response" && event.complete && delivered.bodies.get(event.body.bodyId)?.body == null) {
        cut = true;
        metrics.increment("sync_browser_body_incomplete", { pageId });
        logger.warn({ pageId, seq: event.seq, problem: delivered.bodies.get(event.body.bodyId)?.problem ?? "missing" },
          "Fansly sync browser intake: a site answer's body did not arrive whole; asked again");
        break;
      }
      take.push(event);
    }
    if (take.length > 0) {
      const committed = await this.#commit(sub, take, delivered, missing);
      if (!committed) return;
    }
    if (cut || hole) {
      this.#sub = null;
      this.#retryLater(cut ? this.#timing.bodyRetryMs : 0);
    }
  }

  /** One batch in one transaction, then its ack. False: nothing committed
   *  (subscribed again later). `missing`: events before the batch's first
   *  are gone at the operator — a loss since the loss boundary. */
  async #commit(sub: Subscription, events: readonly BufferEvent[], delivered: DeliveredEvents, missing: boolean): Promise<boolean> {
    const d = this.#d;
    const { pageId, metrics, logger } = d;
    const generations = new Map<number, string | null>();
    const now = new Date();
    const batch: BrowserIntakeBatch = { bufferId: sub.bufferId, fromSeq: events[0]!.seq, uptoSeq: events.at(-1)!.seq, frames: 0, fenced: 0, siteResponses: 0, gaps: 0, lost: 0 };
    const captured: number[] = [];
    const connections: Array<{ event: BufferEvent; taken: BrowserWsTaken }> = [];
    let result: { uptoSeq: number } | null;
    try {
      // A `ws.open`'s generation, on its own snapshot before the transaction.
      // None while the page exists (no proxy for a moment): the batch waits —
      // a connection of the page is never let go for a setting.
      for (const event of events) {
        if (event.kind === "site.response" && !event.complete) {
          // The session an incomplete answer came under: only the engine's
          // trusted one's asks for a backfill.
          generations.set(event.seq, await d.source.generationOf(event.sessionFingerprint));
          continue;
        }
        if (event.kind !== "ws.open") continue;
        const generation = await d.source.generationOf(event.sessionFingerprint);
        if (generation === null && await findPageById(d.db, pageId) !== null) throw new Error("page_browser_generation_unreadable");
        generations.set(event.seq, generation);
      }
      result = await d.db.transaction(async (raw) => {
        const tx = raw as unknown as Database;
        await lockOwnedPage(tx, { pageId, generation: d.generation, lock: "share" });
        const stored = await lockPageBrowserIntake(tx, pageId);
        if (stored === null) throw new Error("page_browser_missing");
        // The position under its row lock is the authority: what it has is
        // not taken twice.
        const storedSeq = stored.bufferId === sub.bufferId ? stored.ackedSeq : 0;
        /** The loss boundary: the latest socket open or frame taken. */
        let lossBoundary = stored.lastWall;
        let gapSince = stored.gapSince;
        const signals: DemandSignal[] = [];
        // The session the engine trusts: frames of another are kept, not applied.
        const trustedGeneration = (await getSyncPage(tx, pageId))?.credentialsGeneration ?? null;
        if ((sub.switchedFrom !== null && stored.bufferId === sub.switchedFrom) || (missing && events[0]!.seq > storedSeq + 1)) {
          // The old buffer's untaken tail, or events the operator no longer
          // has: lost since the last socket event taken. The next
          // connection's gap starts there; the connection still open (its
          // close may be among them) has its gap open again — verified,
          // repaired now.
          gapSince = minDate(gapSince, lossBoundary);
          if (lossBoundary !== null) {
            const open = await markBrowserWsLoss(tx, { pageId, browserConnectionId: null, since: lossBoundary });
            if (open?.verified === true) signals.push({ resource: "repair.ws-gap", demand: { reason: "browser_events_lost" } });
          }
        }
        /** The latest event of each connection in this batch: its proof of life. */
        const alive = new Map<string, Date>();
        let uptoSeq = storedSeq;
        for (const event of events) {
          if (event.seq <= storedSeq) continue;
          const at = wallOf(event, now);
          switch (event.kind) {
            case "ws.open": {
              const taken = await d.source.takeIn(tx, event, { generation: generations.get(event.seq) ?? null, gapSince });
              if (taken === "opened") gapSince = null;
              if (taken === "page_inactive") batch.fenced += 1;
              connections.push({ event, taken });
              break;
            }
            case "ws.close":
              connections.push({ event, taken: await d.source.takeIn(tx, event, { generation: null }) });
              break;
            case "ws.in": {
              alive.set(event.connectionId, maxDate(alive.get(event.connectionId) ?? null, at)!);
              const kind: FrameClass = classifyFanslyWsFrame(event.frame);
              metrics.increment("sync_browser_frames", { pageId, kind });
              if (kind === "session") {
                if (await verifyBrowserWsConnection(tx, { pageId, browserConnectionId: event.connectionId, at })) {
                  signals.push({ resource: "repair.ws-gap", demand: { reason: "ws_gap" } });
                }
              } else if (kind === "auth_refused") {
                signals.push({ resource: "account.verify", demand: { reason: "ws_auth_refused" } });
              } else if (kind === "business" || kind === "invalid") {
                let business: string | null = null;
                if (kind === "business") {
                  try {
                    business = businessFanslyWsFrame(event.frame);
                  } catch {
                    business = null;
                  }
                }
                if (business === null) {
                  // Not a frame the journal can keep (not JSON, more children
                  // than the traversal reads): never an acknowledgement of
                  // nothing. Its loss is marked (a fact without the frame,
                  // `fansly.ws.frame.v1:refused`) and repaired: its
                  // connection's gap opens again — or, its connection
                  // unknown (its `ws.open` lost), the page's connection still
                  // open, and the next one's gap starts no later.
                  batch.lost += 1;
                  metrics.increment("sync_browser_frames_lost", { pageId, kind });
                  logger.warn({ pageId, seq: event.seq, kind }, "Fansly sync browser intake: a frame the journal cannot keep; its loss is marked and repaired");
                  const mark = { connectionId: event.connectionId, seq: event.seq, class: kind, chars: event.frame.length, disposition: "not_kept_loss_repaired" };
                  await insertObservation(tx, {
                    source: "fansly_ws",
                    producer: "fansly:browser",
                    platform: "fansly",
                    accountId: pageId,
                    nativeAccountRef: d.ownRef,
                    kind: "fansly.ws.frame.v1:refused",
                    payload: mark,
                    payloadHash: createHash("sha256").update(JSON.stringify(mark)).digest(),
                    idempotencyKey: browserWsFrameKey(sub.bufferId, event.seq),
                    receivedAt: at,
                  });
                  let loss = await markBrowserWsLoss(tx, { pageId, browserConnectionId: event.connectionId, since: at });
                  if (loss === null) {
                    gapSince = minDate(gapSince, at);
                    loss = await markBrowserWsLoss(tx, { pageId, browserConnectionId: null, since: at });
                  }
                  if (loss?.verified === true) signals.push({ resource: "repair.ws-gap", demand: { reason: "browser_frame_lost" } });
                  break;
                }
                const frame = await captureBrowserWsFrame(tx, {
                  pageId,
                  browserConnectionId: event.connectionId,
                  bufferId: sub.bufferId,
                  seq: event.seq,
                  accountRef: d.ownRef,
                  // A NUL or an unpaired surrogate the journal cannot store
                  // is replaced, as the engine's codec does for every body:
                  // never a frame that stalls the stream.
                  frame: replaceJournalUnstorableText(business).value,
                  receivedAt: at,
                  trustedGeneration,
                });
                if (frame.kind === "captured") {
                  batch.frames += 1;
                  captured.push(frame.observationId);
                } else {
                  batch.fenced += 1;
                  metrics.increment("sync_browser_frames_fenced", { pageId, why: frame.kind === "kept" ? frame.why : frame.kind });
                }
              }
              break;
            }
            case "gap": {
              batch.gaps += 1;
              const boundary = event.fromWall === null ? lossBoundary : new Date(Math.min(event.fromWall, now.getTime()));
              gapSince = minDate(gapSince, boundary);
              metrics.increment("sync_browser_gaps", { pageId, reason: event.reason, boundary: event.fromWall === null ? "unknown" : "known" });
              logger.info({ pageId, reason: event.reason, fromSeq: event.fromSeq, boundary: boundary?.toISOString() ?? null },
                "Fansly sync browser intake: the operator marked a gap; the socket's next connection reads it back");
              break;
            }
            case "site.response": {
              const observation = siteResponseObservation({
                pageId,
                bufferId: sub.bufferId,
                event,
                body: event.complete ? delivered.bodies.get(event.body.bodyId)?.body ?? null : null,
              });
              if (observation === null) break;
              await insertObservation(tx, {
                source: observation.source,
                producer: observation.producer,
                platform: "fansly",
                accountId: pageId,
                nativeAccountRef: d.ownRef,
                kind: observation.kind,
                payload: observation.payload,
                payloadHash: observation.payloadHash,
                idempotencyKey: observation.idempotencyKey,
                receivedAt: at,
              });
              batch.siteResponses += 1;
              metrics.increment("sync_browser_site_responses", { pageId, as: observation.as });
              if (observation.as === "incomplete") {
                // Nothing is done for a session the engine does not trust:
                // what its request names may not be the page's.
                const trusted = trustedGeneration !== null && generations.get(event.seq) === trustedGeneration;
                const backfill = trusted ? await this.#backfillOf(tx, event) : { signals: [], why: "untrusted_session" };
                if (backfill.signals.length === 0) {
                  metrics.increment("sync_browser_site_unbackfilled", { pageId, route: event.route, why: backfill.why });
                  logger.warn({ pageId, route: event.route, seq: event.seq, why: backfill.why },
                    "Fansly sync browser intake: a site answer not kept whole is not backfilled; its mark stays");
                }
                signals.push(...backfill.signals);
              }
              break;
            }
          }
          if (boundsSocketLoss(event)) lossBoundary = maxDate(lossBoundary, at);
          uptoSeq = event.seq;
        }
        // All of it committed before (an ack that was lost): acknowledged
        // again, never past what this batch carried.
        if (uptoSeq === storedSeq) return { uptoSeq: Math.min(storedSeq, events.at(-1)!.seq) };
        for (const [browserConnectionId, at] of alive) await touchBrowserWsConnection(tx, { pageId, browserConnectionId, at });
        if (signals.length > 0) await this.#upsertDemands(tx, signals, now);
        await writePageBrowserIntake(tx, { profileId: stored.profileId, bufferId: sub.bufferId, ackedSeq: uptoSeq, lastWall: lossBoundary, gapSince });
        if (d.faults !== undefined) await d.faults("in_batch");
        return { uptoSeq };
      });
    } catch (error) {
      if (error instanceof BrowserIntakeCrash) throw error;
      if (error instanceof OwnershipLostError) {
        logger.warn({ pageId }, "Fansly sync browser intake: the page has a newer owner; the intake stops");
        this.#halt("ownership_lost");
        return false;
      }
      metrics.increment("sync_browser_batch_failed", { pageId, error: errorName(error) });
      // Past the retry ladder it is no blip: said loudly, never a silent stall.
      const log = this.#failures >= this.#timing.retryMs.length ? logger.error.bind(logger) : logger.warn.bind(logger);
      log({ pageId, fromSeq: batch.fromSeq, failures: this.#failures + 1, err: errorName(error) }, "Fansly sync browser intake: a batch did not commit; it comes again");
      this.#sub = null;
      this.#retryLater();
      return false;
    }
    this.#failures = 0;
    if (d.faults !== undefined) await d.faults("after_commit");
    if (this.#sub === sub) {
      sub.committedSeq = Math.max(sub.committedSeq, result.uptoSeq);
      sub.first = false;
      sub.switchedFrom = null;
      this.#startOver = null;
      d.client.ack(sub.bufferId, sub.committedSeq);
    }
    for (const { event, taken } of connections) d.source.committed(event, taken);
    for (const observationId of captured) d.applyLive?.(observationId);
    batch.uptoSeq = result.uptoSeq;
    this.#committedBatches += 1;
    this.#recent = [...this.#recent.slice(-(BROWSER_INTAKE_RECENT_BATCHES - 1)), batch];
    return true;
  }

  /** The reads whose own request backfills a site answer the operator
   *  could not keep (of the trusted session), by its route, path and query:
   *  a chat's head page — the chat's head read (`dm-messages.head`, down to
   *  the chain it knows); an older page of a chat (`before`) — none: the
   *  engine reads a chat's history only for a history request (I12, owner
   *  decision №2), so its mark stays, said so; a post's replies — the post's
   *  reply walk, only for a post of the page's own its queue holds; any
   *  other route — the polls that read it. */
  async #backfillOf(tx: Database, event: Extract<BufferEvent, { kind: "site.response" }>): Promise<{ signals: DemandSignal[]; why: string }> {
    const wire = isFanslyRoute(event.route) ? FANSLY_ROUTES.get(event.route)?.wire ?? null : null;
    if (wire === null) return { signals: [], why: "no_route" };
    const reason = "browser_site_incomplete";
    const query = new URLSearchParams(event.query.startsWith("?") ? event.query.slice(1) : event.query);
    if (wire === "messages.page") {
      const groupId = query.get("groupId");
      if (groupId === null || groupId === "") return { signals: [], why: "no_chat" };
      if (query.has("before")) return { signals: [], why: "history_read_by_request_only" };
      return { signals: [{ resource: "dm-messages.head", subject: groupId, demand: { reason } }], why: "head" };
    }
    if (wire === "post.replies") {
      const postId = /\/post\/([^/?#]+)\/replies/.exec(event.path)?.[1];
      if (postId === undefined) return { signals: [], why: "no_post" };
      if (!(await markPostRepliesDirty(tx, { pageId: this.#d.pageId, subjectRef: decodeURIComponent(postId), reason }))) {
        return { signals: [], why: "not_a_post_of_the_page" };
      }
      return { signals: [{ resource: "post-replies.walk", demand: { reason } }], why: "post_replies" };
    }
    const polls = this.#d.registry.specs
      .filter((spec) => spec.kind === "poll" && spec.operations?.includes(wire) === true)
      .map((spec) => ({ resource: spec.key, demand: { reason } }));
    return { signals: polls, why: polls.length === 0 ? "no_poll_reads_it" : "polls" };
  }

  async #upsertDemands(tx: Database, signals: readonly DemandSignal[], now: Date): Promise<void> {
    const page = await getSyncPage(tx, this.#d.pageId);
    const upserts: UpsertDemandInput[] = [];
    for (const signal of signals) {
      const spec = this.#d.registry.spec(signal.resource);
      if (spec === null) {
        this.#d.metrics.increment("sync_browser_demand_unknown_resource", { resource: signal.resource });
        continue;
      }
      const upsert = demandToUpsert(signal, spec, { pageId: this.#d.pageId, now, ...(page === null ? {} : { page }) });
      if (upsert !== null) upserts.push(upsert);
    }
    if (upserts.length > 0) await upsertDemands(tx, upserts);
  }
}
