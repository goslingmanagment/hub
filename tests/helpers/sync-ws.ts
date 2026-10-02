import { createRequire } from "node:module";

import type { Database } from "@agency_hub_core/db";
import type { FanslyWireRequest } from "@agency_hub_core/fansly";
import type { AppConfig } from "@agency_hub_core/shared";

import { bindFanslyUpgradeLease } from "../../apps/runtime/src/services/egress/fansly-send-lease.ts";
import type { FanslyReceiverSocket } from "../../apps/runtime/src/services/fansly-ws/connection.ts";
import type { LivePageLinks, SyncHostOptions } from "../../apps/runtime/src/sync/engine/host.ts";
import { REQUEST_TIMEOUT_MS } from "../../apps/runtime/src/sync/engine/pacer.ts";
import type { SendHooks, TransportOutcome } from "../../apps/runtime/src/sync/engine/ports.ts";
import {
  createEngineRegistry,
  type EngineRegistry,
  type EngineResourceSpec,
  type RequestPlan,
  type ResourceModule,
} from "../../apps/runtime/src/sync/engine/resource.ts";
import type { PageTransport } from "../../apps/runtime/src/sync/engine/shadow.ts";
import { fanslyResourceSpec } from "../../apps/runtime/src/sync/fansly/registry.ts";
import { createPageTransport } from "../../apps/runtime/src/sync/fansly/transport.ts";
import {
  FANSLY_WS_SOURCE_TIMING,
  type FanslyWsSource,
  type FanslyWsSocketOpener,
  type FanslyWsSourceTiming,
} from "../../apps/runtime/src/sync/fansly/ws/source.ts";
import { serviceFrame } from "./fansly-ws-fixtures.ts";
import { testSpec } from "./sync-engine-host.ts";
import {
  HARNESS_KEY,
  HARNESS_WS_PATH,
  harnessHostOptions,
  type FakeWsPeer,
  type HarnessPage,
  type TakeoverRecord,
} from "./sync-engine.ts";

// The engine's page socket against the fake origin (step-3 design §3.3): the
// production socket source and its engine lease over the pacer check; only
// the socket's URL is the harness's (`ws://<origin>/ws?v=3`, through the page
// proxy, instead of wsv3.fansly.com) and the `ws.connect` resource is a
// stand-in for S3-04's: its plan asks the source whether a connection is
// wanted and when, its request is routed to `FanslyWsSource.handshake`.

/** The source on scaled time (production: `FANSLY_WS_SOURCE_TIMING`). */
export const WS_TEST_TIMING: Readonly<FanslyWsSourceTiming> = Object.freeze({
  ...FANSLY_WS_SOURCE_TIMING,
  authTimeoutMs: 3_000,
  checkMs: 200,
  guardStaleMs: 2_000,
  pingMs: 1_000,
  pongTimeoutMs: 3_000,
  drainMs: 2_000,
  applyDrainMs: 1_500,
  reconnectBaseMs: 100,
  downListAfterMs: 1_000,
  downCheckMs: 200,
  recheckMs: 300,
  reacquireMs: 200,
  handshakeTimeoutMs: 5_000,
  settleWaitMs: 5_000,
});

type UndiciWebSocket = FanslyReceiverSocket & { close(): void };
const runtimeRequire = createRequire(new URL("../../apps/runtime/src/bootstrap.ts", import.meta.url));
const { WebSocket } = runtimeRequire("undici") as {
  WebSocket: new (url: string, init: { dispatcher: unknown; headers?: Record<string, string> }) => UndiciWebSocket;
};

/**
 * `openFanslyReceiverSocket` with the harness origin's URL: the same page
 * egress (the counting proxy), the same lease binding (`bindFanslyUpgradeLease`,
 * whose check is the admission's), the same stop.
 */
export function harnessSocketOpener(origin: string): FanslyWsSocketOpener {
  return (egress, lease) => {
    const base = egress.dispatcher;
    if (base === null) throw new Error("harness socket: the page has no egress dispatcher");
    const dispatcher = bindFanslyUpgradeLease(lease, base);
    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}${HARNESS_WS_PATH}?v=3`, {
      dispatcher,
      headers: { origin: "https://fansly.com" },
    });
    return {
      socket,
      stop() {
        try {
          socket.close();
        } catch {
          // Destroying the dispatcher covers a socket that never opened.
        }
        void base.destroy().catch(() => undefined);
      },
    };
  };
}

export const WS_SESSION_FRAME = '{"t":1,"d":"{}"}';
export const WS_PONG_FRAME = '{"t":2,"d":"{}"}';
export const WS_AUTH_REFUSED_FRAME = JSON.stringify({ t: 0, d: JSON.stringify({ code: 401 }) });
/** A business frame that is neither a message nor money (routes nothing). */
export const WS_NOOP_FRAME = serviceFrame({ type: 99 }, 99);

export interface FanslyPeerScript {
  /** Answer the auth frame with the refusal (`t:0`, code 401). */
  refuseAuth?: boolean;
  /** Runs once the session frame was sent. */
  onSession?: (peer: FakeWsPeer) => void;
}

/** The origin's side of Fansly's socket protocol: the session (or its
 *  refusal) for the auth frame, a pong for every ping. */
export function speakFansly(peer: FakeWsPeer, script: FanslyPeerScript = {}): void {
  peer.onText = (text) => {
    if (text === "p") {
      peer.send(WS_PONG_FRAME);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || (parsed as { t?: unknown }).t !== 1) return;
    if (script.refuseAuth === true) {
      peer.send(WS_AUTH_REFUSED_FRAME);
      return;
    }
    peer.send(WS_SESSION_FRAME);
    script.onSession?.(peer);
  };
}

// ── the stand-in `ws.connect` and the transport ─────────────────────────────

const WS_MARKER_URL = "harness-ws://upgrade";

function isWsMarker(params: unknown): boolean {
  return typeof params === "object" && params !== null && (params as { harness?: unknown }).harness === "ws";
}

/** `ws.connect` as S3-04 plans it: a request only while the source has the
 *  page's lock and no socket, not before the ladder's instant. */
export function wsConnectTestModule(sourceOf: () => FanslyWsSource | null): ResourceModule {
  return {
    async plan(_work, ctx) {
      const source = sourceOf();
      if (source === null || (source.state !== "owning" && source.state !== "down")) {
        return { kind: "wait", reason: "dependency", until: new Date(ctx.now.getTime() + 100) };
      }
      const notBefore = source.connectNotBefore;
      if (notBefore !== null && notBefore.getTime() > ctx.now.getTime()) {
        return { kind: "wait", reason: "not_due", until: notBefore };
      }
      const request: RequestPlan = { spec: "polls", params: { harness: "ws" } as never };
      return { kind: "request", request };
    },
    apply: async () => ({ work: { satisfiesRevision: true, close: "done", closeReason: "upgraded" }, followups: [] }),
    shadow: async () => ({ work: { satisfiesRevision: true, close: "done" }, followups: [] }),
  };
}

/** A registry entry without code: its work waits on `dependency` (the demand
 *  the source raised stays visible). */
function waiting(key: string): EngineResourceSpec {
  const spec = fanslyResourceSpec(key);
  if (spec === null) throw new Error(`no registry entry ${key}`);
  const { module: _module, ...rest } = spec;
  return rest;
}

/**
 * The socket tests' registry: the stand-in `ws.connect` (101 is its answer),
 * the harness's urgent REST read, and the keys the source raises demand for —
 * `repair.ws-gap`, `dm-conversations.ws-down`, `account.verify` — as entries
 * whose work waits, plus `extra`.
 */
export function wsTestRegistry(sourceOf: () => FanslyWsSource | null, extra: readonly EngineResourceSpec[] = []): EngineRegistry {
  const urgent: ResourceModule = {
    plan: async () => ({ kind: "request", request: { spec: "trackinglinks", params: {} as never } }),
    apply: async () => ({ work: { satisfiesRevision: true, close: "done" }, followups: [] }),
    shadow: async () => ({ work: { satisfiesRevision: true, close: "done" }, followups: [] }),
  };
  return createEngineRegistry([
    testSpec("ws.connect", wsConnectTestModule(sourceOf), { terminalStatuses: [101], liveOnly: true }),
    testSpec(HARNESS_KEY.urgent, urgent),
    waiting("repair.ws-gap"),
    waiting("dm-conversations.ws-down"),
    waiting("account.verify"),
    ...extra,
  ]);
}

/** The page transport of the socket tests: REST through the production page
 *  transport, the stand-in `ws.connect`'s request to the source's handshake. */
export async function createWsHarnessTransport(
  ctx: { db: Database; config: AppConfig },
  page: HarnessPage,
  links: LivePageLinks,
): Promise<PageTransport> {
  const rest = await createPageTransport(ctx, page);
  return {
    async prepare(request: RequestPlan): Promise<FanslyWireRequest> {
      if (isWsMarker(request.params)) return { spec: request.spec, url: WS_MARKER_URL, headers: {}, timeoutMs: REQUEST_TIMEOUT_MS };
      return rest.prepare(request);
    },
    async send(req: FanslyWireRequest, hooks: SendHooks, signal: AbortSignal): Promise<TransportOutcome> {
      if (req.url !== WS_MARKER_URL) return rest.send(req, hooks, signal);
      if (links.ws === null) return { kind: "aborted_before_send", refusal: "lease_inactive" };
      return links.ws.handshake(hooks, signal);
    },
    close: () => rest.close(),
  };
}

/** A live host over the harness with the page's socket on the fake origin. */
export function wsHostOptions(input: Parameters<typeof harnessHostOptions>[0] & {
  /** The fake origin (`FakeFanslyServer.origin`) the socket connects to. */
  wsOrigin: string;
  sourceOf: () => FanslyWsSource | null;
  timing?: FanslyWsSourceTiming;
  extraSpecs?: readonly EngineResourceSpec[];
  takeovers?: TakeoverRecord[];
}): SyncHostOptions {
  // The page's real socket source, not the harness's stand-in owner: without
  // `liveSocket` the host creates a `FanslyWsSource` per live slot.
  const { liveSocket: _standIn, ...base } = harnessHostOptions({
    ...input,
    registry: input.registry ?? wsTestRegistry(input.sourceOf, input.extraSpecs),
  });
  return {
    ...base,
    liveTransportFactory: async (page, links) => createWsHarnessTransport(
      { db: input.db, config: input.config },
      { pageId: page.pageId, pageLabel: page.pageLabel ?? `page-${page.pageId}` },
      links,
    ),
    wsSourceOverrides: { timing: input.timing ?? WS_TEST_TIMING, openSocket: harnessSocketOpener(input.wsOrigin) },
  };
}
