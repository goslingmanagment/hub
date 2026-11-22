import { moscowDayOfMs } from "@agency_hub_core/shared";

import {
  CUSTOM_ORDER_ACTIONS,
  customOrderCardSchema,
  customOrderCode,
  customOrderIssueSchema,
  customPaidWordSchema,
  type CustomFact,
  type CustomOrderAction,
  type CustomOrderCard,
  type CustomOrderFacts,
  type CustomOrderIssue,
  type CustomOrderState,
  type CustomPaidWord,
  type CustomPaidWordKind,
  type CustomUndo,
} from "./custom-orders.ts";

/**
 * Заказ кастома: the rules every door shares, pure — who may take which step
 * from which state, the parts an order wants and its overdue days, the card
 * «📦 Описание заказа» as text. Hub's server enforces them
 * (apps/runtime services/custom-orders); Workboard and the demo read them.
 */

const OPEN: readonly CustomOrderState[] = ["recorded", "paid", "checked", "at_model", "partly", "shot", "revision", "refused"];
const NOT_ENDED: readonly CustomOrderState[] = [...OPEN, "given"];
const ALL: readonly CustomOrderState[] = [...NOT_ENDED, "closed", "cancelled"];

// ── Steps and states ────────────────────────────────────────────────────────

/**
 * The board's steps, and the readers' own: a delivery message, a revision fixed, another message, a delivery taken
 * back, the fan's «where is it», a disagreement of the sources; and the server's own `settle` — the order put where
 * its kept messages say (an import stores messages without a step).
 */
export type CustomStepName = CustomOrderAction | "delivery" | "revision_done" | "message" | "retract" | "settle" | "fan_asked" | "issue";

const BOARD_ACTIONS: ReadonlySet<string> = new Set(CUSTOM_ORDER_ACTIONS);
export function isBoardAction(step: CustomStepName): step is CustomOrderAction {
  return BOARD_ACTIONS.has(step);
}

/** The states a delivery moves the order from (to «сдан частично», «снят» or back to «правка»). */
export const DELIVERY_MOVES_FROM: readonly CustomOrderState[] = ["recorded", "paid", "checked", "at_model", "partly", "revision"];

/** The states each step may be taken from. A step that moves the order names its new state in `STEP_TO`. */
export const STEP_FROM: Readonly<Record<CustomStepName, readonly CustomOrderState[]>> = {
  edit: NOT_ENDED,
  deadline: OPEN,
  fan: NOT_ENDED,
  card: ALL,
  // «100$ после готовности»: a payment may come at any step, after «отдали» too; never to a cancelled order.
  payment: [...NOT_ENDED, "closed"],
  // As a payment: a closed order's sale taken off too (the owner's alone there).
  unpay: [...NOT_ENDED, "closed"],
  // «Проверен» before the model; a routine «со слов из Telegram» may still put a recorded or paid order there.
  checked: ["recorded", "paid"],
  at_model: ["recorded", "paid", "checked", "refused"],
  partly: ["at_model", "partly", "revision"],
  shot: ["at_model", "partly", "revision"],
  // A fan's complaint after «отдали» is a revision too; one more request while it is in revision as well.
  revision: ["partly", "shot", "revision", "given"],
  refused: ["at_model", "partly", "revision"],
  given: ["recorded", "paid", "checked", "at_model", "partly", "shot", "revision"],
  // «Отдан» taken back while the order is not closed yet: it is «снят» again.
  ungive: ["given"],
  close: ["given"],
  cancel: OPEN,
  // A delivery is kept in every state (its sender must know it is in the hub); it moves the order only from the
  // states before «снят» and from a revision (DELIVERY_MOVES_FROM): it proves the card reached the model.
  delivery: ALL,
  revision_done: NOT_ENDED,
  message: ALL,
  retract: ALL,
  settle: DELIVERY_MOVES_FROM,
  // A wait on purpose belongs to an order in work; it can always be taken off.
  hold: OPEN,
  unhold: ALL,
  // The fan asks about an order that is not his yet.
  fan_asked: OPEN,
  // The sources disagree about an order until it closes; a standing issue can always be cleared.
  issue: NOT_ENDED,
  issue_clear: ALL,
  // The owner's word on the payment, as a payment: at any step, after «отдан» too; never on a cancelled order.
  paid_word: [...NOT_ENDED, "closed"],
  // The page answered the fan's «where is it»: a standing ask can always be taken off.
  fan_asked_clear: ALL,
};

export const STEP_TO: Partial<Readonly<Record<CustomOrderAction, CustomOrderState>>> = {
  checked: "checked",
  at_model: "at_model",
  partly: "partly",
  shot: "shot",
  revision: "revision",
  refused: "refused",
  given: "given",
  close: "closed",
  cancel: "cancelled",
};

/**
 * Each state in people's words: the one table for every door that names an order's step — the board «Кастомы»
 * in Workboard and the extension's fan panel (the wire's `stepLabel`, shown as it is).
 */
export const CUSTOM_STATE_WORDS: Readonly<Record<CustomOrderState, string>> = {
  recorded: "Записан",
  paid: "Оплачен",
  checked: "Проверен",
  at_model: "У модели",
  partly: "Сдан частично",
  shot: "Снят",
  revision: "Правка",
  refused: "Отказ модели",
  given: "Отдан фану",
  closed: "Закрыт",
  cancelled: "Отменён",
};

/** Who looks at an order: a person of a role, the lead (the right «ведёт кастомы»), and the pages they reach. */
export interface CustomViewer {
  userId: number;
  role: "owner" | "team_lead" | "chatter";
  /** The pages whose orders the viewer READS: the team's cut (services/teams.ts) and the login's own pages. */
  pageIds: readonly number[];
  /**
   * The pages the viewer WORKS: the login's own pages (user_page_assignments). A write of the chat's side — «оплата»,
   * «отдан», «Записать кастом» — goes by these (and the step's leader, the owner), never by the team's read cut:
   * «видит команду» of another model reads its orders and changes none. Absent — `pageIds`, as before the cut.
   */
  workPageIds?: readonly number[];
  /** «Ведёт кастомы» (the person right): the steps of an order of no known page. */
  lead: boolean;
  /**
   * The pages whose orders' steps the viewer leads, by phase (products plan §4.5; the one rule is the server's,
   * services/custom-orders/leaders.ts): `check` — «Проверен» and the card's fixes, `shoot` — the content side's steps.
   * Absent: every lead's step by `lead` and the role, as before the rule.
   */
  leads?: { check: readonly number[]; shoot: readonly number[] };
  /**
   * The test realm (0414, apps/runtime/src/services/sandbox/realm.ts): whether the viewer is a test person's login, and
   * the test pages. A live viewer never sees a test page's order, a test viewer only those. Absent: no test realm.
   */
  realm?: { test: boolean; testPageIds: readonly number[] };
}

/** Whether the order is of the viewer's realm (an order of no known page is the live agency's). */
function ofViewersRealm(viewer: CustomViewer, order: { pageId: number | null }): boolean {
  if (viewer.realm === undefined) return true;
  const test = order.pageId !== null && viewer.realm.testPageIds.includes(order.pageId);
  return test === viewer.realm.test;
}

/** The lead's steps belong to the lead, the owner and a team lead. */
export function leadsSteps(viewer: CustomViewer): boolean {
  return viewer.lead || viewer.role === "owner" || viewer.role === "team_lead";
}

/**
 * Whether the viewer sees the order: the lead and the owner every one; a team lead the orders of their pages and
 * those of no known page; a chatter only the orders of the pages they reach.
 */
export function seesOrder(viewer: CustomViewer, order: { pageId: number | null }): boolean {
  if (!ofViewersRealm(viewer, order)) return false;
  if (viewer.lead || viewer.role === "owner") return true;
  if (order.pageId === null) return viewer.role === "team_lead";
  return viewer.pageIds.includes(order.pageId);
}

// ── Who leads which step (products plan §4.5) ───────────────────────────────

/**
 * The side of an order's step: `check` — recorded, the card checked and given to shooting (the chat's side, Workboard);
 * `shoot` — handed to the model, delivered, revision, refusal, shot (ContentOps «Съёмка»); `give` — given to the fan
 * (the chatter, Workboard). Null — an ended order.
 */
export type CustomPhase = "check" | "shoot" | "give";
export function customPhaseOf(state: CustomOrderState): CustomPhase | null {
  if (state === "recorded" || state === "paid") return "check";
  if (state === "checked" || state === "at_model" || state === "partly" || state === "revision" || state === "refused") return "shoot";
  if (state === "shot") return "give";
  return null;
}
/** Where a phase is done. */
export function customPhaseProduct(phase: CustomPhase): "workboard" | "contentops" {
  return phase === "shoot" ? "contentops" : "workboard";
}

/** The content side's steps: whoever leads the shooting takes them (a delivery taken back too). */
const SHOOT_STEPS: ReadonlySet<CustomOrderAction> = new Set(["at_model", "partly", "shot", "revision", "refused", "retract"]);

/** Whether the viewer leads a phase of the order (the owner always; an order of no page: the person right, a team lead). */
export function leadsPhase(viewer: CustomViewer, order: { pageId: number | null }, phase: "check" | "shoot"): boolean {
  if (viewer.role === "owner") return true;
  if (viewer.leads === undefined || order.pageId === null) return leadsSteps(viewer);
  return viewer.leads[phase].includes(order.pageId);
}

/**
 * Whether the viewer works a page: the owner every page; else the login's own pages (`workPageIds`), or a page whose
 * order's step they lead. An order of no known page: the lead's steps' holders.
 */
export function worksOnPage(viewer: CustomViewer, pageId: number | null): boolean {
  if (viewer.role === "owner") return true;
  if (pageId === null) return leadsSteps(viewer);
  if ((viewer.workPageIds ?? viewer.pageIds).includes(pageId)) return true;
  return viewer.leads !== undefined && (viewer.leads.check.includes(pageId) || viewer.leads.shoot.includes(pageId));
}

/**
 * A chatter's steps: a payment, «отдали» and taking it back, the fan's «where is it» answered; on their own order also its
 * card, its fan and «отменить».
 */
const CHATTER_STEPS: ReadonlySet<CustomOrderAction> = new Set(["payment", "given", "ungive", "fan_asked_clear"]);
const OWN_ORDER_STEPS: ReadonlySet<CustomOrderAction> = new Set(["edit", "fan", "unpay", "cancel"]);
/** The owner's alone: his word on the payment, and settling the agent's sentence of a disagreement. */
const OWNER_STEPS: ReadonlySet<CustomOrderAction> = new Set(["paid_word", "issue_clear"]);
/** A wait on purpose: the owner's and the check's leader's. */
const HOLD_STEPS: ReadonlySet<CustomOrderAction> = new Set(["hold", "unhold"]);

/** An order as the rights read it; a hold, an issue and the fan's ask, when given, say whether there is one to take off. */
export interface CustomRightsOrder {
  pageId: number | null;
  state: CustomOrderState;
  acceptedByUserId: number | null;
  holdReason?: string | null;
  issue?: unknown;
  fanAskedAt?: unknown;
}

/** Whether the viewer may take `step` on the order now (its state included). */
export function mayTakeStep(viewer: CustomViewer, order: CustomRightsOrder, step: CustomOrderAction): boolean {
  if (!seesOrder(viewer, order)) return false;
  if (!STEP_FROM[step].includes(order.state)) return false;
  if ((step === "unhold" && order.holdReason === null) || (step === "issue_clear" && order.issue === null)) return false;
  if (step === "fan_asked_clear" && order.fanAskedAt === null) return false;
  if (step === "unpay" && order.state === "closed") return viewer.role === "owner";
  if (OWNER_STEPS.has(step)) return viewer.role === "owner";
  if (HOLD_STEPS.has(step)) {
    return viewer.role === "owner" || (viewer.leads !== undefined ? leadsPhase(viewer, order, "check") : leadsSteps(viewer));
  }
  if (viewer.leads !== undefined) {
    const check = leadsPhase(viewer, order, "check");
    const shoot = leadsPhase(viewer, order, "shoot");
    // «Проверен» is the check's; the content side's steps the shooting's (a fan's complaint after «отдан» either's).
    if (step === "checked") return check;
    if (SHOOT_STEPS.has(step)) return shoot || (step === "revision" && order.state === "given" && check);
    // The card's fixes, its fan, its deadline, a payment, «отменить», «закрыть»: whoever leads a step of it.
    if (check || shoot) return true;
  } else if (leadsSteps(viewer)) {
    return true;
  }
  // «Оплата» and «отдан»: the chatter who took the order, or whoever works its page — never a reader of the team.
  if (CHATTER_STEPS.has(step)) return order.acceptedByUserId === viewer.userId || worksOnPage(viewer, order.pageId);
  return OWN_ORDER_STEPS.has(step) && order.acceptedByUserId === viewer.userId;
}

/** The steps the viewer may take on the order now, in the board's order. */
export function stepsFor(viewer: CustomViewer, order: CustomRightsOrder): CustomOrderAction[] {
  return CUSTOM_ORDER_ACTIONS.filter((step) => mayTakeStep(viewer, order, step));
}


/** The parts the card orders: a video unless it says none, and photos when it names how many. */
export function wantedParts(card: CustomOrderCard): Array<"video" | "photos"> {
  const parts: Array<"video" | "photos"> = [];
  if (card.wantsVideo !== false) parts.push("video");
  if ((card.wantsPhotos ?? 0) > 0) parts.push("photos");
  return parts.length === 0 ? ["photos"] : parts;
}

/** The parts the order still waits for: the card orders them and they are not ready in the current round. */
export function waitedParts(order: { card: CustomOrderCard; partsDone: ReadonlyArray<"video" | "photos"> }): Array<"video" | "photos"> {
  return wantedParts(order.card).filter((part) => !order.partsDone.includes(part));
}

/** Days past the deadline while the model has not delivered it whole (as ContentOps counts «просрочено»); null — not overdue. */
export function overdueDaysOf(order: { state: CustomOrderState; deadlineOn: string | null }, now: Date): number | null {
  if (!["recorded", "paid", "checked", "at_model", "partly", "revision"].includes(order.state) || order.deadlineOn === null) return null;
  const today = moscowDay(now);
  if (today <= order.deadlineOn) return null;
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${order.deadlineOn}T00:00:00Z`)) / 86_400_000);
}

/**
 * Moscow days from today to the deadline in every state before «отдан» (0 — today, negative — past it): a shot order
 * still counts until the fan has it, where `overdueDaysOf` stops at «снят». Null — no deadline, or given or ended.
 */
export function dueLeftDaysOf(order: { state: CustomOrderState; deadlineOn: string | null }, now: Date): number | null {
  if (!OPEN.includes(order.state) || order.deadlineOn === null) return null;
  return Math.round((Date.parse(`${order.deadlineOn}T00:00:00Z`) - Date.parse(`${moscowDay(now)}T00:00:00Z`)) / 86_400_000);
}

// ── The four facts (customs facts spec §4) ──────────────────────────────────

/** What an order's four facts are read from: its row and the aggregate of the sales that pay it. */
export interface CustomFactsInput {
  state: CustomOrderState;
  /** The agreed total, gross; null — not named. */
  priceMills: number | null;
  /** How many sales pay the order, and their gross sum (a Fansly sale still pending counts). */
  payments: number;
  paidGrossMills: number;
  /**
   * One of those sales was taken back: OnlyFans wrote its reversal or chargeback as a row of its own. A sale merely
   * missing from a sync window is not taken back; Fansly reports no refund per sale, so on Fansly this is never true.
   */
  paymentReversed: boolean;
  /** The owner's word on the payment (a gift, paid outside the platform); null — none. */
  paidWord: { kind: CustomPaidWordKind } | null;
  /** Every file was sent to the fan and a priced one is not bought yet (the pass's mark, `sent_at`); null — not so. */
  sentAt: Date | string | null;
}

/** The states before the card reaches the model: a payment is the next move while nothing pays the order. */
const BEFORE_MODEL: readonly CustomOrderState[] = ["recorded", "paid", "checked"];
/** The states from «у модели» on: the model has the card (a refusal too, a given or closed order). */
const AT_MODEL_ON: readonly CustomOrderState[] = ["at_model", "partly", "shot", "revision", "refused", "given", "closed"];
const PAID_WORD_NOTES: Readonly<Record<CustomPaidWordKind, string>> = { gift: "без оплаты, слово владельца", off_platform: "оплачен не через площадку" };

function paidFact(input: CustomFactsInput): CustomFact {
  if (input.paidWord !== null) return { value: "yes", note: PAID_WORD_NOTES[input.paidWord.kind] };
  // A sale taken back is a conflict whatever money still counts: the platform may retire the original row with it.
  if (input.paymentReversed) return { value: "conflict", note: "возврат оплаты" };
  if (input.payments === 0) return BEFORE_MODEL.includes(input.state) ? { value: "wait" } : { value: "no" };
  // Never «оплачен» while the price is unknown: the screen says what came, «получено $X».
  if (input.priceMills === null || input.priceMills <= 0) return { value: "part", note: "цена не названа" };
  return input.paidGrossMills >= input.priceMills ? { value: "yes" } : { value: "part", note: "не вся сумма" };
}

function atModelFact(input: CustomFactsInput): CustomFact {
  if (AT_MODEL_ON.includes(input.state)) return { value: "yes" };
  // Money is linked (or the owner's word stands) and the card is not there: «передать модели» is the next move.
  if (BEFORE_MODEL.includes(input.state) && (input.payments > 0 || input.paidWord !== null)) return { value: "wait" };
  return { value: "no" };
}

function shotFact(state: CustomOrderState): CustomFact {
  switch (state) {
    case "shot": case "given": case "closed": return { value: "yes" };
    case "partly": return { value: "part" };
    case "revision": return { value: "wait", note: "правка" };
    case "refused": return { value: "conflict", note: "отказ модели" };
    case "at_model": return { value: "wait" };
    default: return { value: "no" };
  }
}

function givenFact(input: CustomFactsInput): CustomFact {
  if (input.state === "given" || input.state === "closed") return { value: "yes" };
  if (!OPEN.includes(input.state)) return { value: "no" };
  if (input.sentAt !== null) return { value: "part", note: "отправлен, фан не открыл" };
  return input.state === "shot" ? { value: "wait" } : { value: "no" };
}

/**
 * The four facts of an order (paid, at the model, shot, given), derived from its row and its payments at read time
 * and never stored: the server's board and the order's page read them, and so does the screen. «Given» is «yes» only
 * in the states «отдан» and «закрыт»; «paid» is «yes» only by the price reached or the owner's word.
 */
export function customOrderFactsOf(input: CustomFactsInput): CustomOrderFacts {
  return { paid: paidFact(input), atModel: atModelFact(input), shot: shotFact(input.state), given: givenFact(input) };
}

// ── What burns, why, and the forwarding timer (customs facts spec §7, C2, C3) ──

/** A paid card not at the model: the timer is amber after this long, red after that, and the owner hears of it then. */
export const CUSTOM_FORWARD_AMBER_HOURS = 24;
export const CUSTOM_FORWARD_RED_HOURS = 48;
/** Shot and nothing sent this long: it burns. */
export const CUSTOM_SHOT_UNSENT_HOURS = 12;
/** Burns by the deadline only past it by more than one full day (C2): from the second day after it. */
const OVERDUE_BURN_DAYS = 2;
const HOUR_MS = 3_600_000;

/** What an order's urgency is read from: its row, its four facts and the first sale that pays it. */
export interface CustomUrgencyInput {
  state: CustomOrderState;
  deadlineOn: string | null;
  deadlineDefault: boolean;
  stateAt: Date | string;
  stateNote: string | null;
  createdAt: Date | string;
  /** The first sale that pays it, its own time; null — none. */
  firstPaidAt: Date | string | null;
  payments: number;
  paidWord: { at: string } | null;
  holdReason: string | null;
  issue: { text: string } | null;
  fanAskedAt: Date | string | null;
  sentAt: Date | string | null;
  facts: CustomOrderFacts;
}

export interface CustomUrgency {
  burning: boolean;
  reason: string | null;
  timer: { kind: "forwarding"; level: "amber" | "red"; since: string } | null;
}

const msOf = (value: Date | string) => (value instanceof Date ? value.getTime() : Date.parse(value));
/** One line: no line breaks, at most 200 characters. */
const oneLine = (text: string) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  const chars = [...flat];
  return chars.length > 200 ? `${chars.slice(0, 199).join("").trimEnd()}…` : flat;
};

/**
 * The forwarding timer (C3): money linked or the owner's word, the card not at the model yet (recorded, paid, checked),
 * not on hold — counted from the later of the record and the first sale (or the word): amber from 24 h, red from 48 h;
 * null under 24 h and otherwise. The checks' matters read the same timer (`custom.not_at_model`, the owner's line).
 */
export function customForwardTimerOf(input: Omit<CustomUrgencyInput, "facts" | "issue" | "fanAskedAt" | "sentAt" | "stateNote" | "deadlineOn" | "deadlineDefault" | "stateAt">, now: Date): CustomUrgency["timer"] {
  if (input.holdReason !== null || !BEFORE_MODEL.includes(input.state)) return null;
  const from = input.payments > 0 ? input.firstPaidAt : input.paidWord?.at ?? null;
  if (from === null) return null;
  const since = Math.max(msOf(input.createdAt), msOf(from));
  const hours = (now.getTime() - since) / HOUR_MS;
  if (hours < CUSTOM_FORWARD_AMBER_HOURS) return null;
  return { kind: "forwarding", level: hours >= CUSTOM_FORWARD_RED_HOURS ? "red" : "amber", since: new Date(since).toISOString() };
}

/** What makes an order burn (customs facts spec §7), each with its words. */
export type CustomBurnKind = "issue" | "fan_asked" | "paid_conflict" | "refused" | "overdue" | "shot_unsent";
export interface CustomBurn {
  kind: CustomBurnKind;
  text: string;
}

/**
 * Everything an order burns by, the first being its reason (customs facts spec §7), derived at read time — the board
 * (`customOrderUrgencyOf`) and the checks' matters read the same list, so they never disagree. An open order: an issue
 * (its sentence), the fan asked where it is, a reversed payment, the model's refusal, more than one full day past the
 * deadline, shot and nothing sent for 12 h. A given order, until it closes: an issue, a reversed payment — the owner
 * settles them first. An order on hold never burns.
 */
export function customOrderBurnsOf(input: CustomUrgencyInput, now: Date): CustomBurn[] {
  if (input.holdReason !== null) return [];
  const burns: CustomBurn[] = [];
  if (input.state === "given") {
    if (input.issue !== null) burns.push({ kind: "issue", text: input.issue.text });
    if (input.facts.paid.value === "conflict") burns.push({ kind: "paid_conflict", text: "Отдан, но оплата возвращена" });
    return burns;
  }
  if (!OPEN.includes(input.state)) return burns;
  const dueLeft = dueLeftDaysOf(input, now);
  const shotHours = input.state === "shot" ? Math.floor((now.getTime() - msOf(input.stateAt)) / HOUR_MS) : 0;
  if (input.issue !== null) burns.push({ kind: "issue", text: input.issue.text });
  if (input.fanAskedAt !== null) burns.push({ kind: "fan_asked", text: "Фан спросил, где заказ" });
  if (input.facts.paid.value === "conflict") burns.push({ kind: "paid_conflict", text: "Возврат оплаты" });
  if (input.state === "refused") burns.push({ kind: "refused", text: input.stateNote ? `Отказ модели: ${input.stateNote}` : "Отказ модели" });
  if (dueLeft !== null && dueLeft <= -OVERDUE_BURN_DAYS) burns.push({ kind: "overdue", text: `Срок прошёл: был ${deadlineWordsOf(input)}` });
  if (input.state === "shot" && input.sentAt === null && shotHours >= CUSTOM_SHOT_UNSENT_HOURS) {
    burns.push({ kind: "shot_unsent", text: `Снят ${shotHours} ч назад и не отправлен фану` });
  }
  return burns;
}

/** The deadline as the reasons name it: «21.11.2026», «21.11.2026 (примерно)». */
function deadlineWordsOf(input: Pick<CustomUrgencyInput, "deadlineOn" | "deadlineDefault">): string {
  return input.deadlineOn === null ? "" : `${dottedDay(input.deadlineOn)}${input.deadlineDefault ? " (примерно)" : ""}`;
}

/**
 * Whether an order burns and why, or what it waits for, in one line (customs facts spec §7), derived at read time:
 * the first of `customOrderBurnsOf`, else what it waits for. An order on hold never burns.
 */
export function customOrderUrgencyOf(input: CustomUrgencyInput, now: Date): CustomUrgency {
  const timer = customForwardTimerOf(input, now);
  const burns = customOrderBurnsOf(input, now);
  if (!OPEN.includes(input.state)) {
    if (burns.length > 0) return { burning: true, reason: oneLine(burns[0]!.text), timer: null };
    const ended: Partial<Record<CustomOrderState, string>> = { given: "Отдан, ждём слово фана", closed: "Закрыт", cancelled: "Отменён" };
    return { burning: false, reason: ended[input.state] ?? null, timer: null };
  }
  if (input.holdReason !== null) return { burning: false, reason: oneLine(`На паузе: ${input.holdReason}`), timer };
  if (burns.length > 0) return { burning: true, reason: oneLine(burns[0]!.text), timer };
  const dueLeft = dueLeftDaysOf(input, now);
  const deadline = deadlineWordsOf(input);
  const due = dueLeft === 0 ? ", срок сегодня" : dueLeft === -1 ? `, срок был вчера (${deadline})` : "";
  const waits = ((): string => {
    if (input.facts.given.value === "part") return "Отправлен, фан ещё не открыл";
    switch (input.state) {
      case "shot": return "Снят, отдать фану";
      case "revision": return input.stateNote ? `Правка: ${input.stateNote}` : "Правка у модели";
      case "partly": return `${input.stateNote ? `Сдан частично: ${input.stateNote}` : "Сдан частично"}${due}`;
      case "at_model": return `У модели${due}`;
      default:
        return input.payments > 0 || input.paidWord !== null ? `Оплата есть, карточка не у модели${due}` : `Ждём оплату${due}`;
    }
  })();
  return { burning: false, reason: oneLine(waits), timer };
}

// ── How fresh the board is (customs facts spec §9) ──────────────────────────

/**
 * The reader's routines in «Система → Состояние», as the reader reports them (`PUT /api/v1/agent/system/routines`): the
 * pass every 30 minutes and the nightly reconciliation. A pass that could not read one of its sources reports a failure,
 * not a success, so the last success is what the board calls «Сверено». The keys are the reader's and the board's both.
 */
export const CUSTOMS_ROUTINES = {
  reader: { key: "customs-reader", title: "Кастомы: читатель (каждые 30 минут)", periodSeconds: 1800 },
  nightly: { key: "customs-nightly", title: "Кастомы: ночная сверка", periodSeconds: 86_400 },
} as const;

/** The reader is stale: never succeeded, or its last success is older than twice its period and ten minutes. */
export function customsReaderStale(readerAt: Date | string | null, now: Date): boolean {
  if (readerAt === null) return true;
  return now.getTime() - msOf(readerAt) > (2 * CUSTOMS_ROUTINES.reader.periodSeconds + 600) * 1000;
}

// ── Undo of what the system or an agent did (customs facts spec §10) ────────

/** The doors whose steps are «изменилось само»: Hub itself, and an agent key. */
export const SELF_CHANGE_DOORS: readonly string[] = ["system", "api"];

/**
 * How the viewer takes back one step of an order's history that the system or an agent took — the board's «Отменить»
 * in «За сутки изменилось само» and on the order's facts: a sale linked (`unpay`), «отдан» by a message (`ungive`), a
 * delivery (`retract`), a deadline moved (back to what it was). Null — not such a step, its evidence is off the order
 * already (`applied` false: the sale unlinked, the delivery taken back), the order moved on, or the step is not the
 * viewer's (`may`). The same rule on the server (the changes' list) and on the screen (the order's history).
 */
export function customUndoOf(
  step: { event: string; door: string; changes: Record<string, unknown> },
  order: { state: CustomOrderState; deadlineOn: string | null; givenMessageRef: string | null },
  /** The step's evidence is still on the order: its sale linked, its delivery not taken back; null — not asked. */
  applied: boolean | null,
  may: (action: CustomOrderAction) => boolean,
): CustomUndo | null {
  if (!SELF_CHANGE_DOORS.includes(step.door)) return null;
  const text = (key: string) => {
    const value = step.changes[key];
    return typeof value === "string" || typeof value === "number" ? String(value) : null;
  };
  switch (step.event) {
    case "custom_order.payment":
    case "custom_order.recorded": {
      const sale = text("transactionId");
      return sale !== null && applied === true && may("unpay") ? { action: "unpay", transactionRef: sale } : null;
    }
    case "custom_order.given": {
      const message = text("messageRef");
      return message !== null && order.state === "given" && order.givenMessageRef === message && may("ungive") ? { action: "ungive", messageRef: message } : null;
    }
    case "custom_order.delivery": {
      const ref = text("eventRef") ?? text("telegramRef");
      return ref !== null && applied === true && may("retract") ? { action: "retract", retracts: ref } : null;
    }
    case "custom_order.deadline": {
      const from = step.changes.from;
      const to = step.changes.to;
      if ((from !== null && typeof from !== "string") || to === undefined || order.deadlineOn !== to || !may("deadline")) return null;
      return { action: "deadline", deadlineOn: from };
    }
    default:
      return null;
  }
}

/** The stored owner's word on the payment, as the wire carries it; null — none, or a shape the contract does not know. */
export function paidWordOf(stored: unknown): CustomPaidWord | null {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return null;
  const parsed = customPaidWordSchema.safeParse({ note: null, by: null, ...stored });
  return parsed.success ? parsed.data : null;
}

/** The stored issue of an order, as the wire carries it; null — none, or a shape the contract does not know. */
export function issueOf(stored: unknown): CustomOrderIssue | null {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return null;
  const parsed = customOrderIssueSchema.safeParse({ by: null, ...stored });
  return parsed.success ? parsed.data : null;
}

// ── The card ────────────────────────────────────────────────────────────────

/** The stored card, its known fields only (a field the contract no longer knows is dropped, never served). */
export function cardOf(stored: Record<string, unknown>): CustomOrderCard {
  const card: Record<string, unknown> = {};
  for (const key of Object.keys(customOrderCardSchema.shape)) {
    const value = stored[key];
    if (value !== undefined && value !== null && value !== "") card[key] = value;
  }
  const parsed = customOrderCardSchema.safeParse(card);
  if (parsed.success) return parsed.data;
  // A field past today's limits (an older import): each field alone, the bad ones out.
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(card)) {
    if (customOrderCardSchema.safeParse({ [key]: value }).success) kept[key] = value;
  }
  return customOrderCardSchema.parse(kept);
}

/** What the order is, in one line: the task's first line without its number. */
export function whatOf(card: CustomOrderCard): string {
  const first = (card.task ?? card.photos ?? "").split("\n").map((line) => line.trim()).find((line) => line.length > 0 && line !== "-");
  const text = (first ?? card.duration ?? "").replace(/^\d+[.)]\s*/u, "").trim();
  if (text === "") return "Без описания";
  const chars = [...text];
  return chars.length > 140 ? `${chars.slice(0, 139).join("").trimEnd()}…` : text;
}

/** `YYYY-MM-DD` → `DD.MM.YYYY`. */
export function dottedDay(day: string): string {
  const [year, month, date] = day.split("-");
  return `${date}.${month}.${year}`;
}
/** The Moscow day of a moment, `YYYY-MM-DD`. */
export function moscowDay(at: Date): string {
  return moscowDayOfMs(at.getTime());
}
/** The deadline is behind: its Moscow day has ended. */
export function deadlinePassed(deadlineOn: string | null, now: Date): boolean {
  return deadlineOn !== null && moscowDay(now) > deadlineOn;
}

/** The buyer's link as the card prints it: Fansly `…/<username>/posts`, OnlyFans `…/<username>` or `…/u<number>`. */
export function buyerLinkOf(fan: { platform: string; fanRef: string; username: string | null }): string {
  if (fan.platform === "fansly") return fan.username ? `https://fansly.com/${fan.username}/posts` : `https://fansly.com/${fan.fanRef}`;
  return fan.username ? `https://onlyfans.com/${fan.username}` : `https://onlyfans.com/u${fan.fanRef}`;
}

const dash = (value: string | undefined) => (value === undefined || value.trim() === "" ? "-" : value.trim());

/**
 * «Скопировать карточку»: the card in the exact text of today's card (Gengar's skill `custom-tz`, the team's
 * template), the order's code beside the title. An empty section prints «-», as the team does.
 */
export function renderCardText(input: {
  id: number;
  card: CustomOrderCard;
  deadlineOn: string | null;
  createdAt: Date;
  buyer: string | null;
  fan: { platform: string; fanRef: string; username: string | null } | null;
}): string {
  const { card } = input;
  const photoSet = card.duration !== undefined && /фото/iu.test(card.duration) && !/мин|min/iu.test(card.duration);
  const lines: string[] = [
    `📦 Описание заказа ${customOrderCode(input.id)}`,
    `Дата: ${card.date ?? dottedDay(moscowDay(input.createdAt))}`,
    `Покупатель: ${input.fan !== null ? buyerLinkOf(input.fan) : dash(input.buyer ?? undefined)}`,
  ];
  if (card.name) lines.push(`Имя: ${card.name}`);
  lines.push(`Оплата: ${dash(card.price)}`, `Длительность: ${dash(card.duration)}`, "");
  lines.push(`${photoSet ? "📸" : "🎥"} Описание задания:`, dash(card.task), "");
  if (card.photos) lines.push("📸 Фото:", card.photos, "");
  lines.push("👗 Одежда:", dash(card.clothes), "");
  if (card.face) lines.push(`🙈 Лицо: ${card.face}`, "");
  lines.push("🗒 Заметки:", dash(card.notes), "");
  lines.push(`🔥Срочность: ${dash(card.urgency)}`);
  lines.push(`⏳Сроки: ${input.deadlineOn !== null ? `До ${dottedDay(input.deadlineOn)}` : dash(card.deadlineNote)}`);
  if (card.attachments && card.attachments.length > 0) lines.push("", ...card.attachments);
  return lines.join("\n");
}

