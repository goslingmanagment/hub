// Every request of every tab, frame and worker stops in Fetch on the browser
// target (plan §4.1, step 4) and is resolved here: continued, failed, or
// answered by the operator itself (the environment check's own page,
// env/check.ts — nothing is sent), never left. The decision is the
// operator's (`decide`); this module is the mechanics. A paused request is
// acknowledged to the holder only once its resolution was answered by
// Chrome, so an operator that dies in between learns about it again from
// the holder's replay.
//
// A decision may be `hold`: the path that owns the request (a Hub request
// waiting for the engine's check, PR 9) resolves it later with `resolve`.
// A held request stays unacknowledged meanwhile, like any paused one.
//
// A resolution Chrome did not answer (no answer in time, the link down) is
// not acknowledged: the request may still be paused, so it stays in the
// holder's store, and the operator treats the browser as out of control
// (`onIndeterminate`: the exit closes, Chrome goes). An error answer means
// Chrome no longer has that pause, and is acknowledged.
//
// A pause from before this operator instance (a replay) is failed whatever
// it is: an admission it may have had died with the previous instance, and a
// request is never released without one. A pause at the response stage is
// asked for only by the paths that admit requests (`interceptResponse`; PR
// 9, PR 7): it goes to `decide` like any other, and the operator fails one
// that no path claims.
//
// What a paused request carries — its headers, the response's headers — is
// kept in memory for the decision only: none of it is logged here. Of its
// body only the size is kept (a login's carries the password).

import { CdpUnanswered, type CdpEvent, type CdpPort } from "./client.ts";
import { errorMessage, makeLog, type Logger } from "../shared/util.ts";

/** Fetch.ErrorReason values the operator uses. */
export type FailReason = "BlockedByClient" | "Aborted" | "Failed";

export interface PausedResponse {
  status: number | null;
  statusText: string;
  /** As Chrome gives them: repeated names are separate entries. */
  headers: Array<{ name: string; value: string }>;
  /** A network error at the response stage (no status then). */
  errorReason: string | null;
}

export interface PausedRequest {
  /** Fetch's id of the pause (the interception job). */
  requestId: string;
  /** The Network domain's id of the request, when Chrome gives one. */
  networkId: string | null;
  sessionId: string | null;
  seq: number;
  replayed: boolean;
  stage: "request" | "response";
  method: string;
  url: string;
  /** "#…" or "" (the fragment never goes to the network). */
  urlFragment: string;
  /** The request's headers as the page set them (memory only, never logged:
   *  the site's session rides here). */
  headers: Record<string, string>;
  resourceType: string;
  frameId: string | null;
  /** The previous hop's Fetch id, when this is a redirect's next hop. */
  redirectedRequestId: string | null;
  /** Its body's bytes: 0 none, null of a length the event does not tell
   *  (a stream, a blob, data Chrome did not attach). Never the body itself. */
  bodyBytes: number | null;
  /** The response stage's status and headers; null at the request stage. */
  response: PausedResponse | null;
}

export type PausedDecision =
  | { action: "continue"; params?: Record<string, unknown> }
  | { action: "fail"; reason: FailReason; why: string }
  /** Answered here (Fetch.fulfillRequest): the request goes nowhere — or,
   *  at the response stage, the page gets this answer instead. */
  | { action: "fulfill"; status: number; headers: Array<{ name: string; value: string }>; body: string; why: string; phrase?: string }
  /** The response stage: the answer goes on to the page as it came. */
  | { action: "continueResponse" }
  /** Resolved later by the path that owns it (`resolve`). */
  | { action: "hold" };

export type Resolution = "answered" | "refused" | "unanswered";

export interface PausedOptions {
  decide: (request: PausedRequest) => PausedDecision;
  /** Every resolution, for the request journal (logs/): called as it is
   *  decided, before Chrome has answered it. */
  onDecided?: (request: PausedRequest, decision: PausedDecision) => void;
  /** Every resolution once Chrome answered it (or did not: `unanswered`).
   *  What depends on the resolution having happened — a request's end for
   *  the page's slot — goes here, never in `onDecided`. */
  onResolved?: (request: PausedRequest, decision: PausedDecision, resolution: Resolution) => void;
  /** Chrome did not answer a resolution: the request may still be paused. */
  onIndeterminate?: (request: PausedRequest, why: string) => void;
  log?: Logger;
}

export class PausedRequests {
  readonly #cdp: CdpPort;
  readonly #options: PausedOptions;
  readonly #log: Logger;
  #resolving = 0;

  constructor(cdp: CdpPort, options: PausedOptions) {
    this.#cdp = cdp;
    this.#options = options;
    this.#log = options.log ?? makeLog("paused");
    cdp.on("Fetch.requestPaused", (event) => this.#onPaused(event));
  }

  /** Pauses whose resolution Chrome has not answered yet. */
  get resolving(): number {
    return this.#resolving;
  }

  #onPaused(event: CdpEvent): void {
    const params = event.params as {
      requestId?: string;
      networkId?: string;
      redirectedRequestId?: string;
      request?: { url?: string; urlFragment?: string; method?: string; headers?: Record<string, unknown>; hasPostData?: boolean; postData?: string; postDataEntries?: Array<{ bytes?: unknown }> };
      resourceType?: string;
      frameId?: string;
      responseStatusCode?: number;
      responseStatusText?: string;
      responseErrorReason?: string;
      responseHeaders?: Array<{ name?: unknown; value?: unknown }>;
    };
    if (typeof params.requestId !== "string") {
      this.#cdp.ack(event.seq);
      return;
    }
    const responseStage = params.responseStatusCode !== undefined || params.responseErrorReason !== undefined;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(params.request?.headers ?? {})) headers[name] = String(value);
    const request: PausedRequest = {
      requestId: params.requestId,
      networkId: params.networkId ?? null,
      sessionId: event.sessionId ?? null,
      seq: event.seq,
      replayed: event.replayed,
      stage: responseStage ? "response" : "request",
      method: String(params.request?.method ?? ""),
      url: String(params.request?.url ?? ""),
      urlFragment: String(params.request?.urlFragment ?? ""),
      headers,
      resourceType: String(params.resourceType ?? ""),
      frameId: params.frameId ?? null,
      redirectedRequestId: params.redirectedRequestId ?? null,
      bodyBytes: bodyBytesOf(params.request),
      response: responseStage
        ? {
            status: typeof params.responseStatusCode === "number" ? params.responseStatusCode : null,
            statusText: String(params.responseStatusText ?? ""),
            headers: (params.responseHeaders ?? []).map((header) => ({ name: String(header.name ?? ""), value: String(header.value ?? "") })),
            errorReason: params.responseErrorReason ?? null,
          }
        : null,
    };
    let decision: PausedDecision;
    if (request.replayed) {
      decision = { action: "fail", reason: "BlockedByClient", why: "paused under a previous operator instance" };
    } else {
      try {
        decision = this.#options.decide(request);
      } catch (error) {
        decision = { action: "fail", reason: "BlockedByClient", why: `the decision failed: ${errorMessage(error)}` };
      }
    }
    if (decision.action === "hold") return;
    void this.resolve(request, decision);
  }

  /** Carries out a decision for a paused request (one held earlier, or
   *  decided now). Resolves with Chrome's word: answered, refused (the pause
   *  is gone: its target closed, Chrome restarted, the page dropped the
   *  request), or unanswered (it may still be paused). A decision of the
   *  other stage (a request's continue for a response, say) is a fail. */
  resolve(request: PausedRequest, decision: Exclude<PausedDecision, { action: "hold" }>): Promise<Resolution> {
    const wrongStage = request.stage === "response" ? decision.action === "continue" : decision.action === "continueResponse";
    return this.#resolve(request, wrongStage ? { action: "fail", reason: "BlockedByClient", why: `a ${decision.action} at the ${request.stage} stage` } : decision);
  }

  async #resolve(request: PausedRequest, decision: Exclude<PausedDecision, { action: "hold" }>): Promise<Resolution> {
    this.#options.onDecided?.(request, decision);
    this.#resolving += 1;
    let method: string;
    let params: Record<string, unknown>;
    switch (decision.action) {
      case "continue":
        method = "Fetch.continueRequest";
        params = { requestId: request.requestId, ...decision.params };
        break;
      case "fail":
        method = "Fetch.failRequest";
        params = { requestId: request.requestId, errorReason: decision.reason };
        break;
      case "fulfill":
        method = "Fetch.fulfillRequest";
        params = {
          requestId: request.requestId,
          responseCode: decision.status,
          responseHeaders: decision.headers,
          body: Buffer.from(decision.body, "utf8").toString("base64"),
          ...(decision.phrase ? { responsePhrase: decision.phrase } : {}),
        };
        break;
      case "continueResponse":
        method = "Fetch.continueResponse";
        params = { requestId: request.requestId };
        break;
    }
    let resolution: Resolution = "answered";
    try {
      await this.#cdp.send(method, params, request.sessionId ?? undefined);
    } catch (error) {
      // An error answer: gone already (its target closed, Chrome restarted, a
      // replay of a request a previous instance did resolve). No answer: it
      // may still be paused.
      resolution = error instanceof CdpUnanswered ? "unanswered" : "refused";
      this.#log(resolution === "refused" ? "resolve.refused" : "resolve.unanswered", { method, error: errorMessage(error) });
      if (resolution === "unanswered") this.#options.onIndeterminate?.(request, errorMessage(error));
    } finally {
      this.#resolving -= 1;
      if (resolution !== "unanswered") this.#cdp.ack(request.seq);
    }
    this.#options.onResolved?.(request, decision, resolution);
    return resolution;
  }
}

/** The bytes of a paused request's body as Fetch shows it: its entries'
 *  (base64), or its text — and null when it has one of a length not shown. */
function bodyBytesOf(request: { method?: string; hasPostData?: boolean; postData?: string; postDataEntries?: Array<{ bytes?: unknown }> } | undefined): number | null {
  if (request === undefined) return 0;
  const entries = request.postDataEntries;
  if (Array.isArray(entries) && entries.length > 0) {
    let total = 0;
    for (const entry of entries) {
      if (typeof entry.bytes !== "string") return null;
      total += Buffer.from(entry.bytes, "base64").length;
    }
    return total;
  }
  if (typeof request.postData === "string") return Buffer.byteLength(request.postData, "utf8");
  return request.hasPostData === true ? null : 0;
}
