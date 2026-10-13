// Which document each of the site's requests belongs to, and whether that
// document is still the frame's (stage 1, amendment 41). Fansly reloads its
// page right after a login: a request of the old page that still waits for
// its admission, released after the reload, is neither sent by Chrome nor
// reported ended — and an operation with no end stops the page
// (`request_unended`). So a request of a replaced document is never
// released: failed at once when its document goes, or at its admission
// instead of its release.
//
// - A request's document is its `loaderId` (Network.requestWillBeSent); a
//   preflight has none of its own, and takes its request's
//   (`initiator.requestId`), whichever of the two Chrome reports first.
// - A frame's documents come from Page.frameNavigated: the loader a frame
//   had before a new one is replaced.
// - A request whose document is not known yet is judged by its frame: a
//   frame that committed another document after the request paused
//   replaced it. A request of no frame (a worker's) is never judged so.
//
// Memory is bounded: the newest few thousand ids of each kind are kept.

import type { CdpEvent, CdpPort } from "../cdp/client.ts";

const REMEMBERED = 5000;

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > REMEMBERED) map.delete(map.keys().next().value!);
}

/** Where a paused request stood when it paused. */
export interface DocumentMark {
  networkId: string | null;
  frameId: string | null;
  /** The frame's documents committed when it paused. */
  navigations: number;
}

export class Documents {
  /** Each request's loader ("": none of its own). */
  readonly #loaderOf = new Map<string, string>();
  /** A preflight's request. */
  readonly #preflightOf = new Map<string, string>();
  /** Each frame's current loader and how many documents it committed. */
  readonly #frames = new Map<string, { loader: string; navigations: number }>();
  readonly #replaced = new Map<string, true>();
  /** Told when a frame's document is replaced. */
  onReplaced: () => void = () => undefined;

  constructor(cdp: CdpPort) {
    cdp.on("Network.requestWillBeSent", (event) => this.#onWillBeSent(event));
    cdp.on("Page.frameNavigated", (event) => this.#onNavigated(event));
  }

  /** Where `request` stands now (at its pause). */
  mark(request: { networkId: string | null; frameId: string | null }): DocumentMark {
    return { networkId: request.networkId, frameId: request.frameId, navigations: request.frameId === null ? 0 : (this.#frames.get(request.frameId)?.navigations ?? 0) };
  }

  /** The request's document was replaced since `mark`. */
  replaced(mark: DocumentMark): boolean {
    const loader = this.#loader(mark.networkId);
    if (loader !== null) return this.#replaced.has(loader);
    if (mark.frameId === null || mark.frameId === "") return false;
    return (this.#frames.get(mark.frameId)?.navigations ?? 0) > mark.navigations;
  }

  /** A new browser: nothing of the old one counts. */
  reset(): void {
    this.#loaderOf.clear();
    this.#preflightOf.clear();
    this.#frames.clear();
    this.#replaced.clear();
  }

  #loader(networkId: string | null): string | null {
    if (networkId === null) return null;
    const own = this.#loaderOf.get(networkId);
    if (own !== undefined && own !== "") return own;
    const request = this.#preflightOf.get(networkId);
    const theirs = request === undefined ? undefined : this.#loaderOf.get(request);
    return theirs !== undefined && theirs !== "" ? theirs : null;
  }

  #onWillBeSent(event: CdpEvent): void {
    const params = event.params as { requestId?: unknown; loaderId?: unknown; initiator?: { type?: unknown; requestId?: unknown } };
    if (typeof params.requestId !== "string") return;
    remember(this.#loaderOf, params.requestId, typeof params.loaderId === "string" ? params.loaderId : "");
    if (params.initiator?.type === "preflight" && typeof params.initiator.requestId === "string") remember(this.#preflightOf, params.requestId, params.initiator.requestId);
  }

  #onNavigated(event: CdpEvent): void {
    const frame = (event.params as { frame?: { id?: unknown; loaderId?: unknown } }).frame;
    if (typeof frame?.id !== "string") return;
    const loader = typeof frame.loaderId === "string" ? frame.loaderId : "";
    const known = this.#frames.get(frame.id);
    if (known !== undefined && known.loader === loader && loader !== "") return;
    if (known !== undefined && known.loader !== "") remember(this.#replaced, known.loader, true);
    remember(this.#frames, frame.id, { loader, navigations: (known?.navigations ?? 0) + 1 });
    if (known !== undefined) this.onReplaced();
  }
}
