import { lookup } from "node:dns/promises";

import {
  assertProxyTargetAllowed,
  isDisallowedProxyHostname,
  normalizeProxyConfigWithMetadata,
  type ProxyConfig,
} from "@agency_hub_core/shared";

import { BadRequestError } from "./errors.ts";

function toBadRequest(error: unknown) {
  return new BadRequestError(error instanceof Error ? error.message : "Invalid proxy target");
}

export async function assertAllowedProxyTarget(proxy: ProxyConfig) {
  try {
    assertProxyTargetAllowed(proxy);
  } catch (error) {
    throw toBadRequest(error);
  }

  const normalized = normalizeProxyConfigWithMetadata(proxy);
  try {
    const addresses = await lookup(normalized.hostname, {
      all: true,
      verbatim: true,
    });

    const blocked = addresses.find((address) => isDisallowedProxyHostname(address.address));
    if (blocked) {
      throw new BadRequestError("Proxy host resolves to a loopback, private, link-local, multicast, or localhost address");
    }
  } catch (error) {
    if (error instanceof BadRequestError) {
      throw error;
    }
    // DNS failures still fail during the subsequent proxy verification request.
    // The guard is best-effort for hostnames and strict for literals.
  }
}
