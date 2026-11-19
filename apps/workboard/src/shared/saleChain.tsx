import type { ReactNode } from "react";
import { Link } from "react-router";
import { SaleChainTrigger, type ChainLinkRenderer } from "@agency_hub_core/ui";
import { kernel } from "@/shared/hub";
import { consoleHref } from "@/shared/links";

/**
 * Цепочка продажи (package T) in Workboard: the sale's amount on a line opens its chain of money in place
 * (packages/ui `SaleChainTrigger`, the one component of every place a sale stands). Workboard's own links open in the
 * app, the console's by a page load.
 */
const workboardLink: ChainLinkRenderer = (href, children) => (href.startsWith("/workboard/") || href === "/workboard"
  ? <Link to={href.slice("/workboard".length) || "/"} className="ui-chain__go">{children}</Link>
  : <a href={consoleHref(href)} className="ui-chain__go">{children}</a>);

export function ChainMoney({ saleId, children, align = "end" }: { saleId: number; children: ReactNode; align?: "start" | "end" }) {
  return (
    <SaleChainTrigger load={() => kernel.saleChain({ query: { saleId } })} renderLink={workboardLink} align={align}>
      {children}
    </SaleChainTrigger>
  );
}
