import type { ReactNode } from "react";
import { Link } from "react-router";
import { consoleHref } from "@/shared/links";

/** A matter's link: Workboard's own (`/workboard/…`) inside the app, the console's by a page load. */
export function goLink(link: string, children: ReactNode): ReactNode {
  if (link.startsWith("/workboard/") || link === "/workboard") {
    const inside = link.slice("/workboard".length) || "/";
    return <Link to={inside} className="wt-go">{children}</Link>;
  }
  return <a href={consoleHref(link)} className="wt-go">{children}</a>;
}
