import {
  listCustomOrdersAwaitingGiving, listOpenMattersOfKinds, listUsersWithPersonRight, type CustomOrderRow, type Database, type MatterOwner,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";

/**
 * «Кастомы оплачены, не отданы», read from the custom orders: the customs row of «Ждут вас» and the morning report's
 * line. The number counts the orders paid (a sale, or the state) or shot and not given.
 */

/**
 * Who leads customs, the one rule: the person with the right «ведёт кастомы» (`customs_lead`, their living login),
 * else the team lead's role. The custom checks give the lead's matters to it, and «Ждут вас»'s customs count is the
 * role's only while nobody has the right (a person who has it reads their own matters instead).
 */
export async function customsLeadOwner(app: Pick<AppContext, "db">): Promise<MatterOwner> {
  const leads = await listUsersWithPersonRight(app.db, "customs_lead");
  return leads[0] === undefined ? { role: "team_lead" } : { userId: leads[0].userId };
}

/** «Похоже на кастом без заказа»: the matter of a sale that looks like a custom and has no order, one per sale. */
export const CUSTOM_UNRECORDED_KIND = "custom.unrecorded";
export const unrecordedKey = (transactionId: number) => `${CUSTOM_UNRECORDED_KIND}:${transactionId}`;
export function unrecordedSaleOf(key: string): number | null {
  const id = Number(key.slice(CUSTOM_UNRECORDED_KIND.length + 1));
  return key.startsWith(`${CUSTOM_UNRECORDED_KIND}:`) && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The sales such a matter still waits about. A matter stays open until its sale has an order or is «не кастом»,
 * so the pass follows these sales, and the board lists them and takes «Записать» and «Не кастом» on them, whatever
 * their day (the windows only limit which new sales are found).
 */
export async function waitingCustomSaleIds(db: Database): Promise<number[]> {
  return (await listOpenMattersOfKinds(db, [CUSTOM_UNRECORDED_KIND]))
    .map((matter) => unrecordedSaleOf(matter.key)).filter((id): id is number => id !== null);
}

export function awaitingGivingOf(app: Pick<AppContext, "db">, input: { pageIds: "all" | readonly number[]; limit: number }): Promise<CustomOrderRow[]> {
  return listCustomOrdersAwaitingGiving(app.db, input);
}

/** When an order waits from: its first payment, or the moment it became paid or shot. */
export function waitsSince(order: CustomOrderRow): Date {
  return order.firstPaidAt ?? order.stateAt;
}
