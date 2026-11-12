import { customOrderCode, type CustomOrderCheckKind } from "@agency_hub_core/contracts";
import {
  closeMatter,
  listCustomLookalikeSales,
  listCustomOrderCardOwners,
  listCustomOrdersInStates,
  listOnShiftUsersByPage,
  listOpenMattersOfKinds,
  listUsersWithPersonRight,
  matterChanges,
  openMatter,
  touchMatters,
  type CustomLookalikeRow,
  type CustomOrderRow,
  type MatterActor,
  type MatterOpenInput,
  type MatterOwner,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { ensureQueueCreated, type QueueCreationClient } from "../sync-queue.ts";
import { applyCustomStep } from "./index.ts";
import { customsLeadOwner } from "./readers.ts";
import { deadlinePassed, dottedDay } from "./rules.ts";

/**
 * Заказ кастома, the checks (ecosystem plan §6; one writer per kind — this
 * pass, Hub's server): every five minutes it reads the orders and the sales and
 * makes the matters what they say, and closes those whose cause is gone.
 *
 *   custom.not_at_model      paid or recorded and not at the model for 24 h, or the model refused it 12 h ago and
 *                            nobody moved it since → the lead (deadline or not: such an order waits for no one else)
 *   custom.overdue           the deadline's day is over and it is not shot → the lead;
 *   custom.overdue_owner     the same day one line for the owner, with the count
 *   custom.shot_not_given    shot and not given for 12 h → the chatter who accepted it
 *   custom.give_on_shift     … and the person on shift on its page
 *   custom.unrecorded        a tier that includes a custom, or a tip whose note says so, with no order a day
 *                            later → the chatter who led the chat when they record customs, else the lead (an
 *                            order or «не кастом» closes it)
 *   custom.card_without_order a Telegram card no order has (the reader of the models' groups reports it) → the lead
 *
 * A chatter gets a matter only with the right «записывает кастомы в системе» (records_customs, off by default):
 * the obligation is a background check, never a blocker, and it starts per person; until then the lead gets the
 * chatter's findings, so every finding waits for someone. Without a lead the lead's
 * matters are the team leads' role's. The pass also closes an order given 72 hours ago with no revision: the
 * system never closes an order that was not given. Database only.
 */

export const CUSTOM_CHECKS_QUEUE = "custom-orders.checks";
const HOUR_MS = 3_600_000;
/** Paid (or recorded) and not at the model this long → the lead. */
const NOT_AT_MODEL_HOURS = 24;
/** The model refused and nobody moved the order since (another model, a cancel) this long → the lead. */
const REFUSED_HOURS = 12;
/** Shot and not given this long → the chatter. */
const NOT_GIVEN_HOURS = 12;
/** A sale that looks like a custom gets its order within this long, or a matter. */
const UNRECORDED_HOURS = 24;
/** … looked for this far back. */
const UNRECORDED_DAYS = 7;
/** Given and no revision this long → closed by itself. */
export const AUTO_CLOSE_HOURS = 72;

const SYSTEM: MatterActor = { door: "system" };

interface Finding {
  key: string;
  title: string;
  object: { type: string; id: string } | null;
  pageIds: number[];
  owner: MatterOwner;
  evidence: Record<string, unknown>;
  link: string;
}

const orderObject = (order: CustomOrderRow) => ({ type: "custom_order", id: String(order.id) });
const orderLink = (order: CustomOrderRow) => `/workboard/customs/${customOrderCode(order.id)}`;
const pageOf = (order: CustomOrderRow) => order.pageLabel ?? "страница не подтверждена";

/** The findings of every order kind from the orders, pure: the rules above. */
export function orderFindings(input: {
  orders: readonly CustomOrderRow[];
  now: Date;
  lead: MatterOwner;
  /** The people with records_customs. */
  recorders: ReadonlySet<number>;
  /** Who is on a shift now, by page label. */
  onShift: ReadonlyMap<string, readonly number[]>;
}): Record<"custom.not_at_model" | "custom.overdue" | "custom.overdue_owner" | "custom.shot_not_given" | "custom.give_on_shift", Finding[]> {
  const { now, lead } = input;
  const out = {
    "custom.not_at_model": [] as Finding[],
    "custom.overdue": [] as Finding[],
    "custom.overdue_owner": [] as Finding[],
    "custom.shot_not_given": [] as Finding[],
    "custom.give_on_shift": [] as Finding[],
  };
  const overdue: CustomOrderRow[] = [];
  for (const order of input.orders) {
    const code = customOrderCode(order.id);
    const pageIds = order.pageId === null ? [] : [order.pageId];
    const since = now.getTime() - order.stateAt.getTime();
    const waitsAtStart = (order.state === "paid" || order.state === "recorded") && since >= NOT_AT_MODEL_HOURS * HOUR_MS;
    const refusedLong = order.state === "refused" && since >= REFUSED_HOURS * HOUR_MS;
    if (waitsAtStart || refusedLong) {
      const title = order.state === "refused"
        ? `Кастом ${code}: отказ модели, решите, что дальше: ${pageOf(order)}`
        : `Кастом ${code} ${order.state === "paid" ? "оплачен" : "записан"} и сутки не у модели: ${pageOf(order)}`;
      out["custom.not_at_model"].push({
        key: `custom.not_at_model:${code}`, title,
        object: orderObject(order), pageIds, owner: lead, evidence: { code, state: order.state, since: order.stateAt.toISOString() }, link: orderLink(order),
      });
    }
    if (["recorded", "paid", "at_model", "partly", "revision"].includes(order.state) && deadlinePassed(order.deadlineOn, now)) {
      overdue.push(order);
      out["custom.overdue"].push({
        key: `custom.overdue:${code}`, title: `Кастом ${code} просрочен: срок был ${dottedDay(order.deadlineOn!)}, ${pageOf(order)}`,
        object: orderObject(order), pageIds, owner: lead, evidence: { code, deadlineOn: order.deadlineOn, state: order.state }, link: orderLink(order),
      });
    }
    if (order.state === "shot" && since >= NOT_GIVEN_HOURS * HOUR_MS) {
      const acceptor = order.acceptedByUserId !== null && input.recorders.has(order.acceptedByUserId) ? order.acceptedByUserId : null;
      const evidence = { code, shotAt: order.stateAt.toISOString() };
      const title = `Кастом ${code} снят, отдайте фану: ${pageOf(order)}`;
      out["custom.shot_not_given"].push({
        key: `custom.shot_not_given:${code}`, title, object: orderObject(order), pageIds,
        // An order nobody accepted (imported) or a chatter without the right: the lead hands it over.
        owner: acceptor === null ? lead : { userId: acceptor }, evidence, link: orderLink(order),
      });
      const onShift = (order.pageLabel === null ? [] : input.onShift.get(order.pageLabel) ?? [])
        .find((userId) => userId !== acceptor && input.recorders.has(userId));
      if (onShift !== undefined) {
        out["custom.give_on_shift"].push({ key: `custom.give_on_shift:${code}`, title, object: orderObject(order), pageIds, owner: { userId: onShift }, evidence, link: orderLink(order) });
      }
    }
  }
  if (overdue.length > 0) {
    const codes = overdue.map((order) => customOrderCode(order.id));
    out["custom.overdue_owner"].push({
      key: "custom.overdue_owner:all",
      title: `Кастомы просрочены: ${overdue.length}`,
      object: null,
      pageIds: [],
      owner: { role: "owner" },
      evidence: { count: overdue.length, codes: codes.slice(0, 50) },
      link: "/workboard/customs",
    });
  }
  return out;
}

/** A sale that looks like a custom and has no order a day later, pure: one matter per sale. */
export function unrecordedFindings(input: { sales: readonly CustomLookalikeRow[]; recorders: ReadonlySet<number>; lead: MatterOwner }): Finding[] {
  const out: Finding[] = [];
  for (const sale of input.sales) {
    // The chatter who led the chat when they record customs; else the lead — nobody else would see it.
    const chatter = sale.ledByUserIds.find((userId) => input.recorders.has(userId));
    const owner: MatterOwner = chatter === undefined ? input.lead : { userId: chatter };
    out.push({
      key: `custom.unrecorded:${sale.transactionId}`,
      title: `Похоже на кастом без заказа: ${sale.kind === "tier" ? "тир с кастомом" : "чаевые с запиской про кастом"}, ${sale.pageLabel}`,
      object: { type: "transaction", id: String(sale.transactionId) },
      pageIds: [sale.pageId],
      owner,
      evidence: { transactionId: sale.transactionId, kind: sale.kind, at: sale.at.toISOString() },
      link: `/workboard/customs?sale=${sale.transactionId}`,
    });
  }
  return out;
}

/** Makes the server's matters of `kind` what the findings say: open or update them, close the rest (cause gone). */
async function reconcile(app: Pick<AppContext, "db" | "logger">, kind: CustomOrderCheckKind, findings: readonly Finding[], now: Date, keep?: (key: string) => boolean) {
  const open = new Map((await listOpenMattersOfKinds(app.db, [kind])).map((matter) => [matter.key, matter]));
  const seen = new Set<string>();
  const touched: string[] = [];
  let opened = 0;
  let closed = 0;
  for (const finding of findings) {
    if (seen.has(finding.key)) continue;
    seen.add(finding.key);
    const input: MatterOpenInput = {
      key: finding.key, kind, source: "server", title: finding.title.slice(0, 300), object: finding.object, pageIds: finding.pageIds,
      owner: finding.owner, money: false, evidence: finding.evidence, link: finding.link,
    };
    const existing = open.get(finding.key);
    if (existing !== undefined && matterChanges(existing, input).length === 0) {
      touched.push(finding.key);
      continue;
    }
    try {
      const result = await openMatter(app.db, input, SYSTEM, now);
      if (result.transition === "opened" || result.transition === "reopened") opened += 1;
    } catch (error) {
      app.logger.error({ err: error, kind, key: finding.key }, "custom checks: a matter could not be opened");
    }
  }
  for (const key of open.keys()) {
    if (seen.has(key) || keep?.(key)) continue;
    try {
      if ((await closeMatter(app.db, { key, how: "cause_gone", writer: "server" }, SYSTEM, now)).transition === "closed") closed += 1;
    } catch (error) {
      app.logger.error({ err: error, kind, key }, "custom checks: a matter could not be closed");
    }
  }
  await touchMatters(app.db, touched, now);
  return { opened, closed };
}

const CARD_KIND = "custom.card_without_order";
const cardKey = (ref: string) => `${CARD_KIND}:${ref}`;

/**
 * The reader's report of cards no order has: each becomes the lead's matter. With `complete`, the open ones not
 * in the list are gone (closed); a card attached to an order closes its matter on the next pass.
 */
export async function reportUnmatchedCards(
  app: Pick<AppContext, "db" | "logger">,
  input: { cards: ReadonlyArray<{ telegramRef: string; postedAt?: string | undefined; where?: string | undefined }>; complete: boolean; agentKeyId: number },
  now: Date,
): Promise<{ opened: number; closed: number }> {
  const lead = await customsLeadOwner(app);
  const findings: Finding[] = input.cards.map((card) => ({
    key: cardKey(card.telegramRef),
    title: `Карточка кастома без заказа${card.where ? `: ${card.where}` : ""}`,
    object: { type: "telegram_message", id: card.telegramRef },
    pageIds: [],
    owner: lead,
    evidence: { telegramRef: card.telegramRef, ...(card.postedAt ? { postedAt: card.postedAt } : {}), reportedByKey: input.agentKeyId },
    link: `/workboard/customs?card=${encodeURIComponent(card.telegramRef)}`,
  }));
  if (input.complete) return reconcile(app, CARD_KIND, findings, now);
  // Not the whole list: only open or refresh what was named.
  return reconcile(app, CARD_KIND, findings, now, () => true);
}

export interface CustomChecksTally {
  opened: number;
  closed: number;
  autoClosed: number;
}

/** One pass of the checks; a kind whose read fails is logged and left as it was. */
export async function runCustomOrderChecks(app: Pick<AppContext, "db" | "logger">, now: Date = new Date()): Promise<CustomChecksTally> {
  const tally: CustomChecksTally = { opened: 0, closed: 0, autoClosed: 0 };
  const add = (done: { opened: number; closed: number }) => {
    tally.opened += done.opened;
    tally.closed += done.closed;
  };
  const [lead, recorderRows, onShift] = await Promise.all([
    customsLeadOwner(app),
    listUsersWithPersonRight(app.db, "records_customs"),
    listOnShiftUsersByPage(app.db, now),
  ]);
  const recorders = new Set(recorderRows.map((row) => row.userId));

  // Given and quiet for three days: closed by itself (a revision moves it out of «given» first).
  for (const order of await listCustomOrdersInStates(app.db, ["given"])) {
    if (order.givenAt !== null && now.getTime() - order.givenAt.getTime() >= AUTO_CLOSE_HOURS * HOUR_MS) {
      try {
        if (await applyCustomStep(app, { orderId: order.id, step: { action: "close" }, actor: { door: "system" }, viewer: null, now })) tally.autoClosed += 1;
      } catch (error) {
        app.logger.error({ err: error, orderId: order.id }, "custom checks: a given order could not be closed");
      }
    }
  }

  const orders = await listCustomOrdersInStates(app.db, ["recorded", "paid", "at_model", "partly", "shot", "revision", "refused"]);
  const findings = orderFindings({ orders, now, lead, recorders, onShift });
  for (const kind of Object.keys(findings) as Array<keyof typeof findings>) add(await reconcile(app, kind, findings[kind], now));

  // A sale that looks like a custom, a day old and still without an order: its chatter's with the right, else the lead's.
  const sales = await listCustomLookalikeSales(app.db, {
    from: new Date(now.getTime() - UNRECORDED_DAYS * 24 * HOUR_MS), to: new Date(now.getTime() - UNRECORDED_HOURS * HOUR_MS), limit: 500,
  });
  add(await reconcile(app, "custom.unrecorded", unrecordedFindings({ sales, recorders, lead }), now));

  // A reported card that now belongs to an order: its matter closes (the cause is gone).
  const cardMatters = await listOpenMattersOfKinds(app.db, [CARD_KIND]);
  if (cardMatters.length > 0) {
    const refs = cardMatters.map((matter) => matter.key.slice(CARD_KIND.length + 1));
    const owners = await listCustomOrderCardOwners(app.db, refs);
    for (const matter of cardMatters) {
      if (!owners.has(matter.key.slice(CARD_KIND.length + 1))) continue;
      try {
        if ((await closeMatter(app.db, { key: matter.key, how: "cause_gone", writer: "server" }, SYSTEM, now)).transition === "closed") tally.closed += 1;
      } catch (error) {
        app.logger.error({ err: error, key: matter.key }, "custom checks: a card matter could not be closed");
      }
    }
  }
  return tally;
}

export async function ensureCustomChecksQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, CUSTOM_CHECKS_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensureCustomChecksSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) return;
  await boss.schedule(CUSTOM_CHECKS_QUEUE, "*/5 * * * *", null, { tz: "UTC" });
}
