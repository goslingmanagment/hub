/** Scale the owner's view locally. Resizing X changes the persistent
 *  browser's environment and survives a Chrome restart (pilot F4). */
export function screenUrl(target: { kind: "page"; label: string } | { kind: "profile"; profileId: string }): string {
  const base = target.kind === "page"
    ? `/api/v1/page-browser/pages/${encodeURIComponent(target.label)}/screen`
    : `/api/v1/page-browser/profiles/${target.profileId}/screen`;
  const socketPath = `${base.slice(1)}/websockify`;
  return `${base}/index.html?autoconnect=1&resize=scale&path=${encodeURIComponent(socketPath)}`;
}
