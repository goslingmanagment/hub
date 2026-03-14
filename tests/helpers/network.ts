import type { AddressInfo, Server as NetServer } from "node:net";

import { acquireTestPrerequisite } from "./prerequisites.ts";

export async function listenOnLoopback(
  server: NetServer,
  purpose: string,
): Promise<{ host: string; port: number } | null> {
  return acquireTestPrerequisite(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeAllListeners("error");
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP address");
    }

    return {
      host: address.address,
      port: address.port,
    };
  }, {
    prerequisite: `loopback TCP listener for ${purpose}`,
    reason: "These tests need permission to bind an ephemeral localhost socket.",
  });
}

export function asAddressInfo(address: string | AddressInfo | null) {
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }

  return address;
}
