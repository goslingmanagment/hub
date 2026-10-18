// The site's own API traffic, observed — never paused, never refused (variant
// Б, plan-b-browser-host §4.1.2; Б-2a). Chrome lets the site's requests go as
// any browser does; their writes are stopped by the rules extension (DNR)
// and the exit's own rules, not here. From the Network domain this module:
//
// - tells the engine what left (`siteSent`, at Chrome's announcement of the
//   request's headers on the wire — `requestWillBeSentExtraInfo`) and how it
//   ended (`siteEnded`), so the engine counts the site's sends in the page's
//   pause and holds its own routes on the site's 429, 401 and 403;
// - learns the live session from the site's own authorized GETs (the same
//   `note` the paused path used: Hub's header template, the session shown);
// - keeps the platform data the site read: the body of a finished answer
//   (`Network.getResponseBody`) goes to the buffer as `site.response` with
//   attempt 0 — no engine attempt is behind it;
// - journals each request with its end.
//
// The site's socket's handshake is a send of the site's too (route
// `ws.upgrade`, Б-2d): ws/sockets.ts tells its send here from the proxy's
// write, under the tunnel's id; CDP gives the answer. It goes to the engine
// the same way, through the same outbox.
//
// Hub's own requests (its placeholder host, then its real one) are not the
// site's: the caller says which network ids are Hub's. Nor are the
// self-test's probes (selftest/probes.ts): the probe driver names its own by
// their network id, and they journal as the operator's probes — told to the
// engine as any request that left, should one leave, and said so. A request answered
// from a cache or a service worker never left: no `siteSent` (no
// `requestWillBeSentExtraInfo` comes for it).
//
// What the engine is told goes for sure (minor 6). Each request is named by a
// key minted when it is first followed (`requestKey`; a socket's handshake,
// its connection id) and the hop under it (`hop`: each redirect under the
// same network id the next), and each message by its delivery number
// (`deliverySeq`). An engine of minor 6 answers `siteObservedAck` once it
// committed what it was told; until then the observation stays in the
// outbox and goes again (`resend`, every `OBSERVED_RESEND_MS`; all of it on a
// new connection), oldest first. An end confirmed lets its send go too: the
// engine commits an end only after its send. An engine before minor 6 takes
// an observation as told once it is written (as before). The outbox keeps at
// most `OBSERVED_OUTBOX_MAX`; past it the oldest is dropped, counted
// (`state.siteObserved.dropped`) and logged.

import { randomUUID } from "node:crypto";

import type { CdpEvent, CdpPort } from "../cdp/client.ts";
import type { PausedRequest } from "../cdp/paused.ts";
import type { OperatorMode } from "../policy/operations.ts";
import { decide as mapDecide } from "../policy/operations.ts";
import type { OperatorToEngine, ResponseSource, SiteEnded, SiteSent } from "../rpc/protocol.ts";
import type { BodyWriter, SealedBody } from "../buffer/bodies.ts";
import type { GroupItem } from "../buffer/buffer.ts";
import { engineHeaders } from "../hub-requests/hub.ts";
import type { RequestLine } from "../logs/journal.ts";
import { monoMs, wallMs } from "../shared/util.ts";

/** Requests followed at most; the oldest is forgotten first. */
export const OBSERVED_KEPT = 2_048;
/** Unmatched ExtraInfo expires; unrelated hosts must not accumulate here. */
export const OBSERVED_EARLY_MS = 10_000;
/** Observations not confirmed yet, oldest first (at most two per followed
 *  request, and those the engine has not confirmed). */
export const OBSERVED_OUTBOX_MAX = OBSERVED_KEPT * 2;
/** An observation the engine has not confirmed this long after its write
 *  goes again. */
export const OBSERVED_RESEND_MS = 5_000;
/** At most this many go again at once (the oldest first). */
export const OBSERVED_RESEND_BATCH = 256;
/** The engine confirms what it commits (`siteObservedAck`) from this minor. */
export const OBSERVED_ACK_MINOR = 6;
/** A body larger than this is not kept whole (the engine backfills it). */
export const OBSERVED_BODY_MAX = 32 * 1024 * 1024;
/** Past any API request's own limit: a hung or lost end must not hold a restart. */
export const SITE_STALE_IN_FLIGHT_MS = 60_000;
/** The route of the site socket's handshake (the engine's catalogue). */
export const WS_UPGRADE_ROUTE = "ws.upgrade";
/** Socket handshakes followed at most (each ends within seconds). */
const SOCKETS_KEPT = 64;

const NO_SESSION = "0".repeat(64);

export interface SiteObserverDeps {
  cdp: Pick<CdpPort, "on" | "send">;
  /** The API host's class name in the map (`api`). */
  isApiHost: (host: string) => boolean;
  /** Network ids of Hub's own requests (its path decides those). */
  isHubRequest: (networkId: string) => boolean;
  /** The self-test probe a network id went as (its marker), or null. */
  probeOf?: (networkId: string) => string | null;
  mode: () => OperatorMode;
  link: {
    send: (message: OperatorToEngine) => boolean;
    /** The engine connected confirms what it committed (minor 6). */
    confirms: () => boolean;
  };
  session: {
    note: (request: PausedRequest) => void;
    fingerprint: () => string | null;
  };
  buffer: {
    beginBody(): BodyWriter | null;
    appendGroup(items: GroupItem[]): unknown;
    removeBody(bodyId: string): void;
  };
  journal: (line: RequestLine) => void;
  /** The login desk's word of the site's reads (status only). */
  readEnded?: (end: { route: string; status: number | null; sent: boolean; session: string | null }) => void;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

interface Observed {
  id: string;
  /** Minted when the request was first followed; the same over its redirects. */
  key: string;
  /** 0: as it first left; each redirect under its id the next. */
  hop: number;
  sessionId: string | null;
  frameId: string | null;
  method: string;
  url: URL;
  route: string;
  platformData: boolean;
  preflight: boolean;
  startedMono: number;
  sentMono: number | null;
  status: number | null;
  extraStatus: number | null;
  headers: Record<string, string>;
  source: ResponseSource;
  fingerprint: string | null;
}

interface RequestExtra {
  headers: Record<string, string>;
  sent: { mono: number; wall: number };
}

interface ResponseExtra {
  statusCode: number | null;
  headers: Record<string, string>;
}

interface EarlyInfo {
  request?: RequestExtra;
  response?: ResponseExtra;
  expires: NodeJS.Timeout;
}

interface QueuedObservation {
  message: SiteSent | SiteEnded;
  /** An end must still be understandable to an engine that started anew. */
  sent: SiteSent;
}

interface KeptObservation extends QueuedObservation {
  /** When it was kept (the age of what waits for the engine's word). */
  keptWall: number;
  /** When it was last written to the engine (null: not on this connection). */
  writtenMono: number | null;
}

/** What the outbox holds, for the operator's state (minor 6). */
export interface ObservedOutbox {
  unconfirmed: number;
  oldestAtWall: number | null;
  dropped: number;
}

export class SiteObserver {
  readonly #deps: SiteObserverDeps;
  readonly #requests = new Map<string, Observed>();
  readonly #early = new Map<string, EarlyInfo>();
  /** By delivery number, oldest first. */
  readonly #outbox = new Map<number, KeptObservation>();
  #nextSeq = 1;
  #dropped = 0;
  /** The site socket's handshakes told and not ended, by their id. */
  readonly #sockets = new Map<string, SiteSent>();
  #lastSend: { mono: number; wall: number } | null = null;

  constructor(deps: SiteObserverDeps) {
    this.#deps = deps;
    const cdp = deps.cdp;
    cdp.on("Network.requestWillBeSent", (event) => this.#onWillBeSent(event));
    cdp.on("Network.requestWillBeSentExtraInfo", (event) => this.#onExtraInfo(event));
    cdp.on("Network.responseReceived", (event) => this.#onResponse(event));
    cdp.on("Network.responseReceivedExtraInfo", (event) => this.#onResponseExtra(event));
    cdp.on("Network.loadingFinished", (event) => void this.#onFinished(event));
    cdp.on("Network.loadingFailed", (event) => this.#onFailed(event));
  }

  /** Chrome went: whatever was followed is gone with it — each one that left
   *  ends as a failure, never left flying in the engine's journal. */
  reset(why = "the page's browser went"): void {
    const followed = [...this.#requests.values()];
    this.#requests.clear();
    for (const r of followed) this.#abandon(r, why);
    for (const id of this.#early.keys()) this.#takeEarly(id);
  }

  /** The site's API requests seen to start, not to end (including lost ends). */
  get inFlight(): number {
    return this.#requests.size;
  }

  /** In flight and started at or after this instant on the operator's clock. */
  activeSince(minStartMono: number): number {
    let active = 0;
    for (const r of this.#requests.values()) if (r.startedMono >= minStartMono) active += 1;
    return active;
  }

  /** Kept across Chrome resets, like the gate's last send: a takeover floor. */
  get lastSend(): { mono: number; wall: number } | null {
    return this.#lastSend;
  }

  /** A new engine needs both the missed history and what is still flying:
   *  everything kept goes to it, and a send it was not told of yet. */
  linkChanged(up: boolean): void {
    if (!up) return;
    const queued = new Set<string>();
    for (const entry of this.#outbox.values()) {
      entry.writtenMono = null;
      if (entry.message.type === "siteSent") queued.add(hopKey(entry.message));
    }
    this.#flush();
    for (const r of this.#requests.values()) {
      if (r.sentMono === null) continue;
      const sent = this.#siteSent(r);
      if (!queued.has(hopKey(sent))) this.#send({ message: sent, sent });
    }
    for (const sent of this.#sockets.values()) if (!queued.has(hopKey(sent))) this.#send({ message: sent, sent });
  }

  /** The engine committed these (`siteObservedAck`): they go. An end lets
   *  its send go too — the engine commits an end only after its send. */
  confirmed(deliverySeqs: readonly number[]): void {
    for (const seq of deliverySeqs) {
      const entry = this.#outbox.get(seq);
      if (entry === undefined) continue;
      this.#outbox.delete(seq);
      if (entry.message.type !== "siteEnded") continue;
      const ended = hopKey(entry.message);
      for (const [other, kept] of this.#outbox) if (kept.message.type === "siteSent" && hopKey(kept.message) === ended) this.#outbox.delete(other);
    }
  }

  /** What the engine has not confirmed and was written long enough ago goes
   *  again, oldest first (the operator's timer). */
  resend(nowMono = monoMs()): void {
    if (!this.#deps.link.confirms()) return this.#flush();
    let budget = OBSERVED_RESEND_BATCH;
    for (const entry of this.#outbox.values()) {
      if (budget === 0) return;
      if (entry.writtenMono !== null && nowMono - entry.writtenMono < OBSERVED_RESEND_MS) continue;
      if (!this.#deps.link.send(entry.message)) return;
      entry.writtenMono = nowMono;
      budget -= 1;
    }
  }

  /** What waits for the engine's word (the operator's state, minor 6). */
  get outbox(): ObservedOutbox {
    const oldest = this.#outbox.values().next().value;
    return { unconfirmed: this.#outbox.size, oldestAtWall: oldest?.keptWall ?? null, dropped: this.#dropped };
  }

  /** The site socket's handshake left (ws/sockets.ts): a send of the site's
   *  (`ws.upgrade`), told as any. */
  socketSent(handshake: { id: string; url: URL; sentMono: number }): void {
    const sent: SiteSent = {
      type: "siteSent",
      siteRequestId: handshake.id,
      method: "GET",
      host: handshake.url.hostname,
      path: handshake.url.pathname,
      route: WS_UPGRADE_ROUTE,
      sessionFingerprint: this.#deps.session.fingerprint(),
      sentMono: handshake.sentMono,
      requestKey: handshake.id,
      hop: 0,
    };
    this.#sockets.delete(handshake.id);
    this.#sockets.set(handshake.id, sent);
    if (this.#sockets.size > SOCKETS_KEPT) this.socketEnded({ id: this.#sockets.keys().next().value!, status: null, error: "the operator followed too many handshakes" });
    this.#send({ message: sent, sent });
  }

  /** How the site socket's handshake ended: its answer (101 — it opened),
   *  or why it failed. */
  socketEnded(end: { id: string; status: number | null; error: string | null }): void {
    const sent = this.#sockets.get(end.id);
    if (sent === undefined) return;
    this.#sockets.delete(end.id);
    this.#send({ message: { type: "siteEnded", siteRequestId: end.id, endedMono: monoMs(), status: end.status, retryAfter: null, error: end.error, requestKey: end.id, hop: 0 }, sent });
  }

  #onWillBeSent(event: CdpEvent): void {
    const p = event.params as {
      requestId?: string;
      frameId?: string;
      type?: string;
      request?: { url?: string; method?: string };
      redirectResponse?: { status?: number };
    };
    const id = p.requestId;
    if (typeof id !== "string") return;
    const early = this.#takeEarly(id);
    const previous = this.#requests.get(id);
    /** A redirect's next hop keeps its request's key. */
    let redirected: { key: string; hop: number } | null = null;
    if (previous !== undefined) {
      // A redirect goes on under the same id: the hop before it ended with
      // its answer (no loadingFinished comes for it).
      this.#requests.delete(id);
      const hop = p.redirectResponse?.status;
      if (typeof hop === "number") {
        previous.status = hop;
        this.#ended(previous, null);
        redirected = { key: previous.key, hop: previous.hop + 1 };
      } else {
        this.#abandon(previous, "its request id came again");
      }
    }
    if (this.#deps.isHubRequest(id)) return;
    let url: URL;
    try {
      url = new URL(p.request?.url ?? "");
    } catch {
      return;
    }
    if (!this.#deps.isApiHost(url.hostname)) return;
    const method = (p.request?.method ?? "GET").toUpperCase();
    const verdict = mapDecide({ method, url: url.href, ...(typeof p.type === "string" ? { resourceType: p.type } : {}) }, this.#deps.mode());
    const route = "route" in verdict && typeof verdict.route === "string" ? verdict.route : "site.other";
    const platformData = "platformData" in verdict && verdict.platformData === true;
    const r: Observed = {
      id,
      key: redirected?.key ?? randomUUID(),
      hop: redirected?.hop ?? 0,
      sessionId: event.sessionId ?? null,
      frameId: typeof p.frameId === "string" ? p.frameId : null,
      method,
      url,
      route,
      platformData,
      preflight: method === "OPTIONS",
      startedMono: monoMs(),
      sentMono: null,
      status: null,
      extraStatus: null,
      headers: {},
      source: "network",
      fingerprint: null,
    };
    this.#requests.set(id, r);
    if (this.#requests.size > OBSERVED_KEPT) {
      const oldest = this.#requests.values().next().value!;
      this.#requests.delete(oldest.id);
      this.#abandon(oldest, "too many requests followed");
    }
    if (early?.response !== undefined) this.#responseExtra(r, early.response);
    if (early?.request !== undefined) this.#sent(r, early.request);
  }

  /** The headers as they went on the wire: the request left. */
  #onExtraInfo(event: CdpEvent): void {
    const p = event.params as { requestId?: string; headers?: Record<string, string> };
    if (typeof p.requestId !== "string" || this.#deps.isHubRequest(p.requestId)) return;
    const extra: RequestExtra = { headers: p.headers ?? {}, sent: { mono: monoMs(), wall: wallMs() } };
    const r = this.#requests.get(p.requestId);
    if (r === undefined) this.#earlyInfo(p.requestId).request ??= extra;
    else this.#sent(r, extra);
  }

  #sent(r: Observed, extra: RequestExtra): void {
    if (r.sentMono !== null) return;
    r.sentMono = extra.sent.mono;
    if (this.#lastSend === null || extra.sent.mono > this.#lastSend.mono) this.#lastSend = extra.sent;
    // HTTP/2 pseudo-headers describe the wire request, not XHR headers.
    const headers = Object.fromEntries(Object.entries(extra.headers).filter(([name]) => !name.startsWith(":")));
    if (!r.preflight) {
      // The live session, from the site's own request as it left.
      const request: PausedRequest = {
        requestId: `observed:${r.id}`,
        networkId: r.id,
        sessionId: r.sessionId,
        seq: 0,
        replayed: false,
        stage: "request",
        method: r.method,
        url: r.url.href,
        urlFragment: "",
        headers,
        resourceType: "XHR",
        frameId: r.frameId,
      } as PausedRequest;
      this.#deps.session.note(request);
    }
    r.fingerprint = this.#deps.session.fingerprint();
    const sent = this.#siteSent(r);
    this.#send({ message: sent, sent });
  }

  #siteSent(r: Observed): SiteSent {
    return {
      type: "siteSent",
      siteRequestId: r.id,
      method: r.method,
      host: r.url.hostname,
      path: r.url.pathname,
      route: r.route,
      sessionFingerprint: r.fingerprint,
      sentMono: r.sentMono!,
      requestKey: r.key,
      hop: r.hop,
    };
  }

  #onResponse(event: CdpEvent): void {
    const p = event.params as { requestId?: string; response?: { status?: number; headers?: Record<string, string>; fromDiskCache?: boolean; fromServiceWorker?: boolean; fromPrefetchCache?: boolean } };
    const r = typeof p.requestId === "string" ? this.#requests.get(p.requestId) : undefined;
    if (r === undefined) return;
    const response = p.response ?? {};
    r.status = r.extraStatus ?? (typeof response.status === "number" ? response.status : r.status);
    r.headers = { ...responseHeaders(response.headers ?? {}), ...r.headers };
    r.source = response.fromServiceWorker ? "service_worker" : response.fromDiskCache || response.fromPrefetchCache ? "cache_unconfirmed" : "network";
  }

  #onResponseExtra(event: CdpEvent): void {
    const p = event.params as { requestId?: string; statusCode?: number; headers?: Record<string, string> };
    if (typeof p.requestId !== "string" || this.#deps.isHubRequest(p.requestId)) return;
    const extra: ResponseExtra = { statusCode: p.statusCode ?? null, headers: p.headers ?? {} };
    const r = this.#requests.get(p.requestId);
    if (r === undefined) this.#earlyInfo(p.requestId).response = extra;
    else this.#responseExtra(r, extra);
  }

  #responseExtra(r: Observed, extra: ResponseExtra): void {
    if (typeof extra.statusCode === "number") r.status = r.extraStatus = extra.statusCode;
    r.headers = { ...r.headers, ...responseHeaders(extra.headers) };
  }

  #earlyInfo(id: string): EarlyInfo {
    const known = this.#early.get(id);
    if (known !== undefined) return known;
    const early: EarlyInfo = { expires: setTimeout(() => this.#early.delete(id), OBSERVED_EARLY_MS).unref() };
    this.#early.set(id, early);
    if (this.#early.size > OBSERVED_KEPT) this.#takeEarly(this.#early.keys().next().value!);
    return early;
  }

  #takeEarly(id: string): EarlyInfo | undefined {
    const early = this.#early.get(id);
    if (early !== undefined) {
      clearTimeout(early.expires);
      this.#early.delete(id);
    }
    return early;
  }

  /** Kept under its delivery number until the engine confirms it (an engine
   *  before minor 6: until it is written — at once, when nothing waits
   *  before it). */
  #send(entry: QueuedObservation): void {
    const deliverySeq = this.#nextSeq++;
    const message = { ...entry.message, deliverySeq };
    if (!this.#deps.link.confirms()) {
      this.#flush();
      if (this.#outbox.size === 0 && this.#deps.link.send(message)) return;
    }
    this.#outbox.set(deliverySeq, { message, sent: entry.sent, keptWall: wallMs(), writtenMono: null });
    if (this.#outbox.size > OBSERVED_OUTBOX_MAX) {
      const [oldest, dropped] = this.#outbox.entries().next().value!;
      this.#outbox.delete(oldest);
      this.#dropped += 1;
      this.#deps.log("observe.outbox_full", { kept: this.#outbox.size, dropped: this.#dropped, type: dropped.message.type, siteRequestId: dropped.message.siteRequestId, deliverySeq: oldest });
    }
    this.#flush();
  }

  /** What was not written on this connection goes, in order. To an engine
   *  before minor 6 an observation is told once written — an end after its
   *  send, so that one started anew understands it. */
  #flush(): void {
    const link = this.#deps.link;
    if (link.confirms()) {
      const now = monoMs();
      for (const entry of this.#outbox.values()) {
        if (entry.writtenMono !== null) continue;
        if (!link.send(entry.message)) return;
        entry.writtenMono = now;
      }
      return;
    }
    const announced = new Set<string>();
    for (const [seq, entry] of this.#outbox) {
      if (entry.message.type === "siteEnded" && !announced.has(hopKey(entry.message))) {
        if (!link.send(entry.sent)) return;
        announced.add(hopKey(entry.sent));
      }
      if (!link.send(entry.message)) return;
      if (entry.message.type === "siteSent") announced.add(hopKey(entry.message));
      this.#outbox.delete(seq);
    }
  }

  async #onFinished(event: CdpEvent): Promise<void> {
    const p = event.params as { requestId?: string; encodedDataLength?: number };
    const r = typeof p.requestId === "string" ? this.#requests.get(p.requestId) : undefined;
    if (r === undefined) return;
    this.#requests.delete(r.id);
    this.#ended(r, null, typeof p.encodedDataLength === "number" ? p.encodedDataLength : null);
    if (r.preflight || !r.platformData || r.status === null) return;
    await this.#keepBody(r, event.sessionId ?? r.sessionId);
  }

  #onFailed(event: CdpEvent): void {
    const p = event.params as { requestId?: string; errorText?: string; canceled?: boolean };
    const r = typeof p.requestId === "string" ? this.#requests.get(p.requestId) : undefined;
    if (r === undefined) return;
    this.#requests.delete(r.id);
    this.#ended(r, p.canceled ? "canceled" : (p.errorText ?? "failed"));
  }

  /** Followed no further: it ends as a failed load would — what Chrome showed
   *  of its answer kept, a 429 or 401 still holding — so its attempt never
   *  stays unfinished until the engine's next start. Not a read the login
   *  desk may take: its answer never came whole. */
  #abandon(r: Observed, why: string): void {
    this.#ended(r, `followed no further: ${why}`, null, false);
  }

  #ended(r: Observed, error: string | null, bytes: number | null = null, read = true): void {
    const sent = r.sentMono !== null;
    if (sent) {
      this.#send({
        message: {
          type: "siteEnded",
          siteRequestId: r.id,
          endedMono: monoMs(),
          status: r.status,
          retryAfter: header(r.headers, "retry-after"),
          error,
          requestKey: r.key,
          hop: r.hop,
        },
        sent: this.#siteSent(r),
      });
    }
    // A probe of the self-test is the operator's, not the site's: journaled
    // as its own — and one that went out says so.
    const probe = this.#deps.probeOf?.(r.id) ?? null;
    const result = error ?? (r.status === null ? "no answer" : `${r.status}${sent ? "" : " (not from the network)"}`);
    this.#deps.journal({
      method: r.method,
      host: r.url.hostname,
      path: r.url.pathname,
      resourceType: r.preflight ? "Preflight" : "XHR",
      admission: probe === null ? "observed (the site's own)" : `self-test probe ${probe} (the operator's own)`,
      decision: "ended",
      result: probe !== null && sent ? `${result}: the probe left the browser` : result,
      status: r.status,
      bytes,
      bytesSource: bytes === null ? null : "loading_finished",
    });
    if (read && !r.preflight) this.#deps.readEnded?.({ route: r.route, status: r.status, sent, session: r.fingerprint });
  }

  /** The answer's body, as Chrome kept it, to the buffer (attempt 0: the
   *  site's own, no engine attempt behind it). Not kept whole: the event says
   *  so and the engine backfills what the route allows. */
  async #keepBody(r: Observed, sessionId: string | null): Promise<void> {
    let text: string | null = null;
    let base64 = false;
    try {
      const got = await this.#deps.cdp.send<{ body?: string; base64Encoded?: boolean }>("Network.getResponseBody", { requestId: r.id }, sessionId ?? undefined);
      text = typeof got.body === "string" ? got.body : null;
      base64 = got.base64Encoded === true;
    } catch (error) {
      this.#deps.log("observe.body_unread", { siteRequestId: r.id, route: r.route, why: error instanceof Error ? error.message : String(error) });
    }
    const data = text === null ? null : Buffer.from(text, base64 ? "base64" : "utf8");
    const whole = data !== null && data.length <= OBSERVED_BODY_MAX;
    let sealed: SealedBody | null = null;
    if (whole) {
      const writer = this.#deps.buffer.beginBody();
      if (writer !== null) {
        try {
          sealed = writer.write(data) ? writer.seal() : null;
          if (sealed === null) writer.abandon();
        } catch (error) {
          writer.abandon();
          this.#deps.log("observe.body_unkept", { siteRequestId: r.id, why: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    const event = {
      kind: "site.response" as const,
      siteRequestId: r.id,
      attemptId: 0,
      route: r.route,
      method: r.method,
      path: r.url.pathname,
      query: r.url.search,
      status: r.status!,
      headers: engineHeaders(headerList(r.headers)),
      body: sealed === null ? { bodyId: randomUUID(), decodedBytes: 0, sha256: EMPTY_SHA256 } : { bodyId: sealed.bodyId, decodedBytes: sealed.bytes, sha256: sealed.sha256 },
      complete: sealed !== null,
      source: r.source,
      sessionFingerprint: r.fingerprint ?? NO_SESSION,
      requestKey: r.key,
      hop: r.hop,
    };
    const items: GroupItem[] = [{ event, at: { mono: monoMs(), wall: wallMs() }, ...(sealed === null ? {} : { body: { bodyId: sealed.bodyId, bytes: sealed.bytes } }) } as GroupItem];
    try {
      this.#deps.buffer.appendGroup(items);
    } catch (error) {
      if (sealed !== null) this.#deps.buffer.removeBody(sealed.bodyId);
      this.#deps.log("observe.response_unkept", { siteRequestId: r.id, why: error instanceof Error ? error.message : String(error) });
    }
  }
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** One hop of one request: its key and hop. */
function hopKey(message: SiteSent | SiteEnded): string {
  return `${message.requestKey ?? message.siteRequestId}#${message.hop ?? 0}`;
}

function header(headers: Record<string, string>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return null;
}

function responseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

/** CDP's response headers (repeats joined by a newline) as a list. */
function headerList(headers: Record<string, string>): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(headers)) for (const one of String(value).split("\n")) out.push({ name, value: one });
  return out;
}
