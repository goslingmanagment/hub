import { SHIFT_REVIEW_DELETED_UNSEEN_SECONDS } from "@agency_hub_core/contracts";
import {
  bumpCustomOrder,
  clearCustomOrderWaitMarks,
  findCustomOrder,
  findCustomPageReplyAfter,
  insertCustomOrderEvent,
  listCustomFileSends,
  listCustomOrderEvidenceFloors,
  listCustomOrderNamedFiles,
  listCustomOrderRejectedRefs,
  listPersonFans,
  lockCustomOrder,
  setCustomOrderDefaultDeadline,
  setCustomOrderSent,
  type CustomFileSendRow,
  type CustomOrderFileRow,
  type CustomOrderRow,
  type CustomOrderStateRow,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { ConflictError } from "../errors.ts";
import { applyCustomStep, type CustomActor } from "./index.ts";
import { moscowDay } from "./rules.ts";

/**
 * Заказ кастома, what the checks pass settles by itself (customs facts spec §6, §7, C2; behind the switch `customsFacts`):
 *
 *   the exact «given»   the order's files are the vault files of its model's pages named with its code (`…_K-<id>_…`)
 *                       that appeared after its last revision request; a copy of a file on another page of the model
 *                       (named the same, to resell it) is that file. A file is delivered when a page's message carried
 *                       one of its copies to the order's fan (any account of the person) after the order was recorded,
 *                       its last revision request and a person's last «не отдан» — free, or priced and bought (the one
 *                       rule, `ppvBoughtSql`). Every file delivered → the step «отдан» (door system) with the last such
 *                       message and its time, and every purchase of a bought message linked as the order's payment in
 *                       the same transaction. Every file sent and a priced one not bought → «отправлен, фан не открыл»
 *                       (`sent_at`), no step. The same file sent to another fan means nothing: customs are resold. What
 *                       a person took off the order (`custom_order_rejections`) is never evidence again.
 *   the default deadline  an order with no deadline a day after it was recorded gets max(first payment, recorded) + 7
 *                       days, «примерно» (`deadline_default`), never one of the person's fields — and never again once a
 *                       person took the deadline off (it is theirs then).
 *   the fan's ask       answered: the page wrote to the fan after his «where is it» — the ask is off the order.
 */

type DeliveryApp = Pick<AppContext, "db" | "logger">;

/**
 * The states a delivery found by the files settles: shot, and the ones where the reader missed a delivery. Never «сдан
 * частично»: the files there are the part that is ready, and the order is not whole yet.
 */
export const EXACT_GIVEN_STATES: readonly CustomOrderStateRow[] = ["at_model", "shot", "revision"];
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** An order with no deadline this long after its record gets the default one. */
const DEFAULT_DEADLINE_AFTER_HOURS = 24;
const DEFAULT_DEADLINE_DAYS = 7;

/** What the files and their sends say about an order. */
export type CustomDeliveryVerdict =
  | { kind: "given"; messageRef: string; at: Date; purchaseIds: number[] }
  | { kind: "sent"; messageRef: string; at: Date }
  | { kind: "none" };

const latest = (sends: readonly CustomFileSendRow[]) => sends.reduce((last, send) => (send.at.getTime() >= last.at.getTime() ? send : last));

/**
 * The verdict of an order's files and the messages that carried them to its fan, pure: every file delivered (its first
 * free or bought message, its own or a copy's) → given by the last of those, with the purchases of every bought send of
 * them (a file sent free first and bought after still pays the order); every file sent but some only priced and not
 * bought → sent by the last message that carried one; else nothing. A copy of a file is a file of the same name on
 * another page of the model (resold there) — only while that name is one file on each page: several originals of one
 * name on a page are not told apart, and none of them stands in for another. Two files of one page are two files. A
 * message named in `rejected` is no evidence at all.
 */
export function deliveryVerdictOf(
  files: ReadonlyArray<Pick<CustomOrderFileRow, "pageId" | "mediaRef"> & { name?: string }>,
  sends: readonly CustomFileSendRow[],
  rejected: ReadonlySet<string>,
): CustomDeliveryVerdict {
  if (files.length === 0) return { kind: "none" };
  const usable = sends.filter((send) => !rejected.has(send.messageRef)).sort((left, right) => left.at.getTime() - right.at.getTime());
  const keyOf = (one: { pageId: number; mediaRef: string }) => `${one.pageId}:${one.mediaRef}`;
  const onPage = new Map<string, number>();
  for (const file of files) if (file.name !== undefined) onPage.set(`${file.pageId}:${file.name}`, (onPage.get(`${file.pageId}:${file.name}`) ?? 0) + 1);
  const ambiguous = new Set(files.filter((file) => file.name !== undefined && (onPage.get(`${file.pageId}:${file.name}`) ?? 0) > 1).map((file) => file.name!));
  const delivering: CustomFileSendRow[] = [];
  const carrying: CustomFileSendRow[] = [];
  const purchases = new Set<number>();
  for (const file of files) {
    const others = file.name === undefined || ambiguous.has(file.name) ? [] : files.filter((other) => other.name === file.name && other.pageId !== file.pageId);
    const copies = new Set([file, ...others].map(keyOf));
    const sent = usable.filter((send) => copies.has(keyOf(send)));
    if (sent.length === 0) return { kind: "none" };
    carrying.push(sent[0]!);
    const delivered = sent.find((send) => !send.priced || send.bought);
    if (delivered !== undefined) delivering.push(delivered);
    for (const send of sent) if (send.priced && send.bought) for (const id of send.purchaseIds) purchases.add(id);
  }
  if (delivering.length === files.length) {
    const last = latest(delivering);
    return { kind: "given", messageRef: last.messageRef, at: last.at, purchaseIds: [...purchases] };
  }
  const last = latest(carrying);
  return { kind: "sent", messageRef: last.messageRef, at: last.at };
}

export interface CustomDeliveryTally {
  given: number;
  sent: number;
  payments: number;
}

/**
 * The exact «given» over the orders in `EXACT_GIVEN_STATES` with a page and a fan (the pass's list): from the few
 * code-named files of these orders, never a scan of the messages. One order that fails is logged and left.
 */
export async function settleCustomDeliveries(app: DeliveryApp, orders: readonly CustomOrderRow[], now: Date): Promise<CustomDeliveryTally> {
  const tally: CustomDeliveryTally = { given: 0, sent: 0, payments: 0 };
  const candidates = orders.filter((order) => EXACT_GIVEN_STATES.includes(order.state) && order.pageId !== null && order.fanId !== null);
  if (candidates.length === 0) return tally;
  const [files, floors] = await Promise.all([
    listCustomOrderNamedFiles(app.db, candidates.map((order) => order.id)),
    listCustomOrderEvidenceFloors(app.db, candidates.map((order) => order.id)),
  ]);
  const byOrder = new Map<number, CustomOrderFileRow[]>();
  for (const file of files) byOrder.set(file.orderId, [...(byOrder.get(file.orderId) ?? []), file]);
  for (const order of candidates) {
    try {
      const own = byOrder.get(order.id) ?? [];
      if (own.length === 0) {
        // No file of this round (none named yet, or a revision sent the named ones back): nothing was sent of it.
        if (order.sentAt !== null && (await markSent(app, order.id, null, now, order.version))) tally.sent += 1;
        continue;
      }
      const fanIds = (await listPersonFans(app.db, order.fanId!)).map((fan) => fan.id);
      // A message of before the last revision request or a person's «не отдан» is not this round's delivery.
      const floor = floors.get(order.id);
      const since = floor !== undefined && floor.getTime() > order.createdAt.getTime() ? floor : order.createdAt;
      const [sends, rejected] = await Promise.all([
        listCustomFileSends(app.db, { files: own, fanIds, since, unseenSeconds: SHIFT_REVIEW_DELETED_UNSEEN_SECONDS }),
        listCustomOrderRejectedRefs(app.db, order.id),
      ]);
      const verdict = deliveryVerdictOf(own, sends, rejected.given);
      if (verdict.kind === "given") {
        // Written only on the order as it was read: a revision or a person's step meanwhile leaves it to the next pass.
        const done = await giveByMessage(app, {
          orderId: order.id, messageRef: verdict.messageRef, at: verdict.at, purchaseIds: verdict.purchaseIds.filter((id) => !rejected.payment.has(String(id))),
          states: EXACT_GIVEN_STATES, version: order.version, actor: SYSTEM, now,
        });
        if (done?.given === true) tally.given += 1;
        tally.payments += done?.payments ?? 0;
      } else if (await markSent(app, order.id, verdict.kind === "sent" ? { messageRef: verdict.messageRef, at: verdict.at } : null, now, order.version)) {
        tally.sent += 1;
      }
    } catch (error) {
      app.logger.error({ err: error, orderId: order.id }, "custom checks: an order's delivery could not be settled");
    }
  }
  return tally;
}

const SYSTEM: CustomActor = { door: "system" };

/**
 * «Отдан» by a message, in one transaction under the order's lock (the exact rule's, the agent's, the backfill's): the
 * purchases of the offer that carried the order linked as its payment (one another order holds, or a person took off
 * this one, is not), then the step with the message and its time; what only an order waiting for its fan holds goes.
 * Only on the order as its evidence was read (`version`) and in one of `states`: an order that moved meanwhile — a
 * revision, a person's step — answers null and nothing is written. Else whether it was given, and how many purchases.
 */
export async function giveByMessage(
  app: Pick<AppContext, "db">,
  input: {
    orderId: number; messageRef: string; at: Date; purchaseIds: readonly number[]; states: readonly CustomOrderStateRow[]; version: number;
    actor: CustomActor; now: Date;
  },
): Promise<{ given: boolean; payments: number } | null> {
  return app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    if (!(await lockCustomOrder(db, input.orderId))) return null;
    const order = (await findCustomOrder(db, input.orderId))!;
    if (order.version !== input.version || !input.states.includes(order.state)) return null;
    const payments = await linkPurchasesWithin(db, input.orderId, input.purchaseIds, input.actor, input.now);
    const given = await applyCustomStep({ db }, {
      orderId: input.orderId, step: { action: "given", messageRef: input.messageRef, at: input.at }, actor: input.actor, viewer: null, now: input.now,
    });
    if (given) await clearCustomOrderWaitMarks(db, input.orderId, input.now);
    return { given, payments };
  });
}

/**
 * The purchases of the message that gave an order, linked as its payment in one transaction under its lock: an order
 * given by that message before its purchase was linked (the agent names the message again). Answers how many.
 */
export async function linkDeliveryPurchases(
  app: Pick<AppContext, "db">,
  input: { orderId: number; purchaseIds: readonly number[]; actor: CustomActor; now: Date },
): Promise<number> {
  if (input.purchaseIds.length === 0) return 0;
  return app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    if (!(await lockCustomOrder(db, input.orderId))) return 0;
    return linkPurchasesWithin(db, input.orderId, input.purchaseIds, input.actor, input.now);
  });
}

/** Each purchase by the payment step, a savepoint of its own: one another order holds or a person took off is left out. */
async function linkPurchasesWithin(db: Database, orderId: number, purchaseIds: readonly number[], actor: CustomActor, now: Date): Promise<number> {
  let linked = 0;
  for (const transactionId of purchaseIds) {
    try {
      if (await applyCustomStep({ db }, { orderId, step: { action: "payment", transactionId }, actor, viewer: null, now })) linked += 1;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    }
  }
  return linked;
}

/**
 * «Отправлен, фан не открыл» set to `sent` (null clears it), with its line in the order's history, on the order as it was
 * read (`version`). Answers whether it changed.
 */
async function markSent(app: DeliveryApp, orderId: number, sent: { messageRef: string; at: Date } | null, now: Date, version: number): Promise<boolean> {
  return app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    if (!(await lockCustomOrder(db, orderId))) return false;
    const order = (await findCustomOrder(db, orderId))!;
    if (order.version !== version || !EXACT_GIVEN_STATES.includes(order.state)) return false;
    if (!(await setCustomOrderSent(db, orderId, sent, now))) return false;
    await insertCustomOrderEvent(db, {
      orderId, event: "custom_order.sent", door: "system",
      changes: sent === null ? { cleared: true } : { messageRef: sent.messageRef, sentAt: sent.at.toISOString() }, at: now,
    });
    await bumpCustomOrder(db, orderId, now);
    return true;
  });
}

/** The default deadline's day (C2): the later of the first payment and the record, plus seven days, in Moscow. */
export function defaultDeadlineOf(order: Pick<CustomOrderRow, "createdAt" | "firstPaidAt">): string {
  const from = Math.max(order.createdAt.getTime(), order.firstPaidAt?.getTime() ?? 0);
  return moscowDay(new Date(from + DEFAULT_DEADLINE_DAYS * DAY_MS));
}

/**
 * The default deadline (C2) of every open order with none a day after it was recorded: «примерно», with its line in the
 * order's history (`approximate`, as the deadline step writes the system's). Never on an order whose deadline a person
 * set — taking it off included: the empty deadline is theirs. Answers how many were set.
 */
export async function setDefaultDeadlines(app: DeliveryApp, orders: readonly CustomOrderRow[], now: Date): Promise<number> {
  let set = 0;
  for (const order of orders) {
    if (order.deadlineOn !== null || order.personFields.includes("deadlineOn")) continue;
    if (now.getTime() - order.createdAt.getTime() < DEFAULT_DEADLINE_AFTER_HOURS * HOUR_MS) continue;
    const day = defaultDeadlineOf(order);
    try {
      const changed = await app.db.transaction(async (tx) => {
        const db = tx as unknown as Database;
        if (!(await lockCustomOrder(db, order.id))) return false;
        if (!(await setCustomOrderDefaultDeadline(db, order.id, day, now))) return false;
        await insertCustomOrderEvent(db, { orderId: order.id, event: "custom_order.deadline", door: "system", changes: { from: null, to: day, approximate: true }, at: now });
        await bumpCustomOrder(db, order.id, now);
        return true;
      });
      if (changed) set += 1;
    } catch (error) {
      app.logger.error({ err: error, orderId: order.id }, "custom checks: an order's default deadline could not be set");
    }
  }
  return set;
}

/**
 * The fan's «where is it» answered (customs facts spec §7): every order whose ask stands and whose page wrote to the fan
 * (any account of the person) after it loses the ask, by the system's step with that message. Answers how many.
 */
export async function clearAnsweredAsks(app: DeliveryApp, orders: readonly CustomOrderRow[], now: Date): Promise<number> {
  let cleared = 0;
  for (const order of orders) {
    if (order.fanAskedAt === null || order.pageId === null || order.fanId === null) continue;
    try {
      const fanIds = (await listPersonFans(app.db, order.fanId)).map((fan) => fan.id);
      const reply = await findCustomPageReplyAfter(app.db, { pageId: order.pageId, fanIds, after: order.fanAskedAt });
      if (reply === null) continue;
      const step = { action: "fan_asked_clear" as const, messageRef: reply.messageRef, at: reply.at };
      if (await applyCustomStep(app, { orderId: order.id, step, actor: SYSTEM, viewer: null, now })) cleared += 1;
    } catch (error) {
      app.logger.error({ err: error, orderId: order.id }, "custom checks: an order's answered ask could not be cleared");
    }
  }
  return cleared;
}
