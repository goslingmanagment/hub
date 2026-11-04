/**
 * The smaller «Команда» answers: open customs, greetings and broadcasts,
 * win-back approaches and their results. They lean on the same people,
 * pages and fans as the shifts in team-world.ts.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { type DemoRequest } from "../core.ts";
import { DEMO_CHATTERS, DEMO_PAGES, demoFans, type DemoUser } from "../world.ts";
import { DAY, HOUR, MIN, between, intBetween, isoAt, mskDay, mskMidnight, pick, rng, windowDays, windowStart } from "./team-world.ts";

// --- Customs ---

interface CustomSeed {
  page: string;
  fan: number;
  text: string;
  price: number | null;
  /** Days since payment; null — ordered, not paid. */
  paidDaysAgo: number | null;
  createdDaysAgo: number;
  by: string;
}

const CUSTOMS: readonly CustomSeed[] = [
  { page: "mia-1", fan: 2, text: "Видео 6–7 мин в красном белье, медленный стриптиз, в конце зовёт его по имени (Джейк)", price: 180, paidDaysAgo: 9.4, createdDaysAgo: 9.6, by: "alex.k" },
  { page: "mia-vip-of", fan: 0, text: "Разбор его фото голосом, 3–4 мин, честно и с юмором", price: 60, paidDaysAgo: 7.6, createdDaysAgo: 8.1, by: "olya.m" },
  { page: "nova-1", fan: 0, text: "Фотосет 15 фото в его футболке (размер прислал), лицо можно", price: 120, paidDaysAgo: 6.2, createdDaysAgo: 6.3, by: "den.s" },
  { page: "mia-3", fan: 4, text: "Голосовое 2 мин на английском: пожелание спокойной ночи, имя — Marcus", price: 45, paidDaysAgo: 4.1, createdDaysAgo: 4.2, by: "kate.v" },
  { page: "mia-2", fan: 1, text: "Видео в душе 4 мин, без музыки, в конце воздушный поцелуй в камеру", price: 150, paidDaysAgo: 3, createdDaysAgo: 3.5, by: "alex.k" },
  { page: "nova-1", fan: 3, text: "Распаковка его подарка (туфли на каблуке) и примерка, 3–5 мин", price: 220, paidDaysAgo: 1.6, createdDaysAgo: 2.4, by: "den.s" },
  { page: "mia-1", fan: 7, text: "Видео 1 мин: «С днём рождения, Tom» в чёрном платье", price: 40, paidDaysAgo: 0.6, createdDaysAgo: 0.7, by: "kate.v" },
  { page: "mia-3", fan: 11, text: "Тренировка в спортивном топе и джоггерах, 5 мин, вид сбоку", price: 90, paidDaysAgo: null, createdDaysAgo: 1.4, by: "kate.v" },
  { page: "ivy-2", fan: 0, text: "5 фото в очках и с косичками, домашний свет", price: 35, paidDaysAgo: null, createdDaysAgo: 2.2, by: "ivan.p" },
  { page: "nova-1", fan: 9, text: "Видео 10 мин по его сценарию «соседка зашла за солью» — ждём ответа модели, цену не назвали", price: null, paidDaysAgo: null, createdDaysAgo: 0.8, by: "den.s" },
];

export function teamCustoms(request: DemoRequest, scope: readonly string[]): KernelOperationResponse<"teamCustoms"> {
  const now = request.now.getTime();
  const customs = CUSTOMS.filter((seed) => scope.includes(seed.page)).map((seed, index) => {
    const fans = demoFans(seed.page).filter((fan) => fan.totalSpent > 0);
    const fan = fans[seed.fan % Math.max(1, fans.length)] ?? demoFans(seed.page)[0]!;
    return {
      id: 4100 + index * 7,
      pageLabel: seed.page,
      fanRef: fan.platformUserId,
      description: seed.text,
      priceMills: seed.price === null ? null : seed.price * 1000,
      state: seed.paidDaysAgo === null ? "ordered" : "paid",
      paidAt: seed.paidDaysAgo === null ? null : isoAt(now - Math.round(seed.paidDaysAgo * DAY)),
      createdBy: seed.by,
      createdAt: isoAt(now - Math.round(seed.createdDaysAgo * DAY)),
    };
  });
  customs.sort((left, right) => {
    if (left.paidAt !== null && right.paidAt !== null) return left.paidAt.localeCompare(right.paidAt);
    if (left.paidAt !== null) return -1;
    if (right.paidAt !== null) return 1;
    return left.createdAt.localeCompare(right.createdAt);
  });
  return { customs, serverNow: request.now.toISOString() };
}

// --- Greetings and broadcasts ---

interface GreetingProfile {
  /** New subscribers a day. */
  perDay: number;
  auto: number;
  greeted: number;
  /** Median of the personal greeting, minutes. */
  medianMinutes: readonly [number, number];
  /** Broadcasts a day. */
  broadcasts: number;
}

const GREETING_PROFILES: Readonly<Record<string, GreetingProfile>> = {
  "mia-1": { perDay: 8.5, auto: 0.96, greeted: 0.72, medianMinutes: [14, 32], broadcasts: 0.75 },
  "mia-2": { perDay: 5.8, auto: 0.95, greeted: 0.63, medianMinutes: [22, 48], broadcasts: 0.55 },
  "mia-3": { perDay: 3.6, auto: 0.93, greeted: 0.47, medianMinutes: [40, 95], broadcasts: 0.4 },
  "mia-of": { perDay: 10.5, auto: 0.98, greeted: 0.52, medianMinutes: [30, 70], broadcasts: 0.5 },
  "mia-vip-of": { perDay: 4.1, auto: 0.97, greeted: 0.6, medianMinutes: [25, 60], broadcasts: 0.45 },
  // nova-1 has no automatic welcome set up: the chatter greets everyone himself.
  "nova-1": { perDay: 5.2, auto: 0, greeted: 0.81, medianMinutes: [9, 21], broadcasts: 0.65 },
  "ivy-1": { perDay: 0.8, auto: 0.9, greeted: 0.06, medianMinutes: [300, 600], broadcasts: 0 },
  "ivy-2": { perDay: 1.7, auto: 0.92, greeted: 0.34, medianMinutes: [120, 260], broadcasts: 0.25 },
};

const PREVIEWS = [
  "Just got out of the shower and couldn't stop thinking about you...",
  "Sunday mood: lazy, cozy and a little bit naughty. Want to see?",
  "I made something special this morning, only for my favorites",
  "Guess what I'm wearing right now? Hint: almost nothing",
  "New set from the beach trip is finally here, 12 pics + a video",
  "Are you up? I'm bored in bed and could use some company",
  "Thank you for being here with me, babe. Here's a little gift",
  "Red or black? Tell me and I'll send you the one you pick",
  "Tried on my new lingerie... I think you'll like this one",
  "Late night thoughts. Come talk to me?",
  "Happy Halloween! My costume was a little too small this year",
  "Workout done, sweaty selfie for you",
  "I miss our chats, where did you go?",
  "Unlocking my favorite video from this week for 24h only",
  "Just me, a glass of wine and a long bath. Join me?",
  "Your weekly spoiler is ready, open it before it's gone",
] as const;

const PRICES = [9.99, 12.99, 14.99, 19.99, 24.99, 29.99] as const;

type Broadcast = KernelOperationResponse<"teamGreetings">["broadcasts"][number];

function broadcastsOf(request: DemoRequest, label: string, platform: string, subscribers: number, days: number): Broadcast[] {
  const profile = GREETING_PROFILES[label];
  if (!profile || profile.broadcasts === 0) return [];
  const now = request.now.getTime();
  const rows: Broadcast[] = [];
  for (const day of windowDays(request.now, days)) {
    const random = rng(`broadcast:${label}:${day}`);
    if (random() > profile.broadcasts) continue;
    const at = mskMidnight(day) + pick(random, [3, 4, 5, 20, 22]) * HOUR + intBetween(random, 0, 59) * MIN;
    if (at > now - 30 * MIN) continue;
    const priced = random() < 0.45;
    const deliveries = Math.round(subscribers * between(random, 0.55, 0.9));
    const ageDays = (now - at) / DAY;
    const ripe = Math.min(1, ageDays / 7);
    const replied = Math.round(deliveries * between(random, 0.02, 0.06) * Math.min(1, ageDays));
    const bought = Math.round(deliveries * between(random, 0.006, 0.022) * ripe);
    rows.push({
      pageLabel: label,
      sentAt: isoAt(at),
      preview: random() < 0.04 ? "" : pick(random, PREVIEWS),
      priceMills: priced ? Math.round(pick(random, PRICES) * 1000) : null,
      files: priced ? intBetween(random, 1, 6) : intBetween(random, 0, 1),
      massMessage: platform === "fansly" && random() < 0.8,
      deliveries,
      replied,
      bought,
      ppvBought: priced ? Math.min(bought, Math.round(deliveries * between(random, 0.004, 0.015) * ripe)) : 0,
    });
  }
  return rows;
}

export function teamGreetings(request: DemoRequest, scope: readonly string[], days: number): KernelOperationResponse<"teamGreetings"> {
  const now = request.now.getTime();
  const from = windowStart(request.now, days);
  const pages: KernelOperationResponse<"teamGreetings">["pages"] = [];
  const broadcasts: Broadcast[] = [];
  for (const page of DEMO_PAGES) {
    if (!scope.includes(page.label)) continue;
    const profile = GREETING_PROFILES[page.label];
    if (!profile) continue;
    const random = rng(`greetings:${page.label}:${days}:${mskDay(now)}`);
    const end = now;
    const liveDays = Math.max(0, (end - from) / DAY);
    const recentDays = Math.max(0, Math.min(7, (end - Math.max(from, now - 7 * DAY)) / DAY));
    const newSubscribers = Math.round(profile.perDay * liveDays * between(random, 0.85, 1.15));
    const recent = liveDays === 0 ? 0 : Math.min(newSubscribers, Math.round((newSubscribers * recentDays) / liveDays));
    const autoWelcomed = Math.round(newSubscribers * profile.auto * between(random, 0.97, 1));
    const greeted = Math.min(newSubscribers, Math.round(newSubscribers * profile.greeted * between(random, 0.9, 1.1)));
    const notGreeted = newSubscribers - greeted;
    const pageBroadcasts = broadcastsOf(request, page.label, page.platform, page.subscribers, days);
    broadcasts.push(...pageBroadcasts);
    if (newSubscribers === 0 && pageBroadcasts.length === 0) continue;
    pages.push({
      pageLabel: page.label,
      platform: page.platform,
      newSubscribers,
      autoWelcomed,
      greeted,
      greetingMedianSeconds: greeted === 0 ? null : Math.round(between(random, profile.medianMinutes[0], profile.medianMinutes[1]) * 60),
      repliedWithinHour: Math.round(greeted * between(random, 0.26, 0.42)),
      boughtGreeted: Math.round(greeted * between(random, 0.17, 0.27) * (page.dailyNet < 20 ? 0.4 : 1)),
      boughtNotGreeted: Math.round(notGreeted * between(random, 0.06, 0.11) * (page.dailyNet < 20 ? 0.4 : 1)),
      recent,
      broadcasts: {
        sent: pageBroadcasts.length,
        deliveries: pageBroadcasts.reduce((sum, cast) => sum + cast.deliveries, 0),
        replied: pageBroadcasts.reduce((sum, cast) => sum + cast.replied, 0),
        bought: pageBroadcasts.reduce((sum, cast) => sum + cast.bought, 0),
      },
    });
  }
  broadcasts.sort((left, right) => right.sentAt.localeCompare(left.sentAt));
  return { from: isoAt(from), to: request.now.toISOString(), pages, broadcasts: broadcasts.slice(0, 100), serverNow: request.now.toISOString() };
}

// --- Win-back ---

const APPROACHES = [
  { id: 1, label: "Напомнить, о чём говорили", sortOrder: 1, active: true, popularity: 0.32, reply: 0.41, buy: 0.13 },
  { id: 2, label: "Личное голосовое с именем", sortOrder: 2, active: true, popularity: 0.18, reply: 0.49, buy: 0.17 },
  { id: 3, label: "Скидка на платное сообщение, которое он открывал", sortOrder: 3, active: true, popularity: 0.2, reply: 0.31, buy: 0.21 },
  { id: 4, label: "Фото «скучаю»", sortOrder: 4, active: true, popularity: 0.16, reply: 0.43, buy: 0.1 },
  { id: 5, label: "Спросить про его день", sortOrder: 5, active: true, popularity: 0.14, reply: 0.36, buy: 0.07 },
  { id: 6, label: "Бесплатный тизер", sortOrder: 6, active: false, popularity: 0.24, reply: 0.27, buy: 0.08 },
] as const;

/** When the «Вернуть» tab appeared, and when the free teaser was retired. */
const WIN_BACK_SINCE_DAYS = 40;
const TEASER_RETIRED_DAYS = 18;

const PICKS_PER_DAY: Readonly<Record<string, number>> = { "alex.k": 3.1, "kate.v": 2.6, "den.s": 3.8, "olya.m": 1.9, "ivan.p": 0.9, "lena.r": 1.6 };

export function teamWinBackApproaches(): KernelOperationResponse<"teamWinBackApproaches"> {
  return { approaches: APPROACHES.map(({ id, label, sortOrder, active }) => ({ id, label, sortOrder, active })) };
}

function chatterUntil(user: DemoUser, now: number): number {
  if (!user.active) return now - 12 * DAY;
  return now;
}

export function teamWinBackResults(request: DemoRequest, scope: readonly string[], days: number): KernelOperationResponse<"teamWinBackResults"> {
  const now = request.now.getTime();
  const from = windowStart(request.now, days);
  const rows: KernelOperationResponse<"teamWinBackResults">["rows"] = [];
  /** Days of [start, end) that lie at least `age` days before now. */
  const span = (start: number, end: number, age: number) => Math.max(0, (Math.min(end, now - age * DAY) - start) / DAY);
  for (const approach of APPROACHES) {
    for (const user of DEMO_CHATTERS) {
      if (!user.pages.some((label) => scope.includes(label))) continue;
      const start = Math.max(from, now - WIN_BACK_SINCE_DAYS * DAY);
      const end = Math.min(chatterUntil(user, now), approach.active ? now : now - TEASER_RETIRED_DAYS * DAY);
      if (end <= start) continue;
      const random = rng(`winback:${approach.id}:${user.username}:${days}`);
      const perDay = (PICKS_PER_DAY[user.username] ?? 1) * approach.popularity * between(random, 0.7, 1.3);
      const attempts = Math.round(perDay * span(start, end, 0));
      if (attempts === 0) continue;
      const fraction = (age: number) => span(start, end, age) / span(start, end, 0);
      const matured72h = Math.round(attempts * fraction(3));
      const matured7d = Math.round(attempts * fraction(7));
      const matured30d = Math.round(attempts * fraction(30));
      const bought7d = Math.round(matured7d * approach.buy * between(random, 0.7, 1.3) * (user.username === "ivan.p" ? 0.4 : 1));
      const buyers30d = Math.round(matured30d * approach.buy * between(random, 0.9, 1.5));
      rows.push({
        approachId: approach.id,
        approach: approach.label,
        userId: user.id,
        username: user.username,
        attempts,
        sent: Math.round(attempts * between(random, 0.82, 0.96)),
        matured72h,
        replied72h: Math.round(matured72h * approach.reply * between(random, 0.8, 1.2)),
        matured7d,
        bought7d,
        matured30d,
        spent30dMills: Math.round(buyers30d * between(random, 28, 75)) * 1000,
      });
    }
  }
  rows.sort((left, right) => left.approachId - right.approachId || right.attempts - left.attempts);
  return { from: isoAt(from), to: request.now.toISOString(), rows, serverNow: request.now.toISOString() };
}
