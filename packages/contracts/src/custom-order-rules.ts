import {
  CUSTOM_ORDER_ACTIONS,
  customOrderCardSchema,
  customOrderCode,
  type CustomOrderAction,
  type CustomOrderCard,
  type CustomOrderState,
} from "./custom-orders.ts";

/**
 * Заказ кастома: the rules every door shares, pure — who may take which step
 * from which state, the parts an order wants and its overdue days, the card
 * «📦 Описание заказа» as text. Hub's server enforces them
 * (apps/runtime services/custom-orders); Workboard and the demo read them.
 */

const OPEN: readonly CustomOrderState[] = ["recorded", "paid", "at_model", "partly", "shot", "revision", "refused"];
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
export const DELIVERY_MOVES_FROM: readonly CustomOrderState[] = ["recorded", "paid", "at_model", "partly", "revision"];

/** The states each step may be taken from. A step that moves the order names its new state in `STEP_TO`. */
export const STEP_FROM: Readonly<Record<CustomStepName, readonly CustomOrderState[]>> = {
  edit: NOT_ENDED,
  deadline: OPEN,
  fan: NOT_ENDED,
  card: ALL,
  // «100$ после готовности»: a payment may come at any step, after «отдали» too; never to a cancelled order.
  payment: [...NOT_ENDED, "closed"],
  unpay: NOT_ENDED,
  at_model: ["recorded", "paid", "refused"],
  partly: ["at_model", "partly", "revision"],
  shot: ["at_model", "partly", "revision"],
  // A fan's complaint after «отдали» is a revision too; one more request while it is in revision as well.
  revision: ["partly", "shot", "revision", "given"],
  refused: ["at_model", "partly", "revision"],
  given: ["recorded", "paid", "at_model", "partly", "shot", "revision"],
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
  /** The pages the person reaches (user_page_assignments). */
  pageIds: readonly number[];
  /** «Ведёт кастомы». */
  lead: boolean;
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
  if (viewer.lead || viewer.role === "owner") return true;
  if (order.pageId === null) return viewer.role === "team_lead";
  return viewer.pageIds.includes(order.pageId);
}

/** A chatter's steps: a payment, «отдали»; on their own order also its card, its fan and «отменить». */
const CHATTER_STEPS: ReadonlySet<CustomOrderAction> = new Set(["payment", "given"]);
const OWN_ORDER_STEPS: ReadonlySet<CustomOrderAction> = new Set(["edit", "fan", "unpay", "cancel"]);

/** Whether the viewer may take `step` on the order now (its state included). */
export function mayTakeStep(viewer: CustomViewer, order: { pageId: number | null; state: CustomOrderState; acceptedByUserId: number | null }, step: CustomOrderAction): boolean {
  if (!seesOrder(viewer, order)) return false;
  if (!STEP_FROM[step].includes(order.state)) return false;
  if (leadsSteps(viewer)) return true;
  if (CHATTER_STEPS.has(step)) return true;
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
  if (!["recorded", "paid", "at_model", "partly", "revision"].includes(order.state) || order.deadlineOn === null) return null;
  const today = moscowDay(now);
  if (today <= order.deadlineOn) return null;
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${order.deadlineOn}T00:00:00Z`)) / 86_400_000);
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

const MSK_OFFSET_MS = 3 * 3_600_000;
/** `YYYY-MM-DD` → `DD.MM.YYYY`. */
export function dottedDay(day: string): string {
  const [year, month, date] = day.split("-");
  return `${date}.${month}.${year}`;
}
/** The Moscow day of a moment, `YYYY-MM-DD`. */
export function moscowDay(at: Date): string {
  return new Date(at.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10);
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

