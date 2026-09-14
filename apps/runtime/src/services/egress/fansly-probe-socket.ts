import { WebSocket } from "undici";
import type { AppEgressContext } from "./resolver.ts";

/** The caller resolves one active Fansly page and owns this dedicated egress.
 * This helper neither authenticates nor paces REST requests. An outer process
 * deadline is required: dispatcher.destroy() does not own an upgraded socket. */
export function openFanslyProbeSocket(egress: AppEgressContext): WebSocket {
  if (!egress.dispatcher || !egress.egressKey || egress.egressKey === "direct"
    || /^(vendor|service|legacy-page):/.test(egress.egressKey)) {
    throw new Error("fansly_probe_page_egress_required");
  }

  return new WebSocket("wss://wsv3.fansly.com/?v=3", {
    dispatcher: egress.dispatcher,
    headers: { origin: "https://fansly.com" },
  });
}
