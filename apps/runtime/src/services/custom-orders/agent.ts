import {
  customOrderCode,
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
  listOpenCustomOrdersOfFan,
  listCustomOrderCardOwners,
  listCustomOrderMessagesOf,
  type CustomOrderRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import type { AgentAuthPrincipal } from "../auth.ts";
import { AppError, ConflictError } from "../errors.ts";
import {
  applyCustomStep, cardTextOf, messageWire, orderMessagesOf, orderWire, recordCustomOrder,
  type CustomActor, type CustomEventResult, type CustomMessageInput, type CustomStep,
} from "./index.ts";
import { reportUnmatchedCards } from "./checks.ts";
import { dottedDay, fanInputOf, moscowDay, parseCardText, STEP_FROM } from "./rules.ts";

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

/**
 * `/tz`: a recorded order. The same Telegram card again answers its order, unchanged. A card whose text carries an
 * order's code (`sourceText`, «📦 Описание заказа K-123») is that order's: the card is attached to it and it is the
 * answer — Gengar records the order before its card is posted, the reader later finds the card by its link. Never
 * matched by the fan's name; a code of no order this key sees is refused (409 `code_unknown`), never a second order.
 */
export async function agentCreateCustomOrder(app: AgentApp, scope: AgentCustomScope, body: AgentCustomOrderCreateBody, now: Date = new Date()) {
  const telegramRef = body.telegramRef === undefined ? null : parseTelegramRef(body.telegramRef);
  if (telegramRef !== null) {
    const existing = await findCustomOrderIdByCard(app.db, telegramRef);
    if (existing !== null) {
      const order = (await findCustomOrder(app.db, existing))!;
      if (!inGrant(scope, order)) throw notFound();
      return { order: await agentOrderOf(app, order, now), outcome: "unchanged" as const, event: null };
    }
  }
  const actor: CustomActor = {
    door: "api", agentKeyId: scope.principal.agentKeyId,
    onBehalfOfUserId: body.onBehalfOf === undefined ? null : await personOf(app, body.onBehalfOf),
  };
  const code = body.sourceText === undefined ? null : parseCardText(body.sourceText).code;
  if (code !== null) {
    const order = await findCustomOrder(app.db, code);
    // Missing and out of grant are the same words.
    if (order === null || !inGrant(scope, order)) {
      throw new ConflictError(`The card names ${customOrderCode(code)}: no such order on this key's pages`, { reason: "code_unknown" });
    }
    if (body.pageLabel !== undefined && order.pageLabel !== null && order.pageLabel !== body.pageLabel) {
      throw new ConflictError(`The card names ${order.pageLabel}'s order ${customOrderCode(code)}, not one of ${body.pageLabel}`, { reason: "code_other_page" });
    }
    const changed = telegramRef !== null && await applyCustomStep(app, {
      orderId: order.id, actor, viewer: null, now,
      step: { action: "card", telegramRef, postedAt: body.postedAt === undefined ? null : new Date(body.postedAt), author: body.author ?? null },
    });
    return { order: await agentOrderOf(app, (await findCustomOrder(app.db, order.id))!, now), outcome: changed ? "changed" as const : "unchanged" as const, event: null };
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
    // Four doors record orders and only a card's link or code tells a repeat: an agent never silently records a
    // second open order of the same fan on the page. It hears the open ones; one more only with `another`.
    const buyer = fanId === null && body.fan !== undefined ? body.fan.slice(0, 300) : null;
    if (body.another !== true && (fanId !== null || buyer !== null)) {
      const open = await listOpenCustomOrdersOfFan(app.db, { pageId: page.id, fanId, buyer });
      if (open.length > 0) {
        const named = open.map((one) => `${customOrderCode(one.id)} (recorded ${dottedDay(moscowDay(one.createdAt))}, state ${one.state})`).join(", ");
        throw new ConflictError(
          `The fan has open orders on ${page.pageLabel}: ${named}. The card is most likely one of them (attach it: custom step <code> --step card);`
          + " a new custom of the fan is recorded with another: true",
          { reason: "open_orders" },
        );
      }
    }
  }
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
  return { order: await agentOrderOf(app, (await findCustomOrder(app.db, id))!, now), outcome: "created" as const, event: null };
}

export async function agentUpdateCustomOrder(app: AgentApp, scope: AgentCustomScope, code: string, body: AgentCustomOrderUpdateBody, now: Date = new Date()) {
  const id = parseCustomOrderCode(code);
  const order = id === null ? null : await findCustomOrder(app.db, id);
  if (order === null || !inGrant(scope, order)) throw notFound();
  const ref = (text: string) => parseTelegramRef(text)!;
  type MessageBody = { telegramRef?: string | undefined; at?: string | undefined; author?: string | undefined; excerpt?: string | undefined };
  const message = (input: MessageBody | undefined, eventRef: string | undefined): CustomMessageInput => ({
    telegramRef: input?.telegramRef === undefined ? null : ref(input.telegramRef), eventRef: eventRef ?? null,
    at: input?.at === undefined ? null : new Date(input.at), author: input?.author ?? null, excerpt: input?.excerpt ?? null,
  });
  const unchanged = async () => ({ order: await agentOrderOf(app, order, now), outcome: "unchanged" as const, event: null });
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
      // The routine repeats every message it sees. The card the order already holds, named again once the order is
      // past «записан» and «оплачен», changes nothing — above all it never takes a model's refusal back: only a new
      // card (the order posted to a model again) or a person's «Передать модели» sends a refused order there.
      const beforeModel = order.state === "recorded" || order.state === "paid";
      if (!beforeModel && card !== undefined && order.telegramRefs.includes(card)) return unchanged();
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
      step = { action: "delivery", message: message(body.message, body.eventRef), part: body.part, complete: body.complete };
      break;
    case "partly":
      step = { action: "partly", note: body.note, ref: ref(body.ref) };
      break;
    case "shot":
      step = { action: "shot", ref: ref(body.ref) };
      break;
    case "revision":
      step = { action: "revision", message: message(body.message, body.eventRef), ordinal: body.ordinal, note: body.text, part: body.part };
      break;
    case "revision_done":
      step = {
        action: "revision_done", telegramRef: body.telegramRef === undefined ? null : ref(body.telegramRef), eventRef: body.eventRef ?? null, ordinal: body.ordinal,
      };
      break;
    case "retract": {
      const link = parseTelegramRef(body.retracts);
      step = {
        action: "retract", retracts: link === null ? { eventRef: body.retracts } : { telegramRef: link }, reason: body.reason,
        message: { ...message(body.message, body.eventRef), eventRef: body.eventRef },
      };
      break;
    }
    case "refused":
      step = { action: "refused", reason: body.reason, ref: ref(body.ref) };
      break;
    case "cancel":
      if (order.state === "cancelled") return unchanged();
      step = { action: "cancel", reason: body.reason };
      break;
    case "message":
      step = { action: "message", kind: body.kind, message: message(body.message, body.eventRef) };
      break;
    case "card":
      step = { action: "card", telegramRef: ref(body.telegramRef) };
      break;
  }
  // A step that names a message or an event the order already keeps changes nothing and answers `unchanged` — a
  // delivery, a revision, and a state by a message (partly, shot, refused) alike, whatever the order's state is now
  // (the one rule is in `applyCustomStep`); a new step not from the order's state is 409 `not_allowed` (the reader
  // reports it).
  const actor: CustomActor = {
    door: "api", agentKeyId: scope.principal.agentKeyId,
    onBehalfOfUserId: body.onBehalfOf === undefined ? null : await personOf(app, body.onBehalfOf),
  };
  if (!STEP_FROM[step.action].includes(order.state) && step.action === "revision") {
    // Recorded once already (a repeat after the order moved on): nothing new.
    return unchanged();
  }
  // A message step says which event it names and whether the hub keeps it: a sender checks that, not the status.
  const report: { event: CustomEventResult | null } = { event: null };
  const changed = await applyCustomStep(app, { orderId: order.id, step, actor, viewer: null, now, report });
  return {
    order: await agentOrderOf(app, (await findCustomOrder(app.db, order.id))!, now),
    outcome: changed ? "changed" as const : "unchanged" as const,
    event: report.event,
  };
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
