// Every request of every tab, frame and worker stops in Fetch on the browser
// target (plan §4.1, step 4) and is resolved here: continued or failed,
// never left. The decision is the operator's (`decide`); this module is the
// mechanics. A paused request is acknowledged to the holder only once its
// resolution was answered by Chrome, so an operator that dies in between
// learns about it again from the holder's replay.
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
// asked for only by the paths that admit requests (PR 7, PR 9); one that
// arrives otherwise is failed too.

import { CdpUnanswered, type Cdp, type CdpEvent } from "./client.ts";
import { errorMessage, makeLog, type Logger } from "../shared/util.ts";

/** Fetch.ErrorReason values the operator uses. */
export type FailReason = "BlockedByClient" | "Aborted" | "Failed";

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
  resourceType: string;
  frameId: string | null;
  /** The previous hop's Fetch id, when this is a redirect's next hop. */
  redirectedRequestId: string | null;
}

export type PausedDecision = { action: "continue"; params?: Record<string, unknown> } | { action: "fail"; reason: FailReason; why: string };

export interface PausedOptions {
  decide: (request: PausedRequest) => PausedDecision;
  /** Every decision, for the request journal (logs/). */
  onDecided?: (request: PausedRequest, decision: PausedDecision) => void;
  /** Chrome did not answer a resolution: the request may still be paused. */
  onIndeterminate?: (request: PausedRequest, why: string) => void;
  log?: Logger;
}

export class PausedRequests {
  readonly #cdp: Cdp;
  readonly #options: PausedOptions;
  readonly #log: Logger;
  #resolving = 0;

  constructor(cdp: Cdp, options: PausedOptions) {
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
      request?: { url?: string; urlFragment?: string; method?: string };
      resourceType?: string;
      frameId?: string;
      responseStatusCode?: number;
      responseErrorReason?: string;
    };
    if (typeof params.requestId !== "string") {
      this.#cdp.ack(event.seq);
      return;
    }
    const request: PausedRequest = {
      requestId: params.requestId,
      networkId: params.networkId ?? null,
      sessionId: event.sessionId ?? null,
      seq: event.seq,
      replayed: event.replayed,
      stage: params.responseStatusCode !== undefined || params.responseErrorReason !== undefined ? "response" : "request",
      method: String(params.request?.method ?? ""),
      url: String(params.request?.url ?? ""),
      urlFragment: String(params.request?.urlFragment ?? ""),
      resourceType: String(params.resourceType ?? ""),
      frameId: params.frameId ?? null,
      redirectedRequestId: params.redirectedRequestId ?? null,
    };
    let decision: PausedDecision;
    if (request.replayed) {
      decision = { action: "fail", reason: "BlockedByClient", why: "paused under a previous operator instance" };
    } else if (request.stage === "response") {
      decision = { action: "fail", reason: "BlockedByClient", why: "a response stage nobody asked for" };
    } else {
      try {
        decision = this.#options.decide(request);
      } catch (error) {
        decision = { action: "fail", reason: "BlockedByClient", why: `the decision failed: ${errorMessage(error)}` };
      }
    }
    this.#options.onDecided?.(request, decision);
    void this.#resolve(request, decision);
  }

  async #resolve(request: PausedRequest, decision: PausedDecision): Promise<void> {
    this.#resolving += 1;
    const method = decision.action === "continue" ? "Fetch.continueRequest" : "Fetch.failRequest";
    const params = decision.action === "continue" ? { requestId: request.requestId, ...decision.params } : { requestId: request.requestId, errorReason: decision.reason };
    let answered = true;
    try {
      await this.#cdp.send(method, params, request.sessionId ?? undefined);
    } catch (error) {
      // An error answer: gone already (its target closed, Chrome restarted, a
      // replay of a request a previous instance did resolve). No answer: it
      // may still be paused.
      answered = !(error instanceof CdpUnanswered);
      this.#log(answered ? "resolve.refused" : "resolve.unanswered", { method, error: errorMessage(error) });
      if (!answered) this.#options.onIndeterminate?.(request, errorMessage(error));
    } finally {
      this.#resolving -= 1;
      if (answered) this.#cdp.ack(request.seq);
    }
  }
}
