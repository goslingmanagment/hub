import type { EgressContext } from "@agency_hub_core/platform-core";
import {
  assertProxyTargetAllowed,
  buildProxyConfig,
  buildProxyEgressKey,
  createProxyRequestDispatcher,
  getProxyStringError,
  getServiceEgressProxyUrlError,
  type AppConfig,
  type ProxyConfig,
} from "@agency_hub_core/shared";
import type { Dispatcher } from "undici";

type ServiceEgressConfig = Pick<
  AppConfig,
  | "serviceEgressProxyUrl"
  | "serviceEgressProxyUsername"
  | "serviceEgressProxyPassword"
>;

export class ServiceEgressProxyConfigError extends Error {
  override name = "ServiceEgressProxyConfigError";
}

function configured(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function hasServiceEgressProxy(config: ServiceEgressConfig): boolean {
  return configured(config.serviceEgressProxyUrl)
    && configured(config.serviceEgressProxyUsername)
    && configured(config.serviceEgressProxyPassword);
}

/**
 * Resolve the boot-only tuple into the shared proxy shape. The tuple is
 * revalidated here because tests and tooling may construct AppConfig literals
 * without going through loadConfig; malformed input must never become direct
 * egress.
 */
export function resolveServiceEgressProxy(config: ServiceEgressConfig): ProxyConfig | null {
  const values = [
    config.serviceEgressProxyUrl,
    config.serviceEgressProxyUsername,
    config.serviceEgressProxyPassword,
  ];
  const configuredCount = values.filter(configured).length;
  if (configuredCount === 0) {
    return null;
  }
  if (configuredCount !== values.length) {
    throw new ServiceEgressProxyConfigError(
      "SERVICE_EGRESS_PROXY_URL, SERVICE_EGRESS_PROXY_USERNAME, and "
        + "SERVICE_EGRESS_PROXY_PASSWORD must be configured together",
    );
  }

  const url = config.serviceEgressProxyUrl!;
  if (getProxyStringError(url) !== null) {
    throw new ServiceEgressProxyConfigError(
      "SERVICE_EGRESS_PROXY_URL must be a valid SOCKS5 URL",
    );
  }
  const shapeError = getServiceEgressProxyUrlError(url);
  if (shapeError) {
    throw new ServiceEgressProxyConfigError(shapeError);
  }

  const parsed = buildProxyConfig(url);
  if (!parsed) {
    throw new ServiceEgressProxyConfigError(
      "SERVICE_EGRESS_PROXY_URL must be a valid SOCKS5 URL",
    );
  }
  try {
    assertProxyTargetAllowed(parsed);
  } catch {
    throw new ServiceEgressProxyConfigError(
      "SERVICE_EGRESS_PROXY_URL must not target a local or private address",
    );
  }

  return {
    url: parsed.url,
    username: config.serviceEgressProxyUsername!.trim(),
    password: config.serviceEgressProxyPassword!.trim(),
  };
}

export function buildServiceEgressContext(
  config: ServiceEgressConfig,
): EgressContext<Dispatcher> {
  const proxy = resolveServiceEgressProxy(config);
  if (!proxy) {
    throw new ServiceEgressProxyConfigError(
      "The service egress proxy is not configured",
    );
  }

  const dispatcher = createProxyRequestDispatcher(proxy);
  return {
    dispatcher,
    egressKey: `service:${buildProxyEgressKey(proxy)}`,
    pace: async () => 0,
    close: async () => {
      await dispatcher.close();
    },
  };
}
