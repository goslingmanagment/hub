// What the operator's proxy lets Chrome reach, by host (spec §2.1). The map
// of operations (policy/operations.ts, PR 6) takes this table over; until
// then it is the spec's list.
//
//   site  — the site's page, scripts, styles, fonts: a plain tunnel, journaled
//   api   — the API: every TLS record through the send gate (egress/gate.ts)
//   ws    — the site's socket: one tunnel per socket, each by the engine's
//           admission (PR 10); until that path exists, refused
//   cdn   — media and previews: a plain tunnel, journaled
//   denied — everything else, Chrome's own service hosts included until the
//           owner approves their list (stage 1, item 10; owner decision №2)

export type HostClass = "site" | "api" | "ws" | "cdn" | "denied";

export type HostClassifier = (host: string) => HostClass;

export const FANSLY_HOSTS = {
  site: ["fansly.com"],
  api: ["apiv3.fansly.com"],
  ws: ["wsv3.fansly.com"],
  cdn: ["cdn*.fansly.com"],
} as const;

/** A host list entry is a name, or a pattern with `*` standing for part of
 *  one label (`cdn*.fansly.com`). */
export function hostMatches(entry: string, host: string): boolean {
  if (!entry.includes("*")) return entry === host;
  const pattern = entry
    .split("*")
    .map((part) => part.replace(/[.\\^$+?()[\]{}|]/g, "\\$&"))
    .join("[^.]*");
  return new RegExp(`^${pattern}$`).test(host);
}

export function classifierOf(hosts: Partial<Record<Exclude<HostClass, "denied">, readonly string[]>>): HostClassifier {
  const order: Array<Exclude<HostClass, "denied">> = ["site", "api", "ws", "cdn"];
  return (host) => {
    const name = host.toLowerCase();
    for (const cls of order) {
      if ((hosts[cls] ?? []).some((entry) => hostMatches(entry, name))) return cls;
    }
    return "denied";
  };
}

export const classifyFanslyHost: HostClassifier = classifierOf(FANSLY_HOSTS);
