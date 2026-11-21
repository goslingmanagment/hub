/**
 * Workboard «Кастомы» (package I; the facts screen, customs facts spec §13): the board, an order's page and its steps,
 * the given and closed, the findings of a custom with no order and what changed by itself, over invented orders of the
 * demo agency, kept in memory with their writes. The cookie `hub-demo-customs` picks how many orders there are (0, the
 * default set — every fact combination, burning, on hold, sent and not bought, no deadline, overdue — or 60);
 * `hub-demo-customs-as=lead` makes the chatter the lead («ведёт кастомы»); `hub-demo-customs-facts=off` shows the
 * column board as before the facts; `hub-demo-customs-stale=1` makes the reader late. Nothing here is real.
 */
import {
  CUSTOM_STATE_WORDS,
  customOrderFactsOf,
  customOrderUrgencyOf,
  customPhaseOf,
  customPhaseProduct,
  customOrderCode,
  customUndoOf,
  dueLeftDaysOf,
  parseCustomOrderCode,
  renderCardText,
  STEP_FROM,
  STEP_TO,
  stepsFor,
  wantedParts,
  whatOf,
  overdueDaysOf,
  type CustomBoardOrder,
  type CustomFinding,
  type CustomFindingActionBody,
  type CustomOrder,
  type CustomOrderActionBody,
  type CustomOrderCard,
  type CustomOrderDetailResponse,
  type CustomOrderIssue,
  type CustomOrderState,
  type CustomPaidWord,
  type CustomSelfChange,
  type CustomViewer,
  type KernelOperationResponse,
} from "@agency_hub_core/contracts";

import { demoError, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DEMO_DATA_PAGES, DEMO_USERS, demoFanProfile, demoFans, demoUserByRole } from "../world.ts";
import { DAY, HOUR, isoAt, mskDay, rng } from "./team-world.ts";

interface DemoOrder {
  id: number;
  page: string | null;
  fanRef: string | null;
  buyer: string | null;
  card: CustomOrderCard;
  deadlineOn: string | null;
  state: CustomOrderState;
  stateAt: number;
  stateNote: string | null;
  acceptedBy: string | null;
  origin: CustomOrder["origin"];
  createdAt: number;
  payments: Array<{ ref: string; kind: string; gross: number; at: number; note: string | null }>;
  givenAt: number | null;
  refs: string[];
  /** The parts ready in the current round, and the order's messages (deliveries, revision requests). */
  partsDone: CustomOrder["partsDone"];
  messages: CustomOrderDetailResponse["messages"];
  /** The order's history; each event's id is given when the detail is read (its place in the history). */
  history: Array<Omit<CustomOrderDetailResponse["history"][number], "id">>;
  /** The agreed total (null — not named), a deadline the system set, the owner's word, a hold, an issue, the fan's
   *  «where is it», every file sent and not opened yet; OnlyFans took a sale back. */
  priceMills: number | null;
  deadlineDefault: boolean;
  paidWord: CustomPaidWord | null;
  holdReason: string | null;
  issue: CustomOrderIssue | null;
  fanAskedAt: number | null;
  sentAt: number | null;
  reversed: boolean;
}

const TASKS: readonly string[] = [
  "1. Медленный стриптиз в красном белье, ~3 мин\n2. В конце называешь его по имени и шлёшь воздушный поцелуй, ~1 мин",
  "1. Тренировка в спортивном топе, вид сбоку, ~4 мин\n2. Растяжка на коврике, ~2 мин",
  "1. Примерка его подарка: туфли на каблуке и чулки, ~3 мин\n2. Прогулка по комнате, камера на штативе, ~2 мин",
  "1. Видео в душе без музыки, ~4 мин\n2. В конце смотришь в камеру и говоришь «for you», ~30 сек",
  "10 фото в его футболке, домашний свет, лицо не показываешь",
  "1. Утро в кровати, ленивые потягушки, ~2 мин\n2. Шёпотом «good morning, Tom» (гуд монинг, том), ~30 сек",
  "1. Разбор его фото голосом, честно и с юмором, ~3 мин",
  "1. Танец под медленную музыку в чёрном платье, ~5 мин\n2. Платье снимаешь в конце, ~1 мин",
  "1. Готовишь ему завтрак в фартуке, ~4 мин\n2. Пробуешь и хвалишь, ~1 мин",
  "1. Сцена «соседка зашла за солью» по его сценарию, ~8 мин\n2. Реплики короткие, выписаны в заметках",
];
const PRICES: readonly string[] = ["100$ тир Master + 50$", "150$ чаевые", "250$ уже оплачено", "100$ чаевые + 100$ после готовности", "60$", "150$ подписка + 50$ чаевые", "80$ чаевые", "220$"];
const CLOTHES: readonly string[] = ["Красное бельё, каблуки", "Спортивный комплект", "Его футболка, под ней ничего", "Чёрное платье, чулки", "Фартук на голое тело"];
/** The order of steps the generated orders past the scenarios walk through. */
const STATE_CYCLE: readonly CustomOrderState[] = ["at_model", "paid", "shot", "recorded", "checked", "partly", "given", "revision", "shot", "at_model", "at_model", "closed", "refused", "given"];

/**
 * The facts screen's orders, one per case: whose money came (all, part, none, the owner's word, taken back), where the
 * card is, what is shot and what the fan has, and why one burns. `due` — days from today to the deadline (null — none).
 */
interface Scenario {
  state: CustomOrderState;
  page: string | null;
  due: number | null;
  /** Hours since the step. */
  stepHours: number;
  /** How much of the price came, in percent: 100 — all, a part, 0 — nothing; the price null — not named. */
  paid: number;
  price: number | null;
  approximate?: boolean;
  hold?: string;
  issue?: string;
  fanAskedHours?: number;
  sentHours?: number;
  word?: CustomPaidWord["kind"];
  reversed?: boolean;
  note?: string;
  imported?: boolean;
  /** Its payment (by the agent) or its approximate deadline (by Hub) came in the last day: «изменилось само». */
  recent?: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  { state: "at_model", page: "mia-1", due: -3, stepHours: 120, paid: 100, price: 380_000 },
  { state: "revision", page: "mia-2", due: -2, stepHours: 30, paid: 100, price: 220_000, note: "Фото тёмные: переснять у окна" },
  { state: "shot", page: "mia-1", due: 2, stepHours: 15, paid: 100, price: 260_000 },
  { state: "at_model", page: "ivy-1", due: 8, stepHours: 50, paid: 100, price: 190_000, issue: "У модели в карточке другой срок, чем в заказе" },
  { state: "paid", page: "nova-1", due: null, stepHours: 60, paid: 100, price: 170_000, fanAskedHours: 20 },
  { state: "refused", page: "ivy-2", due: 4, stepHours: 10, paid: 100, price: 180_000, note: "Модель не снимает такие сцены" },
  { state: "at_model", page: "mia-of", due: 5, stepHours: 40, paid: 100, price: 140_000, reversed: true },
  { state: "shot", page: "mia-3", due: 0, stepHours: 5, paid: 50, price: 360_000, sentHours: 3 },
  { state: "at_model", page: "mia-2", due: -1, stepHours: 70, paid: 100, price: 125_000 },
  { state: "shot", page: "mia-1", due: 2, stepHours: 2, paid: 100, price: 45_000, recent: true },
  { state: "partly", page: "mia-2", due: 3, stepHours: 20, paid: 100, price: 240_000, note: "Видео есть, фото ещё ждём" },
  { state: "paid", page: "ivy-1", due: 5, stepHours: 28, paid: 100, price: 155_000 },
  { state: "checked", page: "nova-1", due: 6, stepHours: 52, paid: 40, price: 230_000, approximate: true, recent: true },
  { state: "at_model", page: "mia-3", due: 4, stepHours: 26, paid: 100, price: null, recent: true },
  { state: "at_model", page: "mia-vip-of", due: 7, stepHours: 12, paid: 0, price: 280_000, word: "off_platform" },
  { state: "recorded", page: "mia-1", due: null, stepHours: 6, paid: 0, price: 480_000 },
  { state: "at_model", page: "ivy-2", due: null, stepHours: 90, paid: 100, price: 135_000, hold: "Ждём от фана фото образа" },
  { state: "recorded", page: null, due: null, stepHours: 30, paid: 0, price: null, imported: true },
  { state: "at_model", page: "nova-1", due: 12, stepHours: 18, paid: 100, price: 210_000 },
  { state: "recorded", page: "mia-2", due: 9, stepHours: 3, paid: 0, price: 65_000 },
  { state: "given", page: "mia-1", due: 1, stepHours: 20, paid: 100, price: 310_000 },
  { state: "given", page: "ivy-1", due: -1, stepHours: 50, paid: 100, price: 145_000 },
  { state: "closed", page: "mia-2", due: -6, stepHours: 24 * 5, paid: 100, price: 205_000 },
  { state: "closed", page: "nova-1", due: -10, stepHours: 24 * 9, paid: 100, price: 115_000 },
  { state: "closed", page: "mia-3", due: -14, stepHours: 24 * 16, paid: 100, price: 85_000 },
];

const DEMO_CHAT = "1000000001";
/** A person as the people registry names them (the demo's users carry the name). */
const nameOf = (login: string | null) => (login === null ? null : DEMO_USERS.find((user) => user.username === login)?.name ?? login);
const MAIN_PAGES = DEMO_DATA_PAGES.filter((page) => page.label !== "mia-tg");

/** The order of a scenario, or — past the scenarios — one walked through the cycle of steps. */
function seedOrder(index: number, now: number, random: () => number): DemoOrder {
  const scenario = SCENARIOS[index];
  const page = scenario?.page === null ? MAIN_PAGES[0]! : MAIN_PAGES.find((one) => one.label === scenario?.page) ?? MAIN_PAGES[index % MAIN_PAGES.length]!;
  const fans = demoFans(page.label).filter((fan) => fan.totalSpent > 0);
  const fan = fans[(index * 7) % Math.max(1, fans.length)] ?? demoFans(page.label)[0]!;
  const state = scenario?.state ?? STATE_CYCLE[index % STATE_CYCLE.length]!;
  const stepAt = scenario ? now - Math.round(scenario.stepHours * HOUR) : now - Math.round((0.3 + random() * 6) * DAY);
  const createdAt = scenario ? stepAt - Math.round((2 + (index % 4)) * DAY) : stepAt - Math.round((0.2 + random() * 3) * DAY);
  const chatters = DEMO_USERS.filter((user) => user.role === "chatter" && user.active && user.pages.includes(page.label));
  const acceptor = chatters[index % Math.max(1, chatters.length)]?.username ?? "alex.k";
  const imported = scenario ? scenario.imported === true : index % 7 === 5;
  const due = scenario ? scenario.due : index % 5 === 3 ? null : [3, -2, 1, 5, 0, -4, 6][index % 7]!;
  const deadlineOn = due === null ? null : mskDay(now + due * DAY);
  const priceMills = scenario ? scenario.price : [150_000, 150_000, null, 200_000, 60_000, 200_000, 80_000, null][index % 8]!;
  const paidPercent = scenario ? scenario.paid : state === "recorded" ? 0 : 100;
  const gross = ((priceMills ?? 150_000) * paidPercent) / 100;
  const paid = gross > 0 && !imported;
  const history: DemoOrder["history"] = [{ at: isoAt(createdAt), event: "custom_order.recorded", actor: imported ? null : nameOf(acceptor), onBehalfOf: null, door: imported ? "system" : index % 2 === 0 ? "extension" : "api", changes: {} }];
  const recent = scenario?.recent === true;
  const byAgent = recent || index % 3 === 0;
  if (paid) {
    history.push({
      at: isoAt(recent ? now - (4 + (index % 3)) * HOUR : createdAt + 20 * 60_000), event: "custom_order.payment", actor: byAgent ? "Генгар" : nameOf(acceptor),
      onBehalfOf: null, door: byAgent ? "api" : "extension", changes: { transactionId: String(8_000_000 + index) },
    });
  }
  if (!["recorded", "paid", "checked"].includes(state)) history.push({ at: isoAt(createdAt + 6 * HOUR), event: "custom_order.at_model", actor: "Генгар", onBehalfOf: null, door: "api", changes: {} });
  const revised = state === "revision";
  const firstAt = Math.max(createdAt + 7 * HOUR, stepAt - 6 * HOUR);
  const message = (n: number, fields: Partial<DemoOrder["messages"][number]> & Pick<DemoOrder["messages"][number], "kind" | "at">): DemoOrder["messages"][number] => ({
    telegramRef: `tg:${DEMO_CHAT}/3/${20_000 + (101 + index) * 10 + n}`, eventRef: null, ordinal: 0, part: null, complete: null, author: "Модель", excerpt: null,
    doneAt: null, retractedAt: null, ...fields,
  });
  const messages: DemoOrder["messages"] = revised
    ? [
      message(1, { kind: "delivery", part: "video", complete: true, at: isoAt(firstAt), excerpt: "6-12 кастом.mov" }),
      message(2, { kind: "delivery", part: "photos", complete: true, at: isoAt(firstAt + 20 * 60_000), excerpt: "5 фото к кастому" }),
      message(3, { kind: "revision", ordinal: 1, part: "photos", at: isoAt(stepAt), author: "Вера", excerpt: scenario?.note ?? "Фото тёмные: переснять у окна" }),
    ]
    : ["shot", "given", "closed", "partly"].includes(state)
      ? [message(1, { kind: "delivery", part: "video", complete: true, at: isoAt(Math.min(stepAt, now - HOUR)), excerpt: "6-12 кастом в красном.mov" })]
      : [];
  if (revised) {
    history.push({ at: isoAt(firstAt), event: "custom_order.delivery", actor: "Генгар", onBehalfOf: null, door: "api", changes: { telegramRef: messages[0]!.telegramRef, excerpt: "6-12 кастом.mov" } });
    history.push({ at: isoAt(stepAt), event: "custom_order.revision", actor: "Вера", onBehalfOf: null, door: "contentops", changes: {} });
  } else if (["shot", "given", "closed", "partly"].includes(state)) {
    history.push({ at: isoAt(Math.min(stepAt, now - HOUR)), event: "custom_order.delivery", actor: "Генгар", onBehalfOf: null, door: "api", changes: { telegramRef: messages[0]!.telegramRef, excerpt: "6-12 кастом в красном.mov" } });
  }
  if (state === "partly" || state === "refused") history.push({ at: isoAt(stepAt), event: `custom_order.${state}`, actor: "Вера", onBehalfOf: null, door: "contentops", changes: {} });
  const givenAt = state === "given" || state === "closed" ? stepAt : null;
  if (givenAt !== null) history.push({ at: isoAt(givenAt), event: "custom_order.given", actor: null, onBehalfOf: null, door: "system", changes: { messageRef: String(990_000_000_000 + 101 + index) } });
  if (state === "closed") history.push({ at: isoAt(givenAt! + 3 * DAY), event: "custom_order.closed", actor: null, onBehalfOf: null, door: "system", changes: {} });
  if (scenario?.approximate) {
    history.push({ at: isoAt(recent ? now - 10 * HOUR : createdAt + DAY), event: "custom_order.deadline", actor: null, onBehalfOf: null, door: "system", changes: { from: null, to: deadlineOn, approximate: true } });
  }
  history.sort((left, right) => left.at.localeCompare(right.at));
  return {
    id: 101 + index,
    page: imported ? null : page.label,
    fanRef: imported ? null : fan.platformUserId,
    buyer: imported ? `${fan.username} (${fan.username})` : null,
    card: {
      price: PRICES[index % PRICES.length]!,
      duration: TASKS[index % TASKS.length]!.startsWith("10 фото") ? "10 фото" : `${4 + (index % 5)} минут${revised ? " + 5 фото" : ""}`,
      task: TASKS[index % TASKS.length]!,
      ...(revised ? { photos: "5 фото в том же образе, свет тёплый", wantsPhotos: 5 } : {}),
      clothes: CLOTHES[index % CLOTHES.length]!,
      notes: "Снимаешь вертикально.",
      urgency: ["Средняя", "Высокая", "Низкая"][index % 3]!,
    },
    deadlineOn,
    state,
    stateAt: state === "recorded" ? createdAt : stepAt,
    stateNote: scenario?.note ?? (state === "refused" ? "Модель не снимает такие сцены" : state === "partly" ? "Видео есть, фото ещё ждём" : null),
    acceptedBy: imported ? null : acceptor,
    origin: imported ? "import" : index % 2 === 0 ? "extension" : "agent",
    createdAt,
    payments: paid ? [{ ref: String(8_000_000 + index), kind: index % 3 === 0 ? "subscription" : "tip", gross, at: createdAt - 15 * 60_000, note: null }] : [],
    givenAt,
    refs: [`tg:${DEMO_CHAT}/3/${10_000 + index}`],
    partsDone: ["shot", "given", "closed"].includes(state) ? (revised ? ["video", "photos"] : ["video"]) : state === "revision" ? ["video"] : [],
    messages,
    history,
    priceMills,
    deadlineDefault: scenario?.approximate === true,
    paidWord: scenario?.word ? { kind: scenario.word, note: "Оплатил переводом", by: "Владелец", at: isoAt(createdAt + 2 * HOUR) } : null,
    holdReason: scenario?.hold ?? null,
    issue: scenario?.issue ? { text: scenario.issue, by: "Генгар", at: isoAt(stepAt) } : null,
    fanAskedAt: scenario?.fanAskedHours !== undefined ? now - scenario.fanAskedHours * HOUR : null,
    sentAt: scenario?.sentHours !== undefined ? now - scenario.sentHours * HOUR : null,
    reversed: scenario?.reversed === true,
  };
}

function seedOrders(count: number, now: number): DemoOrder[] {
  const random = rng(`customs:${count}`);
  return Array.from({ length: count }, (_, index) => seedOrder(index, now, random));
}

const stores = new Map<string, DemoOrder[]>();
const dismissed = new Set<string>();
const DEFAULT_SIZE = SCENARIOS.length;

function sizeOf(request: DemoRequest): number {
  const value = Number(request.cookie?.("hub-demo-customs") ?? String(DEFAULT_SIZE));
  return [0, DEFAULT_SIZE, 60].includes(value) ? value : DEFAULT_SIZE;
}

function storeOf(request: DemoRequest): DemoOrder[] {
  const size = sizeOf(request);
  const key = String(size);
  let store = stores.get(key);
  if (!store) {
    store = seedOrders(size, request.now.getTime());
    stores.set(key, store);
  }
  return store;
}

function viewerOf(request: DemoRequest): CustomViewer {
  const user = demoUserByRole(request.role);
  const pageIds = user.pages.map((label) => DEMO_DATA_PAGES.find((page) => page.label === label)?.id ?? 0);
  return { userId: user.id, role: request.role, pageIds, lead: request.role === "chatter" && request.cookie?.("hub-demo-customs-as") === "lead" };
}

const factsOnOf = (request: DemoRequest) => request.cookie?.("hub-demo-customs-facts") !== "off";
const pageIdOf = (label: string | null) => (label === null ? null : DEMO_DATA_PAGES.find((page) => page.label === label)?.id ?? null);
const TEAM_LEAD = () => demoUserByRole("team_lead").name;

/** «У кого сейчас» in the demo: the check is the team lead's, the shooting a made-up content manager's, the giving its chatter's. */
function demoLeader(order: DemoOrder): CustomOrder["leader"] {
  const phase = customPhaseOf(order.state);
  if (phase === null) return null;
  const name = phase === "check" ? TEAM_LEAD()
    : phase === "shoot" ? (order.page === null ? null : "Вера")
    : nameOf(order.acceptedBy) ?? TEAM_LEAD();
  return { name, phase, product: customPhaseProduct(phase) };
}

function factsOf(order: DemoOrder) {
  return customOrderFactsOf({
    state: order.state, priceMills: order.priceMills, payments: order.payments.length,
    paidGrossMills: order.payments.reduce((sum, payment) => sum + payment.gross, 0), paymentReversed: order.reversed, paidWord: order.paidWord,
    sentAt: order.sentAt === null ? null : isoAt(order.sentAt),
  });
}

/**
 * Whose move in the demo, by the server's order of rules (leaders.ts `customMoveOf`) over the made-up team: the owner
 * for a hold, a refusal or a reversed payment; the content manager for a revision; the fan for a sent and unopened
 * file; whoever is on shift (every third shot order) or the acceptor for a shot one; the model while she shoots.
 */
function demoMove(order: DemoOrder, facts: CustomOrder["facts"], fanName: string | null, modelName: string | null): CustomOrder["move"] {
  if (["given", "closed", "cancelled"].includes(order.state)) return null;
  if (order.holdReason !== null) return { who: null, whoKind: "owner", what: "решить, когда продолжить" };
  if (order.state === "refused") return { who: null, whoKind: "owner", what: "решить после отказа модели" };
  if (facts.paid.value === "conflict") return { who: null, whoKind: "owner", what: "разобраться с возвратом оплаты" };
  if (order.state === "revision") return { who: order.page === null ? null : "Вера", whoKind: order.page === null ? "owner" : "person", what: "довести правку" };
  if (facts.given.value === "part") return { who: fanName, whoKind: "fan", what: "открыть присланное" };
  if (order.state === "shot") {
    return order.id % 3 === 0
      ? { who: "Саша", whoKind: "shift", what: "отдать фану" }
      : { who: nameOf(order.acceptedBy) ?? demoUserByRole("team_lead").name, whoKind: "person", what: "отдать фану" };
  }
  if (order.state === "at_model" || order.state === "partly") return { who: modelName, whoKind: "model", what: order.state === "partly" ? "доснять" : "снять" };
  if (order.payments.length > 0 || order.paidWord !== null) return { who: demoUserByRole("team_lead").name, whoKind: "person", what: "передать модели" };
  return { who: nameOf(order.acceptedBy) ?? demoUserByRole("team_lead").name, whoKind: "person", what: "получить оплату" };
}

function wire(order: DemoOrder, now: number): CustomOrder {
  const page = order.page === null ? undefined : DEMO_DATA_PAGES.find((one) => one.label === order.page);
  const fan = order.fanRef === null || order.page === null ? undefined : demoFans(order.page).find((one) => one.platformUserId === order.fanRef);
  const profile = fan ? demoFanProfile(fan) : null;
  const facts = factsOf(order);
  const firstPaid = order.payments.reduce<number | null>((first, payment) => (first === null || payment.at < first ? payment.at : first), null);
  const urgency = customOrderUrgencyOf({
    state: order.state, deadlineOn: order.deadlineOn, deadlineDefault: order.deadlineDefault, stateAt: isoAt(order.stateAt), stateNote: order.stateNote,
    createdAt: isoAt(order.createdAt), firstPaidAt: firstPaid === null ? null : isoAt(firstPaid), payments: order.payments.length,
    paidWord: order.paidWord, holdReason: order.holdReason, issue: order.issue,
    fanAskedAt: order.fanAskedAt === null ? null : isoAt(order.fanAskedAt), sentAt: order.sentAt === null ? null : isoAt(order.sentAt), facts,
  }, new Date(now));
  return {
    id: order.id,
    code: customOrderCode(order.id),
    pageLabel: order.page,
    platform: page?.platform ?? null,
    model: page?.modelName ?? null,
    modelSlug: page?.modelSlug ?? null,
    fan: fan && page ? { platform: page.platform, fanRef: fan.platformUserId, username: profile!.username ?? fan.username, displayName: profile!.displayName } : null,
    buyer: order.fanRef === null ? order.buyer : null,
    fanErased: false,
    card: order.card,
    what: whatOf(order.card),
    deadlineOn: order.deadlineOn,
    state: order.state,
    stateWord: CUSTOM_STATE_WORDS[order.state],
    leader: demoLeader(order),
    stateAt: isoAt(order.stateAt),
    stateNote: order.stateNote,
    stateRef: null,
    paidGrossMills: order.payments.reduce((sum, payment) => sum + payment.gross, 0),
    paidNetMills: order.payments.reduce((sum, payment) => sum + Math.round(payment.gross * 0.8), 0),
    payments: order.payments.length,
    givenAt: order.givenAt === null ? null : isoAt(order.givenAt),
    givenMessageRef: order.givenAt === null ? null : String(990_000_000_000 + order.id),
    acceptedBy: order.acceptedBy,
    acceptedByName: nameOf(order.acceptedBy),
    telegramRefs: order.refs,
    contentopsRef: null,
    origin: order.origin,
    overdueDays: overdueDaysOf(order, new Date(now)),
    dueLeftDays: dueLeftDaysOf(order, new Date(now)),
    deadlineDefault: order.deadlineDefault,
    facts,
    priceMills: order.priceMills,
    paidWord: order.paidWord,
    holdReason: order.holdReason,
    issue: order.issue,
    fanAskedAt: order.fanAskedAt === null ? null : isoAt(order.fanAskedAt),
    sentAt: order.sentAt === null ? null : isoAt(order.sentAt),
    move: demoMove(order, facts, profile?.username ?? order.buyer, page?.modelName ?? null),
    ...urgency,
    partsDone: order.partsDone,
    openRevisions: order.messages.filter((message) => message.kind === "revision" && message.doneAt === null).length,
    version: order.history.length,
    createdAt: isoAt(order.createdAt),
    updatedAt: isoAt(order.stateAt),
  };
}

/** An order on the board's lists: without its card while the facts screen is on. */
function boardWire(order: DemoOrder, now: number, withCard: boolean): CustomBoardOrder {
  const { card, ...rest } = wire(order, now);
  return { ...rest, ...(withCard ? { card } : {}), volume: card.duration ?? null };
}

function visible(viewer: CustomViewer, order: DemoOrder): boolean {
  if (viewer.lead || viewer.role === "owner") return true;
  const pageId = pageIdOf(order.page);
  if (pageId === null) return viewer.role === "team_lead";
  return viewer.pageIds.includes(pageId);
}

const rightsOf = (order: DemoOrder) => ({
  pageId: pageIdOf(order.page), state: order.state, acceptedByUserId: DEMO_USERS.find((user) => user.username === order.acceptedBy)?.id ?? null,
  holdReason: order.holdReason, issue: order.issue,
});

function historyOf(order: DemoOrder): CustomOrderDetailResponse["history"] {
  return order.history.map((item, index) => ({ id: order.id * 1000 + index + 1, ...item }));
}

function detail(request: DemoRequest, order: DemoOrder): CustomOrderDetailResponse {
  const now = request.now.getTime();
  const viewer = viewerOf(request);
  const wired = wire(order, now);
  const fanRef = order.fanRef;
  const open = ["recorded", "paid", "at_model", "partly", "shot", "revision"].includes(order.state);
  return {
    order: wired,
    cardText: renderCardText({
      id: order.id, card: order.card, deadlineOn: order.deadlineOn, createdAt: new Date(order.createdAt), buyer: order.buyer,
      fan: wired.fan === null ? null : { platform: wired.fan.platform, fanRef: wired.fan.fanRef, username: wired.fan.username },
    }),
    sourceText: order.origin === "import" ? renderCardText({ id: order.id, card: order.card, deadlineOn: order.deadlineOn, createdAt: new Date(order.createdAt), buyer: order.buyer, fan: null }).replace(/ K-\d+/u, "") : null,
    messages: order.messages,
    payments: order.payments.map((payment) => ({ transactionRef: payment.ref, kind: payment.kind, grossMills: payment.gross, netMills: Math.round(payment.gross * 0.8), at: isoAt(payment.at), note: payment.note })),
    paymentSuggestions: fanRef !== null && order.state !== "cancelled" && order.payments.length < 2
      ? [{ transactionRef: String(7_000_000 + order.id), kind: "tip", grossMills: 50_000, netMills: 40_000, at: isoAt(order.createdAt + 40 * 60_000), note: order.id % 2 === 0 ? "for the custom" : null }]
      : [],
    deliverySuggestions: fanRef !== null && open && order.state !== "recorded"
      ? [{ messageRef: String(990_000_000_000 + order.id), at: isoAt(Math.min(now, order.stateAt + 2 * HOUR)), mediaCount: 1, priceMills: null }]
      : [],
    history: historyOf(order),
    actions: stepsFor(viewer, rightsOf(order)),
    serverNow: request.now.toISOString(),
  };
}

function findOrder(request: DemoRequest): DemoOrder | undefined {
  const id = parseCustomOrderCode(request.params.code ?? "");
  const order = storeOf(request).find((one) => one.id === id);
  return order && visible(viewerOf(request), order) ? order : undefined;
}

function lookalikes(request: DemoRequest): KernelOperationResponse<"customOrdersBoard">["lookalikes"] {
  if (sizeOf(request) === 0) return [];
  const now = request.now.getTime();
  const viewer = viewerOf(request);
  const seeds = [
    { ref: "6100000001", page: "mia-1", kind: "tier" as const, detail: "Master (Free long custom video, Maximum Attention) 👑", gross: 100_000, at: now - 5 * HOUR },
    { ref: "6100000002", page: "nova-1", kind: "tip_note" as const, detail: "for my custom vid", gross: 60_000, at: now - 26 * HOUR },
    { ref: "6100000003", page: "mia-2", kind: "tier" as const, detail: "Advanced (Free custom, Close friends & More Attention) 💎", gross: 50_000, at: now - 31 * HOUR },
    { ref: "6100000004", page: "ivy-2", kind: "tip_note" as const, detail: "custom pls, the one we talked about", gross: 80_000, at: now - 50 * HOUR },
    { ref: "6100000005", page: "mia-3", kind: "tier" as const, detail: "Master (Free Sexting or Custom video) 👑", gross: 100_000, at: now - 70 * HOUR },
  ].slice(0, sizeOf(request) === 60 ? 5 : 2);
  return seeds
    .filter((seed) => !dismissed.has(seed.ref) && !storeOf(request).some((order) => order.payments.some((payment) => payment.ref === seed.ref)))
    .filter((seed) => viewer.role === "owner" || viewer.lead || viewer.pageIds.includes(pageIdOf(seed.page) ?? -1))
    .map((seed) => {
      const fan = demoFans(seed.page)[3]!;
      const profile = demoFanProfile(fan);
      return {
        transactionRef: seed.ref, pageLabel: seed.page,
        fan: { platform: "fansly", fanRef: fan.platformUserId, username: profile.username, displayName: profile.displayName },
        kind: seed.kind, detail: seed.detail, grossMills: seed.gross, at: isoAt(seed.at),
      };
    });
}

// ── Findings: a custom with no order ────────────────────────────────────────

interface DemoFinding {
  id: number;
  source: CustomFinding["source"];
  page: string | null;
  fanIndex: number | null;
  amount: number | null;
  quote: string;
  hoursAgo: number;
}

const FINDINGS: readonly DemoFinding[] = [
  { id: 501, source: "sale", page: "mia-1", fanIndex: 5, amount: 320_000, quote: "can we do the beach one for 320?", hoursAgo: 30 },
  { id: 502, source: "fan_chat", page: "mia-2", fanIndex: 8, amount: 90_000, quote: "ok then the video with the red dress", hoursAgo: 52 },
  { id: 503, source: "fan_chat", page: "nova-1", fanIndex: 4, amount: 130_000, quote: "send me the price for a personal video", hoursAgo: 8 },
  { id: 504, source: "sale", page: "ivy-1", fanIndex: 6, amount: 75_000, quote: "for the special video", hoursAgo: 75 },
  { id: 505, source: "work_chat", page: null, fanIndex: null, amount: null, quote: "📦 Описание заказа: йога в белом, 6 минут", hoursAgo: 20 },
  { id: 506, source: "shift_report", page: "mia-3", fanIndex: 9, amount: 45_000, quote: "кастом, фото в купальнике", hoursAgo: 40 },
];
/** The findings answered in this demo: recorded, linked or dismissed. */
const resolved = new Map<number, { status: CustomFinding["status"]; orderCode: string | null; reason: CustomFinding["dismissReason"] }>();

function findingWire(finding: DemoFinding, now: number): CustomFinding {
  const fan = finding.page === null || finding.fanIndex === null ? undefined : demoFans(finding.page)[finding.fanIndex];
  const profile = fan ? demoFanProfile(fan) : null;
  const page = finding.page === null ? undefined : DEMO_DATA_PAGES.find((one) => one.label === finding.page);
  const done = resolved.get(finding.id);
  return {
    id: finding.id, source: finding.source, ref: `demo:${finding.id}`, pageLabel: finding.page,
    fan: fan && page ? { platform: page.platform, fanRef: fan.platformUserId, username: profile!.username ?? fan.username, displayName: profile!.displayName } : null,
    amountMills: finding.amount, quote: finding.quote, happenedAt: isoAt(now - finding.hoursAgo * HOUR),
    status: done?.status ?? "open", orderCode: done?.orderCode ?? null, dismissReason: done?.reason ?? null,
    resolvedAt: done ? isoAt(now) : null, createdAt: isoAt(now - finding.hoursAgo * HOUR + HOUR),
  };
}

/** Who resolves findings in the demo: the owner, a team lead and the lead. */
const resolvesFindings = (viewer: CustomViewer) => viewer.role !== "chatter" || viewer.lead;

function openFindings(request: DemoRequest): CustomFinding[] {
  if (sizeOf(request) === 0 || !resolvesFindings(viewerOf(request))) return [];
  const now = request.now.getTime();
  return FINDINGS.filter((finding) => !resolved.has(finding.id)).map((finding) => findingWire(finding, now));
}

function actOnFinding(request: DemoRequest, body: CustomFindingActionBody) {
  const id = Number(request.params.findingId);
  const finding = FINDINGS.find((one) => one.id === id);
  if (!finding || !resolvesFindings(viewerOf(request))) return demoError(404, "Not Found", "Находка не найдена");
  if (resolved.has(id)) return demoError(409, "Conflict", "Находку уже разобрали");
  const now = request.now.getTime();
  if (body.action === "dismiss") resolved.set(id, { status: "dismissed", orderCode: null, reason: body.reason });
  if (body.action === "link") resolved.set(id, { status: "linked", orderCode: body.code, reason: null });
  if (body.action === "record") {
    const store = storeOf(request);
    const page = finding.page ?? body.pageLabel ?? MAIN_PAGES[0]!.label;
    const fan = finding.fanIndex === null ? null : demoFans(page)[finding.fanIndex] ?? null;
    const user = demoUserByRole(request.role);
    const order: DemoOrder = {
      id: 101 + store.length + 1000, page, fanRef: fan?.platformUserId ?? null, buyer: fan === null ? body.fan ?? null : null, card: body.card, deadlineOn: null,
      state: finding.source === "sale" ? "paid" : "recorded", stateAt: now, stateNote: null, acceptedBy: user.username, origin: "workboard", createdAt: now,
      payments: finding.source === "sale" && finding.amount !== null ? [{ ref: `61${finding.id}`, kind: "tip", gross: finding.amount, at: now - finding.hoursAgo * HOUR, note: null }] : [],
      givenAt: null, refs: [], partsDone: [], messages: [],
      history: [{ at: isoAt(now), event: "custom_order.recorded", actor: user.name, onBehalfOf: null, door: "workboard", changes: {} }],
      priceMills: finding.amount, deadlineDefault: false, paidWord: null, holdReason: null, issue: null, fanAskedAt: null, sentAt: null, reversed: false,
    };
    store.push(order);
    resolved.set(id, { status: "recorded", orderCode: customOrderCode(order.id), reason: null });
  }
  return { finding: findingWire(finding, now) };
}

// ── What changed by itself ──────────────────────────────────────────────────

/** The last day's steps of the system's and the agents' doors on the viewer's orders, the newest first. */
function selfChanges(request: DemoRequest): CustomSelfChange[] {
  const now = request.now.getTime();
  const viewer = viewerOf(request);
  const changes: CustomSelfChange[] = [];
  for (const order of storeOf(request)) {
    if (!visible(viewer, order)) continue;
    const steps = new Set(stepsFor(viewer, rightsOf(order)));
    const wired = wire(order, now);
    const name = wired.fan?.username ?? wired.fan?.displayName ?? order.buyer;
    historyOf(order).forEach((item) => {
      if ((item.door !== "system" && item.door !== "api") || Date.parse(item.at) < now - DAY) return;
      const sale = typeof item.changes.transactionId === "string" ? item.changes.transactionId : null;
      const telegramRef = typeof item.changes.telegramRef === "string" ? item.changes.telegramRef : null;
      const applied = item.event === "custom_order.payment" ? order.payments.some((payment) => payment.ref === sale)
        : item.event === "custom_order.delivery" ? order.messages.some((message) => message.kind === "delivery" && message.retractedAt === null && message.telegramRef === telegramRef)
        : null;
      changes.push({
        id: item.id, at: item.at, code: wired.code, fan: name, event: item.event, door: item.door, actor: item.door === "api" ? item.actor : null,
        changes: item.changes, undo: customUndoOf(item, wired, applied, (action) => steps.has(action)),
      });
    });
  }
  return changes.sort((left, right) => right.at.localeCompare(left.at) || right.id - left.id);
}

function act(request: DemoRequest, order: DemoOrder, body: CustomOrderActionBody) {
  const now = request.now.getTime();
  const user = demoUserByRole(request.role);
  const from = order.state;
  if (!STEP_FROM[body.action].includes(from)) return demoError(409, "Conflict", "Этот шаг сейчас недоступен");
  const move = (to: CustomOrderState, note: string | null = null) => {
    order.state = to;
    order.stateAt = now;
    order.stateNote = note;
  };
  let event: string = body.action;
  switch (body.action) {
    case "edit": order.card = body.card; event = "edited"; break;
    case "deadline": order.deadlineOn = body.deadlineOn; order.deadlineDefault = false; break;
    case "fan": order.page = body.pageLabel; order.fanRef = demoFans(body.pageLabel)[2]?.platformUserId ?? null; order.buyer = null; event = "fan_confirmed"; break;
    case "card": order.refs.push(body.telegramRef); break;
    case "payment":
      order.payments.push({ ref: body.transactionRef, kind: "tip", gross: 50_000, at: order.createdAt + 40 * 60_000, note: null });
      if (from === "recorded") move("paid");
      break;
    case "unpay": order.payments = order.payments.filter((payment) => payment.ref !== body.transactionRef); order.reversed = false; event = "payment_removed"; break;
    case "given": order.givenAt = now; order.sentAt = null; order.fanAskedAt = null; move("given"); break;
    case "ungive": order.givenAt = null; move("shot"); event = "ungiven"; break;
    case "refused": move("refused", body.reason); break;
    case "partly": move("partly", body.note ?? null); break;
    case "retract":
      // As Hub does, roughly: the delivery stops counting, the order goes back to the model.
      order.messages = order.messages.map((message) => (message.kind === "delivery" && message.retractedAt === null && (message.telegramRef === body.retracts || message.eventRef === body.retracts) ? { ...message, retractedAt: isoAt(now) } : message));
      order.partsDone = [];
      if (["shot", "partly", "revision"].includes(from)) move("at_model");
      event = "retracted";
      break;
    case "revision": {
      // As Hub does: the request is a message of the order, and it sends back the parts it is about.
      const wanted = wantedParts(order.card);
      const about = body.part !== undefined && wanted.includes(body.part) ? [body.part] : wanted;
      order.partsDone = order.partsDone.filter((part) => !about.includes(part));
      order.messages.push({
        telegramRef: null, eventRef: `workboard:revision:${order.history.length + 1}`, ordinal: 0, kind: "revision", part: body.part ?? null, complete: null,
        at: isoAt(now), author: null, excerpt: body.note ?? null, doneAt: null, retractedAt: null,
      });
      order.sentAt = null;
      if (from === "given") order.givenAt = null;
      move("revision", body.note ?? null);
      break;
    }
    case "shot":
      // «Снят» by a person: every part whole, every open request fixed.
      order.partsDone = wantedParts(order.card);
      order.messages = order.messages.map((message) => (message.kind === "revision" && message.doneAt === null ? { ...message, doneAt: isoAt(now) } : message));
      move("shot");
      break;
    case "hold": order.holdReason = body.reason; break;
    case "unhold": order.holdReason = null; break;
    case "issue_clear": order.issue = null; event = "issue_cleared"; break;
    case "paid_word":
      order.paidWord = body.word === null ? null : { kind: body.word.kind, note: body.word.note ?? null, by: user.name, at: isoAt(now) };
      break;
    case "cancel": order.payments = []; move("cancelled", body.reason ?? null); event = "cancelled"; break;
    case "close": move("closed"); event = "closed"; break;
    default: move(STEP_TO[body.action]!);
  }
  order.history.push({
    at: isoAt(now), event: `custom_order.${event}`, actor: user.name, onBehalfOf: null, door: "workboard",
    changes: "undoOf" in body && body.undoOf !== undefined ? { undoOf: body.undoOf } : {},
  });
  return detail(request, order);
}

export const wbCustomsHandlers: DemoHandlers = {
  customOrdersBoard: (request) => {
    const viewer = viewerOf(request);
    const now = request.now.getTime();
    const factsOn = factsOnOf(request);
    const page = typeof request.query.pageLabel === "string" ? request.query.pageLabel : null;
    const mine = storeOf(request).filter((order) => visible(viewer, order)).filter((order) => page === null || order.page === page || order.page === null);
    const orders = mine
      .filter((order) => (factsOn
        ? !["given", "closed", "cancelled"].includes(order.state)
        : order.state !== "cancelled" && !((order.state === "given" || order.state === "closed") && (order.givenAt ?? 0) < now - 7 * DAY)))
      .sort((left, right) => left.stateAt - right.stateAt);
    const findings = factsOn ? openFindings(request) : [];
    const changes = factsOn ? selfChanges(request) : [];
    const fans = [...new Set(findings.map((finding) => finding.fan?.username ?? finding.fan?.displayName).filter((name): name is string => typeof name === "string"))];
    return {
      viewer: { lead: viewer.lead || viewer.role !== "chatter", owner: viewer.role === "owner", name: demoUserByRole(request.role).name },
      leads: [{ model: "Mia Hart", check: "Марта", shoot: "Вера" }, { model: "Ivy Rose", check: "Марта", shoot: "Марта" }],
      factsOn,
      orders: orders.map((order) => boardWire(order, now, !factsOn)),
      capped: false,
      lookalikes: factsOn ? [] : lookalikes(request).filter((sale) => page === null || sale.pageLabel === page),
      // The reader checked twelve minutes ago, the nightly pass nine hours ago; with no orders, never (stale). The cookie
      // `hub-demo-customs-stale=1` makes it three hours late.
      verified: sizeOf(request) === 0
        ? { readerAt: null, nightlyAt: null, readerStale: true }
        : request.cookie?.("hub-demo-customs-stale") === "1"
          ? { readerAt: isoAt(now - 3 * HOUR - 12 * 60_000), nightlyAt: isoAt(now - 9 * HOUR), readerStale: true }
          : { readerAt: isoAt(now - 12 * 60_000), nightlyAt: isoAt(now - 9 * HOUR), readerStale: false },
      findings: { open: findings.length, amountMills: findings.reduce((sum, finding) => sum + (finding.amountMills ?? 0), 0), fans: fans.slice(0, 3) },
      changes: { count: changes.length, newest: changes[0] ?? null },
      done: factsOn
        ? { given: mine.filter((order) => order.state === "given").length, closed: mine.filter((order) => order.state === "closed" && order.stateAt >= now - 30 * DAY).length }
        : { given: 0, closed: 0 },
      serverNow: request.now.toISOString(),
    };
  },
  customOrdersDone: (request) => {
    const viewer = viewerOf(request);
    const now = request.now.getTime();
    const days = Number(request.query.days ?? 30) || 30;
    const mine = storeOf(request).filter((order) => visible(viewer, order)).sort((left, right) => right.stateAt - left.stateAt);
    return {
      given: mine.filter((order) => order.state === "given").map((order) => boardWire(order, now, false)),
      closed: mine.filter((order) => order.state === "closed" && order.stateAt >= now - days * DAY).map((order) => boardWire(order, now, false)),
      capped: false,
      serverNow: request.now.toISOString(),
    };
  },
  customFindingsList: (request) => ({ findings: openFindings(request), serverNow: request.now.toISOString() }),
  customFindingAct: (request) => actOnFinding(request, request.body as CustomFindingActionBody),
  customOrderChanges: (request) => ({ changes: selfChanges(request), serverNow: request.now.toISOString() }),
  customOrder: (request) => {
    const order = findOrder(request);
    return order ? detail(request, order) : demoError(404, "Not Found", "Заказ не найден");
  },
  customOrderAct: (request) => {
    const order = findOrder(request);
    if (!order) return demoError(404, "Not Found", "Заказ не найден");
    return act(request, order, request.body as CustomOrderActionBody);
  },
  customOrderCreate: (request) => {
    const body = request.body as { transactionRef?: string; pageLabel?: string; fan?: string; card: CustomOrderCard };
    const sale = lookalikes(request).find((one) => one.transactionRef === body.transactionRef);
    if (body.transactionRef !== undefined && !sale) return demoError(404, "Not Found", "Продажа не найдена");
    const pageLabel = sale?.pageLabel ?? body.pageLabel ?? MAIN_PAGES[0]!.label;
    const store = storeOf(request);
    const now = request.now.getTime();
    const user = demoUserByRole(request.role);
    const order: DemoOrder = {
      id: 101 + store.length + 1000, page: pageLabel, fanRef: sale?.fan?.fanRef ?? null, buyer: sale ? null : body.fan ?? null, card: body.card, deadlineOn: null,
      state: sale ? "paid" : "recorded", stateAt: now, stateNote: null, acceptedBy: user.username, origin: "workboard", createdAt: now,
      payments: sale ? [{ ref: sale.transactionRef, kind: sale.kind === "tier" ? "subscription" : "tip", gross: sale.grossMills, at: Date.parse(sale.at), note: sale.kind === "tip_note" ? sale.detail : null }] : [],
      givenAt: null, refs: [], partsDone: [], messages: [],
      history: [{ at: isoAt(now), event: "custom_order.recorded", actor: user.name, onBehalfOf: null, door: "workboard", changes: {} }],
      priceMills: null, deadlineDefault: false, paidWord: null, holdReason: null, issue: null, fanAskedAt: null, sentAt: null, reversed: false,
    };
    store.push(order);
    return detail(request, order);
  },
  customSaleDismiss: (request) => {
    dismissed.add(request.params.transactionRef ?? "");
    return { dismissed: true };
  },
};
