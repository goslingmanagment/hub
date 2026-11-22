import {
  agentCustomCardsBodySchema,
  agentCustomCardsResponseSchema,
  agentCustomFindingsBodySchema,
  agentCustomFindingsResponseSchema,
  agentCustomOrderCreateBodySchema,
  agentCustomOrderResponseSchema,
  agentCustomOrdersQuerySchema,
  agentCustomOrdersResponseSchema,
  agentCustomOrderUpdateBodySchema,
  customFindingActionBodySchema,
  customFindingActionResponseSchema,
  customFindingParamsSchema,
  customFindingsListResponseSchema,
  customOrderActionBodySchema,
  customOrderChangesResponseSchema,
  customOrderCreateBodySchema,
  customOrderDetailResponseSchema,
  customOrderParamsSchema,
  customOrdersBoardQuerySchema,
  customOrdersBoardResponseSchema,
  customOrdersDoneQuerySchema,
  customOrdersDoneResponseSchema,
  customSaleDismissResponseSchema,
  customSaleParamsSchema,
} from "./custom-orders.ts";
import { errorResponseSchema } from "./primitives.ts";

// Заказ кастома (custom-orders.ts): the board «Кастомы» of Workboard by any
// session (the lead and the owner every order, a team lead and a chatter the
// orders of their pages), and the agent key's door (write:customs). The
// extension records and gives an order through these routes with its narrow
// token and reads the orders in clientFanCard's `customs`. Database only.

/** The board's reads the extension's frame calls with the device token (the launcher's «Кастомы»). */
const FRAME_TOKEN = " The extension's device token too: Workboard's «Кастомы» in its frame over the site, read as a chatter.";

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
    auth: { kind: "any" }, tags: ["admin"],
    summary: "The board «Кастомы»: open custom orders by step, the given of the last week, and sales that look like a custom with no order",
    description: "Database only. The lead (the right «ведёт кастомы») and the owner see every order; a team lead and a chatter the orders "
      + "of the pages they reach. An order of no known page is the lead's, the owner's and the team leads'." + FRAME_TOKEN,
    querystring: customOrdersBoardQuerySchema,
    response: { 200: customOrdersBoardResponseSchema, ...sessionErrors },
  },
  customOrdersDone: {
    auth: { kind: "any" }, tags: ["admin"],
    summary: "The board «Кастомы»: the orders given and waiting for the fan's word, and the closed of the last days",
    description: "Database only. The board's visibility: the lead and the owner every order of their realm, a team lead and a "
      + "chatter the orders of the pages they reach. Without the card document." + FRAME_TOKEN,
    querystring: customOrdersDoneQuerySchema,
    response: { 200: customOrdersDoneResponseSchema, ...sessionErrors },
  },
  customFindingsList: {
    auth: { kind: "any" }, tags: ["admin"],
    summary: "«Найдено без заказа»: the open findings of a custom with no order the viewer resolves",
    description: "Database only. The check's leader of the finding's page, the customs lead and the owner, of their realm; anyone "
      + "else reads an empty list." + FRAME_TOKEN,
    response: { 200: customFindingsListResponseSchema, ...sessionErrors },
  },
  customOrderChanges: {
    auth: { kind: "any" }, tags: ["admin"],
    summary: "«За сутки изменилось само»: the last 24 hours' steps of the system and the agents on the viewer's orders, each "
      + "with its undo when the viewer may take it back",
    description: "Database only. The orders the board shows the viewer; an undo is the board's step (`unpay`, `ungive`, "
      + "`retract`, the deadline back) sent with `undoOf`." + FRAME_TOKEN,
    response: { 200: customOrderChangesResponseSchema, ...sessionErrors },
  },
  customOrder: {
    auth: { kind: "any" }, tags: ["admin"],
    summary: "One custom order: its card, payments with «Это оплата?», delivery hints, history and what the viewer may do",
    description: "Database only. The board's visibility; an order the viewer does not see reads as missing." + FRAME_TOKEN,
    params: customOrderParamsSchema,
    response: { 200: customOrderDetailResponseSchema, ...sessionErrors },
  },
  customOrderAct: {
    auth: { kind: "any" }, tags: ["admin"],
    summary: "A step of a custom order: edit the card, deadline, fan, Telegram card, payment, at the model, partly, shot, revision, "
      + "refused, given and its undo, a delivery taken back, close, cancel, a hold, the issue settled, the owner's word on the payment",
    description: "Database only. The lead and the owner take every step; a chatter only theirs (a payment, «отдали» and its undo, "
      + "editing and cancelling their own order); the owner alone his word on the payment and settling an issue; a hold the owner "
      + "and the check's leader; a step not from the order's state is 409 `not_allowed`. Taking off a sale or a message the system "
      + "or an agent applied is remembered: they never apply it to the order again. Answers the order after it. "
      + "A session or the extension's device token (the fan panel's «Отдан», package R5, and the steps of Workboard's «Кастомы» "
      + "in its frame): it reads as a chatter, so it takes a narrow session's steps and no other.",
    params: customOrderParamsSchema,
    body: customOrderActionBodySchema,
    response: { 200: customOrderDetailResponseSchema, ...sessionErrors },
  },
  customFindingAct: {
    auth: { kind: "any-session" }, tags: ["admin"],
    summary: "Resolve a custom with no order: record it as an order, link it to one, or dismiss it with a reason",
    description: "Database only. The check's leader of the finding's page, the customs lead and the owner; any other reads it as not "
      + "found. A sale's finding brings its sale to the order as its payment. A resolved finding is 409 `resolved`.",
    params: customFindingParamsSchema,
    body: customFindingActionBodySchema,
    response: { 200: customFindingActionResponseSchema, ...sessionErrors },
  },
  customOrderCreate: {
    auth: { kind: "any" }, tags: ["admin"],
    summary: "«Записать кастом» on the board: from a sale that looks like a custom, or on a page for a fan",
    description: "A session, or the extension's device token: the board's own form in the extension's frame (package R5).",
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
    summary: "Custom orders of the key's pages and of no known page, with the card text (needs write:customs); no money, the facts"
      + " with read:money",
    description: "`state=live`: the open orders and the given ones not closed yet.",
    querystring: agentCustomOrdersQuerySchema,
    response: { 200: agentCustomOrdersResponseSchema, ...agentErrors },
  },
  agentCustomOrderCreate: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Create a recorded custom order from the card's fields, its price and the fan's link (needs write:customs; its sales"
      + " with read:money)",
    description: "Database only. A fan that does not match a fan of the page stays the buyer's string; a page outside the key's grant "
      + "is 404. The same Telegram card again answers its order (`unchanged`); an order found by its card or its code takes the "
      + "price and the sales. Each named sale is answered in `sales`: linked or why not; none fails the create.",
    body: agentCustomOrderCreateBodySchema,
    response: { 200: agentCustomOrderResponseSchema, ...agentErrors },
  },
  agentCustomOrderUpdate: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Update a custom order: the card's fields, at the model, partly shot, shot, a revision, the model's refusal, a Telegram card,"
      + " the deadline, an issue (needs write:customs); a payment (also read:money); «отдан» by a message, the fan, the fan's «where is"
      + " it» (also read:messages)",
    description: "Database only. What a step names — a sale, a message, a fan — is one Hub holds on the key's pages, checked by Hub "
      + "(a page outside them is 404); a refusal is 409 with its reason.",
    params: customOrderParamsSchema,
    body: agentCustomOrderUpdateBodySchema,
    response: { 200: agentCustomOrderResponseSchema, ...agentErrors },
  },
  agentCustomFindings: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Report the traces of a custom with no order, or a candidate that is no custom (needs write:customs, read:money and"
      + " read:messages)",
    description: "Database only. Each once by `(source, ref)`, on the key's pages; the check's leader of the page resolves an open one.",
    body: agentCustomFindingsBodySchema,
    response: { 200: agentCustomFindingsResponseSchema, ...agentErrors },
  },
  agentCustomCards: {
    auth: { kind: "agentKey" }, tags: ["agent"],
    summary: "Report the Telegram cards no order has: each becomes the lead's matter until a card is attached (needs write:customs)",
    body: agentCustomCardsBodySchema,
    response: { 200: agentCustomCardsResponseSchema, ...agentErrors },
  },
} as const;
