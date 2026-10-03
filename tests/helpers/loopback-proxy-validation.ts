import type { ProxyConfig } from "@agency_hub_core/shared";

import type * as ProxyValidation from "../../apps/runtime/src/services/proxy-validation.ts";

// The proxy target check (`assertAllowedProxyTarget`) refuses a loopback
// proxy, and a test's CONNECT proxy listens on loopback. A test file that
// sends a Fansly identity check without a page — whose egress scope runs the
// check — through such a proxy mocks `services/proxy-validation.ts` with this:
//
//   const loopbackProxies = vi.hoisted(() => new Set<string>());
//   vi.mock("../apps/runtime/src/services/proxy-validation.ts", async (importOriginal) =>
//     (await import("./helpers/loopback-proxy-validation.ts")).loopbackProxyValidation(await importOriginal(), loopbackProxies));
//
// Exactly the proxies it registers (by `host:port`) pass; every other target
// is judged by the real check.

export function loopbackProxyValidation(
  actual: typeof ProxyValidation,
  allowed: ReadonlySet<string>,
): typeof ProxyValidation {
  return {
    ...actual,
    async assertAllowedProxyTarget(proxy: ProxyConfig) {
      if (allowed.has(new URL(proxy.url).host)) return;
      await actual.assertAllowedProxyTarget(proxy);
    },
  };
}
