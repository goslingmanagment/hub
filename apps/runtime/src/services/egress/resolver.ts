import { findPageById } from "@agency_hub_core/db";
import type { EgressContext, EgressScope } from "@agency_hub_core/platform-core";
import {
  createProxyRequestDispatcher,
  createRequestDispatcher,
} from "@agency_hub_core/shared";
import type { Dispatcher } from "undici";

import type { AppContext } from "../../bootstrap.ts";
import { NotFoundError, ProxyMissingError } from "../errors.ts";
import {
  resolveStoredProxyConfig,
  resolveStoredProxyEgressKey,
} from "../page-context.ts";
import { createEgressPacer } from "./pacer.ts";

// Kernel Stage 26: THE egress resolver — the only legal way to obtain an
// outbound transport for platform traffic. No default path: a caller must
// present a scope, and an unknown scope throws.
//
// RECORDED ADDRESS POLICY (owner-visible, per vendor):
// - page scope       — the page's assigned proxy is the address identity
//   (Fansly direct-to-platform MUST ride it; OFAPI account-scoped reads ride
//   it so large bodies don't traverse the hub VPS direct route). A FANSLY
//   page without a proxy is REFUSED (W3.1, decision #124 — this reverses the
//   Stage-26 recorded direct fallback): a direct request would ride the
//   shared VPS IP. OnlyFans pages without a proxy still egress direct under
//   egress key "direct" (their platform traffic is vendor-side anyway).
// - vendor "ofapi"   — vendor-DIRECT (dispatcher null, hub address). The
//   OFAPI gateway terminates at onlyfansapi.com, not at the platform;
//   address consistency to the vendor gateway is deliberately not
//   proxy-per-page (today's behavior, now recorded instead of accidental).
// - vendor "fansly"  — REFUSED. Fansly egress is direct-to-platform and must
//   always be page-scoped; a vendor-wide Fansly transport would be an
//   address-consistency violation by construction.

export type AppEgressContext = EgressContext<Dispatcher>;

/** Which vendor's pacing rows a platform's page-scoped egress rides. */
const PLATFORM_VENDORS = {
  onlyfans: "ofapi",
  fansly: "fansly",
} as const;

export async function resolveEgress(
  app: AppContext,
  scope: EgressScope,
): Promise<AppEgressContext> {
  if (scope.kind === "vendor") {
    if (scope.vendor === "fansly") {
      throw new Error(
        'Egress scope vendor:"fansly" is refused: Fansly egress is direct-to-platform and must be page-scoped',
      );
    }
    if (scope.vendor === "elevenlabs") {
      // Voice notes vendor TTS: a NON-platform vendor (deliberately absent from
      // PLATFORM_VENDORS and the pacer's EGRESS_VENDOR_PROVIDERS). Direct hub
      // egress (dispatcher null), UNPACED — the provider makes exactly one
      // attempt and this vendor is not rate-limit-governed by the seam.
      return {
        egressKey: "vendor:elevenlabs",
        dispatcher: null,
        pace: async () => 0,
        close: async () => {},
      };
    }
    if (scope.vendor !== "ofapi") {
      throw new Error(`Unknown egress vendor "${scope.vendor}"`);
    }

    const pacer = createEgressPacer(app, { vendor: "ofapi" });
    return {
      egressKey: "vendor:ofapi",
      dispatcher: null,
      pace: (priorityClass) => pacer.pace(priorityClass),
      close: async () => {},
    };
  }

  const stored = await findPageById(app.db, scope.pageId);
  if (!stored) {
    throw new NotFoundError(`Page ${scope.pageId} not found for egress resolution`);
  }

  const proxy = resolveStoredProxyConfig(app, stored.proxy);
  const egressKey = resolveStoredProxyEgressKey(stored.proxy);
  const vendor = PLATFORM_VENDORS[stored.page.platform];
  if (!proxy && vendor === "fansly") {
    // W3.1 (decision #124): fansly-vendor traffic is direct-to-platform, so
    // a proxyless page would egress from the shared VPS IP — refused.
    throw new ProxyMissingError(
      `Page ${scope.pageId} has no assigned proxy; Fansly egress is refused (fail-closed)`,
    );
  }
  const dispatcher = proxy
    ? createProxyRequestDispatcher(proxy)
    : createRequestDispatcher();
  const pacer = createEgressPacer(app, { vendor });

  return {
    egressKey,
    dispatcher,
    pace: (priorityClass) => pacer.pace(priorityClass),
    close: async () => {
      await dispatcher.close();
    },
  };
}
