import {
  parseCustomOrderCode,
  parseTelegramRef,
  type AgentCustomCardsBody,
  type AgentCustomOrder,
  type AgentCustomOrderCreateBody,
  type AgentCustomOrdersQuery,
  type AgentCustomOrderUpdateBody,
} from "@agency_hub_core/contracts";
import {
  findCustomOrder,
  findCustomOrderIdByCard,
  findMatterPerson,
  findPageFanByInput,
  listAgentCustomOrders,
  listCustomOrderCardOwners,
  listCustomOrderMessagesOf,
  type CustomOrderRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import type { AgentAuthPrincipal } from "../auth.ts";
import { AppError, ConflictError } from "../errors.ts";
import { applyCustomStep, cardTextOf, messageWire, orderMessagesOf, orderWire, recordCustomOrder, type CustomActor, type CustomStep } from "./index.ts";
import { reportUnmatchedCards } from "./checks.ts";
import { fanInputOf, STEP_FROM } from "./rules.ts";

/**
 * Заказ кастома, the agent key's door (write:customs): Gengar's `/tz` creates
 * a recorded order from the card's fields and the fan's link and keeps
 * printing the card; «держи обновлённую» rewrites its fields; the reader of the
 * models' groups writes what the model did (partly, shot, a revision, a
 * refusal) with the model's message, attaches cards and reports the ones no
 * order has. Never a payment, never «отдали»: those are people's.
 */

type AgentApp = Pick<AppContext, "db">;

export interface AgentCustomScope {
  principal: AgentAuthPrincipal;
  /** The key's granted pages. */
  pages: ReadonlyArray<{ id: number; pageLabel: string; platform: string }>;
}

/** The plane's one 404: missing and out of grant are the same bytes. */
const notFound = () => new AppError("Not found", 404, "not_found");

async function personOf(app: AgentApp, username: string): Promise<number> {
  const person = await findMatterPerson(app.db, username);
  if (person === null) throw new ConflictError(`No living person "${username}"`, { reason: "person_unknown" });
  return person.userId;
}

function inGrant(scope: AgentCustomScope, order: CustomOrderRow): boolean {
  return order.pageId === null || scope.pages.some((page) => page.id === order.pageId);
}

async function agentOrderOf(app: AgentApp, order: CustomOrderRow, now: Date): Promise<AgentCustomOrder> {
  return agentWire(order, await orderMessagesOf(app.db, order.id), now);
}

function agentWire(order: CustomOrderRow, messages: AgentCustomOrder["messages"], now: Date): AgentCustomOrder {
  const { paidGrossMills: _gross, paidNetMills: _net, ...wire } = orderWire(order, now);
  return { ...wire, cardText: cardTextOf(order), sourceText: order.sourceText, messages };
}

export async function agentListCustomOrders(app: AgentApp, scope: AgentCustomScope, query: AgentCustomOrdersQuery, now: Date = new Date()) {
  const orderId = query.code === undefined ? null : parseCustomOrderCode(query.code);
  const telegramRef = query.telegramRef === undefined ? null : parseTelegramRef(query.telegramRef);
  const orders = await listAgentCustomOrders(app.db, {
    pageIds: scope.pages.map((page) => page.id), open: query.state === "open" && orderId === null && telegramRef === null, orderId, telegramRef, limit: query.limit,
  });
  const messages = await listCustomOrderMessagesOf(app.db, orders.map((order) => order.id));
  return { orders: orders.map((order) => agentWire(order, (messages.get(order.id) ?? []).map(messageWire), now)), serverNow: now.toISOString() };
}

/** `/tz`: a recorded order. The same Telegram card again answers its order, unchanged. */
export async function agentCreateCustomOrder(app: AgentApp, scope: AgentCustomScope, body: AgentCustomOrderCreateBody, now: Date = new Date()) {
  const telegramRef = body.telegramRef === undefined ? null : parseTelegramRef(body.telegramRef);
  if (telegramRef !== null) {
    const existing = await findCustomOrderIdByCard(app.db, telegramRef);
    if (existing !== null) {
      const order = (await findCustomOrder(app.db, existing))!;
      if (!inGrant(scope, order)) throw notFound();
      return { order: await agentOrderOf(app, order, now), outcome: "unchanged" as const };
    }
  }
  let pageId: number | null = null;
  let fanId: number | null = null;
  let conversationRef: string | null = null;
  if (body.pageLabel !== undefined) {
    const page = scope.pages.find((candidate) => candidate.pageLabel === body.pageLabel);
    if (!page) throw notFound();
    pageId = page.id;
    const parsed = body.fan === undefined ? null : fanInputOf(page.platform, body.fan);
    const fan = parsed === null ? null : await findPageFanByInput(app.db, { pageId: page.id, platform: page.platform, ...parsed });
    if (fan !== null) {
      fanId = fan.fanId;
      if (page.platform === "onlyfans") conversationRef = fan.platformUserId;
    }
  }
  const actor: CustomActor = {
    door: "api", agentKeyId: scope.principal.agentKeyId,
    onBehalfOfUserId: body.onBehalfOf === undefined ? null : await personOf(app, body.onBehalfOf),
  };
  const id = await recordCustomOrder(app, {
    pageId, fanId,
    // A fan that does not match stays the buyer's string, as the card names him: never a guess.
    buyer: fanId === null && body.fan !== undefined ? body.fan.slice(0, 300) : null,
    conversationRef, card: body.card, deadlineOn: body.deadlineOn ?? null,
    acceptedByUserId: body.acceptedBy === undefined ? null : await personOf(app, body.acceptedBy),
    origin: "agent", telegramRefs: telegramRef === null ? [] : [telegramRef], actor, now,
    sourceText: body.sourceText ?? null,
    cardPostedAt: body.postedAt === undefined ? null : new Date(body.postedAt),
    cardAuthor: body.author ?? null,
    // A card posted earlier counts from its time (the checks and the delivery hints read it).
    ...(body.postedAt !== undefined && Date.parse(body.postedAt) < now.getTime() ? { createdAt: new Date(body.postedAt) } : {}),
  });
  return { order: await agentOrderOf(app, (await findCustomOrder(app.db, id))!, now), outcome: "created" as const };
}

export async function agentUpdateCustomOrder(app: AgentApp, scope: AgentCustomScope, code: string, body: AgentCustomOrderUpdateBody, now: Date = new Date()) {
  const id = parseCustomOrderCode(code);
  const order = id === null ? null : await findCustomOrder(app.db, id);
  if (order === null || !inGrant(scope, order)) throw notFound();
  const ref = (text: string) => parseTelegramRef(text)!;
  const message = (input: { telegramRef: string; at?: string | undefined; author?: string | undefined; excerpt?: string | undefined }) => ({
    telegramRef: ref(input.telegramRef), at: input.at === undefined ? null : new Date(input.at), author: input.author ?? null, excerpt: input.excerpt ?? null,
  });
  const unchanged = async () => ({ order: await agentOrderOf(app, order, now), outcome: "unchanged" as const });
  let step: CustomStep;
  switch (body.action) {
    case "edit":
      step = {
        action: "edit", patch: body.card, by: "agent",
        ...(body.deadlineOn === undefined ? {} : { deadlineOn: body.deadlineOn }),
        ...(body.sourceText === undefined ? {} : { sourceText: body.sourceText }),
        ...(body.ifVersion === undefined ? {} : { ifVersion: body.ifVersion }),
      };
      break;
    case "at_model": {
      const card = body.telegramRef === undefined ? undefined : ref(body.telegramRef);
      if (STEP_FROM.at_model.includes(order.state)) {
        step = { action: "at_model", telegramRef: card };
        break;
      }
      // The order is past that step already (the card copied once more): only the card is new, if any.
      if (card === undefined) return unchanged();
      step = { action: "card", telegramRef: card };
      break;
    }
    case "delivery":
      step = { action: "delivery", message: message(body.message), part: body.part, complete: body.complete };
      break;
    case "partly":
      step = { action: "partly", note: body.note, ref: ref(body.ref) };
      break;
    case "shot":
      // The same message again: the same state from it is nothing new.
      if (order.state === "shot" && order.stateRef === ref(body.ref)) return unchanged();
      step = { action: "shot", ref: ref(body.ref) };
      break;
    case "revision":
      step = { action: "revision", message: message(body.message), ordinal: body.ordinal, note: body.text };
      break;
    case "revision_done":
      step = { action: "revision_done", telegramRef: ref(body.telegramRef), ordinal: body.ordinal };
      break;
    case "refused":
      if (order.state === "refused" && order.stateRef === ref(body.ref)) return unchanged();
      step = { action: "refused", reason: body.reason, ref: ref(body.ref) };
      break;
    case "cancel":
      if (order.state === "cancelled") return unchanged();
      step = { action: "cancel", reason: body.reason };
      break;
    case "message":
      step = { action: "message", kind: body.kind, message: message(body.message) };
      break;
    case "card":
      step = { action: "card", telegramRef: ref(body.telegramRef) };
      break;
  }
  // A repeat of a step that changes nothing (a revision request or a delivery already kept) answers `unchanged`;
  // a step not from the order's state is 409 `not_allowed` (the reader reports it).
  const actor: CustomActor = {
    door: "api", agentKeyId: scope.principal.agentKeyId,
    onBehalfOfUserId: body.onBehalfOf === undefined ? null : await personOf(app, body.onBehalfOf),
  };
  if (!STEP_FROM[step.action].includes(order.state) && (step.action === "revision" || step.action === "delivery" || step.action === "message")) {
    // Recorded once already (a repeat after the order moved on): nothing new.
    return unchanged();
  }
  const changed = await applyCustomStep(app, { orderId: order.id, step, actor, viewer: null, now });
  return { order: await agentOrderOf(app, (await findCustomOrder(app.db, order.id))!, now), outcome: changed ? "changed" as const : "unchanged" as const };
}

/** The cards no order has: the ones that do belong to an order are answered, the rest become the lead's matters. */
export async function agentReportCustomCards(app: Pick<AppContext, "db" | "logger">, scope: AgentCustomScope, body: AgentCustomCardsBody, now: Date = new Date()) {
  const cards = body.cards.map((card) => ({ ...card, telegramRef: parseTelegramRef(card.telegramRef)! }));
  const owners = await listCustomOrderCardOwners(app.db, cards.map((card) => card.telegramRef));
  const matched = [...owners].map(([telegramRef, orderId]) => ({ telegramRef, code: `K-${orderId}` }));
  const unmatched = cards.filter((card) => !owners.has(card.telegramRef));
  const { opened, closed } = await reportUnmatchedCards(app, { cards: unmatched, complete: body.complete, agentKeyId: scope.principal.agentKeyId }, now);
  return { matched, opened, closed };
}
