import { matchPath, Outlet, useLocation } from "react-router";
import { pageCardLegacyRule, statsLegacyRule, type LegacyRule } from "@/lib/redirects";
import { Legacy } from "./legacy.js";

/**
 * Addresses that are alive and old at once: `/stats?tab=content` is a tab now.
 * Sits above the frames, so an old address leaves before any of them reads it.
 */
export function LiveLegacy() {
  const { pathname, search } = useLocation();
  const query = new URLSearchParams(search);
  const rule = matchPath({ path: "/stats", end: true }, pathname) ? statsLegacyRule(query) : null;
  return rule ? <Legacy rule={rule} /> : <Outlet />;
}

/** `/pages/:pageLabel`, the page's card that left: Главная on the page, or Операции for its old block of operations. */
export function PageCardLegacy({ rule }: { rule: LegacyRule }) {
  const { search } = useLocation();
  return <Legacy rule={pageCardLegacyRule(new URLSearchParams(search)) ?? rule} />;
}
