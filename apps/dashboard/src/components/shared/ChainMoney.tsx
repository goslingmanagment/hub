import type { ReactNode } from "react";
import { SaleChainTrigger } from "@agency_hub_core/ui/components/SaleChain";
import { kernel } from "@/api/sdk.js";

/**
 * Цепочка продажи (package T) in the console: a sale's amount in «Операции» and in a fan's operations opens its
 * chain of money in place — the same component as Workboard's lines (packages/ui `SaleChainTrigger`). The console's
 * rows name a sale by its page and the platform's transaction id.
 */
export function ChainMoney({ pageLabel, transactionRef, children }: { pageLabel: string; transactionRef: string; children: ReactNode }) {
  return (
    <SaleChainTrigger load={() => kernel.saleChain({ query: { pageLabel, transactionRef } })} align="end">
      {children}
    </SaleChainTrigger>
  );
}
