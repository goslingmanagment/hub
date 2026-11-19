import type { ChatterSaleKind } from "@agency_hub_core/contracts";

const KIND_OF: Readonly<Record<string, ChatterSaleKind>> = {
  message_purchase: "ppv",
  tip: "tip",
  stream_tip: "tip",
  subscription: "subscription",
  post_purchase: "post",
};

/** A sale's kind as the screens name it, from the transaction's canonical type. Pure. */
export function saleKindOf(canonicalType: string): ChatterSaleKind {
  return KIND_OF[canonicalType] ?? "tip";
}
