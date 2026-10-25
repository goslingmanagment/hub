import { randomUUID } from "node:crypto";

import { beginBrowserWsConnection, finishBrowserWsConnection, type Database } from "@agency_hub_core/db";

import type { BufferEvent } from "../../../services/egress/page-browser-protocol.ts";
import type { WsSourceState } from "../../engine/ports.ts";
import { readBrowserCredentialsGeneration } from "../browser-transport.ts";

// The site's socket of a page (Project Browser, plan §3.2 «Кадры сокета»,
// §4.4; stage 3 PR 12): the site opens its socket in the page's browser (the
// engine opens none), and this source only takes what the operator tells of
// it.
//
// - Each connection of the site's socket is a row of fansly_ws_connections
//   (0273): `origin = 'browser'`, the operator's connection id, the page's
//   browser credentials generation with the session fingerprint the
//   connection opened under (one value across the engine's fields). The
//   operator's `ws.open` opens it — once: an event delivered again opens
//   nothing twice — and its `ws.close` closes it at the instant the operator
//   saw; gap_since is taken from the previous row of the page, as for the
//   engine's own socket, and starts no later than a loss the operator marked
//   before it (its `gap`, PR 13).
// - As the page's socket owner it reports `open` while a connection is open,
//   `idle` otherwise: the engine never opens the socket of a browser page.
//
// The events come from the buffer's intake (`fansly/browser-intake.ts`, PR
// 13), which takes a batch of them in one transaction (`takeIn`) and tells
// the source once it committed (`committed`); the frames themselves, the gap
// marks and the repair are the intake's. The admission of the site's socket
// rides the site path (`engine/site-admission.ts`, route `ws.upgrade`) over
// the operator's `wsAdmit`/`wsDone`.

export interface BrowserWsSourceDeps {
  db: Database;
  pageId: number;
  /** TESTS ONLY: the generation of a fingerprint (default: the page's
   *  browser credentials generation). */
  generationOf?: (sessionFingerprint: string) => Promise<string | null>;
}

/** How the source took one of the operator's socket events. */
export type BrowserWsTaken = "opened" | "closed" | "known" | "not_a_connection_event" | "page_inactive";

export class BrowserWsSource {
  readonly #d: BrowserWsSourceDeps;
  /** The site's connections open now (the operator's ids). */
  readonly #open = new Set<string>();
  #stopped = false;

  constructor(deps: BrowserWsSourceDeps) {
    this.#d = deps;
  }

  get state(): WsSourceState {
    if (this.#stopped) return "stopped";
    return this.#open.size > 0 ? "open" : "idle";
  }

  /** The site's connection open now (the operator's id), or null. */
  get openConnectionId(): string | null {
    if (this.#stopped) return null;
    let last: string | null = null;
    for (const id of this.#open) last = id;
    return last;
  }

  /** One of the operator's socket events, in the order of its stream: a
   *  connection opened or closed, in its own transaction. Other events are
   *  the intake's. */
  async take(event: BufferEvent): Promise<BrowserWsTaken> {
    const generation = event.kind === "ws.open" ? await this.generationOf(event.sessionFingerprint) : null;
    const taken = await this.#d.db.transaction(async (raw) => this.takeIn(raw as unknown as Database, event, { generation }));
    this.committed(event, taken);
    return taken;
  }

  /** The page's browser credentials generation of a session fingerprint (null:
   *  the page is not active, or has no proxy) — read before the transaction
   *  that takes the `ws.open`, on its own snapshot. */
  generationOf(sessionFingerprint: string): Promise<string | null> {
    const generationOf = this.#d.generationOf
      ?? ((fingerprint: string) => readBrowserCredentialsGeneration(this.#d.db, this.#d.pageId, fingerprint));
    return generationOf(sessionFingerprint);
  }

  /** The database's part of `take`, in the caller's transaction (the
   *  intake's batch): `generation` of a `ws.open` read before it
   *  (`generationOf`), `gapSince` a loss the operator marked before it. The
   *  caller tells the source with `committed` once its transaction did. */
  async takeIn(tx: Database, event: BufferEvent, input: { generation: string | null; gapSince?: Date | null }): Promise<BrowserWsTaken> {
    switch (event.kind) {
      case "ws.open": {
        if (input.generation === null) return "page_inactive";
        const opened = await beginBrowserWsConnection(tx, {
          id: randomUUID(),
          pageId: this.#d.pageId,
          generation: input.generation,
          browserConnectionId: event.connectionId,
          startedAt: new Date(event.atWall),
          gapSince: input.gapSince ?? null,
        });
        return opened ? "opened" : "known";
      }
      case "ws.close": {
        const closed = await finishBrowserWsConnection(tx, {
          pageId: this.#d.pageId,
          browserConnectionId: event.connectionId,
          closedAt: new Date(event.atWall),
          reason: event.code === null ? "site_closed" : `site_closed:${event.code}`,
        });
        return closed ? "closed" : "known";
      }
      default:
        return "not_a_connection_event";
    }
  }

  /** What a committed transaction took of the site's connections. */
  committed(event: BufferEvent, taken: BrowserWsTaken): void {
    if (event.kind === "ws.open" && taken !== "page_inactive") {
      // One site socket of a page at a time: an open browser row before it
      // was closed as abandoned with the insert.
      this.#open.clear();
      this.#open.add(event.connectionId);
    } else if (event.kind === "ws.close") {
      this.#open.delete(event.connectionId);
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#open.clear();
  }
}
