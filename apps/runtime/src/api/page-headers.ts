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
 * The «Отчёт» board in the extension's frame (products plan 2026-11-13, package R; R-protocol.md): `/workboard/frame/*`
 * is the one path another site may frame — the two sites the extension works on — and it carries no `x-frame-options`.
 * No credential enters that frame: its page reads no cookie and starts no sign-in, every request goes to the extension
 * over a port. Every other answer keeps `pageHeaders`.
 */
export const BOARD_FRAME_PATH = "/workboard/frame/";
export const BOARD_FRAME_ANCESTORS = ["https://fansly.com", "https://chat.onlymonster.ai"] as const;

/** Whether a request's path is the board's frame. */
export function isBoardFramePath(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  return path === BOARD_FRAME_PATH.slice(0, -1) || path.startsWith(BOARD_FRAME_PATH);
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
