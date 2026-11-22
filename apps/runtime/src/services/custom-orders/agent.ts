import {
  customOrderCode,
  parseCustomOrderCode,
  parseTelegramRef,
  type AgentCustomCardsBody,
  type AgentCustomEventsQuery,
  type AgentCustomEventsResponse,
  type AgentCustomFindingActBody,
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
  findCustomPageReplyAfter,
  findCustomTakerOnPage,
  findMatterPerson,
  findPageFanByInput,
  isCustomOrderIssueOfAgent,
  listAgentCustomOrders,
  listCustomEventsAfter,
  listOnShiftUsersByPage,
  listOpenCustomOrdersOfFan,
  listCustomOrderCardOwners,
  listCustomOrderMessagesOf,
  listCustomOrdersByIds,
  lockCustomOrderCreate,
  type CustomOrderRow,
  type CustomTakerRow,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { principalOfLogin, type AgentAuthPrincipal, type HumanAuthPrincipal } from "../auth.ts";
import { AppError, ConflictError } from "../errors.ts";
import { isTestAgent } from "../sandbox/realm.ts";
import {
  agentOrderBase, applyCustomStep, boardStepAs, cardTextOf, customLeaderContext, customViewerOf, messageWire, orderMessagesOf, recordCustomOrder,
  unlinkedSalesOf,
  type CustomActor, type CustomEventResult, type CustomLeaderContext, type CustomMessageInput, type CustomOnShift, type CustomStep,
  type CustomTakerResult,
} from "./index.ts";
import { actOnCustomFindingAs } from "./findings.ts";
import { seesOrder } from "./rules.ts";
import { reportUnmatchedCards } from "./checks.ts";
import { giveByMessage, linkDeliveryPurchases } from "./deliveries.ts";
import { checkFanAskedMessage, checkGivenMessage, checkNamedSales, deliveryPurchasesOf, modelPagesOf } from "./evidence.ts";
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

/**
 * An order of the key's pages; one of no known page is the live agency's (0414): a live key's to read and write, never a
 * test key's — the test realm's key neither reads nor writes a live order.
 */
function inGrant(scope: AgentCustomScope, order: CustomOrderRow): boolean {
  if (order.pageId === null) return !isTestAgent(scope.principal);
  return scope.pages.some((page) => page.id === order.pageId);
}

async function agentOrderOf(app: AgentApp, scope: AgentCustomScope, order: CustomOrderRow, now: Date): Promise<AgentCustomOrder> {
  const [messages, leaders, onShift] = await Promise.all([
    orderMessagesOf(app.db, order.id), customLeaderContext(app), scope.texts ? listOnShiftUsersByPage(app.db, now) : Promise.resolve(new Map<string, number[]>()),
  ]);
  return agentWire(scope, order, messages, now, leaders, scope.texts ? { onShift } : undefined);
}

function agentWire(
  scope: AgentCustomScope,
  order: CustomOrderRow,
  messages: AgentCustomOrder["messages"],
  now: Date,
  leaders: CustomLeaderContext | null,
  reading?: { onShift: CustomOnShift },
): AgentCustomOrder {
  const base = agentOrderBase(order, now, leaders, { money: scope.money, ...(reading === undefined ? {} : { reading: true, onShift: reading.onShift }) });
  return { ...base, cardText: cardTextOf(order), sourceText: order.sourceText, messages };
}

export async function agentListCustomOrders(app: AgentApp, scope: AgentCustomScope, query: AgentCustomOrdersQuery, now: Date = new Date()) {
  const orderId = query.code === undefined ? null : parseCustomOrderCode(query.code);
  const telegramRef = query.telegramRef === undefined ? null : parseTelegramRef(query.telegramRef);
  const filtered = orderId === null && telegramRef === null;
  const orders = await listAgentCustomOrders(app.db, {
    pageIds: scope.pages.map((page) => page.id), noPage: !isTestAgent(scope.principal),
    open: query.state === "open" && filtered, live: query.state === "live" && filtered, orderId, telegramRef, limit: query.limit,
  });
  // Every read to a key with read:messages (the live list, by code, by card): whose move each order is and whether it
  // burns, by the board's one rule — the reader's reminders (who gives a shot order, who forwards a waiting card) and its
  // answers to people read it from here, never `leader` alone.
  const reading = scope.texts;
  const [messages, leaders, onShift] = await Promise.all([
    listCustomOrderMessagesOf(app.db, orders.map((order) => order.id)),
    customLeaderContext(app),
    reading ? listOnShiftUsersByPage(app.db, now) : Promise.resolve(new Map<string, number[]>()),
  ]);
  const wires = orders.map((order) => agentWire(scope, order, (messages.get(order.id) ?? []).map(messageWire), now, leaders, reading ? { onShift } : undefined));
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
 * a sale that does not hold never fails the create — the answer says, per sale, linked or why not. The one-off backfill
 * links its sales by the same path (backfill.ts).
 */
export async function linkNamedSales(
  app: AgentApp,
  scope: Pick<AgentCustomScope, "pages" | "money">,
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

const TAKER_REFUSALS = new Set(["taker_set", "person_set", "taker_unknown"]);

/**
 * The taker named by an agent's evidence (a login, the backfill's file), by the step `accepted_by`: only an order with
 * none. Answers whether it changed and what it did — never a refusal: another taker, a person's decision or nobody named
 * are the outcome's reason.
 */
export async function fillTakerOf(
  app: AgentApp,
  input: { orderId: number; taker: CustomTakerRow | null; source: "agent" | "backfill"; actor: CustomActor; now: Date },
): Promise<{ changed: boolean; outcome: CustomTakerResult }> {
  const report: { event: CustomEventResult | null; taker?: CustomTakerResult } = { event: null };
  try {
    const changed = await applyCustomStep(app, {
      orderId: input.orderId, step: { action: "accepted_by", taker: input.taker, by: "evidence", source: input.source }, actor: input.actor, viewer: null,
      now: input.now, report,
    });
    return { changed, outcome: report.taker ?? { result: changed ? "set" : "unchanged", source: input.source, reason: null } };
  } catch (error) {
    if (error instanceof ConflictError && TAKER_REFUSALS.has(error.reason ?? "")) {
      return { changed: false, outcome: { result: "unchanged", source: input.source, reason: error.reason as CustomTakerResult["reason"] } };
    }
    throw error;
  }
}

/** The taker a login names on the order's page (null — nobody of it works there, or the order has no page). */
async function takerByLogin(app: AgentApp, pageId: number | null, login: string): Promise<CustomTakerRow | null> {
  return pageId === null ? null : findCustomTakerOnPage(app.db, { pageId, login });
}

/**
 * What a create brings to an order it finds (by its card or its code) besides the card: the price, by the agent's edit
 * (a price a person set is theirs and stays), the taker (`acceptedBy`: only while the order names none), and the sales.
 * Answers whether anything changed.
 */
async function applyToFound(
  app: AgentApp,
  scope: AgentCustomScope,
  order: CustomOrderRow,
  body: AgentCustomOrderCreateBody,
  actor: CustomActor,
  now: Date,
): Promise<{ changed: boolean; sales: AgentCustomSaleOutcome[] | undefined; taker: CustomTakerResult | undefined }> {
  let changed = false;
  let taker: CustomTakerResult | undefined;
  if (body.priceMills !== undefined && body.priceMills !== order.priceMills && !order.personFields.includes("priceMills")) {
    changed = await applyCustomStep(app, { orderId: order.id, step: { action: "edit", priceMills: body.priceMills, by: "agent" }, actor, viewer: null, now });
  }
  if (body.acceptedBy !== undefined) {
    const filled = await fillTakerOf(app, { orderId: order.id, taker: await takerByLogin(app, order.pageId, body.acceptedBy), source: "agent", actor, now });
    changed ||= filled.changed;
    taker = filled.outcome;
  }
  if (body.sales === undefined) return { changed, sales: undefined, taker };
  const linked = await linkNamedSales(app, scope, order.id, body.sales, actor, now);
  return { changed: changed || linked.changed, sales: linked.outcomes, taker };
}

/** A card's author and kind as the create's and the steps' bodies carry them (`work` names the taker). */
const cardAuthorOf = (body: { authorTelegramId?: string | undefined; cardKind?: "work" | "model" | undefined }) => ({
  ...(body.authorTelegramId === undefined ? {} : { authorTelegramId: body.authorTelegramId }),
  ...(body.cardKind === undefined ? {} : { cardKind: body.cardKind }),
});

/**
 * `/tz`: a recorded order. The same Telegram card again answers its order, unchanged. A card whose text carries an
 * order's code (`sourceText`, «📦 Описание заказа K-123») is that order's: the card is attached to it and it is the
 * answer — Gengar records the order before its card is posted, the reader later finds the card by its link. Never
 * matched by the fan's name; a code of no order this key sees is refused (409 `code_unknown`), never a second order.
 * An order found by its card or its code takes the create's price and sales (customs facts spec §5). The named sales
 * are each answered in `sales`: linked, or why not; none of them fails the create.
 */
export async function agentCreateCustomOrder(app: AgentApp, scope: AgentCustomScope, body: AgentCustomOrderCreateBody, now: Date = new Date()) {
  // The price is about the fan's money, a hold's reason is read in the chats: a key that only writes the shooting names
  // neither (customs facts spec §11).
  if (body.priceMills !== undefined && !scope.money) throw capabilityMissing("read:money");
  if (body.holdReason !== undefined && !scope.texts) throw capabilityMissing("read:messages");
  const telegramRef = body.telegramRef === undefined ? null : parseTelegramRef(body.telegramRef);
  const actorNow = async () => actorOf(scope, body.onBehalfOf === undefined ? null : await personOf(app, body.onBehalfOf));
  const withSales = <T extends object>(answer: T, sales: AgentCustomSaleOutcome[] | undefined) => (sales === undefined ? answer : { ...answer, sales });
  const withTaker = <T extends object>(answer: T, taker: CustomTakerResult | undefined) => (taker === undefined ? answer : { ...answer, taker });
  if (telegramRef !== null) {
    const existing = await findCustomOrderIdByCard(app.db, telegramRef);
    if (existing !== null) {
      const order = (await findCustomOrder(app.db, existing))!;
      if (!inGrant(scope, order)) throw notFound();
      // The card's link is one order's and its text names another: neither is guessed, the agent sorts it out.
      const named = body.sourceText === undefined ? null : parseCardText(body.sourceText).code;
      if (named !== null && named !== order.id) {
        throw new ConflictError(`The card's link is ${customOrderCode(order.id)}'s and its text names ${customOrderCode(named)}`, { reason: "card_other_order" });
      }
      const applied = body.priceMills === undefined && body.sales === undefined && body.acceptedBy === undefined
        ? { changed: false, sales: undefined, taker: undefined }
        : await applyToFound(app, scope, order, body, await actorNow(), now);
      // The card again with its author: a work card's author names the taker of an order with none.
      const carded = body.cardKind === "work" && body.authorTelegramId !== undefined && body.acceptedBy === undefined
        ? await cardStep(app, order.id, { telegramRef, ...cardAuthorOf(body) }, await actorNow(), now)
        : null;
      return withTaker(withSales({
        order: await agentOrderOf(app, scope, (await findCustomOrder(app.db, order.id))!, now),
        outcome: applied.changed || carded?.changed === true ? "changed" as const : "unchanged" as const, event: null,
      }, applied.sales), applied.taker ?? carded?.taker);
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
    const carded = telegramRef === null ? null : await cardStep(app, order.id, {
      telegramRef, postedAt: body.postedAt === undefined ? null : new Date(body.postedAt), author: body.author ?? null,
      // The login the create names comes first: the card's author fills only what it leaves empty.
      ...(body.acceptedBy === undefined ? cardAuthorOf(body) : { ...(body.authorTelegramId === undefined ? {} : { authorTelegramId: body.authorTelegramId }) }),
    }, actor, now);
    const applied = await applyToFound(app, scope, (await findCustomOrder(app.db, order.id))!, body, actor, now);
    return withTaker(withSales({
      order: await agentOrderOf(app, scope, (await findCustomOrder(app.db, order.id))!, now),
      outcome: carded?.changed === true || applied.changed ? "changed" as const : "unchanged" as const, event: null,
    }, applied.sales), applied.taker ?? carded?.taker);
  }
  let pageId: number | null = null;
  let fanId: number | null = null;
  let conversationRef: string | null = null;
  let buyer: string | null = null;
  // An order of no known page is the live agency's: the test realm's key records only on its own pages.
  if (body.pageLabel === undefined && isTestAgent(scope.principal)) {
    throw new ConflictError("A test key records an order on one of its pages: pageLabel", { reason: "page_required" });
  }
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
  // A fan that does not match stays the buyer's string, as the card names him: never a guess.
  if (fanId === null && body.fan !== undefined) buyer = body.fan.slice(0, 300);
  const pageLabel = body.pageLabel;
  // «Принял»: the login the create names, else its work card's author by Telegram id — on the order's page, never by a name.
  const takerEvidence = body.acceptedBy !== undefined
    ? { taker: await takerByLogin(app, pageId, body.acceptedBy), source: "agent" as const, ref: null }
    : body.cardKind === "work" && body.authorTelegramId !== undefined
      ? { taker: pageId === null ? null : await findCustomTakerOnPage(app.db, { pageId, telegramUserId: body.authorTelegramId }), source: "card" as const, ref: telegramRef }
      : null;
  const taker = takerEvidence?.taker ?? null;
  const id = await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    if (pageId !== null && (fanId !== null || buyer !== null)) {
      // Two `/tz` of one fan at once: the second waits for the first and then hears its order (one create at a time per
      // fan of a page). Four doors record orders and only a card's link or code tells a repeat: an agent never silently
      // records a second open order of the same fan on the page — it hears the open ones; one more only with `another`.
      await lockCustomOrderCreate(db, { pageId, fanId, buyer });
      if (body.another !== true) {
        const open = await listOpenCustomOrdersOfFan(db, { pageId, fanId, buyer });
        if (open.length > 0) {
          const named = open.map((one) => `${customOrderCode(one.id)} (recorded ${dottedDay(moscowDay(one.createdAt))}, state ${one.state})`).join(", ");
          throw new ConflictError(
            `The fan has open orders on ${pageLabel}: ${named}. The card is most likely one of them (attach it: custom step <code> --step card);`
            + " a new custom of the fan is recorded with another: true",
            { reason: "open_orders" },
          );
        }
      }
    }
    return recordCustomOrder({ db }, {
      pageId, fanId, buyer, conversationRef, card: body.card, deadlineOn: body.deadlineOn ?? null,
      acceptedByUserId: taker?.userId ?? null,
      taker: taker === null ? null : { source: takerEvidence!.source, ref: takerEvidence!.ref, name: taker.name, person: false },
      origin: "agent", telegramRefs: telegramRef === null ? [] : [telegramRef], actor, now,
      sourceText: body.sourceText ?? null,
      cardPostedAt: body.postedAt === undefined ? null : new Date(body.postedAt),
      cardAuthor: body.author ?? null,
      cardAuthorTelegramId: body.authorTelegramId ?? null,
      priceMills: body.priceMills ?? null,
      holdReason: body.holdReason ?? null,
      // A card posted earlier counts from its time (the checks and the delivery hints read it).
      ...(body.postedAt !== undefined && Date.parse(body.postedAt) < now.getTime() ? { createdAt: new Date(body.postedAt) } : {}),
    });
  });
  // The order is recorded; its sales are linked after it, each by its own step: one that does not hold is answered, not fatal.
  // With no taker yet, a sale whose one home is one chatter's whole names them (the payment step).
  const sales = body.sales === undefined ? undefined : (await linkNamedSales(app, scope, id, body.sales, actor, now)).outcomes;
  const recorded = (await findCustomOrder(app.db, id))!;
  const takerOutcome: CustomTakerResult | undefined = takerEvidence !== null && taker !== null ? { result: "set", source: takerEvidence.source, reason: null }
    : recorded.acceptedByUserId !== null ? { result: "set", source: "sale", reason: null }
    : takerEvidence !== null ? { result: "unchanged", source: takerEvidence.source, reason: "taker_unknown" }
    : undefined;
  return withTaker(withSales({ order: await agentOrderOf(app, scope, recorded, now), outcome: "created" as const, event: null }, sales), takerOutcome);
}

/** The card step with its author (a work card names the taker of an order with none): whether it changed, and the taker's outcome. */
async function cardStep(
  app: AgentApp,
  orderId: number,
  card: { telegramRef: string; postedAt?: Date | null; author?: string | null; authorTelegramId?: string; cardKind?: "work" | "model" },
  actor: CustomActor,
  now: Date,
): Promise<{ changed: boolean; taker: CustomTakerResult | undefined }> {
  const report: { event: CustomEventResult | null; taker?: CustomTakerResult } = { event: null };
  const changed = await applyCustomStep(app, { orderId, step: { action: "card", ...card }, actor, viewer: null, now, report });
  return { changed, taker: report.taker };
}

/** A refusal of a named sale as the payment step answers it: not found reads as the plane's 404. */
function saleRefused(verdict: Exclude<AgentCustomSaleOutcome["reason"], null>): AppError {
  if (verdict === "not_found") return notFound();
  if (verdict === "capability_missing") return capabilityMissing("read:money");
  return new ConflictError(`The sale does not pay this order: ${verdict}`, { reason: verdict });
}

export async function agentUpdateCustomOrder(app: AppContext, scope: AgentCustomScope, code: string, body: AgentCustomOrderUpdateBody, now: Date = new Date()) {
  // A step that names money or a message needs that capability besides write:customs: a key that only writes the
  // shooting gains nothing new (customs facts spec §11) — the price is money; a hold, an issue and its end are read in
  // the chats. Checked before the order is looked at.
  if ((body.action === "payment" || (body.action === "edit" && body.priceMills !== undefined)) && !scope.money) throw capabilityMissing("read:money");
  if ((body.action === "given" || body.action === "fan" || body.action === "fan_asked" || body.action === "issue" || body.action === "issue_clear"
    || body.action === "board" || (body.action === "edit" && body.holdReason !== undefined)) && !scope.texts) throw capabilityMissing("read:messages");
  const id = parseCustomOrderCode(code);
  const order = id === null ? null : await findCustomOrder(app.db, id);
  if (order === null || !inGrant(scope, order)) throw notFound();
  // On a person's word: the board's own step, as that person takes it there.
  if (body.action === "board") {
    const { person, requestRef } = await onWordOf(app, scope, body);
    const viewer = await customViewerOf(app, person);
    if (!seesOrder(viewer, order)) throw new ConflictError(`${body.onBehalfOf} does not see this order on the board`, { reason: "not_allowed" });
    const changed = await boardStepAs(app, {
      viewer, order, body: body.step, actor: { door: "api", agentKeyId: scope.principal.agentKeyId, onBehalfOfUserId: person.user.id }, now, requestRef,
    });
    return { order: await agentOrderOf(app, scope, (await findCustomOrder(app.db, order.id))!, now), outcome: changed ? "changed" as const : "unchanged" as const, event: null };
  }
  const ref = (text: string) => parseTelegramRef(text)!;
  type MessageBody = { telegramRef?: string | undefined; at?: string | undefined; author?: string | undefined; excerpt?: string | undefined };
  const message = (input: MessageBody | undefined, eventRef: string | undefined): CustomMessageInput => ({
    telegramRef: input?.telegramRef === undefined ? null : ref(input.telegramRef), eventRef: eventRef ?? null,
    at: input?.at === undefined ? null : new Date(input.at), author: input?.author ?? null, excerpt: input?.excerpt ?? null,
  });
  const unchanged = async () => ({ order: await agentOrderOf(app, scope, order, now), outcome: "unchanged" as const, event: null });
  let step: CustomStep;
  /** «Отдан» by a message: the purchases that come with it (the order's money by construction). */
  let deliveryPurchases: number[] | null = null;
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
      if (order.state === "given" && order.givenMessageRef === body.messageRef) {
        // The same message again: «отдан» stands; its purchase, not linked when the mark was set, is now.
        const linked = await linkDeliveryPurchases(app, {
          orderId: order.id, purchaseIds: await deliveryPurchasesOf(app.db, scope, order, body.messageRef),
          actor: actorOf(scope, body.onBehalfOf === undefined ? null : await personOf(app, body.onBehalfOf)), now,
        });
        if (linked === 0) return unchanged();
        return { order: await agentOrderOf(app, scope, (await findCustomOrder(app.db, order.id))!, now), outcome: "changed" as const, event: null };
      }
      if (!STEP_FROM.given.includes(order.state)) throw new ConflictError(`An order «${order.state}» takes no step «given»`, { reason: "not_allowed" });
      const checked = await checkGivenMessage(app.db, scope, order, body.messageRef);
      step = { action: "given", messageRef: body.messageRef, at: checked.at };
      deliveryPurchases = checked.purchaseIds;
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
      // An ask the page has answered since (the reader repeats what it read) asks nothing any more.
      if ((await findCustomPageReplyAfter(app.db, { pageId: order.pageId!, fanIds: checked.fanIds, after: checked.at })) !== null) return unchanged();
      step = { action: "fan_asked", messageRef: body.messageRef, at: checked.at };
      break;
    }
    case "issue":
      step = { action: "issue", text: body.text };
      break;
    case "issue_clear":
      // The agent takes back only its own sentence; another's — another key's — a person settles (the owner's step).
      if (order.issue !== null && !(await isCustomOrderIssueOfAgent(app.db, { orderId: order.id, agentKeyId: scope.principal.agentKeyId }))) {
        throw new ConflictError("Another agent set this issue: a person settles it", { reason: "not_yours" });
      }
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
        step = { action: "at_model", telegramRef: card, ...cardAuthorOf(body) };
        break;
      }
      // The order is past that step already (the card copied once more): only the card is new, if any.
      if (card === undefined) return unchanged();
      step = { action: "card", telegramRef: card, ...cardAuthorOf(body) };
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
      step = { action: "card", telegramRef: ref(body.telegramRef), ...cardAuthorOf(body) };
      break;
    case "accepted_by": {
      // A login of the order's page; it fills only an order with none (409 taker_set, person_set otherwise).
      const taker = await takerByLogin(app, order.pageId, body.acceptedBy);
      if (taker === null) throw new ConflictError(`Nobody of the login ${body.acceptedBy} works on the order's page`, { reason: "taker_unknown" });
      step = { action: "accepted_by", taker, by: "evidence", source: "agent" };
      break;
    }
  }
  // A step that names a message or an event the order already keeps changes nothing and answers `unchanged` — a
  // delivery, a revision, and a state by a message (partly, shot, refused) alike, whatever the order's state is now
  // (the one rule is in `applyCustomStep`); a new step not from the order's state is 409 `not_allowed` (the reader
  // reports it).
  const actor = actorOf(scope, body.onBehalfOf === undefined ? null : await personOf(app, body.onBehalfOf));
  if (step.action === "given" && step.messageRef !== null && deliveryPurchases !== null) {
    // «Отдан» by the message and its purchase as the order's payment, in one transaction — on the order as it was checked:
    // one that moved meanwhile (a revision, a person's step) is refused, and the agent reads it again.
    const done = await giveByMessage(app, {
      orderId: order.id, messageRef: step.messageRef, at: step.at, purchaseIds: deliveryPurchases, states: STEP_FROM.given, version: order.version, actor, now,
    });
    if (done === null) throw new ConflictError("The order changed while its delivery was checked: read it again", { reason: "version_changed" });
    return {
      order: await agentOrderOf(app, scope, (await findCustomOrder(app.db, order.id))!, now),
      outcome: done.given || done.payments > 0 ? "changed" as const : "unchanged" as const, event: null,
    };
  }
  if (!STEP_FROM[step.action].includes(order.state) && step.action === "revision") {
    // Recorded once already (a repeat after the order moved on): nothing new.
    return unchanged();
  }
  // A message step says which event it names and whether the hub keeps it: a sender checks that, not the status; a card's
  // author, what it did to the taker.
  const report: { event: CustomEventResult | null; taker?: CustomTakerResult } = { event: null };
  const changed = await applyCustomStep(app, { orderId: order.id, step, actor, viewer: null, now, report });
  return {
    order: await agentOrderOf(app, scope, (await findCustomOrder(app.db, order.id))!, now),
    outcome: changed ? "changed" as const : "unchanged" as const,
    event: report.event,
    ...(report.taker === undefined || step.action === "accepted_by" ? {} : { taker: report.taker }),
  };
}

/**
 * The person an agent acts for on their word, and where they asked: a living login of the key's realm, as a full session
 * of theirs would read (`principalOfLogin`) — the board's rules then give the agent no more than that person has.
 */
async function onWordOf(app: AppContext, scope: AgentCustomScope, body: { onBehalfOf: string; requestRef: string }): Promise<{ person: HumanAuthPrincipal; requestRef: string }> {
  const userId = await personOf(app, body.onBehalfOf);
  const person = await principalOfLogin(app, userId);
  // A test key acts for the test team's people alone, a live one for the live agency's.
  if (person === null || (person.sandbox?.test === true) !== isTestAgent(scope.principal)) {
    throw new ConflictError(`No living person "${body.onBehalfOf}"`, { reason: "person_unknown" });
  }
  return { person, requestRef: parseTelegramRef(body.requestRef)! };
}

/**
 * A finding answered on a person's word: the board's own answer (findings.ts `actOnCustomFindingAs`) as that person —
 * the check's leader of its page, the customs lead, the owner; any other reads it as not found. A finding off the key's
 * pages is not found either.
 */
export async function agentActOnCustomFinding(app: AppContext, scope: AgentCustomScope, findingId: string, body: AgentCustomFindingActBody, now: Date = new Date()) {
  if (!scope.texts) throw capabilityMissing("read:messages");
  const { person, requestRef } = await onWordOf(app, scope, body);
  return actOnCustomFindingAs(app, {
    person, findingId, body: body.step, now, requestRef,
    actor: { door: "api", agentKeyId: scope.principal.agentKeyId, onBehalfOfUserId: person.user.id },
    pageIds: scope.pages.map((page) => page.id), noPage: !isTestAgent(scope.principal),
  });
}

/** At most this many events per call of the change feed. */
const EVENTS_MAX = 200;

/**
 * What changed on the key's orders and findings after the cursor, the oldest first (the history, `object_events`): the
 * order's code or the finding, the event, who (a person by name and login, or the key), on whose word, the changes.
 */
export async function agentCustomEvents(app: AgentApp, scope: AgentCustomScope, query: AgentCustomEventsQuery, now: Date = new Date()): Promise<AgentCustomEventsResponse> {
  if (!scope.texts) throw capabilityMissing("read:messages");
  const rows = await listCustomEventsAfter(app.db, {
    after: query.after, pageIds: scope.pages.map((page) => page.id), noPage: !isTestAgent(scope.principal), limit: Math.min(query.limit, EVENTS_MAX),
  });
  return {
    events: rows.map((row) => ({
      id: row.id, at: row.at.toISOString(), object: row.objectType, code: row.orderId === null ? null : customOrderCode(row.orderId), findingId: row.findingId,
      event: row.event, door: row.door, actor: row.actor, agentKey: row.agentKey, onBehalfOf: row.onBehalfOf, changes: row.changes,
    })),
    next: rows.at(-1)?.id ?? query.after,
    serverNow: now.toISOString(),
  };
}

/**
 * The cards no order has: the ones that do belong to an order are answered, the rest become the lead's findings (or
 * matters, with the switch off). A card names no page — it is the live agency's: the test realm's key hears only its
 * own orders' cards and writes nothing for the rest.
 */
export async function agentReportCustomCards(app: Pick<AppContext, "db" | "logger" | "config">, scope: AgentCustomScope, body: AgentCustomCardsBody, now: Date = new Date()) {
  const cards = body.cards.map((card) => ({ ...card, telegramRef: parseTelegramRef(card.telegramRef)! }));
  const owners = await listCustomOrderCardOwners(app.db, cards.map((card) => card.telegramRef));
  // A card's order is named only when it is the key's (its pages, its realm); one of another's is answered as neither.
  const own = new Set((await listCustomOrdersByIds(app.db, [...new Set(owners.values())])).filter((order) => inGrant(scope, order)).map((order) => order.id));
  const matched = [...owners].filter(([, orderId]) => own.has(orderId)).map(([telegramRef, orderId]) => ({ telegramRef, code: `K-${orderId}` }));
  if (isTestAgent(scope.principal)) return { matched, opened: 0, closed: 0 };
  const unmatched = cards.filter((card) => !owners.has(card.telegramRef));
  const { opened, closed } = await reportUnmatchedCards(app, { cards: unmatched, complete: body.complete, agentKeyId: scope.principal.agentKeyId }, now);
  return { matched, opened, closed };
}
