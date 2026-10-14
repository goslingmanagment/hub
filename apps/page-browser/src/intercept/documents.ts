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
// - The operator replaces a document itself when it loads the work tab anew
//   (`retire`): the frame's document counts as replaced from that moment,
//   before Chrome commits the next one — nothing of it is released into
//   the reload.
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
  /** Each frame's current loader and how many documents it committed;
   *  `retired`: the operator replaced its document, Chrome has not
   *  committed the next one yet. */
  readonly #frames = new Map<string, { loader: string; navigations: number; commits: number; retired?: boolean }>();
  readonly #replaced = new Map<string, true>();
  /** Told when a frame's document is replaced. */
  onReplaced: () => void = () => undefined;
  /** Told when Chrome names the request a preflight was made for. */
  onPreflight: (preflightId: string, requestId: string) => void = () => undefined;
  /** Told when Chrome names a request's document (its loader). */
  onLoader: (networkId: string, loaderId: string) => void = () => undefined;

  constructor(cdp: CdpPort) {
    cdp.on("Network.requestWillBeSent", (event) => this.#onWillBeSent(event));
    cdp.on("Page.frameNavigated", (event) => this.#onNavigated(event));
  }

  /** Where `request` stands now (at its pause). */
  mark(request: { networkId: string | null; frameId: string | null }): DocumentMark {
    const frame = request.frameId === null ? undefined : this.#frames.get(request.frameId);
    // A frame the operator retired has no document of its own until Chrome
    // commits the next: what pauses in it meanwhile is of the retired one.
    return { networkId: request.networkId, frameId: request.frameId, navigations: (frame?.navigations ?? 0) - (frame?.retired ? 1 : 0) };
  }

  /** The request's document was replaced since `mark`. */
  replaced(mark: DocumentMark): boolean {
    const loader = this.#loader(mark.networkId);
    if (loader !== null) return this.#replaced.has(loader);
    if (mark.frameId === null || mark.frameId === "") return false;
    return (this.#frames.get(mark.frameId)?.navigations ?? 0) > mark.navigations;
  }

  /** The frame's document is being replaced by the operator (the work tab
   *  loaded anew): replaced from now on, whatever Chrome has told so far. */
  retire(frameId: string): void {
    const known = this.#frames.get(frameId);
    if (known !== undefined && known.loader !== "") remember(this.#replaced, known.loader, true);
    remember(this.#frames, frameId, { loader: "", navigations: (known?.navigations ?? 0) + 1, commits: known?.commits ?? 0, retired: true });
    this.onReplaced();
  }

  /** The request's document (its loader, or its request's for a
   *  preflight); null: Chrome has not named it (yet), or it has none. */
  loaderOfRequest(networkId: string | null): string | null {
    return this.#loader(networkId);
  }

  /** The frame's document now: the loader Chrome committed last; null when
   *  none is committed — or the operator retired it and the next is not in. */
  currentLoader(frameId: string | null): string | null {
    const loader = frameId === null ? undefined : this.#frames.get(frameId)?.loader;
    return loader === undefined || loader === "" ? null : loader;
  }

  /** How many documents Chrome committed in the frame so far. */
  commits(frameId: string | null): number {
    return frameId === null ? 0 : (this.#frames.get(frameId)?.commits ?? 0);
  }

  /** The request a preflight was made for (its network id), once Chrome
   *  said so; null until then. */
  requestOf(preflightId: string | null): string | null {
    return preflightId === null ? null : (this.#preflightOf.get(preflightId) ?? null);
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
    if (typeof params.loaderId === "string" && params.loaderId !== "") this.onLoader(params.requestId, params.loaderId);
    if (params.initiator?.type === "preflight" && typeof params.initiator.requestId === "string") {
      remember(this.#preflightOf, params.requestId, params.initiator.requestId);
      this.onPreflight(params.requestId, params.initiator.requestId);
    }
  }

  #onNavigated(event: CdpEvent): void {
    const frame = (event.params as { frame?: { id?: unknown; loaderId?: unknown } }).frame;
    if (typeof frame?.id !== "string") return;
    const loader = typeof frame.loaderId === "string" ? frame.loaderId : "";
    const known = this.#frames.get(frame.id);
    if (known !== undefined && known.loader === loader && loader !== "") return;
    if (known !== undefined && known.loader !== "") remember(this.#replaced, known.loader, true);
    remember(this.#frames, frame.id, { loader, navigations: (known?.navigations ?? 0) + 1, commits: (known?.commits ?? 0) + 1 });
    if (known !== undefined) this.onReplaced();
  }
}
