import { findPageById, findPageByLabel } from "@agency_hub_core/db";
import type { EgressContext, EgressScope } from "@agency_hub_core/platform-core";
import { createProxyRequestDispatcher, createRequestDispatcher, type Platform } from "@agency_hub_core/shared";
import type { Dispatcher } from "undici";

import type { AppContext } from "../../bootstrap.ts";
import { NotFoundError, ProxyMissingError } from "../errors.ts";
import {
  resolveStoredProxyConfig,
  resolveStoredProxyEgressKey,
} from "../page-context.ts";
import { resolveFanslyPublicEgress } from "./fansly-public.ts";
import {
  buildServiceEgressContext,
  resolveServiceEgressProxy,
  ServiceEgressProxyConfigError,
} from "./service-proxy.ts";

// THE egress resolver — the only legal way to obtain an
// outbound transport for platform traffic. No default path: a caller must
// present a scope, and an unknown scope throws.
//
// RECORDED ADDRESS POLICY (owner-visible, per vendor):
// - fansly_public    — the session-less public account reader (arena "vanished
//   chat" R5, owner decision Р1): its OWN proxy, which the owner configures
//   and no page holds (`fansly_public_egress`; a page's proxy is refused),
//   letting through Fansly's API host only (`FANSLY_PUBLIC_API_HOST`;
//   anything else is refused before a connection opens). Never direct and
//   never a fallback: without that proxy the scope throws and the reader
//   sends nothing. Unpaced here: the reader paces itself
//   (egress/fansly-public.ts).
// - page scope       — the page's assigned proxy is the address identity
//   (Fansly direct-to-platform MUST ride it). The legacy OnlyFans page-scope
//   branch below has no runtime callers: OFAPI callers must use vendor scope,
//   including capture and desktop reads. A FANSLY
//   page without a proxy is REFUSED (W3.1 — this reverses the earlier
//   direct fallback): a direct request would ride the
//   shared VPS IP. OnlyFans pages without a proxy still egress direct under
//   egress key "direct" (their platform traffic is vendor-side anyway).
// - vendor "elevenlabs" / "telegram" — the boot-only service SOCKS5 identity.
//   Telegram alone retains a transition fallback to its deprecated page proxy
//   when the entire dedicated tuple is absent. A configured tuple never falls
//   back after an auth/connect failure.
//   The FANSLY BLOCKLIST reader's MTProto connection is no HTTP request this
//   resolver can carry: it rides the same SOCKS5 identity, read from the same
//   tuple (services/fansly-blocklist/telegram.ts), direct only without one or
//   on TG_READER_DIRECT.
// - vendor "ofapi"   — vendor-DIRECT (dispatcher null, hub address). The
//   OFAPI gateway terminates at onlyfansapi.com, not at the platform;
//   address consistency to the vendor gateway is deliberately not
//   proxy-per-page (today's behavior, now recorded instead of accidental).
// - vendor "fansly"  — REFUSED. Fansly egress is direct-to-platform and must
//   always be page-scoped; a vendor-wide Fansly transport would be an
//   address-consistency violation by construction.

export type AppEgressContext = EgressContext<Dispatcher>;

/** Which vendor's pacing rows a platform's page-scoped egress rides. */
const PLATFORM_VENDORS: Readonly<Partial<Record<Platform, "ofapi" | "fansly">>> = {
  onlyfans: "ofapi",
  fansly: "fansly",
  // Telegram: none. The hub sends nothing to Telegram for a page (the chat
  // extension reads the persona's Telegram in the chatter's browser).
};

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

    // The OFAPI client claims its own pacing slot (ofapiRestDelayMs).
    return {
      egressKey: "vendor:ofapi",
      dispatcher: null,
      pace: async () => 0,
      close: async () => {},
    };
  }

  if (scope.kind === "fansly_public") {
    return resolveFanslyPublicEgress(app);
  }

  const stored = await findPageById(app.db, scope.pageId);
  if (!stored) {
    throw new NotFoundError(`Page ${scope.pageId} not found for egress resolution`);
  }

  const proxy = resolveStoredProxyConfig(app, stored.proxy);
  const egressKey = resolveStoredProxyEgressKey(stored.proxy);
  const vendor = PLATFORM_VENDORS[stored.page.platform];
  if (vendor === undefined) {
    throw new Error(
      `Page ${scope.pageId} is a ${stored.page.platform} page: the hub has no platform egress for it`,
    );
  }
  if (!proxy && vendor === "fansly") {
    // W3.1: fansly-vendor traffic is direct-to-platform, so
    // a proxyless page would egress from the shared VPS IP — refused.
    throw new ProxyMissingError(
      `Page ${scope.pageId} has no assigned proxy; Fansly egress is refused (fail-closed)`,
    );
  }
  const dispatcher = proxy
    ? createProxyRequestDispatcher(proxy)
    : createRequestDispatcher();
  // Platform pacing lives with the callers: the Fansly engine's per-page
  // pause and send guard, the OFAPI client's slot.
  return {
    egressKey,
    dispatcher,
    pace: async () => 0,
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
