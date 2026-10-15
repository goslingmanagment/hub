import { createHmac, randomBytes, randomUUID } from "node:crypto";

import type { PastedProxy } from "@agency_hub_core/shared";

// The owner's proxy checks the API remembers for a short while (Project
// Browser, owner decision 2026-10-15; Astra's review of PR #627, round 2):
// a check is the only source of the SOCKS5 address a page's browser is made
// for. It records the exact `ip:port` it connected to — the address it
// judged public, from its one DNS answer — and a keyed hash of the proxy it
// checked; a save names the check, gets that address back only for the
// same proxy and only while the check is fresh, and resolves nothing
// itself. So what is stored is always what was checked.
//
// In memory only, in the one API process (docker-compose.production.yml:
// one `api`): a check outlives neither a restart nor `PROXY_CHECK_TTL_MS`
// (the owner checks again). The hash is an HMAC under a key made at the
// process's start, so even this memory holds nothing a password could be
// recovered from offline; nothing of it is logged, stored or answered but
// the check's id.

/** How long a check may be named by a save. */
export const PROXY_CHECK_TTL_MS = 10 * 60_000;
/** At most so many remembered checks (the oldest go first). */
const MAX_CHECKS = 500;

export type ProxyCheckRefusal = "no_check" | "stale" | "proxy_changed";

interface Recorded {
  proxyHash: string;
  socksEndpoint: string;
  at: number;
}

export class ProxyCheckLedger {
  readonly #key = randomBytes(32);
  readonly #checks = new Map<string, Recorded>();
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(options: { now?: (() => number) | undefined; ttlMs?: number | undefined } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? PROXY_CHECK_TTL_MS;
  }

  /** The proxy as checked, keyed: its type, address, port, login and
   *  password (`socks5h` is `socks5`: the same proxy). */
  #hashOf(proxy: Pick<PastedProxy, "scheme" | "host" | "port" | "username" | "password">): string {
    const scheme = proxy.scheme === "socks5h" ? "socks5" : proxy.scheme;
    return createHmac("sha256", this.#key).update(JSON.stringify([scheme, proxy.host.toLowerCase(), proxy.port, proxy.username, proxy.password])).digest("hex");
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, check] of this.#checks) {
      if (now - check.at > this.#ttlMs) this.#checks.delete(id);
    }
    while (this.#checks.size >= MAX_CHECKS) {
      const oldest = this.#checks.keys().next().value;
      if (oldest === undefined) break;
      this.#checks.delete(oldest);
    }
  }

  /** A check that reached the proxy and logged in, remembered: its id. */
  record(proxy: Pick<PastedProxy, "scheme" | "host" | "port" | "username" | "password">, socksEndpoint: string): string {
    this.#prune();
    const id = randomUUID();
    this.#checks.set(id, { proxyHash: this.#hashOf(proxy), socksEndpoint, at: this.#now() });
    return id;
  }

  /** The address the check `id` connected to — for this very proxy, while
   *  fresh — or why not. */
  take(id: string, proxy: Pick<PastedProxy, "scheme" | "host" | "port" | "username" | "password">): { socksEndpoint: string } | { refusal: ProxyCheckRefusal } {
    const check = this.#checks.get(id);
    if (check === undefined) return { refusal: "no_check" };
    if (this.#now() - check.at > this.#ttlMs) {
      this.#checks.delete(id);
      return { refusal: "stale" };
    }
    if (check.proxyHash !== this.#hashOf(proxy)) return { refusal: "proxy_changed" };
    return { socksEndpoint: check.socksEndpoint };
  }
}
