/**
 * What a Fansly page shows of itself: its profile and its counters, what it
 * sells (tiers, links, place among creators), its mass messages and its
 * settings. OnlyFans pages answer with empty lists: the screens say these
 * views are Fansly-only.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import {
  between,
  daysAgo,
  hashString,
  hoursAgo,
  intBetween,
  iso,
  isoDay,
  mills,
  pick,
  queryNumber,
  queryString,
  rng,
  type DemoHandlers,
  type DemoReply,
} from "../core.ts";
import { demoNetSum, type DemoPage } from "../world.ts";
import { resolvePage } from "./page-world.ts";

function isReply(value: unknown): value is DemoReply {
  return typeof value === "object" && value !== null && (value as { demoReply?: unknown }).demoReply === true;
}

function ref(page: DemoPage, kind: string, index: number): string {
  return `${7 + (hashString(`${kind}:${page.label}`) % 2)}${String(hashString(`${kind}:${page.label}:${index}`)).padStart(10, "3")}${String(index).padStart(6, "0")}`;
}

// --- Profile ---

type ProfileVersion = NonNullable<KernelOperationResponse<"pageProfile">["current"]>;

const ABOUT: Record<string, string> = {
  "mia-hart": "Your favorite girl next door 💋 22, Texas, gym & coffee addict.\nDaily posts, chatting is always me 🥰\nCustoms open — DM me!",
  "nova-lane": "Nova ✨ 24 · cosplay, lingerie & late-night streams\nTop 1% creator · new sets every Friday\nTips make my day 💜",
  "ivy-rose": "Ivy 🌹 just a shy redhead from Oregon\nhiking, books & tiny bikinis\nsay hi, I answer everyone",
};

function wallsOf(page: DemoPage, renamed: boolean): ProfileVersion["walls"] {
  return [
    { wallRef: ref(page, "wall", 1), pos: 1, name: "Posts", description: null, private: false, mainWall: true, defaultWall: true },
    { wallRef: ref(page, "wall", 2), pos: 2, name: renamed ? "VIP only 🔒" : "VIP", description: "Full-length videos for subscribers", private: false, mainWall: false, defaultWall: false },
    { wallRef: ref(page, "wall", 3), pos: 3, name: "Behind the scenes", description: "Shoot day selfies and bloopers", private: false, mainWall: false, defaultWall: false },
    { wallRef: ref(page, "wall", 4), pos: 4, name: "Archive 2025", description: null, private: true, mainWall: false, defaultWall: false },
  ];
}

function profileVersions(page: DemoPage, now: Date): ProfileVersion[] {
  const random = rng(`profile:${page.label}`);
  const about = ABOUT[page.modelSlug] ?? "";
  const base: ProfileVersion = {
    contentSha256: "",
    firstSeenAt: "",
    lastSeenAt: "",
    username: page.username,
    displayName: page.displayName,
    about: about.replace("Customs open — DM me!", "DM me 💌"),
    location: page.modelSlug === "ivy-rose" ? "Oregon" : "Texas, USA",
    avatarMediaRef: ref(page, "avatar", 1),
    bannerMediaRef: ref(page, "banner", 1),
    socials: [{ providerId: "1", handle: `${page.username}x` }],
    badges: [
      { badgeRef: ref(page, "badge", 1), badgeType: 2, title: "Verified Creator", description: "Identity verified by Fansly", awardedAt: iso(daysAgo(now, 410, 12)) },
    ],
    pinnedPosts: [
      { postRef: ref(page, "post", 1), wallRef: ref(page, "wall", 1), pos: 1, pinnedAt: iso(daysAgo(now, 170, 18)) },
    ],
    walls: wallsOf(page, false),
    profileFlags: 0,
    accountFlags: 4,
    profileAccessFlags: 0,
  };
  const steps: { daysAgoAt: number; change: (v: ProfileVersion) => ProfileVersion }[] = [
    { daysAgoAt: 160, change: (v) => v },
    { daysAgoAt: 118, change: (v) => ({ ...v, socials: [...v.socials, { providerId: "4", handle: `${page.username}.ig` }] }) },
    { daysAgoAt: 77, change: (v) => ({ ...v, about, avatarMediaRef: ref(page, "avatar", 2) }) },
    {
      daysAgoAt: 41,
      change: (v) => ({
        ...v,
        badges: [...v.badges, { badgeRef: ref(page, "badge", 2), badgeType: 7, title: page.dailyNet > 300 ? "Top 1% Creator" : page.dailyNet > 100 ? "Top 5% Creator" : "Rising Star", description: "Earnings rank last month", awardedAt: iso(daysAgo(now, 41, 6)) }],
      }),
    },
    {
      daysAgoAt: 19,
      change: (v) => ({
        ...v,
        walls: wallsOf(page, true),
        pinnedPosts: [...v.pinnedPosts, { postRef: ref(page, "post", 2), wallRef: ref(page, "wall", 2), pos: 1, pinnedAt: iso(daysAgo(now, 19, 20)) }],
      }),
    },
    { daysAgoAt: 6, change: (v) => ({ ...v, bannerMediaRef: ref(page, "banner", 2), socials: [...v.socials, { providerId: "5", handle: page.username }] }) },
  ];
  const out: ProfileVersion[] = [];
  let current = base;
  steps.forEach((step, index) => {
    current = step.change(current);
    const next = steps[index + 1];
    out.push({
      ...current,
      contentSha256: String(hashString(`${page.label}:v${index}`).toString(16)).padStart(8, "0").repeat(8),
      firstSeenAt: iso(daysAgo(now, step.daysAgoAt, intBetween(random, 6, 20))),
      lastSeenAt: next ? iso(daysAgo(now, next.daysAgoAt + 1, 23)) : iso(hoursAgo(now, between(random, 0.2, 0.9))),
    });
  });
  return out;
}

function profileDaily(page: DemoPage, now: Date, days: number): KernelOperationResponse<"pageProfile">["daily"] {
  const random = rng(`profile-daily:${page.label}`);
  const followers = page.followers ?? 0;
  let postLikes = Math.round(followers * between(random, 4, 9));
  let mediaLikes = Math.round(postLikes * between(random, 1.6, 2.4));
  let images = intBetween(random, 600, 1400);
  let videos = intBetween(random, 140, 420);
  const bundles = intBetween(random, 30, 90);
  const rows: KernelOperationResponse<"pageProfile">["daily"] = [];
  let balance = 0;
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = daysAgo(now, index);
    const share = (days - 1 - index) / Math.max(1, days - 1);
    // Payouts go out on Mondays: the balance to withdraw falls back to a little.
    const net = demoNetSum(page.label, date, 1);
    balance = date.getUTCDay() === 1 ? mills(net) : balance + mills(net);
    postLikes += intBetween(random, Math.round(followers / 300), Math.round(followers / 90));
    mediaLikes += intBetween(random, Math.round(followers / 160), Math.round(followers / 50));
    if (random() < 0.7) images += intBetween(random, 1, 8);
    if (random() < 0.45) videos += intBetween(random, 1, 3);
    rows.push({
      day: isoDay(date),
      followers: Math.round(followers * (0.82 + 0.18 * share) + between(random, -15, 15)),
      subscribers: Math.round(page.subscribers * (0.88 + 0.12 * share) + between(random, -8, 8)),
      postLikes,
      mediaLikes,
      images,
      videos,
      bundles: bundles + Math.floor(share * 6),
      stories: intBetween(random, 0, 4),
      streamStatus: page.modelSlug === "ivy-rose" ? null : random() < 0.05 ? 2 : 1,
      earningsBalanceMills: balance,
      capturedAt: iso(index === 0 ? hoursAgo(now, 0.4) : daysAgo(now, index, 23)),
    });
  }
  const last = rows.at(-1);
  if (last) {
    last.followers = followers;
    last.subscribers = page.subscribers;
  }
  return rows;
}

// --- Promo ---

type Promo = KernelOperationResponse<"pagePromo">;

function tiersOf(page: DemoPage, now: Date): Promo["tiers"] {
  const tier = (index: number, name: string, color: string, price: number, benefits: string[], max: number | null, promo: boolean): Promo["tiers"][number] => ({
    tierRef: ref(page, "tier", index),
    name,
    color,
    pos: index,
    basePriceMills: mills(price),
    maxSubscribers: max,
    benefits,
    missingSince: null,
    plans: [30, 90, 180, 365].map((days, planIndex) => ({
      planRef: ref(page, `plan-${index}`, planIndex),
      status: 1,
      durationDays: days,
      priceMills: mills(Math.round(price * (days / 30) * [1, 0.9, 0.85, 0.75][planIndex]! * 100) / 100),
      missingSince: null,
      promotions: promo && planIndex === 0
        ? [{
          promoRef: ref(page, `promo-${index}`, 1),
          priceMills: mills(Math.round(price * 0.5 * 100) / 100),
          durationDays: 30,
          status: 1,
          maxUses: 100,
          newSubscribersOnly: true,
          startsAt: iso(daysAgo(now, 4, 0)),
          endsAt: iso(daysAgo(now, -3, 23)),
          description: "Halloween week -50%",
        }]
        : [],
    })),
  });
  return [
    tier(1, "Bestie", "#ff7eb6", page.dailyNet > 300 ? 12.99 : 9.99, ["Full timeline", "DM access", "Weekly bonus set"], null, true),
    tier(2, "VIP", "#a77bff", page.dailyNet > 300 ? 29.99 : 24.99, ["Everything in Bestie", "Uncensored videos", "Priority replies", "Monthly custom photo"], 150, false),
    { ...tier(3, "Old fan tier", "#9aa4b2", 4.99, [], null, false), missingSince: iso(daysAgo(now, 95, 0)) },
  ];
}

const LINKS: { label: string; type: number; weight: number }[] = [
  { label: "Fansly FYP", type: 1, weight: 1 },
  { label: "Fansly Suggestions", type: 1, weight: 0.45 },
  { label: "Fansly Search", type: 1, weight: 0.3 },
  { label: "Reddit · r/gonewild", type: 0, weight: 0.8 },
  { label: "X bio", type: 0, weight: 0.35 },
  { label: "Instagram story", type: 0, weight: 0.2 },
  { label: "TikTok link-in-bio", type: 0, weight: 0.25 },
  { label: "Telegram promo (Oct)", type: 0, weight: 0.12 },
];

function trackingOf(page: DemoPage, now: Date): { links: Promo["trackingLinks"]; days: Promo["trackingDays"] } {
  const scale = Math.max(0.15, (page.followers ?? 0) / 8000);
  const days: Promo["trackingDays"] = [];
  const links = LINKS.map((link, index): Promo["trackingLinks"][number] => {
    const random = rng(`link:${page.label}:${index}`);
    const linkRef = ref(page, "link", index);
    const ageDays = link.type === 1 ? 400 : intBetween(random, 25, 300);
    let last7 = { follows: 0, subscriptions: 0, grossMills: 0 };
    let last30 = { follows: 0, subscriptions: 0, grossMills: 0 };
    for (let day = 89; day >= 0; day -= 1) {
      if (day > ageDays) continue;
      const follows = Math.round(between(random, 0, 14) * link.weight * scale);
      const subscriptions = random() < 0.4 ? Math.round(between(random, 0, 3) * link.weight * scale) : 0;
      const grossMills = subscriptions * mills(pick(random, [9.99, 12.99, 24.99]));
      if (follows + subscriptions > 0) days.push({ day: isoDay(daysAgo(now, day)), linkRef, follows, subscriptions, grossMills });
      if (day < 7) last7 = { follows: last7.follows + follows, subscriptions: last7.subscriptions + subscriptions, grossMills: last7.grossMills + grossMills };
      if (day < 30) last30 = { follows: last30.follows + follows, subscriptions: last30.subscriptions + subscriptions, grossMills: last30.grossMills + grossMills };
    }
    const totalFollows = Math.round(last30.follows * ageDays / 30 * between(random, 0.8, 1.2));
    const totalSubs = Math.round(last30.subscriptions * ageDays / 30 * between(random, 0.8, 1.2));
    const clicks = Math.round(totalFollows * between(random, 2.5, 6));
    return {
      linkRef,
      label: link.label,
      description: link.type === 1 ? "Встроенная ссылка Fansly" : null,
      linkType: link.type,
      status: 1,
      createdAt: iso(daysAgo(now, ageDays, 10)),
      clicks: link.type === 1 ? null : clicks,
      claims: link.type === 1 ? null : Math.round(clicks * between(random, 0.3, 0.6)),
      follows: totalFollows,
      subscriptions: totalSubs,
      grossMills: totalSubs * mills(between(random, 14, 30)),
      netMills: null,
      missingSince: null,
      lastSeenDay: isoDay(now),
      last7: { sinceDay: isoDay(daysAgo(now, 7)), clicks: null, claims: null, ...last7 },
      last30: { sinceDay: isoDay(daysAgo(now, 30)), clicks: null, claims: null, ...last30 },
    };
  });
  days.sort((left, right) => left.day.localeCompare(right.day));
  return { links, days };
}

function monthsOf(page: DemoPage, now: Date): Promo["months"] {
  const out: Promo["months"] = [];
  const base = page.dailyNet > 300 ? 0.6 : page.dailyNet > 150 ? 2 : page.dailyNet > 50 ? 5 : 38;
  for (let back = 0; back < 14; back += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 15));
    const random = rng(`month:${page.label}:${isoDay(date)}`);
    // The running month counts only its days so far.
    const share = back === 0 ? now.getUTCDate() / 30 : 1;
    const net = page.dailyNet * 30 * share * between(random, 0.95, 1.35);
    out.push({
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      grossMills: mills(net / 0.8),
      netMills: mills(net),
      topPercent: Math.round(base * between(random, 0.75, 1.3) * 100) / 100,
      maxTopPercent: Math.round(base * 1.6 * 100) / 100,
    });
  }
  return out;
}

function recapOf(page: DemoPage): Promo["recap"] {
  const random = rng(`recap:${page.label}`);
  const rows: [string, unknown][] = [
    ["highest_earning_day", { date: "2025-12-24", amount: Math.round(page.dailyNet * between(random, 5, 9)) }],
    ["highest_earning_month", { month: "December", amount: Math.round(page.dailyNet * 30 * 1.4) }],
    ["highest_earning_fan", { username: "midnight_rider", amount: Math.round(page.dailyNet * between(random, 6, 12)) }],
    ["top_earned_by_category", { messages: 46, tips: 28, subscriptions: 21, posts: 5 }],
    ["top_earn_position", { percent: page.dailyNet > 300 ? 0.8 : page.dailyNet > 100 ? 3.4 : 41 }],
    ["fyp_impact_percent", { percent: Math.round(between(random, 18, 44)) }],
    ["follower_country_count", { countries: intBetween(random, 60, 118) }],
    ["model_sub_follow_gains", { followers: Math.round((page.followers ?? 0) * 0.7), subscribers: Math.round(page.subscribers * 1.9) }],
    ["model_total_uploaded", { images: intBetween(random, 500, 1200), videos: intBetween(random, 120, 380) }],
  ];
  return rows.map(([statName, value], index) => ({ year: 2025, statRef: ref(page, "recap", index), statName, value: JSON.stringify(value) }));
}

function pollsOf(page: DemoPage, now: Date): Promo["polls"] {
  const polls: { title: string; options: string[] }[] = [
    { title: "What should I shoot next weekend?", options: ["Red lingerie", "Gym fit", "Bubble bath", "Cosplay"] },
    { title: "Live stream on Friday or Saturday?", options: ["Friday", "Saturday"] },
    { title: "Favorite set this month?", options: ["Beach day", "Cozy sweater", "Office look"] },
  ];
  return polls.map((poll, index) => {
    const random = rng(`poll:${page.label}:${index}`);
    return {
      pollRef: ref(page, "poll", index),
      title: poll.title,
      description: null,
      status: index === 0 ? 1 : 2,
      createdAt: iso(daysAgo(now, 3 + index * 17, 18)),
      options: poll.options.map((title) => ({ title, votes: Math.round(between(random, 10, 160) * Math.max(0.2, (page.followers ?? 0) / 8000)) })),
    };
  });
}

function automationsOf(page: DemoPage, now: Date): Promo["automations"] {
  return [
    { automationRef: ref(page, "auto", 1), triggerType: 3, tierName: null, delaySeconds: 300, cooldownSeconds: 0, messageText: "hey you 🥰 thanks for the follow! subscribe to see everything, I reply to every message myself", attachmentCount: 1, missingSince: null },
    { automationRef: ref(page, "auto", 2), triggerType: 15, tierName: "Bestie", delaySeconds: 60, cooldownSeconds: 0, messageText: "welcome babe!! 💕 tell me a little about you — what made you subscribe?", attachmentCount: 0, missingSince: null },
    { automationRef: ref(page, "auto", 3), triggerType: 15010, tierName: null, delaySeconds: 3600, cooldownSeconds: 86_400 * 7, messageText: "you renewed 🥺 that means so much. a little gift for you 🎁", attachmentCount: 2, missingSince: null },
    { automationRef: ref(page, "auto", 4), triggerType: 7001, tierName: null, delaySeconds: 0, cooldownSeconds: 3600, messageText: "omg thank you for the tip 😍", attachmentCount: 0, missingSince: null },
    { automationRef: ref(page, "auto", 5), triggerType: 15002, tierName: null, delaySeconds: 120, cooldownSeconds: 0, messageText: "glad you came from my gift link!", attachmentCount: 0, missingSince: iso(daysAgo(now, 30)) },
  ];
}

// --- Mass messages ---

const BROADCAST_TEXTS = [
  "Good morning ☀️ new set just dropped on my wall, go check it 💕",
  "I made something naughty for you… 18 min, uncut 🔥 unlock it before midnight",
  "Halloween special 🎃 my witch costume set, only for my favorites",
  "Who's up late? 🌙 I'm in bed and bored…",
  "Weekend bundle: 3 videos for the price of one 😈",
  "Thank you for being here 🥺 small gift inside, no strings",
  "Going live tonight at 9pm EST, come say hi 💜",
  "Shower thoughts 🚿 (with a little video)",
  "New customs slots open this week — reply 'custom' if you want one",
  "Gym day 💪 sweaty selfie set inside",
  "Rate my outfit 1-10? 👗",
  "Sunday self-care vibes 🛁 full video in your DMs",
];

function broadcastsOf(page: DemoPage, now: Date): KernelOperationResponse<"pageMassMessages">["rows"] {
  const random = rng(`mass:${page.label}`);
  const audience = Math.round((page.followers ?? 0) * 0.85 + page.subscribers);
  const rows: KernelOperationResponse<"pageMassMessages">["rows"] = [];
  let hours = between(random, 3, 20);
  for (let index = 0; index < 64; index += 1) {
    // Halloween goes out only in the last days of October.
    const sentOn = hoursAgo(now, hours);
    const halloween = sentOn.getUTCMonth() === 9 && sentOn.getUTCDate() >= 25;
    const everyday = BROADCAST_TEXTS.filter((item) => !item.startsWith("Halloween"));
    const text = halloween && random() < 0.5 ? BROADCAST_TEXTS.find((item) => item.startsWith("Halloween"))! : pick(random, everyday);
    const paid = /unlock|bundle|naughty|uncut|Shower|Sunday/.test(text);
    const toSubs = paid || random() < 0.4;
    const sent = Math.round((toSubs ? page.subscribers * between(random, 0.85, 0.98) : audience * between(random, 0.7, 0.95)));
    const read = Math.round(sent * between(random, 0.22, 0.48));
    const price = paid ? pick(random, [9.99, 14.99, 19.99, 24.99, 29.99]) : null;
    const sales = paid ? Math.round(read * between(random, 0.01, 0.05)) : 0;
    const net = price === null ? 0 : sales * price * 0.8;
    rows.push({
      broadcastRef: ref(page, "mass", index),
      list: "live",
      createdAt: iso(hoursAgo(now, hours)),
      scheduledFor: null,
      deletedAt: null,
      text,
      sent,
      delivered: Math.round(sent * 0.98),
      read,
      tipsMills: random() < 0.35 ? mills(pick(random, [5, 10, 15, 20, 40])) : 0,
      offeredMedia: paid ? intBetween(random, 1, 4) : random() < 0.3 ? 1 : 0,
      offeredBundles: paid && random() < 0.25 ? 1 : 0,
      minPriceMills: price === null ? null : mills(price),
      maxPriceMills: price === null ? null : mills(price),
      salesCount: paid ? sales : 0,
      salesNetMills: mills(net),
      salesPendingMills: hours < 72 && paid ? mills(net * 0.3) : 0,
    });
    hours += between(random, 14, 40);
  }
  for (let index = 0; index < 3; index += 1) {
    rows.push({
      broadcastRef: ref(page, "mass-s", index),
      list: "scheduled",
      createdAt: iso(hoursAgo(now, between(random, 2, 30))),
      scheduledFor: iso(hoursAgo(now, -(12 + index * 26))),
      deletedAt: null,
      text: pick(random, BROADCAST_TEXTS.filter((item) => !item.startsWith("Halloween"))),
      sent: null,
      delivered: null,
      read: null,
      tipsMills: null,
      offeredMedia: index === 1 ? 2 : 0,
      offeredBundles: 0,
      minPriceMills: index === 1 ? mills(19.99) : null,
      maxPriceMills: index === 1 ? mills(19.99) : null,
      salesCount: null,
      salesNetMills: null,
      salesPendingMills: null,
    });
  }
  for (let index = 0; index < 4; index += 1) {
    const created = between(random, 48, 24 * 50);
    const sent = Math.round(page.subscribers * between(random, 0.5, 0.9));
    rows.push({
      broadcastRef: ref(page, "mass-d", index),
      list: "deleted",
      createdAt: iso(hoursAgo(now, created)),
      scheduledFor: null,
      deletedAt: iso(hoursAgo(now, created - between(random, 1, 20))),
      text: pick(random, BROADCAST_TEXTS.filter((item) => !item.startsWith("Halloween"))),
      sent,
      delivered: Math.round(sent * 0.97),
      read: Math.round(sent * 0.2),
      tipsMills: 0,
      offeredMedia: 1,
      offeredBundles: 0,
      minPriceMills: mills(14.99),
      maxPriceMills: mills(14.99),
      salesCount: 0,
      salesNetMills: 0,
      salesPendingMills: 0,
    });
  }
  return rows.sort((left, right) => (right.scheduledFor ?? right.createdAt ?? "").localeCompare(left.scheduledFor ?? left.createdAt ?? ""));
}

// --- Settings ---

type SettingsRoute = KernelOperationResponse<"pageSettings">["routes"][number];

function settingsOf(page: DemoPage, now: Date): SettingsRoute[] {
  const random = rng(`settings:${page.label}`);
  const seen = (days: number) => iso(daysAgo(now, days, intBetween(random, 2, 6)));
  const today = iso(hoursAgo(now, between(random, 2, 14)));
  const version = (route: string, summary: string, body: unknown, firstDays: number, lastDays?: number) => ({
    route,
    summary,
    body,
    firstSeenAt: seen(firstDays),
    lastSeenAt: lastDays === undefined ? today : seen(lastDays),
  });
  const row = (route: string, current: ReturnType<typeof version>, earlier: ReturnType<typeof version>[] = []): SettingsRoute => ({ route, current, earlier });
  const balance = mills(page.dailyNet * between(random, 4, 7));
  const tags = page.modelSlug === "nova-lane"
    ? ["cosplay", "lingerie", "brunette", "gamer", "petite", "tattoos", "stream"]
    : page.modelSlug === "ivy-rose"
      ? ["redhead", "natural", "outdoors", "petite", "shy"]
      : ["blonde", "girlnextdoor", "fitness", "lingerie", "texas", "tease", "curvy", "solo"];
  return [
    row(
      "settings.account",
      version("settings.account", "видна в поиске · возраст скрыт · заглушено: Новые лайки", { categories: [{ inputs: [{ name: "hideFromSearch", data: "{\"value\":false}" }, { name: "hideAge", data: "{\"value\":true}" }, { name: "muteLikes", label: "Новые лайки", data: "{\"value\":true}" }] }] }, 64),
      [version("settings.account", "видна в поиске · возраст скрыт · уведомления не заглушены", { categories: [] }, 200, 65)],
    ),
    row(
      "settings.geo_blocks",
      version("settings.geo_blocks", page.modelSlug === "mia-hart" ? "гео-блок: US / TX, RU" : "гео-блок: RU", page.modelSlug === "mia-hart" ? [{ locationData: { countryCode: "US", stateCode: "TX" } }, { locationData: { countryCode: "RU" } }] : [{ locationData: { countryCode: "RU" } }], 140),
      page.modelSlug === "mia-hart" ? [version("settings.geo_blocks", "гео-блок: US / TX", [{ locationData: { countryCode: "US", stateCode: "TX" } }], 300, 141)] : [],
    ),
    row("settings.timeline_permissions", version("settings.timeline_permissions", "ленту видят: подписчики", [{ flags: 4 }], 210)),
    row(
      "settings.dm_permissions",
      version("settings.dm_permissions", "в ЛС пишут: фолловеры или подписчики", [{ flags: 6 }], 33),
      [version("settings.dm_permissions", "в ЛС пишут: подписчики", [{ flags: 4 }], 210, 34)],
    ),
    row("settings.watermark", version("settings.watermark", `вотермарка: «fansly.com/${page.username}»`, { text: `fansly.com/${page.username}`, position: 3 }, 260)),
    row("settings.alerts", version("settings.alerts", "каналов алертов: 2 (тип 1, по умолчанию; тип 3, свои настройки)", [{ type: 1 }, { type: 3, metadata: "{\"minTip\":20}" }], 90)),
    row("earnings.overview", version("earnings.overview", `в холде $${(balance / 1000).toFixed(2)}`, { pendingBalance: balance }, 0)),
    row("referrals.stats", version("referrals.stats", "реферальных кодов: 1", { codes: [{ code: page.username.toUpperCase(), uses: intBetween(random, 0, 6) }] }, 180)),
    row(
      "tipgoals.account",
      version("tipgoals.account", page.modelSlug === "ivy-rose" ? "целей типов нет" : "целей типов: 2", page.modelSlug === "ivy-rose" ? [] : [{ label: "New camera 📸", goal: 50000 }, { label: "Beach trip", goal: 120000 }], 12),
      page.modelSlug === "ivy-rose" ? [] : [version("tipgoals.account", "целей типов: 1", [{ label: "New camera 📸", goal: 50000 }], 70, 13)],
    ),
    row("discovery.content", version("discovery.content", "меток For You: 3", [{ id: 1 }, { id: 2 }, { id: 3 }], 55)),
    row("discovery.tags", version("discovery.tags", `тегов: ${tags.length} — ${tags.join(", ")}`, tags.map((tag) => ({ tag })), 22)),
  ];
}

export const pageInsightHandlers: DemoHandlers = {
  pageProfile: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    if (page.platform !== "fansly") return { page: { label: page.label, platform: page.platform }, current: null, versions: [], daily: [] };
    const days = Math.min(400, Math.max(1, queryNumber(request, "days", 180)));
    const versions = profileVersions(page, request.now);
    return { page: { label: page.label, platform: page.platform }, current: versions.at(-1) ?? null, versions, daily: profileDaily(page, request.now, days) };
  },

  pagePromo: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const empty = { page: { label: page.label, platform: page.platform }, currentRank: null, tiers: [], giftLinks: [], trackingLinks: [], months: [], recap: [], polls: [], trackingDays: [], automations: [] };
    if (page.platform !== "fansly") return empty;
    const now = request.now;
    const months = monthsOf(page, now);
    const tracking = trackingOf(page, now);
    const net30 = demoNetSum(page.label, now, 30);
    return {
      page: { label: page.label, platform: page.platform },
      currentRank: {
        topPercent: months[0]?.topPercent ?? null,
        maxTopPercent: months[0]?.maxTopPercent ?? null,
        grossMills: mills(net30 / 0.8),
        netMills: mills(net30),
        windowStart: iso(daysAgo(now, 30, 0)),
        windowEnd: iso(now),
      },
      tiers: tiersOf(page, now),
      giftLinks: [
        { linkRef: ref(page, "gift", 1), label: "Reddit free trial", status: 1, priceMills: 0, originalPriceMills: mills(9.99), durationDays: 3, uses: 41, maxUses: 100, newSubscribersOnly: true, createdAt: iso(daysAgo(now, 12, 15)), startsAt: iso(daysAgo(now, 12, 15)), endsAt: iso(daysAgo(now, -18, 15)), missingSince: null, lastSeenDay: isoDay(now) },
        { linkRef: ref(page, "gift", 2), label: "Win-back -60%", status: 1, priceMills: mills(3.99), originalPriceMills: mills(9.99), durationDays: 30, uses: 17, maxUses: null, newSubscribersOnly: false, createdAt: iso(daysAgo(now, 26, 11)), startsAt: null, endsAt: null, missingSince: null, lastSeenDay: isoDay(now) },
        { linkRef: ref(page, "gift", 3), label: "X promo (Sep)", status: 2, priceMills: mills(4.99), originalPriceMills: mills(9.99), durationDays: 30, uses: 63, maxUses: 60, newSubscribersOnly: true, createdAt: iso(daysAgo(now, 60, 11)), startsAt: iso(daysAgo(now, 60, 11)), endsAt: iso(daysAgo(now, 33, 11)), missingSince: null, lastSeenDay: isoDay(daysAgo(now, 33)) },
      ],
      trackingLinks: tracking.links,
      months,
      recap: recapOf(page),
      polls: pollsOf(page, now),
      trackingDays: tracking.days,
      automations: automationsOf(page, now),
    };
  },

  pageMassMessages: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const list = queryString(request, "list") ?? "all";
    const all = page.platform === "fansly" ? broadcastsOf(page, request.now) : [];
    const rows = list === "all" ? all : all.filter((row) => row.list === list);
    const limit = Math.min(200, Math.max(1, queryNumber(request, "limit", 50)));
    const offset = Math.max(0, queryNumber(request, "offset", 0));
    const totals = rows.reduce((sum, row) => ({
      sent: sum.sent + (row.sent ?? 0),
      read: sum.read + (row.read ?? 0),
      salesCount: sum.salesCount + (row.salesCount ?? 0),
      salesNetMills: sum.salesNetMills + (row.salesNetMills ?? 0),
      tipsMills: sum.tipsMills + (row.tipsMills ?? 0),
    }), { sent: 0, read: 0, salesCount: 0, salesNetMills: 0, tipsMills: 0 });
    return { page: { label: page.label, platform: page.platform }, total: rows.length, totals, rows: rows.slice(offset, offset + limit) };
  },

  pageSettings: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    return { page: { label: page.label, platform: page.platform }, routes: page.platform === "fansly" ? settingsOf(page, request.now) : [] };
  },
};
