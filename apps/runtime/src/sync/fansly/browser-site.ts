import type { AdmissionCancel, SiteAdmit, SiteAdmitResult, SiteDone, WsAdmit, WsDone } from "../../services/egress/page-browser-protocol.ts";
import type { SyncLogger } from "../engine/commit.ts";
import type { LinkStatus, MonoBridge, PageBrowserRpcClient, SiteObservedMessage } from "../../services/egress/page-browser-rpc.ts";
import { retryAfterDelayMs } from "../engine/errors.ts";
import type { Metrics, ObservedSiteKey, PendingSiteRequest, SiteAdmissionPort, SiteObservation, SiteRefusalReason, SiteRequestEnd } from "../engine/ports.ts";
import { classifySiteRequest } from "../engine/site-admission.ts";

// The site path of a browser page over its operator's RPC (Project Browser,
// plan §3.2 «Путь допуска для запросов, которые движок не выбирал сам»,
// §4.3, §4.13; spec §6.1; stage 3 PR 14): PR 8's admission port
// (`SiteAdmissionPort`, decided and journaled by `engine/site-admission.ts`
// and `engine/site-slot.ts`) on the operator's `siteAdmit`/`siteDone` and
// `wsAdmit`/`wsDone`.
//
// - A `siteAdmit` (a request of the site held paused) or a `wsAdmit` (the
//   site socket's CONNECT held at the proxy) is a pending request of the
//   page: its id, method, host class and path; asked when the operator
//   paused it (its own clock, moved to the engine's), so the engine's wait
//   (`SITE_WAIT_MS`) counts from there — and never past the operator's own
//   absolute deadline (`waitDeadlineMono`: a socket's counts from its
//   CONNECT, before the operator asks), which the choice reads and the grant
//   checks again right before it is answered: a request past it is refused
//   (`wait_expired`) and ends not sent. A socket is a GET of the socket host
//   (route `ws.upgrade`, as the engine's own socket's Upgrade). The manual
//   login is the operator's mode in its last `state`.
// - The same id asked again (the operator repeats it after a reconnect)
//   changes nothing: a request is admitted once — also once its end was
//   committed (the newest `SITE_IDS_REMEMBERED` ids are kept).
// - Nothing is pending before the operator's `quiesced` for this owner: the
//   previous owner's work is not known to be over (plan §4.7).
// - An admission is answered only on the connection it was asked on (the
//   operator refuses every admission asked on a connection that went). A
//   grant that cannot be written there never reached the browser: it ends
//   not sent. A request asked on a connection that went is dropped — the
//   operator asks again if it still holds it.
// - A request asked under another session than the operator's live one is
//   refused (`session_mismatch`): its answer would not be the session's the
//   engine judges.
// - The end (`siteDone`, `wsDone`) settles the admitted request; its instant
//   of sending (CLOCK_MONOTONIC) is moved to the engine's clock and rounded
//   up as the browser transport's (`SEND_REPORT_GUARD_MS`). An end whose
//   request this path does not wait for (after a restart) is not claimed:
//   the transport's held outcomes take it (PR 13). Once the actor committed
//   an end it came for, it is acknowledged (`resultAck`): until then the
//   operator keeps it.
// - A new page's browser (PR 16, `browser-onboarding.ts`): its link serves
//   the owner's login alone (`loginOnly`). Only the manual login's own
//   requests — the login operations and the reads its interface makes (every
//   API read the map opens), asked while the operator says it is in the
//   manual login — wait for the engine; every other request of the site and
//   every socket is refused (`mode`) at once.
// - Variant Б (minor 4): what the operator observed of the site's own
//   traffic goes to the actor (`onObserved`), each fact with its hop's key
//   and its ack. An operator of minor 6 names the key (`requestKey`, `hop`)
//   and keeps the fact until its `deliverySeq` is acknowledged — on the
//   connection it came on, once the actor committed it. An older one names
//   neither: a send's key is the engine's own (its id and send instant, so a
//   send told again after a reconnect is the same hop), an end or an
//   identity takes the key of its id's last send (the newest
//   `LEGACY_KEYS_KEPT`; one older is dropped, counted), and nothing is
//   acknowledged.

/** A reported send instant is taken this much later than the bridge says:
 *  the shift between the two clocks is read, not known, and the pause must
 *  never run from an instant before the true send (I1: a strict minimum).
 *  The browser transport's too. */
export const SEND_REPORT_GUARD_MS = 1;

/** Ids of finished requests kept, so that one asked again is not admitted
 *  a second time (spec §6.1: an id is never acted on twice). */
export const SITE_IDS_REMEMBERED = 4_096;

/** An operator before minor 6: the keys of the last sends by their id, for
 *  the ends and identities that follow them. */
export const LEGACY_KEYS_KEPT = 4_096;

/** The site's refusals as the protocol names them (spec §6.1 `siteAdmitResult`). */
type ProtocolSiteRefusal = Extract<SiteAdmitResult, { admit: false }>["reason"];

/** The engine's reason for refusing a site request, in the protocol's words. */
export function protocolSiteRefusal(reason: SiteRefusalReason | "session_mismatch"): ProtocolSiteRefusal {
  switch (reason) {
    case "waited_too_long":
      return "wait_expired";
    case "paused":
      return "paused";
    case "route_held":
      return "route_hold";
    case "hour_ceiling":
      return "site_hour_cap";
    case "session_mismatch":
      return "session_mismatch";
    case "credentials":
      return "credentials";
    case "held":
    case "lease":
      return "held";
    case "write":
    case "method":
    case "not_api_path":
    case "not_a_route":
    case "mode":
      return "mode";
  }
}

/** The class of a host the operator names (a host name, or the class
 *  itself), or null: not one the engine admits. */
export function siteHostClass(host: string): PendingSiteRequest["host"] | null {
  const name = host.toLowerCase();
  if (name === "api" || name === "ws" || name === "cdn") return name;
  if (!name.endsWith(".fansly.com")) return null;
  if (/^apiv\d+\.fansly\.com$/.test(name)) return "api";
  if (/^wsv\d+\.fansly\.com$/.test(name)) return "ws";
  if (/^cdn\d*\.fansly\.com$/.test(name)) return "cdn";
  return null;
}

/** A site request's or a site socket's end as the site path takes it. */
export function siteRequestEndOf(end: SiteDone | WsDone, bridge: MonoBridge, now: Date = new Date()): SiteRequestEnd {
  if (end.type === "wsDone" && end.fate === "unknown") {
    return { kind: "transport_error", sent: true, message: "the operator started again after the admission: whether the handshake went is not known" };
  }
  const sentMono = end.sentMono === null ? null : bridge.fromKernel(end.sentMono) + SEND_REPORT_GUARD_MS;
  if (!end.sent) return { kind: "aborted_before_send", reason: "not_sent" };
  if (end.status !== null) {
    const retryAfter = end.type === "siteDone" ? end.retryAfter : null;
    return { kind: "response", status: end.status, retryAfterMs: retryAfterDelayMs(retryAfter, null, now), sentMono };
  }
  const message = end.type === "siteDone" ? end.error?.message ?? "no answer" : end.error ?? "no answer";
  return { kind: "transport_error", sent: true, message, sentMono };
}

interface Entry {
  kind: "site" | "ws";
  request: PendingSiteRequest;
  /** The connection it was asked on. */
  epoch: number;
  state: "pending" | "granted" | "ended";
  attemptId: number | null;
  end: SiteRequestEnd | null;
  /** The operator's end came (its outcome is kept until `resultAck`). */
  reported: boolean;
  waiters: Array<(end: SiteRequestEnd) => void>;
}

export interface BrowserSiteAdmissionOptions {
  client: PageBrowserRpcClient;
  bridge: MonoBridge;
  /** The engine's monotonic clock (the pacer's). */
  monoNow: () => number;
  metrics?: Metrics;
  logger?: SyncLogger;
  /** A new page's browser (PR 16): only the manual login's own requests. */
  loginOnly?: boolean;
}

export class BrowserSiteAdmission implements SiteAdmissionPort {
  readonly #o: BrowserSiteAdmissionOptions;
  readonly #entries = new Map<string, Entry>();
  /** Finished ids, oldest first (bounded). */
  readonly #finished = new Set<string>();
  readonly #unlisten: Array<() => void> = [];
  #closed = false;
  #observed: ((event: SiteObservation) => void) | null = null;
  /** An operator before minor 6: the key of each id's last send, oldest first. */
  readonly #legacyKeys = new Map<string, ObservedSiteKey>();

  constructor(options: BrowserSiteAdmissionOptions) {
    this.#o = options;
    const client = options.client;
    client.onOtherMessage((message) => {
      if (message.type === "siteAdmit") this.#onSiteAdmit(message);
      else if (message.type === "wsAdmit") this.#onWsAdmit(message);
      else if (message.type === "admissionCancel") this.#onCancel(message);
    });
    client.onEnd((end) => this.#onEnd(end));
    client.onSiteObserved((message) => this.#onObservedMessage(message));
    this.#unlisten.push(() => client.onOtherMessage(null), () => client.onEnd(null), () => client.onSiteObserved(null));
    this.#unlisten.push(client.onLink((status) => this.#onLink(status)));
  }

  /** The requests waiting now, oldest first: none before the operator's
   *  `quiesced` for this owner, and only those of the current connection. */
  pending(): readonly PendingSiteRequest[] {
    const client = this.#o.client;
    if (this.#closed || client.quiesced === null || !client.up) return [];
    const epoch = client.epoch;
    return [...this.#entries.values()]
      .filter((entry) => entry.state === "pending" && entry.epoch === epoch)
      .map((entry) => entry.request)
      .sort((a, b) => a.askedMono - b.askedMono);
  }

  grant(id: string, admission: { attemptId: number; sendWithinMs: number }, request?: PendingSiteRequest): boolean {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.state !== "pending" || entry.epoch !== this.#o.client.epoch || (request !== undefined && entry.request !== request)) return false;
    const waitDeadline = entry.request.waitDeadlineMono;
    if (waitDeadline !== undefined && this.#o.monoNow() >= waitDeadline) {
      // Its wait ended between the choice and the grant: the browser fails
      // it; nothing goes under this admission.
      entry.state = "granted";
      entry.attemptId = admission.attemptId;
      this.#answerRefusal(entry, "wait_expired");
      this.#finish(entry, { kind: "aborted_before_send", reason: "wait_expired" });
      return true;
    }
    entry.state = "granted";
    entry.attemptId = admission.attemptId;
    const deadlineMono = this.#o.bridge.toKernel(this.#o.monoNow() + Math.max(0, admission.sendWithinMs));
    const written = entry.kind === "site"
      ? this.#o.client.answerSiteAdmit(entry.epoch, { siteRequestId: id, admit: true, deadlineMono, attemptId: admission.attemptId })
      : this.#o.client.answerWsAdmit(entry.epoch, { connectionId: id, admit: true, deadlineMono, attemptId: admission.attemptId });
    if (!written) {
      // The browser never got it: nothing can go under it.
      this.#o.metrics?.increment("sync_browser_site_grant_unsent", { kind: entry.kind });
      this.#finish(entry, { kind: "aborted_before_send", reason: "link_lost" });
    }
    return true;
  }

  refuse(id: string, reason: SiteRefusalReason, request?: PendingSiteRequest): void {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.state !== "pending" || (request !== undefined && entry.request !== request)) return;
    this.#entries.delete(id);
    this.#remember(id);
    this.#answerRefusal(entry, protocolSiteRefusal(reason));
  }

  end(id: string, signal: AbortSignal): Promise<SiteRequestEnd> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return Promise.resolve({ kind: "aborted_before_send", reason: "not_admitted" });
    if (entry.end !== null) return Promise.resolve(entry.end);
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      entry.waiters.push((end) => {
        signal.removeEventListener("abort", onAbort);
        resolve(end);
      });
    });
  }

  /** The actor committed the end of `id`: an end the operator reported is
   *  acknowledged (it keeps it until then). */
  settled(id: string, attemptId: number): void {
    const entry = this.#entries.get(id);
    if (entry !== undefined && entry.attemptId !== attemptId) return;
    this.#entries.delete(id);
    this.#remember(id);
    if (entry?.reported === true) this.#o.client.resultAck(attemptId);
  }

  /** Nothing more is taken; whoever waits for an end is told it was not
   *  heard (the safe upper bound, `siteEnd`). */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const unlisten of this.#unlisten.splice(0)) unlisten();
    for (const entry of this.#entries.values()) {
      for (const waiter of entry.waiters.splice(0)) waiter({ kind: "transport_error", sent: true, message: "the site path closed before the end" });
    }
    this.#entries.clear();
  }

  /** Variant Б: the site's own traffic an operator of minor 4 observed, on
   *  the engine's clocks (the actor counts it in the pause, journals it and
   *  holds routes on it). */
  onObserved(listener: ((event: SiteObservation) => void) | null): void {
    this.#observed = listener;
  }

  /** The hop a fact names, and its ack: an operator of minor 6's own key; an
   *  older one's, the engine's (null: an end or identity of an id whose send
   *  is not remembered). */
  #observedKey(message: SiteObservedMessage): { key: ObservedSiteKey; ack: () => void } | null {
    if (message.requestKey !== undefined && message.hop !== undefined) {
      const client = this.#o.client;
      const epoch = client.epoch;
      const deliverySeq = message.deliverySeq;
      return {
        key: { requestKey: message.requestKey, hop: message.hop },
        ack: () => {
          if (deliverySeq !== undefined) client.siteObservedAck(epoch, [deliverySeq]);
        },
      };
    }
    const ack = () => undefined;
    if (message.type === "siteSent") {
      // Its send instant as the operator wrote it: the same in every repeat.
      const key = { requestKey: `legacy:${message.siteRequestId}:${message.sentMono}`, hop: 0 };
      this.#legacyKeys.delete(message.siteRequestId);
      this.#legacyKeys.set(message.siteRequestId, key);
      if (this.#legacyKeys.size > LEGACY_KEYS_KEPT) this.#legacyKeys.delete(this.#legacyKeys.keys().next().value!);
      return { key, ack };
    }
    const key = this.#legacyKeys.get(message.siteRequestId);
    return key === undefined ? null : { key, ack };
  }

  #onObservedMessage(message: SiteObservedMessage): void {
    const listener = this.#observed;
    if (this.#closed || listener === null) return;
    const named = this.#observedKey(message);
    if (named === null) {
      this.#o.metrics?.increment("sync_site_observed_unkeyed", { type: message.type });
      return;
    }
    const bridge = this.#o.bridge;
    // Wall time of an engine-monotonic instant: now, moved back by how long ago it was.
    const wallOf = (engineMono: number) => new Date(Date.now() - Math.max(0, this.#o.monoNow() - engineMono));
    switch (message.type) {
      case "siteSent": {
        // Rounded late, as a reported end's: the pause never runs from before the send.
        const sentMono = Math.min(this.#o.monoNow(), bridge.fromKernel(message.sentMono) + SEND_REPORT_GUARD_MS);
        listener({
          ...named,
          kind: "sent",
          id: message.siteRequestId,
          method: message.method,
          host: message.host,
          path: message.path,
          route: message.route,
          sessionFingerprint: message.sessionFingerprint,
          sentMono,
          sentWall: wallOf(sentMono),
        });
        return;
      }
      case "siteEnded":
        listener({
          ...named,
          kind: "ended",
          id: message.siteRequestId,
          status: message.status,
          retryAfterMs: message.status === null ? null : retryAfterDelayMs(message.retryAfter, null, new Date()),
          error: message.error,
        });
        return;
      case "siteIdentity": {
        // A lower bound stays one: rounded early, never later than now.
        const at = Math.min(this.#o.monoNow(), bridge.fromKernel(message.sentNotBeforeMono) - SEND_REPORT_GUARD_MS);
        listener({
          ...named,
          kind: "identity",
          id: message.siteRequestId,
          accountId: message.accountId,
          sessionFingerprint: message.sessionFingerprint,
          sentNotBeforeWall: wallOf(at),
        });
        return;
      }
    }
  }

  // ── the operator's messages ──────────────────────────────────────────────

  #askedMono(kernelMono: number): number {
    return Math.min(this.#o.monoNow(), this.#o.bridge.fromKernel(kernelMono));
  }

  #manualLogin(): boolean {
    return this.#o.client.state?.mode === "manual_login";
  }

  #onCancel(message: AdmissionCancel): void {
    const entry = this.#entries.get(message.id);
    if (entry === undefined || entry.kind !== message.kind || entry.epoch !== this.#o.client.epoch) return;
    this.#o.logger?.info({ id: message.id, kind: message.kind, reason: message.reason, epoch: entry.epoch, state: entry.state }, "page browser: pending admission withdrawn");
    if (entry.state !== "pending") {
      // The grant crossed the withdrawal. Its ordinary, buffered end is
      // still required; never reclassify an already possible send here.
      return;
    }
    this.#entries.delete(message.id);
    this.#remember(message.id);
    this.#o.metrics?.increment("sync_browser_admission_cancelled", { kind: message.kind });
  }

  #remember(id: string): void {
    this.#finished.delete(id);
    this.#finished.add(id);
    if (this.#finished.size > SITE_IDS_REMEMBERED) this.#finished.delete(this.#finished.values().next().value!);
  }

  /** Asked before: pending, admitted, or finished. */
  #known(id: string): boolean {
    return this.#entries.has(id) || this.#finished.has(id);
  }

  #onSiteAdmit(message: SiteAdmit): void {
    if (this.#closed || this.#known(message.siteRequestId)) return;
    const epoch = this.#o.client.epoch;
    const host = siteHostClass(message.host);
    const entry: Entry = {
      kind: "site",
      request: {
        id: message.siteRequestId,
        method: message.method,
        host: host ?? "api",
        path: message.path,
        askedMono: this.#askedMono(message.pausedMono),
        waitDeadlineMono: this.#o.bridge.fromKernel(message.waitDeadlineMono),
        manualLogin: this.#manualLogin(),
      },
      epoch,
      state: "pending",
      attemptId: null,
      end: null,
      reported: false,
      waiters: [],
    };
    if (host === null) return this.#answerRefusal(entry, "mode");
    if (this.#o.loginOnly === true && !this.#ofTheLogin(entry.request)) return this.#answerRefusal(entry, "mode");
    if (this.#sessionDiffers(message.sessionFingerprint)) return this.#answerRefusal(entry, "session_mismatch");
    this.#entries.set(message.siteRequestId, entry);
  }

  /** A request of the manual login itself: a login operation, or a read its
   *  interface makes, asked in the manual login (`classifySiteRequest`). */
  #ofTheLogin(request: PendingSiteRequest): boolean {
    const classified = classifySiteRequest(request);
    return !("refuse" in classified) && classified.exempt;
  }

  #onWsAdmit(message: WsAdmit): void {
    if (this.#closed || this.#known(message.connectionId)) return;
    let path = "/";
    let hostOk: boolean;
    try {
      const url = new URL(message.url);
      path = url.pathname === "" ? "/" : url.pathname;
      hostOk = (url.protocol === "wss:" || url.protocol === "ws:") && siteHostClass(url.hostname) === "ws";
    } catch {
      hostOk = false;
    }
    const entry: Entry = {
      kind: "ws",
      request: {
        id: message.connectionId,
        method: "GET",
        host: "ws",
        path,
        askedMono: this.#askedMono(message.requestedMono),
        waitDeadlineMono: this.#o.bridge.fromKernel(message.waitDeadlineMono),
        manualLogin: this.#manualLogin(),
      },
      epoch: this.#o.client.epoch,
      state: "pending",
      attemptId: null,
      end: null,
      reported: false,
      waiters: [],
    };
    // Only the site's own socket host (the second socket, chatws, is closed);
    // none for a new page's login (`loginOnly`).
    if (!hostOk || this.#o.loginOnly === true) return this.#answerRefusal(entry, "mode");
    if (this.#sessionDiffers(message.sessionFingerprint)) return this.#answerRefusal(entry, "session_mismatch");
    this.#entries.set(message.connectionId, entry);
  }

  /** The request names a session, and it is not the operator's live one. */
  #sessionDiffers(fingerprint: string | null): boolean {
    if (fingerprint === null) return false;
    const live = this.#o.client.state?.sessionFingerprint ?? null;
    return live !== fingerprint;
  }

  #answerRefusal(entry: Entry, reason: ProtocolSiteRefusal): void {
    this.#o.metrics?.increment("sync_browser_site_refused", { kind: entry.kind, reason });
    if (entry.kind === "site") this.#o.client.answerSiteAdmit(entry.epoch, { siteRequestId: entry.request.id, admit: false, reason });
    else this.#o.client.answerWsAdmit(entry.epoch, { connectionId: entry.request.id, admit: false, reason, retryNotBeforeWall: null });
  }

  /** An end the operator reported: the site path's when it waits for it. */
  #onEnd(end: SiteDone | WsDone): boolean {
    const id = end.type === "siteDone" ? end.siteRequestId : end.connectionId;
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.attemptId !== end.attemptId || entry.kind !== (end.type === "siteDone" ? "site" : "ws")) return false;
    entry.reported = true;
    if (entry.state !== "ended") this.#finish(entry, siteRequestEndOf(end, this.#o.bridge));
    return true;
  }

  #finish(entry: Entry, end: SiteRequestEnd): void {
    entry.state = "ended";
    entry.end = end;
    for (const waiter of entry.waiters.splice(0)) waiter(end);
  }

  #onLink(status: LinkStatus): void {
    if (status.kind === "up") return;
    // What was asked on a connection that went is the operator's to ask
    // again; what was admitted waits for its end (the operator delivers it
    // to the next connection).
    for (const [id, entry] of this.#entries) if (entry.state === "pending") this.#entries.delete(id);
  }
}
