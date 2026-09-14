import type { Duplex } from "node:stream";
import { WebSocket, type Dispatcher } from "undici";
import type { AppEgressContext } from "./resolver.ts";
import { createFanslyWsFrameBudget } from "./fansly-ws-frame-budget.ts";

/** Own the upgraded transport as well as the dispatcher. Undici's close()
 * handshake alone cannot enforce the B0 kill-switch on a stalled peer. */
export function openFanslyReceiverSocket(egress: AppEgressContext) {
  if (!egress.dispatcher || !egress.egressKey || egress.egressKey === "direct"
    || /^(vendor|service|legacy-page):/.test(egress.egressKey)) {
    throw new Error("fansly_receiver_page_egress_required");
  }
  let upgraded: Duplex | undefined;
  let stopped = false;
  const acceptBytes = createFanslyWsFrameBudget();
  const dispatcher = egress.dispatcher.compose((dispatch) => (options, handler) => dispatch({
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
        socket.destroy(); return;
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
