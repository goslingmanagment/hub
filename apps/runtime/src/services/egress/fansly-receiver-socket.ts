import type { Duplex } from "node:stream";
import type { FanslySendLease } from "@agency_hub_core/fansly";
import { WebSocket, type Dispatcher } from "undici";
import type { AppEgressContext } from "./resolver.ts";
import { createFanslyWsFrameBudget } from "./fansly-ws-frame-budget.ts";
import { bindFanslyUpgradeLease } from "./fansly-send-lease.ts";

/** Own the upgraded transport as well as the dispatcher. Undici's close()
 * handshake alone cannot enforce a stop on a stalled peer.
 *
 * Plan §2.4/§2.5: the HTTP Upgrade is a request of the page and rides `lease`
 * (the engine's lease over its pacer check, `sync/fansly/ws/source.ts`), taken
 * for this one attempt. The lease admits exactly one handshake and completes
 * when it settles (101, another status or an error); a reconnect is a new
 * admission. */
export function openFanslyReceiverSocket(egress: AppEgressContext, lease: FanslySendLease) {
  if (!egress.dispatcher || !egress.egressKey || egress.egressKey === "direct"
    || /^(vendor|service|legacy-page):/.test(egress.egressKey)) {
    throw new Error("fansly_receiver_page_egress_required");
  }
  let upgraded: Duplex | undefined;
  let stopped = false;
  const acceptBytes = createFanslyWsFrameBudget();
  const receiver = egress.dispatcher.compose((dispatch) => (options, handler) => dispatch({
    ...options,
    // Undici offers compression by default, whose decompressed fragments can
    // exceed the wire budget. B0 intentionally negotiates no extensions.
    headers: withoutCompression(options.headers),
  }, {
    onRequestStart: (controller, context) => {
      if (stopped) { controller.abort(new Error("fansly_receiver_stopped")); return; }
      handler.onRequestStart?.(controller, context);
    },
    onRequestUpgrade(controller, status, headers, socket) {
      upgraded = socket;
      if (stopped) { socket.destroy(); return; }
      if (Object.keys(headers).some((name) => name.toLowerCase() === "sec-websocket-extensions")) {
        socket.destroy();
        handler.onResponseError?.(controller, new Error("fansly_receiver_extensions_refused"));
        return;
      }
      const installBudget = (event: string | symbol) => {
        if (event !== "data") return;
        socket.removeListener("newListener", installBudget);
        socket.prependListener("data", (chunk: Buffer) => {
          if (!acceptBytes(chunk)) socket.destroy();
        });
      };
      // Wait for Undici's reader: adding a data listener here immediately can
      // consume upgrade-head bytes before Undici attaches after its promise.
      socket.on("newListener", installBudget);
      handler.onRequestUpgrade?.(controller, status, headers, socket);
    },
    onResponseStart: (controller, status, headers, statusText) => handler.onResponseStart?.(controller, status, headers, statusText),
    onResponseStarted: () => handler.onResponseStarted?.(),
    onResponseData: (controller, chunk) => handler.onResponseData?.(controller, chunk),
    onResponseEnd: (controller, trailers) => handler.onResponseEnd?.(controller, trailers),
    onResponseError: (controller, error) => handler.onResponseError?.(controller, error),
  }));
  // The guard's send check is the last check before the headers are written.
  const dispatcher = bindFanslyUpgradeLease(lease, receiver);
  const socket = new WebSocket("wss://wsv3.fansly.com/?v=3", {
    dispatcher, headers: { origin: "https://fansly.com" },
  });
  return {
    socket,
    stop() {
      stopped = true;
      try { socket.close(); } catch { /* destroy below also covers pre-open */ }
      upgraded?.destroy();
      void egress.dispatcher!.destroy().catch(() => undefined);
    },
  };
}

function withoutCompression(headers: Dispatcher.DispatchOptions["headers"]): string[] {
  if (Array.isArray(headers)) {
    const filtered: string[] = [];
    for (let i = 0; i < headers.length; i += 2) {
      if (headers[i]!.toLowerCase() !== "sec-websocket-extensions") filtered.push(headers[i]!, headers[i + 1]!);
    }
    return filtered;
  }
  return Object.entries(headers ?? {}).flatMap(([name, value]) => name.toLowerCase() === "sec-websocket-extensions"
    || value === undefined ? [] : [name, String(value)]);
}
