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
// Hub's own requests (its placeholder host, then its real one) are not the
// site's: the caller says which network ids are Hub's. A request answered
// from a cache or a service worker never left: no `siteSent` (no
// `requestWillBeSentExtraInfo` comes for it).

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
/** Undelivered observations, oldest first (at most two per followed request). */
export const OBSERVED_OUTBOX_MAX = OBSERVED_KEPT * 2;
/** A body larger than this is not kept whole (the engine backfills it). */
export const OBSERVED_BODY_MAX = 32 * 1024 * 1024;
/** Past any API request's own limit: a hung or lost end must not hold a restart. */
export const SITE_STALE_IN_FLIGHT_MS = 60_000;

const NO_SESSION = "0".repeat(64);

export interface SiteObserverDeps {
  cdp: Pick<CdpPort, "on" | "send">;
  /** The API host's class name in the map (`api`). */
  isApiHost: (host: string) => boolean;
  /** Network ids of Hub's own requests (its path decides those). */
  isHubRequest: (networkId: string) => boolean;
  mode: () => OperatorMode;
  link: { send: (message: OperatorToEngine) => boolean };
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

export class SiteObserver {
  readonly #deps: SiteObserverDeps;
  readonly #requests = new Map<string, Observed>();
  readonly #early = new Map<string, EarlyInfo>();
  readonly #outbox: QueuedObservation[] = [];
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

  /** A new engine needs both the missed history and what is still flying. */
  linkChanged(up: boolean): void {
    if (!up) return;
    const queued = new Set(this.#outbox.filter((entry) => entry.message.type === "siteSent").map((entry) => entry.message.siteRequestId));
    this.#flush();
    for (const r of this.#requests.values()) {
      if (r.sentMono === null || queued.has(r.id)) continue;
      const sent = this.#siteSent(r);
      this.#send({ message: sent, sent });
    }
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
    if (previous !== undefined) {
      // A redirect goes on under the same id: the hop before it ended with
      // its answer (no loadingFinished comes for it).
      this.#requests.delete(id);
      const hop = p.redirectResponse?.status;
      if (typeof hop === "number") {
        previous.status = hop;
        this.#ended(previous, null);
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

  #send(entry: QueuedObservation): void {
    this.#flush();
    if (this.#outbox.length === 0 && this.#deps.link.send(entry.message)) return;
    this.#outbox.push(entry);
    if (this.#outbox.length > OBSERVED_OUTBOX_MAX) {
      this.#outbox.shift();
      this.#deps.log("observe.outbox_full", { kept: this.#outbox.length });
    }
  }

  #flush(): void {
    const announced = new Set<string>();
    while (this.#outbox.length > 0) {
      const entry = this.#outbox[0]!;
      if (entry.message.type === "siteEnded" && !announced.has(entry.message.siteRequestId)) {
        if (!this.#deps.link.send(entry.sent)) return;
        announced.add(entry.sent.siteRequestId);
      }
      if (!this.#deps.link.send(entry.message)) return;
      if (entry.message.type === "siteSent") announced.add(entry.message.siteRequestId);
      this.#outbox.shift();
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
        },
        sent: this.#siteSent(r),
      });
    }
    this.#deps.journal({
      method: r.method,
      host: r.url.hostname,
      path: r.url.pathname,
      resourceType: r.preflight ? "Preflight" : "XHR",
      admission: "observed (the site's own)",
      decision: "ended",
      result: error ?? (r.status === null ? "no answer" : `${r.status}${sent ? "" : " (not from the network)"}`),
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
