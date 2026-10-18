// The rules extension's blocks, as Chrome reports them: a request whose load
// failed with net::ERR_BLOCKED_BY_CLIENT (the DNR rules, plan §4.6) — of any
// host, the site's, a third party's, the self-test's probes. Only its host is
// told (state/egress-failures.ts counts it by the host's class). A request
// the operator failed itself in Fetch (`failedHere`) ends the same way and is
// not the extension's.

import type { CdpEvent, CdpPort } from "../cdp/client.ts";

/** Requests whose host is remembered until their end, at most (the oldest
 *  forgotten first). */
export const BLOCKED_KEPT = 4_096;

export const BLOCKED_BY_CLIENT = "net::ERR_BLOCKED_BY_CLIENT";

export class BlockedRequests {
  readonly #hosts = new Map<string, string>();
  /** Network ids the operator failed in Fetch, until their end. */
  readonly #failedHere = new Set<string>();
  readonly #onBlocked: (block: { networkId: string; host: string }) => void;

  constructor(cdp: Pick<CdpPort, "on">, onBlocked: (block: { networkId: string; host: string }) => void) {
    this.#onBlocked = onBlocked;
    cdp.on("Network.requestWillBeSent", (event) => this.#onWillBeSent(event));
    cdp.on("Network.loadingFinished", (event) => this.#forget(event));
    cdp.on("Network.loadingFailed", (event) => this.#onFailed(event));
  }

  #onWillBeSent(event: CdpEvent): void {
    const p = event.params as { requestId?: string; request?: { url?: string } };
    if (typeof p.requestId !== "string") return;
    let host: string;
    try {
      host = new URL(p.request?.url ?? "").hostname;
    } catch {
      return;
    }
    if (host === "") return;
    this.#hosts.delete(p.requestId);
    this.#hosts.set(p.requestId, host);
    if (this.#hosts.size > BLOCKED_KEPT) this.#hosts.delete(this.#hosts.keys().next().value!);
  }

  /** The operator failed this request in Fetch: its end is no block of the
   *  extension's. */
  failedHere(networkId: string): void {
    this.#failedHere.add(networkId);
    if (this.#failedHere.size > BLOCKED_KEPT) this.#failedHere.delete(this.#failedHere.values().next().value!);
  }

  #forget(event: CdpEvent): void {
    const id = (event.params as { requestId?: string }).requestId;
    if (typeof id !== "string") return;
    this.#hosts.delete(id);
    this.#failedHere.delete(id);
  }

  #onFailed(event: CdpEvent): void {
    const p = event.params as { requestId?: string; errorText?: string };
    if (typeof p.requestId !== "string") return;
    const host = this.#hosts.get(p.requestId);
    this.#hosts.delete(p.requestId);
    if (this.#failedHere.delete(p.requestId)) return;
    if (host === undefined || typeof p.errorText !== "string" || !p.errorText.includes(BLOCKED_BY_CLIENT)) return;
    this.#onBlocked({ networkId: p.requestId, host });
  }
}
