import {
  customOrderCode,
  parseCustomOrderCode,
  parseTelegramRef,
  type AgentCustomCardsBody,
  type AgentCustomOrder,
  type AgentCustomOrderCreateBody,
  type AgentCustomOrdersQuery,
  type AgentCustomOrderUpdateBody,
  type AgentCustomSaleOutcome,
  type AgentSaleRequest,
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
  agentOrderBase, applyCustomStep, cardTextOf, customLeaderContext, messageWire, orderMessagesOf, recordCustomOrder, unlinkedSalesOf,
  type CustomActor, type CustomEventResult, type CustomLeaderContext, type CustomMessageInput, type CustomStep,
} from "./index.ts";
import { reportUnmatchedCards } from "./checks.ts";
import { checkFanAskedMessage, checkGivenMessage, checkNamedSales, modelPagesOf } from "./evidence.ts";
import { dottedDay, fanInputOf, moscowDay, parseCardText, STEP_FROM } from "./rules.ts";

/**
 * Заказ кастома, the agent key's door (write:customs): Gengar's `/tz` creates
 * a recorded order from the card's fields, its price and the sales the fan
 * paid it with, and keeps printing the card; «держи обновлённую» rewrites its
 * fields; the reader of the models' groups writes what the model did (partly,
 * shot, a revision, a refusal) with the model's message, attaches cards and
 * reports the ones no order has. The agent names sales and messages Hub
 * already holds — a payment (`read:money`), the message that gave the order,
 * the order's fan and his «where is it» (`read:messages`) — and Hub verifies
 * each (evidence.ts); a person can undo it, and the undo is remembered. A key
 * with write:customs alone gains none of these. Never «отдали» by a word.
 */

type AgentApp = Pick<AppContext, "db">;

export interface AgentCustomScope {
  principal: AgentAuthPrincipal;
  /** The key's granted pages, with their model. */
  pages: ReadonlyArray<{ id: number; pageLabel: string; platform: string; modelSlug: string }>;
  /** The key holds read:money (sales, and the facts on the wire) and read:messages (messages, the fan). */
  money: boolean;
  texts: boolean;
}

/** The plane's one 404: missing and out of grant are the same bytes. */
const notFound = () => new AppError("Not found", 404, "not_found");
/** At most this many of the fan's unlinked sales per order on the live list. */
const UNLINKED_SALES_MAX = 10;
/** A step that needs more than write:customs: the key lacks it (the plane's own words). */
const capabilityMissing = (capability: string) => new AppError(`agent key lacks the ${capability} capability`, 403, "agent_capability_missing");

async function personOf(app: AgentApp, username: string): Promise<number> {
  const person = await findMatterPerson(app.db, username);
  if (person === null) throw new ConflictError(`No living person "${username}"`, { reason: "person_unknown" });
  return person.userId;
}

function inGrant(scope: AgentCustomScope, order: CustomOrderRow): boolean {
  return order.pageId === null || scope.pages.some((page) => page.id === order.pageId);
}

async function agentOrderOf(app: AgentApp, scope: AgentCustomScope, order: CustomOrderRow, now: Date): Promise<AgentCustomOrder> {
  return agentWire(scope, order, await orderMessagesOf(app.db, order.id), now, await customLeaderContext(app));
}

function agentWire(scope: AgentCustomScope, order: CustomOrderRow, messages: AgentCustomOrder["messages"], now: Date, leaders: CustomLeaderContext | null): AgentCustomOrder {
  return { ...agentOrderBase(order, now, leaders, { money: scope.money }), cardText: cardTextOf(order), sourceText: order.sourceText, messages };
}

export async function agentListCustomOrders(app: AgentApp, scope: AgentCustomScope, query: AgentCustomOrdersQuery, now: Date = new Date()) {
  const orderId = query.code === undefined ? null : parseCustomOrderCode(query.code);
  const telegramRef = query.telegramRef === undefined ? null : parseTelegramRef(query.telegramRef);
  const filtered = orderId === null && telegramRef === null;
  const orders = await listAgentCustomOrders(app.db, {
    pageIds: scope.pages.map((page) => page.id), open: query.state === "open" && filtered, live: query.state === "live" && filtered, orderId, telegramRef,
    limit: query.limit,
  });
  const [messages, leaders] = await Promise.all([listCustomOrderMessagesOf(app.db, orders.map((order) => order.id)), customLeaderContext(app)]);
  const wires = orders.map((order) => agentWire(scope, order, (messages.get(order.id) ?? []).map(messageWire), now, leaders));
  // The live list to a key with read:money: what the reader may name for an order whose money is not complete.
  if (query.state === "live" && filtered && scope.money) {
    const labelOf = new Map(scope.pages.map((page) => [page.id, page.pageLabel]));
    for (const [index, order] of orders.entries()) {
      const wire = wires[index]!;
      if (wire.facts?.paid.value === "yes" || order.fanId === null) continue;
      const sales = await unlinkedSalesOf(app.db, order, modelPagesOf(scope, order), now, UNLINKED_SALES_MAX);
      wire.unlinkedSales = sales.map((sale) => ({
        saleRef: String(sale.transactionId), pageLabel: labelOf.get(sale.pageId ?? -1) ?? "", kind: sale.kind, grossMills: sale.grossMills,
        at: sale.at.toISOString(),
      }));
    }
  }
  return { orders: wires, serverNow: now.toISOString() };
}

function actorOf(scope: AgentCustomScope, onBehalfOfUserId: number | null): CustomActor {
  return { door: "api", agentKeyId: scope.principal.agentKeyId, onBehalfOfUserId };
}

/** Why a step refused a named sale, as the create's answer names it. */
function saleRefusalOf(error: unknown): AgentCustomSaleOutcome["reason"] | null {
  if (!(error instanceof ConflictError)) return null;
  const reason = error.reason;
  return reason === "rejected" ? "rejected" : reason === "not_allowed" ? "not_allowed" : reason === "not_suggested" ? "taken" : null;
}

/**
 * The sales a create names, each checked (evidence.ts) and the ones that hold linked by the payment step, one by one:
 * a sale that does not hold never fails the create — the answer says, per sale, linked or why not.
 */
async function linkNamedSales(
  app: AgentApp,
  scope: AgentCustomScope,
  orderId: number,
  sales: readonly AgentSaleRequest[],
  actor: CustomActor,
  now: Date,
): Promise<{ outcomes: AgentCustomSaleOutcome[]; changed: boolean }> {
  const order = (await findCustomOrder(app.db, orderId))!;
  const checked = await checkNamedSales(app.db, scope, order, sales, scope.money);
  const outcomes: AgentCustomSaleOutcome[] = [];
  let changed = false;
  for (const one of checked) {
    const saleRef = one.transactionId === null ? null : String(one.transactionId);
    if (one.verdict === "already") {
      outcomes.push({ sale: one.sale, saleRef, result: "already", reason: null });
      continue;
    }
    if (one.verdict !== "ok") {
      outcomes.push({ sale: one.sale, saleRef, result: "refused", reason: one.verdict });
      continue;
    }
    const current = (await findCustomOrder(app.db, orderId))!;
    if (!STEP_FROM.payment.includes(current.state)) {
      outcomes.push({ sale: one.sale, saleRef, result: "refused", reason: "not_allowed" });
      continue;
    }
    try {
      const linked = await applyCustomStep(app, { orderId, step: { action: "payment", transactionId: one.transactionId! }, actor, viewer: null, now });
      changed ||= linked;
      outcomes.push({ sale: one.sale, saleRef, result: linked ? "linked" : "already", reason: null });
    } catch (error) {
      // Taken by another order between the check and the lock, or refused by the step's own rules.
      const reason = saleRefusalOf(error);
      if (reason === null) throw error;
      outcomes.push({ sale: one.sale, saleRef, result: "refused", reason });
    }
  }
  return { outcomes, changed };
}

/**
 * What a create brings to an order it finds (by its card or its code) besides the card: the price, by the agent's edit
 * (a price a person set is theirs and stays), and the sales. Answers whether anything changed.
 */
async function applyToFound(
  app: AgentApp,
  scope: AgentCustomScope,
  order: CustomOrderRow,
  body: AgentCustomOrderCreateBody,
  actor: CustomActor,
  now: Date,
): Promise<{ changed: boolean; sales: AgentCustomSaleOutcome[] | undefined }> {
  let changed = false;
  if (body.priceMills !== undefined && body.priceMills !== order.priceMills && !order.personFields.includes("priceMills")) {
    changed = await applyCustomStep(app, { orderId: order.id, step: { action: "edit", priceMills: body.priceMills, by: "agent" }, actor, viewer: null, now });
  }
  if (body.sales === undefined) return { changed, sales: undefined };
  const linked = await linkNamedSales(app, scope, order.id, body.sales, actor, now);
  return { changed: changed || linked.changed, sales: linked.outcomes };
}

/**
 * `/tz`: a recorded order. The same Telegram card again answers its order, unchanged. A card whose text carries an
 * order's code (`sourceText`, «📦 Описание заказа K-123») is that order's: the card is attached to it and it is the
 * answer — Gengar records the order before its card is posted, the reader later finds the card by its link. Never
 * matched by the fan's name; a code of no order this key sees is refused (409 `code_unknown`), never a second order.
 * An order found by its card or its code takes the create's price and sales (customs facts spec §5). The named sales
 * are each answered in `sales`: linked, or why not; none of them fails the create.
 */
export async function agentCreateCustomOrder(app: AgentApp, scope: AgentCustomScope, body: AgentCustomOrderCreateBody, now: Date = new Date()) {
  const telegramRef = body.telegramRef === undefined ? null : parseTelegramRef(body.telegramRef);
  const actorNow = async () => actorOf(scope, body.onBehalfOf === undefined ? null : await personOf(app, body.onBehalfOf));
  const withSales = <T extends object>(answer: T, sales: AgentCustomSaleOutcome[] | undefined) => (sales === undefined ? answer : { ...answer, sales });
  if (telegramRef !== null) {
    const existing = await findCustomOrderIdByCard(app.db, telegramRef);
    if (existing !== null) {
      const order = (await findCustomOrder(app.db, existing))!;
      if (!inGrant(scope, order)) throw notFound();
      const applied = body.priceMills === undefined && body.sales === undefined
        ? { changed: false, sales: undefined }
        : await applyToFound(app, scope, order, body, await actorNow(), now);
      return withSales({
        order: await agentOrderOf(app, scope, (await findCustomOrder(app.db, order.id))!, now), outcome: applied.changed ? "changed" as const : "unchanged" as const, event: null,
      }, applied.sales);
    }
  }
  const actor = await actorNow();
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
    const carded = telegramRef !== null && await applyCustomStep(app, {
      orderId: order.id, actor, viewer: null, now,
      step: { action: "card", telegramRef, postedAt: body.postedAt === undefined ? null : new Date(body.postedAt), author: body.author ?? null },
    });
    const applied = await applyToFound(app, scope, (await findCustomOrder(app.db, order.id))!, body, actor, now);
    return withSales({
      order: await agentOrderOf(app, scope, (await findCustomOrder(app.db, order.id))!, now),
      outcome: carded || applied.changed ? "changed" as const : "unchanged" as const, event: null,
    }, applied.sales);
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
    priceMills: body.priceMills ?? null,
    holdReason: body.holdReason ?? null,
    // A card posted earlier counts from its time (the checks and the delivery hints read it).
    ...(body.postedAt !== undefined && Date.parse(body.postedAt) < now.getTime() ? { createdAt: new Date(body.postedAt) } : {}),
  });
  // The order is recorded; its sales are linked after it, each by its own step: one that does not hold is answered, not fatal.
  const sales = body.sales === undefined ? undefined : (await linkNamedSales(app, scope, id, body.sales, actor, now)).outcomes;
  return withSales({ order: await agentOrderOf(app, scope, (await findCustomOrder(app.db, id))!, now), outcome: "created" as const, event: null }, sales);
}

/** A refusal of a named sale as the payment step answers it: not found reads as the plane's 404. */
function saleRefused(verdict: Exclude<AgentCustomSaleOutcome["reason"], null>): AppError {
  if (verdict === "not_found") return notFound();
  if (verdict === "capability_missing") return capabilityMissing("read:money");
  return new ConflictError(`The sale does not pay this order: ${verdict}`, { reason: verdict });
}

export async function agentUpdateCustomOrder(app: AgentApp, scope: AgentCustomScope, code: string, body: AgentCustomOrderUpdateBody, now: Date = new Date()) {
  // A step that names money or a message needs that capability besides write:customs: a key that only writes the
  // shooting gains nothing new (customs facts spec §11). Checked before the order is looked at.
  if (body.action === "payment" && !scope.money) throw capabilityMissing("read:money");
  if ((body.action === "given" || body.action === "fan" || body.action === "fan_asked") && !scope.texts) throw capabilityMissing("read:messages");
  const id = parseCustomOrderCode(code);
  const order = id === null ? null : await findCustomOrder(app.db, id);
  if (order === null || !inGrant(scope, order)) throw notFound();
  const ref = (text: string) => parseTelegramRef(text)!;
  type MessageBody = { telegramRef?: string | undefined; at?: string | undefined; author?: string | undefined; excerpt?: string | undefined };
  const message = (input: MessageBody | undefined, eventRef: string | undefined): CustomMessageInput => ({
    telegramRef: input?.telegramRef === undefined ? null : ref(input.telegramRef), eventRef: eventRef ?? null,
    at: input?.at === undefined ? null : new Date(input.at), author: input?.author ?? null, excerpt: input?.excerpt ?? null,
  });
  const unchanged = async () => ({ order: await agentOrderOf(app, scope, order, now), outcome: "unchanged" as const, event: null });
  let step: CustomStep;
  switch (body.action) {
    case "edit":
      step = {
        action: "edit", patch: body.card, by: "agent",
        ...(body.deadlineOn === undefined ? {} : { deadlineOn: body.deadlineOn }),
        ...(body.sourceText === undefined ? {} : { sourceText: body.sourceText }),
        ...(body.ifVersion === undefined ? {} : { ifVersion: body.ifVersion }),
        ...(body.priceMills === undefined ? {} : { priceMills: body.priceMills }),
        ...(body.holdReason === undefined ? {} : { holdReason: body.holdReason }),
      };
      break;
    case "deadline":
      step = { action: "deadline", deadlineOn: body.deadlineOn, by: "agent", reason: body.reason };
      break;
    case "payment": {
      const [named] = await checkNamedSales(app.db, scope, order, [body.sale], scope.money);
      if (named!.verdict === "already") return unchanged();
      if (named!.verdict !== "ok") throw saleRefused(named!.verdict);
      step = { action: "payment", transactionId: named!.transactionId! };
      break;
    }
    case "given": {
      if (order.state === "given" && order.givenMessageRef === body.messageRef) return unchanged();
      if (!STEP_FROM.given.includes(order.state)) throw new ConflictError(`An order «${order.state}» takes no step «given»`, { reason: "not_allowed" });
      const checked = await checkGivenMessage(app.db, scope, order, body.messageRef);
      step = { action: "given", messageRef: body.messageRef, at: checked.at };
      break;
    }
    case "fan": {
      const page = scope.pages.find((candidate) => candidate.pageLabel === body.pageLabel);
      if (page === undefined) throw notFound();
      if (order.fanId !== null || order.fanErasedAt !== null) {
        throw new ConflictError("The order has its fan already, or its fan was erased", { reason: "fan_known" });
      }
      // The fan of the order's own page: the page is set by the fan only when the order names none.
      if (order.pageId !== null && order.pageId !== page.id) {
        throw new ConflictError(`The order is ${order.pageLabel}'s, not ${page.pageLabel}'s`, { reason: "other_page" });
      }
      const fan = await findPageFanByInput(app.db, { pageId: page.id, platform: page.platform, platformUserId: body.fanRef, username: null });
      if (fan === null) throw new ConflictError("No such fan on the page", { reason: "fan_unknown" });
      step = { action: "fan", pageId: page.id, fanId: fan.fanId, conversationRef: page.platform === "onlyfans" ? fan.platformUserId : null, by: "agent" };
      break;
    }
    case "fan_asked": {
      if (order.fanAskedRef === body.messageRef) return unchanged();
      const checked = await checkFanAskedMessage(app.db, order, body.messageRef);
      step = { action: "fan_asked", messageRef: body.messageRef, at: checked.at };
      break;
    }
    case "issue":
      step = { action: "issue", text: body.text };
      break;
    case "issue_clear":
      step = { action: "issue_clear" };
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
  const actor = actorOf(scope, body.onBehalfOf === undefined ? null : await personOf(app, body.onBehalfOf));
  if (!STEP_FROM[step.action].includes(order.state) && step.action === "revision") {
    // Recorded once already (a repeat after the order moved on): nothing new.
    return unchanged();
  }
  // A message step says which event it names and whether the hub keeps it: a sender checks that, not the status.
  const report: { event: CustomEventResult | null } = { event: null };
  const changed = await applyCustomStep(app, { orderId: order.id, step, actor, viewer: null, now, report });
  return {
    order: await agentOrderOf(app, scope, (await findCustomOrder(app.db, order.id))!, now),
    outcome: changed ? "changed" as const : "unchanged" as const,
    event: report.event,
  };
}

/** The cards no order has: the ones that do belong to an order are answered, the rest become the lead's matters. */
export async function agentReportCustomCards(app: Pick<AppContext, "db" | "logger" | "config">, scope: AgentCustomScope, body: AgentCustomCardsBody, now: Date = new Date()) {
  const cards = body.cards.map((card) => ({ ...card, telegramRef: parseTelegramRef(card.telegramRef)! }));
  const owners = await listCustomOrderCardOwners(app.db, cards.map((card) => card.telegramRef));
  const matched = [...owners].map(([telegramRef, orderId]) => ({ telegramRef, code: `K-${orderId}` }));
  const unmatched = cards.filter((card) => !owners.has(card.telegramRef));
  const { opened, closed } = await reportUnmatchedCards(app, { cards: unmatched, complete: body.complete, agentKeyId: scope.principal.agentKeyId }, now);
  return { matched, opened, closed };
}
