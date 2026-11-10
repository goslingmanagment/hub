import type { ReactNode } from "react";
import { Link } from "react-router";
import { isWorkboardHref } from "@/lib/workboard";

/**
 * A link to a console screen or to Workboard (lib/workboard.ts): the console's
 * router cannot open Workboard, so there it is a plain `<a href>` in the same tab.
 */
export function AppLink({ to, className, children }: { to: string; className?: string | undefined; children: ReactNode }) {
  if (isWorkboardHref(to)) return <a href={to} className={className}>{children}</a>;
  return <Link to={to} className={className}>{children}</Link>;
}
