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
import { applyCustomStep } from "./index.ts";
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
 * free or bought message, its own or a copy's) → given by the last of those, with every purchase of the bought ones;
 * every file sent but some only priced and not bought → sent by the last message that carried one; else nothing. A
 * copy of a file is a file of the same name on another page of the model (resold there); two files of one page are two
 * files whatever their names. A message named in `rejected` is no evidence at all.
 */
export function deliveryVerdictOf(
  files: ReadonlyArray<Pick<CustomOrderFileRow, "pageId" | "mediaRef"> & { name?: string }>,
  sends: readonly CustomFileSendRow[],
  rejected: ReadonlySet<string>,
): CustomDeliveryVerdict {
  if (files.length === 0) return { kind: "none" };
  const usable = sends.filter((send) => !rejected.has(send.messageRef)).sort((left, right) => left.at.getTime() - right.at.getTime());
  const delivering: CustomFileSendRow[] = [];
  const carrying: CustomFileSendRow[] = [];
  for (const file of files) {
    const copies = new Set([file, ...files.filter((other) => other.name !== undefined && other.name === file.name && other.pageId !== file.pageId)]
      .map((one) => `${one.pageId}:${one.mediaRef}`));
    const sent = usable.filter((send) => copies.has(`${send.pageId}:${send.mediaRef}`));
    if (sent.length === 0) return { kind: "none" };
    carrying.push(sent[0]!);
    const delivered = sent.find((send) => !send.priced || send.bought);
    if (delivered !== undefined) delivering.push(delivered);
  }
  if (delivering.length === files.length) {
    const last = latest(delivering);
    const purchaseIds = [...new Set(delivering.filter((send) => send.priced && send.bought).flatMap((send) => send.purchaseIds))];
    return { kind: "given", messageRef: last.messageRef, at: last.at, purchaseIds };
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
        if (order.sentAt !== null && (await markSent(app, order.id, null, now))) tally.sent += 1;
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
        const done = await markGiven(app, order.id, verdict, rejected.payment, now);
        if (done.given) tally.given += 1;
        tally.payments += done.payments;
      } else if (await markSent(app, order.id, verdict.kind === "sent" ? { messageRef: verdict.messageRef, at: verdict.at } : null, now)) {
        tally.sent += 1;
      }
    } catch (error) {
      app.logger.error({ err: error, orderId: order.id }, "custom checks: an order's delivery could not be settled");
    }
  }
  return tally;
}

const SYSTEM = { door: "system" as const };

/**
 * «Отдан» by the files, in one transaction: each bought message's purchase linked as the order's payment (one another
 * order holds, or a person took off this one, is not), then the step with the last delivering message and its time;
 * what only an order waiting for its fan holds goes. The order moved on meanwhile (a person's step): nothing.
 */
async function markGiven(
  app: DeliveryApp,
  orderId: number,
  verdict: Extract<CustomDeliveryVerdict, { kind: "given" }>,
  rejectedPayments: ReadonlySet<string>,
  now: Date,
): Promise<{ given: boolean; payments: number }> {
  return app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    if (!(await lockCustomOrder(db, orderId))) return { given: false, payments: 0 };
    const order = (await findCustomOrder(db, orderId))!;
    if (!EXACT_GIVEN_STATES.includes(order.state)) return { given: false, payments: 0 };
    let payments = 0;
    for (const transactionId of verdict.purchaseIds) {
      if (rejectedPayments.has(String(transactionId))) continue;
      try {
        // A savepoint of its own: a sale another order holds is refused there and leaves this transaction whole.
        if (await applyCustomStep({ db }, { orderId, step: { action: "payment", transactionId }, actor: SYSTEM, viewer: null, now })) payments += 1;
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
      }
    }
    const given = await applyCustomStep({ db }, { orderId, step: { action: "given", messageRef: verdict.messageRef, at: verdict.at }, actor: SYSTEM, viewer: null, now });
    if (given) await clearCustomOrderWaitMarks(db, orderId, now);
    return { given, payments };
  });
}

/** «Отправлен, фан не открыл» set to `sent` (null clears it), with its line in the order's history. Answers whether it changed. */
async function markSent(app: DeliveryApp, orderId: number, sent: { messageRef: string; at: Date } | null, now: Date): Promise<boolean> {
  return app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    if (!(await lockCustomOrder(db, orderId))) return false;
    const order = (await findCustomOrder(db, orderId))!;
    if (!EXACT_GIVEN_STATES.includes(order.state)) return false;
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
