import type { SiteAdmit, SiteAdmitResult, SiteDone, WsAdmit, WsDone } from "../../services/egress/page-browser-protocol.ts";
import type { LinkStatus, MonoBridge, PageBrowserRpcClient } from "../../services/egress/page-browser-rpc.ts";
import { retryAfterDelayMs } from "../engine/errors.ts";
import type { Metrics, PendingSiteRequest, SiteAdmissionPort, SiteRefusalReason, SiteRequestEnd } from "../engine/ports.ts";

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
//   (`SITE_WAIT_MS`) counts from there. A socket is a GET of the socket host
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

/** A reported send instant is taken this much later than the bridge says:
 *  the shift between the two clocks is read, not known, and the pause must
 *  never run from an instant before the true send (I1: a strict minimum).
 *  The browser transport's too. */
export const SEND_REPORT_GUARD_MS = 1;

/** Ids of finished requests kept, so that one asked again is not admitted
 *  a second time (spec §6.1: an id is never acted on twice). */
export const SITE_IDS_REMEMBERED = 4_096;

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
}

export class BrowserSiteAdmission implements SiteAdmissionPort {
  readonly #o: BrowserSiteAdmissionOptions;
  readonly #entries = new Map<string, Entry>();
  /** Finished ids, oldest first (bounded). */
  readonly #finished = new Set<string>();
  readonly #unlisten: Array<() => void> = [];
  #closed = false;

  constructor(options: BrowserSiteAdmissionOptions) {
    this.#o = options;
    const client = options.client;
    client.onOtherMessage((message) => {
      if (message.type === "siteAdmit") this.#onSiteAdmit(message);
      else if (message.type === "wsAdmit") this.#onWsAdmit(message);
    });
    client.onEnd((end) => this.#onEnd(end));
    this.#unlisten.push(() => client.onOtherMessage(null), () => client.onEnd(null));
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

  grant(id: string, admission: { attemptId: number; sendWithinMs: number }): void {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.state !== "pending") return;
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
  }

  refuse(id: string, reason: SiteRefusalReason): void {
    const entry = this.#entries.get(id);
    if (entry === undefined || entry.state !== "pending") return;
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

  // ── the operator's messages ──────────────────────────────────────────────

  #askedMono(kernelMono: number): number {
    return Math.min(this.#o.monoNow(), this.#o.bridge.fromKernel(kernelMono));
  }

  #manualLogin(): boolean {
    return this.#o.client.state?.mode === "manual_login";
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
    if (this.#sessionDiffers(message.sessionFingerprint)) return this.#answerRefusal(entry, "session_mismatch");
    this.#entries.set(message.siteRequestId, entry);
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
      request: { id: message.connectionId, method: "GET", host: "ws", path, askedMono: this.#askedMono(message.requestedMono), manualLogin: this.#manualLogin() },
      epoch: this.#o.client.epoch,
      state: "pending",
      attemptId: null,
      end: null,
      reported: false,
      waiters: [],
    };
    // Only the site's own socket host (the second socket, chatws, is closed).
    if (!hostOk) return this.#answerRefusal(entry, "mode");
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
