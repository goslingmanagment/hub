import { findPageById, findPageByLabel } from "@agency_hub_core/db";
import type { EgressContext, EgressScope } from "@agency_hub_core/platform-core";
import {
  buildProxyEgressKey,
  createProxyRequestDispatcher,
  createRequestDispatcher,
  normalizeProxyConfig,
} from "@agency_hub_core/shared";
import type { Dispatcher } from "undici";

import type { AppContext } from "../../bootstrap.ts";
import { NotFoundError, ProxyMissingError } from "../errors.ts";
import {
  resolveStoredProxyConfig,
  resolveStoredProxyEgressKey,
} from "../page-context.ts";
import { createEgressPacer } from "./pacer.ts";
import {
  buildServiceEgressContext,
  resolveServiceEgressProxy,
  ServiceEgressProxyConfigError,
} from "./service-proxy.ts";

// Kernel Stage 26: THE egress resolver — the only legal way to obtain an
// outbound transport for platform traffic. No default path: a caller must
// present a scope, and an unknown scope throws.
//
// RECORDED ADDRESS POLICY (owner-visible, per vendor):
// - page_candidate   — one identity check of a page through the candidate
//   proxy the owner is assigning it (the engine's `account.identity`, step 3b
//   ruling 5): checked before it is stored, so it cannot ride the page scope.
//   Only a page of a platform with page-scoped egress, only with a proxy, and
//   never as a fallback after the page proxy failed.
// - page scope       — the page's assigned proxy is the address identity
//   (Fansly direct-to-platform MUST ride it). The legacy OnlyFans page-scope
//   branch below has no runtime callers: OFAPI callers must use vendor scope,
//   including capture and desktop reads. A FANSLY
//   page without a proxy is REFUSED (W3.1, decision #124 — this reverses the
//   Stage-26 recorded direct fallback): a direct request would ride the
//   shared VPS IP. OnlyFans pages without a proxy still egress direct under
//   egress key "direct" (their platform traffic is vendor-side anyway).
// - vendor "elevenlabs" / "telegram" — the boot-only service SOCKS5 identity.
//   Telegram alone retains a transition fallback to its deprecated page proxy
//   when the entire dedicated tuple is absent. A configured tuple never falls
//   back after an auth/connect failure.
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
  app: Pick<AppContext, "db" | "config">,
  scope: EgressScope,
): Promise<AppEgressContext> {
  if (scope.kind === "vendor") {
    if (scope.vendor === "fansly") {
      throw new Error(
        'Egress scope vendor:"fansly" is refused: Fansly egress is direct-to-platform and must be page-scoped',
      );
    }
    if (scope.vendor === "elevenlabs" || scope.vendor === "telegram") {
      // Calling the strict resolver first is the transition precedence guard:
      // a partial/malformed dedicated tuple throws and can never reach the
      // Telegram legacy branch.
      const serviceProxy = resolveServiceEgressProxy(app.config);
      if (serviceProxy) {
        return buildServiceEgressContext(app.config);
      }
      if (scope.vendor === "elevenlabs") {
        throw new ServiceEgressProxyConfigError(
          "ElevenLabs egress requires the service proxy",
        );
      }
      return resolveLegacyTelegramEgress(app);
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

  if (scope.kind === "page_candidate") {
    const vendor = PLATFORM_VENDORS[stored.page.platform];
    if (vendor !== "fansly") {
      // OFAPI pages have no hub-side address identity to check a proxy for.
      throw new Error(`Egress scope page_candidate is refused for page ${scope.pageId}: its egress is vendor-side`);
    }
    const candidate = normalizeProxyConfig(scope.proxy);
    const dispatcher = createProxyRequestDispatcher(candidate);
    const pacer = createEgressPacer(app, { vendor });
    return {
      egressKey: buildProxyEgressKey(candidate),
      dispatcher,
      pace: (priorityClass) => pacer.pace(priorityClass),
      close: async () => {
        await dispatcher.close();
      },
    };
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

async function resolveLegacyTelegramEgress(
  app: Pick<AppContext, "db" | "config">,
): Promise<AppEgressContext> {
  const pageLabel = app.config.telegramProxyPageLabel;
  if (!pageLabel) {
    throw new ServiceEgressProxyConfigError(
      "Telegram egress requires the service proxy; no transition legacy page route is configured",
    );
  }

  const stored = await findPageByLabel(app.db, pageLabel);
  if (!stored) {
    throw new ServiceEgressProxyConfigError(
      "The Telegram transition legacy page route was not found",
    );
  }
  if (!stored.proxy) {
    throw new ServiceEgressProxyConfigError(
      "The Telegram transition legacy page route has no proxy",
    );
  }

  try {
    const proxy = resolveStoredProxyConfig(app, stored.proxy);
    if (!proxy) {
      throw new Error("empty proxy");
    }
    const dispatcher = createProxyRequestDispatcher(proxy);
    return {
      egressKey: `legacy-page:${resolveStoredProxyEgressKey(stored.proxy)}`,
      dispatcher,
      pace: async () => 0,
      close: async () => {
        await dispatcher.close();
      },
    };
  } catch {
    throw new ServiceEgressProxyConfigError(
      "The Telegram transition legacy page route has invalid proxy configuration",
    );
  }
}
