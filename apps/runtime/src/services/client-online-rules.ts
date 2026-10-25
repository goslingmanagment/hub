import {
  CLIENT_ONLINE_REASONS,
  type ClientOnlineItem,
} from "@agency_hub_core/contracts";
import type { OnlineCandidateRow } from "@agency_hub_core/db";

/**
 * chat-extension «Онлайн»: why to write to a fan seen online, with what, and
 * whether he is set aside now. Pure: the facts come from listOnlineCandidates
 * (packages/db/src/repositories/online.ts), the chatters «в разговоре» from
 * the in-conversation read. Hub decides; the extension shows and asks nothing
 * else.
 *
 * Reasons, the most urgent first:
 * - `waiting` — the fan wrote last within 30 days, the page gave no personal answer since (a mass message is none);
 * - `new_unattended` — subscribed within 7 days, no personal message of the page since (one within 2 minutes of the
 *   start is the platform's welcome);
 * - `expiring` — a current subscription without renewal ends within 3 days;
 * - `silent` — paid, wrote before, nothing either way for 5 days; `quiet` — the same, never paid (the team's guide,
 *   segment A);
 * - `never_wrote` — the fan never wrote in any chat of the page (segment B);
 * - `none` — nothing to write about now.
 *
 * With what: Reply to who waits, Hi to the new, Ping from 10 messages of the chat (Hub's own minimum), below that a
 * text of the guide (A, or B for a fan who never wrote).
 *
 * Set aside, never hidden (a chatter may still write): «Не предлагать», a fan the platform says cannot be written to,
 * another chatter «в разговоре» with him, and — unless he waits — the page wrote to him within 48 hours or the window
 * within 21 days and he did not answer since.
 */

export const ONLINE_RULES = {
  waitingDays: 30,
  newDays: 7,
  expiringDays: 3,
  silentDays: 5,
  /** A personal message within this many minutes of the subscription's start is the platform's welcome. */
  welcomeMinutes: 2,
  wroteRecentlyHours: 48,
  attemptCooldownDays: 21,
  /** Lifetime gross from which a fan counts as paid (Spenders' payers). */
  payerMinGrossMills: 10,
  /** Hub's Ping minimum: fewer messages and Ping refuses (feature-policies.ts). */
  pingMinMessages: 10,
  /** Seen within this many minutes: on top of his group. */
  freshMinutes: 10,
} as const;

/** OnlyFans contactability values that say the page cannot write to the fan. */
const UNREACHABLE = new Set(["unavailable", "restricted", "blocked", "gone"]);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface OnlineDecision {
  reason: (typeof CLIENT_ONLINE_REASONS)[number];
  reasonAt: Date | null;
  act: ClientOnlineItem["act"];
  aside: ClientOnlineItem["aside"];
  asideAt: Date | null;
  asideBy: string | null;
}

/** Other chatters «в разговоре» with the fan: their names and the newest send. */
export interface OthersTalking {
  names: string[];
  lastSentAt: Date;
}

const after = (date: Date | null, cut: number): boolean => date !== null && date.getTime() > cut;
const later = (a: Date | null, b: Date | null): Date | null => (a === null ? b : b === null ? a : a > b ? a : b);

function reasonOf(row: OnlineCandidateRow, now: number): Pick<OnlineDecision, "reason" | "reasonAt"> {
  const { lastFanMessageAt: fan, answeredAt: answered } = row;
  if (fan !== null && fan.getTime() > now - ONLINE_RULES.waitingDays * DAY && (answered === null || fan > answered)) {
    return { reason: "waiting", reasonAt: fan };
  }
  const started = row.subscribedAt;
  if (started !== null && started.getTime() > now - ONLINE_RULES.newDays * DAY
    && (answered === null || answered.getTime() <= started.getTime() + ONLINE_RULES.welcomeMinutes * MINUTE)
    && (row.lastAttributionAt === null || row.lastAttributionAt <= started)) {
    return { reason: "new_unattended", reasonAt: started };
  }
  const ends = row.subscriptionEndsAt;
  if (ends !== null && row.autoRenew === false && ends.getTime() > now && ends.getTime() <= now + ONLINE_RULES.expiringDays * DAY) {
    return { reason: "expiring", reasonAt: ends };
  }
  const quietSince = now - ONLINE_RULES.silentDays * DAY;
  const lastEither = later(row.anyFanMessageAt, answered);
  if (row.anyFanMessageAt !== null) {
    if (lastEither !== null && lastEither.getTime() <= quietSince) {
      return { reason: row.lifetimeGrossMills >= ONLINE_RULES.payerMinGrossMills ? "silent" : "quiet", reasonAt: row.anyFanMessageAt };
    }
    return { reason: "none", reasonAt: null };
  }
  if (answered === null || answered.getTime() <= quietSince) return { reason: "never_wrote", reasonAt: started };
  return { reason: "none", reasonAt: null };
}

function actOf(reason: OnlineDecision["reason"], row: OnlineCandidateRow): OnlineDecision["act"] {
  switch (reason) {
    case "waiting": return "reply";
    case "new_unattended": return "hi";
    case "expiring":
    case "silent":
    case "quiet": return row.messageCount >= ONLINE_RULES.pingMinMessages ? "ping" : "template_a";
    case "never_wrote": return "template_b";
    default: return "none";
  }
}

export function decideOnline(row: OnlineCandidateRow, context: { now: Date; others: OthersTalking | null }): OnlineDecision {
  const now = context.now.getTime();
  const { reason, reasonAt } = reasonOf(row, now);
  const act = actOf(reason, row);
  const aside = (kind: NonNullable<OnlineDecision["aside"]>, at: Date | null, by: string | null = null): OnlineDecision => ({ reason, reasonAt, act, aside: kind, asideAt: at, asideBy: by });
  if (row.mark?.action === "dismissed") return aside("dismissed", row.mark.at, row.mark.by);
  if ((row.contactability !== null && UNREACHABLE.has(row.contactability)) || row.probeResolved === false) return aside("unreachable", null);
  if (context.others !== null) return aside("in_conversation", context.others.lastSentAt, context.others.names.join(", "));
  if (reason !== "waiting" && reason !== "none") {
    if (after(row.answeredAt, now - ONLINE_RULES.wroteRecentlyHours * HOUR)) return aside("wrote_recently", row.answeredAt);
    const tried = row.lastSentAttemptAt;
    if (tried !== null && tried.getTime() > now - ONLINE_RULES.attemptCooldownDays * DAY
      && (row.anyFanMessageAt === null || row.anyFanMessageAt < tried)) {
      return aside("attempted_recently", tried);
    }
  }
  return { reason, reasonAt, act, aside: null, asideAt: null, asideBy: null };
}

/** The order of the list: the most urgent reason, the offered before the set aside, the fresh, the paid, the newest. */
export function onlineRank(
  a: { reason: string; aside: string | null; fresh: boolean; lifetimeGrossMills: number; seenAt: Date | null },
  b: { reason: string; aside: string | null; fresh: boolean; lifetimeGrossMills: number; seenAt: Date | null },
): number {
  const order = (reason: string) => {
    const at = (CLIENT_ONLINE_REASONS as readonly string[]).indexOf(reason);
    return at < 0 ? CLIENT_ONLINE_REASONS.length : at;
  };
  return order(a.reason) - order(b.reason)
    || Number(a.aside !== null) - Number(b.aside !== null)
    || Number(b.fresh) - Number(a.fresh)
    || b.lifetimeGrossMills - a.lifetimeGrossMills
    || (b.seenAt?.getTime() ?? 0) - (a.seenAt?.getTime() ?? 0);
}

/** An OnlyFans id the platform gave for a name («u285080777»): no name. */
const AUTO_NAME = /^u\d+$/i;

/**
 * The name a guide's text puts instead of «love» (the guide: the fan's name or nick if the profile has one, else
 * «love»): the first word of letters of the display name, else of the username, 2 to 20 letters, capitalised.
 */
export function greetingNameOf(displayName: string | null, username: string | null): string | null {
  for (const value of [displayName, username]) {
    const text = value?.trim() ?? "";
    if (text === "" || AUTO_NAME.test(text)) continue;
    const word = /\p{L}+/u.exec(text)?.[0] ?? null;
    if (word !== null && word.length >= 2 && word.length <= 20) return word.charAt(0).toUpperCase() + word.slice(1);
  }
  return null;
}

/**
 * The team's reactivation guide (onlyfans-chat docs/research/reactivation-guide.md, the agency's Notion), word for
 * word: A — the fan talked before and went quiet, B — he never wrote. «love» is the place of the fan's name; the
 * client rotates the texts so neighbours never get the same one.
 */
export const ONLINE_TEMPLATES: ReadonlyArray<{ id: string; group: "a" | "b"; text: string }> = [
  { id: "A1", group: "a", text: "hey love 👋 not gonna pretend this is some spontaneous \"was just thinking of you\" moment lol. I'm going through my messages and realized we haven't talked in a while. I have a very important question for you but I need to know you're alive first lol" },
  { id: "A2", group: "a", text: "hey love 👋 I was scrolling back through my messages and saw our old convos - lowkey made me wonder where you disappeared to. everything good?" },
  { id: "A3", group: "a", text: "ok random but I just shot something that reminded me of a conversation we had a while back. you still around?" },
  { id: "A4", group: "a", text: "okay genuine question love - are you the type who disappears and then randomly comes back, or did I do something wrong? 😂" },
  { id: "A5", group: "a", text: "okay real talk love - I know you probably get a ton of messages. but I actually want to know what's going on with you. boring life update accepted" },
  { id: "A6", group: "a", text: "hey love 👋 okay so I have this idea for something new but I need a second opinion before I commit to it. you around?" },
  { id: "A7", group: "a", text: "hey love - was organizing my DMs (yes I do that sometimes lol) and realized you went quiet on me. what happened?" },
  { id: "A8", group: "a", text: "okay real talk love - I'm trying something different soon and lowkey want to know if it's something you'd even be into. thoughts?" },
  { id: "A9", group: "a", text: "hey love 👋 quick question - I'm planning content for next week and I'm torn between two ideas. wanna help me pick?" },
  { id: "A10", group: "a", text: "be honest love - did you forget about me or are you just watching from the shadows? 👀" },
  { id: "A11", group: "a", text: "okay wait you're still here but we haven't talked in forever. are you mad at me or just busy? lol" },
  { id: "B1", group: "b", text: "hey love - I noticed you've been here for a bit but we never actually talked? that's kinda unusual for me lol. what brought you here originally?" },
  { id: "B2", group: "b", text: "hey! I feel like we somehow never ended up talking which is weird lol - I'm curious, what kind of content do you usually like? trying to figure out what to shoot next 😄" },
  { id: "B3", group: "b", text: "ok be honest are you the quiet type or did my page just get lost in the scroll? either way, hi 👋" },
  { id: "B4", group: "b", text: "hey love 👋 I keep seeing you here but we've never actually talked? that's giving mystery vibes lol. shy or just picky?" },
  { id: "B5", group: "b", text: "ok I'm genuinely curious - you've been following for a while but never said hi. are you shy or just picky about who you talk to? 😄" },
];
