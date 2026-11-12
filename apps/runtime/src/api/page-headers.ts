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
