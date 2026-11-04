/**
 * A page's fans: the subscriber and follower lists, the deleted accounts, the
 * spender lists, the top fans, one fan's card, dossier, history and chat.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import {
  between,
  daysAgo,
  demoError,
  hashString,
  hoursAgo,
  intBetween,
  iso,
  isoDay,
  pick,
  queryNumber,
  queryString,
  rng,
  type DemoHandlers,
  type DemoReply,
  type DemoRequest,
} from "../core.ts";
import { DEMO_OFAPI_OFF_DAY, DEMO_PAGES, DEMO_USERS, demoPage, type DemoPage } from "../world.ts";
import {
  DAY_MS,
  FAN_LINES,
  MODEL_LINES,
  assignedPage,
  dayOf,
  fanIdentity,
  fanMatches,
  fanTransactions,
  findByConversation,
  findPageFan,
  inWindow,
  metricsOf,
  pageRefShort,
  pagePopulation,
  pageTransactionsOf,
  paginate,
  previousWindow,
  queryBool,
  resolvePage,
  retentionOf,
  spenderPeriodShape,
  spenderWindow,
  windowTxs,
  type CanonicalType,
  type DemoTx,
  type PageFan,
  type Window,
} from "./page-world.ts";

function isReply(value: unknown): value is DemoReply {
  return typeof value === "object" && value !== null && (value as { demoReply?: unknown }).demoReply === true;
}

function at(now: Date, hours: number | null): string | null {
  return hours === null ? null : iso(hoursAgo(now, hours));
}

function centsOf(mills: number): number {
  return Math.round(mills / 10);
}

function lifetimeNet(page: DemoPage, item: PageFan): number {
  return fanTransactions(page, item.fan).reduce((sum, tx) => sum + tx.netMills, 0);
}

function lastTxHours(page: DemoPage, item: PageFan): number | null {
  return fanTransactions(page, item.fan)[0]?.hoursAgo ?? null;
}

function shownName(item: PageFan): string | null {
  return item.fan.displayName === item.fan.username ? null : item.fan.displayName;
}

// --- Subscribers and followers ---

function subscriberItem(page: DemoPage, item: PageFan, now: Date) {
  const sub = item.subscription!;
  const last = lastTxHours(page, item);
  return {
    platformSubscriptionId: sub.id,
    platformUserId: item.fan.platformUserId,
    pageAlias: null,
    username: item.fan.username,
    displayName: shownName(item),
    endsAt: iso(new Date(now.getTime() + sub.endsInHours * 3_600_000)),
    autoRenew: sub.autoRenew,
    autoRenewOffDetectedAt: sub.autoRenewOffDaysAgo === null ? null : iso(daysAgo(now, sub.autoRenewOffDaysAgo, 9)),
    subscriptionTierName: sub.tierName,
    startedAt: iso(hoursAgo(now, sub.startedHoursAgo)),
    totalSpentCents: centsOf(lifetimeNet(page, item)),
    lastTransactionAt: at(now, last),
  };
}

function followerItem(page: DemoPage, item: PageFan, now: Date) {
  const sub = item.subscription;
  const last = lastTxHours(page, item);
  return {
    platformUserId: item.fan.platformUserId,
    pageAlias: null,
    username: item.fan.username,
    displayName: shownName(item),
    followedAt: iso(hoursAgo(now, item.followedHoursAgo ?? 0)),
    isSubscriber: sub !== null,
    subscriberSince: sub ? iso(hoursAgo(now, sub.startedHoursAgo)) : null,
    subscriptionExpiresAt: sub ? iso(new Date(now.getTime() + sub.endsInHours * 3_600_000)) : null,
    autoRenew: sub ? sub.autoRenew : null,
    autoRenewOffDetectedAt: sub?.autoRenewOffDaysAgo != null ? iso(daysAgo(now, sub.autoRenewOffDaysAgo, 9)) : null,
    totalSpentCents: centsOf(lifetimeNet(page, item)),
    lastTransactionAt: at(now, last),
    dm: item.dm
      ? {
        hasConversation: true,
        platformConversationId: item.dm.conversationId,
        unreadCount: item.dm.unreadCount,
        lastMessageAt: iso(hoursAgo(now, item.dm.lastMessageHoursAgo)),
        lastFanMessageAt: at(now, item.dm.lastFanMessageHoursAgo),
        lastModelMessageAt: at(now, item.dm.lastModelMessageHoursAgo),
        lastMessagePreview: item.dm.preview,
      }
      : {
        hasConversation: false,
        platformConversationId: null,
        unreadCount: 0,
        lastMessageAt: null,
        lastFanMessageAt: null,
        lastModelMessageAt: null,
        lastMessagePreview: null,
      },
    presence: {
      status: item.presence.status,
      lastSeenAt: at(now, item.presence.lastSeenHoursAgo),
      observedAt: item.presence.lastSeenHoursAgo === null ? null : iso(hoursAgo(now, 0.1)),
    },
  };
}

/** Days of a daily rollup: the console's period, oldest first. */
function rollupDays(request: DemoRequest): string[] {
  const period = queryString(request, "period") ?? "30d";
  if (period === "custom") {
    const from = queryString(request, "from") ?? isoDay(request.now);
    const to = queryString(request, "to") ?? isoDay(request.now);
    const out: string[] = [];
    for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += DAY_MS) out.push(isoDay(new Date(at)));
    return out;
  }
  const days = period === "today" ? 1 : period === "7d" ? 7 : period === "30d" ? 30 : 120;
  return Array.from({ length: days }, (_, index) => isoDay(daysAgo(request.now, days - 1 - index)));
}

function countByDay(now: Date, hours: Iterable<number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const value of hours) {
    const day = dayOf(now, value);
    out.set(day, (out.get(day) ?? 0) + 1);
  }
  return out;
}

// --- Deleted fans ---

function deletedFans(page: DemoPage, now: Date) {
  const random = rng(`deleted:${page.label}`);
  const count = 3 + Math.floor(pagePopulation(page).length / 1400);
  return Array.from({ length: count }, (_, index) => {
    const handle = `${pick(random, ["jt", "mike", "sk8r", "dave", "anon", "buddy", "cooper", "rick", "fred", "nolan"])}${intBetween(random, 10, 9999)}`;
    const renamed = random() < 0.4;
    const detected = between(random, 6, 24 * 160);
    const known = random() < 0.85;
    return {
      platformUserId: page.platform === "fansly"
        ? `7${String(hashString(`gone:${page.label}:${index}`)).padStart(10, "2")}${String(900000 + index).padStart(7, "0")}`
        : `${300000 + (hashString(`gone:${page.label}:${index}`) % 600000)}`,
      latestKnownLabel: known ? `@${handle}` : null,
      pageAlias: null,
      username: null,
      displayName: null,
      latestHistoricalPageAlias: null,
      latestHistoricalUsername: renamed ? pick(random, ["jt_", "mike_", "dave", "rick"]) + String(intBetween(random, 1, 99)) : null,
      deletedDetectedAt: iso(hoursAgo(now, detected)),
      deletedLastDetectedAt: random() < 0.8 ? iso(hoursAgo(now, Math.min(detected, between(random, 1, 30)))) : null,
      lastSeenAt: iso(hoursAgo(now, detected + between(random, 12, 24 * 20))),
      // Two in three of them paid before they left.
      totalCreatorNetMills: random() < 0.68 ? intBetween(random, 4, 900) * 1000 : 0,
    };
  }).sort((left, right) => right.deletedDetectedAt.localeCompare(left.deletedDetectedAt));
}

// --- The fan's memory ---

const FACTS = [
  ["about", "Работает дальнобойщиком, пишет по вечерам", "yeah im on the road most of the week, usually free after 9"],
  ["about", "Есть собака, зовут Бадди", "buddy says hi lol he never leaves me alone"],
  ["about", "День рождения в марте", "my birthday is coming in march btw"],
  ["promise", "Обещали видео в красном к выходным", "ill have the red set for you by the weekend, promise"],
  ["promise", "Обещали ответить на вопрос про поездку", "let me think about it and ill tell you tomorrow"],
  ["agreement", "Договорились: персональное видео за $60", "ok deal, 60 for the custom one"],
  ["agreement", "Договорились о скидке на следующий набор", "ok next set is cheaper for you then"],
] as const;

const CUSTOMS = [
  ["ordered", "Видео в красном платье, 5 минут", 60_000],
  ["paid", "Набор из 12 фото у окна", 45_000],
  ["delivered", "Поздравление с днём рождения", 30_000],
  ["cancelled", "Видео на улице: передумал", 80_000],
] as const;

/** The fan's card as the console reads it: full for the world's spenders, known but empty for the quiet crowd. */
function fanCard(page: DemoPage, fanRef: string, now: Date): KernelOperationResponse<"pageFanCard"> {
  const empty = { pageLabel: page.label, fanRef, accounts: [], pages: [], suggestions: [], facts: [], customs: [], customPayments: [], serverNow: iso(now) };
  const item = findPageFan(page, fanRef);
  if (!item) return { ...empty, known: false };
  const account = { platform: page.platform, fanRef, username: item.fan.username, displayName: item.fan.displayName === item.fan.username ? null : item.fan.displayName, gone: false };
  const own = metricsOf(fanTransactions(page, item.fan), now);
  const row = (ref: string, spentMills: number) => ({
    pageLabel: page.label, platform: page.platform, modelName: page.modelName, fanRef: ref, granted: true, alias: null,
    subscribed: item.subscription !== null, subscribedSince: null, subscriptionEndsAt: null, spentMills, last30Mills: {}, lastPurchaseAt: own.lastTransactionAt,
  });
  const base = { ...empty, known: true, accounts: [{ ...account, linkedBy: null }], pages: [row(fanRef, own.grossAmountMills)] };
  if (!item.core) return base;

  const random = rng(`card:${page.label}:${fanRef}`);
  const chatter = pick(random, DEMO_USERS.filter((user) => user.role === "chatter")).username;
  const numeric = (salt: string) => `${5_200_000_000 + (hashString(`${fanRef}:${salt}`) % 700_000_000)}000000`;
  const conversationRef = item.dm?.conversationId ?? numeric("chat");
  const facts = FACTS.filter((_, index) => [0, 3, 5].includes(index) || random() < 0.5).map(([kind, text, quote], index) => {
    const at = iso(hoursAgo(now, 30 + index * 70));
    return {
      id: hashString(`${fanRef}:fact:${index}`) % 1_000_000 + 1,
      kind, text, pageLabel: page.label, granted: true, conversationRef, messageRef: numeric(`fact:${index}`), messageAt: at,
      source: index === 0 ? "chatter" : "ai", author: index === 0 ? chatter : null, createdAt: at,
      quote: { text: quote, from: kind === "about" ? "fan" : "model", at, media: false },
    };
  });
  const customs = CUSTOMS.map(([state, description, priceMills], index) => {
    const created = hoursAgo(now, 40 + index * 90);
    const paid = state === "paid" || state === "delivered";
    return {
      id: hashString(`${fanRef}:custom:${index}`) % 1_000_000 + 1,
      pageLabel: page.label, granted: true, description, priceMills, state,
      paymentMills: paid ? priceMills : null,
      paidAt: paid ? iso(created) : null,
      deliveredMessageRef: state === "delivered" ? numeric("delivered") : null,
      deliveredAt: state === "delivered" ? iso(hoursAgo(now, 30)) : null,
      createdBy: chatter, createdAt: iso(created), deliveryCandidates: [],
    };
  });
  const other = (salt: string, username: string) => ({
    platform: page.platform, fanRef: `7${String(hashString(`${fanRef}:${salt}`)).padStart(10, "3")}`, username, displayName: null, gone: salt === "linked",
  });
  const linked = other("linked", `${item.fan.username ?? "fan"}_old`);
  const suggested = other("suggested", `${item.fan.username ?? "fan"}_two`);
  return {
    ...base,
    accounts: [{ ...account, linkedBy: null }, { ...linked, linkedBy: chatter }],
    suggestions: [{ ...suggested, reason: "same_alias", shared: `${item.fan.username ?? "fan"}/USA/34`, sharedOn: page.label, pages: [row(suggested.fanRef, 12_000)] }],
    facts,
    customs,
  };
}

// --- Spender lists ---

const BUCKETS = [
  { key: "0-25", label: "[FB] $0-$25 Spenders", min: 10, max: 25_000 },
  { key: "25-50", label: "[FB] $25-$50 Spenders", min: 25_000, max: 50_000 },
  { key: "50-150", label: "[FB] $50-$150 Spenders", min: 50_000, max: 150_000 },
  { key: "150-350", label: "[FB] $150-$350 Spenders", min: 150_000, max: 350_000 },
  { key: "350-600", label: "[FB] $350-$600 Spenders", min: 350_000, max: 600_000 },
  { key: "600-plus", label: "[FB] $600+ Spenders", min: 600_000, max: null },
] as const;

type Bucket = (typeof BUCKETS)[number];

interface SpenderRow {
  page: DemoPage;
  item: PageFan;
  window: ReturnType<typeof metricsOf>;
  lifetime: ReturnType<typeof metricsOf>;
}

function spenderRows(pages: readonly DemoPage[], window: Window, now: Date): SpenderRow[] {
  const out: SpenderRow[] = [];
  for (const page of pages) {
    for (const item of pagePopulation(page)) {
      if (item.fan.totalSpent <= 0) continue;
      const all = fanTransactions(page, item.fan);
      if (all.length === 0) continue;
      const inside = window.fromDay === null ? all : all.filter((tx) => inWindow(window, now, tx.hoursAgo));
      if (inside.length === 0) continue;
      out.push({ page, item, window: metricsOf(inside, now), lifetime: metricsOf(all, now) });
    }
  }
  return out;
}

/** Over several pages one row a fan: his money summed over the pages, his newest page's chat. */
function onePerFan(rows: SpenderRow[], window: Window, now: Date): SpenderRow[] {
  const byFan = new Map<string, SpenderRow[]>();
  for (const row of rows) byFan.set(row.item.fan.platformUserId, [...(byFan.get(row.item.fan.platformUserId) ?? []), row]);
  return [...byFan.values()].map((group) => {
    if (group.length === 1) return group[0]!;
    const all = group.flatMap((row) => fanTransactions(row.page, row.item.fan));
    const inside = window.fromDay === null ? all : all.filter((tx) => inWindow(window, now, tx.hoursAgo));
    const first = [...group].sort((left, right) => right.lifetime.creatorNetAmountMills - left.lifetime.creatorNetAmountMills)[0]!;
    return { page: first.page, item: { ...first.item, fan: { ...first.item.fan, totalSpent: group.reduce((sum, row) => sum + row.item.fan.totalSpent, 0) } }, window: metricsOf(inside, now), lifetime: metricsOf(all, now) };
  });
}

/** A few payers of every page the page no longer sees, some of them with money. */
function pageMisses(page: DemoPage, item: PageFan): boolean {
  if (!item.core || item.fan.totalSpent <= 0) return false;
  return hashString(`miss:${page.label}:${item.fan.platformUserId}`) % 23 === 0;
}

function bucketOf(row: SpenderRow, window: Window): Bucket | undefined {
  const amount = window.fromDay === null ? row.lifetime.grossAmountMills : row.window.grossAmountMills;
  return BUCKETS.find((bucket) => amount >= bucket.min && (bucket.max === null || amount < bucket.max));
}

function bucketShape(bucket: Bucket, entryCount: number) {
  return { key: bucket.key, label: bucket.label, minAmountMills: bucket.min, maxAmountMillsExclusive: bucket.max, entryCount };
}

// --- One fan ---

const NOTE_TEXTS = [
  "Любит, когда пишут первой утром. Работает в ночную смену, отвечает после 14:00 МСК.",
  "Покупает видео только с превью, фото не берёт. Цена до $25 — без торга.",
  "Просил кастом на день рождения (12 декабря). Напомнить за неделю.",
  "Не любит слово «babe», лучше по имени. Разведён, есть собака Рокки.",
  "Ушёл в минус по деньгам в октябре, не давить с PPV до зарплаты (пятница).",
  "Ревнует к другим фанам — не упоминать стримы.",
] as const;

function fanNotes(page: DemoPage, item: PageFan, now: Date) {
  const random = rng(`notes:${page.label}:${item.fan.platformUserId}`);
  if (!item.core || item.fan.totalSpent < 20) return [];
  const authors = DEMO_USERS.filter((user) => user.role !== "owner" && user.active && user.pages.includes(page.label));
  const count = item.fan.totalSpent > 300 ? 3 : item.fan.totalSpent > 80 ? 2 : 1;
  return Array.from({ length: count }, (_, index) => ({
    id: 1000 + (hashString(`${page.label}:${item.fan.platformUserId}`) % 50000) + index,
    authorUserId: authors.length > 0 ? pick(random, authors).id : null,
    body: NOTE_TEXTS[(hashString(item.fan.platformUserId) + index * 2) % NOTE_TEXTS.length]!,
    createdAt: iso(hoursAgo(now, between(random, 10, 24 * 60) * (count - index))),
  })).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function fanFlags(page: DemoPage, item: PageFan, now: Date) {
  const net = lifetimeNet(page, item);
  const flags: { flag: "whale" | "vip" | "risky"; createdAt: string; createdByUserId: number | null }[] = [];
  if (net >= 600_000) flags.push({ flag: "whale", createdAt: iso(daysAgo(now, 40, 12)), createdByUserId: null });
  else if (net >= 150_000) flags.push({ flag: "vip", createdAt: iso(daysAgo(now, 25, 12)), createdByUserId: 2 });
  if (fanTransactions(page, item.fan).some((tx) => tx.type === "chargeback")) {
    flags.push({ flag: "risky", createdAt: iso(daysAgo(now, 6, 10)), createdByUserId: 2 });
  }
  return flags;
}

function dossierBody(page: DemoPage, item: PageFan): string {
  const random = rng(`dossier:${page.label}:${item.fan.platformUserId}`);
  const name = item.fan.displayName.split(" ")[0] ?? item.fan.username;
  const job = pick(random, ["электрик", "дальнобойщик", "инженер на нефтянке", "владелец автомастерской", "айтишник", "пожарный", "менеджер по продажам"]);
  const cities: Record<string, readonly string[]> = { GB: ["Манчестер", "Лидс"], CA: ["Онтарио", "Альберта"], DE: ["Гамбург"], AU: ["Сидней", "Перт"], NL: ["Роттердам"], SE: ["Гётеборг"] };
  const city = pick(random, cities[item.fan.country] ?? ["Техас", "Огайо", "Флорида", "Аризона", "Джорджия", "Мичиган"]);
  const age = intBetween(random, 29, 56);
  const pet = pick(random, ["собака Рокки", "кот Бадди", "два лабрадора", "попугай"]);
  const spent = Math.round(item.fan.totalSpent);
  return [
    `**${name}**, ${age}, ${city}. Пишет вечером по своему времени, чаще в выходные.`,
    "",
    "## 1. ДОСЬЕ",
    `- Работа: ${job}, смены по 12 часов.`,
    `- Дома: ${pet}; разведён, дочь в колледже.`,
    `- Хобби: рыбалка, старые машины, смотрит футбол по воскресеньям.`,
    `- Называет модель «${pick(random, ["sunshine", "angel", "princess", "gorgeous"])}», сам просит звать его ${name}.`,
    "",
    "## 2. ПСИХОЛОГИЧЕСКИЙ ПОРТРЕТ",
    "Одинокий, ценит внимание больше контента. Быстро привязывается, обижается на шаблонные ответы. Любит чувствовать себя особенным и «единственным».",
    "",
    "## 3. СТАДИЯ И ТРАЕКТОРИЯ",
    item.fan.lastPurchaseDaysAgo !== null && item.fan.lastPurchaseDaysAgo <= 14
      ? "Тёплый, покупает регулярно. Траты растут последние три недели."
      : "Остывает: последние покупки давно, на сообщения отвечает коротко.",
    "",
    "## 4. ДИНАМИКА ОБЩЕНИЯ",
    "- Открывается на вопросы про его день и работу.",
    "- Хорошо реагирует на голосовые и фото «без фильтров».",
    "- Не любит, когда сразу предлагают PPV после приветствия.",
    "",
    "## 5. ФИНАНСОВЫЙ ПРОФИЛЬ",
    `Всего на странице ≈ $${spent}. Лучше всего покупает видео $15–30 и чаевые после личных разговоров.`,
    "",
    "## 6. ОТКРЫТЫЕ ПЕТЛИ",
    `- Обещали фото в ${pick(random, ["красном", "чёрном", "белом"])} белье — не отправлено.`,
    "- Спрашивал про стрим в пятницу.",
    "",
    "## 7. СТРАТЕГИЯ",
    "Сначала личный разговор (работа, собака), потом мягкий тизер. PPV не чаще раза в два дня, цена до $30.",
  ].join("\n");
}

function dossierVersions(page: DemoPage, item: PageFan, now: Date): { version: number; createdAt: string; generatedAt: string }[] {
  if (!item.core || item.fan.totalSpent < 15) return [];
  const random = rng(`dossier-v:${page.label}:${item.fan.platformUserId}`);
  const count = item.fan.totalSpent > 200 ? intBetween(random, 4, 7) : intBetween(random, 1, 3);
  let hours = between(random, 6, 60);
  const out: { version: number; createdAt: string; generatedAt: string }[] = [];
  for (let index = count; index >= 1; index -= 1) {
    out.push({ version: index, createdAt: iso(hoursAgo(now, hours)), generatedAt: iso(hoursAgo(now, hours + between(random, 0.05, 0.4))) });
    hours += between(random, 48, 24 * 12);
  }
  return out;
}

function previewMessages(page: DemoPage, item: PageFan, now: Date, limit: number) {
  const dm = item.dm!;
  const random = rng(`chat:${page.label}:${item.fan.platformUserId}`);
  const tips = fanTransactions(page, item.fan).filter((tx) => tx.type === "tip" && tx.hoursAgo < dm.lastMessageHoursAgo + 24 * 10);
  const out: KernelOperationResponse<"pageConversationPreview">["messages"] = [];
  let hours = dm.lastMessageHoursAgo;
  let fanTurn = dm.lastFanMessageHoursAgo === dm.lastMessageHoursAgo;
  for (let index = 0; index < limit; index += 1) {
    const content = index === 0 ? dm.preview : fanTurn ? pick(random, FAN_LINES) : pick(random, MODEL_LINES);
    const tip = fanTurn ? tips.find((tx) => Math.abs(tx.hoursAgo - hours) < 6) : undefined;
    out.push({
      platformMessageId: `${dm.conversationId}${String(9000 - index).padStart(5, "0")}`,
      senderPlatformUserId: fanTurn ? item.fan.platformUserId : null,
      senderRole: fanTurn ? "fan" : "model",
      createdAt: iso(hoursAgo(now, hours)),
      content: tip ? `sent you a tip 💸 ${content}` : content,
      totalTipAmountCents: tip ? Math.round(tip.grossMills / 10) : 0,
      source: "rest",
    });
    hours += random() < 0.7 ? between(random, 0.02, 0.6) : between(random, 3, 30);
    fanTurn = random() < 0.35 ? fanTurn : !fanTurn;
  }
  return out.reverse();
}

// --- Spender metrics shapes ---

function comparisonOf(current: ReturnType<typeof metricsOf>, previous: ReturnType<typeof metricsOf> | null) {
  if (previous === null) return null;
  return {
    previousGrossAmountMills: previous.grossAmountMills,
    previousCreatorNetAmountMills: previous.creatorNetAmountMills,
    deltaGrossAmountMills: current.grossAmountMills - previous.grossAmountMills,
    deltaCreatorNetAmountMills: current.creatorNetAmountMills - previous.creatorNetAmountMills,
    deltaPct: previous.creatorNetAmountMills === 0
      ? null
      : ((current.creatorNetAmountMills - previous.creatorNetAmountMills) / Math.abs(previous.creatorNetAmountMills)) * 100,
  };
}

function scopeOf(request: DemoRequest): { kind: "page" | "model" | "agency"; platform: DemoPage["platform"]; pages: DemoPage[]; page: DemoPage | null; model: { slug: string; name: string } | null } | DemoReply {
  const kind = (queryString(request, "scope") ?? "page") as "page" | "model" | "agency";
  if (kind === "page") {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    return { kind, platform: page.platform, pages: [page], page, model: null };
  }
  const platform = (queryString(request, "platform") ?? request.params.platform ?? "fansly") as DemoPage["platform"];
  if (kind === "model") {
    const slug = queryString(request, "modelSlug") ?? "";
    const pages = DEMO_PAGES.filter((page) => page.modelSlug === slug && page.platform === platform);
    if (pages.length === 0) return demoError(404, "not_found", `Модель ${slug} не найдена`);
    return { kind, platform, pages, page: null, model: { slug, name: pages[0]!.modelName } };
  }
  return { kind, platform, pages: DEMO_PAGES.filter((page) => page.platform === platform), page: null, model: null };
}

function scopeShape(scope: Exclude<ReturnType<typeof scopeOf>, DemoReply>) {
  return {
    kind: scope.kind,
    platform: scope.platform,
    pageCount: scope.pages.length,
    page: scope.page ? pageRefShort(scope.page) : null,
    model: scope.model,
  };
}

function typeBreakdown(txs: readonly DemoTx[]) {
  const order: CanonicalType[] = ["subscription", "tip", "message_purchase", "post_purchase", "stream_tip", "chargeback"];
  return order.flatMap((type) => {
    const rows = txs.filter((tx) => tx.type === type);
    if (rows.length === 0) return [];
    return [{
      canonicalType: type,
      grossAmountMills: rows.reduce((sum, tx) => sum + tx.grossMills, 0),
      creatorNetAmountMills: rows.reduce((sum, tx) => sum + tx.netMills, 0),
      transactionCount: rows.length,
    }];
  });
}

function findFanInScope(scope: Exclude<ReturnType<typeof scopeOf>, DemoReply>, platformUserId: string): { page: DemoPage; item: PageFan } | undefined {
  for (const page of scope.pages) {
    const item = findPageFan(page, platformUserId);
    if (item) return { page, item };
  }
  return undefined;
}

type Granularity = "day" | "week" | "month";

function seriesBuckets(fromDay: string, toDay: string, granularity: Granularity): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let cursor = Date.parse(`${fromDay}T00:00:00Z`);
  const end = Date.parse(`${toDay}T00:00:00Z`);
  while (cursor <= end) {
    const start = new Date(cursor);
    let next: number;
    if (granularity === "day") next = cursor + DAY_MS;
    else if (granularity === "week") next = cursor + 7 * DAY_MS;
    else next = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
    const last = Math.min(next - DAY_MS, end);
    out.push({ from: isoDay(start), to: isoDay(new Date(last)) });
    cursor = next;
  }
  return out;
}

const SUBSCRIBERS_LIMIT_FALLBACK = 50;

export const pageFanHandlers: DemoHandlers = {
  pageSubscribers: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const query = queryString(request, "query");
    const expiring = queryString(request, "expiringWithinDays");
    const started = queryString(request, "startedWithinHours");
    const autoRenew = queryBool(request, "autoRenew");
    const paid = queryBool(request, "paid");
    const rows = pagePopulation(page)
      .filter((item) => item.subscription !== null)
      .filter((item) => fanMatches(item.fan, query))
      .filter((item) => expiring === undefined || item.subscription!.endsInHours <= Number(expiring) * 24)
      .filter((item) => started === undefined || item.subscription!.startedHoursAgo <= Number(started))
      .filter((item) => autoRenew === undefined || item.subscription!.autoRenew === autoRenew)
      .filter((item) => paid === undefined || item.subscription!.paid === paid)
      // As the server: the subscription that ends first comes first.
      .sort((left, right) => left.subscription!.endsInHours - right.subscription!.endsInHours);
    const slice = paginate(request, rows, SUBSCRIBERS_LIMIT_FALLBACK);
    return { page: assignedPage(page, request.now), ...slice, items: slice.items.map((item) => subscriberItem(page, item, request.now)) };
  },

  pageSubscribersDaily: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const days = rollupDays(request);
    const subs = pagePopulation(page).filter((item) => item.subscription !== null);
    const news = countByDay(request.now, subs.map((item) => item.subscription!.startedHoursAgo));
    // Walk back from today's count: each day's new subscriptions minus the ones that ended.
    let active = page.subscribers;
    const today = isoDay(request.now);
    const allDays: string[] = [];
    for (let at = Date.parse(`${today}T00:00:00Z`); allDays.length < 400 && (days[0] === undefined || isoDay(new Date(at)) >= days[0]); at -= DAY_MS) {
      allDays.push(isoDay(new Date(at)));
    }
    const activeByDay = new Map<string, number>();
    for (const day of allDays) {
      activeByDay.set(day, active);
      const gained = news.get(day) ?? 0;
      const lost = Math.round(gained * between(rng(`churn:${page.label}:${day}`), 0.55, 1.05));
      active -= gained - lost;
    }
    return {
      page: assignedPage(page, request.now),
      // The full walk of an OnlyFans list went through its API: no day's row after it.
      items: days
        .filter((day) => page.platform !== "onlyfans" || day <= DEMO_OFAPI_OFF_DAY)
        .map((day) => ({ businessDate: day, newSubscribers: news.get(day) ?? 0, activeSubscribers: activeByDay.get(day) ?? page.subscribers })),
    };
  },

  pageFollowers: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const query = queryString(request, "query");
    const within = queryString(request, "followedWithinHours");
    const subscriber = queryBool(request, "subscriber");
    const dmStatus = queryString(request, "dmStatus");
    const active = queryString(request, "activeWithinMinutes");
    const rows = pagePopulation(page)
      .filter((item) => item.followedHoursAgo !== null)
      .filter((item) => fanMatches(item.fan, query))
      .filter((item) => within === undefined || item.followedHoursAgo! <= Number(within))
      .filter((item) => subscriber === undefined || (item.subscription !== null) === subscriber)
      .filter((item) => dmStatus === undefined || (dmStatus === "none" ? item.dm === null : item.dm !== null))
      .filter((item) => active === undefined || (item.presence.lastSeenHoursAgo !== null && item.presence.lastSeenHoursAgo * 60 <= Number(active)))
      .sort((left, right) => left.followedHoursAgo! - right.followedHoursAgo!);
    const slice = paginate(request, rows);
    return { page: assignedPage(page, request.now), ...slice, items: slice.items.map((item) => followerItem(page, item, request.now)) };
  },

  pageFollowersDaily: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const days = rollupDays(request);
    if (page.platform !== "fansly") return { page: assignedPage(page, request.now), items: days.map((day) => ({ businessDate: day, newFollowers: 0, knownTotalFollowers: null })) };
    const follows = pagePopulation(page).filter((item) => item.followedHoursAgo !== null).map((item) => item.followedHoursAgo!);
    const news = countByDay(request.now, follows);
    return {
      page: assignedPage(page, request.now),
      items: days.map((day) => {
        let later = 0;
        for (const [other, count] of news) if (other > day) later += count;
        // A little churn: the known total lags behind the follows a bit.
        const unfollowed = Math.round(later * 0.12);
        return { businessDate: day, newFollowers: news.get(day) ?? 0, knownTotalFollowers: (page.followers ?? 0) - later + unfollowed };
      }),
    };
  },

  pageFanCard: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    return fanCard(page, request.params.platformUserId ?? "", request.now);
  },

  pageDeletedFans: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    return { page: assignedPage(page, request.now), ...paginate(request, deletedFans(page, request.now)) };
  },

  pageTransactions: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const type = queryString(request, "type");
    const state = queryString(request, "state");
    const rows = pageTransactionsOf(page)
      .filter((row) => type === undefined || row.tx.type === type)
      .filter((row) => state === undefined || (state === "pending") === row.tx.pending);
    const slice = paginate(request, rows);
    return {
      page: assignedPage(page, request.now),
      ...slice,
      items: slice.items.map(({ item, tx }) => ({
        transactionId: tx.id,
        rawType: tx.rawType,
        canonicalType: tx.type,
        transactionState: tx.pending ? "pending" as const : "posted" as const,
        amountMills: tx.grossMills,
        destinationAmountMills: tx.grossMills,
        netAmountMills: tx.netMills,
        walletId: null,
        correlationId: null,
        correlationAccountId: null,
        occurredAt: iso(hoursAgo(request.now, tx.hoursAgo)),
        sourceUpdatedAt: iso(hoursAgo(request.now, Math.max(0, tx.hoursAgo - 0.5))),
        fan: { platformUserId: item.fan.platformUserId, pageAlias: null, username: item.fan.username, displayName: shownName(item) },
      })),
    };
  },

  pageSpenderAutoLists: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const window = spenderWindow(request);
    const rows = spenderRows([page], window, request.now);
    const counts = new Map<string, number>();
    for (const row of rows) {
      const bucket = bucketOf(row, window);
      if (bucket) counts.set(bucket.key, (counts.get(bucket.key) ?? 0) + 1);
    }
    return {
      page: pageRefShort(page),
      currency: "USD" as const,
      metric: window.fromDay === null ? "lifetimeGrossAmountMills" as const : "grossAmountMills" as const,
      period: spenderPeriodShape(window, request.now),
      asOf: iso(hoursAgo(request.now, 0.25)),
      totalEntries: [...counts.values()].reduce((sum, value) => sum + value, 0),
      lists: BUCKETS.map((bucket) => bucketShape(bucket, counts.get(bucket.key) ?? 0)),
    };
  },

  pageSpenderAutoListDetail: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const bucket = BUCKETS.find((item) => item.key === request.params.bucketKey);
    if (!bucket) return demoError(404, "not_found", "Такого списка нет");
    const window = spenderWindow(request);
    const query = queryString(request, "query");
    const followersOnly = queryBool(request, "excludeNonFollowers") === true;
    const all = spenderRows([page], window, request.now).filter((row) => bucketOf(row, window)?.key === bucket.key);
    const rows = all
      .filter((row) => fanMatches(row.item.fan, query))
      .filter((row) => !followersOnly || row.item.followedHoursAgo !== null)
      .sort((left, right) => (window.fromDay === null ? right.lifetime.grossAmountMills - left.lifetime.grossAmountMills : right.window.grossAmountMills - left.window.grossAmountMills));
    const slice = paginate(request, rows);
    return {
      page: pageRefShort(page),
      currency: "USD" as const,
      metric: window.fromDay === null ? "lifetimeGrossAmountMills" as const : "grossAmountMills" as const,
      period: spenderPeriodShape(window, request.now),
      bucket: bucketShape(bucket, all.length),
      ...slice,
      items: slice.items.map((row) => {
        const sub = row.item.subscription;
        const lapsed = sub === null && row.lifetime.transactionCount > 2;
        return {
          fan: fanIdentity(page, row.item, request.now),
          isFollower: row.item.followedHoursAgo !== null,
          isSubscriber: sub !== null,
          subscriptionStatus: sub ? "active" as const : lapsed ? "expired" as const : "never" as const,
          subscriptionExpiresAt: sub ? iso(new Date(request.now.getTime() + sub.endsInHours * 3_600_000)) : null,
          lastSubscriptionEndedAt: lapsed ? iso(daysAgo(request.now, 12 + (hashString(row.item.fan.platformUserId) % 80), 6)) : null,
          grossAmountMills: row.window.grossAmountMills,
          creatorNetAmountMills: row.window.creatorNetAmountMills,
          lifetimeGrossAmountMills: row.lifetime.grossAmountMills,
          lifetimeCreatorNetAmountMills: row.lifetime.creatorNetAmountMills,
          lastTransactionAt: row.lifetime.lastTransactionAt,
          accountLookupMissAt: null,
        };
      }),
    };
  },

  fansSearch: (request) => {
    const scope = scopeOf(request);
    if (isReply(scope)) return scope;
    const query = queryString(request, "query") ?? queryString(request, "q");
    const found = new Map<string, { fan: ReturnType<typeof fanIdentity>; pages: { page: DemoPage; item: PageFan }[] }>();
    for (const page of scope.pages) {
      for (const item of pagePopulation(page)) {
        if (!fanMatches(item.fan, query)) continue;
        const entry = found.get(item.fan.platformUserId) ?? { fan: fanIdentity(page, item, request.now), pages: [] };
        entry.pages.push({ page, item });
        found.set(item.fan.platformUserId, entry);
      }
    }
    const slice = paginate(request, [...found.values()], 20);
    return {
      scope: scopeShape(scope),
      limit: slice.limit,
      offset: slice.offset,
      total: slice.total,
      items: slice.items.map((entry) => ({
        fan: entry.fan,
        matchKind: entry.fan.displayName ? "displayName" as const : "username" as const,
        matchedValue: entry.fan.displayName ?? entry.fan.username,
        pages: entry.pages.map(({ page, item }) => {
          const sub = item.subscription;
          return {
            pageId: page.id,
            pageLabel: page.label,
            modelSlug: page.modelSlug,
            modelName: page.modelName,
            isFollower: item.followedHoursAgo !== null,
            followerSince: at(request.now, item.followedHoursAgo),
            isSubscriber: sub !== null,
            subscriberSince: sub ? iso(hoursAgo(request.now, sub.startedHoursAgo)) : null,
            subscriptionExpiresAt: sub ? iso(new Date(request.now.getTime() + sub.endsInHours * 3_600_000)) : null,
            autoRenew: sub ? sub.autoRenew : null,
            autoRenewOffDetectedAt: sub?.autoRenewOffDaysAgo != null ? iso(daysAgo(request.now, sub.autoRenewOffDaysAgo, 9)) : null,
          };
        }),
      })),
    };
  },

  crossPageFanDetail: (request) => {
    const platformUserId = request.params.platformUserId ?? "";
    const pages = DEMO_PAGES.filter((page) => page.platform === request.params.platform).flatMap((page) => {
      const item = findPageFan(page, platformUserId);
      return item ? [{ page, item }] : [];
    });
    const first = pages[0];
    if (!first) return demoError(404, "not_found", "Фан не найден");
    const lifetimes = pages.map(({ page, item }) => metricsOf(fanTransactions(page, item.fan), request.now));
    return {
      fan: fanIdentity(first.page, first.item, request.now),
      platformTotalSpendMills: lifetimes.reduce((sum, lifetime) => sum + lifetime.grossAmountMills, 0),
      pages: pages.map(({ page, item }, index) => {
        const sub = item.subscription;
        return {
          pageId: page.id,
          pageLabel: page.label,
          modelSlug: page.modelSlug,
          modelName: page.modelName,
          totalCreatorNetMills: lifetimes[index]?.creatorNetAmountMills ?? 0,
          currency: "USD" as const,
          isFollower: item.followedHoursAgo !== null,
          followerSince: at(request.now, item.followedHoursAgo),
          isSubscriber: sub !== null,
          subscriberSince: sub ? iso(hoursAgo(request.now, sub.startedHoursAgo)) : null,
          subscriptionExpiresAt: sub ? iso(new Date(request.now.getTime() + sub.endsInHours * 3_600_000)) : null,
          autoRenew: sub ? sub.autoRenew : null,
          autoRenewOffDetectedAt: sub?.autoRenewOffDaysAgo != null ? iso(daysAgo(request.now, sub.autoRenewOffDaysAgo, 9)) : null,
          lastTransactionAt: lifetimes[index]?.lastTransactionAt ?? null,
          notes: [],
          summaries: [],
        };
      }),
      flags: [],
    };
  },

  spenders: (request) => {
    const scope = scopeOf(request);
    if (isReply(scope)) return scope;
    const window = spenderWindow(request);
    const previous = previousWindow(window);
    const query = queryString(request, "query");
    const retention = queryString(request, "retentionStatus") ?? "all";
    const sortBy = queryString(request, "sortBy") ?? "creatorNetAmountMills";
    const sortDir = queryString(request, "sortDir") === "asc" ? 1 : -1;
    const all = scope.kind === "page" ? spenderRows(scope.pages, window, request.now) : onePerFan(spenderRows(scope.pages, window, request.now), window, request.now);
    const totals = all.reduce((sum, row) => ({ gross: sum.gross + row.window.grossAmountMills, net: sum.net + row.window.creatorNetAmountMills }), { gross: 0, net: 0 });
    const rows = all
      .filter((row) => fanMatches(row.item.fan, query))
      .map((row) => ({ ...row, retention: retentionOf(lastTxHours(row.page, row.item), row.lifetime.creatorNetAmountMills) }))
      .filter((row) => retention === "all" || row.retention === retention);
    const key = (row: SpenderRow): number | string => {
      switch (sortBy) {
        case "lastTransactionAt": return row.window.lastTransactionAt ?? "";
        case "lifetimeGrossAmountMills": return row.lifetime.grossAmountMills;
        case "lifetimeCreatorNetAmountMills": return row.lifetime.creatorNetAmountMills;
        case "grossAmountMills": return row.window.grossAmountMills;
        case "username": return row.item.fan.username;
        case "displayName": return row.item.fan.displayName;
        case "platformUserId": return row.item.fan.platformUserId;
        default: return row.window.creatorNetAmountMills;
      }
    };
    rows.sort((left, right) => {
      const a = key(left);
      const b = key(right);
      return (a < b ? -1 : a > b ? 1 : 0) * sortDir;
    });
    const slice = paginate(request, rows);
    return {
      scope: scopeShape(scope),
      period: spenderPeriodShape(window, request.now),
      diagnostics: {
        totalGrossAmountMills: totals.gross,
        totalCreatorNetAmountMills: totals.net,
        attributedGrossAmountMills: totals.gross,
        attributedCreatorNetAmountMills: totals.net,
        unattributedGrossAmountMills: 0,
        unattributedCreatorNetAmountMills: 0,
      },
      ...slice,
      items: slice.items.map((row) => {
        const txs = fanTransactions(row.page, row.item.fan);
        const newest = txs[0];
        const prev = previous ? metricsOf(windowTxs(row.page, row.item.fan, previous, request.now), request.now) : null;
        const dm = row.item.dm;
        return {
          fan: fanIdentity(row.page, row.item, request.now),
          metrics: {
            window: row.window,
            lifetime: {
              scopeGrossAmountMills: row.lifetime.grossAmountMills,
              scopeCreatorNetAmountMills: row.lifetime.creatorNetAmountMills,
              platformGrossAmountMills: row.lifetime.grossAmountMills,
              platformCreatorNetAmountMills: row.lifetime.creatorNetAmountMills,
            },
            comparison: comparisonOf(row.window, prev),
          },
          lifetimeLastTransactionAt: row.lifetime.lastTransactionAt,
          lastFanMessageAt: dm ? at(request.now, dm.lastFanMessageHoursAgo) : null,
          conversation: {
            platformConversationId: dm?.conversationId ?? null,
            unreadCount: dm?.unreadCount ?? 0,
            lastMessageAt: dm ? iso(hoursAgo(request.now, dm.lastMessageHoursAgo)) : null,
            lastFanMessageAt: dm ? at(request.now, dm.lastFanMessageHoursAgo) : null,
            lastModelMessageAt: dm ? at(request.now, dm.lastModelMessageHoursAgo) : null,
            lastMessagePreview: dm?.preview ?? null,
            storedMessageCount: dm?.storedMessageCount ?? 0,
            messageCoverageStatus: dm ? (dm.storedMessageCount > 1500 ? "partial_window" as const : "complete" as const) : "pending_backfill" as const,
            messageBackfillComplete: dm !== null,
          },
          lastTransaction: newest
            ? {
              canonicalType: newest.type,
              transactionState: newest.pending ? "pending" as const : "posted" as const,
              grossAmountMills: newest.grossMills,
              creatorNetAmountMills: newest.netMills,
              occurredAt: iso(hoursAgo(request.now, newest.hoursAgo)),
            }
            : null,
          retentionStatus: row.retention,
          // A page answers for itself: over several pages the server says nothing.
          accountLookupMissAt: scope.kind === "page" && pageMisses(row.page, row.item) ? iso(daysAgo(request.now, 2 + (hashString(row.item.fan.platformUserId) % 9), 8)) : null,
        };
      }),
    };
  },

  spenderDetail: (request) => {
    const scope = scopeOf(request);
    if (isReply(scope)) return scope;
    const found = findFanInScope(scope, request.params.platformUserId ?? "");
    if (!found) return demoError(404, "not_found", "Фан не найден");
    const { page, item } = found;
    const window = spenderWindow(request);
    const previous = previousWindow(window);
    const all = fanTransactions(page, item.fan);
    const inside = windowTxs(page, item.fan, window, request.now);
    const current = metricsOf(inside, request.now);
    const lifetime = metricsOf(all, request.now);
    // Every page of the platform the fan is on, as the server: the scope's marked, all time each.
    const pages = DEMO_PAGES.filter((one) => one.platform === page.platform).flatMap((one) => {
      const there = findPageFan(one, item.fan.platformUserId);
      if (!there) return [];
      const money = metricsOf(fanTransactions(one, there.fan), request.now);
      const sub = there.subscription;
      return [{
        pageId: one.id,
        pageLabel: one.label,
        modelSlug: one.modelSlug,
        modelName: one.modelName,
        inScope: scope.pages.some((inside) => inside.label === one.label),
        grossAmountMills: money.grossAmountMills,
        creatorNetAmountMills: money.creatorNetAmountMills,
        lastTransactionAt: money.lastTransactionAt,
        isFollower: there.followedHoursAgo !== null,
        followerSince: at(request.now, there.followedHoursAgo),
        isSubscriber: sub !== null,
        subscriberSince: sub ? iso(hoursAgo(request.now, sub.startedHoursAgo)) : null,
        subscriptionExpiresAt: sub ? iso(new Date(request.now.getTime() + sub.endsInHours * 3_600_000)) : null,
        autoRenew: sub ? sub.autoRenew : null,
        autoRenewOffDetectedAt: sub?.autoRenewOffDaysAgo != null ? iso(daysAgo(request.now, sub.autoRenewOffDaysAgo, 9)) : null,
      }];
    });
    return {
      scope: scopeShape(scope),
      fan: fanIdentity(page, item, request.now),
      period: spenderPeriodShape(window, request.now),
      metrics: {
        window: current,
        lifetime: {
          scopeGrossAmountMills: lifetime.grossAmountMills,
          scopeCreatorNetAmountMills: lifetime.creatorNetAmountMills,
          platformGrossAmountMills: pages.reduce((sum, one) => sum + one.grossAmountMills, 0),
          platformCreatorNetAmountMills: pages.reduce((sum, one) => sum + one.creatorNetAmountMills, 0),
        },
        comparison: comparisonOf(current, previous ? metricsOf(windowTxs(page, item.fan, previous, request.now), request.now) : null),
      },
      typeBreakdown: typeBreakdown(inside),
      pages,
    };
  },

  crossPageFanTransactions: (request) => {
    const platformUserId = request.params.platformUserId ?? "";
    const rows = DEMO_PAGES.filter((page) => page.platform === request.params.platform).flatMap((page) => {
      const item = findPageFan(page, platformUserId);
      return item ? fanTransactions(page, item.fan).map((tx) => ({ page, item, tx })) : [];
    }).sort((left, right) => left.tx.hoursAgo - right.tx.hoursAgo);
    if (rows.length === 0 && !DEMO_PAGES.some((page) => findPageFan(page, platformUserId))) return demoError(404, "not_found", "Фан не найден");
    const slice = paginate(request, rows, 25);
    return {
      ...slice,
      items: slice.items.map(({ page, item, tx }) => ({
        transactionId: tx.id,
        rawType: tx.rawType,
        canonicalType: tx.type,
        transactionState: tx.pending ? "pending" as const : "posted" as const,
        amountMills: tx.grossMills,
        destinationAmountMills: tx.netMills,
        netAmountMills: tx.netMills,
        occurredAt: iso(hoursAgo(request.now, tx.hoursAgo)),
        sourceUpdatedAt: null,
        fan: { platformUserId: item.fan.platformUserId, username: item.fan.username, displayName: item.fan.displayName },
        pageLabel: page.label,
        platform: page.platform as "fansly" | "onlyfans",
      })),
    };
  },

  // A read over POST (the fans travel in the body): «Топ фанов» asks for its
  // rows' subscriptions and lifetime figures in one batch.
  spenderBatch: (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const asked = Array.isArray(body.fans) ? body.fans as { platform?: unknown; platformUserId?: unknown }[] : [];
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key !== "fans" && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) query[key] = String(value);
    }
    const pseudo: DemoRequest = {
      ...request,
      query,
      params: typeof body.pageLabel === "string" ? { ...request.params, pageLabel: body.pageLabel } : request.params,
    };
    const scope = scopeOf(pseudo);
    if (isReply(scope)) return scope;
    const window = spenderWindow(pseudo);
    const previous = previousWindow(window);
    return {
      scope: scopeShape(scope),
      period: spenderPeriodShape(window, request.now),
      items: asked.map((wanted) => {
        const requestedFan = {
          platform: (wanted.platform === "onlyfans" || wanted.platform === "fansly" ? wanted.platform : scope.platform),
          platformUserId: String(wanted.platformUserId ?? ""),
        };
        const found = findFanInScope(scope, requestedFan.platformUserId);
        if (!found) {
          return { requestedFan, found: false, fan: null, metrics: null, typeBreakdown: null, lifetimeLastTransactionAt: null, subscription: null };
        }
        const { page, item } = found;
        const inside = windowTxs(page, item.fan, window, request.now);
        const current = metricsOf(inside, request.now);
        const lifetime = metricsOf(fanTransactions(page, item.fan), request.now);
        const sub = item.subscription;
        // Wider than one page: no one subscription, the fan's pages instead (as the server).
        const wide = scope.pages.length > 1;
        const wideFields = !wide ? {} : {
          subscription: null,
          pages: scope.pages.flatMap((one) => {
            const there = findPageFan(one, requestedFan.platformUserId);
            return there ? [{ pageLabel: one.label, creatorNetAmountMills: metricsOf(fanTransactions(one, there.fan), request.now).creatorNetAmountMills }] : [];
          }).sort((left, right) => right.creatorNetAmountMills - left.creatorNetAmountMills),
        };
        return {
          requestedFan,
          found: true,
          fan: fanIdentity(page, item, request.now),
          metrics: {
            window: current,
            lifetime: {
              scopeGrossAmountMills: lifetime.grossAmountMills,
              scopeCreatorNetAmountMills: lifetime.creatorNetAmountMills,
              platformGrossAmountMills: lifetime.grossAmountMills,
              platformCreatorNetAmountMills: lifetime.creatorNetAmountMills,
            },
            comparison: comparisonOf(current, previous ? metricsOf(windowTxs(page, item.fan, previous, request.now), request.now) : null),
          },
          typeBreakdown: typeBreakdown(inside),
          lifetimeLastTransactionAt: lifetime.lastTransactionAt,
          subscription: sub
            ? {
                status: sub.endsInHours > 0 ? "active" as const : "expired" as const,
                expiresAt: iso(new Date(request.now.getTime() + sub.endsInHours * 3_600_000)),
                autoRenew: sub.autoRenew,
                autoRenewOffDetectedAt: sub.autoRenewOffDaysAgo != null ? iso(daysAgo(request.now, sub.autoRenewOffDaysAgo, 9)) : null,
              }
            : { status: "never" as const, expiresAt: null, autoRenew: null, autoRenewOffDetectedAt: null },
          ...wideFields,
        };
      }),
    };
  },

  spenderSeries: (request) => {
    const scope = scopeOf(request);
    if (isReply(scope)) return scope;
    const found = findFanInScope(scope, request.params.platformUserId ?? "");
    if (!found) return demoError(404, "not_found", "Фан не найден");
    const { page, item } = found;
    const window = spenderWindow(request);
    const txs = fanTransactions(page, item.fan);
    const today = isoDay(request.now);
    const fromDay = window.fromDay ?? isoDay(hoursAgo(request.now, Math.max(item.fan.firstSeenDaysAgo * 24, txs.at(-1)?.hoursAgo ?? 0)));
    const toDay = window.toDay ?? today;
    const span = Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS) + 1;
    const asked = queryString(request, "granularity") ?? "auto";
    const granularity: Granularity = asked === "day" || asked === "week" || asked === "month"
      ? asked
      : span <= 31 ? "day" : span <= 190 ? "week" : "month";
    return {
      scope: scopeShape(scope),
      fan: fanIdentity(page, item, request.now),
      period: spenderPeriodShape({ ...window, fromDay, toDay }, request.now),
      granularity,
      items: seriesBuckets(fromDay, toDay, granularity).map((bucket) => ({
        fromBusinessDate: bucket.from,
        toBusinessDateInclusive: bucket.to,
        metrics: metricsOf(txs.filter((tx) => {
          const day = dayOf(request.now, tx.hoursAgo);
          return day >= bucket.from && day <= bucket.to;
        }), request.now),
      })),
    };
  },

  pageFanDetail: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const item = findPageFan(page, request.params.platformUserId ?? "");
    if (!item) return demoError(404, "not_found", "Фан не найден на этой странице");
    const sub = item.subscription;
    const lifetime = metricsOf(fanTransactions(page, item.fan), request.now);
    const random = rng(`summary:${page.label}:${item.fan.platformUserId}`);
    return {
      fan: fanIdentity(page, item, request.now),
      platformTotalSpendMills: lifetime.grossAmountMills,
      page: {
        pageId: page.id,
        pageLabel: page.label,
        modelSlug: page.modelSlug,
        modelName: page.modelName,
        totalCreatorNetMills: lifetime.creatorNetAmountMills,
        currency: "USD" as const,
        isFollower: item.followedHoursAgo !== null,
        followerSince: at(request.now, item.followedHoursAgo),
        isSubscriber: sub !== null,
        subscriberSince: sub ? iso(hoursAgo(request.now, sub.startedHoursAgo)) : null,
        subscriptionExpiresAt: sub ? iso(new Date(request.now.getTime() + sub.endsInHours * 3_600_000)) : null,
        autoRenew: sub ? sub.autoRenew : null,
        autoRenewOffDetectedAt: sub?.autoRenewOffDaysAgo != null ? iso(daysAgo(request.now, sub.autoRenewOffDaysAgo, 9)) : null,
        lastTransactionAt: lifetime.lastTransactionAt,
        notes: fanNotes(page, item, request.now),
        summaries: item.core && item.fan.totalSpent > 50
          ? [{ id: 70000 + (hashString(item.fan.platformUserId) % 9000), authorUserId: null, body: "Тёплый постоянный покупатель; отвечает на личные вопросы, PPV берёт после разговора.", createdAt: iso(hoursAgo(request.now, between(random, 20, 200))) }]
          : [],
      },
      flags: fanFlags(page, item, request.now),
    };
  },

  pageFanProfile: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const item = findPageFan(page, request.params.platformUserId ?? "");
    if (!item) return demoError(404, "not_found", "Фан не найден на этой странице");
    const latest = dossierVersions(page, item, request.now)[0];
    return {
      fan: { platform: page.platform, platformUserId: item.fan.platformUserId, username: item.fan.username, displayName: shownName(item), createdAtExternal: iso(hoursAgo(request.now, item.createdHoursAgo)), pageAlias: null },
      profile: latest
        ? { version: latest.version, body: dossierBody(page, item), source: "chatmuse" as const, createdAt: latest.createdAt, sourceGeneratedAt: latest.generatedAt, createdByUserId: null }
        : null,
    };
  },

  pageFanProfileVersions: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const item = findPageFan(page, request.params.platformUserId ?? "");
    if (!item) return demoError(404, "not_found", "Фан не найден на этой странице");
    return { items: dossierVersions(page, item, request.now).map((version, index) => ({ version: version.version, createdAt: version.createdAt, isCurrent: index === 0 })) };
  },

  pageFanProfileVersion: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const item = findPageFan(page, request.params.platformUserId ?? "");
    if (!item) return demoError(404, "not_found", "Фан не найден на этой странице");
    const wanted = Number(request.params.version);
    const versions = dossierVersions(page, item, request.now);
    const found = versions.find((version) => version.version === wanted);
    if (!found) return demoError(404, "not_found", "Такой версии досье нет");
    const body = dossierBody(page, item);
    // Older versions knew less: the strategy and the open loops came later.
    const older = found.version === versions[0]?.version ? body : body.split("\n## 6.")[0] ?? body;
    return { version: found.version, body: older, source: "chatmuse" as const, createdAt: found.createdAt, sourceGeneratedAt: found.generatedAt, createdByUserId: null };
  },

  pageFanTransactions: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const item = findPageFan(page, request.params.platformUserId ?? "");
    if (!item) return demoError(404, "not_found", "Фан не найден на этой странице");
    const slice = paginate(request, fanTransactions(page, item.fan));
    return {
      ...slice,
      items: slice.items.map((tx) => ({
        transactionId: tx.id,
        rawType: tx.rawType,
        canonicalType: tx.type,
        transactionState: tx.pending ? "pending" as const : "posted" as const,
        amountMills: tx.grossMills,
        destinationAmountMills: tx.grossMills,
        netAmountMills: tx.netMills,
        occurredAt: iso(hoursAgo(request.now, tx.hoursAgo)),
        sourceUpdatedAt: iso(hoursAgo(request.now, Math.max(0, tx.hoursAgo - 0.5))),
      })),
    };
  },

  pageConversationPreview: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const item = findByConversation(page, request.params.platformConversationId ?? "");
    if (!item?.dm) return demoError(404, "not_found", "Переписка не найдена");
    const limit = Math.min(25, Math.max(1, queryNumber(request, "limit", 10)));
    const dm = item.dm;
    const off = page.health === "off";
    return {
      page: assignedPage(page, request.now),
      fan: { fanId: 10000 + (hashString(item.fan.platformUserId) % 90000), platform: page.platform, platformUserId: item.fan.platformUserId, pageAlias: null, username: item.fan.username, displayName: shownName(item) },
      conversation: {
        platformConversationId: dm.conversationId,
        storedMessageCount: dm.storedMessageCount,
        messageCoverageStatus: dm.storedMessageCount > 1500 ? "partial_window" as const : "complete" as const,
        messageBackfillComplete: true,
        messageSyncEligibility: "eligible" as const,
        messageSyncExcludedReason: null,
        lastMessageSyncAt: iso(hoursAgo(request.now, off ? 48 : 0.1)),
        unreadCount: dm.unreadCount,
        lastMessageAt: iso(hoursAgo(request.now, dm.lastMessageHoursAgo)),
      },
      messageSyncUx: off
        ? { state: "off" as const, label: "Нет доступа", headline: "Сбор OnlyFans выключен", detail: "Доступ к OnlyFans через сервис выключен с 1 ноября.", progressLabel: null, nextRetryAt: null, updatedAt: iso(daysAgo(request.now, 2)), requiresAction: false }
        : { state: "healthy" as const, label: "В порядке", headline: "Переписка свежая", detail: null, progressLabel: null, nextRetryAt: null, updatedAt: iso(hoursAgo(request.now, 0.1)), requiresAction: false },
      messages: previewMessages(page, item, request.now, Math.min(limit, Math.max(3, Math.floor(dm.storedMessageCount / 2)))),
    };
  },
};

/** The richest fan of a page, for the screenshots' fan card. */
export function richestFanId(label: string): string | undefined {
  const page = demoPage(label);
  if (!page) return undefined;
  return pagePopulation(page)[0]?.fan.platformUserId;
}
