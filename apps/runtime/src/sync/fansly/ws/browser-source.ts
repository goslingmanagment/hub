import { randomUUID } from "node:crypto";

import { beginBrowserWsConnection, finishBrowserWsConnection, type Database } from "@agency_hub_core/db";

import type { BufferEvent } from "../../../services/egress/page-browser-protocol.ts";
import type { LivePageSocket, SendHooks, TransportOutcome, WsSourceState } from "../../engine/ports.ts";
import { readBrowserCredentialsGeneration } from "../browser-transport.ts";

// The site's socket of a browser page (Project Browser, plan §3.2 «Кадры
// сокета», §4.4; stage 3 PR 12): in place of the engine's own socket
// (`FanslyWsSource`), the site opens its socket in the page's browser, and
// this source only takes what the operator tells of it.
//
// What it does in this PR:
// - Each connection of the site's socket is a row of fansly_ws_connections
//   (0273): `origin = 'browser'`, the operator's connection id, the page's
//   browser credentials generation with the session fingerprint the
//   connection opened under (one value across the engine's fields). The
//   operator's `ws.open` opens it — once: an event delivered again opens
//   nothing twice — and its `ws.close` closes it at the instant the operator
//   saw; gap_since is taken from the previous row of the page, as for the
//   engine's own socket.
// - As the page's socket owner it reports `open` while a connection is open,
//   `idle` otherwise: the engine never opens the socket of a browser page
//   (`handshake` sends nothing), so `ws.connect` has nothing to do there.
//
// What comes with the buffer's intake (PR 13): the events themselves —
// `events.subscribe`/`ack` over the operator's stream, in order and
// acknowledged after their commit — the frames, taken by their event id
// (`browser:<buffer id>:<number>`, fenced by the page and the session, not by
// an open row: a frame from the buffer may outlive its connection), their
// receipts and routing as today, the gap marks and the repair at the first
// confirmed frame after a connect. The admission of the site's socket rides
// the site path (`engine/site-admission.ts`, route `ws.upgrade`) over the
// operator's `wsAdmit`/`wsDone`.

export interface BrowserWsSourceDeps {
  db: Database;
  pageId: number;
  /** TESTS ONLY: the generation of a fingerprint (default: the page's
   *  browser credentials generation). */
  generationOf?: (sessionFingerprint: string) => Promise<string | null>;
}

/** How the source took one of the operator's socket events. */
export type BrowserWsTaken = "opened" | "closed" | "known" | "not_a_connection_event" | "page_inactive";

export class BrowserWsSource implements LivePageSocket {
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

  readonly connectNotBefore = null;

  /** The engine never opens a browser page's socket: nothing is sent. */
  async handshake(_hooks: SendHooks, _signal: AbortSignal): Promise<TransportOutcome> {
    return { kind: "aborted_before_send", refusal: "lease_inactive" };
  }

  /** One of the operator's socket events, in the order of its stream: a
   *  connection opened or closed. Other events are the intake's (PR 13). */
  async take(event: BufferEvent): Promise<BrowserWsTaken> {
    switch (event.kind) {
      case "ws.open": {
        const generationOf = this.#d.generationOf
          ?? ((fingerprint: string) => readBrowserCredentialsGeneration(this.#d.db, this.#d.pageId, fingerprint));
        const generation = await generationOf(event.sessionFingerprint);
        if (generation === null) return "page_inactive";
        const opened = await beginBrowserWsConnection(this.#d.db, {
          id: randomUUID(),
          pageId: this.#d.pageId,
          generation,
          browserConnectionId: event.connectionId,
          startedAt: new Date(event.atWall),
        });
        // One socket of a page at a time: an open row before it was closed
        // as abandoned with the insert.
        this.#open.clear();
        this.#open.add(event.connectionId);
        return opened ? "opened" : "known";
      }
      case "ws.close": {
        const closed = await finishBrowserWsConnection(this.#d.db, {
          pageId: this.#d.pageId,
          browserConnectionId: event.connectionId,
          closedAt: new Date(event.atWall),
          reason: event.code === null ? "site_closed" : `site_closed:${event.code}`,
        });
        this.#open.delete(event.connectionId);
        return closed ? "closed" : "known";
      }
      default:
        return "not_a_connection_event";
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#open.clear();
  }
}
