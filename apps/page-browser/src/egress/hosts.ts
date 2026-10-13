// What the operator's proxy lets Chrome reach, by host: the map of
// operations' classes (policy/operations.ts, spec §2.1, owner decision №2).
//
//   site        Fansly's page, scripts, styles, fonts, and any other host
//               under fansly.com: a plain tunnel, journaled
//   api         the API: every TLS record through the send gate (gate.ts)
//   ws          the site's socket: one tunnel per socket, each by the
//               engine's admission (ws/sockets.ts); any other request to
//               this host is failed in the interception and by the rules
//               extension, so no socket rides another's connection (stage 1,
//               §3.2)
//   cdn         media and previews: a plain tunnel, journaled
//   third_party a host the site loads that is not Fansly's — and Chrome's own
//               service traffic: a plain tunnel through the page's SOCKS5,
//               journaled (decision №2)
//   closed      a host the map closes (the second socket, the upload API):
//               refused
//   denied      local, private and special-use names: refused

import { API_HOST, CDN_HOST, classifyHost, SITE_HOST, SOCKET_HOST, type HostClass } from "../policy/operations.ts";

export type { HostClass };
export { hostMatches } from "../policy/operations.ts";

export type HostClassifier = (host: string) => HostClass;

export const FANSLY_HOSTS = {
  site: [SITE_HOST],
  api: [API_HOST],
  ws: [SOCKET_HOST],
  cdn: [CDN_HOST],
} as const;

/** The proxy refuses these classes outright. */
export function refusedClass(cls: HostClass): boolean {
  return cls === "closed" || cls === "denied";
}

export const classifyFanslyHost: HostClassifier = classifyHost;
