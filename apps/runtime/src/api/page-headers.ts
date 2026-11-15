/**
 * Headers on every answer of Hub's own names (the console on hub., Workboard on chatgoose.,
 * the API on every name), set first so a route may make them stricter (the sign-in hand-off:
 * `DENY`, `frame-ancestors 'none'`).
 *
 * - Never framed by another site: a click inside a frame goes with Hub's own origin and passes
 *   the Origin check (origin-check.ts). Hub frames only its own pages (`'self'`); nothing else
 *   embeds a page of Hub (the extension, ContentOps, TaskIndex and the site were checked on
 *   2026-11-12).
 * - HTTPS only for a year in production (HSTS), never `includeSubDomains`: other machines' names
 *   live under the same domain. nginx in front of hub. and chatgoose. sets none of these
 *   (agency-site/deploy/server-nginx.sh), so the app does.
 */
export const HSTS_HEADER = "max-age=31536000";

export function pageHeaders(isProduction: boolean): Record<string, string> {
  return {
    "x-frame-options": "SAMEORIGIN",
    "content-security-policy": "frame-ancestors 'self'",
    ...(isProduction ? { "strict-transport-security": HSTS_HEADER } : {}),
  };
}

/**
 * The «Отчёт» board in the extension's frame (products plan 2026-11-13, package R; R-protocol.md): exactly the paths of
 * `BOARD_FRAME_PATHS` may be framed — by the two sites the extension works on — and carry no `x-frame-options`. A further
 * frame screen joins the list by name, never by a prefix. No credential enters that frame: its page reads no cookie and
 * starts no sign-in, every request goes to the extension over a port. Every other answer keeps `pageHeaders`.
 */
export const BOARD_FRAME_PATHS = ["/workboard/frame/report"] as const;
export const BOARD_FRAME_ANCESTORS = ["https://fansly.com", "https://chat.onlymonster.ai"] as const;

/** Whether a request's path (its query and fragment aside) is one of the frame's. */
export function isBoardFramePath(url: string): boolean {
  const path = url.split(/[?#]/)[0] ?? "";
  return (BOARD_FRAME_PATHS as readonly string[]).includes(path);
}

/**
 * The frame path's headers. `devOrigins` — the local stand's origins, only in a non-production build (one env list,
 * `HUB_BOARD_FRAME_DEV_ORIGINS`); production ignores them.
 */
export function boardFrameHeaders(isProduction: boolean, devOrigins: readonly string[] = []): Record<string, string> {
  const extra = isProduction ? [] : devOrigins.filter((origin) => /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(origin));
  return {
    "content-security-policy": `frame-ancestors ${[...BOARD_FRAME_ANCESTORS, ...extra].join(" ")}`,
    ...(isProduction ? { "strict-transport-security": HSTS_HEADER } : {}),
  };
}

/** The stand's origins from the env list (comma or space separated). */
export function boardFrameDevOrigins(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,]+/).map((one) => one.trim()).filter((one) => one !== "");
}

/**
 * «Публикации» and «Статистика» inside ContentOps (products plan §2.4, package C2): exactly these two paths of Hub —
 * bare pages, one screen each, no console frame — may be framed, by ContentOps' public name alone, and carry no
 * `x-frame-options`. The person acts in them with their own Hub session: the two names are one site, so the cookie
 * goes with the frame's requests. Every other answer keeps `pageHeaders`; ContentOps keeps its own ban on being framed.
 */
export const CONTENT_SCREEN_PATHS = { publications: "/frame/publications", stats: "/frame/content-stats" } as const;

/** Whether a request's path (its query and fragment aside) is one of the two content screens'. */
export function isContentScreenPath(url: string): boolean {
  const path = url.split(/[?#]/)[0] ?? "";
  return (Object.values(CONTENT_SCREEN_PATHS) as string[]).includes(path);
}

/**
 * The two paths' headers. `contentopsOrigin`: ContentOps' public name, from the one setting that names it to Hub (the
 * sign-in client `contentops` of `WEB_SIGNIN_CLIENTS`, its callback's origin), so a stand names its own; null (no such
 * client) frames them by nobody.
 */
export function contentScreenHeaders(isProduction: boolean, contentopsOrigin: string | null): Record<string, string> {
  return {
    "content-security-policy": `frame-ancestors ${contentopsOrigin ?? "'none'"}`,
    ...(isProduction ? { "strict-transport-security": HSTS_HEADER } : {}),
  };
}

/** ContentOps' origin from its sign-in callback (`https://contentops.…/auth/hub/callback`); null when none is named. */
export function contentopsOriginOf(callback: string | undefined): string | null {
  if (callback === undefined) return null;
  try {
    const url = new URL(callback);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}
