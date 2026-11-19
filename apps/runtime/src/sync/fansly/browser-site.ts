import { REFUSALS, type Refusal } from "../../services/egress/page-browser-protocol.ts";
import type { MonoBridge, PageBrowserRpcClient, SiteObservedMessage } from "../../services/egress/page-browser-rpc.ts";
import { retryAfterDelayMs } from "../engine/errors.ts";
import type { Metrics, ObservedSiteKey, SiteAdmissionPort, SiteObservation } from "../engine/ports.ts";

// The site path of a browser page over its operator's RPC (Project Browser,
// plan §3.2; variant Б, plan-b §4.2.2): what the operator observed of the
// site's own traffic goes to the actor (`onObserved`), each fact with its
// hop's key and its ack. Nothing of the site waits for the engine's
// admission: an operator of minor 4 or later lets the site's requests and
// its socket go. The admission messages the protocol still carries
// (`siteAdmit`, `wsAdmit`, `admissionCancel`, `siteDone`, `wsDone`) are
// parsed and taken by nobody: the RPC client logs them at debug, and an
// operator's own wait fails closed a request nobody admits.
//
// Every fact names its hop's key (`requestKey`, `hop`: protocol minor 6, the
// oldest the RPC client takes at hello), and the operator keeps it until its
// `deliverySeq` is acknowledged — on the connection it came on, once the
// actor committed it. A fact without a key is dropped, counted.

/** A reported send instant is taken this much later than the bridge says:
 *  the shift between the two clocks is read, not known, and the pause must
 *  never run from an instant before the true send (I1: a strict minimum).
 *  The browser transport's too. */
export const SEND_REPORT_GUARD_MS = 1;

const PROTOCOL_REFUSALS: ReadonlySet<string> = new Set(REFUSALS);

/** The refusal an admission answers the operator with: a reason the
 *  protocol knows as itself, any other as `lease_inactive`. The browser
 *  transport's and the onboarding task's grant checks both answer so. */
export function protocolRefusalOf(reason: string): Refusal {
  return PROTOCOL_REFUSALS.has(reason) ? (reason as Refusal) : "lease_inactive";
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
  readonly #unlisten: Array<() => void> = [];
  #closed = false;
  #observed: ((event: SiteObservation) => void) | null = null;

  constructor(options: BrowserSiteAdmissionOptions) {
    this.#o = options;
    const client = options.client;
    client.onSiteObserved((message) => this.#onObservedMessage(message));
    this.#unlisten.push(() => client.onSiteObserved(null));
  }

  /** Nothing more is taken. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const unlisten of this.#unlisten.splice(0)) unlisten();
  }

  /** Variant Б: the site's own traffic an operator of minor 4 observed, on
   *  the engine's clocks (the actor counts it in the pause, journals it and
   *  holds routes on it). */
  onObserved(listener: ((event: SiteObservation) => void) | null): void {
    this.#observed = listener;
  }

  /** The hop a fact names, and its ack (null: it names no key). */
  #observedKey(message: SiteObservedMessage): { key: ObservedSiteKey; ack: () => void } | null {
    if (message.requestKey === undefined || message.hop === undefined) return null;
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
    }
  }
}
