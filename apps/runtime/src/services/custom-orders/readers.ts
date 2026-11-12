import type { TeamCustomsResponse } from "@agency_hub_core/contracts";
import { listCustomOrdersAwaitingGiving, type CustomOrderRow } from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfigField } from "../effective-config.ts";
import { cardOf, priceMillsOf, whatOf } from "./rules.ts";

/**
 * «Кастомы оплачены, не отданы» once the owner points it at the custom orders
 * (`customOrdersReadEnabled`, off by default): «Ждут вас» and «Решения» (through
 * `teamCustoms`, and the customs row of «Ждут вас» read from matters), the morning
 * report's line; the matters mirror then opens nothing of its old kind. Off, each
 * keeps reading the old table as before. The number counts the orders paid (a
 * sale, or the state) or shot and not given.
 */

type ReaderApp = Pick<AppContext, "db"> & Partial<Pick<AppContext, "config">>;

/** The owner's setting; a caller without the config (a report built in a test) reads the old table. */
export async function customOrdersReadOn(app: ReaderApp): Promise<boolean> {
  if (app.config === undefined) return false;
  return (await loadEffectiveConfigField(app.db, app.config, "customOrdersReadEnabled")) === true;
}

export function awaitingGivingOf(app: ReaderApp, input: { pageIds: "all" | readonly number[]; limit: number }): Promise<CustomOrderRow[]> {
  return listCustomOrdersAwaitingGiving(app.db, input);
}

/** When an order waits from: its first payment, or the moment it became paid or shot. */
export function waitsSince(order: CustomOrderRow): Date {
  return order.firstPaidAt ?? order.stateAt;
}

/**
 * `teamCustoms` from the orders, in its old shape: every row `paid` (what the screens count). An order whose fan
 * is not confirmed has no `fanRef` the shape can carry and is left out here; the board shows it.
 */
export function teamCustomsOfOrders(orders: readonly CustomOrderRow[], now: Date): TeamCustomsResponse {
  return {
    customs: orders
      .filter((order) => order.pageLabel !== null && order.fanRef !== null && /^[1-9]\d{0,29}$/.test(order.fanRef))
      .map((order) => {
        const card = cardOf(order.card);
        return {
          id: order.id,
          pageLabel: order.pageLabel!,
          fanRef: order.fanRef!,
          description: whatOf(card),
          priceMills: priceMillsOf(card.price),
          state: "paid",
          paidAt: waitsSince(order).toISOString(),
          createdBy: order.acceptedBy ?? (order.origin === "import" ? "перенесён" : "Генгар"),
          createdAt: order.createdAt.toISOString(),
        };
      }),
    serverNow: now.toISOString(),
  };
}
