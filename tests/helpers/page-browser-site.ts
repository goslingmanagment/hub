import type { ApiGate } from "../../apps/page-browser/src/egress/gate.ts";
import type { CdpCommand, FakeCdpPort } from "./page-browser-fakes.ts";

// The site's own requests as Chrome shows them over CDP (Project Browser PR
// 7): a request — and its CORS preflight — paused in Fetch, the Network
// events of its tab, the body's stream (armed or not, at either stage), and
// the proxy's view of the API's tunnels through the real gate: `wire` is
// what physically left (what the gate let up).

/** What one request of the site does. */
export interface SiteScript {
  /** A CORS preflight first, answered with this status. */
  preflight?: number;
  /** The preflight's answer comes this long after it went. */
  preflightDelayMs?: number;
  /** The request pauses this long after its preflight was handed on. */
  mainDelayMs?: number;
  status?: number;
  headers?: Array<{ name: string; value: string }>;
  /** The body in chunks; its content-length is declared unless `chunked`. */
  chunks?: Buffer[];
  chunked?: boolean;
  contentLength?: number;
  /** Chrome's moment of the send (null: no timing). */
  timing?: { requestTime: number; sendStart: number } | null;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  wireStatus?: number;
  /** The request opens a new connection (one per window). */
  newTunnel?: boolean;
  /** What happens after the release. */
  then?: "answer" | "hang_before_send" | "hang_after_send" | "fail_before_send" | "fail_after_send" | "cancel_after_send" | "body_fails" | "cancel_after_answer" | "retry";
  /** Chunks without their data (the stream not armed). */
  unstreamed?: boolean;
  /** Chrome tells of bytes received but of no decoded data at all (the
   *  site's service worker passes the answer on: its own request reads
   *  nothing, the page's — which never stops in Fetch — gets the body). */
  deliversNothing?: boolean;
  brokenChunk?: boolean;
  chunkDelayMs?: number;
  /** Network.requestWillBeSent comes this long after the pause (the
   *  sessions' order is not guaranteed). */
  willBeSentDelayMs?: number;
  /** No Network.requestWillBeSent at all. */
  noWillBeSent?: boolean;
  /** Network.streamResourceContent fails at the request stage. */
  armFailsAtRequest?: boolean;
}

export interface SiteWire {
  role: "preflight" | "main";
  method: string;
  url: string;
}

export interface SiteModelRequest {
  role: "preflight" | "main";
  interceptionId: string;
  networkId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  script: SiteScript;
  stage: "request" | "response";
  outcome: "paused" | "continued" | "failed" | "fulfilled";
  failReason?: string;
  interceptResponse: boolean;
  ended: boolean;
  tunnel: number | null;
  sendCount: number;
  /** The stage its body's stream was armed at (null: not armed). */
  armedAt: "request" | "response" | null;
  main: SiteModelRequest | null;
  frameId: string;
  loaderId: string;
  session: string;
}

export class SiteChrome {
  readonly cdp: FakeCdpPort;
  readonly gate: ApiGate;
  readonly session = "S1";
  readonly requests: SiteModelRequest[] = [];
  readonly wire: SiteWire[] = [];
  /** What the page read of each answer (the bytes it got). */
  readonly pageRead = new Map<string, Buffer>();
  /** Preflights continued without their answer handed on by fulfill (what
   *  Chrome 155 may kill its network service on). */
  unfulfilledPreflights = 0;
  #n = 0;
  #tunnels = 100;

  constructor(cdp: FakeCdpPort, gate: ApiGate) {
    this.cdp = cdp;
    this.gate = gate;
    cdp.handlers.set("Fetch.continueRequest", (command) => this.#continue(command));
    cdp.handlers.set("Fetch.continueResponse", (command) => this.#continueResponse(command));
    cdp.handlers.set("Fetch.fulfillRequest", (command) => this.#fulfill(command));
    cdp.handlers.set("Fetch.failRequest", (command) => this.#failCommand(command));
    cdp.handlers.set("Network.streamResourceContent", (command) => {
      const request = this.requests.find((entry) => entry.networkId === command.params.requestId);
      if (!request) return { error: { code: -32602, message: "Request with the provided ID does not exists" } };
      if (command.sessionId !== request.session) return { error: { code: -32602, message: "Request with the provided ID does not exists" } };
      if (request.stage === "request" && request.script.armFailsAtRequest) return { error: { code: -32602, message: "Request with the provided ID does not exists" } };
      request.armedAt ??= request.stage;
      return { bufferedData: "" };
    });
  }

  /** A request of the site's own, paused in Fetch (its preflight first when
   *  the script says). */
  request(url: string, options: { method?: string; headers?: Record<string, string>; script?: SiteScript; resourceType?: string; frameId?: string; loaderId?: string; session?: string; postData?: string } = {}): SiteModelRequest {
    const n = ++this.#n;
    const method = options.method ?? "GET";
    const script = options.script ?? {};
    const main: SiteModelRequest = {
      role: "main",
      interceptionId: `I-${n}`,
      networkId: `R-${n}`,
      url,
      method,
      headers: options.headers ?? {},
      script,
      stage: "request",
      outcome: "paused",
      interceptResponse: false,
      ended: false,
      tunnel: null,
      sendCount: 0,
      armedAt: null,
      main: null,
      frameId: options.frameId ?? "F1",
      loaderId: options.loaderId ?? "L1",
      session: options.session ?? this.session,
    };
    this.requests.push(main);
    const resourceType = options.resourceType ?? "XHR";
    if (script.preflight !== undefined) {
      const preflight: SiteModelRequest = { ...main, role: "preflight", interceptionId: `I-${n}p`, networkId: `P-${n}`, method: "OPTIONS", headers: { "Access-Control-Request-Method": method, "Access-Control-Request-Headers": "authorization,fansly-client-id" }, main };
      this.requests.push(preflight);
      this.#willBeSent(preflight, { type: "preflight", requestId: main.networkId }, "");
      this.#willBeSent(main, { type: "script" }, main.loaderId);
      // Chrome 155 pauses a preflight with its request's resource type.
      this.#pause(preflight, resourceType);
      (main as SiteModelRequest & { resourceType?: string }).resourceType = resourceType;
      return main;
    }
    this.#willBeSent(main, { type: "script" }, main.loaderId);
    this.#pause(main, resourceType, options.postData);
    return main;
  }

  preflightOf(main: SiteModelRequest): SiteModelRequest | undefined {
    return this.requests.find((entry) => entry.main === main);
  }

  /** A frame commits a new document. */
  navigate(frameId: string, loaderId: string, url = "https://fansly.com/"): void {
    this.cdp.emit("Page.frameNavigated", { frame: { id: frameId, url, loaderId } }, this.session);
  }

  /** The API's tunnels are cut: what is in flight there fails. */
  cut(): number {
    let cut = 0;
    for (const request of this.requests) {
      if (!request.outcome.startsWith("continued") || request.ended) continue;
      cut += 1;
      this.#end(request, "net::ERR_CONNECTION_CLOSED", false);
    }
    return cut;
  }

  #willBeSent(request: SiteModelRequest, initiator: Record<string, unknown>, loaderId: string): void {
    if (request.script.noWillBeSent) return;
    const emit = () => this.cdp.emit("Network.requestWillBeSent", { requestId: request.networkId, loaderId, request: { url: request.url, method: request.method }, initiator }, request.session);
    if (request.script.willBeSentDelayMs) setTimeout(emit, request.script.willBeSentDelayMs);
    else emit();
  }

  #pause(request: SiteModelRequest, resourceType: string, postData?: string): void {
    this.cdp.emit("Fetch.requestPaused", {
      requestId: request.interceptionId,
      networkId: request.networkId,
      request: { url: request.url, method: request.method, headers: request.headers, ...(postData !== undefined ? { hasPostData: true, postDataEntries: [{ bytes: Buffer.from(postData).toString("base64") }] } : {}) },
      resourceType,
      frameId: request.frameId,
    });
  }

  #byInterception(id: unknown): SiteModelRequest | undefined {
    return this.requests.find((request) => request.interceptionId === id && !request.ended && (request.outcome === "paused" || request.stage === "response"));
  }

  #continue(command: CdpCommand): unknown {
    const request = this.#byInterception(command.params.requestId);
    if (!request || request.stage !== "request" || request.outcome !== "paused") return { error: { code: -32602, message: "Invalid InterceptionId." } };
    request.outcome = "continued";
    request.interceptResponse = command.params.interceptResponse === true;
    setImmediate(() => this.#afterRelease(request));
    return {};
  }

  /** The request's records through the gate: "up", "held", or "refused"
   *  (no new tunnel in this window). */
  #write(request: SiteModelRequest): "up" | "held" | "refused" {
    // Only the API's tunnels are under the gate.
    if (new URL(request.url).hostname !== "apiv3.fansly.com") {
      request.sendCount += 1;
      this.wire.push({ role: request.role, method: request.method, url: request.url });
      return "up";
    }
    let tunnel = request.tunnel ?? 1;
    if (request.script.newTunnel && request.tunnel === null) {
      if (!this.gate.admitsTunnel()) return "refused";
      tunnel = ++this.#tunnels;
      this.gate.noteTunnel(tunnel);
      this.gate.record(tunnel, true, false, true); // ClientHello
      for (let i = 0; i < 2; i++) {
        if (this.gate.record(tunnel, true, true, true) !== "up") return "held"; // Finished, preface
        this.gate.recordDone(tunnel);
      }
    }
    request.tunnel = tunnel;
    if (this.gate.record(tunnel, true, true, true) !== "up") {
      this.gate.noteHeld(tunnel, 90);
      return "held";
    }
    this.gate.recordDone(tunnel);
    request.sendCount += 1;
    this.wire.push({ role: request.role, method: request.method, url: request.url });
    return "up";
  }

  #afterRelease(request: SiteModelRequest): void {
    if (request.ended) return;
    const script = request.script;
    const then = script.then ?? "answer";
    if (then === "fail_before_send") return this.#end(request, "net::ERR_TUNNEL_CONNECTION_FAILED", false);
    if (then === "hang_before_send") return;
    const went = this.#write(request);
    if (went === "refused") return this.#end(request, "net::ERR_TUNNEL_CONNECTION_FAILED", false);
    if (went === "held") return;
    this.cdp.emit("Network.requestWillBeSentExtraInfo", { requestId: request.networkId, headers: Object.fromEntries(Object.keys(request.headers).map((name) => [name.toLowerCase(), "v"])) }, request.session);
    if (then === "retry" && request.role === "main") {
      // The server refuses the stream; Chrome repeats on the same connection.
      this.gate.noteServerBytes(request.tunnel ?? 1);
      this.#write(request);
      return;
    }
    if (then === "hang_after_send" && request.role === "main") return;
    if (then === "fail_after_send" && request.role === "main") return this.#end(request, "net::ERR_CONNECTION_RESET", false);
    if (then === "cancel_after_send" && request.role === "main") return this.#end(request, "net::ERR_ABORTED", true);
    if (!request.interceptResponse) {
      // Not asked to stop at its headers: the answer goes straight on.
      if (request.role === "preflight") {
        request.outcome = "continued";
        request.ended = true;
        this.unfulfilledPreflights += 1;
        setImmediate(() => {
          if (request.main && !request.main.ended) this.#pause(request.main, (request.main as SiteModelRequest & { resourceType?: string }).resourceType ?? "XHR");
        });
        return;
      }
      request.stage = "response";
      this.#responseReceived(request, script.status ?? 200);
      void this.#body(request);
      return;
    }
    request.stage = "response";
    if (request.role === "preflight") {
      setTimeout(() => {
        if (request.ended) return;
        this.cdp.emit("Fetch.requestPaused", {
          requestId: request.interceptionId,
          networkId: request.networkId,
          request: { url: request.url, method: "OPTIONS", headers: request.headers },
          resourceType: "XHR",
          responseStatusCode: script.preflight ?? 204,
          responseStatusText: "No Content",
          responseHeaders: [{ name: "access-control-allow-origin", value: "https://fansly.com" }, ...(script.headers ?? []).filter((entry) => entry.name.toLowerCase() === "retry-after")],
        });
      }, script.preflightDelayMs ?? 0);
      return;
    }
    const body = Buffer.concat(script.chunks ?? [Buffer.from('{"success":true,"response":[]}')]);
    const headers = [...(script.headers ?? [{ name: "content-type", value: "application/json" }])];
    if (!script.chunked) headers.push({ name: "content-length", value: String(script.contentLength ?? body.length) });
    this.cdp.emit("Fetch.requestPaused", {
      requestId: request.interceptionId,
      networkId: request.networkId,
      request: { url: request.url, method: request.method, headers: request.headers },
      resourceType: "XHR",
      responseStatusCode: script.status ?? 200,
      responseStatusText: "OK",
      responseHeaders: headers,
    });
  }

  #responseReceived(request: SiteModelRequest, status: number): void {
    const script = request.script;
    const timing = script.timing === undefined ? { requestTime: 2000 + this.#n, sendStart: request.role === "preflight" ? 1.5 : 2.5 } : script.timing;
    this.cdp.emit(
      "Network.responseReceived",
      {
        requestId: request.networkId,
        response: {
          status,
          ...(timing ? { timing: { requestTime: timing.requestTime, sendStart: timing.sendStart } } : {}),
          fromDiskCache: script.fromDiskCache === true,
          fromServiceWorker: script.fromServiceWorker === true,
          connectionReused: true,
        },
      },
      request.session,
    );
    if (request.role === "main") this.cdp.emit("Network.responseReceivedExtraInfo", { requestId: request.networkId, statusCode: script.wireStatus ?? status }, request.session);
  }

  #fulfill(command: CdpCommand): unknown {
    const request = this.#byInterception(command.params.requestId);
    if (!request) return { error: { code: -32602, message: "Invalid InterceptionId." } };
    request.outcome = "fulfilled";
    request.ended = true;
    if (request.role !== "preflight") {
      // A request answered here (a redirect made final): its end follows.
      this.#responseReceived(request, Number(command.params.responseCode));
      setImmediate(() => this.cdp.emit("Network.loadingFinished", { requestId: request.networkId, encodedDataLength: 120 }, request.session));
      return {};
    }
    // Chrome 155 tells nothing more of a preflight handed on by fulfill —
    // no responseReceived, no loadingFinished: its request pauses next, or
    // fails Chrome's CORS check, or was aborted meanwhile and never comes.
    setTimeout(() => {
      const main = request.main;
      if (main === null || main.ended) return;
      const status = Number(command.params.responseCode);
      if (status >= 200 && status < 300) this.#pause(main, (main as SiteModelRequest & { resourceType?: string }).resourceType ?? "XHR");
      else this.#end(main, "net::ERR_FAILED", false);
    }, request.main?.script.mainDelayMs ?? 0);
    return {};
  }

  /** The page aborts a request (XMLHttpRequest.abort, a route left): Chrome
   *  tells of the request's end by its own id — also while only its
   *  preflight is paused or in flight, and that preflight goes on as it
   *  was: still paused, or answered later. */
  abort(main: SiteModelRequest): void {
    if (main.ended) return;
    main.ended = true;
    this.cdp.emit("Network.loadingFailed", { requestId: main.networkId, errorText: "net::ERR_ABORTED", canceled: true }, main.session);
  }

  #continueResponse(command: CdpCommand): unknown {
    const request = this.#byInterception(command.params.requestId);
    if (!request || request.stage !== "response") return { error: { code: -32602, message: "Invalid InterceptionId." } };
    this.#responseReceived(request, request.script.status ?? 200);
    void this.#body(request);
    return {};
  }

  async #body(request: SiteModelRequest): Promise<void> {
    const script = request.script;
    const chunks = script.chunks ?? [Buffer.from('{"success":true,"response":[]}')];
    let total = 0;
    const read: Buffer[] = [];
    if (script.deliversNothing) {
      await new Promise((resolve) => setImmediate(resolve));
      if (request.ended) return;
      const bytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      this.cdp.emit("Network.dataReceived", { requestId: request.networkId, dataLength: 0, encodedDataLength: bytes }, request.session);
      request.ended = true;
      this.pageRead.set(request.networkId, Buffer.concat(chunks));
      this.cdp.emit("Network.loadingFinished", { requestId: request.networkId, encodedDataLength: bytes + 200 }, request.session);
      return;
    }
    for (const [index, chunk] of chunks.entries()) {
      if (script.chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, script.chunkDelayMs));
      else await new Promise((resolve) => setImmediate(resolve));
      if (request.ended) return;
      total += chunk.length;
      read.push(chunk);
      const streamed = request.armedAt !== null && !script.unstreamed;
      const data = script.brokenChunk && index === 0 ? chunk.subarray(0, Math.max(0, chunk.length - 1)) : chunk;
      this.cdp.emit("Network.dataReceived", { requestId: request.networkId, dataLength: chunk.length, encodedDataLength: chunk.length, ...(streamed ? { data: data.toString("base64") } : {}) }, request.session);
    }
    await new Promise((resolve) => setImmediate(resolve));
    if (request.ended) return;
    this.pageRead.set(request.networkId, Buffer.concat(read));
    if (script.then === "body_fails") return this.#end(request, "net::ERR_CONNECTION_CLOSED", false);
    if (script.then === "cancel_after_answer") return this.#end(request, "net::ERR_ABORTED", true);
    request.ended = true;
    this.cdp.emit("Network.loadingFinished", { requestId: request.networkId, encodedDataLength: total + 200 }, request.session);
  }

  #failCommand(command: CdpCommand): unknown {
    const request = this.requests.find((entry) => entry.interceptionId === command.params.requestId && !entry.ended);
    if (!request) return { error: { code: -32602, message: "Invalid InterceptionId." } };
    request.outcome = "failed";
    request.failReason = String(command.params.errorReason);
    this.#end(request, command.params.errorReason === "Aborted" ? "net::ERR_ABORTED" : command.params.errorReason === "BlockedByClient" ? "net::ERR_BLOCKED_BY_CLIENT" : "net::ERR_FAILED", false);
    return {};
  }

  #end(request: SiteModelRequest, errorText: string, canceled: boolean): void {
    if (request.ended) return;
    request.ended = true;
    setImmediate(() => this.cdp.emit("Network.loadingFailed", { requestId: request.networkId, errorText, canceled }, request.session));
  }
}
