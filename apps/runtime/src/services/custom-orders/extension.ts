import type { ClientFanCardResponse, ClientHandoffResponse } from "@agency_hub_core/contracts";
import {
  listCustomOrdersOfFans,
  listPageCustomOrdersInWork,
  type CustomOrderRow,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { canAccessPage, type HumanAuthPrincipal } from "../auth.ts";
import {
  customLeaderContext,
  customViewerOf,
  leaderWire,
  deliveryCandidatesOf,
  paymentCandidatesOf,
} from "./index.ts";
import { cardOf, extensionStateOf, extensionStepOf, mayTakeStep, overdueDaysOf, priceMillsOf, STEP_FROM, type CustomViewer } from "./rules.ts";
import type { CustomLeaderContext } from "./index.ts";

/**
 * The released extension's block «Кастомы» (Chat Memory week 4, the tab
 * «Память») read from the custom orders, in its old shapes: the fan card's
 * `customs` and `customPayments` and the handoff's customs. The extension
 * records and gives an order through the board's own routes with its narrow
 * token (customOrderCreate, customOrderAct). The extension knows four states:
 * an order maps to the nearest (rules.ts `extensionStateOf`); its description
 * is the card's task, its price the card's «Оплата» when that is one sum. The
 * extension's hints stay what they were: the fan's tips no order took, the
 * page's media after the payment.
 */

type ExtApp = Pick<AppContext, "db">;

/** Ended orders stay on the fan's card this long. */
const RECENT_DAYS = 30;
const SUGGESTIONS = 5;

/** The extension's own kinds of a payment: tips (as it always offered). */
const EXTENSION_PAYMENT_KINDS = ["tip"] as const;

const iso = (at: Date | null) => (at === null ? null : at.toISOString());

/** What the fan panel says of the order as Workboard does (package R5): its state, deadline, who has it, «Отдан». */
function workboardFieldsOf(order: CustomOrderRow, viewer: CustomViewer, leaders: CustomLeaderContext, now: Date) {
  return {
    orderState: order.state,
    deadlineOn: order.deadlineOn,
    overdueDays: overdueDaysOf(order, now),
    leader: leaderWire(leaders, order),
    mayGive: STEP_FROM.given.includes(order.state) && mayTakeStep(viewer, order, "given"),
  };
}

function extensionCustomOf(
  principal: HumanAuthPrincipal,
  order: CustomOrderRow,
  candidates: ClientFanCardResponse["customs"][number]["deliveryCandidates"],
  workboard: ReturnType<typeof workboardFieldsOf>,
): ClientFanCardResponse["customs"][number] {
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
    ...workboard,
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
  const [viewer, leaders] = orders.length === 0 ? [null, null] : await Promise.all([customViewerOf(app, principal), customLeaderContext(app, principal)]);
  for (const order of orders) {
    const open = extensionStateOf(order) === "ordered" || extensionStateOf(order) === "paid";
    const candidates = open ? await deliveryCandidatesOf(app.db, order, SUGGESTIONS) : [];
    customs.push(extensionCustomOf(principal, order, candidates.map((message) => ({
      messageRef: message.messageRef, at: message.at.toISOString(), mediaCount: message.mediaCount, priceMills: message.priceMills,
    })), workboardFieldsOf(order, viewer!, leaders!, input.now)));
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
