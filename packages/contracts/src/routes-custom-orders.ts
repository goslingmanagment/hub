import {
  agentCustomCardsBodySchema,
  agentCustomCardsResponseSchema,
  agentCustomOrderCreateBodySchema,
  agentCustomOrderResponseSchema,
  agentCustomOrdersQuerySchema,
  agentCustomOrdersResponseSchema,
  agentCustomOrderUpdateBodySchema,
  customOrderActionBodySchema,
  customOrderCreateBodySchema,
  customOrderDetailResponseSchema,
  customOrderParamsSchema,
  customOrdersBoardQuerySchema,
  customOrdersBoardResponseSchema,
  customSaleDismissResponseSchema,
  customSaleParamsSchema,
} from "./custom-orders.ts";
import { errorResponseSchema } from "./primitives.ts";

// Заказ кастома (custom-orders.ts): the board «Кастомы» of Workboard by any
// session (the lead and the owner every order, a team lead and a chatter the
// orders of their pages), and the agent key's door (write:customs). The
// extension keeps its own routes (clientFanCustomCreate, clientFanCustomChange,
// clientFanCard's `customs`), served from the same orders. Database only.

const sessionErrors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema,
  // not_allowed (the step is not the viewer's, or not from this state) | not_suggested | taken
  409: errorResponseSchema,
} as const;
const agentErrors = {
  400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema,
  409: errorResponseSchema, 429: errorResponseSchema, 503: errorResponseSchema,
} as const;

export const customOrderRouteSchemas = {
  customOrdersBoard: {
    auth: { kind: "any-session" }, tags: ["admin"],
    summary: "The board «Кастомы»: open custom orders by step, the given of the last week, and sales that look like a custom with no order",
    description: "Database only. The lead (the right «ведёт кастомы») and the owner see every order; a team lead and a chatter the orders "
      + "of the pages they reach. An order of no known page is the lead's, the owner's and the team leads'.",
    querystring: customOrdersBoardQuerySchema,
    response: { 200: customOrdersBoardResponseSchema, ...sessionErrors },
  },
  customOrder: {
    auth: { kind: "any-session" }, tags: ["admin"],
    summary: "One custom order: its card, payments with «Это оплата?», delivery hints, history and what the viewer may do",
    params: customOrderParamsSchema,
    response: { 200: customOrderDetailResponseSchema, ...sessionErrors },
  },
  customOrderAct: {
    auth: { kind: "any-session" }, tags: ["admin"],
    summary: "A step of a custom order: edit the card, deadline, fan, Telegram card, payment, at the model, partly, shot, revision, "
      + "refused, given, close, cancel",
    description: "Database only. The lead and the owner take every step; a chatter only theirs (a payment, «отдали», editing and "
      + "cancelling their own order); a step not from the order's state is 409 `not_allowed`. Answers the order after it.",
    params: customOrderParamsSchema,
    body: customOrderActionBodySchema,
    response: { 200: customOrderDetailResponseSchema, ...sessionErrors },
  },
  customOrderCreate: {
    auth: { kind: "any-session" }, tags: ["admin"],
    summary: "«Записать кастом» on the board: from a sale that looks like a custom, or on a page for a fan",
    body: customOrderCreateBodySchema,
    response: { 200: customOrderDetailResponseSchema, ...sessionErrors },
  },
  customSaleDismiss: {
    auth: { kind: "any-session" }, tags: ["admin"],
    summary: "«Не кастом»: a sale the custom check pointed at is not a custom; its matter closes",
    params: customSaleParamsSchema,
    response: { 200: customSaleDismissResponseSchema, ...sessionErrors },
  },
  agentCustomOrders: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Custom orders of the key's pages and of no known page, with the card text (needs write:customs); no money",
    querystring: agentCustomOrdersQuerySchema,
    response: { 200: agentCustomOrdersResponseSchema, ...agentErrors },
  },
  agentCustomOrderCreate: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Create a recorded custom order from the card's fields and the fan's link (needs write:customs)",
    description: "Database only. A fan that does not match a fan of the page stays the buyer's string; a page outside the key's grant "
      + "is 404. The same Telegram card again answers its order (`unchanged`).",
    body: agentCustomOrderCreateBodySchema,
    response: { 200: agentCustomOrderResponseSchema, ...agentErrors },
  },
  agentCustomOrderUpdate: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Update a custom order: the card's fields, at the model, partly shot, shot, a revision, the model's refusal, a Telegram card"
      + " (needs write:customs)",
    params: customOrderParamsSchema,
    body: agentCustomOrderUpdateBodySchema,
    response: { 200: agentCustomOrderResponseSchema, ...agentErrors },
  },
  agentCustomCards: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Report the Telegram cards no order has: each becomes the lead's matter until a card is attached (needs write:customs)",
    body: agentCustomCardsBodySchema,
    response: { 200: agentCustomCardsResponseSchema, ...agentErrors },
  },
} as const;
