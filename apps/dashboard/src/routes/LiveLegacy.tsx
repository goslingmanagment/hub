import { matchPath, Outlet, useLocation } from "react-router";
import { pageCardLegacyRule, statsLegacyRule } from "@/lib/redirects";
import { Legacy } from "./legacy.js";

/**
 * Addresses that are alive and old at once: `/stats?tab=content` is a tab now, a
 * page's card kept the operations it no longer shows. Sits above the frames, so an old address leaves before any of
 * them reads it.
 */
export function LiveLegacy() {
  const { pathname, search } = useLocation();
  const query = new URLSearchParams(search);
  const rule = pathname === "/stats" ? statsLegacyRule(query)
      : matchPath({ path: "/pages/:pageLabel", end: true }, pathname) ? pageCardLegacyRule(query)
        : null;
  return rule ? <Legacy rule={rule} /> : <Outlet />;
}
