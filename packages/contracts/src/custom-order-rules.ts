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
 * back; and the server's own `settle` — the order put where its kept messages say (an import stores messages
 * without a step).
 */
export type CustomStepName = CustomOrderAction | "delivery" | "revision_done" | "message" | "retract" | "settle";

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
  unpay: NOT_ENDED,
  // «Проверен» before the model; a routine «со слов из Telegram» may still put a recorded or paid order there.
  checked: ["recorded", "paid"],
  at_model: ["recorded", "paid", "checked", "refused"],
  partly: ["at_model", "partly", "revision"],
  shot: ["at_model", "partly", "revision"],
  // A fan's complaint after «отдали» is a revision too; one more request while it is in revision as well.
  revision: ["partly", "shot", "revision", "given"],
  refused: ["at_model", "partly", "revision"],
  given: ["recorded", "paid", "checked", "at_model", "partly", "shot", "revision"],
  close: ["given"],
  cancel: OPEN,
  // A delivery is kept in every state (its sender must know it is in the hub); it moves the order only from the
  // states before «снят» and from a revision (DELIVERY_MOVES_FROM): it proves the card reached the model.
  delivery: ALL,
  revision_done: NOT_ENDED,
  message: ALL,
  retract: ALL,
  settle: DELIVERY_MOVES_FROM,
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

/** The content side's steps: whoever leads the shooting takes them. */
const SHOOT_STEPS: ReadonlySet<CustomOrderAction> = new Set(["at_model", "partly", "shot", "revision", "refused"]);

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

/** A chatter's steps: a payment, «отдали»; on their own order also its card, its fan and «отменить». */
const CHATTER_STEPS: ReadonlySet<CustomOrderAction> = new Set(["payment", "given"]);
const OWN_ORDER_STEPS: ReadonlySet<CustomOrderAction> = new Set(["edit", "fan", "unpay", "cancel"]);

/** Whether the viewer may take `step` on the order now (its state included). */
export function mayTakeStep(viewer: CustomViewer, order: { pageId: number | null; state: CustomOrderState; acceptedByUserId: number | null }, step: CustomOrderAction): boolean {
  if (!seesOrder(viewer, order)) return false;
  if (!STEP_FROM[step].includes(order.state)) return false;
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
export function stepsFor(viewer: CustomViewer, order: { pageId: number | null; state: CustomOrderState; acceptedByUserId: number | null }): CustomOrderAction[] {
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
  if (input.payments === 0) return BEFORE_MODEL.includes(input.state) ? { value: "wait" } : { value: "no" };
  if (input.paymentReversed) return { value: "conflict", note: "возврат оплаты" };
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

