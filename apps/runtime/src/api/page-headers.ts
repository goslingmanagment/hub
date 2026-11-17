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
 * Workboard's screens in the extension's frame (products plan 2026-11-13: package R, the «Отчёт» board; package R5, the
 * customs record form and the question window; R-protocol.md): exactly the paths of `BOARD_FRAME_PATHS` may be framed —
 * by the two sites the extension works on — and carry no `x-frame-options`; a further frame screen joins the list by
 * name, never by a prefix. Only on the team's name (`WEB_TEAM_ORIGIN`, Workboard's one address) and on the API's root
 * name (`BOARD_FRAME_API_ORIGIN`): the same path on hub. keeps `pageHeaders`. No credential enters such a frame: its
 * page reads no cookie and starts no sign-in, every request goes to the extension over a port. Every other answer
 * keeps `pageHeaders`.
 */
export const BOARD_FRAME_PATHS = ["/workboard/frame/report", "/workboard/frame/custom", "/workboard/frame/ask"] as const;
export const BOARD_FRAME_ANCESTORS = ["https://fansly.com", "https://chat.onlymonster.ai"] as const;

/** Whether a request's path (its query and fragment aside) is one of the frame's. */
export function isBoardFramePath(url: string): boolean {
  const path = url.split(/[?#]/)[0] ?? "";
  return (BOARD_FRAME_PATHS as readonly string[]).includes(path);
}

/**
 * The API's root name, which every installed extension may reach (its host permission, `https://gosling-agency.ru/*`).
 * The extension frames Workboard's screens from here since 2026-11-17: Firefox hands a request to a name the extension
 * may reach to its proxy router, which sends a model's container through the page's proxy; a request to the team's name
 * was left to whatever another add-on set for the container (a dead proxy there left the frame «Unable to connect»).
 * nginx on this name passes only `/workboard/frame/` and `/workboard/assets/` to Hub (agency-site deploy/server-nginx.sh).
 */
export const BOARD_FRAME_API_ORIGIN = "https://gosling-agency.ru";

/**
 * Whether a request is a frame screen's on a name that may serve it: its path is one of the frame's and, in production,
 * the request came to the team's host (`teamOrigin`'s) or the API's root host (`apiOrigin`'s, `BOARD_FRAME_API_ORIGIN`
 * by default), never the console's; outside production any name (the stand, `localhost`).
 */
export function isBoardFrameRequest(input: { url: string; hostname: string; isProduction: boolean; teamOrigin: string; apiOrigin?: string }): boolean {
  if (!isBoardFramePath(input.url)) return false;
  if (!input.isProduction) return true;
  const host = input.hostname.toLowerCase();
  return [input.teamOrigin, input.apiOrigin ?? BOARD_FRAME_API_ORIGIN].some((origin) => {
    try {
      return new URL(origin).hostname.toLowerCase() === host;
    } catch {
      return false;
    }
  });
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
