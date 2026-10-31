import type { FanQueueDropReason, FanQueueRule, FanQueueScenario } from "@agency_hub_core/contracts";
import type { FanQueueCandidate, FanQueueFilter, FanQueueMoment, OnlineCandidateRow } from "@agency_hub_core/db";
import { millsFromDollars, millsToRoundedDollars } from "@agency_hub_core/shared";

import { decideOnline, ONLINE_RULES, ONLINE_TEMPLATES, type OthersTalking } from "./client-online-rules.ts";

/**
 * Fan queues (docs/plans/2026-10-29-fan-queues/spec.md): the pure part. A
 * rule becomes Hub's filter (moments and mills) and Hub's own words, the ones
 * the asker reads before «да»; a fan gets a short why; a fan of a portion is
 * judged against what Hub knows now (leaves the queue, waits, or goes out);
 * an item gets what to write with. The facts come from
 * packages/db/src/repositories/fan-queues.ts and the «Онлайн» read.
 */

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const UNREACHABLE = new Set(["unavailable", "restricted", "blocked", "gone"]);
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/** How long a fan another chatter is talking to waits before he is offered again. */
export const FAN_QUEUE_TALKING_WAIT_MINUTES = 15;
/** «Позже»: the fan comes back to the queue in this many days. */
export const FAN_QUEUE_LATER_DAYS = 3;

const ago = (now: Date, days: number) => new Date(now.getTime() - days * DAY);

function moment(now: Date, range: { olderThanDays?: number | undefined; withinDays?: number | undefined }): FanQueueMoment {
  return {
    before: range.olderThanDays === undefined ? null : ago(now, range.olderThanDays),
    since: range.withinDays === undefined ? null : ago(now, range.withinDays),
  };
}

function mills(range: { min?: number | undefined; max?: number | undefined }) {
  return {
    min: range.min === undefined ? null : Number(millsFromDollars(range.min)),
    max: range.max === undefined ? null : Number(millsFromDollars(range.max)),
  };
}

/** The rule in Hub's terms, as of `now`. */
export function fanQueueFilterOf(rule: FanQueueRule, now: Date): FanQueueFilter {
  return {
    audience: rule.audience ?? "any",
    fanWrote: rule.fanWrote ?? null,
    fanLastMessage: rule.fanLastMessage === undefined ? null : moment(now, rule.fanLastMessage),
    pagePersonal: rule.pagePersonal === undefined ? null : rule.pagePersonal === "never" ? "never" : moment(now, rule.pagePersonal),
    lifetimeGross: rule.lifetimeSpend === undefined ? null : mills(rule.lifetimeSpend),
    gross30d: rule.spend30d === undefined ? null : mills(rule.spend30d),
    lastPurchase: rule.lastPurchase === undefined ? null : moment(now, rule.lastPurchase),
    followed: rule.followed === undefined ? null : moment(now, rule.followed),
    subscribed: rule.subscribed === undefined ? null : moment(now, rule.subscribed),
    subscriptionEndsBy: rule.subscriptionEnds === undefined ? null : new Date(now.getTime() + rule.subscriptionEnds.withinDays * DAY),
    autoRenew: rule.autoRenew ?? null,
    seenSince: rule.seen !== undefined && "withinDays" in rule.seen ? ago(now, rule.seen.withinDays) : null,
    notSeenSince: rule.seen !== undefined && "notWithinDays" in rule.seen ? ago(now, rule.seen.notWithinDays) : null,
    otherPagesGross: rule.otherPagesSpend === undefined ? null : mills(rule.otherPagesSpend),
    markersInclude: rule.markers?.include ?? [],
    markersExclude: rule.markers?.exclude ?? null,
    order: rule.order ?? "spend",
    limit: rule.limit ?? null,
  };
}

/** The filter a list goes through: every fan of the list, only the always-on exclusions. */
export function fanQueueListFilter(): FanQueueFilter {
  return fanQueueFilterOf({}, new Date(0));
}

const usd = (dollars: number) => `$${dollars.toLocaleString("en-US")}`;
const daysWord = (n: number) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? "день" : a >= 2 && a <= 4 && (b < 12 || b > 14) ? "дня" : "дней";
};

function spendText(range: { min?: number | undefined; max?: number | undefined }, what: string, none: string): string {
  if (range.max === 0) return none;
  if (range.min !== undefined && range.max !== undefined) return `${what} ${usd(range.min)}-${usd(range.max)}`;
  if (range.min !== undefined) return `${what} от ${usd(range.min)}`;
  return `${what} до ${usd(range.max!)}`;
}

function ageText(
  range: { olderThanDays?: number | undefined; withinDays?: number | undefined },
  older: (days: string) => string,
  within: (days: string) => string,
): string[] {
  const out: string[] = [];
  if (range.olderThanDays !== undefined) out.push(older(`${range.olderThanDays} ${daysWord(range.olderThanDays)}`));
  if (range.withinDays !== undefined) out.push(within(`${range.withinDays} ${daysWord(range.withinDays)}`));
  return out;
}

const ORDER_TEXT: Record<NonNullable<FanQueueRule["order"]>, string> = {
  spend: "сначала крупные траты, потом кто был недавно",
  seen: "сначала кто был на странице недавно",
  followed_new: "сначала новые подписки",
  followed_old: "сначала старые подписки",
  fan_message: "сначала кто писал недавно",
  random: "в случайном порядке",
};

/** The rule in Hub's own words, one line each: what the asker sees before «да», and the chatter on the card. */
export function describeFanQueueRule(rule: FanQueueRule, platform: string): string[] {
  const out: string[] = [];
  const site = platform === "fansly" ? "на Fansly" : "на странице";
  switch (rule.audience ?? "any") {
    case "followers": out.push("фолловеры страницы"); break;
    case "subscribers": out.push("подписчики, подписка идёт"); break;
    case "expired": out.push("бывшие подписчики"); break;
    default: out.push("все фаны страницы"); break;
  }
  if (rule.fanWrote === "never") out.push("ни разу нам не писали");
  if (rule.fanWrote === "ever") out.push("писали нам хоть раз");
  if (rule.fanLastMessage !== undefined) {
    out.push(...ageText(rule.fanLastMessage, (d) => `сами не писали ${d} и больше`, (d) => `писали за последние ${d}`));
  }
  if (rule.pagePersonal === "never") out.push("лично мы им не писали (рассылки не в счёт)");
  else if (rule.pagePersonal !== undefined) {
    out.push(...ageText(rule.pagePersonal, (d) => `лично не писали ${d} и больше`, (d) => `лично писали за последние ${d}`));
  }
  if (rule.lifetimeSpend !== undefined) out.push(spendText(rule.lifetimeSpend, "потратили", "не платили"));
  if (rule.spend30d !== undefined) out.push(spendText(rule.spend30d, "за 30 дней потратили", "за 30 дней ничего не купили"));
  if (rule.lastPurchase !== undefined) {
    out.push(...ageText(rule.lastPurchase, (d) => `${d} и больше без покупки`, (d) => `покупали за последние ${d}`));
  }
  if (rule.followed !== undefined) {
    out.push(...ageText(rule.followed, (d) => `подписаны больше ${d} назад`, (d) => `подписались за последние ${d}`));
  }
  if (rule.subscribed !== undefined) {
    out.push(...ageText(rule.subscribed, (d) => `оформили подписку больше ${d} назад`, (d) => `оформили подписку за последние ${d}`));
  }
  if (rule.subscriptionEnds !== undefined) {
    const d = rule.subscriptionEnds.withinDays;
    out.push(`подписка кончается в ближайшие ${d} ${daysWord(d)}`);
  }
  if (rule.autoRenew === false) out.push("автопродление выключено");
  if (rule.autoRenew === true) out.push("автопродление включено");
  if (rule.seen !== undefined && "withinDays" in rule.seen) {
    out.push(`были ${site} за последние ${rule.seen.withinDays} ${daysWord(rule.seen.withinDays)}`);
  }
  if (rule.seen !== undefined && "notWithinDays" in rule.seen) {
    out.push(`не были ${site} ${rule.seen.notWithinDays} ${daysWord(rule.seen.notWithinDays)} и больше`);
  }
  if (rule.otherPagesSpend !== undefined) {
    out.push(spendText(rule.otherPagesSpend, "на других страницах модели потратили", "не платили на других страницах модели"));
  }
  if (rule.markers?.include !== undefined) out.push(`с метками: ${rule.markers.include.join(", ")}`);
  const excluded = rule.markers?.exclude ?? ["💩", "бомж"];
  out.push(excluded.length === 0
    ? "ему можно написать, без «Не предлагать»"
    : `ему можно написать, без «Не предлагать» и без меток ${excluded.map((one) => (/^\p{L}/u.test(one) ? `«${one}»` : one)).join(", ")}`);
  out.push(ORDER_TEXT[rule.order ?? "spend"]);
  if (rule.limit !== undefined) out.push(`не больше ${rule.limit}`);
  return out;
}

/** A list's words. */
export function describeFanQueueList(count: number): string[] {
  return [`список из ${count} фанов`, "ему можно написать, без «Не предлагать» и без меток 💩, «бомж»", "в порядке списка"];
}

const dayMonth = (date: Date) => `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
const daysSince = (now: Date, date: Date) => Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY));

function agoText(now: Date, date: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - date.getTime()) / MINUTE));
  if (minutes < 60) return `${Math.max(1, minutes)} мин назад`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} ч назад`;
  return `${Math.floor(minutes / (24 * 60))} дн назад`;
}

/** Why a fan is in a queue, short: a list's own words first, else what Hub knows about him. */
export function fanQueueWhy(fan: FanQueueCandidate, now: Date, platform: string): string {
  if (fan.listWhy !== null) return fan.listWhy.slice(0, 300);
  const parts: string[] = [];
  if (fan.lifetimeGrossMills > 0) {
    parts.push(`платил ${usd(millsToRoundedDollars(fan.lifetimeGrossMills))}`);
    if (fan.lastTransactionAt !== null) parts.push(`последняя покупка ${daysSince(now, fan.lastTransactionAt)} дн назад`);
  } else if (fan.followerSince !== null) {
    parts.push(`подписан ${dayMonth(fan.followerSince)}`);
  } else if (fan.subscriberSince !== null) {
    parts.push(`подписка с ${dayMonth(fan.subscriberSince)}`);
  }
  if (fan.lastFanMessageAt === null) parts.push("ни разу не писал");
  else parts.push(`писал ${daysSince(now, fan.lastFanMessageAt)} дн назад`);
  if (fan.seenAt !== null) parts.push(`${platform === "fansly" ? "был на Fansly" : "заходил"} ${agoText(now, fan.seenAt)}`);
  return parts.join(" · ").slice(0, 300);
}

/** The team guide's texts by group, in the order neighbours rotate through them. */
const GUIDE_A = ONLINE_TEMPLATES.filter((one) => one.group === "a").map((one) => one.id);
const GUIDE_B = ["B1", "B4", "B3", "B5", "B2"].filter((id) => ONLINE_TEMPLATES.some((one) => one.id === id));

/** What an item is written with and, for a template, which text: neighbours (by rank) get different ones. */
export function fanQueueItemAct(
  scenario: FanQueueScenario,
  row: OnlineCandidateRow,
  context: { now: Date; rank: number; others: OthersTalking | null },
): { act: string; templateId: string | null } {
  const pick = (list: readonly string[]) => (list.length === 0 ? null : list[context.rank % list.length]!);
  const guide = (group: "a" | "b") => ({ act: group === "a" ? "template_a" : "template_b", templateId: pick(group === "a" ? GUIDE_A : GUIDE_B) });
  const pingOrGuide = () => (row.messageCount >= ONLINE_RULES.pingMinMessages ? { act: "ping", templateId: null } : guide("a"));
  switch (scenario.action) {
    case "hi": return { act: "hi", templateId: null };
    case "reply": return { act: "reply", templateId: null };
    case "own": return { act: "own", templateId: null };
    case "ping": return pingOrGuide();
    case "template":
      if (scenario.texts !== undefined) return { act: "template_q", templateId: `Q${(context.rank % scenario.texts.length) + 1}` };
      return guide(scenario.templates ?? "b");
    default: {
      const decided = decideOnline(row, { now: context.now, others: context.others }).act;
      if (decided === "template_a") return guide("a");
      if (decided === "template_b") return guide("b");
      if (decided === "none") return pingOrGuide();
      return { act: decided, templateId: null };
    }
  }
}

export type FanQueueJudgement =
  | { kind: "go" }
  | { kind: "drop"; reason: FanQueueDropReason }
  | { kind: "wait"; until: Date };

/**
 * The page cannot write to the fan: the page cannot reach his account, the public check found no account (deleted or
 * banned), or, on Fansly, he neither follows the page nor holds a live subscription (a fan's DM rules there are
 * «follows» or «subscribed», as the extension's «Нельзя написать» reads them). What Hub does not know stays reachable.
 * The queue's selection says the same in SQL (packages/db/src/repositories/fan-queues.ts).
 */
function fanQueueCannotWrite(row: OnlineCandidateRow, platform: string, now: Date): boolean {
  if ((row.contactability !== null && UNREACHABLE.has(row.contactability)) || row.probeResolved === false) return true;
  if (row.publicFound === false) return true;
  if (platform !== "fansly") return false;
  const subscribed = row.isSubscriber && (row.subscriptionExpiresAt === null || row.subscriptionExpiresAt > now);
  return !row.isFollower && !subscribed;
}

/**
 * A fan of a portion against what Hub knows now. He leaves the queue when the
 * page cannot write to him, he is marked «Не предлагать», wrote, was written to
 * personally or bought since he was queued; he waits while another chatter
 * talks to him, for 48 hours after the page's last personal message, and for
 * 21 days after a send from «Онлайн» or a queue he did not answer.
 */
export function judgeFanQueueItem(
  item: { createdAt: Date },
  row: OnlineCandidateRow | undefined,
  context: { now: Date; others: OthersTalking | null; platform: string },
): FanQueueJudgement {
  // No row: the fan is gone from the page or deleted (the read skips deleted fans).
  if (row === undefined) return { kind: "drop", reason: "unreachable" };
  if (fanQueueCannotWrite(row, context.platform, context.now)) return { kind: "drop", reason: "unreachable" };
  if (row.mark?.action === "dismissed") return { kind: "drop", reason: "dismissed" };
  const since = item.createdAt.getTime();
  if (row.anyFanMessageAt !== null && row.anyFanMessageAt.getTime() > since) return { kind: "drop", reason: "fan_wrote" };
  const personal = [row.personalAt, row.lastAttributionAt].reduce<Date | null>(
    (latest, at) => (at === null ? latest : latest === null || at > latest ? at : latest), null,
  );
  if (personal !== null && personal.getTime() > since) return { kind: "drop", reason: "messaged" };
  if (row.lastTransactionAt !== null && row.lastTransactionAt.getTime() > since) return { kind: "drop", reason: "bought" };
  const now = context.now.getTime();
  if (context.others !== null) return { kind: "wait", until: new Date(now + FAN_QUEUE_TALKING_WAIT_MINUTES * MINUTE) };
  if (personal !== null && personal.getTime() > now - ONLINE_RULES.wroteRecentlyHours * 60 * MINUTE) {
    return { kind: "wait", until: new Date(personal.getTime() + ONLINE_RULES.wroteRecentlyHours * 60 * MINUTE) };
  }
  const tried = row.lastSentAttemptAt;
  if (tried !== null && tried.getTime() > now - ONLINE_RULES.attemptCooldownDays * DAY
    && (row.anyFanMessageAt === null || row.anyFanMessageAt < tried)) {
    return { kind: "wait", until: new Date(tried.getTime() + ONLINE_RULES.attemptCooldownDays * DAY) };
  }
  return { kind: "go" };
}
