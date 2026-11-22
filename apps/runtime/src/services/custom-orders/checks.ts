import { customOrderCode, type CustomGiverKind, type CustomOrderCheckKind } from "@agency_hub_core/contracts";
import {
  closeMatter,
  listClosedMattersOfKinds,
  listCustomLookalikeSales,
  listCustomOrderCardOwners,
  listCustomOrdersInStates,
  listCustomSaleFates,
  listOnShiftUsersByPage,
  listOpenMattersOfKinds,
  listUsersWithPersonRight,
  touchMatters,
  type CustomLookalikeRow,
  type CustomOrderRow,
  type CustomSaleFate,
  type MatterActor,
  type MatterCloseHow,
  type MatterOpenInput,
  type MatterOwner,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { reconcileKindMatters } from "../matters.ts";
import { ensureQueueCreated, type QueueCreationClient } from "../sync-queue.ts";
import { applyCustomStep, burnsOfRow, factsOfRow, urgencyOfRow } from "./index.ts";
import { CUSTOM_UNRECORDED_KIND, customsLeadOwner, unrecordedKey, unrecordedSaleOf } from "./readers.ts";
import { deadlinePassed, dottedDay, issueOf } from "./rules.ts";
import { customLeaderContext } from "./index.ts";
import { customMoveOf, giverOf, leaderOwner, phaseLeader } from "./leaders.ts";
import { testPageIds } from "../sandbox/realm.ts";
import { clearAnsweredAsks, setDefaultDeadlines, settleCustomDeliveries } from "./deliveries.ts";
import { findingMatters, openFindingsForMatters, reportCardFindings, retireCustomFindingMatters, writeCustomFindings } from "./findings.ts";
import { customsFactsOn } from "./switch.ts";

/**
 * Заказ кастома, the checks (ecosystem plan §6; one writer per kind — this
 * pass, Hub's server): every five minutes it reads the orders and the sales and
 * makes the matters what they say, and closes those whose cause is gone.
 *
 *   custom.not_at_model      paid or recorded and neither checked nor at the model for 24 h → the check's leader
 *                            (Workboard: the team lead, else the customs lead, else the owner)
 *   custom.checked_not_at_model  «Проверен» and not at the model for 24 h, or the model refused it 12 h ago and nobody
 *                            moved it since → the shooting's leader (ContentOps: the content manager, else the customs
 *                            lead, else the owner)
 *   custom.overdue           the deadline's day is over and it is not shot → the shooting's leader;
 *   custom.overdue_owner     the same day one line for the owner, with the count
 *   custom.shot_not_given    shot and not given for 12 h → its giver (leaders.ts `giverOf`): the order's taker (a living
 *                            login working on its page): watch the video whole and give it; with none, the check's
 *                            leader: name the taker. Whoever is on shift may give it too and is not obliged to: the
 *                            retired `custom.give_on_shift` is no longer opened, and its open ones close here
 *   custom.unrecorded        a tier that includes a custom, or a tip whose note says so, with no order a day
 *                            later → the chatter who led the chat when they record customs, else the lead. Only
 *                            what happens to the sale closes it: an order (resolved), «не кастом» (withdrawn),
 *                            the sale itself gone (cause_gone). The week the pass looks back is for finding new
 *                            sales: a matter whose sale still has neither an order nor a word stays open — and one
 *                            closed as cause_gone whose sale is there after all, still such a sale, opens again
 *   custom.card_without_order a Telegram card no order has (the reader of the models' groups reports it) → the lead
 *
 * A chatter gets an unrecorded sale's matter only with the right «записывает кастомы в системе» (records_customs, off by
 * default): the obligation is a background check, never a blocker, and it starts per person; until then the lead gets
 * the chatter's findings, so every finding waits for someone. Without a lead the lead's
 * matters are the team leads' role's. The pass also closes an order 72 hours after it was marked given with no revision
 * (from the mark, not the message's time: a delivery found late keeps a full window for undo and the fan's complaint):
 * the system never closes an order that was not given. Database only.
 *
 * With the switch `customsFacts` on (customs facts spec, C9) the pass also settles the exact «given» and the sent mark
 * from the orders' code-named files (deliveries.ts), gives an order with no deadline its default one (C2), and the
 * matters follow the facts:
 *
 *   custom.not_at_model      the forwarding timer (C3): money linked or the owner's word, not at the model for 24 h
 *                            → the check's leader («Проверен» leaves the path, C8: the shooting's matter keeps only the
 *                            model's refusal)
 *   custom.not_at_model_owner  the same 48 h: one line for the owner with the count
 *   custom.overdue, custom.shot_not_given  the board's «Горит» (`customOrderBurnsOf`, one rule): more than a full day
 *                            past the deadline; shot and nothing sent for 12 h while giving it is the move (`customMoveOf`:
 *                            not while an issue or a payment in conflict is the owner's). Never on hold, never «отправлен,
 *                            фан не открыл»
 *   custom.finding           a custom with no order (findings.ts) open a day → the check's leader of its page
 *   custom.findings_owner    open three days: one line for the owner with the count
 *
 * and `custom.unrecorded` and `custom.card_without_order` are retired into findings (findings.ts, the switch-on step)
 * and no longer written.
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
/** … a new one is looked for this far back (a matter already open is followed whatever its sale's day). */
const UNRECORDED_DAYS = 7;
/** How a matter about such a sale closes, by what became of the sale; a sale that still waits closes nothing. */
const UNRECORDED_CLOSES: Readonly<Record<CustomSaleFate, MatterCloseHow | null>> = {
  recorded: "resolved", dismissed: "withdrawn", gone: "cause_gone", waits: null,
};
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

/** Who leads customs of a page's orders: one owner for all, or by the page (its model's customs lead, then team lead). */
export type LeadOf = MatterOwner | ((pageId: number | null) => MatterOwner);
const leadFn = (lead: LeadOf) => (typeof lead === "function" ? lead : () => lead);
/** Who leads a phase of a page's order (leaders.ts, the one rule); absent — `lead` for every phase. */
export type PhaseLeadOf = (pageId: number | null, phase: "check" | "shoot") => MatterOwner;
/** Whose move an order is (leaders.ts `customMoveOf`, the board's one rule): a shot order's names its giver; null — nobody's. */
export type MoveOf = (order: CustomOrderRow, facts: ReturnType<typeof factsOfRow>) => { what: string; giver?: CustomGiverKind } | null;
/** Who gives a shot order (leaders.ts `giverOf`): the taker, else the check's leader — as a matter's owner. */
export type GiverOf = (order: CustomOrderRow) => { owner: MatterOwner; kind: CustomGiverKind };

/** The states «просрочен» is the shooting's matter in: not shot yet. */
const OVERDUE_STATES: readonly CustomOrderRow["state"][] = ["recorded", "paid", "checked", "at_model", "partly", "revision"];

/** The findings of every order kind from the orders, pure: the rules above. */
export function orderFindings(input: {
  orders: readonly CustomOrderRow[];
  now: Date;
  /** Who leads customs: one owner, or by the page's model (`customsLeadOwner`, per model since 0415). */
  lead: LeadOf;
  /** Who gives a shot order (`giverOf`); absent — its taker as stored, else the check's leader. */
  giverOf?: GiverOf;
  /** The test pages (sandbox/realm.ts): their orders get their own matters (the test team's), never the owner's count. */
  testPageIds?: ReadonlySet<number>;
  /** Who leads each phase (leaders.ts); absent — `lead` for every phase. */
  phaseLead?: PhaseLeadOf;
  /**
   * The switch `customsFacts`: the forwarding timer decides «не у модели» (C3), «Проверен» is off the path (C8), and
   * «просрочен» and «снят, отдайте фану» are the board's own «Горит» (`customOrderBurnsOf`: past the deadline by more than
   * a full day; shot, nothing sent for 12 h — never on hold, never sent and not opened) — the latter while giving it is
   * the move (`moveOf`; a reversed payment is the owner's first).
   */
  factsOn?: boolean;
  /** Whose move each order is (with the facts): absent — every burning shot order is the giver's. */
  moveOf?: MoveOf;
}): Record<"custom.not_at_model" | "custom.not_at_model_owner" | "custom.checked_not_at_model" | "custom.overdue" | "custom.overdue_owner" | "custom.shot_not_given" | "custom.give_on_shift", Finding[]> {
  const { now } = input;
  const leadOf = leadFn(input.lead);
  const phaseOf = input.phaseLead ?? ((pageId: number | null) => leadOf(pageId));
  const giverOf: GiverOf = input.giverOf ?? ((order) => (order.acceptedByUserId !== null
    ? { owner: { userId: order.acceptedByUserId }, kind: "taker" }
    : { owner: phaseOf(order.pageId, "check"), kind: "lead" }));
  const out = {
    "custom.not_at_model": [] as Finding[],
    "custom.not_at_model_owner": [] as Finding[],
    "custom.checked_not_at_model": [] as Finding[],
    "custom.overdue": [] as Finding[],
    "custom.overdue_owner": [] as Finding[],
    "custom.shot_not_given": [] as Finding[],
    // Retired (the owner, 2026-11-22: whoever is on shift may give it, never obliged): none is opened, so the pass closes
    // the open ones by its own rule (cause gone).
    "custom.give_on_shift": [] as Finding[],
  };
  const overdue: CustomOrderRow[] = [];
  const unforwarded: CustomOrderRow[] = [];
  for (const order of input.orders) {
    const code = customOrderCode(order.id);
    const pageIds = order.pageId === null ? [] : [order.pageId];
    const since = now.getTime() - order.stateAt.getTime();
    const test = order.pageId !== null && input.testPageIds?.has(order.pageId) === true;
    // With the facts: the board's own timer (one reading, `customForwardTimerOf`), amber from a day after the money; and
    // what it burns by (`customOrderBurnsOf`), which «просрочен» and «отдайте фану» follow.
    const facts = input.factsOn === true ? factsOfRow(order) : null;
    const timer = facts !== null ? urgencyOfRow(order, facts, now).timer : null;
    const burns = facts !== null ? new Set(burnsOfRow(order, facts, now).map((burn) => burn.kind)) : null;
    const overdueNow = OVERDUE_STATES.includes(order.state) && (burns !== null ? burns.has("overdue") : deadlinePassed(order.deadlineOn, now));
    const giveNow = burns !== null
      ? burns.has("shot_unsent") && (input.moveOf === undefined || input.moveOf(order, facts!)?.giver !== undefined)
      : order.state === "shot" && since >= NOT_GIVEN_HOURS * HOUR_MS;
    const waitsAtStart = input.factsOn === true
      ? timer !== null
      : (order.state === "paid" || order.state === "recorded") && since >= NOT_AT_MODEL_HOURS * HOUR_MS;
    // An order on hold waits on purpose: its refusal is no matter while it does (as it never burns).
    const refusedLong = order.state === "refused" && order.holdReason === null && since >= REFUSED_HOURS * HOUR_MS;
    const checkedLong = input.factsOn !== true && order.state === "checked" && since >= NOT_AT_MODEL_HOURS * HOUR_MS;
    if (waitsAtStart) {
      const title = timer !== null
        ? `Кастом ${code} ${facts?.paid.value === "yes" ? "оплачен" : "частично оплачен"} и сутки не у модели: ${pageOf(order)}`
        : `Кастом ${code} ${order.state === "paid" ? "оплачен" : "записан"} и сутки не у модели: ${pageOf(order)}`;
      out["custom.not_at_model"].push({
        key: `custom.not_at_model:${code}`, title,
        object: orderObject(order), pageIds, owner: phaseOf(order.pageId, "check"), evidence: { code, state: order.state, since: timer?.since ?? order.stateAt.toISOString() }, link: orderLink(order),
      });
      if (timer?.level === "red" && !test) unforwarded.push(order);
    }
    if (refusedLong || checkedLong) {
      const title = order.state === "refused"
        ? `Кастом ${code}: отказ модели, решите, что дальше: ${pageOf(order)}`
        : `Кастом ${code} проверен и сутки не у модели: ${pageOf(order)}`;
      out["custom.checked_not_at_model"].push({
        key: `custom.checked_not_at_model:${code}`, title,
        object: orderObject(order), pageIds, owner: phaseOf(order.pageId, "shoot"), evidence: { code, state: order.state, since: order.stateAt.toISOString() }, link: orderLink(order),
      });
    }
    if (overdueNow) {
      if (order.pageId === null || input.testPageIds?.has(order.pageId) !== true) overdue.push(order);
      out["custom.overdue"].push({
        key: `custom.overdue:${code}`, title: `Кастом ${code} просрочен: срок был ${dottedDay(order.deadlineOn!)}, ${pageOf(order)}`,
        object: orderObject(order), pageIds, owner: phaseOf(order.pageId, "shoot"), evidence: { code, deadlineOn: order.deadlineOn, state: order.state }, link: orderLink(order),
      });
    }
    if (giveNow) {
      // The taker answers for it; with none, the check's leader names who took it (or gives it themselves).
      const giver = giverOf(order);
      const title = giver.kind === "taker"
        ? `Кастом ${code} снят: посмотрите ролик целиком и отдайте фану, ${pageOf(order)}`
        : `Кастом ${code} снят, не указано, кто принял: укажите принявшего или посмотрите ролик целиком и отдайте фану, ${pageOf(order)}`;
      out["custom.shot_not_given"].push({
        key: `custom.shot_not_given:${code}`, title, object: orderObject(order), pageIds, owner: giver.owner,
        evidence: { code, shotAt: order.stateAt.toISOString(), giver: giver.kind }, link: orderLink(order),
      });
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
  // C3: the paid cards two days not at the model, of the live agency, in one line for the owner.
  if (unforwarded.length > 0) {
    out["custom.not_at_model_owner"].push({
      key: "custom.not_at_model_owner:all",
      title: `Кастомы оплачены и двое суток не у модели: ${unforwarded.length}`,
      object: null,
      pageIds: [],
      owner: { role: "owner" },
      evidence: { count: unforwarded.length, codes: unforwarded.map((order) => customOrderCode(order.id)).slice(0, 50) },
      link: "/workboard/customs",
    });
  }
  return out;
}

/** A sale that looks like a custom and has no order a day later, pure: one matter per sale. */
export function unrecordedFindings(input: { sales: readonly CustomLookalikeRow[]; recorders: ReadonlySet<number>; lead: LeadOf }): Finding[] {
  const leadOf = leadFn(input.lead);
  const out: Finding[] = [];
  for (const sale of input.sales) {
    // The chatter who led the chat when they record customs; else the lead — nobody else would see it.
    const chatter = sale.ledByUserIds.find((userId) => input.recorders.has(userId));
    const owner: MatterOwner = chatter === undefined ? leadOf(sale.pageId) : { userId: chatter };
    out.push({
      key: unrecordedKey(sale.transactionId),
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
  return reconcileKindMatters(app, {
    kinds: [kind],
    inputs: findings.map((finding): MatterOpenInput => ({
      key: finding.key, kind, source: "server", title: finding.title.slice(0, 300), object: finding.object, pageIds: finding.pageIds,
      owner: finding.owner, money: false, evidence: finding.evidence, link: finding.link,
    })),
    keep,
    closeAs: "server",
    onOpenError: (error, key) => app.logger.error({ err: error, kind, key }, "custom checks: a matter could not be opened"),
    onCloseError: (error, key) => app.logger.error({ err: error, kind, key }, "custom checks: a matter could not be closed"),
  }, now);
}

const CARD_KIND = "custom.card_without_order";
const cardKey = (ref: string) => `${CARD_KIND}:${ref}`;

/**
 * The reader's report of cards no order has: each becomes the lead's matter. With `complete`, the open ones not
 * in the list are gone (closed); a card attached to an order closes its matter on the next pass.
 */
export async function reportUnmatchedCards(
  app: Pick<AppContext, "db" | "logger" | "config">,
  input: { cards: ReadonlyArray<{ telegramRef: string; postedAt?: string | undefined; where?: string | undefined }>; complete: boolean; agentKeyId: number },
  now: Date,
): Promise<{ opened: number; closed: number }> {
  // With the facts the cards are findings of the models' groups (one home), never matters; an attached card's finding is
  // linked to its order by the pass. A card no longer reported stays open: a person resolves it.
  if (await customsFactsOn(app)) return { opened: await reportCardFindings(app, input.cards, now), closed: 0 };
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
  /**
   * With the facts: orders given by their files, sent marks changed, purchases linked, default deadlines set, the fan's
   * asks answered, findings written.
   */
  given: number;
  sent: number;
  payments: number;
  deadlines: number;
  answered: number;
  findings: number;
}

const OPEN_STATES: readonly CustomOrderRow["state"][] = ["recorded", "paid", "checked", "at_model", "partly", "shot", "revision", "refused"];

/** One pass of the checks; a kind whose read fails is logged and left as it was. */
export async function runCustomOrderChecks(app: Pick<AppContext, "db" | "logger" | "config">, now: Date = new Date()): Promise<CustomChecksTally> {
  const tally: CustomChecksTally = { opened: 0, closed: 0, autoClosed: 0, given: 0, sent: 0, payments: 0, deadlines: 0, answered: 0, findings: 0 };
  const add = (done: { opened: number; closed: number }) => {
    tally.opened += done.opened;
    tally.closed += done.closed;
  };
  const [leaders, recorderRows, onShift, factsOn] = await Promise.all([
    customLeaderContext(app),
    listUsersWithPersonRight(app.db, "records_customs"),
    listOnShiftUsersByPage(app.db, now),
    customsFactsOn(app),
  ]);
  // Who leads each phase of a page's order: the one rule (leaders.ts); the chat side's findings are the check's.
  const phaseLead: PhaseLeadOf = (pageId, phase) => leaderOwner(phaseLeader(leaders.facts, pageId, phase, leaders.fallback));
  const lead = (pageId: number | null) => phaseLead(pageId, "check");
  const recorders = new Set(recorderRows.map((row) => row.userId));
  // Who gives a shot order: the one rule (leaders.ts `giverOf`), no right gating it.
  const giverOfOrder: GiverOf = (order) => {
    const giver = giverOf(leaders.facts, order, leaders.fallback);
    return { owner: leaderOwner(giver.who), kind: giver.kind };
  };

  // Marked given and quiet for three days: closed by itself (a revision moves it out of «given» first). From the mark
  // (`state_at`), not the message's own time: a delivery found late or backfilled keeps a full window. Never while
  // something stands against it — the agent's sentence of a disagreement, a sale the platform took back: it burns, the
  // owner's move, until settled.
  for (const order of await listCustomOrdersInStates(app.db, ["given"])) {
    if (issueOf(order.issue) !== null || factsOfRow(order).paid.value === "conflict") continue;
    if (now.getTime() - order.stateAt.getTime() >= AUTO_CLOSE_HOURS * HOUR_MS) {
      try {
        const step = { action: "close" as const, auto: { hours: AUTO_CLOSE_HOURS } };
        if (await applyCustomStep(app, { orderId: order.id, step, actor: { door: "system" }, viewer: null, now })) tally.autoClosed += 1;
      } catch (error) {
        app.logger.error({ err: error, orderId: order.id }, "custom checks: a given order could not be closed");
      }
    }
  }

  if (factsOn) {
    // The exact «given» and the sent mark from the orders' files, then the default deadline of the orders with none and
    // the fan's asks the page answered.
    const live = await listCustomOrdersInStates(app.db, OPEN_STATES);
    const delivered = await settleCustomDeliveries(app, live, now);
    tally.given = delivered.given;
    tally.sent = delivered.sent;
    tally.payments = delivered.payments;
    const settled = await listCustomOrdersInStates(app.db, OPEN_STATES);
    tally.deadlines = await setDefaultDeadlines(app, settled, now);
    tally.answered = await clearAnsweredAsks(app, settled, now);
  }

  const orders = await listCustomOrdersInStates(app.db, OPEN_STATES);
  const tests = await testPageIds(app);
  // Whose move, by the board's one rule: «отдайте фану» only while giving it is the move.
  const moveOf: MoveOf = (order, facts) => customMoveOf(
    leaders.facts, order, { paid: facts.paid.value, given: facts.given.value }, order.pageLabel === null ? [] : onShift.get(order.pageLabel) ?? [], leaders.fallback,
  );
  const findings = orderFindings({ orders, now, lead, phaseLead, giverOf: giverOfOrder, testPageIds: tests, factsOn, moveOf });
  for (const kind of Object.keys(findings) as Array<keyof typeof findings>) add(await reconcile(app, kind, findings[kind], now));

  // A custom with no order: findings (one home) with the switch on; the two kinds of matter before them with it off.
  if (factsOn) {
    try {
      const retired = await retireCustomFindingMatters(app, now);
      tally.closed += retired.closed;
      tally.findings += retired.migrated;
      const written = await writeCustomFindings(app, { now });
      tally.findings += written.written;
    } catch (error) {
      app.logger.error({ err: error }, "custom checks: the findings could not be written");
    }
  }
  const open = factsOn ? await openFindingsForMatters(app, now) : [];
  const ofFindings = findingMatters({ findings: open, now, leadOf: lead });
  for (const kind of Object.keys(ofFindings) as Array<keyof typeof ofFindings>) add(await reconcile(app, kind, ofFindings[kind], now));
  if (factsOn) return tally;

  // A sale that looks like a custom, a day old and still without an order: its chatter's with the right, else the
  // lead's. New ones are looked for in the last week; the sales of the matters already open are read whatever their
  // day, so a matter is kept (and its owner followed) while its sale has neither an order nor «не кастом».
  const waiting = await listOpenMattersOfKinds(app.db, [CUSTOM_UNRECORDED_KIND]);
  // So are the sales of the matters closed as «cause gone»: the rule as it was closed a matter that way when its sale
  // only left the week, though it had neither an order nor a word. Such a sale is found again below and its matter
  // opens again; one that is really gone — or has an order or «не кастом» now — is not found, and stays closed.
  const lapsed = await listClosedMattersOfKinds(app.db, { kinds: [CUSTOM_UNRECORDED_KIND], how: "cause_gone" });
  const saleIds = (matters: typeof waiting) => matters.map((matter) => unrecordedSaleOf(matter.key)).filter((id): id is number => id !== null);
  const sales = await listCustomLookalikeSales(app.db, {
    from: new Date(now.getTime() - UNRECORDED_DAYS * 24 * HOUR_MS), to: new Date(now.getTime() - UNRECORDED_HOURS * HOUR_MS), limit: 500,
    alsoIds: [...saleIds(waiting), ...saleIds(lapsed)],
  });
  const unrecorded = unrecordedFindings({ sales, recorders, lead });
  add(await reconcile(app, CUSTOM_UNRECORDED_KIND, unrecorded, now, () => true));
  // A matter whose sale is not among them closes only by what became of the sale, and says which.
  const found = new Set(unrecorded.map((finding) => finding.key));
  const left = waiting.filter((matter) => !found.has(matter.key));
  const fates = await listCustomSaleFates(app.db, saleIds(left));
  const stillWaiting: string[] = [];
  for (const matter of left) {
    const how = UNRECORDED_CLOSES[fates.get(unrecordedSaleOf(matter.key) ?? 0) ?? "gone"];
    if (how === null) {
      stillWaiting.push(matter.key);
      continue;
    }
    try {
      if ((await closeMatter(app.db, { key: matter.key, how, writer: "server" }, SYSTEM, now)).transition === "closed") tally.closed += 1;
    } catch (error) {
      app.logger.error({ err: error, key: matter.key }, "custom checks: an unrecorded custom's matter could not be closed");
    }
  }
  await touchMatters(app.db, stillWaiting, now);

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
