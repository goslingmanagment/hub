import {
  captureBrowserWsFrame,
  getSyncPage,
  insertObservation,
  lockOwnedPage,
  lockPageBrowserIntake,
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
//   are a loss since the last event committed, taken as a gap, and the
//   stream goes on from what there is.
// - `events.refused`: another buffer (the volume was made anew) — the intake
//   starts over with the operator's buffer from its first event, and the
//   old buffer's untaken tail is a loss since the last event committed; a
//   buffer that cannot be opened — again once the operator's state says it
//   opened; a subscription ahead of the buffer (a file restored from before)
//   — nothing of that buffer is taken: its numbers are not this history's,
//   and keys would collide (logged, tried again rarely); an ack before the
//   subscription or past what it sent — subscribe again from the position.
// - Every batch commits under the page's owner generation (`lockOwnedPage`):
//   an intake of an earlier owner commits nothing and stops.
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
// - `gap`: the operator lost or could not keep events from `fromWall` (plan
//   §4.4, step 6). The engine's own machinery backfills a socket's gap: the
//   next connection's `gap_since` (0196) is where its `repair.ws-gap` reads
//   back from. So the gap lowers the next connection's `gap_since` to its
//   boundary (kept in `events_gap_since` until a connection takes it); a
//   boundary the operator cannot name (`fromSeq`/`fromWall` null: nothing
//   before it in its buffer) is the last event the engine committed of any
//   buffer (`events_last_wall`) — and with none, the previous connection's
//   end, as for the engine's own socket. Every reason is taken alike
//   (`ws_reconnect`, `operator_start`, `chrome_restart`, `buffer_full`,
//   `disk_full`).
// - `site.response`: the site's answer, journaled in `observations`
//   (`browser_site`) by `browser-site-capture.ts`; a body the operator could
//   not take whole leaves a mark there, and a poll of the registry that
//   reads the route is asked for (its own request backfills it). A body
//   that did not arrive whole over the link is not taken: the batch is cut
//   before it, and the operator sends it again.

/** The intake's timing. Production always uses the defaults; tests scale
 *  them. */
export interface BrowserIntakeTiming {
  /** A failed batch: subscribe again after these (the last one repeats). */
  retryMs: readonly number[];
  /** A batch cut before a body that did not arrive whole: subscribe again
   *  after this. */
  bodyRetryMs: number;
  /** A subscription refused as ahead of the buffer: tried again after this. */
  aheadRetryMs: number;
}

export const BROWSER_INTAKE_TIMING: Readonly<BrowserIntakeTiming> = Object.freeze({
  retryMs: [250, 1_000, 5_000, 15_000],
  bodyRetryMs: 1_000,
  aheadRetryMs: 10 * 60_000,
});

/** Where a test may break the intake: inside the batch's transaction before
 *  its commit (it rolls back), or after the commit before the ack. */
export type BrowserIntakeFaultPoint = "in_batch" | "after_commit";
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
   *  its untaken tail is a loss since the last event committed. */
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
  readonly #unlisten: Array<() => void> = [];
  /** Committed batches (tests, diagnostics). */
  readonly batches: BrowserIntakeBatch[] = [];

  constructor(deps: BrowserIntakeDeps) {
    this.#d = deps;
    this.#timing = { ...BROWSER_INTAKE_TIMING, ...deps.timing };
  }

  /** Why the intake stopped for good (a newer owner, a crash in a test);
   *  null while it runs. */
  get stopReason(): string | null {
    return this.#stopReason;
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
    this.#sub = { bufferId, committedSeq: afterSeq, epoch: client.epoch, first: true, switchedFrom };
    if (switchedFrom !== null) {
      this.#d.metrics.increment("sync_browser_buffer_switched", { pageId });
      logger.warn({ pageId, from: switchedFrom, to: bufferId }, "Fansly sync browser intake: another buffer of the operator; taken from its first event, the old one's untaken tail is a gap");
    }
    logger.info({ pageId, bufferId, afterSeq, why }, "Fansly sync browser intake: subscribing");
    if (!client.subscribe(bufferId, afterSeq)) this.#sub = null;
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
      case "ahead":
        // The engine has more of this buffer than the buffer gave: not this
        // history (a file restored from before). Nothing of it is taken — its
        // numbers would collide with the events committed.
        this.#sub = null;
        metrics.increment("sync_browser_buffer_ahead", { pageId });
        logger.error({ pageId, bufferId: refused.bufferId, givenSeq: refused.givenSeq },
          "Fansly sync browser intake: the operator's buffer is behind what the engine committed of it; nothing of it is taken");
        this.#retryLater(this.#timing.aheadRetryMs);
        return;
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
   *  are gone at the operator — a loss since the last event committed. */
  async #commit(sub: Subscription, events: readonly BufferEvent[], delivered: DeliveredEvents, missing: boolean): Promise<boolean> {
    const d = this.#d;
    const { pageId, metrics, logger } = d;
    const generations = new Map<number, string | null>();
    const now = new Date();
    const batch: BrowserIntakeBatch = { bufferId: sub.bufferId, fromSeq: events[0]!.seq, uptoSeq: events.at(-1)!.seq, frames: 0, fenced: 0, siteResponses: 0, gaps: 0 };
    const captured: number[] = [];
    const connections: Array<{ event: BufferEvent; taken: BrowserWsTaken }> = [];
    let result: { uptoSeq: number } | null;
    try {
      // A `ws.open`'s generation, on its own snapshot before the transaction.
      for (const event of events) {
        if (event.kind === "ws.open") generations.set(event.seq, await d.source.generationOf(event.sessionFingerprint));
      }
      result = await d.db.transaction(async (raw) => {
        const tx = raw as unknown as Database;
        await lockOwnedPage(tx, { pageId, generation: d.generation, lock: "share" });
        const stored = await lockPageBrowserIntake(tx, pageId);
        if (stored === null) throw new Error("page_browser_missing");
        // The position under its row lock is the authority: what it has is
        // not taken twice.
        const storedSeq = stored.bufferId === sub.bufferId ? stored.ackedSeq : 0;
        let lastWall = stored.lastWall;
        let gapSince = stored.gapSince;
        if ((sub.switchedFrom !== null && stored.bufferId === sub.switchedFrom) || (missing && events[0]!.seq > storedSeq + 1)) {
          // The old buffer's untaken tail, or events the operator no longer
          // has: lost since the last event taken.
          gapSince = minDate(gapSince, lastWall);
        }
        const signals: DemandSignal[] = [];
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
              } else if (kind === "business") {
                let business: string | null;
                try {
                  business = businessFanslyWsFrame(event.frame);
                } catch {
                  business = null;
                }
                if (business === null) {
                  batch.fenced += 1;
                  break;
                }
                const frame = await captureBrowserWsFrame(tx, {
                  pageId,
                  browserConnectionId: event.connectionId,
                  bufferId: sub.bufferId,
                  seq: event.seq,
                  accountRef: d.ownRef,
                  frame: business,
                  receivedAt: at,
                });
                if (frame.kind === "captured") {
                  batch.frames += 1;
                  captured.push(frame.observationId);
                } else {
                  batch.fenced += 1;
                  metrics.increment("sync_browser_frames_fenced", { pageId, why: frame.kind });
                }
              }
              break;
            }
            case "gap": {
              batch.gaps += 1;
              const boundary = event.fromWall === null ? lastWall : new Date(Math.min(event.fromWall, now.getTime()));
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
              if (observation.as === "incomplete") signals.push(...this.#backfillOf(event.route));
              break;
            }
          }
          lastWall = maxDate(lastWall, at);
          uptoSeq = event.seq;
        }
        // All of it committed before (an ack that was lost): acknowledged
        // again, never past what this batch carried.
        if (uptoSeq === storedSeq) return { uptoSeq: Math.min(storedSeq, events.at(-1)!.seq) };
        for (const [browserConnectionId, at] of alive) await touchBrowserWsConnection(tx, { pageId, browserConnectionId, at });
        if (signals.length > 0) await this.#upsertDemands(tx, signals, now);
        await writePageBrowserIntake(tx, { profileId: stored.profileId, bufferId: sub.bufferId, ackedSeq: uptoSeq, lastWall, gapSince });
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
      logger.warn({ pageId, fromSeq: batch.fromSeq, err: errorName(error) }, "Fansly sync browser intake: a batch did not commit; it comes again");
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
    this.batches.push(batch);
    return true;
  }

  /** The polls of the registry that read `route`: their own request
   *  backfills a site answer the operator could not keep. */
  #backfillOf(route: string): DemandSignal[] {
    const wire = isFanslyRoute(route) ? FANSLY_ROUTES.get(route)?.wire ?? null : null;
    if (wire === null) return [];
    return this.#d.registry.specs
      .filter((spec) => spec.kind === "poll" && spec.operations?.includes(wire) === true)
      .map((spec) => ({ resource: spec.key, demand: { reason: "browser_site_incomplete" } }));
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
