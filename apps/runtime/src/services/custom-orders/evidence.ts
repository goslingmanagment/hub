import type { AgentCustomSaleRefusal, AgentSaleRequest } from "@agency_hub_core/contracts";
import {
  findCustomPageMessage,
  findTransactionIdsByPlatformRef,
  hasCustomOrderRejection,
  listCustomMessagePurchases,
  listCustomModelPages,
  listCustomOrderEvidenceFloors,
  listCustomOrderNamedFiles,
  listCustomSaleFacts,
  listPersonFans,
  type CustomOrderRow,
  type Database,
} from "@agency_hub_core/db";

import { AppError, ConflictError } from "../errors.ts";
import { CUSTOM_PAYING_KINDS } from "./index.ts";

/**
 * What an agent names for a custom order — a sale that pays it, the page's message that gave it, the fan's message
 * «where is it» — checked against what Hub holds before a step takes it (customs facts spec §5, §6, §11). The agent
 * points at a fact Hub has; it never states one. Every page it names is one of the key's pages (another answers as
 * not found), and of the order's model.
 */

export interface EvidenceScope {
  /** The key's granted pages, with their model. */
  pages: ReadonlyArray<{ id: number; pageLabel: string; platform: string; modelSlug: string }>;
}

/** The plane's one 404: missing and out of grant are the same bytes. */
const notFound = () => new AppError("Not found", 404, "not_found");

/** The key's pages of the order's model; none when the order names no page. */
export function modelPagesOf(scope: EvidenceScope, order: Pick<CustomOrderRow, "pageId" | "modelSlug">): number[] {
  if (order.pageId === null || order.modelSlug === null) return [];
  return scope.pages.filter((page) => page.modelSlug === order.modelSlug).map((page) => page.id);
}

/** The person's accounts: the order's fan and the accounts joined to him. */
async function personFanIdsOf(db: Database, fanId: number | null): Promise<Set<number>> {
  return new Set(fanId === null ? [] : (await listPersonFans(db, fanId)).map((fan) => fan.id));
}

const PAYING_KINDS: ReadonlySet<string> = new Set<string>(CUSTOM_PAYING_KINDS);

export interface NamedSale {
  sale: AgentSaleRequest;
  /** Hub's id of the sale; null — not found on the key's pages (or not looked for). */
  transactionId: number | null;
  /** ok — it may pay the order; already — it does; else why not. */
  verdict: "ok" | "already" | AgentCustomSaleRefusal;
}

/**
 * The named sales against the order (spec §5): the key holds `read:money`; the sale is on one of the key's pages, a
 * page of the order's model; it is an account's of the order's fan (`listPersonFans`); a tip, a subscription or a
 * message purchase that counts; held by no other order; not taken back by the platform; not taken off this order by a
 * person. Answers each, in the order named.
 */
export async function checkNamedSales(
  db: Database,
  scope: EvidenceScope,
  order: CustomOrderRow,
  sales: readonly AgentSaleRequest[],
  money: boolean,
): Promise<NamedSale[]> {
  if (!money) return sales.map((sale) => ({ sale, transactionId: null, verdict: "capability_missing" }));
  const byLabel = new Map(scope.pages.map((page) => [page.pageLabel, page.id]));
  const keyPages = new Set(scope.pages.map((page) => page.id));
  const platformIds = await findTransactionIdsByPlatformRef(db, sales.flatMap((sale) => {
    if (!("transactionRef" in sale)) return [];
    const pageId = byLabel.get(sale.pageLabel);
    return pageId === undefined ? [] : [{ pageId, transactionRef: sale.transactionRef }];
  }));
  const idOf = (sale: AgentSaleRequest): number | null => {
    if ("saleRef" in sale) {
      const id = Number(sale.saleRef);
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    }
    const pageId = byLabel.get(sale.pageLabel);
    return pageId === undefined ? null : platformIds.get(`${pageId}:${sale.transactionRef}`) ?? null;
  };
  const ids = sales.map(idOf);
  const facts = await listCustomSaleFacts(db, { orderId: order.id, transactionIds: ids.filter((id): id is number => id !== null) });
  const modelPages = new Set(modelPagesOf(scope, order));
  const fans = await personFanIdsOf(db, order.fanId);
  return sales.map((sale, index) => {
    const id = ids[index] ?? null;
    const fact = id === null ? undefined : facts.get(id);
    // A sale of a page outside the key's: the same as none.
    if (fact === undefined || !keyPages.has(fact.pageId)) return { sale, transactionId: null, verdict: "not_found" };
    const verdict = ((): NamedSale["verdict"] => {
      if (order.pageId === null) return "order_no_page";
      if (!modelPages.has(fact.pageId)) return "other_model";
      if (order.fanId === null) return "order_no_fan";
      if (fact.fanId === null || !fans.has(fact.fanId)) return "other_fan";
      if (!PAYING_KINDS.has(fact.kind) || !fact.live) return "wrong_kind";
      if (fact.heldBy === order.id) return "already";
      if (fact.heldBy !== null) return "taken";
      if (fact.reversed) return "reversed";
      if (fact.rejected) return "rejected";
      return "ok";
    })();
    return { sale, transactionId: fact.transactionId, verdict };
  });
}

const refused = (message: string, reason: string) => new ConflictError(message, { reason });

/**
 * A sale a person names for an order on the board's finding (findings.ts: «Записать заказ», «Это уже есть»), checked
 * as the agent's is (`checkNamedSales`): of the order's fan (any account of the person), on a page of its model, a live
 * sale of a kind that pays a custom, held by no other order, not taken back by the platform. A sale a person took off
 * this order is theirs to bring back by hand. Answers whether the order holds it already; refused with the reason.
 */
export async function checkPersonSale(db: Database, order: CustomOrderRow, transactionId: number): Promise<{ already: boolean }> {
  if (order.modelSlug === null) throw refused("The order names no page: the sale cannot be checked against it", "order_no_page");
  const pages = await listCustomModelPages(db, order.modelSlug);
  const [named] = await checkNamedSales(db, { pages }, order, [{ saleRef: String(transactionId) }], true);
  const verdict = named!.verdict;
  if (verdict === "ok" || verdict === "rejected") return { already: false };
  if (verdict === "already") return { already: true };
  // A sale of no page of the order's model reads as missing to the agent's key; to a person it is another model's.
  const reason = verdict === "not_found" ? "other_model" : verdict;
  throw refused(`The sale does not pay this order: ${reason}`, reason);
}

/**
 * The agent's «отдан» by a message (spec §6): the order names its page and fan; the message is on a page of the
 * order's model among the key's pages (else not found), sent by the page to an account of the order's fan (the chat's
 * fan, never a media offer's recipient), after the order was recorded and after its last revision request and a person's
 * last «не отдан» (a message of before them is the version sent back, or the delivery taken off), with media; a priced
 * one — its own price or an offer's — bought (`ppvBoughtSql`). Refused while the order has its code-named files (the
 * exact rule's own list, `listCustomOrderNamedFiles`: Hub finds their delivery) and for a message a person took off the
 * order. Answers the message's time and its purchases by the fan (`listCustomMessagePurchases`: the order's money by
 * construction, linked with the mark).
 */
export async function checkGivenMessage(
  db: Database,
  scope: EvidenceScope,
  order: CustomOrderRow,
  messageRef: string,
): Promise<{ at: Date; purchaseIds: number[] }> {
  if (order.pageId === null) throw refused("The order names no page: its fan's chat is not known", "order_no_page");
  if (order.fanId === null) throw refused("The order names no fan: whom the message went to cannot be checked", "order_no_fan");
  const pageIds = modelPagesOf(scope, order);
  const message = await findCustomPageMessage(db, { pageIds, messageRef });
  if (message === null) throw notFound();
  if (!message.sentByPage) throw refused("The message is the fan's, not the page's", "not_page_message");
  const fans = await personFanIdsOf(db, order.fanId);
  if (message.chatFanId === null || !fans.has(message.chatFanId)) throw refused("The message went to another fan", "other_fan");
  if (message.at === null || message.at.getTime() < order.createdAt.getTime()) throw refused("The message was sent before the order was recorded", "before_order");
  if (message.media === 0) throw refused("The message carries no media", "no_media");
  if (message.priceMills > 0 && !message.bought) throw refused("The message is priced and the fan has not bought it", "not_bought");
  if ((await listCustomOrderNamedFiles(db, [order.id])).length > 0) {
    throw refused("A vault file carries the order's code: Hub finds its delivery by itself", "code_named_file");
  }
  if (await hasCustomOrderRejection(db, { orderId: order.id, kind: "given", ref: messageRef })) {
    throw refused("A person took this message off the order", "rejected");
  }
  const floor = (await listCustomOrderEvidenceFloors(db, [order.id])).get(order.id);
  if (floor !== undefined && message.at.getTime() < floor.getTime()) {
    throw refused("The message was sent before the order's last revision or a person's «не отдан»", "before_revision");
  }
  return { at: message.at, purchaseIds: await listCustomMessagePurchases(db, { pageIds: [message.pageId], messageRef, fanIds: [...fans] }) };
}

/** The purchases of the message that gave the order (an order given by it before they were linked), of its fan. */
export async function deliveryPurchasesOf(db: Database, scope: EvidenceScope, order: CustomOrderRow, messageRef: string): Promise<number[]> {
  if (order.fanId === null) return [];
  return listCustomMessagePurchases(db, { pageIds: modelPagesOf(scope, order), messageRef, fanIds: [...(await personFanIdsOf(db, order.fanId))] });
}

/**
 * The fan's «where is it» (spec §7): his message on the order's page, in a chat of an account of the order's fan, sent
 * after the order was recorded (a message of before it asks about something else). Answers its time and the fan's
 * accounts (whether the page answered it since is the door's to ask).
 */
export async function checkFanAskedMessage(db: Database, order: CustomOrderRow, messageRef: string): Promise<{ at: Date; fanIds: number[] }> {
  if (order.pageId === null) throw refused("The order names no page: its fan's chat is not known", "order_no_page");
  if (order.fanId === null) throw refused("The order names no fan", "order_no_fan");
  const message = await findCustomPageMessage(db, { pageIds: [order.pageId], messageRef });
  if (message === null) throw notFound();
  if (message.sentByPage) throw refused("The message is the page's, not the fan's", "not_fan_message");
  const fans = await personFanIdsOf(db, order.fanId);
  if (message.chatFanId === null || !fans.has(message.chatFanId)) {
    throw refused("The message is not in the order's chat", "other_fan");
  }
  if (message.at === null) throw refused("The message's time is not known", "not_found");
  if (message.at.getTime() < order.createdAt.getTime()) throw refused("The message was sent before the order was recorded", "before_order");
  return { at: message.at, fanIds: [...fans] };
}
