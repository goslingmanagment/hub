import type { KernelOperationResponse, ShiftReviewChat, ShiftReviewMessage } from "@agency_hub_core/contracts";
import { millsFromDollars, millsPercentOf, millsToNumber } from "@agency_hub_core/shared";
import { myMessages, reviewWaits, shiftQuality, summariesOf, totalsOf, type ShiftQuality } from "@agency_hub_core/ui/shiftReview";

import { demoError, intBetween, pick, queryNumber, queryString, rng, type DemoReply, type DemoRequest } from "../core.ts";
import { demoFanProfile, demoFans, demoPage, type DemoFan } from "../world.ts";
import { teamDisputes } from "./team-disputes.ts";
import { MIN, teamWorld, workedPages, type DemoShift } from "./team-world.ts";

/**
 * Команда → «Разбор смены» in the demo: one shift of the simulated team, opened
 * up. Its chats are invented around the shift's real numbers (pages, minutes,
 * pauses, messages), with a share of texts from the AI, some copied past the
 * button, waits that grow when the chatter slows down, and a pause or two. The
 * sales the shift journal shows for that very shift (team-world.ts) land in the
 * buying fan's own chat, around the sale: a bought PPV on the chatter's message
 * before it, a tip on the fan's, the shift's total on the shift; a disputed
 * sale's fan has a chat in both claimants' shifts (team-disputes.ts). Every
 * text of the chatter is a text of its own — the AI's, a Fix of a draft, a Hi —
 * except one template sent to a few fans, and `repeats` is counted from the
 * texts as Hub counts it (services/shift-review.ts). Fans are named as Hub knows
 * them (`demoFanProfile`: the same in Решения and the fan's card); two AI texts
 * carry the long dash the screen marks. The quality numbers every other screen
 * shows for the shift (`teamChatterNumbers`) are this review's, by the review's
 * own rules (`shiftReviewNumbers` below, packages/ui/src/shiftReview.ts).
 */

type Response = KernelOperationResponse<"teamShiftReview">;

const FAN_LINES = [
  "hey beautiful", "how was your day?", "what are you up to rn", "you look amazing in that last pic", "i just got home from work",
  "do you have anything new?", "how much for the video?", "lol you're so cute", "i was thinking about you", "send me something special",
  "are you real?", "good morning babe", "what are you wearing", "i'm bored, entertain me", "that's hot", "maybe later, payday is friday",
  "miss me?", "you up?", "long day at work ugh", "haha stop it", "that pic last night tho", "where are you from?", "tell me a secret",
  "do you do customs?", "i tipped you yesterday", "can't sleep", "you're my favorite here", "what's your favorite color",
  "just woke up", "on my lunch break", "is that new?", "ok but when", "how old are you", "show me more", "i'm back",
] as const;

/**
 * The chatter's texts of one shift, each its own (as AI texts and drafts are on
 * production): the AI's replies, Fix's English of a Russian draft, Hi greetings,
 * the chatter's own lines. Built from parts on a stride through every
 * combination, so no two texts of a shift are alike — a repeat in the review is
 * only ever the template (`TEMPLATE`). Its own random stream: the shift's waits
 * and replies do not move with the words.
 */
const AI_OPEN = ["aww", "omg", "haha", "mmm", "hehe", "ooh", "awww babe", "lol", "honestly", "wait", "okay", "hmm"] as const;
const AI_MIDDLE = [
  "that's so sweet of you", "you just made my whole day brighter", "i love that you're thinking about me", "you're trouble and i kinda like it",
  "no rush at all, it'll be right here waiting", "you're too sweet seriously", "i was literally just thinking about you", "you always know what to say",
  "that sounds like so much fun", "i'm just chilling in bed scrolling", "you have no idea how much i needed that", "i just finished something you'd really enjoy",
  "i want to hear everything about your day", "you're making me blush rn", "i can't stop smiling at my phone", "you're the sweetest person here",
] as const;
const AI_CLOSE = [
  "what are you up to tonight?", "want a peek? ♡", "tell me what you're into :3", "how was your day?", "are you still up?", "should i show you? hehe",
  "what would you do if i was there?", "do you want to see more?", "i'm curious what you think", "talk to me ♡", "what's on your mind?",
  "come keep me company?", "can i ask you something?", "guess what i'm wearing ;)",
] as const;
// A Russian draft and Fix's English of it, in parallel parts.
const FIX_FIRST = [
  ["только проснулась", "just woke up"], ["только из душа", "just got out of the shower"], ["скучала по тебе", "missed you"],
  ["весь день думала о тебе", "been thinking about you all day"], ["сижу дома одна", "home alone rn"], ["только вернулась", "just got back"],
  ["валяюсь в кровати", "lying in bed"], ["немного устала сегодня", "a little tired today"],
] as const;
const FIX_SECOND = [
  ["а ты как", "how about you"], ["что делаешь", "what are you doing"], ["расскажи как прошёл день", "tell me how your day went"],
  ["хочешь покажу кое-что", "want me to show you something"], ["видео дома, скину позже", "the video is at home, i'll send it later"],
  ["а ты откуда кстати", "where are you from btw"], ["ты сегодня рано", "you're up early today"], ["позже напишу подробнее", "i'll tell you more later"],
] as const;
// Each tail adds words of its own: a repeat is compared by words, «:)» and «♡» are none (they come on top, `DECOR`).
const FIX_TAIL = [["хах", "hehe"], ["", ""], ["ок?", "ok?"], ["лол", "lol"], ["честно", "honestly"]] as const;
const DECOR = ["", "", "", " :)", " ♡"] as const;
const HI_OPEN = ["heyyy", "hiii", "omg hi", "hey you", "hii welcome", "well hello"] as const;
const HI_BODY = [
  "thanks for the follow ♡", "so happy you found me", "i just posted something new", "thank you for following", "welcome to my page :3", "i saw you followed",
] as const;
const HI_CLOSE = [
  "how's your day going?", "tell me a little about yourself?", "i'm curious what you think", "what made you follow?", "where are you from?", "say hi back?",
] as const;
const OWN_SHORT = [
  "omg haha", "aww thank u", "tell me more", "haha stop", "u too", "lol same", "im so bored", "miss u", "ok babe", "noo way", "hiii",
  "mmm yes", "fr?", "so cute", "wbu", "yesss", "hehe", "aww", "good night", "brb",
] as const;
const OWN_FIRST = [
  "just got out of the shower", "i was waiting for u", "u always make me smile", "what do u want to see", "im so bored too",
  "cant stop thinking about it", "my day was so long", "i like talking to u", "u make me laugh so much", "i have something for u",
  "did u sleep well", "tell me what u like",
] as const;
const OWN_SECOND = ["lol", "tbh", "rn", "hehe", "ngl", "omg", "babe", "fr"] as const;
/** The one text the chatter sends to several fans as it is: the review's «тот же текст». */
const TEMPLATE = "heyy just got back, did you miss me? ♡";

/** The `index`-th of `size` combinations, on a stride coprime with it: distinct for every index below `size`. */
function strideOf(index: number, size: number, offset: number): number {
  let stride = Math.max(1, Math.floor(size * 0.618)) | 1;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  while (gcd(stride, size) !== 1) stride += 2;
  return (index * stride + offset) % size;
}

interface ShiftTexts {
  ai(): string;
  fix(): { draft: string; polished: string };
  hi(): string;
  own(): string;
}

function shiftTexts(shift: DemoShift): ShiftTexts {
  const random = rng(`texts:${shift.user.id}:${shift.startedAt}`);
  const counters = { ai: 0, fix: 0, hi: 0, own: 0 };
  const offsets = { ai: Math.floor(random() * 10_000), fix: Math.floor(random() * 10_000), hi: Math.floor(random() * 10_000), own: Math.floor(random() * 10_000) };
  // The next combination of three lists of these lengths, as three indexes.
  const next = (key: keyof typeof counters, a: number, b: number, c: number): [number, number, number] => {
    const size = a * b * c;
    const at = strideOf(counters[key]++, size, offsets[key] % size);
    return [at % a, Math.floor(at / a) % b, Math.floor(at / (a * b)) % c];
  };
  return {
    ai: () => {
      const [open, middle, close] = next("ai", AI_OPEN.length, AI_MIDDLE.length, AI_CLOSE.length);
      return `${AI_OPEN[open]} ${AI_MIDDLE[middle]}, ${AI_CLOSE[close]}`;
    },
    fix: () => {
      // Once a shift, a short draft the AI made far longer: «Fix: свой черновик, ИИ дописал».
      if (counters.fix === 2) {
        counters.fix += 1;
        return { draft: "думаю да", polished: "i think so yeah :3 honestly i've been wanting to try that for a while, you always come up with the best ideas" };
      }
      const [one, two, end] = next("fix", FIX_FIRST.length, FIX_SECOND.length, FIX_TAIL.length);
      const [first, second, tail] = [FIX_FIRST[one]!, FIX_SECOND[two]!, FIX_TAIL[end]!];
      const join = (a: string, b: string, c: string) => `${a}, ${b}${c ? ` ${c}` : ""}`;
      const decor = pick(random, DECOR);
      return { draft: `${join(first[0], second[0], tail[0])}${decor}`, polished: `${join(first[1], second[1], tail[1])}${decor}` };
    },
    hi: () => {
      const [open, body, close] = next("hi", HI_OPEN.length, HI_BODY.length, HI_CLOSE.length);
      return `${HI_OPEN[open]} ${HI_BODY[body]}, ${HI_CLOSE[close]}`;
    },
    own: () => {
      if (random() < 0.7) return pick(random, OWN_SHORT);
      const [first, second] = next("own", OWN_FIRST.length, OWN_SECOND.length, 1);
      return `${OWN_FIRST[first]} ${OWN_SECOND[second]}`;
    },
  };
}

interface PinnedFan {
  fan: DemoFan;
  /** The fan's moments in the shift (sales, a disputed sale), oldest first: the chat talks around each. */
  moments: number[];
}

/** The fans a shift's review must hold a chat with, by page: its sales' buyers, and the fans of the disputes it is the other side of. */
function pinnedFans(shift: DemoShift, now: number): Map<string, PinnedFan[]> {
  const pinned = new Map<string, PinnedFan[]>();
  const add = (pageLabel: string, fan: DemoFan, at: number) => {
    const list = pinned.get(pageLabel) ?? [];
    const known = list.find((item) => item.fan.platformUserId === fan.platformUserId);
    if (known) known.moments.push(at);
    else list.push({ fan, moments: [at] });
    pinned.set(pageLabel, list);
  };
  const pages = workedPages(shift);
  for (const sale of shift.sales) if (pages.includes(sale.pageLabel)) add(sale.pageLabel, sale.fan, sale.at);
  for (const dispute of teamDisputes(new Date(now))) {
    if (dispute.otherShift === shift) add(dispute.sale.pageLabel, dispute.sale.fan, dispute.sale.at);
  }
  for (const list of pinned.values()) {
    for (const item of list) item.moments.sort((left, right) => left - right);
    list.sort((left, right) => left.moments[0]! - right.moments[0]!);
  }
  return pinned;
}

/** A fan's chat as the review carries it: named as Hub knows the fan (`demoFanProfile`). */
function chatShell(pageLabel: string, platform: string, fan: DemoFan): Omit<ShiftReviewChat, "earlierHidden" | "messages" | "fanLifetimeNetMills"> {
  const profile = demoFanProfile(fan);
  return {
    key: `${pageLabel}:${fan.platformUserId}`,
    pageLabel,
    platform,
    conversationRef: fan.platformUserId,
    fanRef: fan.platformUserId,
    fanUsername: profile.username,
    fanDisplayName: profile.displayName,
    shiftNetMills: 0,
  };
}

function inventedReviewOf(shift: DemoShift, now: number): Response {
  const random = rng(`review:${shift.user.id}:${shift.startedAt}`);
  const texts = shiftTexts(shift);
  const start = shift.startedAt;
  const end = shift.ongoing ? now : shift.endedAt;
  const minutes = Math.max(1, Math.round((end - start) / MIN));
  const inPause = (at: number) => shift.pauses.some((pause) => at >= pause.from && at < pause.to);
  // A slow hour in the middle: the chatter writes less and the fans wait longer.
  const slowFrom = start + Math.round(minutes * 0.55) * MIN;
  const slowTo = slowFrom + 50 * MIN;
  // Nothing is written after the last action: a shift on a break now has its fans waiting.
  const lastWrite = shift.ongoing ? shift.lastInputAt + MIN : end;
  const pinned = pinnedFans(shift, now);

  const chats: ShiftReviewChat[] = [];
  const waits: Response["waits"] = [];
  const pages = shift.pages.filter((page) => page.messages > 0);
  const iso = (at: number) => new Date(at).toISOString();

  /**
   * The chatter's talk with one fan: a few words of the fan before the shift,
   * then `turns` exchanges from `from` (the fan writes, the chatter answers;
   * the last fan may wait to the end), and a few words around each later
   * moment of the fan (another purchase, a disputed sale).
   */
  const talk = (pageLabel: string, platform: string, fan: DemoFan, from: number, turns: number, moments: readonly number[]): ShiftReviewChat => {
    const key = `${pageLabel}:${fan.platformUserId}`;
    const messages: ShiftReviewMessage[] = [];
    for (let before = 0; before < 3; before += 1) {
      messages.push(fanMessage(`${key}:b${before}`, start - (3 - before) * 47 * MIN, pick(random, FAN_LINES), false));
    }
    let at = from;
    for (let turn = 0; turn < turns && at < lastWrite; turn += 1) {
      while (inPause(at)) at += 5 * MIN;
      if (at >= lastWrite) break;
      const fanAt = at;
      messages.push(fanMessage(`${key}:f${turn}`, fanAt, pick(random, FAN_LINES), true));
      const slow = fanAt >= slowFrom && fanAt < slowTo;
      // Now and then a fan is forgotten for over an hour: «N % ответов — быстрее часа» is not always 100 %.
      const minutesLate = random() < 0.008 ? intBetween(random, 62, 120) : slow ? intBetween(random, 8, 35) : intBetween(random, 0, 6);
      const delay = Math.round(minutesLate * MIN + intBetween(random, 10, 59) * 1000);
      const replyAt = Math.min(end, fanAt + delay);
      if (replyAt >= lastWrite) {
        waits.push({ chat: key, since: iso(fanAt), from: iso(fanAt), to: iso(end), by: null });
        break;
      }
      waits.push({ chat: key, since: iso(fanAt), from: iso(fanAt), to: iso(replyAt), by: "me" });
      messages.push(myMessage(random, texts, `${key}:m${turn}`, replyAt, Math.round((replyAt - fanAt) / 1000)));
      at = replyAt + intBetween(random, 2, 25) * MIN;
    }
    for (const [step, moment] of moments.slice(1).entries()) {
      const last = Date.parse(messages.at(-1)?.at ?? iso(start));
      if (moment - last < 30 * MIN) continue;
      const fanAt = Math.max(start, moment - intBetween(random, 4, 12) * MIN);
      const replyAt = Math.min(moment - MIN, fanAt + intBetween(random, 1, 4) * MIN + intBetween(random, 10, 59) * 1000);
      if (fanAt <= last || replyAt <= fanAt || replyAt >= lastWrite) continue;
      messages.push(fanMessage(`${key}:g${step}`, fanAt, pick(random, FAN_LINES), true));
      waits.push({ chat: key, since: iso(fanAt), from: iso(fanAt), to: iso(replyAt), by: "me" });
      messages.push(myMessage(random, texts, `${key}:n${step}`, replyAt, Math.round((replyAt - fanAt) / 1000)));
    }
    return { ...chatShell(pageLabel, platform, fan), fanLifetimeNetMills: millsToNumber(millsFromDollars(fan.totalSpent)), earlierHidden: intBetween(random, 0, 40), messages };
  };
  const personalOf = (chat: ShiftReviewChat) => chat.messages.filter((message) => message.mine !== null && message.inShift && !message.mass).length;

  for (const page of pages) {
    const platform = demoPage(page.pageLabel)?.platform ?? "fansly";
    const fans = demoFans(page.pageLabel);
    // The buyers of the shift and the fans of its disputes first, each around their moment; then the page's others.
    const mustHave = pinned.get(page.pageLabel) ?? [];
    const chatCount = Math.min(fans.length, Math.max(3, Math.round(page.messages / 4), mustHave.length));
    const picked: Array<{ fan: DemoFan; moments: number[] }> = mustHave.map((item) => ({ fan: item.fan, moments: item.moments }));
    const taken = new Set(picked.map((item) => item.fan.platformUserId));
    const order = [...fans.map((_, index) => fans[(index * 7) % fans.length]!), ...fans];
    for (const fan of order) {
      if (picked.length >= chatCount) break;
      if (taken.has(fan.platformUserId)) continue;
      taken.add(fan.platformUserId);
      picked.push({ fan, moments: [] });
    }
    // The page's personal messages in the review are the shift's on the page (as the journal and «now» count them):
    // the talks take what the Hi greetings and the later moments leave, and new short talks fill up the rest.
    const hiCount = page.messages >= 40 ? 4 : 0;
    let left = Math.max(0, page.messages - hiCount - mustHave.reduce((sum, item) => sum + item.moments.length - 1, 0));
    const onPage: ShiftReviewChat[] = [];
    for (const [index, { fan, moments }] of picked.entries()) {
      if (left <= 0 && moments.length === 0) break;
      const around = moments[0] ?? null;
      const drawn = index === picked.length - 1 ? left : Math.min(left, intBetween(random, 1, 8));
      // A buyer's chat holds the talk before the purchase: a few turns at least.
      const turns = around === null ? drawn : Math.max(2, drawn);
      left = Math.max(0, left - turns);
      const from = around === null
        ? start + intBetween(random, 0, Math.max(1, minutes - 40)) * MIN
        : Math.max(start, around - intBetween(random, 6, 30) * MIN);
      onPage.push(talk(page.pageLabel, platform, fan, from, turns, moments));
    }
    // New followers greeted with the Hi button: the chatter's one message, no word from the fan yet.
    let greeted = 0;
    for (let index = 0; index < fans.length && greeted < hiCount; index += 1) {
      const fan = fans[(index * 5 + 3) % fans.length]!;
      if (taken.has(fan.platformUserId)) continue;
      taken.add(fan.platformUserId);
      greeted += 1;
      const key = `${page.pageLabel}:${fan.platformUserId}`;
      const at = Math.min(start + intBetween(random, 5, Math.max(6, minutes - 5)) * MIN, lastWrite - MIN);
      const text = texts.hi();
      const hi: ShiftReviewMessage = {
        ref: `${key}:hi`, at: iso(at), side: "page", text, priceMills: null, bought: null, tipMills: null, media: 0,
        inShift: true, by: "me", byName: null, mass: false,
        mine: { composedWith: "hi", edited: false, origin: "ai", aiShare: 1, aiFeature: "hi-greeting", aiText: text, draft: null, replySeconds: null, repeats: 0, marks: [] },
      };
      onPage.push({ ...chatShell(page.pageLabel, platform, fan), fanLifetimeNetMills: null, earlierHidden: 0, messages: [hi] });
    }
    let missing = page.messages - onPage.reduce((sum, chat) => sum + personalOf(chat), 0);
    for (const fan of order) {
      if (missing <= 0) break;
      if (taken.has(fan.platformUserId)) continue;
      taken.add(fan.platformUserId);
      const from = start + intBetween(random, 0, Math.max(1, minutes - 30)) * MIN;
      const chat = talk(page.pageLabel, platform, fan, from, Math.min(missing, intBetween(random, 1, 4)), []);
      missing -= personalOf(chat);
      onPage.push(chat);
    }
    chats.push(...onPage);
  }
  // A chat a colleague kept on the same page, and fans who had waited since before the shift.
  const firstPage = pages[0];
  let colleagueChat: { key: string; at: number } | null = null;
  if (firstPage) {
    const platform = demoPage(firstPage.pageLabel)?.platform ?? "fansly";
    const used = new Set(chats.map((chat) => chat.key));
    const free = demoFans(firstPage.pageLabel).filter((fan) => !used.has(`${firstPage.pageLabel}:${fan.platformUserId}`));
    const chatOf = (fan: (typeof free)[number], messages: ShiftReviewMessage[]): ShiftReviewChat => ({
      ...chatShell(firstPage.pageLabel, platform, fan), fanLifetimeNetMills: millsToNumber(millsFromDollars(fan.totalSpent)), earlierHidden: 0, messages,
    });
    const colleague = free[0];
    if (colleague) {
      const key = `${firstPage.pageLabel}:${colleague.platformUserId}`;
      const first = start + 40 * MIN;
      const theirs = (ref: string, at: number, text: string): ShiftReviewMessage => ({
        ref, at: new Date(at).toISOString(), side: "page", text, priceMills: null, bought: null, tipMills: null, media: 0,
        inShift: true, by: "other", byName: "sofia", mass: false, mine: null,
      });
      chats.push(chatOf(colleague, [
        fanMessage(`${key}:c0`, first, pick(random, FAN_LINES), true),
        theirs(`${key}:c1`, first + 3 * MIN, texts.ai()),
        fanMessage(`${key}:c2`, first + 20 * MIN, pick(random, FAN_LINES), true),
        theirs(`${key}:c3`, first + 26 * MIN, texts.ai()),
        fanMessage(`${key}:c4`, first + 70 * MIN, pick(random, FAN_LINES), true),
      ]));
      waits.push(
        { chat: key, since: iso(first), from: iso(first), to: iso(first + 3 * MIN), by: "other" },
        { chat: key, since: iso(first + 20 * MIN), from: iso(first + 20 * MIN), to: iso(first + 26 * MIN), by: "other" },
        { chat: key, since: iso(first + 70 * MIN), from: iso(first + 70 * MIN), to: iso(end), by: null },
      );
      colleagueChat = { key, at: first + 24 * MIN };
    }
    for (const [index, fan] of free.slice(1, 4).entries()) {
      const key = `${firstPage.pageLabel}:${fan.platformUserId}`;
      const since = start - (3 + index * 9) * 60 * MIN;
      chats.push(chatOf(fan, [fanMessage(`${key}:w0`, since, pick(random, FAN_LINES), false)]));
      waits.push({ chat: key, since: new Date(since).toISOString(), from: new Date(start).toISOString(), to: new Date(end).toISOString(), by: null });
    }
    // A colleague still on the page as the shift began: wrote a minute before its start, then answered a fan waiting since
    // the last shift. Both chats are the colleague's.
    const [lateFan, carriedFan] = free.slice(4, 6);
    if (lateFan && carriedFan) {
      const theirs = (ref: string, at: number): ShiftReviewMessage => ({
        ref, at: iso(at), side: "page", text: texts.ai(), priceMills: null, bought: null, tipMills: null, media: 0,
        inShift: at >= start, by: "other", byName: "sofia", mass: false, mine: null,
      });
      const late = `${firstPage.pageLabel}:${lateFan.platformUserId}`;
      chats.push(chatOf(lateFan, [
        fanMessage(`${late}:l0`, start - 6 * MIN, pick(random, FAN_LINES), false),
        theirs(`${late}:l1`, start - MIN),
        fanMessage(`${late}:l2`, start + 4 * MIN, pick(random, FAN_LINES), true),
        theirs(`${late}:l3`, start + 7 * MIN),
      ]));
      const carried = `${firstPage.pageLabel}:${carriedFan.platformUserId}`;
      chats.push(chatOf(carriedFan, [
        fanMessage(`${carried}:t0`, start - 95 * MIN, pick(random, FAN_LINES), false),
        theirs(`${carried}:t1`, start + 12 * MIN),
      ]));
      waits.push(
        { chat: late, since: iso(start + 4 * MIN), from: iso(start + 4 * MIN), to: iso(start + 7 * MIN), by: "other" },
        { chat: carried, since: iso(start - 95 * MIN), from: iso(start), to: iso(start + 12 * MIN), by: "other" },
      );
    }
    // The tail of past shifts the chatter worked through in the first 15 minutes: fans silent in this shift, each
    // answered a minute or two after the last. Not the shift's queue, and off the median.
    for (const [index, fan] of free.slice(6, 14).entries()) {
      const key = `${firstPage.pageLabel}:${fan.platformUserId}`;
      const since = start - (2 + index * 3) * 60 * MIN;
      const replyAt = Math.min(end - MIN, start + (1 + index * 1.7) * MIN + intBetween(random, 5, 50) * 1000);
      chats.push(chatOf(fan, [
        fanMessage(`${key}:h0`, since, pick(random, FAN_LINES), false),
        myMessage(random, texts, `${key}:h1`, replyAt, Math.round((replyAt - start) / 1000)),
      ]));
      waits.push({ chat: key, since: iso(since), from: iso(start), to: iso(replyAt), by: "me" });
    }
    // A pack of Hi to new followers by «Отправить всем»: a second apart, many in a minute, apart from the pace.
    const packAt = start + Math.round(minutes * 0.3) * MIN;
    for (const [index, fan] of free.slice(14, 24).entries()) {
      const key = `${firstPage.pageLabel}:${fan.platformUserId}`;
      const text = texts.hi();
      chats.push({ ...chatOf(fan, [{
        ref: `${key}:hi`, at: iso(packAt + index * 1000), side: "page", text, priceMills: null, bought: null, tipMills: null,
        media: 0, inShift: true, by: "me", byName: null, mass: false,
        mine: { composedWith: "hi", edited: false, origin: "ai", aiShare: 1, aiFeature: "hi-greeting", aiText: text, draft: null, replySeconds: null, repeats: 0, marks: [] },
      }]), fanLifetimeNetMills: null });
    }
    // A fan who said goodnight after the chatter's answer and got nothing back — «без ответа», but nothing to answer; and
    // one who asked, went quiet for hours and came back, answered in minutes: a long wait the silence explains.
    const [sleepy, returned] = free.slice(24, 26);
    if (sleepy && lastWrite - start > 30 * MIN) {
      const key = `${firstPage.pageLabel}:${sleepy.platformUserId}`;
      const asked = lastWrite - 26 * MIN;
      const replyAt = asked + 3 * MIN;
      chats.push(chatOf(sleepy, [
        fanMessage(`${key}:s0`, asked, "how was your day?", true),
        myMessage(random, texts, `${key}:s1`, replyAt, 3 * 60),
        fanMessage(`${key}:s2`, replyAt + 2 * MIN, "Good night babe, sweet dreams ♡", true),
      ]));
      waits.push(
        { chat: key, since: iso(asked), from: iso(asked), to: iso(replyAt), by: "me" },
        { chat: key, since: iso(replyAt + 2 * MIN), from: iso(replyAt + 2 * MIN), to: iso(end), by: null },
      );
    }
    const back = lastWrite - 40 * MIN;
    if (returned && back - start > 100 * MIN && !inPause(back + 4 * MIN)) {
      const key = `${firstPage.pageLabel}:${returned.platformUserId}`;
      const since = start + 10 * MIN;
      const replyAt = back + 4 * MIN;
      chats.push(chatOf(returned, [
        fanMessage(`${key}:r0`, since, "do you have anything new?", true),
        fanMessage(`${key}:r1`, back, "good morning babe", true),
        myMessage(random, texts, `${key}:r2`, replyAt, Math.round((replyAt - since) / 1000)),
      ]));
      waits.push({ chat: key, since: iso(since), from: iso(since), to: iso(replyAt), by: "me" });
    }
  }
  // One template to a few fans, typed or pasted as it is: no AI text holds it. `repeats` is counted later, from the texts.
  let repeated = 0;
  for (const chat of chats) {
    const mine = chat.messages.find((message) => message.mine !== null && message.mine.composedWith !== "hi");
    if (mine?.mine && repeated < 4 && random() < 0.3) {
      mine.text = TEMPLATE;
      mine.mine = { ...mine.mine, composedWith: "hand", edited: null, origin: "own", aiShare: null, aiFeature: null, aiText: null, draft: null };
      repeated += 1;
    }
  }
  // A Reply sent in two parts ([NEXT]): the second one typed by the extension, the button's all the same.
  const replied = chats.flatMap((chat) => chat.messages.map((message, index) => ({ chat, message, index })))
    .find(({ message }) => message.mine?.composedWith === "reply" && message.mine.origin === "ai");
  if (replied !== undefined) {
    const first = replied.message.mine!;
    const second = "anyway enough about me, how's your night going?";
    first.aiText = `${replied.message.text} [NEXT] ${second}`;
    replied.chat.messages.splice(replied.index + 1, 0, {
      ...replied.message, ref: `${replied.message.ref}:2`, at: iso(Date.parse(replied.message.at) + 2000), text: second,
      priceMills: null, bought: null, media: 0, mine: { ...first, part: 2, replySeconds: null },
    });
  }
  // Deleted after they were sent. A fan who erased the whole chat half an hour after their last message: shown pale,
  // counted. The chatter's Russian to an English fan, deleted after 6 min 25 s (the fan saw it), and a Fix command sent as
  // text, deleted after 6 s (no one saw it: not counted). One more of the chatter's deleted ones the archive has no text of.
  const erased = chats.find((chat) => chat.messages.filter((message) => message.side === "fan" && message.inShift).length >= 3);
  if (erased) {
    const lastFan = Math.max(...erased.messages.filter((message) => message.side === "fan").map((message) => Date.parse(message.at)));
    for (const message of erased.messages) if (message.side === "fan") message.deletedAt = iso(lastFan + 27 * MIN);
  }
  let deletedMine = 0;
  const struck = chats.filter((chat) => chat !== erased && chat.messages.some((message) => message.mine !== null && message.mine.composedWith !== "hi"))
    .slice(0, 2);
  for (const [index, chat] of struck.entries()) {
    const position = chat.messages.findIndex((message) => message.mine !== null);
    const after = Date.parse(chat.messages[position]!.at);
    const [text, deletedSeconds] = index === 0 ? ["ой я тоже щас пойду отдыхать после работы", 385] : ["*разверни поигривее", 6];
    const at = Math.min(after + 40_000, end - 2 * MIN);
    chat.messages.splice(position + 1, 0, {
      ref: `${chat.key}:del${index}`, at: iso(at), side: "page", text, priceMills: null, bought: null, tipMills: null, media: 0,
      inShift: true, by: "me", byName: null, mass: false, deletedAt: iso(at + deletedSeconds * 1000),
      mine: { composedWith: "hand", edited: null, origin: "own", aiShare: 0, aiFeature: null, aiText: null, draft: null, replySeconds: null, repeats: 0, marks: ["cyrillic"] },
    });
    deletedMine += 1;
  }
  // One answer Fansly never gave the archive (the chat dropped from sync): the page socket's copy, no price.
  const socketOnly = chats.find((chat) => chat.platform === "fansly" && chat.messages.some((message) => message.mine !== null && message.mine.replySeconds !== null))
    ?.messages.find((message) => message.mine !== null && message.mine.replySeconds !== null);
  if (socketOnly) Object.assign(socketOnly, { unarchived: true, priceMills: null, bought: null });
  chats.sort((a, b) => Date.parse(a.messages.find((m) => m.inShift)?.at ?? "") - Date.parse(b.messages.find((m) => m.inShift)?.at ?? ""));

  const activity: Response["activity"] = [];
  for (let minute = 0; minute < minutes; minute += 1) {
    const at = start + minute * MIN;
    if (inPause(at)) continue;
    // After the last action the tab is open with nothing done until the extension's last beat, then closed.
    if (shift.ongoing && at > shift.lastInputAt) {
      if (at <= shift.lastBeatAt) activity.push({ at: iso(at), input: false });
      continue;
    }
    activity.push({ at: new Date(at).toISOString(), input: !(at >= slowFrom && at < slowTo) || random() < 0.4 });
  }

  const others = teamWorld(new Date(now)).shifts.filter((one) => one.user.id === shift.user.id).sort((a, b) => a.startedAt - b.startedAt);
  const position = others.findIndex((one) => one.startedAt === shift.startedAt);
  return {
    shift: {
      userId: shift.user.id,
      username: shift.user.username,
      kind: "shift",
      startedAt: new Date(start).toISOString(),
      endedAt: new Date(end).toISOString(),
      ongoing: shift.ongoing,
      workedMinutes: shift.workedMinutes,
      pauses: shift.pauses.map((pause) => ({ from: new Date(pause.from).toISOString(), to: new Date(pause.to).toISOString() })),
      lastInputAt: iso(shift.lastInputAt),
      lastBeatAt: iso(shift.lastBeatAt),
      pages: [...pages].sort((a, b) => b.messages - a.messages).map((page) => ({
        pageLabel: page.pageLabel, platform: demoPage(page.pageLabel)?.platform ?? "fansly", messages: page.messages, worked: page.messages >= 10,
        // Fewer than 10, but nobody else's shift kept the page then: all its fans are the chatter's to see.
        allFans: page.messages >= 10 || !teamWorld(new Date(now)).shifts.some((one) => one.user.id !== shift.user.id
          && one.startedAt < end && (one.ongoing ? now : one.endedAt) > start
          && one.pages.some((other) => other.pageLabel === page.pageLabel && other.messages >= 10)),
      })),
      // The shift's sales (`withMoney`); the colleague's tip in the chat they kept is theirs, not counted.
      salesNetMills: 0,
    },
    previousAt: position > 0 ? new Date(others[position - 1]!.startedAt).toISOString() : null,
    nextAt: position >= 0 && position < others.length - 1 ? new Date(others[position + 1]!.startedAt).toISOString() : null,
    activity,
    chats,
    sales: colleagueChat === null ? [] : [{
      saleRef: `demo-kept-${shift.startedAt}`, at: iso(colleagueChat.at), pageLabel: firstPage!.pageLabel,
      fanRef: chats.find((chat) => chat.key === colleagueChat!.key)?.fanRef ?? null,
      fanName: chats.find((chat) => chat.key === colleagueChat!.key)?.fanDisplayName ?? null, chatKey: colleagueChat.key,
      kind: "tip", netMills: 32_000, verdict: "theirs", holderName: "sofia", ppvSender: null, ppvSentAt: null, lastWriter: "sofia",
      writers: [{ name: "sofia", messages: 2 }], origin: "other_wrote",
    }],
    beforeSales: [],
    laterSales: [],
    waits: waits.sort((a, b) => Date.parse(a.from) - Date.parse(b.from)),
    unarchived: 0,
    deleted: deletedMine === 0 ? 0 : deletedMine + 1,
    serverNow: new Date(now).toISOString(),
  };
}

/** The buying fan's own chat (every buyer of the shift has one, `pinnedFans`); else the page's chat busiest around the sale. */
function chatOfSale(chats: readonly ShiftReviewChat[], pageLabel: string, fanRef: string, at: number): ShiftReviewChat | null {
  const own = chats.find((chat) => chat.pageLabel === pageLabel && chat.fanRef === fanRef);
  if (own) return own;
  const onPage = chats.filter((chat) => chat.pageLabel === pageLabel && chat.messages.some((message) => message.inShift && message.mine !== null && message.mine.composedWith !== "hi"));
  let best: ShiftReviewChat | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const chat of onPage) {
    for (const message of chat.messages) {
      if (!message.inShift) continue;
      const gap = Math.abs(Date.parse(message.at) - at);
      if (gap < distance) {
        distance = gap;
        best = chat;
      }
    }
  }
  return best;
}

/**
 * The shift's sales (team-world.ts) in its chats and in `sales`, as Hub settles them: each the chatter's own, but one PPV a
 * colleague sent before the shift and one tip under a wall post, which the shift holds all the same. Around them: a
 * renewal before the shift from a fan the chatter wrote to last (no shift's), a PPV of the shift bought the next morning
 * in a colleague's shift, and the disputed sales of the colleagues' shifts this one is the other side of. And the long
 * dash in two AI texts.
 */
function withMoney(review: Response, shift: DemoShift, now: number): Response {
  const pages = workedPages(shift);
  const sales = shift.sales.filter((sale) => pages.includes(sale.pageLabel));
  const me = shift.user.username;
  const end = shift.ongoing ? now : shift.endedAt;
  type Sale = Response["sales"][number];
  const entry = (chat: ShiftReviewChat | null, at: number, kind: Sale["kind"], netMills: number, facts: Partial<Sale>): Sale => {
    const mineCount = chat?.messages.filter((message) => message.by === "me").length ?? 0;
    return {
      saleRef: `demo-${shift.startedAt}-${at}-${kind}`, at: new Date(at).toISOString(), pageLabel: chat?.pageLabel ?? "",
      fanRef: chat?.fanRef ?? null, fanName: chat === null ? null : chat.fanDisplayName ?? chat.fanUsername, chatKey: chat?.key ?? null,
      kind, netMills, verdict: "mine", holderName: null, ppvSender: null, ppvSentAt: null, lastWriter: me,
      writers: mineCount === 0 ? [] : [{ name: me, messages: mineCount }], origin: "own", ...facts,
    };
  };
  // A PPV is bought only where a sale of the shift says so: the invented ones stay unbought.
  for (const chat of review.chats) for (const message of chat.messages) if (message.bought === true) message.bought = false;
  const ppvs = sales.filter((sale) => sale.kind === "ppv");
  const tips = sales.filter((sale) => sale.kind === "tip");
  const colleaguePpv = ppvs.length >= 2 ? ppvs[1] : undefined;
  const postTip = tips.length >= 2 ? tips[1] : undefined;
  for (const sale of sales) {
    const chat = chatOfSale(review.chats, sale.pageLabel, sale.fan.platformUserId, sale.at);
    if (!chat) continue;
    chat.shiftNetMills += sale.netMills;
    // What the fan brought all time holds this shift's sale too.
    chat.fanLifetimeNetMills = (chat.fanLifetimeNetMills ?? 0) + sale.netMills;
    let facts: Partial<Sale> = {};
    if (sale === colleaguePpv) {
      facts = { origin: "colleague_ppv", ppvSender: "sofia", ppvSentAt: new Date(shift.startedAt - 5 * 60 * MIN).toISOString() };
    } else if (sale === postTip) {
      facts = { origin: "post_tip" };
    } else if (sale.kind === "ppv") {
      const offer = [...chat.messages].reverse().find((message) => message.inShift && message.mine !== null && !message.unarchived && Date.parse(message.at) <= sale.at)
        ?? chat.messages.find((message) => message.inShift && message.mine !== null && !message.unarchived);
      if (offer) {
        offer.priceMills = sale.priceMills;
        offer.bought = true;
        offer.media = Math.max(1, offer.media);
        facts = { ppvSender: me, ppvSentAt: offer.at };
      }
    } else if (sale.kind === "tip") {
      const fan = [...chat.messages].reverse().find((message) => message.inShift && message.side === "fan" && Date.parse(message.at) <= sale.at)
        ?? chat.messages.find((message) => message.inShift && message.side === "fan");
      if (fan) fan.tipMills = (fan.tipMills ?? 0) + sale.priceMills;
    }
    review.sales.push(entry(chat, sale.at, sale.kind, sale.netMills, facts));
  }
  review.shift.salesNetMills = sales.reduce((sum, sale) => sum + sale.netMills, 0);
  // The disputed sales this shift is the other side of: the colleague's shift holds them.
  for (const dispute of teamDisputes(new Date(now))) {
    if (dispute.otherShift !== shift) continue;
    const chat = chatOfSale(review.chats, dispute.sale.pageLabel, dispute.sale.fan.platformUserId, dispute.sale.at);
    if (!chat) continue;
    chat.shiftNetMills += dispute.sale.netMills;
    review.sales.push(entry(chat, dispute.sale.at, dispute.sale.kind, dispute.sale.netMills, {
      verdict: "theirs", holderName: dispute.shift.user.username,
      writers: [{ name: dispute.shift.user.username, messages: 4 }, { name: me, messages: 3 }],
    }));
  }
  review.sales.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const talked = review.chats.find((chat) => chat.messages.some((message) => message.mine !== null && message.mine.composedWith !== "hi"));
  if (talked && review.shift.kind === "shift") {
    review.beforeSales.push(entry(talked, shift.startedAt - 40 * MIN, "subscription", 12_000, { verdict: "none" }));
  }
  const unsold = review.chats.flatMap((chat) => chat.messages
    .filter((message) => message.mine !== null && message.priceMills !== null && message.bought !== true && !message.unarchived)
    .map((message) => ({ chat, message })))[0];
  if (unsold && !shift.ongoing && end + 9 * 60 * MIN < now) {
    unsold.message.bought = true;
    review.laterSales.push(entry(unsold.chat, end + 9 * 60 * MIN, "ppv", millsToNumber(millsPercentOf(unsold.message.priceMills!, 80)), {
      verdict: "theirs", holderName: "sofia", ppvSender: me, ppvSentAt: unsold.message.at, lastWriter: "sofia",
    }));
  }

  // The long dash, an AI tell the screen marks, in two of the AI's texts.
  const random = rng(`wb-review:${shift.user.id}:${shift.startedAt}`);
  let dashed = 0;
  for (const chat of review.chats) {
    for (const message of chat.messages) {
      if (dashed >= 2 || message.mine === null || message.mine.origin !== "ai" || message.mine.composedWith === "hi" || !message.text.includes(", ")) continue;
      if (random() > 0.25) continue;
      message.text = message.text.replace(", ", " — ");
      if (message.mine.aiText !== null) message.mine.aiText = message.mine.aiText.replace(", ", " — ");
      message.mine.marks = [...message.mine.marks, "dash"];
      dashed += 1;
    }
  }
  return review;
}

/** One shift of the simulated team, opened up, with its money and its repeats. */
export function reviewOf(shift: DemoShift, now: number): Response {
  return withRepeats(withMoney(inventedReviewOf(shift, now), shift, now));
}

/** What the shift numbers (team.ts) carry of a shift's review: its quality and the counts behind it. */
export interface ReviewNumbers {
  quality: ShiftQuality;
  /** Personal messages, and of them the texts with words (Hi greetings left out), the AI's sent unedited, the drafts Fix made. */
  messages: number;
  textMessages: number;
  aiUnedited: number;
  fix: number;
  replies: number;
  repliesWithinHour: number;
}

// A finished shift's review never changes: its numbers are counted once per dev-server life.
const numbersCache = new Map<string, ReviewNumbers>();

/**
 * The shift's three quality numbers by the review's rules — what its «Разбор
 * смены» shows — and the counts behind them, for the shift numbers (team.ts) to
 * carry, so the journal, the people and the review of one shift agree.
 */
export function shiftReviewNumbers(shift: DemoShift, now: number): ReviewNumbers {
  const key = `${shift.user.id}:${shift.startedAt}:${shift.endedAt}`;
  const known = shift.ongoing ? undefined : numbersCache.get(key);
  if (known) return known;
  const review = reviewOf(shift, now);
  const mine = myMessages(review);
  const waits = reviewWaits(review);
  const totals = totalsOf(review, mine, summariesOf(review, waits), waits);
  const delays = mine.flatMap((one) => (one.message.mass || one.message.mine.replySeconds === null ? [] : [one.message.mine.replySeconds]));
  const numbers: ReviewNumbers = {
    quality: shiftQuality(totals),
    messages: totals.messages,
    textMessages: totals.textMessages,
    aiUnedited: totals.aiUnedited,
    fix: totals.origin.fix,
    replies: totals.replies,
    repliesWithinHour: delays.filter((delay) => delay <= 3600).length,
  };
  if (!shift.ongoing) numbersCache.set(key, numbers);
  return numbers;
}

function fanMessage(ref: string, at: number, text: string, inShift: boolean): ShiftReviewMessage {
  return { ref, at: new Date(at).toISOString(), side: "fan", text, priceMills: null, bought: null, tipMills: null, media: 0, inShift, by: null, byName: null, mass: false, mine: null };
}

function myMessage(random: () => number, texts: ShiftTexts, ref: string, at: number, replySeconds: number): ShiftReviewMessage {
  const roll = random();
  let text: string;
  let mine: NonNullable<ShiftReviewMessage["mine"]>;
  const base = { replySeconds, repeats: 0, marks: [] as NonNullable<ShiftReviewMessage["mine"]>["marks"] };
  if (roll < 0.3) {
    text = texts.ai();
    mine = { ...base, composedWith: "reply", edited: false, origin: "ai", aiShare: 1, aiFeature: "fast-reply", aiText: text, draft: null };
  } else if (roll < 0.45) {
    text = texts.ai();
    mine = { ...base, composedWith: "hand", edited: null, origin: "ai", aiShare: 0.92, aiFeature: "coach-chat", aiText: `${text} (or tease him a little first)`, draft: null };
  } else if (roll < 0.7) {
    const { draft, polished } = texts.fix();
    text = polished;
    mine = {
      ...base, composedWith: "fix", edited: false, origin: "fix", aiShare: 1, aiFeature: "improve-draft", aiText: polished, draft,
      fixExpanded: polished.length > 2.2 * draft.length && polished.length - draft.length > 60,
    };
  } else {
    text = texts.own();
    mine = { ...base, composedWith: "hand", edited: null, origin: "own", aiShare: null, aiFeature: null, aiText: null, draft: null };
  }
  const priced = random() < 0.06;
  return {
    ref, at: new Date(at).toISOString(), side: "page", text,
    priceMills: priced ? intBetween(random, 8, 25) * 1000 : null, bought: priced ? random() < 0.4 : null,
    tipMills: null, media: priced ? 1 : 0, inShift: true, by: "me", byName: null, mass: false, mine,
  };
}

/** A text as Hub compares repeats: lower case, words only (services/shift-review.ts `normalized`). */
function repeatKey(text: string): string {
  return (text.toLowerCase().match(/[\p{L}\p{N}_']+/gu) ?? []).join(" ");
}

/** Hub's shortest repeat: a text of fewer words is not one («omg haha» to many fans is no copy-paste). */
const REPEAT_MIN_WORDS = 4;

/**
 * `repeats` as Hub counts it: for each of the chatter's messages of the shift,
 * how many other chats got the same text (lower case, words only, at least four
 * words). Counted from the texts themselves, so a mark is never missing where a
 * repeat is plain to see.
 */
function withRepeats(review: Response): Response {
  const chatsOf = new Map<string, Set<string>>();
  for (const chat of review.chats) {
    for (const message of chat.messages) {
      if (message.by !== "me" || !message.inShift) continue;
      const key = repeatKey(message.text);
      if (key.split(" ").length < REPEAT_MIN_WORDS) continue;
      const set = chatsOf.get(key) ?? new Set<string>();
      set.add(chat.key);
      chatsOf.set(key, set);
    }
  }
  for (const chat of review.chats) {
    for (const message of chat.messages) {
      if (message.mine === null) continue;
      message.mine.repeats = Math.max(0, (chatsOf.get(repeatKey(message.text))?.size ?? 1) - 1);
    }
  }
  return review;
}

export function teamShiftReview(request: DemoRequest): Response | DemoReply {
  if (request.role !== "owner") return demoError(403, "Forbidden", "Разбор смены — только для владельца.");
  const userId = queryNumber(request, "userId", Number.NaN);
  const at = Date.parse(queryString(request, "at") ?? "");
  if (!Number.isInteger(userId) || Number.isNaN(at)) return demoError(400, "Bad Request", "userId и at обязательны.");
  const shift = teamWorld(request.now).shifts.find((one) => one.user.id === userId && one.startedAt <= at && at <= (one.ongoing ? request.now.getTime() : one.endedAt));
  if (!shift) return demoError(404, "Not Found", "В это время у этого человека не было смены.");
  return reviewOf(shift, request.now.getTime());
}
