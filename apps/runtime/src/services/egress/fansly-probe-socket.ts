import type { FanslySendLease } from "@agency_hub_core/fansly";
import { WebSocket } from "undici";
import type { AppEgressContext } from "./resolver.ts";
import type { ProbeTransportDiagnostics } from "./fansly-probe-diagnostics.ts";
import { bindFanslyUpgradeLease } from "./fansly-send-lease.ts";

/** The caller resolves one active Fansly page and owns this dedicated egress.
 * This helper neither authenticates nor paces REST requests. An outer process
 * deadline is required: dispatcher.destroy() does not own an upgraded socket.
 *
 * Plan §2.4/§2.5: the HTTP Upgrade rides `lease`, a capture of the page's send
 * guard (source `ws_probe`) taken by the caller for this one connection; it
 * admits exactly one handshake and completes when the handshake settles. */
export function openFanslyProbeSocket(
  egress: AppEgressContext,
  lease: FanslySendLease,
  diagnostics?: ProbeTransportDiagnostics,
): WebSocket {
  if (!egress.dispatcher || !egress.egressKey || egress.egressKey === "direct"
    || /^(vendor|service|legacy-page):/.test(egress.egressKey)) {
    throw new Error("fansly_probe_page_egress_required");
  }

  const dispatcher = diagnostics ? diagnostics.wrap(egress.dispatcher) : egress.dispatcher;
  return new WebSocket("wss://wsv3.fansly.com/?v=3", {
    dispatcher: bindFanslyUpgradeLease(lease, dispatcher),
    headers: { origin: "https://fansly.com" },
  });
}
