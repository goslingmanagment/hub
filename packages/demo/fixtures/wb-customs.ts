/**
 * Workboard «Кастомы» (package I): the board, an order's page and its steps,
 * over invented orders of the demo agency, kept in memory with their writes.
 * The cookie `hub-demo-customs` picks how many orders there are (0, 9 — the
 * default — or 60); `hub-demo-customs-as=lead` makes the chatter the lead
 * («ведёт кастомы»).
 */
import {
  customOrderCode,
  parseCustomOrderCode,
  renderCardText,
  STEP_FROM,
  STEP_TO,
  stepsFor,
  whatOf,
  overdueDaysOf,
  type CustomOrder,
  type CustomOrderActionBody,
  type CustomOrderCard,
  type CustomOrderDetailResponse,
  type CustomOrderState,
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
  history: CustomOrderDetailResponse["history"];
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
/** The order of steps the seeds walk through; the board shows every column. */
const STATE_CYCLE: readonly CustomOrderState[] = ["at_model", "paid", "shot", "recorded", "at_model", "partly", "given", "revision", "shot", "paid", "at_model", "closed", "refused", "given"];

const DEMO_CHAT = "1000000001";
/** A person as the people registry names them (the demo's users carry the name). */
const nameOf = (login: string | null) => (login === null ? null : DEMO_USERS.find((user) => user.username === login)?.name ?? login);

function seedOrders(count: number, now: number): DemoOrder[] {
  const pages = DEMO_DATA_PAGES.filter((page) => page.label !== "mia-tg");
  const random = rng(`customs:${count}`);
  const orders: DemoOrder[] = [];
  for (let index = 0; index < count; index += 1) {
    const page = pages[index % pages.length]!;
    const fans = demoFans(page.label).filter((fan) => fan.totalSpent > 0);
    const fan = fans[(index * 7) % Math.max(1, fans.length)] ?? demoFans(page.label)[0]!;
    const state = STATE_CYCLE[index % STATE_CYCLE.length]!;
    const ageDays = 0.4 + random() * 9;
    const createdAt = now - Math.round(ageDays * DAY);
    const stepAt = createdAt + Math.round((now - createdAt) * (0.3 + random() * 0.6));
    const chatters = DEMO_USERS.filter((user) => user.role === "chatter" && user.active && user.pages.includes(page.label));
    const acceptor = chatters[index % Math.max(1, chatters.length)]?.username ?? "alex.k";
    // Every seventh is an imported card whose fan and page nobody confirmed yet.
    const imported = index % 7 === 5;
    const deadlineShift = [3, -2, 1, 5, 0, -4, 6][index % 7]!;
    const deadlineOn = index % 5 === 3 ? null : mskDay(now + deadlineShift * DAY);
    const price = PRICES[index % PRICES.length]!;
    const paid = state !== "recorded";
    const gross = 50_000 + (index % 6) * 50_000;
    const history: DemoOrder["history"] = [{ at: isoAt(createdAt), event: "custom_order.recorded", actor: imported ? null : nameOf(acceptor), onBehalfOf: null, door: imported ? "system" : index % 2 === 0 ? "extension" : "api", changes: {} }];
    if (paid && !imported) history.push({ at: isoAt(createdAt + 20 * 60_000), event: "custom_order.payment", actor: nameOf(acceptor), onBehalfOf: null, door: "extension", changes: {} });
    if (!["recorded", "paid"].includes(state)) history.push({ at: isoAt(createdAt + 6 * HOUR), event: "custom_order.at_model", actor: "Катя", onBehalfOf: null, door: "workboard", changes: {} });
    if (["shot", "given", "closed", "revision"].includes(state)) history.push({ at: isoAt(stepAt), event: "custom_order.delivery", actor: "Читатель групп", onBehalfOf: null, door: "api", changes: {} });
    if (state === "partly" || state === "revision" || state === "refused") history.push({ at: isoAt(stepAt), event: `custom_order.${state}`, actor: "Катя", onBehalfOf: null, door: "workboard", changes: {} });
    if (state === "given" || state === "closed") history.push({ at: isoAt(stepAt + 3 * HOUR), event: "custom_order.given", actor: nameOf(acceptor), onBehalfOf: null, door: "extension", changes: {} });
    orders.push({
      id: 101 + index,
      page: imported && index % 2 === 1 ? null : page.label,
      fanRef: imported ? null : fan.platformUserId,
      buyer: imported ? `${fan.username} (${fan.username})` : null,
      card: {
        price,
        duration: TASKS[index % TASKS.length]!.startsWith("10 фото") ? "10 фото" : `${4 + (index % 5)} минут`,
        task: TASKS[index % TASKS.length]!,
        clothes: CLOTHES[index % CLOTHES.length]!,
        notes: "Снимаешь вертикально.",
        urgency: ["Средняя", "Высокая", "Низкая"][index % 3]!,
      },
      deadlineOn,
      state,
      stateAt: ["recorded", "paid"].includes(state) ? createdAt : stepAt,
      stateNote: state === "refused" ? "Модель не снимает такие сцены" : state === "revision" ? "Фан просит без музыки" : state === "partly" ? "Видео есть, фото ещё ждём" : null,
      acceptedBy: imported ? null : acceptor,
      origin: imported ? "import" : index % 2 === 0 ? "extension" : "agent",
      createdAt,
      payments: paid && !imported ? [{ ref: String(8_000_000 + index), kind: index % 3 === 0 ? "subscription" : "tip", gross, at: createdAt - 15 * 60_000, note: null }] : [],
      givenAt: state === "given" || state === "closed" ? stepAt + 3 * HOUR : null,
      refs: [`tg:${DEMO_CHAT}/3/${10_000 + index}`],
      history,
    });
  }
  return orders;
}

const stores = new Map<string, DemoOrder[]>();
const dismissed = new Set<string>();

function sizeOf(request: DemoRequest): number {
  const value = Number(request.cookie?.("hub-demo-customs") ?? "9");
  return [0, 9, 60].includes(value) ? value : 9;
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

const pageIdOf = (label: string | null) => (label === null ? null : DEMO_DATA_PAGES.find((page) => page.label === label)?.id ?? null);

function wire(order: DemoOrder, now: number): CustomOrder {
  const page = order.page === null ? undefined : DEMO_DATA_PAGES.find((one) => one.label === order.page);
  const fan = order.fanRef === null || order.page === null ? undefined : demoFans(order.page).find((one) => one.platformUserId === order.fanRef);
  const profile = fan ? demoFanProfile(fan) : null;
  return {
    id: order.id,
    code: customOrderCode(order.id),
    pageLabel: order.page,
    platform: page?.platform ?? null,
    model: page?.modelName ?? null,
    fan: fan && page ? { platform: page.platform, fanRef: fan.platformUserId, username: profile!.username, displayName: profile!.displayName } : null,
    buyer: order.fanRef === null ? order.buyer : null,
    fanErased: false,
    card: order.card,
    what: whatOf(order.card),
    deadlineOn: order.deadlineOn,
    state: order.state,
    stateAt: isoAt(order.stateAt),
    stateNote: order.stateNote,
    stateRef: null,
    paidGrossMills: order.payments.reduce((sum, payment) => sum + payment.gross, 0),
    paidNetMills: order.payments.reduce((sum, payment) => sum + Math.round(payment.gross * 0.8), 0),
    payments: order.payments.length,
    givenAt: order.givenAt === null ? null : isoAt(order.givenAt),
    givenMessageRef: order.givenAt === null ? null : "990000000001",
    acceptedBy: order.acceptedBy,
    acceptedByName: nameOf(order.acceptedBy),
    telegramRefs: order.refs,
    contentopsRef: null,
    origin: order.origin,
    overdueDays: overdueDaysOf(order, new Date(now)),
    partsDone: ["shot", "given", "closed"].includes(order.state) ? ["video"] : [],
    openRevisions: order.state === "revision" ? 1 : 0,
    version: order.history.length,
    createdAt: isoAt(order.createdAt),
    updatedAt: isoAt(order.stateAt),
  };
}

function visible(viewer: CustomViewer, order: DemoOrder): boolean {
  if (viewer.lead || viewer.role === "owner") return true;
  const pageId = pageIdOf(order.page);
  if (pageId === null) return viewer.role === "team_lead";
  return viewer.pageIds.includes(pageId);
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
    messages: ["shot", "given", "closed", "revision", "partly"].includes(order.state)
      ? [{ telegramRef: `tg:${DEMO_CHAT}/3/${20_000 + order.id}`, ordinal: 0, kind: "delivery", part: "video", at: isoAt(order.stateAt), author: "Модель", excerpt: "6-12 кастом в красном.mov", doneAt: null }]
      : [],
    payments: order.payments.map((payment) => ({ transactionRef: payment.ref, kind: payment.kind, grossMills: payment.gross, netMills: Math.round(payment.gross * 0.8), at: isoAt(payment.at), note: payment.note })),
    paymentSuggestions: fanRef !== null && order.state !== "cancelled" && order.payments.length < 2
      ? [{ transactionRef: String(7_000_000 + order.id), kind: "tip", grossMills: 50_000, netMills: 40_000, at: isoAt(order.createdAt + 40 * 60_000), note: order.id % 2 === 0 ? "for the custom" : null }]
      : [],
    deliverySuggestions: fanRef !== null && open && order.state !== "recorded"
      ? [{ messageRef: String(990_000_000_000 + order.id), at: isoAt(Math.min(now, order.stateAt + 2 * HOUR)), mediaCount: 1, priceMills: null }]
      : [],
    history: order.history,
    actions: stepsFor(viewer, { pageId: pageIdOf(order.page), state: order.state, acceptedByUserId: DEMO_USERS.find((user) => user.username === order.acceptedBy)?.id ?? null }),
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
  switch (body.action) {
    case "edit": order.card = body.card; break;
    case "deadline": order.deadlineOn = body.deadlineOn; break;
    case "fan": order.page = body.pageLabel; order.fanRef = demoFans(body.pageLabel)[2]?.platformUserId ?? null; order.buyer = null; break;
    case "card": order.refs.push(body.telegramRef); break;
    case "payment":
      order.payments.push({ ref: body.transactionRef, kind: "tip", gross: 50_000, at: order.createdAt + 40 * 60_000, note: null });
      if (from === "recorded") move("paid");
      break;
    case "unpay": order.payments = order.payments.filter((payment) => payment.ref !== body.transactionRef); break;
    case "given": order.givenAt = now; move("given"); break;
    case "refused": move("refused", body.reason); break;
    case "partly": case "revision": move(STEP_TO[body.action]!, body.note ?? null); break;
    case "cancel": order.payments = []; move("cancelled", body.reason ?? null); break;
    default: move(STEP_TO[body.action]!);
  }
  order.history.push({ at: isoAt(now), event: `custom_order.${body.action === "given" ? "given" : body.action === "close" ? "closed" : body.action === "cancel" ? "cancelled" : body.action === "edit" ? "edited" : body.action}`, actor: user.name, onBehalfOf: null, door: "workboard", changes: {} });
  return detail(request, order);
}

export const wbCustomsHandlers: DemoHandlers = {
  customOrdersBoard: (request) => {
    const viewer = viewerOf(request);
    const now = request.now.getTime();
    const page = typeof request.query.pageLabel === "string" ? request.query.pageLabel : null;
    const orders = storeOf(request)
      .filter((order) => visible(viewer, order))
      .filter((order) => page === null || order.page === page || order.page === null)
      .filter((order) => order.state !== "cancelled" && !((order.state === "given" || order.state === "closed") && (order.givenAt ?? 0) < now - 7 * DAY))
      .sort((left, right) => left.stateAt - right.stateAt);
    return {
      viewer: { lead: viewer.lead || viewer.role !== "chatter", owner: viewer.role === "owner" },
      leads: ["Катя"],
      orders: orders.map((order) => wire(order, now)),
      capped: false,
      lookalikes: lookalikes(request).filter((sale) => page === null || sale.pageLabel === page),
      serverNow: request.now.toISOString(),
    };
  },
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
    const body = request.body as { transactionRef?: string; card: CustomOrderCard };
    const sale = lookalikes(request).find((one) => one.transactionRef === body.transactionRef);
    if (!sale) return demoError(404, "Not Found", "Продажа не найдена");
    const store = storeOf(request);
    const now = request.now.getTime();
    const user = demoUserByRole(request.role);
    const order: DemoOrder = {
      id: 101 + store.length + 1000, page: sale.pageLabel, fanRef: sale.fan?.fanRef ?? null, buyer: null, card: body.card, deadlineOn: null,
      state: "paid", stateAt: now, stateNote: null, acceptedBy: user.username, origin: "workboard", createdAt: now,
      payments: [{ ref: sale.transactionRef, kind: sale.kind === "tier" ? "subscription" : "tip", gross: sale.grossMills, at: Date.parse(sale.at), note: sale.kind === "tip_note" ? sale.detail : null }],
      givenAt: null, refs: [], history: [{ at: isoAt(now), event: "custom_order.recorded", actor: user.name, onBehalfOf: null, door: "workboard", changes: {} }],
    };
    store.push(order);
    return detail(request, order);
  },
  customSaleDismiss: (request) => {
    dismissed.add(request.params.transactionRef ?? "");
    return { dismissed: true };
  },
};
