import type { ClientFanCardResponse, ClientFanCustomChangeBody, ClientHandoffResponse, CustomOrderCard } from "@agency_hub_core/contracts";
import {
  findCustomOrder,
  listCustomOrdersOfFans,
  listPageCustomOrdersInWork,
  type CustomOrderRow,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { canAccessPage, type HumanAuthPrincipal } from "../auth.ts";
import { ConflictError } from "../errors.ts";
import {
  applyCustomStep,
  customViewerOf,
  deliveryCandidatesOf,
  paymentCandidatesOf,
  recordCustomOrder,
  type CustomStep,
} from "./index.ts";
import { cardOf, extensionStateOf, extensionStepOf, mayTakeStep, priceMillsOf, priceTextOf } from "./rules.ts";

/**
 * The released extension's block «Кастомы» (Chat Memory week 4: the tab
 * «Память», «Записать кастом», «Это оплата?», «Отдали: это он?», «Отменить»)
 * served from the custom orders, on its old routes and in its old shapes. The
 * extension knows four states: an order maps to the nearest
 * (rules.ts `extensionStateOf`); its description is the card's task, its price
 * the card's «Оплата» when that is one sum. The extension's hints stay what
 * they were: the fan's tips no order took, the page's media after the payment.
 */

type ExtApp = Pick<AppContext, "db">;

/** Ended orders stay on the fan's card this long. */
const RECENT_DAYS = 30;
const SUGGESTIONS = 5;

/** The extension's own kinds of a payment: tips (as it always offered). */
const EXTENSION_PAYMENT_KINDS = ["tip"] as const;

const iso = (at: Date | null) => (at === null ? null : at.toISOString());

function extensionCustomOf(principal: HumanAuthPrincipal, order: CustomOrderRow, candidates: ClientFanCardResponse["customs"][number]["deliveryCandidates"]): ClientFanCardResponse["customs"][number] {
  const card = cardOf(order.card);
  const state = extensionStateOf(order);
  return {
    id: order.id,
    pageLabel: order.pageLabel ?? "",
    granted: order.pageId !== null && canAccessPage(principal, order.pageId),
    description: card.task ?? card.photos ?? card.duration ?? "—",
    priceMills: priceMillsOf(card.price),
    state,
    paymentMills: order.payments > 0 ? order.paidGrossMills : null,
    // Paid on the board with no sale linked: since that step. Past it (at the model, shot) the payment's day is unknown.
    paidAt: iso(order.firstPaidAt ?? (order.state === "paid" ? order.stateAt : null)),
    deliveredMessageRef: order.givenMessageRef,
    deliveredAt: iso(order.givenAt),
    createdBy: order.acceptedBy ?? (order.origin === "import" ? "перенесён" : "Генгар"),
    createdAt: order.createdAt.toISOString(),
    deliveryCandidates: candidates,
    ...extensionStepOf(order),
  };
}

/** The card's `customs` and `customPayments`: the person's orders of the pages the caller works, and the asked page's tips. */
export async function extensionCardCustoms(
  app: ExtApp,
  principal: HumanAuthPrincipal,
  input: { personIds: readonly number[]; askedPageId: number | null; now: Date },
): Promise<Pick<ClientFanCardResponse, "customs" | "customPayments">> {
  const orders = (await listCustomOrdersOfFans(app.db, { fanIds: input.personIds, now: input.now, recentDays: RECENT_DAYS }))
    .filter((order) => order.pageId !== null && canAccessPage(principal, order.pageId));
  const customs: ClientFanCardResponse["customs"] = [];
  for (const order of orders) {
    const open = extensionStateOf(order) === "ordered" || extensionStateOf(order) === "paid";
    const candidates = open ? await deliveryCandidatesOf(app.db, order, SUGGESTIONS) : [];
    customs.push(extensionCustomOf(principal, order, candidates.map((message) => ({
      messageRef: message.messageRef, at: message.at.toISOString(), mediaCount: message.mediaCount, priceMills: message.priceMills,
    }))));
  }
  const payments = input.askedPageId === null || input.personIds.length === 0 ? [] : await paymentCandidatesOf(
    app.db, { pageId: input.askedPageId, fanId: input.personIds[0]! }, EXTENSION_PAYMENT_KINDS, input.now, SUGGESTIONS,
  );
  return {
    customs,
    customPayments: payments.map((payment) => ({
      paymentRef: String(payment.transactionId), amountMills: payment.grossMills, at: payment.at.toISOString(), note: payment.note,
    })),
  };
}

/** «Записать кастом»: a recorded order (paid by a suggested tip, or waiting for its payment) accepted by the chatter. */
export async function extensionRecordCustom(
  app: ExtApp,
  principal: HumanAuthPrincipal,
  input: { pageId: number; fanId: number; personIds: readonly number[]; conversationRef: string | null; description: string; priceMills: number | null; paymentRef: string | undefined },
): Promise<void> {
  const now = new Date();
  let payment: number | null = null;
  if (input.paymentRef !== undefined) {
    const offered = await paymentCandidatesOf(app.db, { pageId: input.pageId, fanId: input.fanId }, EXTENSION_PAYMENT_KINDS, now, 50);
    const found = offered.find((one) => String(one.transactionId) === input.paymentRef);
    if (found === undefined) throw new ConflictError("The payment is not suggested for this fan", { reason: "not_suggested" });
    payment = found.transactionId;
  }
  await recordCustomOrder(app, {
    pageId: input.pageId, fanId: input.fanId, buyer: null, conversationRef: input.conversationRef,
    card: { task: input.description, ...(input.priceMills === null ? {} : { price: priceTextOf(input.priceMills) }) },
    deadlineOn: null, acceptedByUserId: principal.user.id, origin: "extension", paymentTransactionId: payment,
    actor: { door: "extension", userId: principal.user.id }, now,
  });
}

/**
 * «Это оплата?», «Отдали: это он?», «Отменить», a correction — from the extension. A step that is not the
 * chatter's (cancelling another person's order) or not from the order's state answers `false`, as the old routes
 * answered a final custom: the extension shows the order as it is.
 */
export async function extensionChangeCustom(
  app: ExtApp,
  principal: HumanAuthPrincipal,
  input: { orderId: number; body: ClientFanCustomChangeBody },
): Promise<boolean> {
  const now = new Date();
  const order = (await findCustomOrder(app.db, input.orderId))!;
  const viewer = await customViewerOf(app, principal);
  const body = input.body;
  let step: CustomStep;
  if (body.action === "paid") {
    const offered = await paymentCandidatesOf(app.db, order, EXTENSION_PAYMENT_KINDS, now, 50);
    const found = offered.find((one) => String(one.transactionId) === body.paymentRef);
    if (found === undefined) throw new ConflictError("The payment is not suggested for this custom", { reason: "not_suggested" });
    step = { action: "payment", transactionId: found.transactionId };
  } else if (body.action === "delivered") {
    const offered = await deliveryCandidatesOf(app.db, order, 50);
    const found = offered.find((one) => one.messageRef === body.messageRef);
    if (found === undefined) throw new ConflictError("The message is not suggested for this custom", { reason: "not_suggested" });
    step = { action: "given", messageRef: found.messageRef, at: found.at };
  } else if (body.action === "cancel") {
    step = { action: "cancel" };
  } else {
    const card: CustomOrderCard = { ...cardOf(order.card), task: body.description };
    if (body.priceMills === null) delete card.price;
    else card.price = priceTextOf(body.priceMills);
    step = { action: "edit", card, by: "person" };
  }
  // The old routes knew one rule: an ended custom changes no more (`changed: false`). A step the chatter may not take is the same.
  if (!mayTakeStep(viewer, order, step.action)) return false;
  return applyCustomStep(app, { orderId: order.id, step, actor: { door: "extension", userId: principal.user.id }, viewer, now });
}

/** «Передача»: the page's orders in work with a known fan, the oldest payment first. */
export async function extensionHandoffCustoms(db: Database, input: { pageId: number; limit: number }): Promise<ClientHandoffResponse["customs"]> {
  const orders = await listPageCustomOrdersInWork(db, { pageId: input.pageId, limit: input.limit * 2 });
  return orders
    .filter((order) => order.fanRef !== null && /^[1-9]\d{0,29}$/.test(order.fanRef))
    .slice(0, input.limit)
    .map((order) => {
      const card = cardOf(order.card);
      return {
        fanRef: order.fanRef!,
        conversationRef: order.conversationRef !== null && /^[1-9]\d{0,29}$/.test(order.conversationRef) ? order.conversationRef : null,
        description: card.task ?? card.photos ?? card.duration ?? "—",
        state: extensionStateOf(order),
        paidAt: iso(order.firstPaidAt),
        createdAt: order.createdAt.toISOString(),
        ...extensionStepOf(order),
      };
    });
}
