/**
 * The invented agency the demo console shows. Every name here is made up;
 * the shapes follow the real agency (a model with several Fansly pages and an
 * OnlyFans pair, smaller models with one or two pages, an owner, two team
 * leads and a handful of chatters) so the screens look the way they do in use.
 */
import { between, daysAgo, hashString, intBetween, isoDay, pick, rng, spendTail } from "./core.ts";

export type DemoPlatform = "fansly" | "onlyfans" | "telegram";

/**
 * The moment the owner switched the OnlyFans API off, as on production. One fixed
 * instant: «по 1 ноября» stays true on whatever day the demo is opened. What went
 * only through the API stops here; money, chats and shifts go on through ChatSpace.
 */
export const DEMO_OFAPI_OFF_AT = Date.parse("2026-11-01T10:21:00Z");
export const DEMO_OFAPI_OFF_DAY = "2026-11-01";
/** What the ChatSpace feed writes after it, of what the API did: as on production. */
const CHATSPACE_FEED_SHARE = 0.15;

export interface DemoModel {
  id: number;
  slug: string;
  name: string;
}

export interface DemoPage {
  id: number;
  label: string;
  platform: DemoPlatform;
  modelSlug: string;
  modelName: string;
  username: string;
  displayName: string;
  /** Fansly only; null on OnlyFans and Telegram. */
  followers: number | null;
  subscribers: number;
  /** A typical day's net revenue in dollars, before the daily noise. */
  dailyNet: number;
  /** How collection of this page looks today. */
  health: "healthy" | "attention" | "off";
}

export const DEMO_MODELS: readonly DemoModel[] = [
  { id: 1, slug: "mia-hart", name: "Mia Hart" },
  { id: 2, slug: "nova-lane", name: "Nova Lane" },
  { id: 3, slug: "ivy-rose", name: "Ivy Rose" },
];

function model(slug: string): DemoModel {
  const found = DEMO_MODELS.find((item) => item.slug === slug);
  if (!found) throw new Error(`demo: no model ${slug}`);
  return found;
}

function page(
  id: number,
  label: string,
  platform: DemoPlatform,
  modelSlug: string,
  username: string,
  followers: number | null,
  subscribers: number,
  dailyNet: number,
  health: DemoPage["health"] = "healthy",
): DemoPage {
  const owner = model(modelSlug);
  return {
    id,
    label,
    platform,
    modelSlug,
    modelName: owner.name,
    username,
    displayName: owner.name,
    followers,
    subscribers,
    dailyNet,
    health,
  };
}

export const DEMO_PAGES: readonly DemoPage[] = [
  page(11, "mia-1", "fansly", "mia-hart", "miahart", 9840, 1420, 210),
  page(12, "mia-2", "fansly", "mia-hart", "miahartvip", 8410, 960, 185),
  page(13, "mia-3", "fansly", "mia-hart", "miaafterdark", 7905, 610, 90),
  page(14, "mia-of", "onlyfans", "mia-hart", "miahart.of", null, 4640, 125, "off"),
  page(15, "mia-vip-of", "onlyfans", "mia-hart", "miahart.vip", null, 1760, 195, "off"),
  page(21, "nova-1", "fansly", "nova-lane", "novalane", 5610, 820, 690, "attention"),
  page(31, "ivy-1", "fansly", "ivy-rose", "ivyrose", 3350, 140, 4),
  page(32, "ivy-2", "fansly", "ivy-rose", "ivyrosexo", 18320, 290, 9),
  // The last of the list: the run ids of the old journal count the pages in this order.
  page(16, "mia-tg", "telegram", "mia-hart", "miahart_tg", null, 0, 0),
];

/** The pages the hub has data of: a Telegram page is in the catalog and nowhere else. */
export const DEMO_DATA_PAGES = DEMO_PAGES.filter((item): item is DemoPage & { platform: "fansly" | "onlyfans" } => item.platform !== "telegram");

export function demoPage(label: string): DemoPage | undefined {
  return DEMO_PAGES.find((item) => item.label === label);
}

export function demoPagesOfModel(slug: string): DemoPage[] {
  return DEMO_PAGES.filter((item) => item.modelSlug === slug);
}

// --- People of the agency ---

export interface DemoUser {
  id: number;
  username: string;
  role: "owner" | "team_lead" | "chatter";
  /** How the console shows the person. */
  name: string;
  pages: readonly string[];
  active: boolean;
}

const ALL_LABELS = DEMO_PAGES.map((item) => item.label);

export const DEMO_USERS: readonly DemoUser[] = [
  { id: 1, username: "owner", role: "owner", name: "Владелец", pages: ALL_LABELS, active: true },
  { id: 2, username: "lead.marta", role: "team_lead", name: "Марта", pages: ALL_LABELS, active: true },
  { id: 3, username: "lead.oleg", role: "team_lead", name: "Олег", pages: ["nova-1", "ivy-1", "ivy-2"], active: true },
  { id: 4, username: "alex.k", role: "chatter", name: "Алекс", pages: ["mia-1", "mia-2"], active: true },
  { id: 5, username: "kate.v", role: "chatter", name: "Катя", pages: ["mia-1", "mia-3"], active: true },
  { id: 6, username: "den.s", role: "chatter", name: "Денис", pages: ["nova-1"], active: true },
  { id: 7, username: "olya.m", role: "chatter", name: "Оля", pages: ["mia-of", "mia-vip-of"], active: true },
  { id: 8, username: "ivan.p", role: "chatter", name: "Иван", pages: ["ivy-1", "ivy-2"], active: true },
  { id: 9, username: "lena.r", role: "chatter", name: "Лена", pages: ["mia-2", "nova-1"], active: false },
];

export function demoUserByRole(role: DemoUser["role"]): DemoUser {
  const found = DEMO_USERS.find((item) => item.role === role && item.active);
  if (!found) throw new Error(`demo: no ${role}`);
  return found;
}

export const DEMO_CHATTERS = DEMO_USERS.filter((item) => item.role === "chatter");

// --- Fans ---

export interface DemoFan {
  /** Platform user id as the platform writes it (digits). */
  platformUserId: string;
  username: string;
  displayName: string;
  /** All-time net spend on this page, dollars. */
  totalSpent: number;
  /** Spend of the last 30 days, dollars. */
  spent30d: number;
  purchases: number;
  firstSeenDaysAgo: number;
  /** null: never bought. */
  lastPurchaseDaysAgo: number | null;
  /** Days since the fan last wrote. */
  lastMessageDaysAgo: number;
  isSubscriber: boolean;
  isFollower: boolean;
  /** Subscription price in dollars, 0 = free. */
  tierPrice: number;
  autoRenew: boolean;
  country: string;
}

const HANDLE_STEMS = [
  "midnight", "rider", "tommy", "jake", "big_mike", "sunny", "ghost", "maverick", "dan", "lucky",
  "chris", "wolf", "texan", "joey", "nightowl", "blaze", "sam", "cold", "dark_viking", "kev",
  "ricky", "paul", "hunter", "max", "oliver", "leo", "brook", "storm", "ace", "vince",
  "eddie", "frank", "gabe", "harry", "iggy", "jonny", "kyle", "liam", "marco", "nate",
] as const;

const DISPLAY_NAMES = [
  "Mike", "Tom", "Jake R.", "Sunny", "Dan", "Chris", "Wolf", "Joey", "Kev", "Ricky", "Paul",
  "Hunter", "Max", "Oliver", "Leo", "Storm", "Ace", "Vince", "Eddie", "Frank", "Gabe", "Harry",
  "Sir Lancelot", "Dark Viking", "Cold Captain", "Night Owl", "Big Mike", "Texas Tom", "Marco", "Nate",
] as const;

const COUNTRIES = ["US", "US", "US", "US", "GB", "CA", "DE", "AU", "NL", "SE"] as const;

const fanCache = new Map<string, DemoFan[]>();

/** The fans of a page, richest first. Deterministic: the same page always has the same fans. */
export function demoFans(label: string): DemoFan[] {
  const cached = fanCache.get(label);
  if (cached) return cached;
  const source = demoPage(label);
  const random = rng(`fans:${label}`);
  // The hub keeps no fans of a Telegram page.
  const count = source?.platform === "telegram" ? 0 : source ? Math.min(420, Math.max(60, Math.round((source.subscribers + (source.followers ?? 0) / 4) / 12))) : 0;
  // A real agency's top fans spend thousands over their lifetime; most spend under $50.
  const median = source ? Math.max(3, source.dailyNet / 5) : 10;
  const fans: DemoFan[] = [];
  for (let index = 0; index < count; index += 1) {
    const stem = pick(random, HANDLE_STEMS);
    const suffix = random() < 0.6 ? String(intBetween(random, 1, 999)) : "";
    const buyer = random() < 0.55;
    const totalSpent = buyer ? Math.round(spendTail(random, median, 1.45) * 100) / 100 : 0;
    const firstSeenDaysAgo = intBetween(random, 1, 420);
    const lastPurchaseDaysAgo = buyer ? Math.min(firstSeenDaysAgo, Math.round(between(random, 0, 1) ** 2 * 120)) : null;
    const isSubscriber = source?.platform === "onlyfans" ? true : random() < 0.35;
    const id = String(hashString(`${label}:${index}`)).padStart(10, "7");
    fans.push({
      platformUserId: source?.platform === "fansly" ? `7${id}${String(index).padStart(7, "0")}` : `${200000 + (hashString(id) % 800000)}`,
      username: `${stem}${suffix}`,
      displayName: random() < 0.7 ? pick(random, DISPLAY_NAMES) : `${stem}${suffix}`,
      totalSpent,
      spent30d: lastPurchaseDaysAgo !== null && lastPurchaseDaysAgo <= 30 ? Math.round(totalSpent * between(random, 0.05, 0.6) * 100) / 100 : 0,
      purchases: buyer ? Math.max(1, Math.round(totalSpent / between(random, 8, 30))) : 0,
      firstSeenDaysAgo,
      lastPurchaseDaysAgo,
      lastMessageDaysAgo: Math.round(between(random, 0, 1) ** 2.5 * 90),
      isSubscriber,
      isFollower: source?.platform === "fansly",
      tierPrice: isSubscriber ? pick(random, [0, 4.99, 9.99, 9.99, 14.99, 24.99]) : 0,
      autoRenew: random() < 0.6,
      country: pick(random, COUNTRIES),
    });
  }
  fans.sort((left, right) => right.totalSpent - left.totalSpent);
  fanCache.set(label, fans);
  return fans;
}

export function demoFan(label: string, platformUserId: string): DemoFan | undefined {
  return demoFans(label).find((fan) => fan.platformUserId === platformUserId);
}

// --- Money over time ---

/** What of a day's usual money an OnlyFans page still has: all of it through the
 *  API, a part of the switch-off's day, then what the ChatSpace feed writes. */
function feedShareOf(source: DemoPage | undefined, day: string): number {
  if (source?.platform !== "onlyfans" || day < DEMO_OFAPI_OFF_DAY) return 1;
  if (day > DEMO_OFAPI_OFF_DAY) return CHATSPACE_FEED_SHARE;
  const before = (DEMO_OFAPI_OFF_AT - Date.parse(`${DEMO_OFAPI_OFF_DAY}T00:00:00Z`)) / 86_400_000;
  return before + (1 - before) * CHATSPACE_FEED_SHARE;
}

/**
 * A page's net revenue by day, dollars, for the `days` days ending today
 * (oldest first). Weekends are stronger, and every page has its own rhythm.
 */
export function demoDailyNet(label: string, now: Date, days: number): { day: string; net: number }[] {
  const source = demoPage(label);
  const base = source?.dailyNet ?? 0;
  return Array.from({ length: days }, (_, index) => {
    const date = daysAgo(now, days - 1 - index);
    const day = isoDay(date);
    const random = rng(`net:${label}:${day}`);
    const weekday = date.getUTCDay();
    const weekend = weekday === 0 || weekday === 6 ? 1.25 : 1;
    const spike = random() < 0.06 ? between(random, 1.8, 3.2) : 1;
    const net = base === 0 ? 0 : Math.max(0, base * weekend * spike * between(random, 0.55, 1.45) * feedShareOf(source, day));
    return { day, net: Math.round(net * 100) / 100 };
  });
}

/** The sum of a page's net revenue over the `days` days ending `offsetDays` ago. */
export function demoNetSum(label: string, now: Date, days: number, offsetDays = 0): number {
  const end = daysAgo(now, offsetDays);
  return demoDailyNet(label, end, days).reduce((sum, item) => sum + item.net, 0);
}
