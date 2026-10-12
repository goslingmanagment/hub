// The self-test's requests (plan §4.1, step 5): each is a fetch() from an
// isolated world of the work tab, marked twice — `?pbst=<marker>` for the
// Network events (a request the rules extension cancels never reaches
// Fetch) and `#pb-selftest-<marker>` for Fetch (the fragment never goes to
// the network). The answer shows which mechanism stopped the request:
// whether it reached the operator's interception, and how it failed.
//
// A probe of the permitted kind is the one request the interception lets go
// without an engine's admission — only while the self-test waits for it and
// the exit is closed: it has nowhere to go. Every other request carrying a
// marker is failed like any request without an admission. The operator
// waits for Network.loadingFailed of every probe: none may stay queued and
// leave later.

import type { Cdp, CdpEvent } from "../cdp/client.ts";
import type { BrowserControl } from "../cdp/control.ts";
import type { PausedRequest } from "../cdp/paused.ts";
import { monoMs, sleep } from "../shared/util.ts";

export type ProbeKind = "permitted" | "never" | "write";

export interface ProbeOutcome {
  /** It reached the operator's Fetch interception. */
  paused: boolean;
  /** Chrome's net error (null: no end within the deadline — still queued). */
  errorText: string | null;
  blockedReason: string | null;
  /** It finished with an answer: it went out (never on a closed exit). */
  answered: boolean;
}

interface Waiter {
  kind: ProbeKind;
  paused: boolean;
  errorText: string | null;
  blockedReason: string | null;
  answered: boolean;
  done: boolean;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Fire and forget; the operator reads the outcome from CDP. */
const FIRE = "function (url, method) { fetch(url, { method: method, mode: 'no-cors', body: method === 'GET' ? undefined : '{}' }).catch(function () {}); return true; }";

export interface ProbeDriverOptions {
  /** The host of the probes: the site's API host (a permitted host — the
   *  closed exit is what must stop it). */
  apiHost: string;
  /** True while the exit is closed. */
  exitClosed: () => boolean;
}

export class ProbeDriver {
  readonly #cdp: Cdp;
  readonly #control: BrowserControl;
  readonly #options: ProbeDriverOptions;
  readonly #waiters = new Map<string, Waiter>();
  readonly #markerOfRequest = new Map<string, string>();

  constructor(cdp: Cdp, control: BrowserControl, options: ProbeDriverOptions) {
    this.#cdp = cdp;
    this.#control = control;
    this.#options = options;
    cdp.on("Network.requestWillBeSent", (event) => this.#onWillBeSent(event));
    cdp.on("Network.loadingFailed", (event) => this.#onEnded(event, false));
    cdp.on("Network.loadingFinished", (event) => this.#onEnded(event, true));
  }

  get apiHost(): string {
    return this.#options.apiHost;
  }

  /** The interception's question: is this paused request a probe, and may
   *  it go on? "continue" only for a permitted probe the self-test waits for
   *  while the exit is closed; "fail" for any other probe (it is recorded as
   *  having reached the interception); null for a request that is no probe. */
  onPaused(request: PausedRequest): "continue" | "fail" | null {
    const marker = /^#pb-selftest-([\w-]+)$/.exec(request.urlFragment)?.[1];
    if (marker === undefined) return null;
    const waiter = this.#waiters.get(marker);
    if (!waiter || waiter.done) return "fail";
    waiter.paused = true;
    if (waiter.kind !== "permitted" || !this.#options.exitClosed()) return "fail";
    return hostOf(request.url) === this.#options.apiHost && request.method === "GET" ? "continue" : "fail";
  }

  /** One probe; resolves once Chrome ended it, or at `deadlineMono` with
   *  `errorText: null` (still queued). */
  async probe(kind: ProbeKind, method: "GET" | "POST", path: string, marker: string, deadlineMono: number): Promise<ProbeOutcome> {
    const tab = this.#control.workTab;
    if (!tab) throw new Error("no work tab");
    const world = await this.#control.isolatedWorld(tab, "pb-selftest");
    const waiter: Waiter = { kind, paused: false, errorText: null, blockedReason: null, answered: false, done: false };
    this.#waiters.set(marker, waiter);
    try {
      const url = `https://${this.#options.apiHost}${path}?pbst=${marker}#pb-selftest-${marker}`;
      await this.#cdp.send(
        "Runtime.callFunctionOn",
        { functionDeclaration: FIRE, executionContextId: world, arguments: [{ value: url }, { value: method }], returnByValue: true },
        tab.sessionId,
      );
      while (!waiter.done && monoMs() < deadlineMono) await sleep(10);
      return { paused: waiter.paused, errorText: waiter.done ? waiter.errorText : null, blockedReason: waiter.blockedReason, answered: waiter.answered };
    } finally {
      // A probe that ends later is no longer waited for: if it pauses now,
      // it is failed.
      waiter.done = true;
    }
  }

  #onWillBeSent(event: CdpEvent): void {
    const params = event.params as { requestId?: string; request?: { url?: string } };
    const marker = /[?&]pbst=([\w-]+)/.exec(String(params.request?.url ?? ""))?.[1];
    if (marker === undefined || typeof params.requestId !== "string") return;
    this.#markerOfRequest.set(params.requestId, marker);
    if (this.#markerOfRequest.size > 200) this.#markerOfRequest.delete(this.#markerOfRequest.keys().next().value!);
  }

  #onEnded(event: CdpEvent, answered: boolean): void {
    const params = event.params as { requestId?: string; errorText?: string; blockedReason?: string };
    const marker = typeof params.requestId === "string" ? this.#markerOfRequest.get(params.requestId) : undefined;
    if (marker === undefined) return;
    this.#markerOfRequest.delete(params.requestId!);
    const waiter = this.#waiters.get(marker);
    if (!waiter || waiter.done) return;
    waiter.answered = answered;
    waiter.errorText = answered ? "" : String(params.errorText ?? "");
    waiter.blockedReason = params.blockedReason ?? null;
    waiter.done = true;
    this.#waiters.delete(marker);
  }
}
